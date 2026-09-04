/*
 * vorto.js — LIVE check of the Vorto vendor maintenance-ticket portal.
 *
 * For each Fullbay order (unit ALMZ… + PO "MT-…") this reports whether the
 * ticket is RESOLVED in Vorto. Reads the live data every run.
 *
 * HOW IT WORKS (rewritten 2026-06-04): the portal's grid only loads 500 of
 * thousands of tickets and its search filters just that page — so scraping the
 * table missed anything past page 1. Instead we call the portal's OWN data API
 * directly (https://maintenance.api.5f.app/.../tickets) with perPage=10000, which
 * returns EVERY ticket in one request. We grab the page's Firebase auth token and
 * the request template (vendor ids etc.) from the live page, then query both the
 * resolved and open views with all hide-filters OFF.
 *
 * MATCHING IS ON THE MT, EXACTLY (corrected 2026-09-03).
 *  - asset.name in the API = the unit (ALMZ…); pid = the ticket MT (MT-…).
 *  - The MT on the Fullbay SO decides it. A unit commonly has SEVERAL MTs — one
 *    resolved, another still open — so "has this unit ever been resolved" is the
 *    wrong question. Only the MT this order was billed against counts.
 *  - This used to check the unit FIRST and fall back to the MT, so an order whose
 *    own MT was still open passed because a different MT on the same unit had
 *    been closed. That was a false pass on real money.
 *  - The unit is used only when the order carries no MT at all, and the result
 *    says so (matchedBy: 'unit').
 *  - The PO's MT is cleaned first (strip stray ":" / ")" etc.), and both sides are
 *    compared in canonical form (letters and digits only) so punctuation
 *    differences never cause a false mismatch.
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { DATA_DIR, dataPath } = require('./paths');

const PROFILE_DIR = dataPath('.vorto-profile');
const CREDS_PATH = dataPath('vorto-credentials.json');
const URL = 'https://vorto-maint-tickets.web.app/vendor-portal';
const TICKETS_RE = /maintenance\.api\.5f\.app\/api\/v1\/vendors\/.*\/tickets/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Pull a clean MT number out of a Fullbay PO (handles ": MT-XXXX", "MT-XXXX)", etc.).
function cleanMT(po) {
  const m = String(po || '').toUpperCase().match(/MT-?[A-Z0-9]{4,}/);
  return m ? m[0] : '';
}

/* ---------------- saved login + auto sign-in ---------------- */
function readCreds() {
  try {
    if (!fs.existsSync(CREDS_PATH)) return null;
    const c = JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8'));
    if (!c.username || !c.password || /PUT-YOUR/i.test(c.username) || /PUT-YOUR/i.test(c.password)) return null;
    return c;
  } catch (e) { return null; }
}
function credsSet() { return !!readCreds(); }

// Vorto login = phone number + password. Fill + submit; returns true if it lands in the app.
async function autoLogin(page) {
  const cred = readCreds();
  if (!cred) return false;
  const pw = await page.$('input[type="password"]');
  if (!pw) return false;
  const user = await page.$('input[type="tel"], input[autocomplete="tel"], input[type="email"], input[name*="phone" i], input[name*="user" i], input[type="text"]');
  try {
    if (user) await user.fill(cred.username);
    await pw.fill(cred.password);
    const btn = await page.$('button:has-text("Log in"), button:has-text("Login"), button:has-text("Sign in"), button[type="submit"], input[type="submit"]');
    if (btn) await btn.click({ timeout: 5000 }).catch(() => {}); else await page.keyboard.press('Enter');
    await sleep(2500);
    await page.goto(URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForSelector('.ag-center-cols-container .ag-row', { timeout: 20000 }).catch(() => {});
  } catch (e) { return false; }
  return !!(await page.$('.ag-center-cols-container .ag-row'));
}

/* ---------------- API access ---------------- */
// Fetch every ticket for a view ('resolved' | 'open') in one call (hide-filters off).
async function fetchView(ctx, template, token, view) {
  let url = template
    .replace(/viewType=\w+/i, 'viewType=' + view)
    .replace(/perPage=\d+/i, 'perPage=10000')
    .replace(/([?&])page=\d+/i, '$1page=1')
    .replace(/hideCompleted=\w+/i, 'hideCompleted=false')
    .replace(/hideResolved=\w+/i, 'hideResolved=false')
    .replace(/hideDeferrable=\w+/i, 'hideDeferrable=false');
  if (!/viewType=/i.test(url)) url += '&viewType=' + view;
  if (!/perPage=/i.test(url)) url += '&perPage=10000';
  const resp = await ctx.request.get(url, { headers: { authorization: token } });
  if (!resp.ok()) throw new Error('tickets API returned ' + resp.status());
  const j = await resp.json();
  return j.tickets || [];
}

// Index tickets by unit (asset.name) and by MT (pid).
/*
 * Canonical form of an MT for comparison: upper case, everything that isn't a
 * letter or digit removed. So "MT-J6FTV4BO", "mt j6ftv4bo" and "MTJ6FTV4BO" all
 * compare equal, while two genuinely different MTs never collide. Both sides of
 * the comparison go through this, so punctuation differences between Fullbay and
 * the portal can't cause a false mismatch.
 */
function mtKey(v) {
  return String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function indexTickets(tickets) {
  const byUnit = new Map(); const byPid = new Map();
  for (const t of tickets) {
    const unit = ((t.asset && t.asset.name) || '').toUpperCase();
    const pid = (t.pid || '').toUpperCase();
    const status = (t.status && (t.status.displayName || t.status.name)) || '';
    const rec = { unit, pid, status };
    if (unit && !byUnit.has(unit)) byUnit.set(unit, rec);
    // Keyed on the canonical MT, not the raw string.
    const k = mtKey(pid);
    if (k && !byPid.has(k)) byPid.set(k, rec);
  }
  return { byUnit, byPid };
}

/*
 * lookupOrders(items) — items: [{ unit, mt }] (unit = ALMZ…, mt = Fullbay PO).
 * -> { available:true, results: { 'UNIT|MT': { resolved, where, status, portalMt, matchedBy } } }
 *    or { available:false, authNeeded?:true, error }
 */
async function lookupOrders(items) {
  const seen = new Set(); const list = [];
  for (const it of (items || [])) {
    const unit = String(it.unit || '').trim().toUpperCase();
    const mt = cleanMT(it.mt);
    const rawMt = String(it.mt || '').trim().toUpperCase();
    if (!unit && !mt) continue;
    const key = unit + '|' + rawMt; // key matches orderKey(unit, rawPO)
    if (seen.has(key)) continue; seen.add(key);
    list.push({ unit, mt, key });
  }
  if (!list.length) return { available: true, results: {} };

  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, { headless: true });
  const page = ctx.pages()[0] || (await ctx.newPage());
  let token = null; let template = null;
  page.on('request', (req) => {
    if (TICKETS_RE.test(req.url())) { const a = req.headers()['authorization']; if (a) token = a; if (!template) template = req.url(); }
  });
  try {
    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    // Wait for the page to fire its tickets request (means we're signed in).
    for (let i = 0; i < 40 && !token; i++) await sleep(500);
    // Not signed in? Try saved credentials, then wait again.
    if (!token && credsSet()) {
      console.log('  Vorto: session not active - attempting automatic sign-in...');
      await autoLogin(page);
      for (let i = 0; i < 30 && !token; i++) await sleep(500);
      if (token) console.log('  Vorto: signed in automatically.');
    }
    if (!token || !template) {
      const why = credsSet() ? 'Automatic Vorto sign-in failed (check the saved Vorto login).' : 'Not signed in to Vorto (save Vorto credentials in Settings, or use "Sign in to Vorto").';
      return { available: false, authNeeded: true, error: why };
    }

    const resolved = indexTickets(await fetchView(ctx, template, token, 'resolved'));
    const open = indexTickets(await fetchView(ctx, template, token, 'open'));
    console.log('  Vorto: ' + resolved.byUnit.size + ' resolved units, ' + open.byUnit.size + ' open units (read live via API).');

    const results = {};
    for (const it of list) {
      /*
       * The MT on the Fullbay SO is the authority, and matching is EXACT.
       *
       * A unit routinely carries several MTs — one resolved, another still open.
       * Matching on the unit therefore answers the wrong question: it says "has
       * this trailer ever been resolved", when what matters is whether THIS
       * order's MT is resolved. The old code checked the unit first, so an order
       * whose own MT was still open passed because some other MT for the same
       * unit had been closed.
       *
       * So when the SO has an MT we decide on that MT alone and never fall back
       * to the unit. Unit matching survives only for an order with no MT at all,
       * and is reported as such (matchedBy: 'unit') so it can be treated as the
       * weaker evidence it is.
       */
      const k = mtKey(it.mt);
      if (k) {
        const hit = resolved.byPid.get(k);
        if (hit) {
          results[it.key] = { resolved: true, where: 'resolved', status: hit.status || 'Resolved',
            portalMt: hit.pid || it.mt, matchedBy: 'mt' };
          continue;
        }
        const openHit = open.byPid.get(k);
        if (openHit) {
          results[it.key] = { resolved: false, where: 'open', status: openHit.status || 'Open',
            portalMt: openHit.pid || it.mt, matchedBy: 'mt' };
          continue;
        }
        // This exact MT is in neither view. Not "resolved via the unit" — the MT
        // the order was billed against simply isn't in the portal.
        results[it.key] = { resolved: false, where: 'missing', status: '', portalMt: '', matchedBy: '' };
        continue;
      }

      // No MT on the order at all — unit is the only thing left to go on.
      let rec = it.unit && resolved.byUnit.get(it.unit);
      if (rec) {
        results[it.key] = { resolved: true, where: 'resolved', status: rec.status || 'Resolved',
          portalMt: rec.pid || '', matchedBy: 'unit' };
        continue;
      }
      rec = it.unit && open.byUnit.get(it.unit);
      if (rec) {
        results[it.key] = { resolved: false, where: 'open', status: rec.status || 'Open',
          portalMt: rec.pid || '', matchedBy: 'unit' };
        continue;
      }
      results[it.key] = { resolved: false, where: 'missing', status: '', portalMt: '', matchedBy: '' };
    }
    return { available: true, results };
  } catch (e) {
    return { available: false, error: e.message };
  } finally {
    await ctx.close();
  }
}

// Key used in the results map (UNIT|RAW-PO, both upper) so audit.js can look results up.
function orderKey(unit, mt) { return (String(unit || '').trim().toUpperCase()) + '|' + (String(mt || '').trim().toUpperCase()); }

// Open the portal in a visible window so a person can sign in; session saved to .vorto-profile.
async function signIn(maxMinutes = 10) {
  const context = await chromium.launchPersistentContext(PROFILE_DIR, { headless: false, viewport: null, args: ['--start-maximized'] });
  const page = context.pages()[0] || (await context.newPage());
  try {
    await page.goto(URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
    if (credsSet()) { if (await autoLogin(page)) { console.log('Vorto: signed in automatically with saved credentials - session saved.'); await sleep(1000); return true; } }
    console.log('Sign in to the Vorto portal in the window that opened - it will close automatically once you are in.');
    const deadline = Date.now() + maxMinutes * 60000;
    while (Date.now() < deadline) {
      if (await page.$('.ag-center-cols-container .ag-row')) { console.log('Vorto sign-in detected - session saved.'); await sleep(1500); return true; }
      await sleep(1500);
    }
    return false;
  } finally {
    await context.close();
  }
}

module.exports = { lookupOrders, orderKey, signIn, credsSet, cleanMT, mtKey, indexTickets};

// CLI self-test: node vorto.js ALMZ1234DV:MT-XXXX ALMZ5678DV:MT-YYYY  (mt optional)
if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    if (!args.length) { console.log('usage: node vorto.js UNIT[:MT] [UNIT[:MT] ...]'); process.exit(0); }
    const items = args.map((a) => { const [unit, mt] = a.split(':'); return { unit, mt: mt || '' }; });
    console.log(JSON.stringify(await lookupOrders(items), null, 2));
    process.exit(0);
  })();
}

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
 * Matching: a unit passes if it (or its PO's MT) appears among resolved tickets.
 *  - asset.name in the API = the unit (ALMZ…); pid = the ticket MT (MT-…).
 *  - The PO's MT is cleaned first (strip stray ":" / ")" etc., keep MT-XXXX), since
 *    final-invoicing edits sometimes leave extra chars on the Fullbay PO.
 *  - Duplicate tickets per unit are fine: present in "resolved" at all = resolved.
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const PROFILE_DIR = path.join(__dirname, '.vorto-profile');
const CREDS_PATH = path.join(__dirname, 'vorto-credentials.json');
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
function indexTickets(tickets) {
  const byUnit = new Map(); const byPid = new Map();
  for (const t of tickets) {
    const unit = ((t.asset && t.asset.name) || '').toUpperCase();
    const pid = (t.pid || '').toUpperCase();
    const status = (t.status && (t.status.displayName || t.status.name)) || '';
    const rec = { unit, pid, status };
    if (unit && !byUnit.has(unit)) byUnit.set(unit, rec);
    if (pid && !byPid.has(pid)) byPid.set(pid, rec);
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
      let rec = (it.unit && resolved.byUnit.get(it.unit)) || (it.mt && resolved.byPid.get(it.mt));
      if (rec) { results[it.key] = { resolved: true, where: 'resolved', status: rec.status || 'Resolved', portalMt: rec.pid || it.mt, matchedBy: (it.unit && resolved.byUnit.has(it.unit)) ? 'unit' : 'mt' }; continue; }
      rec = (it.unit && open.byUnit.get(it.unit)) || (it.mt && open.byPid.get(it.mt));
      if (rec) { results[it.key] = { resolved: false, where: 'open', status: rec.status || 'Open', portalMt: rec.pid || it.mt, matchedBy: (it.unit && open.byUnit.has(it.unit)) ? 'unit' : 'mt' }; continue; }
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

module.exports = { lookupOrders, orderKey, signIn, credsSet, cleanMT };

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

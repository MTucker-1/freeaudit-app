/*
 * vorto.js — LIVE check of the Vorto vendor maintenance-ticket portal.
 *
 * For each Fullbay order we know the UNIT number (ALMZ…). This drives the real
 * portal and reports whether that unit's ticket is RESOLVED. Reads the live site
 * every run (no cached copy to go stale). Login saved in .vorto-profile; if it
 * expired this returns { available:false, authNeeded:true } so the audit says so
 * loudly instead of guessing.
 *
 * IMPORTANT lessons baked in here:
 *  - Match by the UNIT (ALMZ) number, NOT the Fullbay "MT" PO. The PO on the
 *    Fullbay order is a DIFFERENT number than the portal's ticket ID for the same
 *    unit (e.g. unit ALMZ2204DV is resolved under ticket MT-7R7KGFS2, while the
 *    Fullbay PO is MT-FR1FI82M). The unit number is the reliable join key.
 *  - The Search box only filters when you TYPE real keystrokes; setting the value
 *    programmatically (fill) does nothing. So we use pressSequentially.
 *  - Toggles "Hide Completed" / "Hide Deferrable" hide resolved tickets when on —
 *    turn them OFF before searching.
 *  - Grid is AG Grid: col-id "pid" = portal ticket id, "asset.name" = unit,
 *    "status" = ticket status. Rows are virtualized, so we search per unit.
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const PROFILE_DIR = path.join(__dirname, '.vorto-profile');
const CREDS_PATH = path.join(__dirname, 'vorto-credentials.json');
const URL = 'https://vorto-maint-tickets.web.app/vendor-portal';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RESOLVED_RE = /^(resolved|complete|completed|closed)$/i;

// Saved Vorto login (its own username/password — different from Fullbay), used to
// auto-sign-in when the saved browser session has expired.
function readCreds() {
  try {
    if (!fs.existsSync(CREDS_PATH)) return null;
    const c = JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8'));
    if (!c.username || !c.password || /PUT-YOUR/i.test(c.username) || /PUT-YOUR/i.test(c.password)) return null;
    return c;
  } catch (e) { return null; }
}
function credsSet() { return !!readCreds(); }

// Try to sign into Vorto automatically by filling the login form. Returns true if
// it lands on the ticket grid. Resilient selectors (the login page wasn't pinned).
async function autoLogin(page) {
  const cred = readCreds();
  if (!cred) return false;
  const pw = await page.$('input[type="password"]');
  if (!pw) return false; // not on a login page
  // Vorto's username field is a PHONE NUMBER (input[type=tel], placeholder "Phone
  // number") — not an email. Keep email/text fallbacks just in case it changes.
  const user = await page.$('input[type="tel"], input[autocomplete="tel"], input[type="email"], input[name*="phone" i], input[name*="user" i], input[type="text"]');
  try {
    if (user) await user.fill(cred.username);
    await pw.fill(cred.password);
    const btn = await page.$('button:has-text("Log in"), button:has-text("Login"), button:has-text("Sign in"), button[type="submit"], input[type="submit"]');
    if (btn) await btn.click({ timeout: 5000 }).catch(() => {}); else await page.keyboard.press('Enter');
    await sleep(2500);
    // After signing in, make sure we land on the portal grid.
    await page.goto(URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForSelector('.ag-center-cols-container .ag-row', { timeout: 20000 }).catch(() => {});
  } catch (e) { return false; }
  return !!(await page.$('.ag-center-cols-container .ag-row'));
}

function gridRowsInPage() {
  const rs = [...document.querySelectorAll('.ag-center-cols-container .ag-row')];
  const cell = (r, c) => { const x = r.querySelector('[col-id="' + c + '"]'); return x ? x.textContent.trim() : ''; };
  return rs.map((r) => ({ pid: cell(r, 'pid'), asset: cell(r, 'asset.name'), status: cell(r, 'status') })).filter((x) => x.pid || x.asset);
}

// Read a Hide toggle's state: 'ON' | 'OFF' | 'missing' | 'unknown'. Searches a few
// ancestor levels for the checkbox (the label and the switch aren't siblings).
async function readToggle(page, label) {
  return page.evaluate((lbl) => {
    const leaf = [...document.querySelectorAll('*')].find((e) => e.childElementCount === 0 && e.textContent.trim() === lbl);
    if (!leaf) return 'missing';
    let node = leaf;
    for (let i = 0; i < 5 && node; i++) {
      const cb = node.querySelector && node.querySelector('input[type=checkbox]');
      if (cb) return cb.checked ? 'ON' : 'OFF';
      const aria = node.querySelector && node.querySelector('[aria-checked]');
      if (aria) return aria.getAttribute('aria-checked') === 'true' ? 'ON' : 'OFF';
      node = node.parentElement;
    }
    return 'unknown';
  }, label);
}

// Force a Hide toggle to the desired state, verifying and retrying. Returns the
// final observed state so the caller can confirm/log it.
async function setToggle(page, label, desiredOn) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const state = await readToggle(page, label);
    if (state === 'missing') return 'missing';
    if (state !== 'unknown' && (state === 'ON') === desiredOn) return state; // already correct
    try { await page.getByText(label, { exact: true }).first().click(); } catch (e) { /* ignore */ }
    await sleep(700);
    const after = await readToggle(page, label);
    if (after !== 'unknown' && (after === 'ON') === desiredOn) return after;
  }
  return readToggle(page, label);
}

async function clickTab(page, name) {
  const btn = page.getByRole('button', { name, exact: true });
  if (await btn.count()) await btn.first().click(); else await page.getByText(name, { exact: true }).first().click();
  await page.waitForLoadState('networkidle').catch(() => {});
  await sleep(1200);
}

// Type a term as real keystrokes (so the live filter fires) and wait for the grid
// to settle. Returns the rendered rows.
async function searchTerm(page, term) {
  const box = page.getByPlaceholder('Search');
  await box.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Delete');
  await sleep(250);
  await box.pressSequentially(term, { delay: 40 });
  let rows = []; let prev = -2; let stable = 0;
  for (let i = 0; i < 14; i++) {
    await sleep(400);
    rows = await page.evaluate(gridRowsInPage);
    if (rows.some((r) => r.asset.toUpperCase() === term.toUpperCase() || r.pid.toUpperCase() === term.toUpperCase())) break;
    if (rows.length === prev) { stable++; if (stable >= 2) break; } else { stable = 0; prev = rows.length; }
  }
  return rows;
}

// Key used in the results map. Caller rebuilds it the same way: UNIT|MT (upper).
function orderKey(unit, mt) { return (String(unit || '').trim().toUpperCase()) + '|' + (String(mt || '').trim().toUpperCase()); }

// Find, on whichever tab is loaded, any ticket whose UNIT matches `unit` OR whose
// ticket id matches `mt`. Searches by unit first (the reliable join), then by MT.
// Returns the best matching row (a resolved one if present) or null. `unitCache`
// avoids re-searching the same unit.
async function findTicket(page, unit, mt, unitCache) {
  let rows = [];
  if (unit) {
    if (!unitCache.has(unit)) unitCache.set(unit, (await searchTerm(page, unit)).filter((r) => r.asset.toUpperCase() === unit));
    rows = unitCache.get(unit).slice();
  }
  if (!rows.length && mt) {
    rows = (await searchTerm(page, mt)).filter((r) => r.pid.toUpperCase() === mt);
  }
  if (!rows.length) return null;
  // Duplicate tickets for a unit: prefer a RESOLVED one ("resolved on at least one").
  return rows.find((r) => RESOLVED_RE.test(r.status)) || rows[0];
}

/*
 * lookupOrders(items) — items: [{ unit, mt }] (unit = ALMZ…, mt = Fullbay PO).
 * Confirms each order's unit/MT against the LIVE portal. A unit passes if ANY of
 * its (possibly duplicate) tickets is resolved, matched by unit OR by MT.
 *
 * -> { available:true, results: { 'UNIT|MT': { resolved, where:'resolved'|'open'|'missing',
 *        status, portalMt, matchedBy:'unit'|'mt'|'' } } }
 *    or { available:false, authNeeded:true } / { available:false, error:'...' }
 */
async function lookupOrders(items) {
  const seen = new Set();
  const list = [];
  for (const it of (items || [])) {
    const unit = String(it.unit || '').trim().toUpperCase();
    const mt = String(it.mt || '').trim().toUpperCase();
    if (!unit && !mt) continue;
    const key = orderKey(unit, mt);
    if (seen.has(key)) continue;
    seen.add(key);
    list.push({ unit, mt, key });
  }
  if (!list.length) return { available: true, results: {} };

  const context = await chromium.launchPersistentContext(PROFILE_DIR, { headless: true, viewport: { width: 1700, height: 1100 } });
  const page = context.pages()[0] || (await context.newPage());
  try {
    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    let ok = await page.waitForSelector('.ag-center-cols-container .ag-row', { timeout: 25000 }).then(() => true).catch(() => false);
    // Session expired? Try the saved Vorto credentials before giving up.
    if (!ok && credsSet()) {
      console.log('  Vorto: session not active — attempting automatic sign-in…');
      if (await autoLogin(page)) { ok = true; console.log('  Vorto: signed in automatically.'); }
    }
    if (!ok) {
      const hasGrid = await page.$('.ag-root-wrapper');
      const why = credsSet() ? 'Automatic Vorto sign-in failed (check the saved Vorto login, or it may need a verification code).' : 'Not signed in to Vorto (no saved login — use "Sign in to Vorto" or save Vorto credentials in Settings).';
      return { available: false, authNeeded: !hasGrid, error: hasGrid ? 'Portal loaded but no rows appeared.' : why };
    }
    await sleep(800);

    const results = {};
    for (const it of list) results[it.key] = { resolved: false, where: 'missing', status: '', portalMt: '', matchedBy: '' };

    // Phase 1 — Resolved tab (hide toggles OFF): resolved if a matching ticket exists here.
    await clickTab(page, 'Resolved');
    await setToggle(page, 'Hide Completed', false);
    const hdR = await setToggle(page, 'Hide Deferrable', false);
    await sleep(600);
    console.log('  Vorto [Resolved tab]: Hide Deferrable = ' + hdR + (hdR === 'OFF' ? ' (good)' : ' (WARNING — could not confirm OFF)'));
    if (hdR === 'ON') return { available: false, error: 'Could not turn off "Hide Deferrable" — resolved deferrable tickets would be hidden.' };
    let cache = new Map();
    for (const it of list) {
      const row = await findTicket(page, it.unit, it.mt, cache);
      if (row) results[it.key] = { resolved: true, where: 'resolved', status: row.status || 'Resolved', portalMt: row.pid || '', matchedBy: row.asset.toUpperCase() === it.unit ? 'unit' : 'mt' };
    }

    // Phase 2 — Open tab: classify the rest as still-open (a matching ticket exists) vs missing.
    const unresolved = list.filter((it) => !results[it.key].resolved);
    if (unresolved.length) {
      await clickTab(page, 'Open');
      await setToggle(page, 'Hide Completed', false);
      const hdO = await setToggle(page, 'Hide Deferrable', false);
      await sleep(600);
      console.log('  Vorto [Open tab]: Hide Deferrable = ' + hdO + (hdO === 'OFF' ? ' (good)' : ' (WARNING — could not confirm OFF)'));
      cache = new Map();
      for (const it of unresolved) {
        const row = await findTicket(page, it.unit, it.mt, cache);
        if (row) results[it.key] = { resolved: false, where: 'open', status: row.status || 'Open', portalMt: row.pid || '', matchedBy: row.asset.toUpperCase() === it.unit ? 'unit' : 'mt' };
      }
    }

    return { available: true, results };
  } catch (e) {
    return { available: false, error: e.message };
  } finally {
    await context.close();
  }
}

// Open the portal in a visible window so a person can sign in; session saved to
// .vorto-profile. Closes itself once it detects you're in (the grid appears).
async function signIn(maxMinutes = 10) {
  const context = await chromium.launchPersistentContext(PROFILE_DIR, { headless: false, viewport: null, args: ['--start-maximized'] });
  const page = context.pages()[0] || (await context.newPage());
  try {
    await page.goto(URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
    // If credentials are saved, try them first — may not even need a human.
    if (credsSet()) { if (await autoLogin(page)) { console.log('Vorto: signed in automatically with saved credentials — session saved.'); await sleep(1000); return true; } }
    console.log('Sign in to the Vorto portal in the window that opened — it will close automatically once you are in.');
    const deadline = Date.now() + maxMinutes * 60000;
    while (Date.now() < deadline) {
      if (await page.$('.ag-center-cols-container .ag-row')) { console.log('Vorto sign-in detected — session saved.'); await sleep(1500); return true; }
      await sleep(1500);
    }
    console.log('Timed out waiting for sign-in.');
    return false;
  } finally {
    await context.close();
  }
}

module.exports = { lookupOrders, orderKey, signIn, credsSet };

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

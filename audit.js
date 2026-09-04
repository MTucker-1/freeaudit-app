/*
 * audit.js — Fullbay "Ready to Invoice" auto-auditor.
 *
 * Usage (run from the folder this file lives in):
 *   node audit.js probe     → calibration run: logs in, opens the list, clicks the
 *                             first order, and reports what it found. Use this first.
 *   node audit.js           → full run: audits every order and writes the report + CSV.
 *
 * Login: a real Chrome window opens. The FIRST time, log into Fullbay by hand.
 * The session is saved in the .fb-profile folder and reused on later runs.
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ExcelJS = require('exceljs');
const gsheets = require('./gsheets');
const vorto = require('./vorto');
const { runAudit, runOpenAudit, isServiceCall, classify } = require('./checks');
const { DATA_DIR, dataPath } = require('./paths');

const CONFIG = require('./settings').readConfig();
const PROFILE_DIR = dataPath('.fb-profile');
const MODE = (process.argv[2] || 'full').toLowerCase();

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Run fn over items with at most `limit` running at once (speeds up the many
// independent note/photo fetches per order without hammering Fullbay).
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let idx = 0;
  const worker = async () => { while (idx < items.length) { const i = idx++; out[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length || 1) }, worker));
  return out;
}
// page.$ can throw "Execution context was destroyed" if the page navigates
// mid-check (e.g. a session-timeout redirect). Treat that as "not found".
const safe$ = async (page, sel) => { try { return await page.$(sel); } catch { return null; } };
/* ----------------------------------------------------------------------------
 * In-page extraction. This runs INSIDE the live SO page (page.evaluate) and
 * pulls the same elements the drag-and-drop tool reads from saved HTML.
 * -------------------------------------------------------------------------- */
function extractServiceOrderInPage() {
  const textOf = (el) => (el && el.textContent ? el.textContent.trim() : '');

  // SO number — from the page header/title area.
  let soNumber = '';
  const titleM = (document.title || '').match(/SO-?\s*(\d+)/i);
  if (titleM) soNumber = 'SO-' + titleM[1];
  if (!soNumber) soNumber = textOf(document.querySelector('.navbar-span'));
  if (!soNumber) soNumber = textOf(document.querySelector('.so-header-container h3'));

  const customerName = textOf(document.querySelector('a[href*="viewCustomer.html?customerId="]'));
  const unitLink = document.querySelector('a.unit-link, a[href*="viewCustomerUnit.html"]');
  const unitNumber = textOf(unitLink).replace(/^Unit\s+/i, '');

  // Whole-SO attachment count (Check C depends on this).
  const attBadge = textOf(document.querySelector('#roImageButtonBadge'));
  const soAttachmentCount = /^\d+$/.test(attBadge) ? parseInt(attBadge, 10) : 0;

  const actionItems = [];
  document.querySelectorAll('.soai-container').forEach((c) => {
    const idM = (c.id || '').match(/repairOrderActionItemContainer(\d+)/);
    if (!idM) return;
    const id = idM[1];

    const nEl = c.querySelector('[data-soai-action-item-number]');
    const number = nEl ? nEl.getAttribute('data-soai-action-item-number') : '';

    let status = '';
    const sel = c.querySelector('select[id^="status"]');
    if (sel && sel.options[sel.selectedIndex]) status = textOf(sel.options[sel.selectedIndex]);

    let tech = '';
    c.querySelectorAll('.soai-technician-container span').forEach((sp) => {
      // The markup is <span><span class="bold">Assigned: </span>NAME</span>, so the
      // inner label span also starts with "Assigned:" but has no name — only take a
      // match that actually has a name after it, so the label span can't blank it out.
      const m = textOf(sp).match(/^Assigned:\s*(.+)$/i);
      if (m && m[1].trim()) tech = m[1].trim();
    });

    const originalNote = textOf(c.querySelector('.soai-original-note-container p'));
    const invoicedHours = parseFloat(textOf(c.querySelector('#invoicedHours' + id))) || 0;
    const actualHours = parseFloat(textOf(c.querySelector('#actualHours' + id))) || 0;

    // The status <select> is frequently EMPTY on an order that is still open —
    // the real state is the first progress step ("Diagnose", "Open",
    // "Repair In Progress", "Done"). Capture both and prefer whichever is set.
    const steps = [];
    let noParts = false;
    c.querySelectorAll('.progress-step label').forEach((l) => {
      const t = textOf(l);
      if (t) steps.push(t);
      if (/^No Parts$/i.test(t)) noParts = true;
    });
    const stepStatus = steps.find((t) => !/^No Parts$/i.test(t)) || '';
    // Parts started but never priced. Scan the item's text with <select> and
    // <option> stripped out — the status dropdown lists EVERY status, including
    // "Waiting On Parts Pricing", so reading raw textContent matches on every
    // single item.
    const clone = c.cloneNode(true);
    clone.querySelectorAll('select, option, datalist, script, template').forEach((n) => n.remove());
    const bodyText = textOf(clone);
    const QUOTE = /needs?\s*quote|quote\s*needed|awaiting\s*quote|waiting\s*on\s*parts\s*pricing/i;
    const needsQuote = QUOTE.test(bodyText) || QUOTE.test(stepStatus) || QUOTE.test(status);

    let photoCount = null;
    const pb = c.querySelector('[id^="actionItemImageCount"]');
    if (pb) {
      const pt = textOf(pb);
      photoCount = pt === '' ? 0 : (parseInt(pt, 10) || 0);
    }

    // Notes/comments count badge (roaiCommentsButtonBadge<id>).
    let noteCount = 0;
    const nb = c.querySelector('[id^="roaiCommentsButtonBadge"]');
    if (nb) { const nt = textOf(nb); noteCount = nt === '' ? 0 : (parseInt(nt, 10) || 0); }

    actionItems.push({
      id, number, status, stepStatus, needsQuote, technician: tech, originalNote,
      invoicedHours, actualHours, noParts, photoCount, noteCount,
    });
  });

  return { soNumber, customerName, unitNumber, soAttachmentCount, actionItems };
}

/* ----------------------------------------------------------------------------
 * Login handling: navigate to the list; if the Ready-to-Invoice table isn't
 * there, the user isn't logged in — wait for them to log in manually.
 * -------------------------------------------------------------------------- */
// Poll until the Ready-to-Invoice table actually has order rows (it loads
// its data a moment after the page appears). Returns the row count.
async function waitForRows(page, ms = 30000) {
  const deadline = Date.now() + ms;
  let n = 0;
  while (Date.now() < deadline) {
    let rows = [];
    try { rows = await readListRows(page); } catch { rows = []; }
    n = rows.length;
    if (n > 0) return n;
    // A "No data available" placeholder means the table loaded but is empty.
    if (await safe$(page, '#readyToInvoice td.dataTables_empty')) return 0;
    await sleep(1500);
  }
  return n;
}

// Read stored Fullbay credentials (local file, never leaves the PC). Returns null if absent/placeholder.
function readFullbayCreds() {
  const p = dataPath('fullbay-credentials.json');
  if (!fs.existsSync(p)) return null;
  try {
    const c = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (c && c.username && c.password && !/PUT-YOUR/i.test(c.username) && !/PUT-YOUR/i.test(c.password)) return c;
  } catch (e) { /* ignore */ }
  return null;
}

// Try to sign into Fullbay automatically by filling the login form. Returns true if it lands logged in.
const USER_SELECTOR = 'input[type="email"], input[name*="user" i], input[name*="email" i], '
  + 'input[id*="user" i], input[id*="email" i], input[autocomplete="username"], input[type="text"]';

/*
 * Fill Fullbay's login form and submit it.
 *
 * Deliberately plain, because the clever version kept failing:
 *  - page.fill(selector) rather than element handles. A handle grabbed a moment
 *    earlier goes stale when the page re-renders, and .fill() then throws — the
 *    old code caught that and returned "login failed" WITHOUT EVER SUBMITTING.
 *  - a flat wait after submit rather than waitForFunction. Submitting bounces
 *    through several redirects, and evaluating anything mid-flight throws
 *    "Execution context was destroyed".
 * Each step is individually guarded, so one hiccup cannot abandon the sign-in.
 */
async function autoLoginFullbay(page) {
  const cred = readFullbayCreds();
  if (!cred) return false;
  if (!(await safe$(page, 'input[type="password"]'))) return false; // not a login page

  const tryStep = async (fn) => { try { await fn(); return true; } catch (e) { return false; } };

  await tryStep(() => page.fill(USER_SELECTOR, cred.username, { timeout: 10000 }));
  const typed = await tryStep(() => page.fill('input[type="password"]', cred.password, { timeout: 10000 }));
  if (!typed) return false;

  const clicked = await tryStep(() => page.click('button[type="submit"], input[type="submit"]', { timeout: 8000 }));
  if (!clicked) await tryStep(() => page.keyboard.press('Enter'));

  // Let the redirect chain finish. Ten seconds is what a real sign-in takes here.
  await sleep(10000);
  return true;
}

/*
 * opts.autoLogin  — false when a HUMAN is signing in on purpose. Filling the
 *   password form is worse than useless for a single-sign-on account: Fullbay
 *   offers "Continue with Microsoft", the submitted form gets nowhere, and the
 *   page is left spinning so the person cannot use the login screen either.
 * opts.waitMinutes — how long to wait for that human.
 */
/*
 * Kill any Chromium still holding OUR browser profile. Playwright will otherwise
 * "open in existing browser session" and hand back a blank window that never
 * navigates. Matching is on the exact --user-data-dir, so only browsers this app
 * started are ever touched.
 */
async function releaseProfileLock(profileDir) {
  if (process.platform !== 'win32') return;
  const { execSync } = require('child_process');
  try {
    const esc = profileDir.replace(/\\/g, '\\\\').replace(/'/g, "''");
    const ps = `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | `
      + `Where-Object { $_.CommandLine -like '*--user-data-dir=${esc}*' } | `
      + `ForEach-Object { $_.ProcessId }`;
    const out = execSync(`powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`,
      { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'ignore'] });
    const pids = out.split(/\r?\n/).map((s) => s.trim()).filter((s) => /^\d+$/.test(s));
    if (!pids.length) return;
    log(`  Clearing ${pids.length} leftover browser process(es) holding the sign-in profile…`);
    pids.forEach((pid) => {
      try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore', timeout: 10000 }); } catch (e) { /* already gone */ }
    });
    // Chromium also leaves a lockfile behind after a hard kill.
    try { fs.rmSync(path.join(profileDir, 'lockfile'), { force: true }); } catch (e) { /* ignore */ }
  } catch (e) {
    // Best effort only — never block a run because cleanup failed.
  }
}

/** Wait for the Ready-to-Invoice table to actually render. */
async function waitForList(page, ms) {
  try { await page.waitForSelector('#readyToInvoice', { timeout: ms }); return true; }
  catch (e) { return false; }
}

async function ensureListLoaded(page, opts = {}) {
  const autoLogin = opts.autoLogin !== false;
  const waitMinutes = opts.waitMinutes || 5;

  await page.goto(CONFIG.listUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
  // Fullbay serves the LOGIN page at this same URL when the session is gone, so
  // a password box means "signed out" — don't sit waiting for a table that is
  // never going to appear. Only wait for the table when we look signed in.
  if (!(await safe$(page, 'input[type="password"]'))
      && await waitForList(page, 20000)) { await waitForRows(page); return true; }

  // Try automatic sign-in with stored credentials before asking for a human,
  // but never against a single-sign-on screen — see above.
  if (autoLogin && readFullbayCreds()) {
    const ssoOnly = await page.evaluate(() => {
      const t = (document.body && document.body.innerText) || '';
      const hasSso = /continue with microsoft|sign in with microsoft|use microsoft/i.test(t)
        || !!document.querySelector('a[href*="microsoftonline"], a[href*="/sso"], button[data-provider="microsoft"]');
      const hasPw = !!document.querySelector('input[type="password"]');
      return hasSso && !hasPw;
    }).catch(() => false);

    if (ssoOnly) {
      log('  Fullbay is asking for a Microsoft sign-in — that has to be done by hand.');
    } else {
      log('  Attempting automatic Fullbay sign-in…');
      await autoLoginFullbay(page);
      await page.goto(CONFIG.listUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
      if (await waitForList(page, 30000)) { log('  Signed in automatically.\n'); await waitForRows(page); return true; }
      log('  Automatic sign-in did not complete — waiting for a manual sign-in.');
    }
  }

  log('\n  ──────────────────────────────────────────────');
  log('  Please log into Fullbay in the browser window.');
  log('  Use "Continue with Microsoft" if that is how you normally sign in.');
  log('  I will continue automatically once the list loads.');
  log('  ──────────────────────────────────────────────\n');

  const deadline = Date.now() + waitMinutes * 60 * 1000;
  while (Date.now() < deadline) {
    // Waiting for the selector (rather than checking once and reloading) is what
    // gives the AJAX table time to render. Reloading every couple of seconds
    // restarts the load and the table never appears — the page just spins.
    if (await waitForList(page, 8000)) {
      log('  Logged in — list found.\n');
      await waitForRows(page);
      return true;
    }
    // Still on a login screen? DO NOT touch the page — let the person type.
    // Otherwise RELOAD: after a sign-in completes, re-requesting the list URL is
    // what actually picks up the new session. (Checking the URL is useless here —
    // Fullbay serves the login page at the list URL too.)
    const onLogin = await safe$(page, 'input[type="password"]');
    if (!onLogin) {
      await page.goto(CONFIG.listUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
    }
    await sleep(1500);
  }
  throw new Error('Timed out waiting for login / the Ready-to-Invoice list.');
}

// Try to show all rows on one page (avoids pagination).
async function showAllRows(page) {
  try {
    const sel = await page.$('select[name="readyToInvoice_length"]');
    if (sel) {
      const values = await sel.$$eval('option', (opts) => opts.map((o) => o.value));
      // Pick the largest numeric option (or -1 = "All" if present).
      let best = values.includes('-1') ? '-1' : values.map(Number).filter((n) => !isNaN(n))
        .sort((a, b) => b - a)[0];
      if (best !== undefined) {
        await sel.selectOption(String(best));
        await sleep(CONFIG.slowDownMs + 600);
        await waitForRows(page); // changing length reloads the table
      }
    }
  } catch (e) { /* non-fatal */ }
}

// Read every order from the DataTable's in-memory data. Each row object carries
// a `windowOpen` URL containing the repairOrderId — that's how we get the ID for
// all rows (the visible HTML doesn't show it).
async function readListRows(page) {
  return page.evaluate(() => {
    const jq = window.jQuery || window.$;
    if (!jq || !jq.fn || !jq.fn.dataTable || !jq.fn.dataTable.isDataTable('#readyToInvoice')) return [];
    const data = jq('#readyToInvoice').DataTable().rows().data().toArray();
    return data.map((d, idx) => {
      const m = (d.windowOpen || '').match(/repairOrderId=(\d+)/);
      return {
        idx,
        soNumber: (d.soNumber || '').trim(),
        repairOrderId: m ? m[1] : null,
        customer: d.customer || '',
        unit: d.unit || '',
        serviceWriter: d.serviceWriter || '',
        poNumber: d.poNumber || '',
        poRequired: d.poNumberRequired || '',
        completedDate: d.completedDate || null, // epoch seconds, for weekly billed-hours buckets
      };
    }).filter((r) => /^SO-?\d+/i.test(r.soNumber));
  });
}

/* ----------------------------------------------------------------------------
 * Open one order by navigating directly to its view page (the proven path).
 * Returns true if action-item containers rendered.
 * -------------------------------------------------------------------------- */
async function openOrderById(page, repairOrderId) {
  const url = `${CONFIG.baseUrl}/office/workorder/viewRepairOrder.html?repairOrderId=${repairOrderId}`;
  await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForSelector('.soai-container', { timeout: 20000 }).catch(() => {});
  await sleep(CONFIG.slowDownMs);
  return (await page.$('.soai-container')) !== null;
}

// Fetch the photo file URLs for one action item from Fullbay's editImages endpoint.
async function fetchActionItemPhotoUrls(context, aiId) {
  const limit = CONFIG.imageLimit || 50;
  const url = `${CONFIG.baseUrl}/office/global/editImages.html?classDirectory=workorder&showForCustomer=1` +
    `&tableName=RepairOrderActionItem&primaryKeyId=${aiId}&imageLimit=${limit}&ajax=1`;
  const resp = await context.request.get(url).catch(() => null);
  if (!resp || !resp.ok()) return [];
  const body = await resp.text();
  // Stored photo files look like /files/<n>/RepairOrderActionItem/<token>.jpg?<ts>
  const matches = [...body.matchAll(/["'](\/files\/[^"']+?\.(?:jpe?g|png|webp|gif))(?:\?[^"']*)?["']/gi)];
  return [...new Set(matches.map((m) => m[1]))];
}

// Fetch the notes/comments on one action item (author, time, text).
async function fetchActionItemNotes(context, aiId) {
  const url = `${CONFIG.baseUrl}/office/workorder/handleRepairOrderActionItem.html`;
  const resp = await context.request.post(url, {
    form: { cmd: 'getListRepairOrderActionItemNote', repairOrderActionItemId: aiId },
  }).catch(() => null);
  if (!resp || !resp.ok()) return [];
  let data; try { data = JSON.parse(await resp.text()); } catch (e) { return []; }
  return ((data && data.list) || []).map((n) => ({
    text: (n.note || '').trim(), author: n.authorName || '', when: n.correctedCreated || n.created || '',
  })).filter((n) => n.text);
}

// Download an image, save it locally (named by its content hash so identical
// photos share one file), and return its SHA-256 + local filename.
async function fetchAndStorePhoto(context, fileUrl, photosDir) {
  const full = fileUrl.startsWith('http') ? fileUrl : CONFIG.baseUrl + fileUrl;
  const r = await context.request.get(full).catch(() => null);
  if (!r || !r.ok()) return null;
  const buf = await r.body().catch(() => null);
  if (!buf || buf.length === 0) return null;
  const hash = crypto.createHash('sha256').update(buf).digest('hex');
  const extM = fileUrl.match(/\.(jpe?g|png|webp|gif)(?:\?|$)/i);
  const ext = extM ? '.' + extM[1].toLowerCase() : '.jpg';
  const localFile = hash + ext;
  const dest = path.join(photosDir, localFile);
  if (!fs.existsSync(dest)) fs.writeFileSync(dest, buf);
  return { hash, localFile };
}

/* ----------------------------------------------------------------------------
 * PROBE MODE — calibration. Log in, open the list, click the first order,
 * and report exactly what was found so we can confirm selectors together.
 * -------------------------------------------------------------------------- */
async function runProbe(page, context) {
  await ensureListLoaded(page);
  await showAllRows(page);
  const rows = await readListRows(page);

  log('═══════════════════════════════════════════════');
  log(' PROBE RESULTS');
  log('═══════════════════════════════════════════════');
  log(` List URL: ${page.url()}`);
  log(` Rows found in Ready-to-Invoice table: ${rows.length}`);
  log(` First few: ${rows.slice(0, 8).map((r) => r.soNumber).join(', ')}`);
  log(` Rows that expose a repair-order-id: ${rows.filter((r) => r.repairOrderId).length} of ${rows.length}`);
  if (!rows.length) { log('\n No rows found — selector/URL needs adjusting.'); return; }

  // --- Diagnostic 0: can we read all repair-order-ids from the DataTable's
  //     internal data (the library keeps full row data in memory)? ---
  const dtProbe = await page.evaluate(() => {
    const jq = window.jQuery || window.$;
    const out = { hasJq: !!jq, isDataTable: false, sample: null, count: 0, keysWithId: [] };
    if (!jq || !jq.fn || !jq.fn.dataTable) return out;
    if (!jq.fn.dataTable.isDataTable('#readyToInvoice')) return out;
    out.isDataTable = true;
    const dt = jq('#readyToInvoice').DataTable();
    const data = dt.rows().data().toArray();
    out.count = data.length;
    out.sample = data[0];
    // Find which fields in a row object look like an id.
    if (data[0] && typeof data[0] === 'object' && !Array.isArray(data[0])) {
      out.keysWithId = Object.keys(data[0]).filter((k) => /id/i.test(k));
    }
    return out;
  });
  log('\n DIAGNOSTIC 0 — DataTable internal data:');
  log('   jQuery present: ' + dtProbe.hasJq + '   is DataTable: ' + dtProbe.isDataTable);
  log('   row count: ' + dtProbe.count);
  log('   id-like keys: ' + JSON.stringify(dtProbe.keysWithId));
  log('   first row raw: ' + JSON.stringify(dtProbe.sample).slice(0, 600));

  // --- Diagnostic 1: what's actually inside the first row? ---
  const rowInfo = await page.$eval('#readyToInvoice tbody tr', (tr) => {
    const attrs = {};
    [...tr.attributes].forEach((a) => { attrs[a.name] = a.value; });
    const a = tr.querySelector('a[href]');
    const firstCell = tr.querySelector('td');
    return {
      rowAttrs: attrs,
      rowOnclick: tr.getAttribute('onclick'),
      anchorHref: a ? a.getAttribute('href') : null,
      firstCellHtml: firstCell ? firstCell.outerHTML.slice(0, 300) : null,
      firstCellOnclick: firstCell ? firstCell.getAttribute('onclick') : null,
    };
  });
  log('\n DIAGNOSTIC 1 — first row internals:');
  log('   row attributes: ' + JSON.stringify(rowInfo.rowAttrs));
  log('   row onclick:    ' + (rowInfo.rowOnclick || '(none)'));
  log('   anchor href:    ' + (rowInfo.anchorHref || '(no <a> in row)'));
  log('   first cell:     ' + (rowInfo.firstCellHtml || '(none)'));

  // --- Diagnostic 2: does clicking open a NEW TAB? ---
  log('\n DIAGNOSTIC 2 — clicking the first row, watching for a new tab...');
  let popup = null;
  const onPage = (p) => { popup = p; };
  context.on('page', onPage);
  const before = page.url();
  await page.locator('#readyToInvoice tbody tr').first().locator('td').first().click({ timeout: 5000 }).catch(() => {});
  await sleep(4000);
  context.off('page', onPage);
  log('   tabs open now: ' + context.pages().length);
  log('   main tab URL:  ' + page.url() + (page.url() === before ? '  (unchanged)' : '  (changed)'));
  if (popup) {
    await popup.waitForLoadState('domcontentloaded').catch(() => {});
    await sleep(2000);
    const cnt = await popup.$$eval('.soai-container', (e) => e.length).catch(() => 0);
    log('   NEW TAB opened: ' + popup.url());
    log('   action-item containers in new tab: ' + cnt);
  } else {
    log('   no new tab opened.');
  }

  // --- Diagnostic 3: does the direct-URL pattern work? ---
  const withId = rows.find((r) => r.repairOrderId);
  if (withId) {
    const testUrl = `https://app.fullbay.com/office/workorder/viewRepairOrder.html?repairOrderId=${withId.repairOrderId}`;
    log(`\n DIAGNOSTIC 3 — trying direct URL for ${withId.soNumber}:`);
    log('   ' + testUrl);
    await page.goto(testUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForSelector('.soai-container', { timeout: 12000 }).catch(() => {});
    const cnt = await page.$$eval('.soai-container', (e) => e.length).catch(() => 0);
    log('   landed at: ' + page.url());
    log('   action-item containers found: ' + cnt);
    if (cnt > 0) {
      const so = await page.evaluate(extractServiceOrderInPage);
      log(`   extracted ${so.soNumber} — ${so.actionItems.length} items, ` +
        `${runAudit(so).length} issue(s). Direct-URL approach WORKS.`);
    }
  } else {
    log('\n DIAGNOSTIC 3 — skipped (no repair-order-id available to test).');
  }

  log('\n Probe done. Browser stays open 45s.');
  await sleep(45000);
}

/* ----------------------------------------------------------------------------
 * FULL MODE — audit every order, write HTML report + CSV.
 * -------------------------------------------------------------------------- */
async function runFull(page, context) {
  const t0 = Date.now();
  // Timing on every startup phase. Without it, a slow run is indistinguishable
  // from a stuck one — you just watch a browser sit there.
  const phase = (label, since) => log(`  [${((Date.now() - t0) / 1000).toFixed(1)}s] ${label} took ${((Date.now() - since) / 1000).toFixed(1)}s`);

  let mark = Date.now();
  await ensureListLoaded(page);
  phase('sign-in / list', mark);

  mark = Date.now();
  const rows = await readListRows(page);
  phase(`reading the list (${rows.length} orders)`, mark);

  let limit = rows.length;
  if (CONFIG.maxOrders && CONFIG.maxOrders > 0) limit = Math.min(limit, CONFIG.maxOrders);

  const doPhotos = CONFIG.checkDuplicatePhotos !== false;

  // Load the Google Sheet "complete" tracker — live from Google when configured,
  // otherwise from a local .xlsx export (which may be stale).
  let sheet = null;
  if (CONFIG.checkSheetCompletion !== false) {
    mark = Date.now();
    sheet = await loadSheetCompletionMap();
    phase('loading the sheet trackers', mark);
    if (sheet) {
      const src = sheet.live ? 'LIVE Google Sheets' : 'local .xlsx export (may be stale)';
      log(`Sheet tracker [${src}]: ${sheet.map.size} units from ${sheet.tabsUsed.length} tab(s) across ${sheet.files.length} source(s): ${sheet.files.join(', ')}.`);
    } else {
      log('Sheet tracker: no live sheet configured and no .xlsx export found — skipping the "complete in sheet" check.');
    }
  }

  log(`Found ${rows.length} orders in Ready to Invoice. Auditing ${limit}.` +
    (doPhotos ? ' (fingerprinting photos for duplicates)' : '') + '\n');

  const results = [];
  const allPhotos = []; // {soNumber, aiNumber, technician, url, hash, localFile}
  const photosDir = dataPath('photos');
  if (doPhotos) {
    fs.rmSync(photosDir, { recursive: true, force: true }); // fresh each run
    fs.mkdirSync(photosDir, { recursive: true });
  }
  for (let i = 0; i < limit; i++) {
    const r = rows[i];
    process.stdout.write(`  [${i + 1}/${limit}] ${r.soNumber} ... `);
    if (!r.repairOrderId) {
      log('no order id — skipped');
      results.push({ soNumber: r.soNumber, url: '', error: 'No order id found in list', findings: [] });
      continue;
    }
    try {
      const ok = await openOrderById(page, r.repairOrderId);
      if (!ok) {
        log('no action items on page — skipped');
        results.push({ soNumber: r.soNumber, url: page.url(), error: 'Order page had no action items', findings: [] });
      } else {
        const so = await page.evaluate(extractServiceOrderInPage);
        if (!so.soNumber) so.soNumber = r.soNumber;
        so.poNumber = r.poNumber; // PO comes from the list data

        // Fetch notes/comments FIRST and attach to each action item, so the checks
        // (especially "No Parts") can read what the note actually says.
        const notes = [];
        if (CONFIG.includeNotes !== false) {
          so.actionItems.forEach((ai) => { if (!ai.noteCount || ai.noteCount <= 0) ai.notes = []; });
          const withNotes = so.actionItems.filter((ai) => ai.noteCount > 0);
          await mapLimit(withNotes, 6, async (ai) => {
            const list = await fetchActionItemNotes(context, ai.id);
            ai.notes = list;
            list.forEach((n) => notes.push({ aiNumber: ai.number || ai.id, ...n }));
          });
        }

        const findings = runAudit(so, { inspectionSoPhotoMin: CONFIG.inspectionSoPhotoMin });
        const technicians = [...new Set(so.actionItems.map((a) => a.technician).filter(Boolean))];

        // Service-call identifier: real "Service Call (In/Out Hours)", NOT "Drive to unit (Service Call)".
        const serviceCall = so.actionItems.some((a) => isServiceCall(a.originalNote));
        // The Google-sheet tracker is for INSPECTION completion only, so Check G applies
        // ONLY to inspection orders (BIT, DOT/PM, PM Only). Service calls and pure repairs
        // aren't on the tracker and must NOT be flagged. (Vorto Check H still applies to all.)
        const hasInspection = so.actionItems.some((a) => classify(a.originalNote).isInspection);

        // Check G — is this unit marked complete in the current-year tracker tabs?
        const unitNum = so.unitNumber || r.unit;
        let sheetComplete; let sheetStatus;
        if (sheet) {
          const entry = sheet.map.get(normUnit(unitNum));
          sheetComplete = !!(entry && entry.complete);
          sheetStatus = entry ? entry.status : 'Not found';
          if (!sheetComplete && hasInspection) {
            findings.push({
              check: 'G', severity: 'warning',
              title: 'Unit not marked complete in tracker',
              detail: entry
                ? `Unit ${unitNum} shows "${entry.status}" in tab "${entry.tab}" — Fullbay has it at Ready to Invoice.`
                : `Unit ${unitNum} was not found in any ${sheet.year} tab of the tracker.`,
            });
          }
        }

        results.push({
          soNumber: so.soNumber, url: page.url(), repairOrderId: r.repairOrderId,
          customerName: so.customerName || r.customer, unitNumber: unitNum,
          serviceWriter: r.serviceWriter || '', technicians, poNumber: r.poNumber,
          sheetComplete, sheetStatus, notes, serviceCall,
          actionItemCount: so.actionItems.length, findings,
        });

        // Download photos: save each locally (for the report) and fingerprint it.
        // Photo-URL lookups and the downloads themselves run concurrently (capped),
        // which is the biggest per-order speedup for orders with many photos.
        let photoCt = 0;
        if (doPhotos) {
          const withPhotos = so.actionItems.filter((ai) => ai.photoCount > 0);
          const urlLists = await mapLimit(withPhotos, 6, (ai) => fetchActionItemPhotoUrls(context, ai.id));
          const tasks = [];
          withPhotos.forEach((ai, k) => (urlLists[k] || []).forEach((u) => tasks.push({ ai, u })));
          const saved = await mapLimit(tasks, 6, async (t) => {
            const s = await fetchAndStorePhoto(context, t.u, photosDir);
            return s ? { ai: t.ai, url: t.u, hash: s.hash, localFile: s.localFile } : null;
          });
          for (const s of saved) {
            if (!s) continue;
            allPhotos.push({ soNumber: so.soNumber, aiNumber: s.ai.number || s.ai.id, technician: s.ai.technician || '', url: s.url, hash: s.hash, localFile: s.localFile });
            photoCt++;
          }
        }
        log(`${so.actionItems.length} items, ${findings.length} issue(s)` + (doPhotos ? `, ${photoCt} photos` : ''));
      }
    } catch (e) {
      log(`ERROR: ${e.message}`);
      results.push({ soNumber: r.soNumber, url: page.url(), error: e.message, findings: [] });
    }
    await sleep(CONFIG.slowDownMs);
  }

  // --- Cross-order pass: flag duplicate PO numbers (same PO on >1 order) ---
  const poMap = {};
  results.forEach((r) => {
    const po = (r.poNumber || '').trim();
    if (!po) return;
    (poMap[po] = poMap[po] || []).push(r.soNumber);
  });
  results.forEach((r) => {
    const po = (r.poNumber || '').trim();
    if (po && poMap[po].length > 1) {
      const others = poMap[po].filter((s) => s !== r.soNumber);
      r.findings.push({
        check: 'E', severity: 'blocker',
        title: 'Duplicate PO number',
        detail: 'PO "' + po + '" is also used on: ' + others.join(', ') + '. Each order should have its own PO.',
      });
    }
  });

  // --- Cross-order pass: flag the SAME photo reused on DIFFERENT service orders ---
  // (Reuse within a single order is intentionally ignored.)
  const hashMap = {};
  allPhotos.forEach((p) => { (hashMap[p.hash] = hashMap[p.hash] || []).push(p); });
  const dupInfo = {}; // hash -> [distinct SOs] for photos reused across orders
  Object.entries(hashMap).forEach(([h, group]) => {
    const sos = [...new Set(group.map((p) => p.soNumber))];
    if (sos.length > 1) dupInfo[h] = sos;
  });
  // One finding per affected order, listing the OTHER orders sharing its photo.
  Object.keys(dupInfo).forEach((h) => {
    const sos = dupInfo[h];
    sos.forEach((soNum) => {
      const mine = hashMap[h].filter((p) => p.soNumber === soNum);
      const aiNums = [...new Set(mine.map((p) => p.aiNumber))];
      const others = sos.filter((s) => s !== soNum);
      const r = results.find((rr) => rr.soNumber === soNum);
      if (!r) return;
      // Don't add the same other-order list twice for one order.
      const dupKey = 'F|' + others.join(',') + '|' + aiNums.join(',');
      r._dupKeys = r._dupKeys || new Set();
      if (r._dupKeys.has(dupKey)) return;
      r._dupKeys.add(dupKey);
      r.findings.push({
        check: 'F', severity: 'blocker', technician: mine[0].technician,
        title: 'Reused photo on ' + (aiNums.length > 1 ? 'Action Items ' + aiNums.join(', ') : 'Action Item ' + aiNums[0]),
        detail: 'A photo on this order is the exact same image used on: ' + others.join(', ') +
          '. Same photo across different service orders.',
      });
    });
  });
  results.forEach((r) => { delete r._dupKeys; r.photos = allPhotos.filter((p) => p.soNumber === r.soNumber); });
  log(`Photo fingerprints: ${allPhotos.length} photos, ${Object.keys(dupInfo).length} reused across orders.`);

  // --- Check H — is each order's MT (PO) resolved in the Vorto portal? ---
  // LIVE read: drives the real portal each run (no cached copy to go stale).
  // One batched browser session checks every MT. If the Vorto sign-in has
  // expired we log it loudly and mark nothing, rather than guess.
  if (CONFIG.checkVortoResolved !== false) {
    const unitOf = (r) => (r.unitNumber || '').trim();
    const mtOf = (r) => (r.poNumber || '').trim();
    // Check any order that has a unit number or a valid-looking MT (PO).
    const checkable = results.filter((r) => unitOf(r) || /^MT-[A-Za-z0-9]{6,}$/i.test(mtOf(r)));
    if (checkable.length) {
      log(`Vorto portal: checking ${checkable.length} order(s) live (by unit / MT)…`);
      const v = await vorto.lookupOrders(checkable.map((r) => ({ unit: unitOf(r), mt: mtOf(r) })));
      if (!v.available) {
        log(`Vorto portal: COULD NOT CHECK — ${v.authNeeded ? 'not signed in (use "Sign in to Vorto")' : v.error}. No orders were marked unresolved.`);
      } else {
        let flagged = 0;
        for (const r of checkable) {
          const info = v.results[vorto.orderKey(unitOf(r), mtOf(r))];
          r.vorto = info || null;
          // Flat aliases for the FLSS portal, which reads `vortoResolved` /
          // `vortoStatus` if they are present. Without these, check H shows up in
          // the portal as findings with no supporting portal state.
          r.vortoResolved = info ? !!info.resolved : null;
          r.vortoStatus = info ? (info.status || info.where || '') : '';
          if (info && !info.resolved) {
            flagged++;
            const isOpen = info.where === 'open';
            r.findings.push({
              check: 'H', severity: isOpen ? 'blocker' : 'warning',
              title: isOpen ? 'Ticket not resolved in Vorto' : 'Unit/MT not found in Vorto',
              detail: isOpen
                ? `Unit ${unitOf(r)} is still OPEN in Vorto (ticket ${info.portalMt}, status "${info.status}") — resolve it before invoicing.`
                : `Neither unit ${unitOf(r)} nor PO ${mtOf(r) || '(none)'} matched a resolved ticket in the Vorto portal (searched Resolved + Open, deferrable included).`,
            });
          }
        }
        log(`Vorto portal: ${flagged} order(s) not resolved (of ${checkable.length} checked).`);
      }
    }
  }

  // --- Open service orders: the second section of the audit ---
  let openOrders = [];
  if (CONFIG.auditOpenSos !== false) {
    const mk = Date.now();
    try {
      openOrders = await auditOpenSos(page);
      fs.writeFileSync(dataPath('open-sos.json'),
        JSON.stringify({ generatedAt: new Date().toISOString(), orders: openOrders }, null, 2), 'utf8');
    } catch (e) {
      log('Open SOs: section failed — ' + e.message);
    }
    phase('auditing open orders', mk);
  }

  // Record this run for the week-by-week scorecard. Never let a scorecard
  // problem cost us the report, so it is best-effort and comes first only in the
  // sense that it reads `results` before the writers touch anything.
  try {
    if (require('./scorecard').recordRun(results)) log('Scorecard: run recorded.');
  } catch (e) { log('Scorecard: could not record this run — ' + e.message); }

  writeCsv(results);
  writeJson(results, dupInfo, allPhotos);
  writeHtml(results, dupInfo, openOrders);
  const totalFindings = results.reduce((n, r) => n + r.findings.length, 0);
  const flaggedOrders = results.filter((r) => r.findings.length).length;

  // --- Impact summary for the FreeAudit dashboard ---
  const byCheck = {};
  results.forEach((r) => r.findings.forEach((f) => { byCheck[f.check] = (byCheck[f.check] || 0) + 1; }));
  const minsPerOrder = CONFIG.manualMinutesPerOrder || 8;

  const summary = {
    timestamp: new Date().toISOString(),
    ordersChecked: results.length,
    flaggedOrders,
    cleanOrders: results.length - flaggedOrders,
    totalFindings,
    blockers: results.reduce((n, r) => n + r.findings.filter((f) => f.severity === 'blocker').length, 0),
    byCheck,
    photos: allPhotos.length,
    duplicatePhotos: Object.keys(dupInfo).length,
    estMinutesSaved: results.length * minsPerOrder,
    manualMinutesPerOrder: minsPerOrder,
    runSeconds: Math.round((Date.now() - t0) / 1000),
  };
  fs.writeFileSync(dataPath('audit-summary.json'), JSON.stringify(summary, null, 2), 'utf8');

  log(`\nDone. ${flaggedOrders} of ${results.length} orders have issues (${totalFindings} findings total).`);
  log('Reports written: audit-report.html  and  audit-results.csv');
}

/* ----------------------------------------------------------------------------
 * PHOTOS MODE — investigation. Open a few orders and dump everything about
 * their photos/attachments so we can see how Fullbay labels before/after/paperwork.
 * Writes the dump to photo-investigation.json for review.
 * -------------------------------------------------------------------------- */
async function runPhotoProbe(page, context) {
  await ensureListLoaded(page);
  const rows = await readListRows(page);
  // Look at a spread of orders, preferring inspection-titled ones (likely to have checklists).
  const sample = rows.slice(0, 6);
  log(`Investigating photos on ${sample.length} orders...\n`);

  const dump = [];
  for (const r of sample) {
    if (!r.repairOrderId) continue;
    const ok = await openOrderById(page, r.repairOrderId);
    if (!ok) { log(`  ${r.soNumber}: no action items`); continue; }

    // Try to reveal photos: click any attachment/image buttons so thumbnails render.
    const buttons = await page.$$('[id*="ImageButton" i], [class*="attach" i] button, [class*="image" i] a, .soai-container [class*="camera" i]');
    for (const b of buttons.slice(0, 4)) { await b.click({ timeout: 1500 }).catch(() => {}); await sleep(300); }
    await sleep(800);

    const info = await page.evaluate(() => {
      const trim = (s) => (s || '').toString().trim().slice(0, 120);
      const isReal = (src) => src && src.indexOf('data:') !== 0 &&
        !/loading|spinner|placeholder|icon|logo|favicon|user-placeholder/i.test(src) &&
        (/\.(png|jpe?g|gif|webp)/i.test(src) || /image|attachment|photo|document/i.test(src));
      const out = { soAttachmentBadge: trim((document.querySelector('#roImageButtonBadge') || {}).textContent), actionItems: [], pageKeywords: [] };

      document.querySelectorAll('.soai-container').forEach((c) => {
        const idM = (c.id || '').match(/repairOrderActionItemContainer(\d+)/);
        if (!idM) return;
        const countEl = c.querySelector('[id^="actionItemImageCount"]');
        const imgs = [...c.querySelectorAll('img')].filter((im) => isReal(im.getAttribute('src')))
          .map((im) => ({ src: trim(im.getAttribute('src')), alt: trim(im.getAttribute('alt')), title: trim(im.getAttribute('title')) }));
        // Containers that might carry a caption/category label near a photo.
        const labels = [...c.querySelectorAll('[class*="attach" i],[class*="image" i],[class*="photo" i],[class*="caption" i],[class*="document" i],figcaption')]
          .map((e) => ({ tag: e.tagName, cls: trim(e.className), id: trim(e.id), txt: trim(e.textContent) }))
          .filter((e) => e.txt).slice(0, 12);
        out.actionItems.push({ id: idM[1], count: countEl ? trim(countEl.textContent) : null, imgCount: imgs.length, imgs: imgs.slice(0, 12), labels });
      });

      // Scan the whole page text for the words we care about.
      const body = (document.body.innerText || '').toLowerCase();
      ['before', 'after', 'paperwork', 'checklist', 'inspection', 'signature', 'document', 'category'].forEach((k) => {
        if (body.indexOf(k) > -1) out.pageKeywords.push(k);
      });
      return out;
    });
    info.soNumber = r.soNumber;
    dump.push(info);
    const totalImgs = info.actionItems.reduce((n, a) => n + a.imgCount, 0);
    log(`  ${r.soNumber}: badge=${info.soAttachmentBadge || '0'}, ${info.actionItems.length} items, ${totalImgs} photos in DOM, keywords: [${info.pageKeywords.join(', ')}]`);
    await sleep(CONFIG.slowDownMs);
  }

  fs.writeFileSync(dataPath('photo-investigation.json'), JSON.stringify(dump, null, 2), 'utf8');
  log('\nFull detail written to photo-investigation.json');
  log('Browser stays open 20s.');
  await sleep(20000);
}

/* ----------------------------------------------------------------------------
 * VIEWER MODE — open Fullbay's attachment viewer on one order that has photos,
 * and capture the real photo URLs (over the network) plus any caption/category
 * text. This tells us how before/after/paperwork are identified and gives us the
 * URLs we'd hash for duplicate detection.
 * -------------------------------------------------------------------------- */
async function runViewerProbe(page, context) {
  await ensureListLoaded(page);
  const rows = await readListRows(page);

  // Capture every image the page loads over the network.
  const netImages = [];
  page.on('response', (resp) => {
    const ct = resp.headers()['content-type'] || '';
    const u = resp.url();
    if (/^image\//i.test(ct) && !/svg/i.test(ct) &&
        !/icon|logo|sprite|placeholder|favicon|user-placeholder/i.test(u)) {
      netImages.push({ url: u.slice(0, 220), ct });
    }
  });

  // Find an order that actually has photos.
  let target = null;
  for (const r of rows.slice(0, 10)) {
    if (!r.repairOrderId) continue;
    if (!(await openOrderById(page, r.repairOrderId))) continue;
    const badge = await page.$eval('#roImageButtonBadge', (e) => e.textContent.trim()).catch(() => '0');
    const counts = await page.$$eval('[id^="actionItemImageCount"]', (els) => els.map((e) => e.textContent.trim()));
    if ((parseInt(badge, 10) || 0) > 0 || counts.some((c) => (parseInt(c, 10) || 0) > 0)) { target = r; break; }
  }
  if (!target) { log('No order with photos found in the first 10.'); return; }
  log(`Opening photos on ${target.soNumber}...`);

  netImages.length = 0; // only keep images loaded from here on

  // Try to open the SO-level attachments viewer, then the first action item's photos.
  const triggers = ['#roImageButton', '[id*="roImageButton"]', '[id^="actionItemImageCount"]',
    '[class*="camera" i]', '[class*="attachment" i] a', '[class*="image" i] a'];
  for (const sel of triggers) {
    const el = await page.$(sel);
    if (el) { await el.click({ timeout: 2000 }).catch(() => {}); await sleep(2500); }
  }
  await sleep(2000);

  const domDump = await page.evaluate(() => {
    const trim = (s) => (s || '').toString().trim().slice(0, 160);
    const imgs = [];
    document.querySelectorAll('img').forEach((im) => {
      const s = im.getAttribute('src') || '';
      if (s && s.indexOf('data:') !== 0 &&
          /(amazonaws|fullbay|attachment|repairorder|\.jpe?g|\.png|\.webp)/i.test(s) &&
          !/icon|logo|placeholder|user-placeholder|favicon/i.test(s)) {
        imgs.push({ src: trim(s), alt: trim(im.getAttribute('alt')), title: trim(im.getAttribute('title')) });
      }
    });
    const cats = [...document.querySelectorAll('[class*="categ" i],[class*="caption" i],[class*="tab" i],figcaption,select option,label')]
      .map((e) => trim(e.textContent)).filter(Boolean).slice(0, 50);
    return { domImages: imgs.slice(0, 50), captionsAndCategories: [...new Set(cats)] };
  });

  const dump = { soNumber: target.soNumber, ...domDump, networkImages: netImages.slice(0, 80) };
  fs.writeFileSync(dataPath('viewer-investigation.json'), JSON.stringify(dump, null, 2), 'utf8');
  log(`Captured ${dump.networkImages.length} image responses, ${dump.domImages.length} photo <img> in DOM.`);
  log('Detail in viewer-investigation.json. Browser stays open 30s so you can open a photo to compare.');
  await sleep(30000);
}

/* ----------------------------------------------------------------------------
 * AIHTML MODE — dump one action item's HTML and capture the network calls fired
 * when its photos open, so we can find how to reach the photo files for hashing.
 * -------------------------------------------------------------------------- */
async function runAiHtmlProbe(page, context) {
  await ensureListLoaded(page);
  const rows = await readListRows(page);

  const netCalls = [];
  page.on('request', (req) => {
    const u = req.url();
    if (/attachment|image|photo|document|gallery|getImages|listImages|repairOrderImage|file|s3|amazonaws/i.test(u) &&
        !/\.css|\.js$|pendo|intercom|googleapis|gstatic/i.test(u)) {
      netCalls.push({ method: req.method(), url: u.slice(0, 240) });
    }
  });

  // Find an order with an action item that has photos.
  let found = null;
  for (const r of rows.slice(0, 12)) {
    if (!r.repairOrderId) continue;
    if (!(await openOrderById(page, r.repairOrderId))) continue;
    const counts = await page.$$eval('[id^="actionItemImageCount"]', (els) =>
      els.map((e) => ({ id: e.id, n: parseInt(e.textContent.trim(), 10) || 0 })));
    const withPhoto = counts.find((c) => c.n > 0);
    if (withPhoto) { found = { r, countId: withPhoto.id }; break; }
  }
  if (!found) { log('No action item with photos found in first 12 orders.'); return; }
  log(`Found photos on ${found.r.soNumber} (${found.countId}). Dumping structure...`);

  netCalls.length = 0;
  // Click the photo-count element and its clickable ancestors to open the gallery.
  const countEl = await page.$('#' + found.countId);
  if (countEl) {
    await countEl.click({ timeout: 2000 }).catch(() => {});
    await sleep(1500);
    const anc = await page.evaluateHandle((id) => {
      const el = document.getElementById(id);
      return el ? (el.closest('a,button,[onclick],[data-toggle],.clickable') || el.parentElement) : null;
    }, found.countId);
    if (anc) { await anc.asElement()?.click({ timeout: 2000 }).catch(() => {}); await sleep(1500); }
  }
  await sleep(2000);

  // Dump the action item's HTML (trimmed) + what images are now in the DOM.
  const dump = await page.evaluate((countId) => {
    const el = document.getElementById(countId);
    const container = el ? el.closest('.soai-container') : null;
    let html = container ? container.outerHTML : '(container not found)';
    // Strip long data: URIs and scripts to keep it readable.
    html = html.replace(/data:[^"')\s]{60,}/g, 'data:[...]').replace(/<script[\s\S]*?<\/script>/gi, '');
    const imgs = [...document.querySelectorAll('img')]
      .map((im) => im.getAttribute('src') || '')
      .filter((s) => s && s.indexOf('data:') !== 0 && /(amazonaws|attachment|repairorder|fullbay.*\/image|\.jpe?g|\.png|\.webp)/i.test(s) && !/icon|logo|placeholder|dashboard|MOTOR/i.test(s));
    return { html: html.slice(0, 8000), photoImgs: imgs.slice(0, 30) };
  }, found.countId);

  fs.writeFileSync(dataPath('ai-html-dump.html'), dump.html, 'utf8');
  fs.writeFileSync(dataPath('ai-network-dump.json'),
    JSON.stringify({ soNumber: found.r.soNumber, photoImgs: dump.photoImgs, networkCalls: netCalls.slice(0, 60) }, null, 2), 'utf8');
  log(`Wrote ai-html-dump.html and ai-network-dump.json. Photo <img> found: ${dump.photoImgs.length}, network calls: ${netCalls.length}.`);
  log('Browser stays open 30s.');
  await sleep(30000);
}

/* ----------------------------------------------------------------------------
 * IMGAPI MODE — fetch the editImages.html data endpoint for an action item that
 * has photos and dump what it returns, so we can see the real image URLs.
 * -------------------------------------------------------------------------- */
async function runImgApiProbe(page, context) {
  await ensureListLoaded(page);
  const rows = await readListRows(page);

  // Find an action item id that has photos.
  let aiId = null; let soNum = null;
  for (const r of rows.slice(0, 12)) {
    if (!r.repairOrderId) continue;
    if (!(await openOrderById(page, r.repairOrderId))) continue;
    aiId = await page.evaluate(() => {
      for (const c of document.querySelectorAll('.soai-container')) {
        const badge = c.querySelector('[id^="actionItemImageCount"]');
        const n = badge ? (parseInt(badge.textContent.trim(), 10) || 0) : 0;
        const idM = (c.id || '').match(/repairOrderActionItemContainer(\d+)/);
        if (n > 0 && idM) return idM[1];
      }
      return null;
    });
    if (aiId) { soNum = r.soNumber; break; }
  }
  if (!aiId) { log('No action item with photos found.'); return; }
  log(`Fetching photo endpoint for ${soNum}, action item ${aiId}...`);

  const url = `${CONFIG.baseUrl}/office/global/editImages.html?classDirectory=workorder&showForCustomer=1` +
    `&tableName=RepairOrderActionItem&primaryKeyId=${aiId}&imageLimit=50&ajax=1`;
  const resp = await context.request.get(url);
  const body = await resp.text();
  fs.writeFileSync(dataPath('img-api-dump.html'), body, 'utf8');

  // Pull out any image-ish URLs from the returned HTML.
  const urls = [...body.matchAll(/(?:src|href|data-[\w-]*)\s*=\s*["']([^"']+)["']/gi)]
    .map((m) => m[1])
    .filter((u) => /amazonaws|attachment|getImage|downloadImage|\.jpe?g|\.png|\.webp|\.pdf|\.gif/i.test(u) &&
      !/loading|icon|logo|placeholder/i.test(u));
  fs.writeFileSync(dataPath('img-api-urls.json'),
    JSON.stringify({ soNumber: soNum, actionItemId: aiId, status: resp.status(), bodyLength: body.length, urls: [...new Set(urls)].slice(0, 40) }, null, 2), 'utf8');
  log(`Endpoint status ${resp.status()}, body ${body.length} bytes. Found ${[...new Set(urls)].length} image-ish URLs.`);
  log('See img-api-dump.html and img-api-urls.json.');
}

// Extract a spreadsheet ID from a Google Sheets URL.
function sheetIdFromUrl(u) {
  const m = (u || '').match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

/* ----------------------------------------------------------------------------
 * Google Sheet "complete" tracker (read from a locally-exported .xlsx).
 * -------------------------------------------------------------------------- */
function cellText(cell) {
  const v = cell && cell.value;
  if (v == null) return '';
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map((t) => t.text).join('');
    if (v.text != null) return String(v.text);
    if (v.result != null) return String(v.result);
    if (v instanceof Date) return v.toISOString();
    return '';
  }
  return String(v);
}
const normUnit = (s) => String(s == null ? '' : s).trim().toUpperCase();

// Newest .xlsx in the project folder (the user's exported tracker).
function findNewestXlsx() {
  const files = fs.readdirSync(DATA_DIR)
    .filter((f) => /\.xlsx$/i.test(f) && !f.startsWith('~$'))
    .map((f) => ({ f, m: fs.statSync(dataPath(f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  return files.length ? dataPath(files[0].f) : null;
}

// What a unit id looks like (ALMZ8277DV, ALMZ1177FB, OLMZ011442, ...).
const UNIT_RE = /^[A-Z]{2,4}\d/;
// Cell values that count as a status/completion entry (used to locate the column).
const STATUS_VOCAB = /^(complete|completed|done|in ?progress|in-progress|queued|queue|yes|no|y|n|pending|scheduled|n\/a|not ?performed|not ?done|incomplete)$/i;
// Cell values that mean the unit IS done.
const COMPLETE_RE = /^(complete|completed|done|yes|y|✓|x)$/i;

// Which tabs to read: current-year location tabs (e.g. "...26") OR a "Full Data" tab.
function currentYearTabFilter(year) {
  const short = year.slice(2);
  const yearRe = new RegExp(`\\b(${short}|${year})\\b`); // tab must mention e.g. "26" or "2026"
  return (name) => yearRe.test(name || '') || /full\s*data/i.test(name || '');
}

// Live sheet URLs/IDs to read. Supports an array (CONFIG.sheets) for multiple
// trackers, or the single CONFIG.sheetUrl as a fallback.
function sheetUrls() {
  if (Array.isArray(CONFIG.sheets) && CONFIG.sheets.length) return CONFIG.sheets.filter(Boolean);
  if (CONFIG.sheetUrl) return [CONFIG.sheetUrl];
  return [];
}

// Detect the unit + completion columns on ONE tab and return [{unit,status,complete}].
// Columns are found by CONTENT (the tabs are inconsistent — some have a "Status"
// column, some "DOT/PM PERFORMED Y/N", some no header at all), so this works the
// same whether the rows came from the live Google Sheet or a local .xlsx.
// `rows` is a 0-indexed 2D array of cell strings.
function extractTabCompletion(rows) {
  const R = rows.length;
  if (!R) return [];
  const maxC = Math.min(rows.reduce((m, r) => Math.max(m, r.length), 0), 40);
  if (!maxC) return [];
  const uval = (r, c) => normUnit(rows[r] && rows[r][c] != null ? rows[r][c] : '');
  const sval = (r, c) => String(rows[r] && rows[r][c] != null ? rows[r][c] : '').trim();

  // 1) Unit column = the column holding the most unit-style IDs.
  const unitScore = new Array(maxC).fill(0);
  for (let r = 0; r < R; r++) for (let c = 0; c < maxC; c++) if (UNIT_RE.test(uval(r, c))) unitScore[c]++;
  let unitCol = -1; let ubest = 1;
  for (let c = 0; c < maxC; c++) if (unitScore[c] > ubest) { ubest = unitScore[c]; unitCol = c; }
  if (unitCol < 0) return []; // no unit column on this tab

  // Header row(s) = leading rows where the unit column isn't yet a unit id.
  let headerRow = -1;
  for (let r = 0; r < Math.min(8, R); r++) {
    if (UNIT_RE.test(uval(r, unitCol))) break;
    headerRow = r;
  }
  const headerOf = (c) => (headerRow >= 0 ? sval(headerRow, c).toUpperCase() : '');

  // 2) Status/completion column = best mix of header hint + status-like values.
  const statusScore = new Array(maxC).fill(0);
  for (let r = headerRow + 1; r < R; r++) {
    if (!UNIT_RE.test(uval(r, unitCol))) continue;
    for (let c = 0; c < maxC; c++) {
      if (c === unitCol) continue;
      if (STATUS_VOCAB.test(sval(r, c))) statusScore[c]++;
    }
  }
  for (let c = 0; c < maxC; c++) {
    const h = headerOf(c);
    if (/STATUS/.test(h) && !/LOAD/.test(h)) statusScore[c] += 100000; // an explicit Status column wins
    else if (/PERFORMED/.test(h)) statusScore[c] += 50000;             // else a "DOT/PM PERFORMED Y/N" column
  }
  let statusCol = -1; let sbest = 0;
  for (let c = 0; c < maxC; c++) if (c !== unitCol && statusScore[c] > sbest) { sbest = statusScore[c]; statusCol = c; }
  if (statusCol < 0) return []; // can't tell completion on this tab

  const out = [];
  for (let r = headerRow + 1; r < R; r++) {
    const unit = uval(r, unitCol);
    if (!UNIT_RE.test(unit)) continue;
    const status = sval(r, statusCol);
    out.push({ unit, status, complete: COMPLETE_RE.test(status) });
  }
  return out;
}

// Merge many tabs into unit -> {status, complete, tab}. A "complete" in ANY tab wins.
function buildMapFromTabs(tabs) {
  const map = new Map();
  const tabsUsed = [];
  for (const { name, rows } of tabs) {
    const entries = extractTabCompletion(rows);
    if (!entries.length) continue;
    tabsUsed.push(name);
    for (const e of entries) {
      const prev = map.get(e.unit);
      if (!prev || (!prev.complete && e.complete)) map.set(e.unit, { status: e.status || '(blank)', complete: e.complete, tab: name });
    }
  }
  return { map, tabsUsed };
}

// Build unit -> {status, complete, tab}. Prefers the LIVE Google Sheets (always
// current) when an API key + sheet link(s) are configured; otherwise falls back
// to the newest local .xlsx export (which can be stale).
async function loadSheetCompletionMap() {
  const year = CONFIG.sheetYear || String(new Date().getFullYear()); // auto-advances each year
  const filterFn = currentYearTabFilter(year);

  // --- Preferred: live Google Sheets ---
  // Start from the configured links, then (if enabled) add every spreadsheet
  // shared with the service account. Auto-discovery is what makes a NEW market's
  // tracker start counting without anyone editing settings — share it with
  // gsheets.serviceAccountEmail() and it is picked up on the next run.
  let urls = sheetUrls();
  if (CONFIG.autoDiscoverSheets !== false && gsheets.serviceAccount()) {
    try {
      const found = await gsheets.listSpreadsheets();
      const seen = new Set(urls.map((u) => gsheets.idFromUrl(u)));
      let added = 0;
      for (const f of found) {
        if (seen.has(f.id)) continue;
        seen.add(f.id);
        urls.push('https://docs.google.com/spreadsheets/d/' + f.id + '/edit');
        added++;
      }
      log(`Sheet tracker: auto-discovery found ${found.length} shared spreadsheet(s); added ${added} beyond the configured links.`);
    } catch (e) {
      log(`Sheet tracker: auto-discovery unavailable (${e.message}). Using the configured sheet links only.`);
    }
  }
  if (gsheets.isConfigured() && urls.length) {
    try {
      // Read the trackers CONCURRENTLY. Sequentially this grew with every sheet
      // added, and it happens before the first order opens — so it reads as the
      // app "sitting on the Office page doing nothing".
      const settled = await Promise.all(urls.map(async (url) => {
        try { return { ok: true, sheet: await gsheets.readSpreadsheet(url, filterFn) }; }
        catch (e) {
          // One unreadable spreadsheet (permissions, deleted, not a tracker)
          // must not sink the whole completion check.
          return { ok: false, url, err: e.message };
        }
      }));
      const tabs = [];
      const titles = [];
      settled.forEach((r) => {
        if (!r.ok) { log(`Sheet tracker: skipped ${r.url} — ${r.err}`); return; }
        titles.push(r.sheet.title);
        for (const t of r.sheet.tabs) tabs.push(t);
      });
      const { map, tabsUsed } = buildMapFromTabs(tabs);
      return { map, files: titles, year, tabsUsed, live: true };
    } catch (e) {
      log(`Sheet tracker: LIVE Google Sheets read failed (${e.message}). Falling back to the local .xlsx export.`);
    }
  }

  // --- Fallback: local .xlsx export(s) ---
  let files;
  if (CONFIG.sheetFile) {
    const p = dataPath(CONFIG.sheetFile);
    files = fs.existsSync(p) ? [p] : [];
  } else {
    files = fs.readdirSync(DATA_DIR)
      .filter((f) => /\.xlsx$/i.test(f) && !f.startsWith('~$'))
      .map((f) => dataPath(f));
  }
  if (!files.length) return null;

  const tabs = [];
  for (const file of files) {
    let wb;
    try { wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(file); } catch (e) { continue; }
    for (const ws of wb.worksheets) {
      if (!filterFn(ws.name)) continue;
      const maxC = Math.min(ws.columnCount, 40);
      const maxR = ws.rowCount;
      if (!maxC || !maxR) continue;
      const rows = [];
      for (let r = 1; r <= maxR; r++) {
        const row = ws.getRow(r);
        const arr = [];
        for (let c = 1; c <= maxC; c++) arr.push(cellText(row.getCell(c)));
        rows.push(arr);
      }
      tabs.push({ name: ws.name, rows, file: path.basename(file) });
    }
  }
  const { map, tabsUsed } = buildMapFromTabs(tabs);
  const usedSet = new Set(tabsUsed);
  const filesUsed = [...new Set(tabs.filter((t) => usedSet.has(t.name)).map((t) => t.file))];
  return { map, files: filesUsed, year, tabsUsed, live: false };
}

/* ----------------------------------------------------------------------------
 * SHEET MODE — sign into Google in the same window, then read the tracking
 * spreadsheet: list its tabs and dump the current tab's columns so we can see
 * where the unit number and the "complete" status live.
 * -------------------------------------------------------------------------- */
async function runSheetProbe(page, context) {
  const sheetId = sheetIdFromUrl(CONFIG.sheetUrl);
  if (!sheetId) { log('No valid sheetUrl in config.'); return; }
  const gid = (CONFIG.sheetUrl.match(/gid=(\d+)/) || [])[1] || '0';
  const csvUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`;

  await page.goto(CONFIG.sheetUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
  log('\n  ──────────────────────────────────────────────');
  log('  If prompted, sign into Google in the browser window.');
  log('  I will continue once I can read the sheet.');
  log('  ──────────────────────────────────────────────\n');

  // Poll the authenticated CSV export until it returns real data (not a login page).
  let csv = null;
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    const r = await context.request.get(csvUrl).catch(() => null);
    if (r && r.ok()) {
      const t = await r.text();
      if (t && !t.trimStart().startsWith('<')) { csv = t; break; }
    }
    await sleep(3000);
  }
  if (csv == null) { log('Could not read the sheet (login not completed?).'); return; }

  // Tab names from the page DOM (the strip at the bottom).
  const tabs = await page.$$eval('.docs-sheet-tab-name', (els) => els.map((e) => e.textContent.trim())).catch(() => []);

  const rows = csv.split(/\r?\n/).slice(0, 15);
  fs.writeFileSync(dataPath('sheet-sample.csv'), csv.split(/\r?\n/).slice(0, 25).join('\n'), 'utf8');
  fs.writeFileSync(dataPath('sheet-tabs.json'), JSON.stringify({ sheetId, currentGid: gid, tabs }, null, 2), 'utf8');
  log(`Tabs found (${tabs.length}): ${tabs.join(' | ')}`);
  log(`\nFirst rows of the current tab (gid ${gid}):`);
  rows.forEach((r, i) => log(`  ${i}: ${r.slice(0, 200)}`));
  log('\nWrote sheet-sample.csv and sheet-tabs.json. Browser stays open 20s.');
  await sleep(20000);
}

/* ----------------------------------------------------------------------------
 * NOTES MODE — find how action-item notes/comments load, so we can show them.
 * -------------------------------------------------------------------------- */
async function runNotesProbe(page, context) {
  await ensureListLoaded(page);
  const rows = await readListRows(page);
  const reqs = [];
  page.on('request', (req) => {
    if (/handleRepairOrderActionItem\.html/i.test(req.url()) && req.method() === 'POST') {
      reqs.push({ url: req.url(), postData: (req.postData() || '').slice(0, 300) });
    }
  });
  const calls = [];
  page.on('response', async (resp) => {
    const u = resp.url();
    const ct = resp.headers()['content-type'] || '';
    // Capture any dynamic html/json (not static assets / 3rd-party).
    if (/json|html/i.test(ct) && !/\.css|\.js(\?|$)|pendo|intercom|googleapis|gstatic|stripe|fonts/i.test(u)
        && u.indexOf('viewRepairOrder.html') < 0 && u.indexOf('indexNew.html') < 0) {
      let body = '';
      try { body = (await resp.text()).slice(0, 400); } catch (e) { /* ignore */ }
      calls.push({ url: u.slice(0, 220), ct, body });
    }
  });

  let found = null;
  for (const r of rows.slice(0, 14)) {
    if (!r.repairOrderId) continue;
    if (!(await openOrderById(page, r.repairOrderId))) continue;
    // Look for a comment-count badge with a number, and grab its action-item id + the Notes button.
    found = await page.evaluate(() => {
      for (const c of document.querySelectorAll('.soai-container')) {
        const badge = c.querySelector('[id^="roaiCommentsButtonBadge"]');
        const n = badge ? (parseInt(badge.textContent.trim(), 10) || 0) : 0;
        const idM = (c.id || '').match(/repairOrderActionItemContainer(\d+)/);
        if (n > 0 && idM) return { aiId: idM[1], count: n };
      }
      return null;
    });
    if (found) { found.so = r.soNumber; break; }
  }
  if (!found) { log('No action item with notes found in first 14 orders.'); return; }
  log(`Found ${found.count} note(s) on ${found.so}, action item ${found.aiId}. Opening notes...`);

  calls.length = 0;
  const hadFn = await page.evaluate((id) => {
    if (window.toggleROAICommentModal) { window.toggleROAICommentModal(Number(id)); return true; }
    return false;
  }, found.aiId).catch(() => false);
  await sleep(3500);

  // Dump any visible modal / comment container text + the notes button markup.
  const dom = await page.evaluate((aiId) => {
    const trim = (s) => (s || '').toString().replace(/\s+/g, ' ').trim().slice(0, 300);
    const out = { fnExists: !!window.toggleROAICommentModal, modals: [], buttonHtml: '' };
    const btn = document.querySelector('[id="roaiCommentsButtonBadge' + aiId + '"]');
    if (btn && btn.closest('button')) out.buttonHtml = btn.closest('button').outerHTML.slice(0, 400);
    document.querySelectorAll('.modal, [role="dialog"], [id*="omment" i], [id*="oaiComment" i], [class*="comment" i]').forEach((m) => {
      const visible = m.offsetParent !== null || /show|in|open/.test(m.className);
      const txt = trim(m.textContent);
      if (txt) out.modals.push({ id: m.id, cls: trim(m.className), visible, txt });
    });
    return out;
  }, found.aiId);

  fs.writeFileSync(dataPath('notes-network.json'), JSON.stringify({ ...found, hadFn, reqs, calls, dom }, null, 2), 'utf8');
  log(`Captured ${reqs.length} POST(s) to handleRepairOrderActionItem.html:`);
  reqs.forEach((r) => log('  POST body: ' + r.postData));
  log('See notes-network.json. Browser stays open 10s.');
  await sleep(10000);
}

/* ----------------------------------------------------------------------------
 * Output writers.
 * -------------------------------------------------------------------------- */
function esc(s) {
  return (s == null ? '' : String(s)).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function csvCell(s) {
  const v = s == null ? '' : String(s);
  return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}

function writeCsv(results) {
  const lines = ['SO,Technician,ServiceWriter,Unit,CompleteInSheet,SheetStatus,Check,Severity,Title,Detail,URL'];
  results.forEach((r) => {
    const allTechs = (r.technicians || []).join('; ');
    const inSheet = r.sheetComplete === undefined ? '' : (r.sheetComplete ? 'Yes' : 'No');
    const sStatus = r.sheetStatus || '';
    const base = (extra) => [csvCell(r.soNumber), csvCell(extra.tech), csvCell(r.serviceWriter),
      csvCell(r.unitNumber), csvCell(inSheet), csvCell(sStatus), extra.check, extra.sev,
      csvCell(extra.title), csvCell(extra.detail), csvCell(r.url)].join(',');
    if (!r.findings.length) {
      lines.push(base({ tech: allTechs, check: '', sev: '', title: r.error ? 'ERROR' : 'OK', detail: r.error || 'No issues found' }));
    } else {
      r.findings.forEach((f) => {
        lines.push(base({ tech: f.technician || allTechs, check: f.check, sev: f.severity, title: f.title, detail: f.detail }));
      });
    }
  });
  // Prepend a UTF-8 BOM so Excel renders dashes/accents correctly.
  fs.writeFileSync(dataPath('audit-results.csv'), '﻿' + lines.join('\r\n'), 'utf8');
}

const CHECK_NAMES = {
  A: 'Photos', B: 'Parts', C: 'Inspections', D: 'Hours', E: 'PO', F: 'Dup photo', G: 'Sheet',
  H: 'Vorto',
  // No entry for address fixes on purpose — they are housekeeping, not findings,
  // so they never appear as a check against an order.
};

/*
 * writeJson — the full run as structured data. audit-report.html is for people;
 * this is the same information for another application (a hosted dashboard
 * rendering its own UI), so nothing has to parse our HTML.
 */
function writeJson(results, dupInfo = {}, allPhotos = []) {
  const out = {
    schema: 1,
    generatedAt: new Date().toISOString(),
    checkNames: CHECK_NAMES,
    counts: {
      orders: results.length,
      flaggedOrders: results.filter((r) => r.findings.length).length,
      findings: results.reduce((n, r) => n + r.findings.length, 0),
      blockers: results.reduce((n, r) => n + r.findings.filter((f) => f.severity === 'blocker').length, 0),
      duplicatePhotoGroups: Object.keys(dupInfo).length,
    },
    orders: results.map((r) => ({
      soNumber: r.soNumber,
      url: r.url,
      customerName: r.customerName || null,
      unitNumber: r.unitNumber || null,
      serviceWriter: r.serviceWriter || null,
      technicians: r.technicians || [],
      poNumber: r.poNumber || null,
      actionItemCount: r.actionItemCount ?? null,
      serviceCall: !!r.serviceCall,
      sheetComplete: r.sheetComplete ?? null,
      sheetStatus: r.sheetStatus || null,
      vorto: r.vorto || null,
      // What the address pass did. Deliberately NOT a finding — housekeeping.
      addressFix: r.addressFix || null,
      error: r.error || null,
      findings: (r.findings || []).map((f) => ({
        check: f.check,
        checkName: CHECK_NAMES[f.check] || null,
        severity: f.severity,
        title: f.title,
        detail: f.detail,
        technician: f.technician || null,
      })),
      // "reusedOn" mirrors the report's REUSED badge: other orders carrying this
      // exact photo. Derived from the hash map, same as writeHtml does.
      photos: (r.photos || []).map((p) => {
        const others = (dupInfo[p.hash] || []).filter((so) => so !== r.soNumber);
        return {
          file: p.localFile,
          aiNumber: p.aiNumber,
          technician: p.technician || null,
          reusedOn: others,
          duplicate: others.length > 0,
        };
      }),
    })),
  };

  /*
   * The FLSS portal agent reads `results` / `photos` / `dupInfo` — the raw
   * scrape — while everything else here reads the tidied `orders` view above.
   * Both live in this one file as a SUPERSET rather than two writers fighting
   * over the same filename, which is what an earlier patch attempt would have
   * done (its write ran last and silently replaced the structured output).
   */
  out.results = results;
  out.photos = allPhotos;
  out.dupInfo = dupInfo;

  fs.writeFileSync(dataPath('audit-results.json'), JSON.stringify(out, null, 2), 'utf8');
}

const ageInDaysSafe = (t) => { try { return require('./checks').ageInDays(t) || 0; } catch (e) { return 0; } };

/*
 * The MT on the order, shown where the service writer used to be — at this shop
 * the writer and the technician are the same person, so listing both said
 * nothing twice, and the MT is what you need when cross-checking Vorto.
 *
 * Shows the tidy MT when the PO parses as one. When it does not, the raw PO is
 * shown instead rather than a blank, so a malformed value stays visible (Check E
 * flags it separately).
 */
function mtLabel(r) {
  const raw = String(r.poNumber || '').trim();
  if (!raw) return ' · <span class="nomt">no MT</span>';
  const m = raw.toUpperCase().match(/MT-?[A-Z0-9]{4,}/);
  return ' · MT: ' + esc(m ? m[0] : raw);
}

function writeHtml(results, dupInfo = {}, openOrders = []) {
  const flagged = results.filter((r) => r.findings.length);
  const totalFindings = results.reduce((n, r) => n + r.findings.length, 0);

  // Render the photo gallery for one order, grouped by action item.
  const galleryHtml = (r) => {
    if (!r.photos || !r.photos.length) return '';
    const byAi = {};
    r.photos.forEach((p) => { (byAi[p.aiNumber] = byAi[p.aiNumber] || []).push(p); });
    const groups = Object.keys(byAi).map((ai) => {
      const thumbs = byAi[ai].map((p) => {
        const others = (dupInfo[p.hash] || []).filter((s) => s !== r.soNumber);
        const isDup = others.length > 0;
        const cap = isDup ? ('REUSED — also on ' + others.join(', ')) : '';
        return `<div class="thumb ${isDup ? 'dup' : ''}">
            <img src="photos/${esc(p.localFile)}" loading="lazy" onclick="lb('photos/${esc(p.localFile)}')" title="${esc(cap)}">
            ${isDup ? '<span class="dupbadge">REUSED</span>' : ''}</div>`;
      }).join('');
      return `<div class="aiphotos"><span class="ailbl">AI ${esc(ai)}</span>${thumbs}</div>`;
    }).join('');
    return `<details class="gallery"><summary>Photos (${r.photos.length})</summary>${groups}</details>`;
  };

  // Clickable notes panel for one order.
  const notesHtml = (r) => {
    const notes = r.notes || [];
    if (!notes.length) return '<div class="nonotes">No notes attached</div>';
    const items = notes.map((n) => `<div class="note">
        <div class="note-meta">AI ${esc(n.aiNumber)}${n.author ? ' · ' + esc(n.author) : ''}${n.when ? ' · ' + esc(n.when) : ''}</div>
        <div class="note-text">${esc(n.text)}</div></div>`).join('');
    return `<details class="notes"><summary>📝 Notes (${notes.length})</summary>${items}</details>`;
  };

  // Anchor id for one order, so the digest lists can jump straight to its card.
  const anchorFor = (r) => 'so-' + String(r.soNumber || '').replace(/[^A-Za-z0-9]+/g, '-');

  /*
   * Two plain lists at the top: what can be invoiced, and what still needs a
   * look. Just the SO numbers, so neither has to be hunted for by scrolling the
   * cards. Each is a link to its card further down.
   */
  // Plain, selectable numbers — no links. Clicking copies the bare number so it
  // can go straight into Fullbay's search box; selecting it by hand copies the
  // same thing, because that IS the text.
  const soList = (list) => (list.length
    ? list.map((r) => {
      const n = String(r.soNumber || '').replace(/^SO-?/i, '');
      return `<span class="so-num" data-n="${esc(n)}" title="Click to copy">${esc(n)}</span>`;
    }).join('')
    : '<span class="none">None</span>');

  const readyList = results.filter((r) => !r.error && !r.findings.length);
  const reviewList = results.filter((r) => r.error || r.findings.length);

  const cards = results.map((r) => {
    const sev = r.findings.some((f) => f.severity === 'blocker') ? 'blocker'
      : r.findings.length ? 'warning' : (r.error ? 'error' : 'ok');
    const findingHtml = r.error
      ? `<div class="f err">Could not audit: ${esc(r.error)}</div>`
      : (r.findings.length
        ? r.findings.map((f) => `<div class="f ${f.severity}">
            <span class="tag">${f.check} · ${CHECK_NAMES[f.check] || ''}</span>
            <strong>${esc(f.title)}</strong>${f.technician ? ' <span class="tech">' + esc(f.technician) + '</span>' : ''}
            <div class="det">${esc(f.detail)}</div></div>`).join('')
        : '<div class="f ok">No issues found.</div>');
    const techList = (r.technicians || []).join(', ');
    let sheetBadge = '';
    if (r.sheetComplete !== undefined) {
      sheetBadge = r.sheetComplete
        ? '<span class="sheet yes">Sheet: Yes</span>'
        : `<span class="sheet no">Sheet: No${r.sheetStatus && r.sheetStatus !== 'Not found' ? ' (' + esc(r.sheetStatus) + ')' : ' (not found)'}</span>`;
    }
    // Vorto badge, mirroring the Sheet badge. Three states, because "not in the
    // portal at all" is a different problem from "there but still open".
    let vortoBadge = '';
    if (r.vorto) {
      if (r.vorto.resolved) {
        vortoBadge = '<span class="sheet yes">Vorto: Yes</span>';
      } else if (r.vorto.where === 'missing') {
        vortoBadge = '<span class="sheet warn">Vorto: Not found</span>';
      } else {
        vortoBadge = `<span class="sheet no">Vorto: No${r.vorto.status ? ' (' + esc(r.vorto.status) + ')' : ''}</span>`;
      }
    }
    const scBadge = r.serviceCall ? '<span class="sc-badge">🛎 Service Call</span>' : '';
    return `<div class="so ${sev}" id="${anchorFor(r)}">
      <div class="so-head"><strong>${esc(r.soNumber)}</strong>${scBadge}
        <span class="meta">${esc(r.customerName || '')} ${r.unitNumber ? '· Unit ' + esc(r.unitNumber) : ''}
          ${techList ? '· Tech: ' + esc(techList) : ''}${mtLabel(r)}</span>
        ${sheetBadge}${vortoBadge}
        <a href="${esc(r.url)}" target="_blank">open</a></div>
      ${findingHtml}${notesHtml(r)}${galleryHtml(r)}</div>`;
  }).join('');

  /*
   * Open service orders — a separate section, because these are not billing
   * decisions. The question here is what is holding each order up.
   */
  const OPEN_NAMES = {
    O1: 'Open too long', O2: 'Still in progress', O3: 'Not started',
    O4: 'Awaiting parts quote', O5: 'No parts on repair',
    O6: 'No photos', O7: 'Missing before/after',
  };
  const openSection = !openOrders.length ? '' : `
  <div class="wrap">
    <h2 class="oh">Open service orders <span>${openOrders.length}</span></h2>
    <p class="osub">Still being worked. Sorted oldest first — age is how long the order has been open.</p>
    ${openOrders.slice().sort((a, b) => (ageInDaysSafe(b.ageText) - ageInDaysSafe(a.ageText))).map((o) => {
    const worst = o.findings.some((f) => f.severity === 'blocker') ? 'blocker'
      : (o.findings.length ? 'warning' : 'ok');
    const items = o.findings.length
      ? o.findings.map((f) => `<div class="f ${f.severity}">
          <span class="tag">${f.check} · ${OPEN_NAMES[f.check] || ''}</span>
          <strong>${esc(f.title)}</strong>${f.technician ? ' <span class="tech">' + esc(f.technician) + '</span>' : ''}
          <div class="det">${esc(f.detail)}</div></div>`).join('')
      : '<div class="f ok">Nothing outstanding.</div>';
    return `<div class="so ${worst}">
        <div class="so-head"><strong>${esc(o.soNumber)}</strong>
          <span class="age">${esc(o.ageText || '')}</span>
          <span class="meta">${esc(o.customer || '')} ${o.unit ? '· Unit ' + esc(o.unit) : ''}
            ${o.assignedTech ? '· Tech: ' + esc(o.assignedTech) : ''}</span>
          <span class="sheet ${/done/i.test(o.partsStatus || '') ? 'yes' : 'warn'}">Parts: ${esc(o.partsStatus || 'not set')}</span>
          <span class="sheet warn">${esc(o.serviceStatus || '')}</span>
        </div>${items}</div>`;
  }).join('')}
  </div>`;

  const blockers = results.reduce((n, r) => n + r.findings.filter((f) => f.severity === 'blocker').length, 0);
  const warnings = totalFindings - blockers;
  const photoCount = results.reduce((n, r) => n + ((r.photos && r.photos.length) || 0), 0);
  const clean = results.length - flagged.length;
  const tile = (v, l, cls) => `<div class="tile ${cls || ''}"><div class="tv">${v}</div><div class="tl">${l}</div></div>`;

  const html = `<!doctype html><html><head><meta charset="utf-8">
<title>FreeAudit — Audit Report</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
  :root{--navy:#0b2341;--red:#c8102e;--dim:#566380;--faint:#8a94a6;--line:#e6eaf1}
  *{box-sizing:border-box}
  body{font-family:'Inter','Segoe UI',Arial,sans-serif;background:#eef1f6;color:var(--navy);margin:0;padding:0 0 40px;-webkit-font-smoothing:antialiased;letter-spacing:-.01em}
  .wrap{max-width:1000px;margin:0 auto;padding:0 20px}
  .banner{background:radial-gradient(800px 320px at 88% -50%,#1f4488 0%,var(--navy) 60%);color:#fff;
    padding:30px 34px 70px;border-radius:0 0 26px 26px;box-shadow:0 14px 40px rgba(11,35,65,.25)}
  .banner h1{font-size:26px;font-weight:800;margin:0;letter-spacing:-.02em}
  .banner .sub{color:#bcd0ee;font-size:13.5px;margin-top:4px}
  .tiles{display:grid;grid-template-columns:repeat(5,1fr);gap:14px;margin:-46px auto 26px;max-width:1000px;padding:0 20px}
  .tile{background:#fff;border-radius:16px;padding:16px 14px;text-align:center;box-shadow:0 10px 26px rgba(11,35,65,.10);border:1px solid var(--line)}
  .tile .tv{font-size:28px;font-weight:800;color:var(--navy);line-height:1}
  .tile .tl{font-size:11.5px;font-weight:600;color:var(--dim);margin-top:6px;letter-spacing:.02em}
  .tile.red .tv{color:var(--red)}.tile.amber .tv{color:#b45309}.tile.green .tv{color:#15803d}
  .so{background:#fff;border:1px solid var(--line);border-radius:16px;padding:18px 20px;margin-bottom:14px;
    box-shadow:0 6px 18px rgba(11,35,65,.06);border-left:6px solid #cbd5e1;transition:transform .15s,box-shadow .15s}
  .so:hover{transform:translateY(-2px);box-shadow:0 16px 36px rgba(11,35,65,.12)}
  .so.blocker{border-left-color:var(--red)}.so.warning{border-left-color:#f59e0b}
  .so.ok{border-left-color:#16a34a}.so.error{border-left-color:#94a3b8}
  .so-head{display:flex;align-items:center;gap:12px;margin-bottom:10px;flex-wrap:wrap}
  .so-head strong{font-size:17px;font-weight:800}
  .so-head .meta{color:var(--dim);font-size:12.5px;flex:1;min-width:160px}
  .so-head a{font-size:12px;font-weight:600;color:#fff;background:var(--navy);padding:5px 12px;border-radius:8px;text-decoration:none}
  .so-head a:hover{background:#07182c}
  .sc-badge{font-size:11px;font-weight:800;border-radius:20px;padding:4px 11px;background:#dbeafe;color:#1e40af;white-space:nowrap}
  .sheet{font-size:11px;font-weight:700;border-radius:20px;padding:4px 11px;white-space:nowrap}
  .sheet.yes{background:#dcfce7;color:#15803d}.sheet.no{background:#fee2e2;color:#b91c1c}
  .sheet.warn{background:#fef3c7;color:#a16207}
  .oh{font-size:19px;font-weight:800;color:#0b2341;margin:34px 0 4px;display:flex;align-items:center;gap:10px}
  .oh span{font-size:15px;color:#a16207;background:#fef3c7;border-radius:20px;padding:3px 12px}
  .osub{font-size:12.5px;color:#7b8aa3;margin:0 0 14px}
  .age{font-size:11px;font-weight:700;background:#eef3fa;color:#15356b;border-radius:20px;padding:4px 11px;white-space:nowrap}
  .nomt{color:#b91c1c;font-weight:700}
  .f{font-size:13px;padding:9px 0;border-top:1px solid #f0f3f8;display:flex;flex-wrap:wrap;align-items:center;gap:6px}
  .f:first-of-type{border-top:none}
  .f .tag{font-size:10.5px;font-weight:800;border-radius:20px;padding:3px 10px;letter-spacing:.03em;text-transform:uppercase;background:#eef2f7;color:#334155}
  .f .ttl{font-weight:600}
  .f .tech{font-size:11px;color:var(--dim);background:#f1f5f9;border-radius:20px;padding:3px 10px}
  .f.blocker .tag{background:#fee2e2;color:#b91c1c}.f.warning .tag{background:#fef3c7;color:#b45309}
  .f.ok{color:#15803d;font-weight:600}.f.err{color:#b91c1c;font-weight:600}
  .det{color:var(--dim);margin-top:2px;flex-basis:100%;font-weight:400}
  .gallery,.notes{margin-top:12px;border-top:1px solid #f0f3f8;padding-top:10px}
  .gallery summary,.notes summary{cursor:pointer;font-size:12.5px;font-weight:700;color:var(--navy);outline:none;list-style:none;
    display:inline-flex;align-items:center;gap:6px;background:var(--navy-soft,#eef2f8);padding:6px 12px;border-radius:8px}
  .gallery summary{background:#eef2f8}
  .notes summary{background:#fff5e6;color:#9a6700}
  .gallery summary::before{content:'▸ ';color:var(--faint)}
  .gallery[open] summary::before{content:'▾ '}
  .nonotes{margin-top:12px;border-top:1px solid #f0f3f8;padding-top:10px;font-size:12px;color:var(--faint);font-style:italic}
  .note{margin:10px 0 0;padding:10px 12px;background:#fffaf0;border:1px solid #fde8c4;border-radius:10px}
  .note-meta{font-size:11px;font-weight:700;color:#9a6700;margin-bottom:3px}
  .note-text{font-size:13px;color:var(--navy);white-space:pre-wrap}
  .aiphotos{display:flex;align-items:center;flex-wrap:wrap;gap:9px;margin:10px 0}
  .ailbl{font-size:11px;font-weight:700;color:var(--dim);min-width:50px}
  .thumb{position:relative;width:90px;height:90px;border-radius:10px;overflow:hidden;border:2px solid var(--line);box-shadow:0 3px 10px rgba(11,35,65,.10);transition:transform .15s}
  .thumb:hover{transform:scale(1.05)}
  .thumb img{width:100%;height:100%;object-fit:cover;cursor:zoom-in;display:block}
  .thumb.dup{border-color:var(--red)}
  .dupbadge{position:absolute;bottom:0;left:0;right:0;background:var(--red);color:#fff;font-size:9px;font-weight:800;text-align:center;padding:2px 0;letter-spacing:.04em}
  #lbov{display:none;position:fixed;inset:0;background:rgba(7,24,44,.88);z-index:999;align-items:center;justify-content:center;cursor:zoom-out}
  #lbov img{max-width:92vw;max-height:92vh;border-radius:8px;box-shadow:0 20px 60px rgba(0,0,0,.6)}
  /* Two plain lists so the actionable SOs are readable at a glance. */
  .lists{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:18px}
  .list{background:#fff;border:1px solid #e3e9f2;border-radius:12px;padding:14px 18px 16px}
  .list h2{margin:0 0 10px;font-size:14px;font-weight:800;color:#0b2341;display:flex;align-items:center;gap:8px}
  .list h2 span{margin-left:auto;font-variant-numeric:tabular-nums}
  .list.ready h2::before{content:'';width:9px;height:9px;border-radius:50%;background:#16a34a}
  .list.review h2::before{content:'';width:9px;height:9px;border-radius:50%;background:#dc2626}
  .list.ready h2 span{color:#16a34a}
  .list.review h2 span{color:#dc2626}
  .sos{display:flex;flex-direction:column}
  .so-num{font-size:13.5px;font-weight:600;color:#0b2341;padding:6px 2px;border-bottom:1px solid #f0f3f8;
    cursor:pointer;font-variant-numeric:tabular-nums;letter-spacing:.02em;position:relative;
    -webkit-user-select:all;user-select:all}
  .so-num:last-child{border-bottom:0}
  .so-num:hover{color:#dc2626}
  .so-num.copied::after{content:'copied';position:absolute;right:2px;font-size:10.5px;font-weight:700;
    color:#16a34a;letter-spacing:.04em;user-select:none}
  .sos .none{font-size:12.5px;color:#7b8aa3;padding:5px 0}
  .so{scroll-margin-top:18px}
  @media(max-width:680px){.lists{grid-template-columns:1fr}}
  @media(max-width:680px){.tiles{grid-template-columns:repeat(2,1fr)}}
</style></head><body>
  <div class="banner"><div class="wrap"><h1>Ready-to-Invoice Audit</h1>
    <div class="sub">${results.length} orders checked · ${new Date().toLocaleString()}</div></div></div>
  <div class="tiles">
    ${tile(results.length, 'Orders checked')}
    ${tile(flagged.length, 'Orders flagged', 'red')}
    ${tile(blockers, 'Blockers', 'red')}
    ${tile(warnings, 'Warnings', 'amber')}
    ${tile(clean, 'Clean', 'green')}
  </div>
  <div class="wrap lists">
    <div class="list ready"><h2>Ready to invoice <span>${readyList.length}</span></h2>
      <div class="sos">${soList(readyList)}</div></div>
    <div class="list review"><h2>Needs review <span>${reviewList.length}</span></h2>
      <div class="sos">${soList(reviewList)}</div></div>
  </div>
  <div class="wrap">
  ${cards}
  </div>
  ${openSection}
  <div id="lbov" onclick="this.style.display='none'"><img id="lbimg" src=""></div>
  <script>
    function lb(src){ var o=document.getElementById('lbov'); document.getElementById('lbimg').src=src; o.style.display='flex'; }
    // Copy just the number. execCommand is kept as the fallback because the
    // clipboard API is often blocked when this report is shown in an iframe.
    function copySo(el){
      var n = el.getAttribute('data-n') || '';
      var done = function(){ el.classList.add('copied'); setTimeout(function(){ el.classList.remove('copied'); }, 1200); };
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(n).then(done, function(){ fallback(n, done); });
          return;
        }
      } catch (e) { /* fall through */ }
      fallback(n, done);
    }
    function fallback(n, done){
      var ta = document.createElement('textarea');
      ta.value = n; ta.setAttribute('readonly',''); ta.style.position='fixed'; ta.style.top='-1000px';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { /* nothing else to try */ }
      document.body.removeChild(ta);
    }
    document.addEventListener('click', function(e){
      var el = e.target.closest ? e.target.closest('.so-num') : null;
      if (el) copySo(el);
    });
    document.addEventListener('keydown',function(e){ if(e.key==='Escape') document.getElementById('lbov').style.display='none'; });
  </script>
</body></html>`;
  fs.writeFileSync(dataPath('audit-report.html'), html, 'utf8');
}


/* ----------------------------------------------------------------------------
 * ESTIMATE MODE (READ-ONLY) — node audit.js estimate [repairOrderId]
 *
 * Opens a service order, clicks the "Estimate" box at the top, and dumps the
 * Bill To / Ship To section plus the tax-location control. Runs through
 * ensureListLoaded() so it inherits the working auto-login.
 *
 * Reads only: no fills, no selectOption, no submits. It must never modify a
 * record, never touch the 5F labor rate, and never create a vendor address.
 * -------------------------------------------------------------------------- */
async function runEstimateProbe(page, context) {
  const out = [];
  const say = (s = '') => { log(s); out.push(s); };
  const finish = () => fs.writeFileSync(dataPath('estimate-dump.txt'), out.join('\n'), 'utf8');

  if (!(await ensureListLoaded(page))) { say('Not signed into Fullbay — aborting.'); finish(); return; }
  say('Signed in.');

  let id = (process.argv[3] || '').trim();
  // Accept "SO-11602", "11602", or a raw repairOrderId. Repair-order ids are long
  // (8 digits); SO numbers are short, so look those up in the Ready-to-Invoice list.
  const looksLikeSo = /^so-?\d+$/i.test(id) || /^\d{1,6}$/.test(id);
  if (!id || looksLikeSo) {
    await showAllRows(page);
    const rows = await readListRows(page);
    if (!id) {
      const first = rows.find((r) => r.repairOrderId);
      if (!first) { say('No repair-order-id available from the list.'); finish(); return; }
      id = first.repairOrderId;
      say(`Using the first Ready-to-Invoice order: ${first.soNumber} (id ${id})`);
    } else {
      const want = id.replace(/^so-?/i, '');
      const hit = rows.find((r) => String(r.soNumber || '').replace(/^so-?/i, '') === want && r.repairOrderId);
      if (!hit) {
        say(`SO ${id} was not found in the Ready-to-Invoice list (${rows.length} rows).`);
        say('Rows available: ' + rows.slice(0, 40).map((r) => r.soNumber).join(', '));
        finish(); return;
      }
      id = hit.repairOrderId;
      say(`SO ${hit.soNumber} -> repairOrderId ${id}`);
    }
  }

  await openOrderById(page, id);
  await sleep(3000);
  say('SO url: ' + page.url());

  // The boxes across the top: Action Items | Parts List | Estimate | Edit
  const boxes = await page.evaluate(() => {
    const ZW = /[​-‍﻿­]/g;
    const clean = (s) => (s || '').replace(ZW, '').replace(/\s+/g, ' ').trim();
    return Array.from(document.querySelectorAll('a,button,li,div'))
      .filter((el) => { const r = el.getBoundingClientRect(); return r.top < 500 && r.height > 16 && r.height < 160 && r.width > 50; })
      .map((el) => ({ t: clean(el.textContent).slice(0, 40), tag: el.tagName.toLowerCase(),
        href: el.getAttribute('href') || '', modal: el.getAttribute('data-modal') || '',
        onclick: (el.getAttribute('onclick') || '').slice(0, 140),
        left: Math.round(el.getBoundingClientRect().left) }))
      .filter((b) => /^(action items?|parts list|estimate|edit)$/i.test(b.t))
      .sort((a, b) => a.left - b.left);
  });
  say('');
  say('=== TOP BOXES ===');
  if (!boxes.length) say('  (none matched Action Items / Parts List / Estimate / Edit)');
  boxes.forEach((b) => say(`  [x=${b.left}] "${b.t}" <${b.tag}> href=${b.href} modal=${b.modal} onclick=${b.onclick}`));

  const clicked = await page.evaluate(() => {
    const ZW = /[​-‍﻿­]/g;
    const clean = (s) => (s || '').replace(ZW, '').replace(/\s+/g, ' ').trim();
    const el = Array.from(document.querySelectorAll('a,button,li,div'))
      .filter((e) => { const r = e.getBoundingClientRect(); return r.top < 500 && r.height > 16 && r.height < 160; })
      .find((e) => /^estimate$/i.test(clean(e.textContent)));
    if (!el) return false;
    el.click();
    return true;
  });
  say('clicked the Estimate box: ' + clicked);
  await sleep(5000);
  say('url now: ' + page.url());
  await page.screenshot({ path: dataPath('estimate-view.png'), clip: { x: 0, y: 0, width: 1600, height: 1000 } }).catch(() => {});

  const res = await page.evaluate(() => {
    const ZW = /[​-‍﻿­]/g;
    const clean = (s) => (s || '').replace(ZW, '').replace(/\s+/g, ' ').trim();
    const RE = /bill\s*to|ship\s*to|remit\s*to/i;
    const hits = [];
    document.querySelectorAll('*').forEach((el) => {
      if (el.children.length > 6) return;
      const t = clean(el.textContent);
      if (t && t.length < 400 && RE.test(t)) {
        const box = el.closest('.panel,.card,.well,div,td,section') || el;
        hits.push({ label: t.slice(0, 180), html: clean(box.outerHTML).slice(0, 1600) });
      }
    });
    const seen = new Set();
    const uniq = hits.filter((h) => { if (seen.has(h.html)) return false; seen.add(h.html); return true; }).slice(0, 8);

    const ctrls = [];
    document.querySelectorAll('input,select,textarea').forEach((el) => {
      const labEl = el.id ? document.querySelector('label[for="' + CSS.escape(el.id) + '"]') : null;
      const key = clean((el.id || '') + ' ' + (el.getAttribute('name') || '') + ' ' + (labEl ? labEl.textContent : ''));
      if (/address|billto|shipto|remitto|taxlocation|customerAddress/i.test(key)) {
        const o = { tag: el.tagName.toLowerCase(), id: el.id || '', name: el.getAttribute('name') || '',
          label: clean(labEl ? labEl.textContent : ''), value: (el.value || '').slice(0, 90),
          visible: !!(el.offsetParent || el.getClientRects().length) };
        if (el.tagName === 'SELECT') {
          o.options = Array.from(el.options).slice(0, 40).map((x) => ({ v: x.value, t: clean(x.textContent), s: x.selected }));
        }
        ctrls.push(o);
      }
    });
    return { uniq, ctrls };
  });

  say('');
  say('=== BILL TO / SHIP TO ===');
  if (!res.uniq.length) say('  (none found)');
  res.uniq.forEach((h, i) => { say(`--- hit ${i + 1}: ${h.label}`); say('    ' + h.html); });

  say('');
  say('=== LABOR ITEMS ON THIS ESTIMATE (READ ONLY — never modified) ===');
  // Everything needed is on the estimate tab. The location comes from the tax
  // location attached to each LABOR ITEM — not the order-level tax location,
  // which is often California and would wrongly send every order to Fontana.
  // Each assigned line reads e.g. "1.1: Assigned  CA Labor  Michael Godinez (100%)".
  // The two-letter prefix on "<XX> Labor" is the labor tax location for that item.
  const laborItems = await page.evaluate(() => {
    const ZW = /[​-‍﻿­]/g;
    const clean = (s) => (s || '').replace(ZW, '').replace(/\s+/g, ' ').trim();
    const RE = /^([A-Za-z]{2})\s+Labor$/;
    const out = [];

    // It is a <select> listing every state ("AL Labor", "AR Labor", …), so only
    // the SELECTED option is this item's location. Reading all options would
    // make the first state in the list look like the answer.
    document.querySelectorAll('select').forEach((el) => {
      const opt = el.options && el.selectedIndex >= 0 ? el.options[el.selectedIndex] : null;
      if (!opt) return;
      const m = clean(opt.textContent).match(RE);
      if (!m) return;
      const row = el.closest('tr, .row');
      // The technician name sits beside the dropdown, e.g. "Michael Godinez (100%)".
      let tech = '';
      if (row) {
        const rt = clean(row.textContent);
        const tm = rt.match(/([A-Z][a-z]+(?:\s+[A-Z][a-z']+)+)\s*\(\d+%\)/);
        if (tm) tech = tm[1];
      }
      out.push({ abbr: m[1].toUpperCase(), tech, id: el.id || '', source: 'select' });
    });

    // Fallback: a custom (non-native) dropdown rendering the same label.
    if (!out.length) {
      document.querySelectorAll('*').forEach((el) => {
        if (el.children.length > 2) return;
        if (el.closest('select, option, .dropdown-menu, ul')) return;
        const m = clean(el.textContent).match(RE);
        if (m) out.push({ abbr: m[1].toUpperCase(), tech: '', id: el.id || '', source: 'text' });
      });
    }
    const seen = new Set();
    return out.filter((o) => { const k = o.abbr + '|' + o.tech + '|' + o.id; if (seen.has(k)) return false; seen.add(k); return true; });
  });
  if (!laborItems.length) say('  (no "<XX> Labor" items found)');
  laborItems.forEach((o) => say(`  [${o.abbr}] ${o.tech || '(tech not read)'}  (${o.source}${o.id ? ' #' + o.id : ''})`));

  // Any per-item tax-location control (as opposed to the single order-level one).
  const perItemTax = await page.evaluate(() => {
    const ZW = /[​-‍﻿­]/g;
    const clean = (s) => (s || '').replace(ZW, '').replace(/\s+/g, ' ').trim();
    return Array.from(document.querySelectorAll('select, input'))
      .filter((el) => /tax|rate/i.test((el.id || '') + ' ' + (el.getAttribute('name') || '')))
      .map((el) => {
        const opt = el.tagName === 'SELECT' && el.options && el.selectedIndex >= 0
          ? el.options[el.selectedIndex] : null;
        return { id: el.id || '', name: el.getAttribute('name') || '',
          selected: opt ? clean(opt.textContent) : clean(el.value) };
      });
  });
  say('');
  say('  per-item tax/rate controls:');
  if (!perItemTax.length) say('    (none)');
  perItemTax.forEach((c) => say(`    id="${c.id}" name="${c.name}" -> ${JSON.stringify(c.selected)}`));

  const states = [...new Set(laborItems.map((o) => o.abbr))];
  say('  labor location(s) on this estimate: ' + (states.length ? states.join(', ') : '(none)'));
  if (states.length > 1) {
    say('  NOTE: this order carries more than one labor location — a human must decide.');
  }

  say('');
  say('=== ADDRESS / TAX-LOCATION CONTROLS ===');
  if (!res.ctrls.length) say('  (none)');
  res.ctrls.forEach((c) => {
    say(`  <${c.tag}> id="${c.id}" name="${c.name}" label="${c.label}" visible=${c.visible} value=${JSON.stringify(c.value)}`);
    if (c.options) c.options.forEach((o) => say(`      ${o.s ? '*' : ' '} ${JSON.stringify(o.t)} value=${o.v}`));
  });

  say('');
  say('=== MARKUP AROUND THE ADDRESS FIELDS (to find the edit control) ===');
  const addrMarkup = await page.evaluate(() => {
    const ZW = /[​-‍﻿­]/g;
    const clean = (s) => (s || '').replace(ZW, '').replace(/\s+/g, ' ').trim();
    const out = [];
    ['billingDisplayAddress', 'shipToDisplayAddress'].forEach((fid) => {
      const el = document.getElementById(fid);
      if (!el) { out.push({ field: fid, html: '(field not present)' }); return; }
      const row = el.closest('tr') || el.closest('div');
      out.push({ field: fid, html: row ? clean(row.outerHTML).slice(0, 1200) : '(no row)' });
    });
    return out;
  });
  addrMarkup.forEach((a) => { say(`  --- ${a.field}:`); say('      ' + a.html); });

  // --- Verdict: what SHOULD this estimate carry? Report only; writes nothing. ---
  say('');
  say('=== VERDICT (report only — nothing was changed) ===');
  try {
    const taxmap = require('./taxmap');
    const get = (cid) => { const c = res.ctrls.find((x) => x.id === cid); return c ? c.value : ''; };
    const current = {
      billToDisplay: get('billingDisplayAddress'),
      shipToDisplay: get('shipToDisplayAddress'),
      taxLocationId: get('entityTaxLocationId'),
    };
    // The location comes from the LABOR ITEM's tax location. The order-level
    // entityTaxLocationId is NOT used as the signal — it reads California on most
    // orders and would wrongly resolve everything to Fontana.
    const taxCtrl = res.ctrls.find((x) => x.id === 'entityTaxLocationId');
    const taxName = taxCtrl && taxCtrl.options
      ? (taxCtrl.options.find((o) => o.s) || {}).t : '';
    say(`  bill to now : ${current.billToDisplay || '(unset)'}`);
    say(`  ship to now : ${current.shipToDisplay || '(unset)'}`);
    say(`  order-level tax location (context only): ${taxName || '(unset)'}`);
    const hint = states[0] || '';
    if (!hint) {
      say('  Cannot judge: no labor-item location found on this estimate.');
    } else {
      say(`  labor-item location: ${hint}`);
      const verdict = taxmap.checkEstimate(current, hint);
      if (!verdict.ok) say('  Cannot resolve: ' + verdict.reason);
      else {
        say(`  Expected facility: ${verdict.expected.name}${verdict.viaDefault ? ' [via default]' : ''}`);
        if (!verdict.problems.length) say('  Addresses already correct — nothing to change.');
        verdict.problems.forEach((p) => {
          say(`   - ${p.field}: is ${JSON.stringify(p.is)}`);
          say(`     should be ${JSON.stringify(p.shouldBe)}`);
        });
        // Context only — the tax location is never changed.
        say(`  (tax location ${verdict.taxLocation.agrees ? 'agrees' : 'differs'}: `
          + `${verdict.taxLocation.current} vs ${verdict.taxLocation.expected} — not changed)`);
      }
    }
  } catch (e) { say('  verdict failed: ' + e.message); }

  finish();
  log('\nWrote estimate-dump.txt and estimate-view.png');
}


/* ----------------------------------------------------------------------------
 * OPEN SERVICE ORDERS — the second half of the audit.
 *
 * Ready-to-Invoice asks "is this billable yet"; this asks "what is holding this
 * order up". Reads Tech Home's Open SOs list, then opens each order and runs the
 * O-checks over its action items.
 * -------------------------------------------------------------------------- */
const OPEN_SOS_PATH = '/office/indexOpenSOs.html';

/** The Open SOs list: one row per order, with the repairOrderId dug out of the table data. */
async function readOpenSoRows(page) {
  await page.goto(CONFIG.baseUrl + OPEN_SOS_PATH, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForSelector('#openSOTable', { timeout: 30000 }).catch(() => {});
  await sleep(2500);
  return page.evaluate(() => {
    const ZW = /[​-‍﻿­]/g;
    const clean = (s) => (s || '').replace(ZW, '').replace(/\s+/g, ' ').trim();
    const jq = window.jQuery || window.$;
    const tbl = document.getElementById('openSOTable');
    if (!tbl) return [];
    let data = [];
    try { if (jq && jq.fn.dataTable) data = jq('#openSOTable').DataTable().rows().data().toArray(); } catch (e) { /* ignore */ }
    return Array.from(tbl.querySelectorAll('tbody tr')).map((tr, i) => {
      const td = Array.from(tr.querySelectorAll('td')).map((c) => clean(c.textContent));
      const blob = JSON.stringify(data[i] || '');
      const m = blob.match(/repairOrderId[^0-9]{0,8}(\d+)/i) || blob.match(/windowOpen[^0-9]{0,20}(\d+)/i);
      return {
        soNumber: td[1] || '', serviceWriter: td[2] || '', leadTech: td[3] || '',
        assignedTech: td[4] || '', unit: td[5] || '', customer: td[6] || '',
        complaint: td[7] || '', ageText: td[10] || '', serviceStatus: td[11] || '',
        partsStatus: td[12] || '', noteCount: td[13] || '',
        repairOrderId: m ? m[1] : '',
      };
    }).filter((r) => r.soNumber);
  }).catch(() => []);
}

/** Audit every open order. Returns [{ ...row, findings }]. */
async function auditOpenSos(page) {
  const rows = await readOpenSoRows(page);
  if (!rows.length) { log('Open SOs: none found (or the list did not load).'); return []; }
  const limit = CONFIG.maxOpenOrders > 0 ? Math.min(CONFIG.maxOpenOrders, rows.length) : rows.length;
  log(`\nOpen SOs: ${rows.length} open order(s); auditing ${limit}.`);

  const out = [];
  for (let i = 0; i < limit; i++) {
    const r = rows[i];
    process.stdout.write(`  [${i + 1}/${limit}] ${r.soNumber} (${r.ageText}) ... `);
    if (!r.repairOrderId) { log('no order id — skipped'); out.push({ ...r, findings: [], error: 'No order id' }); continue; }
    try {
      const ok = await openOrderById(page, r.repairOrderId);
      if (!ok) { log('no action items — skipped'); out.push({ ...r, findings: [], error: 'No action items' }); continue; }
      const so = await page.evaluate(extractServiceOrderInPage);
      const merged = { ...so, ...r, actionItems: so.actionItems };
      const findings = runOpenAudit(merged, { staleDays: CONFIG.openStaleDays });
      out.push({ ...merged, findings });
      log(`${so.actionItems.length} items, ${findings.length} issue(s)`);
    } catch (e) {
      log('ERROR: ' + e.message);
      out.push({ ...r, findings: [], error: e.message });
    }
  }
  return out;
}


/*
 * writeOpenHtml — standalone report for the Open-SO audit, so "Run Open Audit"
 * has somewhere to land without touching the Ready-to-Invoice report.
 */
const OPEN_CHECK_NAMES = {
  O1: 'Open too long', O2: 'Still in progress', O3: 'Not started',
  O4: 'Awaiting parts quote', O5: 'No parts on repair',
  O6: 'No photos', O7: 'Missing before/after',
};

function writeOpenHtml(openOrders) {
  const flagged = openOrders.filter((o) => o.findings.length).length;
  const blockers = openOrders.reduce((n, o) => n + o.findings.filter((f) => f.severity === 'blocker').length, 0);
  const stale = openOrders.filter((o) => o.findings.some((f) => f.check === 'O1')).length;
  const sorted = openOrders.slice().sort((a, b) => ageInDaysSafe(b.ageText) - ageInDaysSafe(a.ageText));

  const cards = sorted.map((o) => {
    const worst = o.findings.some((f) => f.severity === 'blocker') ? 'blocker'
      : (o.findings.length ? 'warning' : 'ok');
    const items = o.findings.length
      ? o.findings.map((f) => `<div class="f ${f.severity}">
          <span class="tag">${f.check} · ${OPEN_CHECK_NAMES[f.check] || ''}</span>
          <strong>${esc(f.title)}</strong>${f.technician ? ' <span class="tech">' + esc(f.technician) + '</span>' : ''}
          <div class="det">${esc(f.detail)}</div></div>`).join('')
      : '<div class="f ok">Nothing outstanding.</div>';
    return `<div class="so ${worst}">
      <div class="so-head"><strong>${esc(o.soNumber)}</strong>
        <span class="age">${esc(o.ageText || '')}</span>
        <span class="meta">${esc(o.customer || '')} ${o.unit ? '· Unit ' + esc(o.unit) : ''}
          ${o.assignedTech ? '· Tech: ' + esc(o.assignedTech) : ''}</span>
        <span class="sheet ${/done/i.test(o.partsStatus || '') ? 'yes' : 'warn'}">Parts: ${esc(o.partsStatus || 'not set')}</span>
        <span class="sheet warn">${esc(o.serviceStatus || '')}</span>
      </div>${items}</div>`;
  }).join('');

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Open SO Audit</title>
<style>
  body{margin:0;background:#f4f7fb;font-family:"Segoe UI",system-ui,sans-serif;color:#0b2341}
  .banner{background:linear-gradient(120deg,#15356b,#0b2341);color:#fff;padding:26px 0}
  .banner h1{margin:0;font-size:24px;font-weight:800;letter-spacing:-.02em}
  .banner .sub{font-size:13px;color:#bcd0ee;margin-top:6px}
  .wrap{max-width:1120px;margin:0 auto;padding:0 18px}
  .tiles{max-width:1120px;margin:18px auto;padding:0 18px;display:grid;grid-template-columns:repeat(4,1fr);gap:14px}
  .tile{background:#fff;border:1px solid #e3e9f2;border-radius:14px;padding:16px;text-align:center}
  .tile .n{font-size:26px;font-weight:800}
  .tile .l{font-size:11.5px;color:#7b8aa3;margin-top:4px}
  .tile.red .n{color:#dc2626}.tile.amber .n{color:#a16207}.tile.green .n{color:#16a34a}
  .so{background:#fff;border:1px solid #e3e9f2;border-left:5px solid #cbd5e1;border-radius:12px;padding:14px 18px;margin-bottom:12px}
  .so.blocker{border-left-color:#dc2626}.so.warning{border-left-color:#f59e0b}.so.ok{border-left-color:#16a34a}
  .so-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:9px}
  .so-head strong{font-size:15px}
  .meta{font-size:12px;color:#7b8aa3}
  .age{font-size:11px;font-weight:700;background:#eef3fa;color:#15356b;border-radius:20px;padding:4px 11px;white-space:nowrap}
  .sheet{font-size:11px;font-weight:700;border-radius:20px;padding:4px 11px;white-space:nowrap}
  .sheet.yes{background:#dcfce7;color:#15803d}.sheet.warn{background:#fef3c7;color:#a16207}
  .f{border-radius:9px;padding:9px 12px;margin-bottom:7px;font-size:13px;background:#f7f9fc}
  .f.blocker{background:#fef2f2}.f.warning{background:#fffbeb}.f.ok{background:#f0fdf4;color:#15803d}
  .tag{font-size:10.5px;font-weight:800;letter-spacing:.04em;color:#64748b;margin-right:7px}
  .tech{font-size:11px;color:#7b8aa3}
  .det{font-size:12px;color:#526179;margin-top:3px}
  @media(max-width:680px){.tiles{grid-template-columns:repeat(2,1fr)}}
</style></head><body>
  <div class="banner"><div class="wrap"><h1>Open SO Audit</h1>
    <div class="sub">${openOrders.length} open orders · ${new Date().toLocaleString()}</div></div></div>
  <div class="tiles">
    <div class="tile"><div class="n">${openOrders.length}</div><div class="l">Open orders</div></div>
    <div class="tile red"><div class="n">${flagged}</div><div class="l">With something outstanding</div></div>
    <div class="tile amber"><div class="n">${stale}</div><div class="l">Open too long</div></div>
    <div class="tile red"><div class="n">${blockers}</div><div class="l">Blockers</div></div>
  </div>
  <div class="wrap">${cards}</div>
</body></html>`;
  fs.writeFileSync(dataPath('open-report.html'), html, 'utf8');
}

/* node audit.js open — audit the open orders on their own. */
async function runOpenOnly(page, context) {
  if (!(await ensureListLoaded(page))) { log('Not signed into Fullbay — aborting.'); return; }
  const results = await auditOpenSos(page);
  fs.writeFileSync(dataPath('open-sos.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), orders: results }, null, 2), 'utf8');
  writeOpenHtml(results);
  const flagged = results.filter((r) => r.findings.length).length;
  log(`\nDone. ${flagged} of ${results.length} open orders have something outstanding.`);
  log('Reports written: open-report.html  and  open-sos.json');
}

/* ----------------------------------------------------------------------------
 * OPEN-SO PROBE (READ-ONLY) — node audit.js opensos
 *
 * The audit only ever looks at Ready-to-Invoice. Tech Home has an "Open SO's"
 * tab listing orders still in progress and how long they have been open. This
 * finds that page and dumps its columns and rows, so we can see what is
 * available to audit before building anything on it.
 * -------------------------------------------------------------------------- */
async function runOpenSosProbe(page, context) {
  const out = [];
  const say = (s = '') => { log(s); out.push(s); };
  const finish = () => fs.writeFileSync(dataPath('opensos-probe.txt'), out.join('\n'), 'utf8');

  if (!(await ensureListLoaded(page))) { say('Not signed into Fullbay — aborting.'); finish(); return; }
  say('Signed in.');

  // Find Tech Home from the left nav rather than guessing at a URL.
  const navLinks = await page.evaluate(() => {
    const ZW = /[​-‍﻿­]/g;
    const clean = (s) => (s || '').replace(ZW, '').replace(/\s+/g, ' ').trim();
    return Array.from(document.querySelectorAll('a')).map((a) => ({
      text: clean(a.textContent).slice(0, 40), href: a.getAttribute('href') || '',
    })).filter((l) => /tech\s*home|open\s*so/i.test(l.text) || /techHome|technicianHome/i.test(l.href));
  }).catch(() => []);
  say('');
  say('=== NAV LINKS THAT LOOK RELEVANT ===');
  if (!navLinks.length) say('  (none found on the current page)');
  [...new Map(navLinks.map((l) => [l.text + l.href, l])).values()]
    .forEach((l) => say(`  "${l.text}"  href=${l.href}`));

  const techHref = (navLinks.find((l) => /tech\s*home/i.test(l.text)) || {}).href;
  if (techHref) {
    const url = techHref.startsWith('http') ? techHref : CONFIG.baseUrl + techHref;
    say('');
    say('=== TECH HOME: ' + url);
    await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await sleep(4500);
    say('  landed: ' + page.url());

    const tabs = await page.evaluate(() => {
      const ZW = /[​-‍﻿­]/g;
      const clean = (s) => (s || '').replace(ZW, '').replace(/\s+/g, ' ').trim();
      return Array.from(document.querySelectorAll('a,button,li'))
        .map((e) => ({ text: clean(e.textContent).slice(0, 40), href: e.getAttribute('href') || '',
          target: e.getAttribute('data-target') || e.getAttribute('data-modal') || '' }))
        .filter((t) => t.text && t.text.length < 34 && /open|invoice|progress|assigned|so/i.test(t.text));
    }).catch(() => []);
    say('');
    say('=== TABS / LINKS ON TECH HOME ===');
    [...new Map(tabs.map((t) => [t.text + t.href, t])).values()].slice(0, 30)
      .forEach((t) => say(`  "${t.text}"  href=${t.href} target=${t.target}`));

    // Click anything that reads as the Open SOs tab, then dump the table.
    const clicked = await page.evaluate(() => {
      const ZW = /[​-‍﻿­]/g;
      const clean = (s) => (s || '').replace(ZW, '').replace(/\s+/g, ' ').trim();
      const el = Array.from(document.querySelectorAll('a,button,li'))
        .find((e) => /^open\s*so'?s?$/i.test(clean(e.textContent)));
      if (!el) return false;
      el.click(); return true;
    }).catch(() => false);
    say('');
    say('clicked an "Open SOs" tab: ' + clicked);
    await sleep(2000);

    // The tab is its own page; go there directly so the table actually loads.
    const openHref = (tabs.find((t) => /indexOpenSOs/i.test(t.href)) || {}).href
      || '/office/indexOpenSOs.html';
    const openUrl = (openHref.startsWith('http') ? openHref : CONFIG.baseUrl + openHref);
    say('=== OPEN SOs PAGE: ' + openUrl);
    await page.goto(openUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await sleep(6000);
    say('  landed: ' + page.url());

    const tables = await page.evaluate(() => {
      const ZW = /[​-‍﻿­]/g;
      const clean = (s) => (s || '').replace(ZW, '').replace(/\s+/g, ' ').trim();
      const vis = (el) => !!(el.offsetParent || el.getClientRects().length);
      return Array.from(document.querySelectorAll('table')).filter(vis).map((t) => ({
        id: t.id || '(none)',
        rows: t.querySelectorAll('tbody tr').length,
        head: Array.from(t.querySelectorAll('thead th')).map((h) => clean(h.textContent)).filter(Boolean),
        sample: Array.from(t.querySelectorAll('tbody tr')).slice(0, 5)
          .map((tr) => Array.from(tr.querySelectorAll('td')).map((td) => clean(td.textContent).slice(0, 28))),
      })).filter((t) => t.rows > 0);
    }).catch(() => []);
    say('');
    say('=== TABLES VISIBLE NOW ===');
    if (!tables.length) say('  (none with rows)');
    tables.forEach((t) => {
      say('');
      say(`  table id=${t.id}  rows=${t.rows}`);
      if (t.head.length) say('    columns: ' + t.head.join(' | '));
      t.sample.forEach((r) => say('    ' + r.join(' | ')));
    });
  } else {
    say('');
    say('Could not find a Tech Home link from the current page.');
  }
  // Row ids so the orders can actually be opened, then inspect one to learn the
  // action-item status vocabulary and how parts state is shown.
  const rows = await page.evaluate(() => {
    const ZW = /[​-‍﻿­]/g;
    const clean = (s) => (s || '').replace(ZW, '').replace(/\s+/g, ' ').trim();
    const jq = window.jQuery || window.$;
    const out = [];
    const tbl = document.getElementById('openSOTable');
    if (!tbl) return out;
    // The repairOrderId hides in the DataTable's row data, same as the
    // Ready-to-Invoice list, not in the visible markup.
    let data = [];
    try { if (jq && jq.fn.dataTable) data = jq('#openSOTable').DataTable().rows().data().toArray(); } catch (e) { /* ignore */ }
    Array.from(tbl.querySelectorAll('tbody tr')).forEach((tr, i) => {
      const tds = Array.from(tr.querySelectorAll('td')).map((td) => clean(td.textContent));
      let id = '';
      const blob = JSON.stringify(data[i] || '');
      const m = blob.match(/repairOrderId[^0-9]{0,8}(\d+)/i) || blob.match(/windowOpen[^0-9]{0,20}(\d+)/i);
      if (m) id = m[1];
      out.push({ so: tds[1] || '', age: tds[10] || '', svc: tds[11] || '', parts: tds[12] || '', id });
    });
    return out;
  }).catch(() => []);
  say('');
  say('=== OPEN SOs WITH IDS ===');
  rows.forEach((r) => say(`  ${r.so.padEnd(10)} age=${r.age.padEnd(8)} service=${r.svc.padEnd(12)} parts=${(r.parts || '-').padEnd(8)} id=${r.id || 'NOT FOUND'}`));

  const first = rows.find((r) => r.id);
  if (first) {
    say('');
    say('=== ACTION ITEMS ON ' + first.so + ' (an open order) ===');
    await openOrderById(page, first.id);
    await sleep(2500);
    const items = await page.evaluate(() => {
      const ZW = /[​-‍﻿­]/g;
      const clean = (s) => (s || '').replace(ZW, '').replace(/\s+/g, ' ').trim();
      return Array.from(document.querySelectorAll('.soai-container')).map((c) => {
        const nEl = c.querySelector('[data-soai-action-item-number]');
        const sel = c.querySelector('select[id^="status"]');
        const status = sel && sel.options[sel.selectedIndex] ? clean(sel.options[sel.selectedIndex].textContent) : '';
        const allStatuses = sel ? Array.from(sel.options).map((o) => clean(o.textContent)) : [];
        const steps = Array.from(c.querySelectorAll('.progress-step label')).map((l) => clean(l.textContent));
        const body = clean(c.textContent);
        return {
          num: nEl ? nEl.getAttribute('data-soai-action-item-number') : '',
          note: clean((c.querySelector('.soai-original-note-container p') || {}).textContent).slice(0, 60),
          status,
          allStatuses,
          steps,
          quote: /needs?\s*quote|quote\s*needed|awaiting\s*quote/i.test(body),
        };
      });
    }).catch(() => []);
    items.forEach((it) => {
      say('');
      say(`  AI ${it.num}  status="${it.status}"  needsQuoteText=${it.quote}  "${it.note}"`);
      say('    progress steps: ' + (it.steps.join(' | ') || '(none)'));
    });
    if (items[0]) {
      say('');
      say('=== FULL STATUS VOCABULARY (dropdown options) ===');
      items[0].allStatuses.forEach((s) => say('    ' + s));
    }
  }

  finish();
  log('\nWrote opensos-probe.txt');
}

/* ----------------------------------------------------------------------------
 * PARTS PROBE (READ-ONLY) — node audit.js parts <SO or repairOrderId>
 *
 * Check B currently knows only a yes/no "No Parts" flag per action item. To
 * honour "the parts for both sensors went on one item", we need to know HOW
 * MANY parts each item carries. This dumps whatever the page exposes so we can
 * see whether a count is available at all.
 * -------------------------------------------------------------------------- */
async function runPartsProbe(page, context) {
  const out = [];
  const say = (s = '') => { log(s); out.push(s); };
  const finish = () => fs.writeFileSync(dataPath('parts-probe.txt'), out.join('\n'), 'utf8');

  if (!(await ensureListLoaded(page))) { say('Not signed into Fullbay — aborting.'); finish(); return; }
  let id = (process.argv[3] || '').trim();
  if (/^so-?\d+$/i.test(id) || /^\d{1,6}$/.test(id)) {
    await showAllRows(page);
    const rows = await readListRows(page);
    const want = id.replace(/^so-?/i, '');
    const hit = rows.find((r) => String(r.soNumber || '').replace(/^so-?/i, '') === want && r.repairOrderId);
    if (!hit) { say('SO not found in the list.'); finish(); return; }
    id = hit.repairOrderId;
  }
  await openOrderById(page, id);
  await sleep(2500);
  say('url: ' + page.url());

  const info = await page.evaluate(() => {
    const ZW = /[​-‍﻿­]/g;
    const clean = (s) => (s || '').replace(ZW, '').replace(/\s+/g, ' ').trim();
    return Array.from(document.querySelectorAll('.soai-container')).map((c) => {
      const nEl = c.querySelector('[data-soai-action-item-number]');
      const num = nEl ? nEl.getAttribute('data-soai-action-item-number') : '';
      const note = clean((c.querySelector('.soai-original-note-container p') || {}).textContent);
      let noParts = false;
      c.querySelectorAll('.progress-step label').forEach((l) => {
        if (/^No Parts$/i.test(clean(l.textContent))) noParts = true;
      });
      // Anything inside the item whose id/class/text mentions parts.
      const hits = [];
      c.querySelectorAll('*').forEach((e) => {
        if (e.children.length > 3) return;
        const key = (e.id || '') + ' ' + String(e.className && e.className.baseVal === undefined ? e.className : '');
        const txt = clean(e.textContent);
        if (/part/i.test(key) || /^\s*parts?/i.test(txt)) {
          hits.push({ tag: e.tagName.toLowerCase(), id: e.id || '', cls: String(key).slice(0, 46), txt: txt.slice(0, 70) });
        }
      });
      const seen = new Set();
      return { num, note: note.slice(0, 70), noParts,
        hits: hits.filter((h) => { const k = h.id + h.cls + h.txt; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 10) };
    });
  }).catch(() => []);

  say('action items found: ' + info.length);
  info.forEach((ai) => {
    say('');
    say(`AI ${ai.num}  noParts=${ai.noParts}  "${ai.note}"`);
    if (!ai.hits.length) say('   (nothing parts-like inside this item)');
    ai.hits.forEach((h) => say(`   <${h.tag}> id="${h.id}" cls="${h.cls}" text="${h.txt}"`));
  });
  // Nothing parts-like sits inside an action item, so look at the Parts List tab.
  say('');
  say('=== PARTS LIST TAB ===');
  await page.goto(`${CONFIG.baseUrl}/office/workorder/partsList.html?repairOrderId=${id}`,
    { waitUntil: 'domcontentloaded' }).catch(() => {});
  await sleep(3500);
  say('url: ' + page.url());
  const parts = await page.evaluate(() => {
    const ZW = /[​-‍﻿­]/g;
    const clean = (s) => (s || '').replace(ZW, '').replace(/\s+/g, ' ').trim();
    const tables = Array.from(document.querySelectorAll('table')).map((t) => ({
      id: t.id || '(none)',
      rows: t.querySelectorAll('tbody tr').length,
      head: Array.from(t.querySelectorAll('thead th')).map((h) => clean(h.textContent)).filter(Boolean),
      sample: Array.from(t.querySelectorAll('tbody tr')).slice(0, 8)
        .map((tr) => Array.from(tr.querySelectorAll('td')).map((td) => clean(td.textContent).slice(0, 34))),
    }));
    return { tables, onLogin: !!document.querySelector('input[type="password"]') };
  }).catch((e) => ({ error: e.message }));
  if (parts.error) say('  could not read: ' + parts.error);
  else {
    say('  on login page: ' + parts.onLogin);
    (parts.tables || []).forEach((t) => {
      say('');
      say(`  table id=${t.id} rows=${t.rows}`);
      if (t.head.length) say('    columns: ' + t.head.join(' | '));
      t.sample.forEach((r) => say('    ' + r.join(' | ')));
    });
  }

  finish();
  log('\nWrote parts-probe.txt');
}

/* ----------------------------------------------------------------------------
 * ESTIMATE ADDRESS FIX — the one place FreeAudit WRITES to Fullbay.
 *
 * Sets the Bill To and Ship To addresses on an estimate to the facility that
 * matches the labour location on the order's action items ("GA Labor" -> the
 * Atlanta, GA address). The tax location is never touched, the labour rate is
 * never touched, and a new vendor address is never created.
 *
 * It refuses to act unless the situation is unambiguous:
 *   - every labour item on the order agrees on one location
 *   - that location resolves to exactly one facility (see taxmap.js)
 *   - the picker offers a row whose title matches that facility exactly
 * Anything else is reported and left alone. Every change is verified by
 * re-reading the field afterwards.
 * -------------------------------------------------------------------------- */
const ZW_SRC = '[\\u200B-\\u200D\\uFEFF\\u00AD]';

/** Read what the estimate currently says. Pure read. */
async function readEstimateState(page, repairOrderId) {
  await page.goto(`${CONFIG.baseUrl}/office/workorder/approveRepairOrderQuote.html?repairOrderId=${repairOrderId}`,
    { waitUntil: 'domcontentloaded' });
  await sleep(3500);
  return page.evaluate((zw) => {
    const ZW = new RegExp(zw, 'g');
    const clean = (s) => (s || '').replace(ZW, '').replace(/\s+/g, ' ').trim();
    const val = (id) => { const el = document.getElementById(id); return el ? clean(el.value) : ''; };
    // Labour location: the DISPLAYED value of each item's "<XX> Labor" dropdown.
    const RE = /^([A-Za-z]{2})\s+Labor$/;
    const abbrs = [];
    document.querySelectorAll('select').forEach((el) => {
      const o = el.options && el.selectedIndex >= 0 ? el.options[el.selectedIndex] : null;
      const m = o && clean(o.textContent).match(RE);
      if (m) abbrs.push(m[1].toUpperCase());
    });
    if (!abbrs.length) {
      document.querySelectorAll('*').forEach((el) => {
        if (el.children.length > 2) return;
        if (el.closest('select, option, .dropdown-menu, ul')) return;
        const m = clean(el.textContent).match(RE);
        if (m) abbrs.push(m[1].toUpperCase());
      });
    }
    return {
      billToDisplay: val('billingDisplayAddress'),
      shipToDisplay: val('shipToDisplayAddress'),
      billToId: val('billingCustomerAddressId'),
      shipToId: val('shipToCustomerAddressId'),
      laborAbbrs: [...new Set(abbrs)],
    };
  }, ZW_SRC);
}

/**
 * Point one address field at `facilityName` using the same picker a person uses.
 * Returns { ok, reason?, chose? }.
 */
async function applyAddress(page, which, facilityName) {
  const fieldId = which === 'billing' ? 'billingDisplayAddress' : 'shipToDisplayAddress';

  const opened = await page.evaluate((fid) => {
    const el = document.getElementById(fid);
    if (!el) return 'field missing';
    const grp = el.closest('.input-group');
    const pencil = grp && grp.querySelector('span[onclick*="openFindAddressModal"]');
    if (!pencil) return 'no edit control';
    pencil.click();
    return 'ok';
  }, fieldId);
  if (opened !== 'ok') return { ok: false, reason: opened };
  await sleep(2500);

  // Show every address — the picker paginates at 10 and the match may be deeper.
  await page.evaluate(() => {
    const sel = document.querySelector('select[name="addresslist_length"]');
    if (sel) {
      sel.value = '100';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }).catch(() => {});
  await sleep(1200);

  // Click the row whose TITLE matches the facility exactly. Never "Add New Address".
  const picked = await page.evaluate((args) => {
    const ZW = new RegExp(args.zw, 'g');
    const clean = (s) => (s || '').replace(ZW, '').replace(/\s+/g, ' ').trim();
    const want = clean(args.facility).toLowerCase();
    const rows = Array.from(document.querySelectorAll('#addresslist tbody tr'));
    for (const tr of rows) {
      const oc = tr.getAttribute('onclick') || '';
      if (!/^selectAddress\(/.test(oc)) continue;         // ignore Add New / Clear
      const cells = tr.querySelectorAll('td');
      const title = clean(cells[1] ? cells[1].textContent : '');
      if (title.toLowerCase() === want) { tr.click(); return { ok: true, chose: title }; }
    }
    return { ok: false, reason: 'no row titled "' + args.facility + '" in the picker' };
  }, { facility: facilityName, zw: ZW_SRC });

  await sleep(3000); // let selectAddress() fire the field save
  return picked;
}

/**
 * Fix one order. Returns a result describing what happened — never throws.
 */
async function fixOrderAddresses(page, repairOrderId, soNumber) {
  const taxmap = require('./taxmap');
  const label = soNumber || repairOrderId;
  const before = await readEstimateState(page, repairOrderId);

  if (before.laborAbbrs.length === 0) {
    return { so: label, action: 'skipped', reason: 'no labour location on the estimate' };
  }
  if (before.laborAbbrs.length > 1) {
    return { so: label, action: 'skipped', reason: `mixed labour locations (${before.laborAbbrs.join(', ')}) — needs a human` };
  }
  const abbr = before.laborAbbrs[0];
  const verdict = taxmap.checkEstimate(before, abbr);
  if (!verdict.ok) return { so: label, action: 'skipped', reason: `${abbr}: ${verdict.reason}` };
  if (!verdict.problems.length) {
    return { so: label, action: 'ok', reason: `already set to ${verdict.expected.name}` };
  }

  const facility = verdict.expected.name;
  const changed = [];
  const failed = [];
  for (const p of verdict.problems) {
    const which = p.field === 'billTo' ? 'billing' : 'shipTo';
    const r = await applyAddress(page, which, facility);
    if (r.ok) changed.push(p.field); else failed.push(`${p.field}: ${r.reason}`);
  }

  // Verify by re-reading the estimate rather than trusting the click.
  const after = await readEstimateState(page, repairOrderId);
  const stillWrong = taxmap.checkEstimate(after, abbr);
  const verified = stillWrong.ok && stillWrong.problems.length === 0;

  return {
    so: label,
    action: verified ? 'fixed' : (changed.length ? 'partial' : 'failed'),
    facility,
    abbr,
    changed,
    failed,
    before: { billTo: before.billToDisplay, shipTo: before.shipToDisplay },
    after: { billTo: after.billToDisplay, shipTo: after.shipToDisplay },
    verified,
  };
}

/* ----------------------------------------------------------------------------
 * ADDRESS-PICKER PROBE (READ-ONLY) — node audit.js addrmodal <SO or id>
 *
 * Opens the Bill To address picker (the pencil next to the field, which calls
 * openFindAddressModal) and dumps the choices it offers, so the automatic fix
 * can select an entry the same way a person does. Nothing is chosen or saved.
 * Never touches the separate "Add Address" button — new vendor addresses are
 * strictly off-limits.
 * -------------------------------------------------------------------------- */
/*
 * node audit.js fixaddresses   — set Bill To / Ship To on EVERY Ready-to-Invoice
 * order to match its labour location. This is the only thing FreeAudit does that
 * writes to Fullbay, and it is deliberately SEPARATE from the audit: an audit
 * stays read-only and can be run any time without changing records.
 *
 * Skips anything ambiguous rather than guessing. Writes address-fixes.json.
 */
async function runFixAddresses(page, context) {
  if (!(await ensureListLoaded(page))) { log('Not signed into Fullbay — aborting.'); return; }
  await showAllRows(page);
  const rows = (await readListRows(page)).filter((r) => r.repairOrderId);
  const limit = CONFIG.maxOrders > 0 ? Math.min(CONFIG.maxOrders, rows.length) : rows.length;
  log(`Fixing estimate addresses on ${limit} order(s).\n`);

  const out = [];
  for (let i = 0; i < limit; i++) {
    const r = rows[i];
    process.stdout.write(`  [${i + 1}/${limit}] ${r.soNumber} ... `);
    try {
      const fx = await fixOrderAddresses(page, r.repairOrderId, r.soNumber);
      out.push(fx);
      if (fx.action === 'fixed') log(`set to ${fx.facility} (labour ${fx.abbr})`);
      else if (fx.action === 'ok') log(`already correct (${fx.reason})`);
      else if (fx.action === 'skipped') log(`skipped — ${fx.reason}`);
      else log(`${fx.action} — ${(fx.failed || []).join('; ')}`);
    } catch (e) {
      log(`error — ${e.message}`);
      out.push({ so: r.soNumber, action: 'error', reason: e.message });
    }
  }

  const n = (a) => out.filter((f) => f.action === a).length;
  const problems = out.filter((f) => ['partial', 'failed', 'error'].includes(f.action));
  log(`\nDone. ${n('fixed')} fixed, ${n('ok')} already correct, ${n('skipped')} left for a human, ${problems.length} problem(s).`);
  if (problems.length) {
    log('Orders whose addresses could NOT be set:');
    problems.forEach((f) => log(`  ${f.so} — ${f.reason || (f.failed || []).join('; ')}`));
  }
  fs.writeFileSync(dataPath('address-fixes.json'),
    JSON.stringify({ ranAt: new Date().toISOString(), results: out }, null, 2), 'utf8');
  log('Wrote address-fixes.json');
}

/*
 * node audit.js fixaddr <SO or repairOrderId>   — fix ONE order (writes).
 * Used to verify the writer on a single known order before it runs across a
 * whole audit.
 */
async function runFixAddr(page, context) {
  if (!(await ensureListLoaded(page))) { log('Not signed into Fullbay — aborting.'); return; }
  let id = (process.argv[3] || '').trim();
  let so = '';
  if (!id) { log('usage: node audit.js fixaddr <SO-number or repairOrderId>'); return; }
  if (/^so-?\d+$/i.test(id) || /^\d{1,6}$/.test(id)) {
    await showAllRows(page);
    const rows = await readListRows(page);
    const want = id.replace(/^so-?/i, '');
    const hit = rows.find((r) => String(r.soNumber || '').replace(/^so-?/i, '') === want && r.repairOrderId);
    if (!hit) { log(`SO ${id} is not in the Ready-to-Invoice list.`); return; }
    so = hit.soNumber; id = hit.repairOrderId;
  }
  log(`Fixing addresses on ${so || id}…`);
  const r = await fixOrderAddresses(page, id, so);
  log('');
  log('  result   : ' + r.action.toUpperCase() + (r.reason ? ' — ' + r.reason : ''));
  if (r.facility) log('  facility : ' + r.facility + '  (labour ' + r.abbr + ')');
  if (r.before) {
    log('  bill to  : ' + JSON.stringify(r.before.billTo) + '  ->  ' + JSON.stringify(r.after.billTo));
    log('  ship to  : ' + JSON.stringify(r.before.shipTo) + '  ->  ' + JSON.stringify(r.after.shipTo));
  }
  if (r.failed && r.failed.length) r.failed.forEach((f) => log('  FAILED   : ' + f));
  if (r.verified !== undefined) log('  verified : ' + r.verified);
}

async function runAddrModalProbe(page, context) {
  const out = [];
  const say = (s = '') => { log(s); out.push(s); };
  const finish = () => fs.writeFileSync(dataPath('addr-modal.txt'), out.join('\n'), 'utf8');

  if (!(await ensureListLoaded(page))) { say('Not signed into Fullbay — aborting.'); finish(); return; }
  let id = (process.argv[3] || '').trim();
  const looksLikeSo = /^so-?\d+$/i.test(id) || /^\d{1,6}$/.test(id);
  if (looksLikeSo) {
    await showAllRows(page);
    const rows = await readListRows(page);
    const want = id.replace(/^so-?/i, '');
    const hit = rows.find((r) => String(r.soNumber || '').replace(/^so-?/i, '') === want && r.repairOrderId);
    if (!hit) { say(`SO ${id} not in the Ready-to-Invoice list.`); finish(); return; }
    id = hit.repairOrderId;
    say(`SO ${hit.soNumber} -> repairOrderId ${id}`);
  }

  await page.goto(`${CONFIG.baseUrl}/office/workorder/approveRepairOrderQuote.html?repairOrderId=${id}`,
    { waitUntil: 'domcontentloaded' });
  await sleep(4000);
  say('estimate url: ' + page.url());

  // Click the pencil beside "Bill to address" (never the Add Address button).
  const opened = await page.evaluate(() => {
    const el = document.getElementById('billingDisplayAddress');
    if (!el) return 'no billingDisplayAddress field';
    const grp = el.closest('.input-group');
    const pencil = grp && grp.querySelector('span[onclick*="openFindAddressModal"]');
    if (!pencil) return 'no pencil control found';
    pencil.click();
    return 'clicked';
  });
  say('open picker: ' + opened);
  await sleep(4000);

  const modal = await page.evaluate(() => {
    const ZW = /[​-‍﻿­]/g;
    const clean = (s) => (s || '').replace(ZW, '').replace(/\s+/g, ' ').trim();
    const vis = (el) => !!(el.offsetParent || el.getClientRects().length);
    const panel = Array.from(document.querySelectorAll('.modal, [role="dialog"]')).filter(vis)[0];
    if (!panel) return null;
    // Rows a person would click to choose an address.
    const rows = Array.from(panel.querySelectorAll('tr, li, .list-group-item, [onclick]'))
      .filter((el) => el.children.length <= 6)
      .map((el) => ({ text: clean(el.textContent).slice(0, 160), onclick: (el.getAttribute('onclick') || '').slice(0, 200) }))
      .filter((r) => r.text);
    const seen = new Set();
    return {
      title: clean((panel.querySelector('.modal-title') || {}).textContent || ''),
      rows: rows.filter((r) => { if (seen.has(r.text)) return false; seen.add(r.text); return true; }).slice(0, 40),
      html: clean(panel.outerHTML).slice(0, 2500),
    };
  });

  if (!modal) say('no visible modal appeared');
  else {
    say('');
    say('modal title: ' + modal.title);
    say('');
    say('=== CHOOSABLE ROWS ===');
    modal.rows.forEach((r) => { say('  ' + r.text); if (r.onclick) say('      onclick=' + r.onclick); });
    say('');
    say('=== MODAL HTML (truncated) ===');
    say('  ' + modal.html);
  }
  finish();
  log('\nWrote addr-modal.txt');
}

/* ----------------------------------------------------------------------------
 * Entry point.
 * -------------------------------------------------------------------------- */
// Allow requiring this file (e.g. for offline parser tests) without launching a browser.
if (require.main !== module) { module.exports = { loadSheetCompletionMap, extractTabCompletion, buildMapFromTabs, writeJson, writeCsv, writeHtml }; }

if (require.main === module) (async () => {
  // Open the Vorto portal so a person can sign in (session saved to .vorto-profile).
  if (MODE === 'vorto-login') { await vorto.signIn(); return; }
  // Live check against the Vorto portal — e.g. node audit.js vortotest ALMZ1234DV:MT-XXXX
  if (MODE === 'vortotest') {
    const args = process.argv.slice(3);
    if (!args.length) { log('usage: node audit.js vortotest UNIT[:MT] [UNIT[:MT] ...]'); return; }
    const items = args.map((a) => { const [unit, mt] = a.split(':'); return { unit, mt: mt || '' }; });
    log(JSON.stringify(await vorto.lookupOrders(items), null, 2));
    return;
  }

  // Offline check of the sheet tracker — no browser needed.
  if (MODE === 'sheettest') {
    const s = await loadSheetCompletionMap();
    if (!s) { log('No .xlsx tracker found.'); return; }
    log(`Loaded ${s.map.size} units from ${s.tabsUsed.length} tab(s) across ${s.files.length} file(s): ${s.files.join(', ')}.`);
    log('Tabs used: ' + s.tabsUsed.join(' | '));
    // Includes units from tabs that previously failed to load.
    ['ALMZ8277DV', 'ALMZ9147DV', 'ALMZ3324DV', 'ALMZ1168HC', 'ALMZ1031FB', 'ALMZ1230FB'].forEach((u) => {
      const e = s.map.get(u);
      log(`  ${u} -> ${e ? (e.complete ? 'COMPLETE' : 'not complete') + ' (raw: "' + e.status + '") [' + e.tab + ']' : 'Not found'}`);
    });
    return;
  }

  // Test whether Fullbay accepts a scripted login — uses a FRESH temp profile so the
  // real saved session is never touched.
  if (MODE === 'logintest') {
    if (!readFullbayCreds()) { log('No valid credentials in fullbay-credentials.json (still has placeholders?).'); return; }
    const dir = dataPath('.fb-logintest');
    fs.rmSync(dir, { recursive: true, force: true });
    const ctx = await chromium.launchPersistentContext(dir, { headless: false, viewport: null, args: ['--start-maximized'] });
    const pg = ctx.pages()[0] || (await ctx.newPage());
    try {
      await pg.goto(CONFIG.listUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await sleep(2000);
      log('Reached Fullbay. Attempting scripted sign-in…');
      await autoLoginFullbay(pg);
      await pg.goto(CONFIG.listUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
      const list = !!(await safe$(pg, '#readyToInvoice'));
      if (list) await waitForRows(pg);
      const stillLogin = !!(await safe$(pg, 'input[type="password"]'));
      log('\n' + (list ? '✅ SUCCESS — Fullbay accepted the scripted login (the list loaded).'
        : (stillLogin ? '❌ BLOCKED — still on the login screen (Fullbay rejected the scripted login).'
          : '⚠️ UNCLEAR — left the login page but the list did not load.')));
      const txt = await pg.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 220)).catch(() => '');
      log('Page now: ' + txt);
      log('\nBrowser stays open 12s.');
      await sleep(12000);
    } finally { await ctx.close(); fs.rmSync(dir, { recursive: true, force: true }); }
    return;
  }

  // A run that was force-killed can leave its Chromium alive holding this
  // profile; the next launch then attaches to that dead session and shows an
  // empty about:blank window. Handle that REACTIVELY — try to launch, and only
  // clear leftovers if Playwright actually reports the conflict. Killing
  // pre-emptively on every run risks killing the browser this run depends on.
  const launchOpts = {
    headless: !!CONFIG.headless,
    viewport: null,
    args: ['--start-maximized'],
  };
  let context;
  try {
    context = await chromium.launchPersistentContext(PROFILE_DIR, launchOpts);
  } catch (e) {
    if (!/existing browser session|already in use/i.test(e.message || '')) throw e;
    log('  A leftover browser is holding the sign-in profile — clearing it…');
    await releaseProfileLock(PROFILE_DIR);
    await sleep(2500);
    context = await chromium.launchPersistentContext(PROFILE_DIR, launchOpts);
  }
  const page = context.pages()[0] || (await context.newPage());
  try {
    if (MODE === 'probe') await runProbe(page, context);
    else if (MODE === 'photos') await runPhotoProbe(page, context);
    else if (MODE === 'viewer') await runViewerProbe(page, context);
    else if (MODE === 'aihtml') await runAiHtmlProbe(page, context);
    else if (MODE === 'imgapi') await runImgApiProbe(page, context);
    else if (MODE === 'sheet') await runSheetProbe(page, context);
    else if (MODE === 'notes') await runNotesProbe(page, context);
    else if (MODE === 'estimate') await runEstimateProbe(page, context);
    else if (MODE === 'parts') await runPartsProbe(page, context);
    else if (MODE === 'opensos') await runOpenSosProbe(page, context);
    else if (MODE === 'open') await runOpenOnly(page, context);
    else if (MODE === 'addrmodal') await runAddrModalProbe(page, context);
    else if (MODE === 'fixaddr') await runFixAddr(page, context);
    else if (MODE === 'fixaddresses') await runFixAddresses(page, context);
    else if (MODE === 'login') {
      // A person is signing in on purpose: never auto-fill (it breaks the SSO
      // screen), and give them 15 minutes to get through Microsoft.
      log('Opening Fullbay. Sign in in the browser window — including "Continue with Microsoft".');
      const ok = await ensureListLoaded(page, { autoLogin: false, waitMinutes: 15 });
      log(ok ? '\nFullbay connected — audits can be run now.' : '\nSign-in was not completed.');
      await sleep(1500);
    } else if (MODE === 'full' || MODE === 'audit') {
      await runFull(page, context);
    } else {
      // Refuse anything we don't recognise. This used to fall through to a full
      // audit, so a stale or mistyped mode — the portal agent still knows about
      // the removed "billed" mode, for instance — would quietly run a complete
      // audit against Fullbay and overwrite the report nobody asked to replace.
      log(`\nUnknown mode "${MODE}". Nothing was run.`);
      log('Valid modes: (none)=full audit, open, login, fixaddresses, fixaddr,');
      log('  probe, estimate, parts, opensos, addrmodal, photos, viewer, sheet, notes.');
      process.exitCode = 2;
    }
  } catch (e) {
    log('\nFATAL: ' + e.message);
    process.exitCode = 1;
  } finally {
    await context.close();
  }
})();

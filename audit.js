/*
 * audit.js — Fullbay "Ready to Invoice" auto-auditor.
 *
 * Usage (from the C:\Users\mitch\flss-audit folder):
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
const { runAudit, isServiceCall, classify } = require('./checks');

const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const PROFILE_DIR = path.join(__dirname, '.fb-profile');
const MODE = (process.argv[2] || 'full').toLowerCase();

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// page.$ can throw "Execution context was destroyed" if the page navigates
// mid-check (e.g. a session-timeout redirect). Treat that as "not found".
const safe$ = async (page, sel) => { try { return await page.$(sel); } catch { return null; } };
// The Monday (YYYY-MM-DD) of the week containing a date — weeks run Monday–Sunday.
function mondayISO(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
}

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

    let noParts = false;
    c.querySelectorAll('.progress-step label').forEach((l) => {
      if (/^No Parts$/i.test(textOf(l))) noParts = true;
    });

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
      id, number, status, technician: tech, originalNote,
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
  const p = path.join(__dirname, 'fullbay-credentials.json');
  if (!fs.existsSync(p)) return null;
  try {
    const c = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (c && c.username && c.password && !/PUT-YOUR/i.test(c.username) && !/PUT-YOUR/i.test(c.password)) return c;
  } catch (e) { /* ignore */ }
  return null;
}

// Try to sign into Fullbay automatically by filling the login form. Returns true if it lands logged in.
async function autoLoginFullbay(page) {
  const cred = readFullbayCreds();
  if (!cred) return false;
  const pw = await safe$(page, 'input[type="password"]');
  if (!pw) return false; // not on a login page
  const user = await safe$(page, 'input[type="email"], input[name*="user" i], input[name*="email" i], input[id*="user" i], input[id*="email" i], input[autocomplete="username"], input[type="text"]');
  try {
    if (user) await user.fill(cred.username);
    await pw.fill(cred.password);
    const btn = await safe$(page, 'button[type="submit"], input[type="submit"]');
    if (btn) await btn.click({ timeout: 5000 }).catch(() => {});
    else await page.keyboard.press('Enter');
    await page.waitForFunction(
      () => !document.querySelector('input[type="password"]') || !!document.querySelector('#readyToInvoice'),
      undefined, { timeout: 20000 },
    ).catch(() => {});
    await sleep(1500);
  } catch (e) { return false; }
  return true;
}

async function ensureListLoaded(page) {
  await page.goto(CONFIG.listUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
  if (await safe$(page, '#readyToInvoice')) { await waitForRows(page); return true; }

  // Try automatic sign-in with stored credentials before asking for a human.
  if (readFullbayCreds()) {
    log('  Attempting automatic Fullbay sign-in…');
    await autoLoginFullbay(page);
    await page.goto(CONFIG.listUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
    if (await safe$(page, '#readyToInvoice')) { log('  Signed in automatically.\n'); await waitForRows(page); return true; }
    log('  Automatic sign-in did not complete — waiting for a manual sign-in.');
  }

  log('\n  ──────────────────────────────────────────────');
  log('  Please log into Fullbay in the browser window.');
  log('  I will continue automatically once the list loads.');
  log('  ──────────────────────────────────────────────\n');

  const deadline = Date.now() + 5 * 60 * 1000; // wait up to 5 minutes for sign-in
  while (Date.now() < deadline) {
    if (await safe$(page, '#readyToInvoice')) {
      log('  Logged in — list found.\n');
      await waitForRows(page);
      return true;
    }
    // Are we still on a login screen? If so, DO NOT touch the page — let the
    // user type. Reloading here would wipe their half-typed credentials.
    const onLogin = await safe$(page, 'input[type="password"]');
    if (!onLogin) {
      // Logged in (or past the login form) but not on the list yet — go there once.
      await page.goto(CONFIG.listUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
    }
    await sleep(2500);
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
  await ensureListLoaded(page);
  const rows = await readListRows(page);
  let limit = rows.length;
  if (CONFIG.maxOrders && CONFIG.maxOrders > 0) limit = Math.min(limit, CONFIG.maxOrders);

  const doPhotos = CONFIG.checkDuplicatePhotos !== false;

  // Load the Google Sheet "complete" tracker — live from Google when configured,
  // otherwise from a local .xlsx export (which may be stale).
  let sheet = null;
  if (CONFIG.checkSheetCompletion !== false) {
    sheet = await loadSheetCompletionMap();
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
  const billed = {};    // techName -> { total, weeks: { 'YYYY-MM-DD': hours } }
  const photosDir = path.join(__dirname, 'photos');
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
          for (const ai of so.actionItems) {
            if (!ai.noteCount || ai.noteCount <= 0) { ai.notes = []; continue; }
            const list = await fetchActionItemNotes(context, ai.id);
            ai.notes = list;
            list.forEach((n) => notes.push({ aiNumber: ai.number || ai.id, ...n }));
          }
        }

        const findings = runAudit(so);
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

        // Accumulate billed (invoiced) hours per mechanic, bucketed by Mon–Sun week.
        const wk = mondayISO(r.completedDate ? new Date(r.completedDate * 1000) : new Date());
        for (const ai of so.actionItems) {
          const tn = ai.technician; const hrs = ai.invoicedHours || 0;
          if (!tn || hrs <= 0) continue;
          const b = (billed[tn] = billed[tn] || { total: 0, weeks: {} });
          b.total += hrs; b.weeks[wk] = (b.weeks[wk] || 0) + hrs;
        }

        results.push({
          soNumber: so.soNumber, url: page.url(),
          customerName: so.customerName || r.customer, unitNumber: unitNum,
          serviceWriter: r.serviceWriter || '', technicians, poNumber: r.poNumber,
          sheetComplete, sheetStatus, notes, serviceCall,
          actionItemCount: so.actionItems.length, findings,
        });

        // Download photos: save each locally (for the report) and fingerprint it.
        let photoCt = 0;
        if (doPhotos) {
          for (const ai of so.actionItems) {
            if (!ai.photoCount || ai.photoCount <= 0) continue;
            const urls = await fetchActionItemPhotoUrls(context, ai.id);
            for (const u of urls) {
              const saved = await fetchAndStorePhoto(context, u, photosDir);
              if (saved) {
                allPhotos.push({ soNumber: so.soNumber, aiNumber: ai.number || ai.id, technician: ai.technician || '', url: u, hash: saved.hash, localFile: saved.localFile });
                photoCt++;
              }
            }
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

  writeCsv(results);
  writeHtml(results, dupInfo);
  const totalFindings = results.reduce((n, r) => n + r.findings.length, 0);
  const flaggedOrders = results.filter((r) => r.findings.length).length;

  // --- Impact summary for the FreeAudit dashboard ---
  const byCheck = {};
  results.forEach((r) => r.findings.forEach((f) => { byCheck[f.check] = (byCheck[f.check] || 0) + 1; }));
  const minsPerOrder = CONFIG.manualMinutesPerOrder || 8;

  // --- Billed-hours scorecard (per mechanic, by Mon–Sun week) ---
  const billedWeeks = new Set();
  Object.values(billed).forEach((b) => Object.keys(b.weeks).forEach((w) => billedWeeks.add(w)));
  const billedSummary = {
    weeks: [...billedWeeks].sort().reverse(),
    byTech: Object.entries(billed).map(([name, b]) => ({
      name,
      total: Math.round(b.total * 100) / 100,
      weekHours: Object.fromEntries(Object.entries(b.weeks).map(([w, h]) => [w, Math.round(h * 100) / 100])),
    })).sort((a, b) => b.total - a.total),
  };

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
    billed: billedSummary,
  };
  fs.writeFileSync(path.join(__dirname, 'audit-summary.json'), JSON.stringify(summary, null, 2), 'utf8');

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

  fs.writeFileSync(path.join(__dirname, 'photo-investigation.json'), JSON.stringify(dump, null, 2), 'utf8');
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
  fs.writeFileSync(path.join(__dirname, 'viewer-investigation.json'), JSON.stringify(dump, null, 2), 'utf8');
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

  fs.writeFileSync(path.join(__dirname, 'ai-html-dump.html'), dump.html, 'utf8');
  fs.writeFileSync(path.join(__dirname, 'ai-network-dump.json'),
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
  fs.writeFileSync(path.join(__dirname, 'img-api-dump.html'), body, 'utf8');

  // Pull out any image-ish URLs from the returned HTML.
  const urls = [...body.matchAll(/(?:src|href|data-[\w-]*)\s*=\s*["']([^"']+)["']/gi)]
    .map((m) => m[1])
    .filter((u) => /amazonaws|attachment|getImage|downloadImage|\.jpe?g|\.png|\.webp|\.pdf|\.gif/i.test(u) &&
      !/loading|icon|logo|placeholder/i.test(u));
  fs.writeFileSync(path.join(__dirname, 'img-api-urls.json'),
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
  const files = fs.readdirSync(__dirname)
    .filter((f) => /\.xlsx$/i.test(f) && !f.startsWith('~$'))
    .map((f) => ({ f, m: fs.statSync(path.join(__dirname, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  return files.length ? path.join(__dirname, files[0].f) : null;
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

  // --- Preferred: live Google Sheets via the Sheets API key ---
  const urls = sheetUrls();
  if (gsheets.isConfigured() && urls.length) {
    try {
      const tabs = [];
      const titles = [];
      for (const url of urls) {
        const sheet = await gsheets.readSpreadsheet(url, filterFn);
        titles.push(sheet.title);
        for (const t of sheet.tabs) tabs.push(t);
      }
      const { map, tabsUsed } = buildMapFromTabs(tabs);
      return { map, files: titles, year, tabsUsed, live: true };
    } catch (e) {
      log(`Sheet tracker: LIVE Google Sheets read failed (${e.message}). Falling back to the local .xlsx export.`);
    }
  }

  // --- Fallback: local .xlsx export(s) ---
  let files;
  if (CONFIG.sheetFile) {
    const p = path.join(__dirname, CONFIG.sheetFile);
    files = fs.existsSync(p) ? [p] : [];
  } else {
    files = fs.readdirSync(__dirname)
      .filter((f) => /\.xlsx$/i.test(f) && !f.startsWith('~$'))
      .map((f) => path.join(__dirname, f));
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
  fs.writeFileSync(path.join(__dirname, 'sheet-sample.csv'), csv.split(/\r?\n/).slice(0, 25).join('\n'), 'utf8');
  fs.writeFileSync(path.join(__dirname, 'sheet-tabs.json'), JSON.stringify({ sheetId, currentGid: gid, tabs }, null, 2), 'utf8');
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

  fs.writeFileSync(path.join(__dirname, 'notes-network.json'), JSON.stringify({ ...found, hadFn, reqs, calls, dom }, null, 2), 'utf8');
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
  fs.writeFileSync(path.join(__dirname, 'audit-results.csv'), '﻿' + lines.join('\r\n'), 'utf8');
}

const CHECK_NAMES = {
  A: 'Photos', B: 'Parts', C: 'Inspections', D: 'Hours', E: 'PO', F: 'Dup photo', G: 'Sheet',
};

function writeHtml(results, dupInfo = {}) {
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
    const scBadge = r.serviceCall ? '<span class="sc-badge">🛎 Service Call</span>' : '';
    return `<div class="so ${sev}">
      <div class="so-head"><strong>${esc(r.soNumber)}</strong>${scBadge}
        <span class="meta">${esc(r.customerName || '')} ${r.unitNumber ? '· Unit ' + esc(r.unitNumber) : ''}
          ${techList ? '· Tech: ' + esc(techList) : ''}${r.serviceWriter ? ' · Writer: ' + esc(r.serviceWriter) : ''}</span>
        ${sheetBadge}
        <a href="${esc(r.url)}" target="_blank">open</a></div>
      ${findingHtml}${notesHtml(r)}${galleryHtml(r)}</div>`;
  }).join('');

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
  <div class="wrap">
  ${cards}
  </div>
  <div id="lbov" onclick="this.style.display='none'"><img id="lbimg" src=""></div>
  <script>
    function lb(src){ var o=document.getElementById('lbov'); document.getElementById('lbimg').src=src; o.style.display='flex'; }
    document.addEventListener('keydown',function(e){ if(e.key==='Escape') document.getElementById('lbov').style.display='none'; });
  </script>
</body></html>`;
  fs.writeFileSync(path.join(__dirname, 'audit-report.html'), html, 'utf8');
}

/* ----------------------------------------------------------------------------
 * Reporting explorer (MODE=reports). Once signed in, maps Fullbay's Reporting
 * section so we can find the Invoiced Hours Report (per-tech completed/invoiced
 * hours by date) to power the efficiency scorecard. Writes a dump file to read.
 * -------------------------------------------------------------------------- */
async function runReportsProbe(page, context) {
  if (!(await ensureListLoaded(page))) { log('Not signed into Fullbay — aborting.'); return; }
  log('Signed in. Exploring Fullbay Reporting…');

  const grabAllLinks = () => page.evaluate(() => {
    const seen = new Set(); const out = [];
    document.querySelectorAll('a[href]').forEach((a) => {
      const text = (a.textContent || '').replace(/\s+/g, ' ').trim();
      const href = a.getAttribute('href') || '';
      if (!href || href.indexOf('javascript:') === 0 || href === '#') return;
      const key = text + '|' + href;
      if (!seen.has(key)) { seen.add(key); out.push({ text, href }); }
    });
    return out;
  });

  // Capture a report page's controls + table so we know how to scrape it.
  const grabReportShape = () => page.evaluate(() => {
    const clip = (s, n) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n);
    const inputs = [...document.querySelectorAll('input,select,textarea')].map((el) => ({
      tag: el.tagName.toLowerCase(), type: el.type || '', name: el.name || '', id: el.id || '',
      value: clip(el.value, 40),
      options: el.tagName === 'SELECT' ? [...el.options].slice(0, 14).map((o) => clip(o.textContent, 30) + '=' + o.value) : undefined,
    })).filter((i) => i.name || i.id);
    const tables = [...document.querySelectorAll('table')].slice(0, 4).map((t) => ({
      id: t.id || '', cls: t.className || '',
      headers: [...t.querySelectorAll('thead th, tr:first-child th, tr:first-child td')].map((th) => clip(th.textContent, 24)).slice(0, 16),
      rows: [...t.querySelectorAll('tbody tr')].slice(0, 3).map((tr) => [...tr.querySelectorAll('td,th')].map((td) => clip(td.textContent, 22)).slice(0, 16)),
    }));
    return { title: document.title, bodyText: clip(document.body.innerText, 500), inputs, tables };
  });

  const dump = [];
  const line = (s) => { dump.push(s); };

  // 1) Open the real Reporting index discovered earlier.
  const reportingUrl = CONFIG.baseUrl + '/office/configuration/indexReports.html';
  await page.goto(reportingUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await sleep(1200);
  line('=== Reporting index: ' + reportingUrl + ' (title: ' + (await page.title().catch(() => '')) + ') ===');
  const idxBody = await page.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 600)).catch(() => '');
  line('  body: ' + idxBody);
  const idxLinks = await grabAllLinks();
  line('\n--- All links on the Reporting index (' + idxLinks.length + ') ---');
  idxLinks.forEach((l) => line('  ' + (l.text || '(no text)') + '   ->   ' + l.href));

  // 2) The reports are "View Report" buttons (JS-wired). Capture how each is
  //    wired so we can find the Completed Hours Report's URL/endpoint.
  const reportCards = await page.evaluate(() => {
    const clip = (s, n) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n);
    const out = [];
    document.querySelectorAll('a,button').forEach((el) => {
      const t = clip(el.textContent, 40);
      if (!/view report|report/i.test(t) && !/report/i.test(el.className)) return;
      const card = el.closest('tr,li,.card,.panel,.report-row,.report,div');
      const dataAttrs = [...el.attributes].filter((a) => /^data-|^href$|^onclick$/.test(a.name)).map((a) => a.name + '=' + clip(a.value, 120));
      out.push({
        text: t,
        near: card ? clip(card.innerText, 70) : '',
        attrs: dataAttrs,
        html: clip((card || el).outerHTML, 360),
      });
    });
    return out;
  }).catch(() => []);
  line('\n--- "View Report" buttons & their wiring (' + reportCards.length + ') ---');
  reportCards.forEach((c) => {
    line('  • ' + c.near);
    line('     attrs: ' + (c.attrs.join('  ') || '(none)'));
    line('     html: ' + c.html);
  });

  // 3) Try opening the Completed Hours Report by clicking its button, then capture shape.
  const opened = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('tr,li,.card,.panel,.report-row,.report,div')];
    const card = rows.find((r) => /completed hours report/i.test(r.textContent || ''));
    if (!card) return false;
    const btn = [...card.querySelectorAll('a,button')].find((b) => /view report|view/i.test(b.textContent || '')) || card.querySelector('a,button');
    if (!btn) return false;
    btn.click();
    return true;
  }).catch(() => false);
  if (opened) {
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await sleep(2200);
    line('\n=== Completed Hours Report (after clicking View Report) ===');
    line('  URL now: ' + page.url());
    const shape = await grabReportShape().catch(() => null);
    if (shape) {
      line('  title: ' + shape.title);
      line('  body: ' + shape.bodyText);
      line('  inputs/controls:');
      shape.inputs.forEach((i) => line('    [' + i.tag + (i.type ? ':' + i.type : '') + '] name=' + i.name + ' id=' + i.id + (i.value ? ' value=' + i.value : '') + (i.options ? ' options=' + i.options.join(', ') : '')));
      shape.tables.forEach((tb, n) => {
        line('  table#' + n + ' id=' + tb.id + ' class=' + tb.cls);
        line('    headers: ' + tb.headers.join(' | '));
        tb.rows.forEach((r) => line('    row: ' + r.join(' | ')));
      });
    } else { line('  (could not read report page)'); }
  } else {
    line('\n(Completed Hours Report button not found to click.)');
  }

  const outFile = path.join(__dirname, 'fullbay-reports-probe.txt');
  fs.writeFileSync(outFile, dump.join('\n'), 'utf8');
  log('Wrote ' + outFile);
  log('Done — open that file to see the reports and their date controls/table layout.');
  await sleep(1200);
}

/* ----------------------------------------------------------------------------
 * Completed Hours Report probe (MODE=completedhours). Opens the Completed Hours
 * report modal, fills a date range, runs it, and captures the modal form, the
 * network request it fires, and the resulting per-employee table — everything
 * needed to scrape completed (invoiced) hours per mechanic by week.
 * -------------------------------------------------------------------------- */
async function runCompletedHoursProbe(page, context) {
  if (!(await ensureListLoaded(page))) { log('Not signed into Fullbay — aborting.'); return; }
  log('Signed in. Opening the Completed Hours Report…');

  const reqs = [];
  page.on('request', (r) => {
    const u = r.url();
    if (/report|completed|hours|datapoint|handle|configuration/i.test(u) && !/\.(png|jpg|gif|css|woff|js)(\?|$)/i.test(u)) {
      reqs.push(r.method() + ' ' + u + (r.postData() ? '  BODY: ' + r.postData().slice(0, 400) : ''));
    }
  });
  page.on('response', (resp) => {
    const u = resp.url();
    if (/datapoint=completedHours|completedHours|generateReport|runReport/i.test(u)) reqs.push('  <-RESP ' + resp.status() + ' ' + u);
  });

  const dump = [];
  const line = (s) => dump.push(s);

  await page.goto(CONFIG.baseUrl + '/office/configuration/indexReports.html', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await sleep(1500);

  // Open the Completed Hours modal via its data-modal button.
  const clicked = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button[data-modal],a[data-modal]')]
      .find((x) => /datapoint=completedHours/i.test(x.getAttribute('data-modal') || ''));
    if (b) { b.click(); return b.getAttribute('data-modal'); }
    return null;
  }).catch(() => null);
  line('Clicked Completed Hours data-modal: ' + clicked);
  await sleep(2800);

  const modalInfo = () => page.evaluate(() => {
    const clip = (s, n) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n);
    const modal = document.querySelector('.modal.in, .modal.show, .modal[style*="display: block"], .modal-dialog');
    const scope = modal || document;
    const inputs = [...scope.querySelectorAll('input,select,textarea')].map((el) => ({
      tag: el.tagName.toLowerCase(), type: el.type || '', name: el.name || '', id: el.id || '',
      value: clip(el.value, 40),
      options: el.tagName === 'SELECT' ? [...el.options].slice(0, 10).map((o) => clip(o.textContent, 24) + '=' + o.value) : undefined,
    })).filter((i) => i.name || i.id);
    const buttons = [...scope.querySelectorAll('button,a.btn,input[type=submit]')].map((b) => ({
      text: clip(b.textContent || b.value, 24), onclick: clip(b.getAttribute('onclick'), 80), id: b.id || '',
    })).filter((b) => b.text);
    return { html: clip((modal || {}).outerHTML, 60), inputs, buttons };
  });

  let m = await modalInfo().catch(() => null);
  line('\n=== Completed Hours modal — form controls ===');
  if (m) {
    m.inputs.forEach((i) => line('  [' + i.tag + (i.type ? ':' + i.type : '') + '] name=' + i.name + ' id=' + i.id + (i.value ? ' value=' + i.value : '') + (i.options ? ' options=' + i.options.join(', ') : '')));
    line('  buttons: ' + m.buttons.map((b) => b.text + (b.id ? '#' + b.id : '') + (b.onclick ? ' onclick=' + b.onclick : '')).join('  |  '));
  } else { line('  (no modal found)'); }

  // Fill any date inputs with a known full week (Mon 5/18 – Sun 5/24, 2026) and run it.
  const filled = await page.evaluate(() => {
    const modal = document.querySelector('.modal.in, .modal.show, .modal[style*="display: block"], .modal-dialog') || document;
    const dates = [...modal.querySelectorAll('input')].filter((el) => /date/i.test(el.id + ' ' + el.name) || /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(el.value || ''));
    const vals = ['5/18/2026', '5/24/2026'];
    dates.forEach((el, i) => { el.value = vals[Math.min(i, 1)]; el.dispatchEvent(new Event('change', { bubbles: true })); });
    const go = [...modal.querySelectorAll('button,a.btn,input[type=submit]')].find((b) => /^(go|run|generate|view|submit)\b/i.test((b.textContent || b.value || '').trim()));
    if (go) go.click();
    return { dateFieldsFilled: dates.map((d) => d.id || d.name), clickedGo: !!go };
  }).catch(() => ({}));
  line('\nFilled date fields: ' + JSON.stringify(filled));
  await sleep(4000);

  // Capture the resulting report table.
  const result = await page.evaluate(() => {
    const clip = (s, n) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n);
    const tables = [...document.querySelectorAll('table')].map((t) => ({
      id: t.id || '', cls: clip(t.className, 40),
      headers: [...t.querySelectorAll('thead th, tr:first-child th, tr:first-child td')].map((th) => clip(th.textContent, 22)).slice(0, 14),
      rowCount: t.querySelectorAll('tbody tr').length,
      rows: [...t.querySelectorAll('tbody tr')].slice(0, 6).map((tr) => [...tr.querySelectorAll('td,th')].map((td) => clip(td.textContent, 22)).slice(0, 14)),
    })).filter((t) => t.headers.length && (t.rowCount > 0 || /hour|tech|employee|name/i.test(t.headers.join(' '))));
    return tables;
  }).catch(() => []);
  line('\n=== Result tables (after Go) ===');
  result.forEach((t, n) => {
    line('  table#' + n + ' id=' + t.id + ' class=' + t.cls + ' rows=' + t.rowCount);
    line('    headers: ' + t.headers.join(' | '));
    t.rows.forEach((r) => line('    row: ' + r.join(' | ')));
  });

  line('\n=== Network requests seen (report-related) ===');
  [...new Set(reqs)].slice(0, 40).forEach((r) => line('  ' + r));

  fs.writeFileSync(path.join(__dirname, 'fullbay-completedhours-probe.txt'), dump.join('\n'), 'utf8');
  log('Wrote fullbay-completedhours-probe.txt');
  await sleep(1200);
}

/* ----------------------------------------------------------------------------
 * Fullbay "Completed Hours" report = billed (invoiced) hours per employee.
 * Parse the #reportTable into { weeks:[Mon-ISO], byEmployee:[{name,weekHours,total}] }.
 * -------------------------------------------------------------------------- */
function parseCompletedHoursTable(html) {
  const tblM = html.match(/<table[^>]*id="reportTable"[\s\S]*?<\/table>/i);
  if (!tblM) return null;
  const tbl = tblM[0];
  const clean = (s) => s.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

  const head = tbl.match(/<thead>[\s\S]*?<\/thead>/i);
  const ths = head ? [...head[0].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)].map((m) => clean(m[1])) : [];
  // Map each header column to a Monday-ISO key (date-range headers) or a role.
  const colKey = ths.map((t) => {
    const dm = t.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (dm) return mondayISO(new Date(+dm[3], +dm[1] - 1, +dm[2]));
    if (/^total$/i.test(t)) return '__total';
    if (/^average$/i.test(t)) return '__avg';
    if (/employee/i.test(t)) return '__name';
    return null;
  });

  const body = tbl.match(/<tbody>[\s\S]*?<\/tbody>/i);
  const trs = body ? [...body[0].matchAll(/<tr>([\s\S]*?)<\/tr>/gi)] : [];
  const byEmployee = [];
  trs.forEach((tr) => {
    const tds = [...tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => clean(m[1]));
    if (!tds.length) return;
    let name = ''; let total = null; const weekHours = {};
    tds.forEach((cell, i) => {
      const key = colKey[i];
      if (key === '__name' || (i === 0 && !key)) { name = cell; return; }
      if (key === '__total') { total = parseFloat(cell); return; }
      if (key && key.indexOf('__') !== 0) { const v = parseFloat(cell); if (!isNaN(v)) weekHours[key] = v; }
    });
    if (!name) name = tds[0];
    if (total == null) total = Object.values(weekHours).reduce((a, b) => a + b, 0);
    byEmployee.push({ name, weekHours, total: +(+total).toFixed(2) });
  });
  const weeks = colKey.filter((k) => k && k.indexOf('__') !== 0);
  return { weeks, byEmployee };
}

// M/D/YYYY (no leading zeros) — the date format Fullbay's report expects.
function mdy(d) { return (d.getMonth() + 1) + '/' + d.getDate() + '/' + d.getFullYear(); }

// Fetch the Completed Hours report for a date range (Weekly buckets) and return parsed data.
async function fetchCompletedHours(page, context, startMDY, endMDY, columnFormat) {
  const base = CONFIG.baseUrl;
  // Open the modal so its employee <select> populates, then read employee + location ids.
  await page.goto(base + '/office/configuration/indexReports.html', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await sleep(1400);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button[data-modal],a[data-modal]')]
      .find((x) => /datapoint=completedHours/i.test(x.getAttribute('data-modal') || ''));
    if (b) b.click();
  }).catch(() => {});
  await sleep(3200);
  let emps = await page.evaluate(() => {
    const sel = document.querySelector('#viewReportModalEntityEmployeeIds');
    return sel ? [...sel.options].map((o) => ({ id: o.value, name: (o.textContent || '').trim() })).filter((e) => e.id) : [];
  }).catch(() => []);
  let locs = await page.evaluate(() => {
    const sel = document.querySelector('#viewReportModalEntityLocationIds');
    return sel ? [...sel.options].map((o) => o.value).filter(Boolean) : [];
  }).catch(() => []);
  // Fallback to the last-known employee list if the modal didn't populate.
  if (!emps.length) {
    try { emps = JSON.parse(fs.readFileSync(path.join(__dirname, 'fb-ch-employees.json'), 'utf8')); } catch (e) { /* ignore */ }
  }
  if (!locs.length) locs = ['9086'];

  const params = new URLSearchParams();
  params.append('datapoint', 'completedHours');
  params.append('reportTitle', 'Completed Hours');
  params.append('dateRange', '');
  params.append('startDate', startMDY);
  params.append('endDate', endMDY);
  locs.forEach((l) => params.append('entityLocationIds[]', l));
  emps.forEach((e) => params.append('entityEmployeeIds[]', e.id));
  params.append('typeOfEntityEmployees', 'Active');
  params.append('columnFormat', columnFormat || 'Weekly');

  const rep = await context.request.post(base + '/office/configuration/viewReport.html', {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    data: params.toString(),
  });
  const html = await rep.text();
  const parsed = parseCompletedHoursTable(html);
  return { ok: rep.status() === 200 && !!parsed, status: rep.status(), employees: emps.length, parsed };
}

// MODE=billed — fetch recent weeks of completed hours and write the JSON the scorecard reads.
async function runBilledFetch(page, context) {
  if (!(await ensureListLoaded(page))) { log('Not signed into Fullbay — aborting.'); return; }
  const today = new Date();
  const startD = new Date(today); startD.setDate(startD.getDate() - 7 * 11); // ~12 weeks back
  // snap start to its Monday
  startD.setDate(startD.getDate() - ((startD.getDay() + 6) % 7));
  log('Fetching Completed Hours ' + mdy(startD) + ' → ' + mdy(today) + ' (Weekly)…');
  const r = await fetchCompletedHours(page, context, mdy(startD), mdy(today), 'Weekly');
  if (!r.ok || !r.parsed) { log('Failed (HTTP ' + r.status + ', employees ' + r.employees + ', parsed ' + !!r.parsed + ').'); return; }
  const out = {
    updatedAt: new Date().toISOString(),
    source: 'fullbay-completed-hours',
    rangeStart: mdy(startD), rangeEnd: mdy(today),
    weeks: r.parsed.weeks,
    byEmployee: r.parsed.byEmployee,
  };
  fs.writeFileSync(path.join(__dirname, 'fullbay-completed-hours.json'), JSON.stringify(out, null, 2), 'utf8');
  const nonZero = r.parsed.byEmployee.filter((e) => e.total > 0).length;
  log('Wrote fullbay-completed-hours.json — ' + r.parsed.weeks.length + ' weeks, ' + r.parsed.byEmployee.length + ' employees (' + nonZero + ' with hours).');
  await sleep(600);
}

/* ----------------------------------------------------------------------------
 * chdata2: opens the modal in-page so JS populates the employee list, reads
 * all employee ids, then (a) direct-POSTs viewReport.html with them and (b)
 * clicks Go and dumps the rendered report — so we can see where the data lives.
 * -------------------------------------------------------------------------- */
async function runChData2Probe(page, context) {
  if (!(await ensureListLoaded(page))) { log('Not signed into Fullbay — aborting.'); return; }
  const base = CONFIG.baseUrl;
  await page.goto(base + '/office/configuration/indexReports.html', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await sleep(1500);

  // Open the Completed Hours modal so its employee <select> populates.
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button[data-modal],a[data-modal]')]
      .find((x) => /datapoint=completedHours/i.test(x.getAttribute('data-modal') || ''));
    if (b) b.click();
  }).catch(() => {});
  await sleep(3500);

  const emps = await page.evaluate(() => {
    const sel = document.querySelector('#viewReportModalEntityEmployeeIds');
    return sel ? [...sel.options].map((o) => ({ id: o.value, name: (o.textContent || '').trim() })).filter((e) => e.id) : [];
  }).catch(() => []);
  const locs = await page.evaluate(() => {
    const sel = document.querySelector('#viewReportModalEntityLocationIds');
    return sel ? [...sel.options].map((o) => o.value).filter(Boolean) : ['9086'];
  }).catch(() => ['9086']);
  log('Employees from live modal: ' + emps.length + '; locations: ' + locs.join(','));
  fs.writeFileSync(path.join(__dirname, 'fb-ch-employees.json'), JSON.stringify(emps, null, 2), 'utf8');

  // (a) Direct POST with all employees, weekly buckets, wide range.
  const params = new URLSearchParams();
  params.append('datapoint', 'completedHours');
  params.append('reportTitle', 'Completed Hours');
  params.append('dateRange', '');
  params.append('startDate', '4/20/2026');
  params.append('endDate', '5/31/2026');
  locs.forEach((l) => params.append('entityLocationIds[]', l));
  emps.forEach((e) => params.append('entityEmployeeIds[]', e.id));
  params.append('typeOfEntityEmployees', 'Active');
  params.append('columnFormat', 'Weekly');
  const rep = await context.request.post(base + '/office/configuration/viewReport.html', {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    data: params.toString(),
  });
  const repHtml = await rep.text();
  fs.writeFileSync(path.join(__dirname, 'fb-ch-report.html'), repHtml, 'utf8');
  log('Direct POST -> HTTP ' + rep.status() + ', ' + repHtml.length + ' bytes');

  // (b) Drive the UI: set fields, click Go, dump the rendered report container.
  await page.evaluate(() => {
    const sd = document.querySelector('#viewReportModalStartDate'); if (sd) { sd.value = '4/20/2026'; sd.dispatchEvent(new Event('change', { bubbles: true })); }
    const ed = document.querySelector('#viewReportModalEndDate'); if (ed) { ed.value = '5/31/2026'; ed.dispatchEvent(new Event('change', { bubbles: true })); }
    const cf = document.querySelector('#viewReportModalColumnFormat'); if (cf) { cf.value = 'Weekly'; cf.dispatchEvent(new Event('change', { bubbles: true })); }
    const sel = document.querySelector('#viewReportModalEntityEmployeeIds'); if (sel) { [...sel.options].forEach((o) => { o.selected = true; }); sel.dispatchEvent(new Event('change', { bubbles: true })); }
    if (typeof viewReportModalSubmitReport === 'function') viewReportModalSubmitReport();
    else { const go = document.querySelector('#btnSubmit'); if (go) go.click(); }
  }).catch(() => {});
  await sleep(6000);
  const rendered = await page.evaluate(() => {
    const clip = (s, n) => (s || '').slice(0, n);
    const tgt = document.querySelector('#viewReportResults, .report-results, #reportResults, .modal.in .modal-body, .modal.show .modal-body');
    return tgt ? clip(tgt.outerHTML, 120000) : clip(document.body.innerHTML, 120000);
  }).catch(() => '');
  fs.writeFileSync(path.join(__dirname, 'fb-ch-rendered.html'), rendered, 'utf8');
  log('Rendered report dumped -> fb-ch-rendered.html (' + rendered.length + ' bytes)');
  await sleep(800);
}

/* ----------------------------------------------------------------------------
 * Completed-hours DATA fetch (MODE=chdata). Replays the report's POST via the
 * authenticated context and saves the raw HTML so we can build the parser.
 * -------------------------------------------------------------------------- */
async function runChDataProbe(page, context) {
  if (!(await ensureListLoaded(page))) { log('Not signed into Fullbay — aborting.'); return; }
  const base = CONFIG.baseUrl;

  // 1) Get the modal HTML to read the full employee <select> (id + name).
  const modalResp = await context.request.post(base + '/office/configuration/viewReportModal.html', {
    form: { datapoint: 'completedHours', reportTitle: 'Completed Hours' },
  });
  const modalHtml = await modalResp.text();
  fs.writeFileSync(path.join(__dirname, 'fb-ch-modal.html'), modalHtml, 'utf8');

  // Parse employee options inside the employee select.
  let empIds = [];
  const selM = modalHtml.match(/id="viewReportModalEntityEmployeeIds"[\s\S]*?<\/select>/i);
  if (selM) {
    empIds = [...selM[0].matchAll(/<option[^>]*value="(\d+)"[^>]*>([^<]+)</g)].map((m) => ({ id: m[1], name: m[2].trim() }));
  }
  log('Employees parsed: ' + empIds.length);

  // 2) POST the report for a wide range, weekly buckets.
  const params = new URLSearchParams();
  params.append('datapoint', 'completedHours');
  params.append('reportTitle', 'Completed Hours');
  params.append('dateRange', '');
  params.append('startDate', '4/20/2026');
  params.append('endDate', '5/31/2026');
  params.append('entityLocationIds[]', '9086');
  empIds.forEach((e) => params.append('entityEmployeeIds[]', e.id));
  params.append('typeOfEntityEmployees', 'Active');
  params.append('columnFormat', 'Weekly');

  const rep = await context.request.post(base + '/office/configuration/viewReport.html', {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    data: params.toString(),
  });
  const repHtml = await rep.text();
  fs.writeFileSync(path.join(__dirname, 'fb-ch-report.html'), repHtml, 'utf8');
  log('Report HTTP ' + rep.status() + ', ' + repHtml.length + ' bytes -> fb-ch-report.html');
  await sleep(800);
}

/* ----------------------------------------------------------------------------
 * Entry point.
 * -------------------------------------------------------------------------- */
// Allow requiring this file (e.g. for offline parser tests) without launching a browser.
if (require.main !== module) { module.exports = { parseCompletedHoursTable, mondayISO, mdy, loadSheetCompletionMap, extractTabCompletion, buildMapFromTabs }; }

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
    const dir = path.join(__dirname, '.fb-logintest');
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

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: !!CONFIG.headless,
    viewport: null,
    args: ['--start-maximized'],
  });
  const page = context.pages()[0] || (await context.newPage());
  try {
    if (MODE === 'probe') await runProbe(page, context);
    else if (MODE === 'photos') await runPhotoProbe(page, context);
    else if (MODE === 'viewer') await runViewerProbe(page, context);
    else if (MODE === 'aihtml') await runAiHtmlProbe(page, context);
    else if (MODE === 'imgapi') await runImgApiProbe(page, context);
    else if (MODE === 'sheet') await runSheetProbe(page, context);
    else if (MODE === 'notes') await runNotesProbe(page, context);
    else if (MODE === 'reports') await runReportsProbe(page, context);
    else if (MODE === 'completedhours') await runCompletedHoursProbe(page, context);
    else if (MODE === 'chdata') await runChDataProbe(page, context);
    else if (MODE === 'chdata2') await runChData2Probe(page, context);
    else if (MODE === 'billed') await runBilledFetch(page, context);
    else if (MODE === 'login') {
      // Open Fullbay and wait for the user to sign in (session is saved in the profile).
      const ok = await ensureListLoaded(page);
      log(ok ? '\nFullbay connected — audits can be run now.' : '\nSign-in was not completed.');
      await sleep(1500);
    } else await runFull(page, context);
  } catch (e) {
    log('\nFATAL: ' + e.message);
  } finally {
    await context.close();
  }
})();

/*
 * inspections.js — when was this unit LAST inspected?
 *
 * Read off the unit's Service History (closed repairs) so an order billing an
 * inspection can be checked against the one before it. A unit inspected a week
 * ago rarely needs another, and the order under review is the moment to notice.
 *
 * Read-only: it navigates and reads. It never submits a change.
 *
 * TWO THINGS THIS PAGE WILL CATCH YOU OUT ON — both learned the hard way on the
 * Albany DOT-PM report, where 90 units with real history were reported as having
 * none and the report went out wrong:
 *
 * 1. THE DATE RANGE IS HELD IN THE FULLBAY SESSION, not in the request. It
 *    carries over from whatever was looked at last, so the page you get is
 *    filtered by a window nobody here chose. One session held
 *    01/01/2015 -> 10/28/2026 and every repair closed in the previous week was
 *    invisible. The range is therefore always stated explicitly below.
 *
 * 2. AN ABSENT TABLE IS NOT AN EMPTY HISTORY. A missing #dataTable is equally
 *    consistent with a page that failed to load. Fullbay prints "There are no
 *    closed repairs at this time" when a unit really has none, so that sentence
 *    is the only thing accepted as proof of empty. Anything else is reported as
 *    unknown, never as "no inspections".
 */

/*
 * What counts as an inspection, by SERVICE NAME.
 *
 * Deliberately narrow. An earlier version matched /dot|pm/ and picked
 * "5F - DOT TAPE R\R" (0.5 hr) as the inspection on an order that also carried
 * the real "5F - DOT - PM CHECKLIST" (1.25 hr). The name is authoritative and
 * hours are not: real DOT-PM items bill 0.5, 1.0, 1.25 and 1.5.
 */
const INSPECTION_RE = /pm\s*-?\s*checklist|quarterly\s*inspection|\bbit\b/i;
const DOT_RE = /\bdot\b/i;

/* Shown as the kind of inspection it was, for the report line. */
function inspectionType(name) {
  if (/quarterly/i.test(name)) return 'Quarterly';
  if (DOT_RE.test(name)) return 'DOT-PM';
  if (/pm/i.test(name)) return 'PM only';
  return 'Inspection';
}

/*
 * Every closed action item for a unit, newest first.
 *
 * Returns { rows, note }. `note` is set only when the rows could not be trusted:
 * 'empty' for a unit the page states has no closed repairs, or a message for a
 * page that would not load. Callers must treat a note as "unknown".
 */
async function readHistory(page, baseUrl, customerUnitId) {
  const url = baseUrl + '/office/customer/viewCustomerUnitClosedRepairs.html'
    + '?customerUnitId=' + encodeURIComponent(customerUnitId)
    + '&dateRange=all'
    + '&startDate=' + encodeURIComponent('01/01/2005')
    + '&endDate=' + encodeURIComponent('12/31/2035');

  let loaded = false;
  for (let attempt = 0; attempt < 3 && !loaded; attempt += 1) {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
    loaded = await page.$('#dataTable').then((h) => !!h).catch(() => false);
    if (loaded) break;
    const saysEmpty = await page
      .evaluate(() => /There are no closed repairs/i.test(document.body.innerText || ''))
      .catch(() => false);
    if (saysEmpty) return { rows: [], note: 'empty' };
    await new Promise((res) => setTimeout(res, 1500));
  }
  if (!loaded) return { rows: [], note: 'service history could not be read' };

  const rows = await page.evaluate(() => {
    const table = document.querySelector('#dataTable');
    if (!table) return [];

    const heads = [...table.querySelectorAll('thead th')]
      .map((th) => th.textContent.trim().replace(/\s+/g, ' ').toLowerCase());
    const col = (re) => heads.findIndex((h) => re.test(h));
    const iSo = col(/^so$/); const iComplaint = col(/complaint/);
    const iCorrection = col(/correction/); const iHours = col(/hours/);
    const iDate = col(/date action completed/);

    /* Read the DataTable's own data, not the visible DOM: the table is paginated
     * and the DOM holds only the page currently shown. */
    let data = null;
    try {
      if (window.jQuery && jQuery.fn.DataTable.isDataTable(table)) {
        data = jQuery(table).DataTable().rows().data().toArray();
      }
    } catch (e) { /* fall through to the DOM */ }

    const cells = (r) => (Array.isArray(r) ? r : Object.keys(r).sort((a, b) => a - b).map((k) => r[k]));
    const strip = (h) => String(h == null ? '' : h).replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&')
      .replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

    const raw = (data && data.length)
      ? data.map(cells)
      : [...table.querySelectorAll('tbody tr')]
        .map((tr) => [...tr.querySelectorAll('td')].map((td) => td.innerHTML));

    return raw.map((c) => {
      const soCell = c[iSo] == null ? '' : String(c[iSo]);
      const dateCell = c[iDate] == null ? '' : String(c[iDate]);
      // The sortable unix timestamp is hidden in a span beside the shown date.
      const ts = parseInt((dateCell.match(/>(\d{9,})</) || dateCell.match(/^(\d{9,})/) || [, '0'])[1], 10) || 0;
      return {
        so: strip(soCell),
        repairOrderId: (soCell.match(/repairOrderId=(\d+)/) || [, ''])[1],
        complaint: strip(c[iComplaint]),
        correction: strip(c[iCorrection]),
        hours: parseFloat(strip(c[iHours])) || 0,
        ts,
      };
    }).filter((r) => r.so || r.complaint);
  }).catch(() => null);

  if (!rows) return { rows: [], note: 'service history could not be read' };
  rows.sort((a, b) => b.ts - a.ts);
  return { rows, note: '' };
}

/* yyyy-mm-dd in local time, which is how the rest of the report prints dates. */
function fmtDate(ts) {
  const d = new Date(ts * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/*
 * The most recent inspection on a unit, EXCLUDING the order being audited.
 *
 * Excluding it matters both ways round: the order under review may already be
 * closed and would otherwise answer "last inspected" with itself, reporting a
 * 0-day gap on every inspection order.
 *
 * Returns:
 *   { known: true,  last: {date, daysAgo, type, service, so, hours} | null }
 *   { known: false, why: '<reason>' }   nothing could be established
 */
async function lastInspection(page, baseUrl, customerUnitId, opts) {
  const o = opts || {};
  if (!customerUnitId) return { known: false, why: 'no unit link on the order' };

  const { rows, note } = await readHistory(page, baseUrl, customerUnitId);
  if (note && note !== 'empty') return { known: false, why: note };
  if (note === 'empty') return { known: true, last: null };

  const exclude = String(o.excludeSo || '').replace(/\s+/g, '').toUpperCase();
  const excludeRoId = String(o.excludeRepairOrderId || '');

  const insps = rows.filter((r) => {
    if (!r.ts) return false;
    if (excludeRoId && r.repairOrderId === excludeRoId) return false;
    if (exclude && r.so.replace(/\s+/g, '').toUpperCase().includes(exclude)) return false;
    return INSPECTION_RE.test(r.complaint + ' ' + r.correction);
  });
  if (!insps.length) return { known: true, last: null };

  /* A unit can carry a DOT-PM and a Quarterly on the same visit. Both are the
   * same inspection; DOT-PM is the more specific label, so prefer it among
   * everything sharing the newest date. */
  const newest = fmtDate(insps[0].ts);
  const sameDay = insps.filter((r) => fmtDate(r.ts) === newest);
  const pick = sameDay.find((r) => DOT_RE.test(r.complaint + ' ' + r.correction)) || sameDay[0];
  const service = pick.correction || pick.complaint;

  return {
    known: true,
    last: {
      date: newest,
      daysAgo: Math.floor((Date.now() - pick.ts * 1000) / 86400000),
      type: inspectionType(pick.complaint + ' ' + pick.correction),
      service,
      so: pick.so,
      hours: pick.hours || null,
    },
  };
}

module.exports = { lastInspection, readHistory, inspectionType, INSPECTION_RE, fmtDate };

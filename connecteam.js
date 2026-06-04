/*
 * connecteam.js — pulls clocked hours per employee from the Connecteam API.
 *
 * Used by the FreeAudit scorecard to compute efficiency = Fullbay billed hours
 * ÷ Connecteam clocked hours, per mechanic, per Monday–Sunday week.
 *
 * The API key lives in connecteam-credentials.json (never in code or chat).
 * Auth is a single header:  X-API-KEY: <key>
 *
 * CLI test:
 *   node connecteam.js                 -> last 4 weeks of clocked hours per person
 *   node connecteam.js 2026-05-18 2026-05-24   -> one explicit date range
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = __dirname;
const CREDS_PATH = path.join(ROOT, 'connecteam-credentials.json');
const API_BASE = 'api.connecteam.com';

function apiKey() {
  try { return (JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8')).apiKey || '').trim(); }
  catch (e) { return ''; }
}
function isConfigured() { const k = apiKey(); return !!(k && !/PUT-YOUR/i.test(k)); }

// People to leave off the mechanic scorecard (not trailer mechanics). Matched on
// normalized "first last". Edit this list to add/remove names.
const EXCLUDE_NAMES = new Set(['daniel lopez', 'mark casas', 'chance simpson']);
const normName = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();

// --- low-level GET against the Connecteam API, returns parsed JSON ---
function apiGet(reqPath) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { host: API_BASE, path: reqPath, method: 'GET',
        headers: { 'X-API-KEY': apiKey(), Accept: 'application/json' } },
      (res) => {
        let body = '';
        res.on('data', (d) => { body += d; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('Bad JSON from Connecteam')); }
          } else {
            reject(new Error('Connecteam ' + res.statusCode + ': ' + body.slice(0, 300)));
          }
        });
      });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('Connecteam request timed out')));
    req.end();
  });
}

// --- userId -> { name, title, userType, archived } ---
// Fetches BOTH active and archived users so every name resolves (former
// employees still appear in time-clock history but aren't in the active list).
async function listUsers() {
  const map = new Map();
  for (const q of ['', '&userStatus=archived']) {
    let offset = 0;
    for (;;) {
      const r = await apiGet(`/users/v1/users?limit=50&offset=${offset}${q}`);
      const users = (r.data && r.data.users) || [];
      users.forEach((u) => {
        const title = ((u.customFields || []).find((c) => c.name === 'Title') || {}).value || '';
        map.set(u.userId, {
          name: `${u.firstName || ''} ${u.lastName || ''}`.trim(),
          title, userType: u.userType, archived: !!u.isArchived,
        });
      });
      const total = (r.paging && r.paging.total) != null ? r.paging.total : users.length;
      offset += users.length;
      if (!users.length || offset >= total) break;
    }
  }
  return map;
}

async function listTimeClockIds() {
  const r = await apiGet('/time-clock/v1/time-clocks');
  return ((r.data && r.data.timeClocks) || []).filter((t) => !t.isArchived).map((t) => t.id);
}

// --- clocked SECONDS per userId for a date range (YYYY-MM-DD, inclusive) ---
// Gross clock-in to clock-out per shift, summed. (Connecteam returns no separate
// break field for this account, so end-start is the worked time.)
async function clockedSecondsByUser(startDate, endDate) {
  const ids = await listTimeClockIds();
  const secByUser = new Map();
  for (const id of ids) {
    const r = await apiGet(
      `/time-clock/v1/time-clocks/${id}/time-activities?startDate=${startDate}&endDate=${endDate}&limit=500`);
    const byUser = (r.data && r.data.timeActivitiesByUsers) || [];
    byUser.forEach((u) => {
      let s = secByUser.get(u.userId) || 0;
      (u.shifts || []).forEach((sh) => {
        const a = sh.start && sh.start.timestamp, b = sh.end && sh.end.timestamp;
        if (a && b && b > a) s += (b - a);
      });
      secByUser.set(u.userId, s);
    });
  }
  return secByUser;
}

/* ---------------- date / period helpers ---------------- */
// Monday (00:00) of the week containing date d, as a Date.
function mondayOf(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = (x.getDay() + 6) % 7; // Mon=0 .. Sun=6
  x.setDate(x.getDate() - dow);
  return x;
}
function isoDate(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function parseISO(s) { return new Date(s + 'T00:00:00'); }
function labelWeek(d) { return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); }
function labelDay(d) { return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }); }

// Returns the last `n` Monday–Sunday weeks (most recent first).
function recentWeeks(n, today) {
  const base = mondayOf(today || new Date());
  const weeks = [];
  for (let i = 0; i < n; i++) {
    const mon = addDays(base, -7 * i);
    weeks.push({ start: isoDate(mon), end: isoDate(addDays(mon, 6)) });
  }
  return weeks;
}

// Break a [start,end] range into reporting periods (oldest → newest).
//   groupBy 'week' -> full Monday–Sunday weeks covering the range
//   groupBy 'day'  -> one period per calendar day
// Each period: { key, start, end, label }. key/start/end are YYYY-MM-DD.
function periodsFor(startISO, endISO, groupBy) {
  let s = parseISO(startISO), e = parseISO(endISO);
  if (e < s) { const t = s; s = e; e = t; }
  const periods = [];
  if (groupBy === 'day') {
    // Cap runaway daily ranges.
    if ((e - s) / 86400000 > 92) s = addDays(e, -92);
    for (let d = new Date(s); d <= e; d = addDays(d, 1)) {
      const iso = isoDate(d);
      periods.push({ key: iso, start: iso, end: iso, label: labelDay(d) });
    }
  } else {
    let mon = mondayOf(s);
    const lastMon = mondayOf(e);
    if ((lastMon - mon) / 86400000 / 7 > 53) mon = addDays(lastMon, -53 * 7);
    for (let m = new Date(mon); m <= lastMon; m = addDays(m, 7)) {
      periods.push({ key: isoDate(m), start: isoDate(m), end: isoDate(addDays(m, 6)), label: labelWeek(m) });
    }
  }
  return periods;
}

/*
 * clockedRange(startISO, endISO, groupBy) -> {
 *   groupBy, rangeStart, rangeEnd,
 *   weeks:   ['2026-04-20', ...],            // period keys, oldest → newest (kept named "weeks" for the UI)
 *   periods: [{ key, start, end, label }],   // same order, with display labels
 *   byPerson:[ { userId, name, title, archived, weekHours:{key:hrs}, total } ]   // sorted by total desc
 * }
 * Only people who clocked time are included; the EXCLUDE_NAMES list is filtered out.
 */
async function clockedRange(startISO, endISO, groupBy) {
  const gb = groupBy === 'day' ? 'day' : 'week';
  const periods = periodsFor(startISO, endISO, gb);
  const users = await listUsers();
  const acc = new Map(); // userId -> { weekHours, total }
  for (const p of periods) {
    const sec = await clockedSecondsByUser(p.start, p.end);
    sec.forEach((s, uid) => {
      if (!s) return;
      const hrs = s / 3600;
      let row = acc.get(uid);
      if (!row) { row = { weekHours: {}, total: 0 }; acc.set(uid, row); }
      row.weekHours[p.key] = +(hrs.toFixed(2));
      row.total += hrs;
    });
  }
  const byPerson = [...acc.entries()].map(([uid, row]) => {
    const u = users.get(uid) || {};
    return {
      userId: uid, name: u.name || ('User ' + uid), title: u.title || '',
      archived: !!u.archived, weekHours: row.weekHours, total: +(row.total.toFixed(2)),
    };
  }).filter((p) => !p.archived && !EXCLUDE_NAMES.has(normName(p.name)))
    .sort((a, b) => b.total - a.total);
  return {
    groupBy: gb, rangeStart: startISO, rangeEnd: endISO,
    weeks: periods.map((p) => p.key), periods, byPerson,
  };
}

// Convenience: the last `numWeeks` Monday–Sunday weeks (oldest → newest in the table).
async function weeklyClocked(numWeeks, today) {
  const weeks = recentWeeks(numWeeks || 6, today);
  const oldest = weeks[weeks.length - 1].start;
  const newest = weeks[0].end;
  return clockedRange(oldest, newest, 'week');
}

module.exports = {
  isConfigured, listUsers, listTimeClockIds, clockedSecondsByUser,
  weeklyClocked, clockedRange, periodsFor, recentWeeks, mondayOf, isoDate,
};

/* ---------------- CLI ---------------- */
if (require.main === module) {
  (async () => {
    if (!isConfigured()) { console.log('No Connecteam API key set in connecteam-credentials.json.'); return; }
    try {
      const a = process.argv[2], b = process.argv[3];
      if (a && b) {
        const users = await listUsers();
        const sec = await clockedSecondsByUser(a, b);
        console.log(`Clocked hours ${a} → ${b}:`);
        [...sec.entries()].filter(([, s]) => s > 0).sort((x, y) => y[1] - x[1]).forEach(([uid, s]) => {
          const u = users.get(uid) || {};
          console.log('  ' + ((u.name || uid) + '').padEnd(22) + (s / 3600).toFixed(2).padStart(8) + ' hrs' + (u.title ? '   (' + u.title + ')' : ''));
        });
      } else {
        const r = await weeklyClocked(4);
        console.log('Weeks (Mon):', r.weeks.join('  '));
        r.byPerson.forEach((p) => {
          console.log('  ' + p.name.padEnd(22) + r.weeks.map((w) => (p.weekHours[w] != null ? p.weekHours[w].toFixed(1) : '—').padStart(7)).join('') + '   total ' + p.total.toFixed(1));
        });
      }
    } catch (e) { console.log('ERROR: ' + e.message); }
  })();
}

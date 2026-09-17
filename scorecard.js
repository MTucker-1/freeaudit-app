/*
 * scorecard.js — a week-by-week record of who is missing what.
 *
 * The audit already knows which person a finding belongs to; what it never did
 * was REMEMBER. Each run appends a compact record here, so the scorecard can
 * answer "who are the repeat offenders" and "what does this person keep
 * missing" across weeks rather than only for the run you just did.
 *
 * Raw per-run records are stored (not pre-aggregated totals) so the way we slice
 * them can change later without losing history.
 */
const fs = require('fs');
const { dataPath } = require('./paths');

const HISTORY = dataPath('scorecard-history.json');
const MAX_RUNS = 400; // roughly a couple of years of daily audits

/** Monday of the week containing a date, as YYYY-MM-DD. Weeks run Mon–Sun. */
function weekOf(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
}

function readHistory() {
  try {
    if (!fs.existsSync(HISTORY)) return { runs: [] };
    const d = JSON.parse(fs.readFileSync(HISTORY, 'utf8'));
    return { runs: Array.isArray(d.runs) ? d.runs : [] };
  } catch (e) {
    return { runs: [] }; // a corrupt history must never break an audit
  }
}

/**
 * Who does this finding belong to? The finding's own technician when it has one
 * (photos, parts, hours are the tech's), otherwise whoever wrote the order —
 * order-level checks like the PO or the tracker are theirs.
 */
function personFor(order, finding) {
  return finding.technician
    || order.serviceWriter
    || (order.technicians && order.technicians[0])
    || 'Unassigned';
}

/**
 * recordRun — append one audit to the history. Safe to call on every run;
 * failures are swallowed so a scorecard problem can never cost you a report.
 */
function recordRun(results, when = new Date(), kind = 'audit') {
  try {
    const people = {};
    const bump = (name, key) => {
      const p = (people[name] = people[name] || { orders: 0, findings: {} });
      if (key) p.findings[key] = (p.findings[key] || 0) + 1;
    };

    results.forEach((o) => {
      // "Submitted" an order = wrote it. That is the roster we want.
      const owner = o.serviceWriter || (o.technicians && o.technicians[0]) || 'Unassigned';
      const p = (people[owner] = people[owner] || { orders: 0, findings: {} });
      p.orders += 1;
      (o.findings || []).forEach((f) => bump(personFor(o, f), f.check));
    });

    const h = readHistory();
    h.runs.push({
      at: when.toISOString(),
      week: weekOf(when),
      // 'audit' = Ready to Invoice, 'open' = the Open-SO pass. Recorded so the
      // Impact timeline can total them separately; older entries have no kind
      // and are read as Ready-to-Invoice, which is all that used to be recorded.
      kind,
      orders: results.length,
      // WHICH orders, not just how many. The same SO stays in Ready to Invoice
      // across several audits, so totalling `orders` counted it once per run —
      // the timeline needs to count each service order once.
      sos: [...new Set(results.map((r) => String(r.soNumber || '').trim()).filter(Boolean))],
      flagged: results.filter((r) => (r.findings || []).length).length,
      people,
    });
    if (h.runs.length > MAX_RUNS) h.runs = h.runs.slice(-MAX_RUNS);
    fs.writeFileSync(HISTORY, JSON.stringify(h, null, 2), 'utf8');
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * aggregate — roll the history up for the UI.
 *
 * opts.weeks limits how far back to look (default 8). Returns the roster with
 * per-person totals, the per-check offender lists, and a per-week series so
 * trends are visible.
 */
function aggregate(opts = {}) {
  const weeks = Math.max(1, opts.weeks || 8);
  const h = readHistory();
  if (!h.runs.length) return { weeks: [], roster: [], byCheck: {}, runs: 0, lastRun: null };

  const allWeeks = [...new Set(h.runs.map((r) => r.week))].sort().reverse().slice(0, weeks);
  const keep = new Set(allWeeks);
  const runs = h.runs.filter((r) => keep.has(r.week));

  // name -> { orders, findings{}, weeks{week: {orders, findings{}}} }
  const people = {};
  runs.forEach((run) => {
    Object.entries(run.people || {}).forEach(([name, p]) => {
      const rec = (people[name] = people[name] || { orders: 0, findings: {}, weeks: {} });
      rec.orders += p.orders || 0;
      const w = (rec.weeks[run.week] = rec.weeks[run.week] || { orders: 0, findings: {} });
      w.orders += p.orders || 0;
      Object.entries(p.findings || {}).forEach(([k, n]) => {
        rec.findings[k] = (rec.findings[k] || 0) + n;
        w.findings[k] = (w.findings[k] || 0) + n;
      });
    });
  });

  const roster = Object.entries(people).map(([name, p]) => {
    const total = Object.values(p.findings).reduce((a, b) => a + b, 0);
    return {
      name,
      orders: p.orders,
      findings: total,
      // Findings per order is the fair comparison — someone who writes 30 orders
      // will out-total someone who writes 3 without being any worse at it.
      perOrder: p.orders ? Math.round((total / p.orders) * 100) / 100 : 0,
      byCheck: p.findings,
      weeks: p.weeks,
    };
  }).sort((a, b) => b.perOrder - a.perOrder || b.findings - a.findings);

  // Per check: who accounts for it most often.
  const byCheck = {};
  roster.forEach((p) => {
    Object.entries(p.byCheck).forEach(([k, n]) => {
      (byCheck[k] = byCheck[k] || []).push({ name: p.name, count: n });
    });
  });
  Object.values(byCheck).forEach((l) => l.sort((a, b) => b.count - a.count));

  return {
    weeks: allWeeks.sort(),
    roster,
    byCheck,
    runs: runs.length,
    lastRun: h.runs[h.runs.length - 1] ? h.runs[h.runs.length - 1].at : null,
  };
}

/* ---------------------------------------------------------------------------
 * timeline(period) — how many service orders were audited, bucketed by date.
 *
 * Reads the same history the scorecard keeps, so nothing new has to be stored
 * and every run already recorded counts. Ready-to-Invoice and Open-SO totals
 * are kept apart because they answer different questions.
 * ------------------------------------------------------------------------- */
const PERIODS = ['day', 'week', 'month', 'quarter', 'year'];

/** Bucket key + a label a person can read, for one date. */
function bucketOf(d, period) {
  const y = d.getFullYear();
  const mo = d.getMonth();
  const pad = (n) => String(n).padStart(2, '0');
  if (period === 'day') {
    return { key: `${y}-${pad(mo + 1)}-${pad(d.getDate())}`,
      label: d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) };
  }
  if (period === 'week') {
    const wk = weekOf(d);
    return { key: wk, label: 'wk of ' + new Date(wk + 'T00:00:00').toLocaleDateString([], { month: 'short', day: 'numeric' }) };
  }
  if (period === 'month') {
    return { key: `${y}-${pad(mo + 1)}`, label: d.toLocaleDateString([], { month: 'long', year: 'numeric' }) };
  }
  if (period === 'quarter') {
    const q = Math.floor(mo / 3) + 1;
    return { key: `${y}-Q${q}`, label: `Q${q} ${y}` };
  }
  return { key: String(y), label: String(y) };
}

function timeline(period = 'month', limit = 24) {
  const p = PERIODS.includes(period) ? period : 'month';
  const h = readHistory();
  const buckets = new Map();

  // Distinct service orders, per bucket and overall. An order re-audited in two
  // different months counts in each of those months (it WAS audited in each) but
  // only once in the all-time figure.
  const allReady = new Set();
  const allOpen = new Set();
  let legacyRuns = 0;

  for (const run of (h.runs || [])) {
    const d = new Date(run.at);
    if (isNaN(d)) continue;
    const { key, label } = bucketOf(d, p);
    let b = buckets.get(key);
    if (!b) {
      b = { key, label, ready: 0, open: 0, runs: 0, flagged: 0, passes: 0, estimated: false,
        _ready: new Set(), _open: new Set() };
      buckets.set(key, b);
    }
    const isOpen = run.kind === 'open';   // no kind = Ready to Invoice, all that used to be recorded
    b.runs += 1;
    b.passes += run.orders || 0;
    b.flagged += run.flagged || 0;

    if (Array.isArray(run.sos) && run.sos.length) {
      for (const so of run.sos) { (isOpen ? b._open : b._ready).add(so); (isOpen ? allOpen : allReady).add(so); }
    } else {
      // Recorded before SO numbers were kept — the only figure available is the
      // run total, which double-counts anything re-audited. Marked so the UI can
      // say so rather than present it as a clean count.
      b.estimated = true;
      legacyRuns += 1;
      if (isOpen) b.open += run.orders || 0; else b.ready += run.orders || 0;
    }
  }

  const rows = [...buckets.values()]
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((b) => {
      const r = { ...b, ready: b.ready + b._ready.size, open: b.open + b._open.size };
      delete r._ready; delete r._open;
      return r;
    });

  const recent = rows.slice(-limit);
  const sum = (list) => list.reduce((t, r) => ({
    ready: t.ready + r.ready, open: t.open + r.open, runs: t.runs + r.runs,
    flagged: t.flagged + r.flagged, passes: t.passes + r.passes,
  }), { ready: 0, open: 0, runs: 0, flagged: 0, passes: 0 });

  const totals = sum(recent);
  // All-time counts each SO once across the whole history, so it is not simply
  // the sum of the buckets.
  const legacyAll = rows.reduce((t, r) => ({ ready: t.ready + (r.estimated ? r.ready : 0), open: t.open + (r.estimated ? r.open : 0) }), { ready: 0, open: 0 });
  const allTime = {
    ready: allReady.size + legacyAll.ready,
    open: allOpen.size + legacyAll.open,
    runs: rows.reduce((n, r) => n + r.runs, 0),
    flagged: rows.reduce((n, r) => n + r.flagged, 0),
    passes: rows.reduce((n, r) => n + r.passes, 0),
  };

  return {
    period: p, rows: recent, totals, allTime,
    estimatedRuns: legacyRuns,   // runs with no SO list — counted as run totals
    since: (h.runs && h.runs[0]) ? h.runs[0].at : null,
  };
}

module.exports = { recordRun, aggregate, timeline, weekOf, readHistory, HISTORY, PERIODS };

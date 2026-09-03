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
function recordRun(results, when = new Date()) {
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
      orders: results.length,
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

module.exports = { recordRun, aggregate, weekOf, readHistory, HISTORY };

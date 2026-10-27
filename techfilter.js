/*
 * techfilter.js — "which techs is this run for?"
 *
 * Several people run FreeAudit against the same Fullbay account. Without a
 * filter, two of them auditing (or worse, running Fix Addresses) at once work
 * through each other's orders. Each copy saves its own choice in config.json:
 *
 *   techFilter: { all: true }                         every order (the default)
 *   techFilter: { all: false, names: ['Saul Soto'] }  only these techs' orders
 *
 * "all" is deliberately separate from ticking every name: it also covers a tech
 * who joins later, where a list of names would silently leave them out.
 *
 * At this shop the service writer IS the tech (true on every Ready-to-Invoice
 * order checked), and Fullbay's lists carry the writer, so matching happens on
 * the list — orders outside the selection are never even opened.
 *
 * Pure logic plus one small file (techs.json: every name seen in Fullbay's
 * lists), so the picker has names to offer before anyone has run anything.
 */
const fs = require('fs');
const { dataPath } = require('./paths');

const norm = (s) => String(s == null ? '' : s).replace(/[​-‍﻿­]/g, '')
  .replace(/\s+/g, ' ').trim();
const key = (s) => norm(s).toLowerCase();
/** A real person, not Fullbay's placeholder for nobody. */
const isPerson = (s) => { const k = key(s); return !!k && !/^\[?\s*(unassigned|none|n\/a)\s*\]?$/.test(k); };

/** null = every order; else { names, keys:Set }. */
function scope(cfg) {
  const tf = cfg && cfg.techFilter;
  if (!tf || tf.all !== false) return null;
  const names = [...new Set((tf.names || []).map(norm).filter(isPerson))];
  return { names, keys: new Set(names.map(key)) };
}

/** Is an order with these people on it inside the scope? */
function matches(sc, people) {
  if (!sc) return true;
  return (people || []).some((p) => sc.keys.has(key(p)));
}

/** For reports and logs. */
function label(sc) {
  if (!sc) return 'All techs';
  if (!sc.names.length) return 'No techs selected';
  return sc.names.join(', ');
}

const FILE = () => dataPath('techs.json');

function readSeen() {
  try { return JSON.parse(fs.readFileSync(FILE(), 'utf8')); } catch (e) { return { names: [], updatedAt: null }; }
}

/** Add names seen in Fullbay's lists. Never throws: a picker list must not cost a run. */
function remember(names) {
  try {
    const cur = readSeen();
    const byKey = new Map((cur.names || []).map((n) => [key(n), norm(n)]));
    (names || []).filter(isPerson).forEach((n) => { if (!byKey.has(key(n))) byKey.set(key(n), norm(n)); });
    const out = [...byKey.values()].sort((a, b) => a.localeCompare(b));
    fs.writeFileSync(FILE(), JSON.stringify({ names: out, updatedAt: new Date().toISOString() }, null, 2), 'utf8');
    return out;
  } catch (e) { return null; }
}

/** Every tech this copy knows of: techs.json, plus the last reports for copies
 * that ran before techs.json existed. */
function known() {
  const names = [...(readSeen().names || [])];
  const fromFile = (f, pick) => {
    try { pick(JSON.parse(fs.readFileSync(dataPath(f), 'utf8'))).forEach((n) => names.push(n)); } catch (e) { /* no report yet */ }
  };
  fromFile('audit-results.json', (d) => (d.orders || []).flatMap((o) => [o.serviceWriter, ...(o.technicians || [])]));
  fromFile('open-sos.json', (d) => (d.orders || []).flatMap((o) => [o.serviceWriter, o.leadTech, o.assignedTech]));
  const byKey = new Map();
  names.filter(isPerson).forEach((n) => { if (!byKey.has(key(n))) byKey.set(key(n), norm(n)); });
  return { names: [...byKey.values()].sort((a, b) => a.localeCompare(b)), updatedAt: readSeen().updatedAt };
}

/** Validate what the picker sends. Returns { ok, value?, error? }. */
function normalise(input) {
  if (!input || input.all !== false) return { ok: true, value: { all: true, names: [] } };
  const names = [...new Set((input.names || []).map(norm).filter(isPerson))];
  if (!names.length) return { ok: false, error: 'Pick at least one tech, or Select all.' };
  return { ok: true, value: { all: false, names } };
}

module.exports = { scope, matches, label, remember, known, normalise, isPerson };

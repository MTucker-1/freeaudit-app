/*
 * taxmap.js — resolves "where is this technician working?" into the facility
 * address and Fullbay tax location that an estimate should carry.
 *
 * Pure logic over tax-locations.json. No browser, no network, so it can be
 * tested offline — which matters, because a wrong answer here would put the
 * wrong address and the wrong sales tax on a real invoice.
 *
 * Deliberately conservative: anything it cannot resolve unambiguously comes back
 * as { ok:false, reason }, never a guess. Tax Exempt is never auto-resolved (it
 * applies only to XTRA or Portland, OR, which this data cannot distinguish).
 */
const fs = require('fs');
const { dataPath } = require('./paths');

let cache = null;
function data() {
  if (cache) return cache;
  const p = dataPath('tax-locations.json');
  if (!fs.existsSync(p)) throw new Error('tax-locations.json not found in the data folder');
  const d = JSON.parse(fs.readFileSync(p, 'utf8'));
  cache = {
    addresses: d.addresses || [],
    defaults: d.defaults || {},
    manualOnly: d.manualOnly || {},
  };
  return cache;
}

const norm = (s) => String(s == null ? '' : s).replace(/[​-‍﻿­]/g, '')
  .replace(/\s+/g, ' ').trim().toLowerCase();

/** Is this tax location one we must never resolve automatically? */
function isManualOnly(taxLocation) {
  return Object.keys(data().manualOnly).some((k) => norm(k) === norm(taxLocation));
}

/**
 * Narrow a candidate list to one address.
 *  - drop manual-only tax locations (Tax Exempt) from automatic resolution
 *  - then apply the configured default for that tax location
 */
function narrow(cands) {
  const auto = cands.filter((a) => !isManualOnly(a.taxLocation));
  if (auto.length === 1) return { ok: true, address: auto[0] };
  if (auto.length === 0) {
    return { ok: false, reason: 'only a manual-only tax location matches (e.g. Tax Exempt) — needs a human' };
  }
  // Several remain: a configured default settles it, but only if they agree on
  // the tax location. Differing tax locations is a genuine ambiguity.
  const taxes = [...new Set(auto.map((a) => a.taxLocation))];
  if (taxes.length === 1) {
    const pick = data().defaults[taxes[0]];
    const hit = auto.find((a) => norm(a.name) === norm(pick));
    if (hit) return { ok: true, address: hit, viaDefault: true };
    return { ok: false, reason: `${auto.length} addresses share tax location "${taxes[0]}" and no default is configured` };
  }
  return { ok: false, reason: `ambiguous across tax locations: ${taxes.join(', ')}` };
}

/**
 * resolve(hint) — hint may be a facility name ("Barrington, NJ"), a two-letter
 * state ("NJ"), or a Fullbay tax-location name ("New Jersey").
 * Returns { ok, address?, viaDefault?, reason? }.
 */
function resolve(hint) {
  const h = norm(hint);
  if (!h) return { ok: false, reason: 'no location hint given' };
  const { addresses } = data();

  const byName = addresses.filter((a) => norm(a.name) === h);
  if (byName.length) return narrow(byName);

  if (/^[a-z]{2}$/.test(h)) {
    const byState = addresses.filter((a) => norm(a.state) === h);
    if (byState.length) return narrow(byState);
    return { ok: false, reason: `no facility in state "${hint}"` };
  }

  const byTax = addresses.filter((a) => norm(a.taxLocation) === h);
  if (byTax.length) return narrow(byTax);

  const byCity = addresses.filter((a) => norm(a.city) === h);
  if (byCity.length) return narrow(byCity);

  return { ok: false, reason: `"${hint}" matched no facility, state, city, or tax location` };
}

/** Does a Fullbay display address plausibly refer to this facility? */
function displayMatches(display, address) {
  const d = norm(display);
  if (!d || d === 'select address') return false;
  const street = norm(address.street);
  // Fullbay renders e.g. "Denver, CO, 1515 Wazee Street, Denver, CO 80202, US"
  return (!!street && d.includes(street))
    || (d.includes(norm(address.city)) && d.includes(norm(address.zip)));
}

/**
 * checkEstimate(current, hint) — compare what the estimate carries against what
 * the technician's location says it should be.
 *
 * current: { billToDisplay, shipToDisplay, taxLocationId }
 * Returns { ok, expected?, problems:[...], reason? }
 */
function checkEstimate(current, hint) {
  const r = resolve(hint);
  if (!r.ok) return { ok: false, problems: [], reason: r.reason };
  return checkAgainst(current, r.address, !!r.viaDefault);
}

/** Same comparison against an address found some other way (Fullbay's own
 * address book, for a facility tax-locations.json doesn't list yet). */
function checkAgainst(current, want, viaDefault = false) {
  const problems = [];

  if (!displayMatches(current.billToDisplay, want)) {
    problems.push({
      field: 'billTo',
      is: current.billToDisplay || '(unset)',
      shouldBe: `${want.name} — ${want.street}, ${want.city}, ${want.state} ${want.zip}`,
    });
  }
  if (!displayMatches(current.shipToDisplay, want)) {
    problems.push({
      field: 'shipTo',
      is: current.shipToDisplay || '(unset)',
      shouldBe: `${want.name} — ${want.street}, ${want.city}, ${want.state} ${want.zip}`,
    });
  }
  // The TAX LOCATION is not changed — only the Bill To and Ship To addresses are.
  // It is still reported as context, so a reviewer can see whether Fullbay's own
  // tax location agrees with the facility the addresses now point at.
  // An unknown expected id (a facility added before its id was captured) can't
  // agree or disagree, so it is reported as unknown rather than as a mismatch.
  const known = !!want.taxLocationId;
  return {
    ok: true,
    expected: want,
    viaDefault,
    problems,
    taxLocation: {
      current: current.taxLocationId || '(unset)',
      expected: known ? `${want.taxLocation} (${want.taxLocationId})` : `${want.taxLocation || 'unknown'} (id not captured)`,
      agrees: known ? String(current.taxLocationId || '') === String(want.taxLocationId) : null,
    },
  };
}

/** "2822 Glenfield Avenue, Dallas, TX 75233, US" -> { street, city, state, zip }. */
function parseDisplayAddress(text) {
  const m = String(text || '').replace(/\s+/g, ' ').trim()
    .match(/^(.*?),\s*([^,]+?),\s*([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)(?:\s*,\s*[A-Za-z]{2,3})?$/);
  return m ? { street: m[1].trim(), city: m[2].trim(), state: m[3].toUpperCase(), zip: m[4] } : null;
}

/**
 * Pick the facility for a state out of Fullbay's address-book rows
 * ([{ title, address }]). Exactly one title ending ", <ST>" is the answer; none
 * or several is left for a human, like every other ambiguity here.
 */
function facilityFromRows(rows, abbr) {
  const st = String(abbr || '').toUpperCase();
  const re = new RegExp(',\\s*' + st + '$', 'i');
  const hits = (rows || []).filter((r) => re.test(norm(r.title)));
  if (!hits.length) return { ok: false, reason: `no facility in state "${st}" in tax-locations.json or in Fullbay's address book` };
  if (hits.length > 1) return { ok: false, reason: `${hits.length} facilities in ${st} in Fullbay's address book (${hits.map((h) => h.title).join(', ')}) — needs a human` };
  const parsed = parseDisplayAddress(hits[0].address);
  if (!parsed) return { ok: false, reason: `could not read the address of "${hits[0].title}": ${hits[0].address}` };
  return { ok: true, address: { name: hits[0].title, ...parsed, taxLocation: '', taxLocationId: '' } };
}

/** null when the facility list is loaded, else why not. */
function unavailable() {
  try { return data().addresses.length ? null : 'tax-locations.json has no addresses'; } catch (e) { return e.message; }
}

module.exports = { resolve, checkEstimate, checkAgainst, displayMatches, isManualOnly, unavailable, parseDisplayAddress, facilityFromRows };

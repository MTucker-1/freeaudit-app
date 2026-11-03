/*
 * registry.js — the team-wide record of who has signed up for FreeAudit.
 *
 * The problem it solves: every install keeps its OWN users.json, so an account
 * created on one PC is invisible everywhere else. "Active Users" could only ever
 * show the accounts on the machine you happened to be sitting at, which made it
 * impossible to answer "who has the signup code and has actually used this?"
 *
 * The shared surface is a Google Sheet named EXACTLY "FreeAudit Users", shared
 * as Editor with the service account. Every install finds it by name through the
 * same Drive listing the tracker check already uses, so nothing has to be
 * configured per machine — create the sheet, share it, and every copy of
 * FreeAudit starts reporting to it on its next launch.
 *
 * It is an append-only LOG, not a table that gets edited: one row per signup and
 * per sign-in. That answers "who has ever signed in" (the question asked) rather
 * than merely "who exists now", and append is the one write that cannot corrupt
 * what is already there. roster() folds the log into one entry per person.
 *
 * Every call here is best-effort. Signing in must never fail, hang, or leak an
 * error because Google was slow or the sheet has not been made yet.
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
const gsheets = require('./gsheets');

const ROSTER_NAME = 'FreeAudit Users';
const TAB = 'Sign-ins';
const HEADER = ['When', 'Event', 'Name', 'Email', 'Computer', 'Version'];
// Network calls get a hard ceiling: a sign-in waits for nobody.
const TIMEOUT_MS = 8000;

let idCache = { id: null, at: 0 };
const ID_TTL_MS = 10 * 60 * 1000;

const withTimeout = (p, ms) => Promise.race([
  p,
  new Promise((_, rej) => setTimeout(() => rej(new Error('timed out')), ms)),
]);

function appVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'version.json'), 'utf8')
      .replace(/^﻿/, '')).version || '';
  } catch (e) { return ''; }
}

/** The roster sheet's id, found by name. Cached — this costs a Drive listing. */
async function rosterId() {
  if (idCache.id && Date.now() - idCache.at < ID_TTL_MS) return idCache.id;
  if (!gsheets.serviceAccount()) return null;
  const files = await gsheets.listSpreadsheets();
  const hit = files.find((f) => String(f.name || '').trim().toLowerCase() === ROSTER_NAME.toLowerCase());
  idCache = { id: hit ? hit.id : null, at: Date.now() };
  return idCache.id;
}

/*
 * Which tab to write to. "Sign-ins" if it exists, otherwise whatever the first
 * tab is called.
 *
 * Why not just require the name: a brand-new Google Sheet's first tab is called
 * "Sheet1", and appending to a range that does not exist fails outright. That
 * would have made "rename the tab" a silent prerequisite — the sheet would look
 * correctly shared and simply never collect anybody.
 */
async function writableTab(id) {
  try {
    const { tabs } = await gsheets.listTabs(id);
    const exact = (tabs || []).find((t) => String(t).trim().toLowerCase() === TAB.toLowerCase());
    return exact || (tabs || [])[0] || TAB;
  } catch (e) { return TAB; }
}

/**
 * Record one event ('signed up' | 'signed in'). Never throws and never blocks
 * the caller: returns a reason string instead, for logging only.
 */
async function record(event, user) {
  try {
    const id = await withTimeout(rosterId(), TIMEOUT_MS);
    if (!id) return 'no "' + ROSTER_NAME + '" sheet shared with the service account';
    const tab = await withTimeout(writableTab(id), TIMEOUT_MS);
    // Put a header on a sheet that has never been written to, so the columns
    // mean something to whoever opens it rather than being six bare values.
    try {
      const existing = await withTimeout(gsheets.getTabValues(id, tab), TIMEOUT_MS);
      if (!existing.length) await withTimeout(gsheets.appendRow(id, tab, HEADER), TIMEOUT_MS);
    } catch (e) { /* a header is a nicety; never let it stop the record itself */ }
    await withTimeout(gsheets.appendRow(id, tab, [
      new Date().toISOString(), event, user.name || '', user.email || '', os.hostname(), appVersion(),
    ]), TIMEOUT_MS);
    return '';
  } catch (e) { return e.message; }
}

/**
 * Everyone who has ever signed up or signed in, folded to one entry each.
 * Returns { ok, rows, error } — never throws.
 */
async function roster() {
  try {
    const id = await withTimeout(rosterId(), TIMEOUT_MS);
    if (!id) return { ok: false, rows: [], error: 'no "' + ROSTER_NAME + '" sheet shared with the service account' };
    // Read the SAME tab record() writes to, or the two could silently diverge.
    const want = await withTimeout(writableTab(id), TIMEOUT_MS);
    const sheet = await withTimeout(gsheets.readSpreadsheet(
      'https://docs.google.com/spreadsheets/d/' + id + '/edit',
      (name) => String(name) === want,
    ), TIMEOUT_MS);
    const tab = (sheet.tabs || [])[0];
    if (!tab) return { ok: false, rows: [], error: 'the roster sheet has no readable tab' };

    const by = new Map();
    for (const row of tab.rows) {
      const [when, event, name, email] = row;
      const key = String(email || '').trim().toLowerCase();
      // Skip the header and any row without an email to key on.
      if (!key || key === 'email' || !/@/.test(key)) continue;
      const computer = row[4] || '';
      const cur = by.get(key) || { name: '', email: key, firstSeen: '', lastSeen: '', computers: [], signIns: 0 };
      if (name) cur.name = name;
      if (when && (!cur.firstSeen || when < cur.firstSeen)) cur.firstSeen = when;
      if (when && when > cur.lastSeen) cur.lastSeen = when;
      if (computer && !cur.computers.includes(computer)) cur.computers.push(computer);
      if (String(event || '').toLowerCase().indexOf('signed in') >= 0) cur.signIns++;
      by.set(key, cur);
    }
    const rows = [...by.values()].sort((a, b) => String(b.lastSeen).localeCompare(String(a.lastSeen)));
    return { ok: true, rows, error: '' };
  } catch (e) { return { ok: false, rows: [], error: e.message }; }
}

module.exports = { record, roster, ROSTER_NAME, TAB, HEADER };

/*
 * runlock.js — one audit at a time on this machine.
 *
 * Two different processes can start an audit: the web app (someone pressing Run
 * Audit) and the portal agent (a run queued from the FLSS dashboard). Neither
 * could see the other, and both drive the same Chromium profile — so a second
 * audit gets "Opening in existing browser session", a dead about:blank window,
 * and silently does nothing.
 *
 * A small lock file both sides check fixes that. It records WHO holds it and
 * HOW it was started, so the UI can say "the portal is running an audit" rather
 * than just refusing.
 *
 * A crashed run leaves a stale file, so the holder's pid is checked for life
 * before the lock is believed.
 */
const fs = require('fs');
const { dataPath } = require('./paths');

const LOCK = dataPath('audit-run.lock');

function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return false; }
}

/** Who holds the lock right now, or null. Clears the file if it is stale. */
function current() {
  try {
    if (!fs.existsSync(LOCK)) return null;
    const h = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
    if (alive(h.pid)) return h;
    // Holder is gone — a crashed or force-killed run. Take the lock back.
    try { fs.unlinkSync(LOCK); } catch (e) { /* ignore */ }
    return null;
  } catch (e) {
    return null; // an unreadable lock must never block a run forever
  }
}

/**
 * acquire({ by, kind, pid }) -> { ok: true } | { ok: false, holder }
 * `by`   who asked for it ("Mitchell Tucker", "FLSS portal")
 * `kind` what it is ("audit", "open", "fixaddresses")
 */
function acquire({ by = 'someone', kind = 'audit', pid = process.pid } = {}) {
  const holder = current();
  if (holder) return { ok: false, holder };
  try {
    fs.writeFileSync(LOCK, JSON.stringify({ pid, by, kind, startedAt: new Date().toISOString() }), 'utf8');
    return { ok: true };
  } catch (e) {
    // If the lock cannot be written, run anyway rather than block real work.
    return { ok: true, unlocked: true };
  }
}

/** Release, but only if this process still owns it. */
function release(pid = process.pid) {
  try {
    if (!fs.existsSync(LOCK)) return;
    const h = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
    if (h.pid === pid) fs.unlinkSync(LOCK);
  } catch (e) { /* ignore */ }
}

/** Human-readable summary for the UI. */
function describe(h) {
  if (!h) return '';
  const mins = Math.max(0, Math.round((Date.now() - new Date(h.startedAt).getTime()) / 60000));
  const what = h.kind === 'open' ? 'an open-SO audit'
    : h.kind === 'fixaddresses' ? 'an address fix'
      : 'an audit';
  return `${h.by} is already running ${what} on this computer (started ${mins} min ago).`;
}

module.exports = { acquire, release, current, describe, LOCK };

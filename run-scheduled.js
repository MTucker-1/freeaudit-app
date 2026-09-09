/*
 * run-scheduled.js — the entry point Windows Task Scheduler calls.
 *
 * Why this exists rather than pointing a scheduled task straight at audit.js:
 * audit.js does not take the machine-wide run lock. Three different things can
 * start an audit on this PC — someone pressing Run Audit, a job queued from the
 * FLSS portal, and now the clock — and all three drive the SAME Chromium
 * profile. A second one launched on top of a running audit gets "Opening in
 * existing browser session", a dead about:blank window, and silently does
 * nothing. So a scheduled run has to check the lock like the other two do, and
 * step aside when the machine is already busy.
 *
 * Skipping is the correct outcome, not an error: an 8:00 audit that is still
 * going at 12:00 means the 12:00 run has nothing to add. Exit 0 so Task
 * Scheduler's history reads "ran, nothing to do" rather than showing a failure.
 *
 * Usage:  node run-scheduled.js [audit|open|both|fixaddresses]
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const runlock = require('./runlock');
const { dataPath } = require('./paths');

// fixaddresses is the only one that WRITES to Fullbay; the rest are read-only.
const KINDS = { audit: [], open: ['open'], both: null, fixaddresses: ['fixaddresses'] }; // both = audit then open
const kind = (process.argv[2] || 'audit').toLowerCase();
const LOG = dataPath('schedule-log.txt');

function log(line) {
  const stamp = new Date().toLocaleString();
  const msg = `[${stamp}] ${line}`;
  console.log(msg);
  // Keep a short local history so a missed overnight run can be explained
  // without anyone having to dig through Task Scheduler.
  try {
    let prev = '';
    try { prev = fs.readFileSync(LOG, 'utf8'); } catch (e) { /* first run */ }
    const lines = (prev + msg + '\n').split('\n').slice(-400);
    fs.writeFileSync(LOG, lines.join('\n'), 'utf8');
  } catch (e) { /* logging must never break the run */ }
}

/** Run one audit pass to completion. Resolves with the exit code. */
function runPass(args, label) {
  return new Promise((resolve) => {
    log(`Starting ${label}…`);
    const child = spawn(process.execPath, [path.join(__dirname, 'audit.js'), ...args], {
      cwd: dataPath('.'),
      env: { ...process.env, FREEAUDIT_DATA_DIR: dataPath('.') },
    });
    const lockKind = args[0] === 'open' ? 'open' : args[0] === 'fixaddresses' ? 'fixaddresses' : 'audit';
    const got = runlock.acquire({ by: 'Scheduled run', kind: lockKind, pid: child.pid });
    if (!got.ok) {
      // Lost a race with a run that started in the last moment.
      child.kill();
      log(`Skipped ${label} — ${runlock.describe(got.holder)}`);
      return resolve(null);
    }
    child.stdout.on('data', (d) => process.stdout.write(d));
    child.stderr.on('data', (d) => process.stderr.write(d));
    child.on('close', (code) => {
      runlock.release(child.pid);
      log(`${label} finished (exit ${code}).`);
      resolve(code);
    });
  });
}

(async () => {
  if (!(kind in KINDS)) {
    log(`Unknown run type "${kind}" — expected audit, open, both or fixaddresses. Nothing run.`);
    process.exit(0); // a bad argument must not look like a failed audit
  }

  // Check BEFORE launching anything, so the common "already busy" case costs
  // nothing and leaves no half-started browser behind.
  const holder = runlock.current();
  if (holder) {
    log(`Skipped — ${runlock.describe(holder)}`);
    process.exit(0);
  }

  if (kind === 'both') {
    await runPass([], 'Ready-to-Invoice audit');
    await runPass(['open'], 'Open-SO audit');
  } else {
    const label = kind === 'open' ? 'Open-SO audit'
      : kind === 'fixaddresses' ? 'estimate address fix'
        : 'Ready-to-Invoice audit';
    await runPass(KINDS[kind], label);
  }
  process.exit(0);
})();

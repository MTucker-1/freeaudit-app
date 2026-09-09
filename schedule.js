/*
 * schedule.js — the automatic-run schedule ("audit at 8:00, 12:00 and 15:00").
 *
 * The schedule is stored in config.json so it travels with the rest of the
 * settings, and is turned into real Windows scheduled tasks by
 * installer/sync-schedule.ps1. Nothing here fires an audit itself: a timer in
 * this process would only run while the app is open, and could not wake a
 * sleeping PC. Windows does both.
 *
 * Times are plain local time ("08:00") and Task Scheduler follows the PC's own
 * clock, so a schedule set in Central Time stays correct across the DST change
 * without anything here knowing about time zones.
 */
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { readConfig, writeConfig } = require('./settings');
const { dataPath } = require('./paths');

const KINDS = ['audit', 'open', 'both', 'fixaddresses'];
const MAX_RUNS = 12; // more than a dozen a day is a mistake, not a schedule

const DEFAULT = { enabled: false, wake: true, runs: [] };

function read() {
  const s = readConfig().schedule;
  if (!s || typeof s !== 'object') return { ...DEFAULT };
  return {
    enabled: !!s.enabled,
    wake: s.wake !== false,
    runs: Array.isArray(s.runs) ? s.runs : [],
  };
}

/** Reject anything Windows would choke on, and sort so the UI reads in order. */
function normalise(input) {
  const errors = [];
  const seen = new Set();
  const runs = [];

  for (const raw of (Array.isArray(input.runs) ? input.runs : []).slice(0, MAX_RUNS)) {
    const time = String((raw && raw.time) || '').trim();
    if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(time)) { errors.push(`"${time || '(blank)'}" is not a valid time — use 24-hour HH:MM, e.g. 08:00 or 15:30.`); continue; }
    if (seen.has(time)) { errors.push(`${time} is listed twice.`); continue; }
    seen.add(time);
    const kind = KINDS.includes(raw && raw.kind) ? raw.kind : 'audit';
    runs.push({ time, kind });
  }
  runs.sort((a, b) => a.time.localeCompare(b.time));

  return { value: { enabled: !!input.enabled, wake: input.wake !== false, runs }, errors };
}

/**
 * Push the saved schedule into Windows Task Scheduler.
 * Resolves { ok, output } — never rejects, because a failed sync must not lose
 * the settings the user just saved.
 */
function sync() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      return resolve({ ok: false, output: 'Scheduled runs need Windows Task Scheduler; this machine is ' + process.platform + '.' });
    }
    // The script ships in installer\ beside the app, but a dev checkout runs
    // from the repo root — look in both.
    const candidates = [
      path.join(__dirname, 'sync-schedule.ps1'),
      path.join(__dirname, 'installer', 'sync-schedule.ps1'),
    ];
    const script = candidates.find((p) => fs.existsSync(p));
    if (!script) return resolve({ ok: false, output: 'sync-schedule.ps1 not found.' });

    execFile('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-DataDir', dataPath('.')],
      { timeout: 60000, windowsHide: true },
      (err, stdout, stderr) => {
        const output = ((stdout || '') + (stderr || '')).trim();
        resolve({ ok: !err, output: output || (err ? err.message : 'done') });
      });
  });
}

/** Save + push to Windows in one step. */
async function save(input) {
  const { value, errors } = normalise(input || {});
  if (errors.length) return { ok: false, errors };
  const cfg = readConfig();
  cfg.schedule = value;
  writeConfig(cfg);
  const synced = await sync();
  return { ok: true, schedule: value, synced: synced.ok, output: synced.output };
}

/** What Windows actually has registered — the truth, not what we hope we wrote. */
function installed() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve([]);
    execFile('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
        "Get-ScheduledTask | Where-Object { $_.TaskName -like 'FreeAudit Run*' } | ForEach-Object { $i = $_ | Get-ScheduledTaskInfo; [PSCustomObject]@{ name=$_.TaskName; state=[string]$_.State; next=[string]$i.NextRunTime; last=[string]$i.LastRunTime; result=$i.LastTaskResult } } | ConvertTo-Json -Compress"],
      { timeout: 30000, windowsHide: true },
      (err, stdout) => {
        if (err || !stdout || !stdout.trim()) return resolve([]);
        try {
          const parsed = JSON.parse(stdout.trim());
          resolve(Array.isArray(parsed) ? parsed : [parsed]);
        } catch (e) { resolve([]); }
      });
  });
}

/** Recent scheduled-run history, newest last. */
function history(limit = 40) {
  try {
    return fs.readFileSync(dataPath('schedule-log.txt'), 'utf8')
      .split('\n').filter(Boolean).slice(-limit);
  } catch (e) { return []; }
}

module.exports = { read, save, sync, installed, history, normalise, KINDS, MAX_RUNS };

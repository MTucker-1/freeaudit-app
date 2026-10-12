/*
 * settings.js — one place that knows how to read config.json.
 *
 * Why this exists: every installed copy keeps its OWN config.json (the updater
 * deliberately never overwrites it, so people don't lose their settings). That
 * means a copy installed months ago has whatever keys existed back then. When we
 * ship a new setting, their file simply won't have it.
 *
 * So reads go through DEFAULTS: anything missing falls back to the shipped value
 * instead of coming back undefined. A missing or corrupt config.json degrades to
 * pure defaults rather than crashing the app on startup.
 */
const fs = require('fs');
const { dataPath } = require('./paths');

const CONFIG_PATH = dataPath('config.json');

// Shipped values. Adding a new setting here is all that's needed for existing
// installs to pick it up on their next auto-update.
const DEFAULTS = {
  baseUrl: 'https://app.fullbay.com',
  listUrl: 'https://app.fullbay.com/office/customer/indexNew.html',
  headless: false,
  maxOrders: 0,
  slowDownMs: 400,
  checkDuplicatePhotos: true,
  includeNotes: true,
  imageLimit: 50,
  checkSheetCompletion: true,
  checkVortoResolved: true,
  // Check A: an inspection action item with no photos of its own is not flagged
  // when the SERVICE ORDER itself carries at least this many attachments — the
  // trailer photos are routinely attached at the top of the order rather than
  // inside the inspection item. 1 means "any photos on the order is enough";
  // only an order with nothing attached at all gets flagged. Raise it to require
  // a fuller set.
  inspectionSoPhotoMin: 1,
  // "Run Audit" covers Ready-to-Invoice ONLY. Open orders are a separate action
  // ("Run Open Audit", or `node audit.js open`) so each can be run on its own.
  // Set true to fold the open-SO pass back into every audit.
  auditOpenSos: false,
  // Open-SO section: 0 = every open order, or cap it for a quick pass.
  maxOpenOrders: 0,
  // An open order older than this many days is called out. Three days matches
  // the shop's own sense of "this has been sitting"; 3x that is a blocker.
  openStaleDays: 3,
  // NOTE: the audit never writes to Fullbay. Correcting estimate addresses is a
  // separate action ("Fix Addresses" in the app, or `node audit.js fixaddresses`)
  // so an audit can always be run without changing records.
  manualMinutesPerOrder: 8,
  sheetFile: '',
  sheetYear: '',
  webPort: 4477,
  // Loopback on a desktop install (nothing exposed). A container must listen on
  // 0.0.0.0 or the platform's router can't reach it — see envOverrides().
  bindHost: '127.0.0.1',
  signupCode: 'FLSS2026',
  maxRunMinutes: 30,
  sheets: [],
  // Also read every spreadsheet shared with the service account, not just the
  // links above. Set false to use the configured links only.
  autoDiscoverSheets: true,
  // Automatic runs. Edited in the app (Automatic runs), turned into real
  // Windows scheduled tasks by installer/sync-schedule.ps1 — a timer in this
  // process would only fire while the app is open and could not wake a sleeping
  // PC. Times are 24-hour local time; kind is audit | open | both.
  //   { enabled: true, wake: true, runs: [{ time: '08:00', kind: 'audit' }] }
  schedule: { enabled: false, wake: true, runs: [] },
};

/*
 * Trackers EVERY install reads, whatever its own config.json says.
 *
 * Why these live in code rather than config.json: the updater deliberately never
 * overwrites a person's config.json (so nobody loses their settings), and the
 * installer bakes in a copy of whatever config.json existed when it was built.
 * A sheet added to config.json therefore reaches only NEW installs. Listed here,
 * it goes out to everyone on their next auto-update.
 *
 * These are merged with each person's own links rather than replacing them, so a
 * user can still add trackers of their own; they just cannot drop these.
 */
const SHIPPED_SHEETS = [
  { name: 'Q4 SoCal BITs', url: 'https://docs.google.com/spreadsheets/d/17AbS2SZp0EGdobtvAeHFVx_KwP11tvPQBOgP3FUvAF8/edit' },
  { name: 'Dallas PepsiCo — DOT / FHWA Inspection Project', url: 'https://docs.google.com/spreadsheets/d/1NG232IK7lPyFjTxLPiJCC5Vj6jmzEMWMoR0weEpW0EQ/edit' },
  { name: '2026 Louisville PMs', url: 'https://docs.google.com/spreadsheets/d/1yYUt2ISYFOiX3T0OX2sjdObLWjl3aCq4SDrRDHnKgVE/edit' },
];
const SHIPPED_URLS = SHIPPED_SHEETS.map((s) => s.url);

/* A sheet is identified by its ID, not its URL — the same tracker gets pasted as
 * /edit, /edit?gid=..., /edit#gid=..., so matching on the string would duplicate it. */
const sheetId = (u) => {
  const m = String(u || '').match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : String(u || '').trim();
};

/** The shipped trackers plus this person's own, de-duplicated by sheet ID. */
function mergeSheets(saved) {
  const out = [];
  const seen = new Set();
  [...SHIPPED_URLS, ...(Array.isArray(saved) ? saved : [])].forEach((u) => {
    if (!u || typeof u !== 'string' || !u.trim()) return;
    const id = sheetId(u);
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push(u.trim());
  });
  return out;
}

let warned = false;

/**
 * Read config.json merged over DEFAULTS. Never throws — a missing or unreadable
 * file yields the defaults so the app still starts and the person can fix their
 * settings in the UI.
 */
function readConfig() {
  let saved = {};
  try {
    if (fs.existsSync(CONFIG_PATH)) saved = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) || {};
  } catch (e) {
    if (!warned) {
      warned = true;
      console.error('[settings] config.json could not be read (' + e.message + ') — using defaults. '
        + 'Fix it in Settings and click Save to write a clean file.');
    }
  }
  const cfg = envOverrides({ ...DEFAULTS, ...saved });
  // Spread would let a saved list REPLACE the shipped trackers (and every saved
  // config has one the moment somebody clicks Save in Settings). Union instead.
  cfg.sheets = mergeSheets(saved.sheets);
  return cfg;
}

/*
 * Hosting platforms configure a service through the environment, not a file we
 * ship. These overrides let the same build run as a desktop app and as a
 * container without a second code path.
 *
 *   PORT                 — injected by Render/Railway/Fly/Heroku; must be obeyed
 *                          or the platform cannot route to us.
 *   FREEAUDIT_HEADLESS   — containers have no display, so Chromium must be
 *                          headless. A desktop install keeps this false so a
 *                          person can finish a login by hand.
 *   FREEAUDIT_BIND       — explicit listen address; defaults to 0.0.0.0 whenever
 *                          PORT is set (i.e. we're hosted), else loopback.
 */
function envOverrides(cfg) {
  const port = parseInt(process.env.PORT, 10);
  if (Number.isFinite(port) && port > 0) cfg.webPort = port;

  if (process.env.FREEAUDIT_HEADLESS != null) {
    cfg.headless = /^(1|true|yes|on)$/i.test(process.env.FREEAUDIT_HEADLESS.trim());
  }

  if (process.env.FREEAUDIT_BIND) cfg.bindHost = process.env.FREEAUDIT_BIND.trim();
  else if (Number.isFinite(port) && port > 0) cfg.bindHost = '0.0.0.0';

  return cfg;
}

/** Write config.json (UTF-8, no BOM — Node's JSON.parse chokes on a BOM). */
function writeConfig(cfg) {
  // Never persist the shipped trackers. Callers hand us the config they READ, so
  // the merged-in shipped links would otherwise be written back and frozen into
  // config.json — and since the updater never rewrites that file, a shipped link
  // later changed or withdrawn in code would live on in every install forever.
  // Keeping only the person's own links means code stays the single source.
  const shipped = new Set(SHIPPED_URLS.map(sheetId));
  const out = { ...cfg };
  if (Array.isArray(out.sheets)) out.sheets = out.sheets.filter((u) => !shipped.has(sheetId(u)));
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(out, null, 2), 'utf8');
}

module.exports = { readConfig, writeConfig, DEFAULTS, CONFIG_PATH, SHIPPED_SHEETS, SHIPPED_URLS, sheetId };

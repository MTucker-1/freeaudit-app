/*
 * server.js — FreeAudit local web app (with user accounts).
 *
 * Runs on this PC and listens on loopback only — nothing is exposed to the network.
 * Open http://localhost:<port> in a browser. Each person runs their own copy with
 * their own logins; credentials and files never leave this machine.
 *
 * Start with:  node server.js   (or "Start FreeAudit (dev).bat" for auto-reload).
 * Teammates install FreeAudit-Setup.exe instead — see TEAM-INSTALL.md.
 */
const express = require('express');
const { spawn, exec } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { readConfig, writeConfig } = require('./settings');
const { ensureDataDir } = require('./paths');
const gsheets = require('./gsheets');

// Force-kill a process and all its children (so a stuck audit + its Chromium are fully cleared).
function killTree(pid) { if (pid) { try { exec('taskkill /PID ' + pid + ' /T /F'); } catch (e) { /* ignore */ } } }

// Data (config, accounts, credentials, photos, reports) lives in DATA_DIR — the
// app folder on a personal install, a per-workspace folder when hosted.
// Code (public/, audit.js) always resolves from __dirname.
const ROOT = ensureDataDir();
const CODE_DIR = __dirname;
const USERS_PATH = path.join(ROOT, 'users.json');
const SESSIONS_PATH = path.join(ROOT, 'sessions.json');
const FBCREDS_PATH = path.join(ROOT, 'fullbay-credentials.json');
const GOOGLE_CREDS_PATH = path.join(ROOT, 'google-credentials.json');
const readFbCreds = () => { try { return fs.existsSync(FBCREDS_PATH) ? JSON.parse(fs.readFileSync(FBCREDS_PATH, 'utf8')) : {}; } catch (e) { return {}; } };
const fbUser = () => { const c = readFbCreds(); return (c.username && !/PUT-YOUR/i.test(c.username)) ? c.username : ''; };
const fbCredsSet = () => { const c = readFbCreds(); return !!(fbUser() && c.password && !/PUT-YOUR/i.test(c.password)); };
const readGoogleCreds = () => { try { return fs.existsSync(GOOGLE_CREDS_PATH) ? JSON.parse(fs.readFileSync(GOOGLE_CREDS_PATH, 'utf8')) : {}; } catch (e) { return {}; } };
const googleApiKeySet = () => { const k = (readGoogleCreds().apiKey || '').trim(); return !!(k && !/PUT-YOUR|YOUR-API-KEY/i.test(k)); };
// Vorto vendor-portal login (its own username/password — different from Fullbay).
const VORTOCREDS_PATH = path.join(ROOT, 'vorto-credentials.json');
const readVortoCreds = () => { try { return fs.existsSync(VORTOCREDS_PATH) ? JSON.parse(fs.readFileSync(VORTOCREDS_PATH, 'utf8')) : {}; } catch (e) { return {}; } };
const vortoUser = () => { const c = readVortoCreds(); return (c.username && !/PUT-YOUR/i.test(c.username)) ? c.username : ''; };
const vortoCredsSet = () => { const c = readVortoCreds(); return !!(vortoUser() && c.password && !/PUT-YOUR/i.test(c.password)); };

const app = express();
app.use(express.json());

/* ---------------- Accounts ---------------- */
const readUsers = () => (fs.existsSync(USERS_PATH) ? JSON.parse(fs.readFileSync(USERS_PATH, 'utf8')) : []);
const writeUsers = (u) => fs.writeFileSync(USERS_PATH, JSON.stringify(u, null, 2));
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString('hex');

/* Sessions are persisted to disk so an auto-update (which restarts the engine)
 * doesn't sign everybody out — the browser still holds a 30-day cookie, and this
 * keeps the matching server-side entry alive across that restart. */
const SESSION_MS = 30 * 24 * 3600 * 1000;
const sessions = new Map(); // token -> { name, email, expires }
function loadSessions() {
  try {
    if (!fs.existsSync(SESSIONS_PATH)) return;
    const saved = JSON.parse(fs.readFileSync(SESSIONS_PATH, 'utf8'));
    const now = Date.now();
    Object.entries(saved || {}).forEach(([token, s]) => {
      if (s && s.expires > now) sessions.set(token, s);
    });
  } catch (e) { /* unreadable session file just means everyone signs in again */ }
}
function saveSessions() {
  try {
    fs.writeFileSync(SESSIONS_PATH, JSON.stringify(Object.fromEntries(sessions)), 'utf8');
  } catch (e) { /* non-fatal: sessions still work until the next restart */ }
}
loadSessions();

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function currentUser(req) {
  const t = parseCookies(req).fa_session;
  if (!t) return null;
  const s = sessions.get(t);
  if (!s) return null;
  if (s.expires <= Date.now()) { sessions.delete(t); saveSessions(); return null; }
  s.lastSeen = Date.now(); // in-memory only; drives the "online now" count
  return s;
}
const ONLINE_MS = 5 * 60 * 1000;
function startSession(res, user) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { name: user.name, email: user.email, expires: Date.now() + SESSION_MS });
  saveSessions();
  res.cookie('fa_session', token, { httpOnly: true, sameSite: 'lax', maxAge: SESSION_MS });
}

app.post('/api/register', (req, res) => {
  const { name, email, password, code } = req.body || {};
  const requiredCode = (readConfig().signupCode || '').trim();
  if (requiredCode && (code || '').trim() !== requiredCode) {
    return res.status(403).json({ error: 'Invalid signup code. Ask your administrator for the code.' });
  }
  if (!name || !email || !password || password.length < 6) {
    return res.status(400).json({ error: 'Enter a name, email, and a password of at least 6 characters.' });
  }
  const users = readUsers();
  if (users.find((u) => u.email.toLowerCase() === email.toLowerCase())) {
    return res.status(409).json({ error: 'An account with that email already exists — try signing in.' });
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const user = { name: name.trim(), email: email.trim(), salt, hash: hashPw(password, salt), created: new Date().toISOString() };
  users.push(user); writeUsers(users);
  startSession(res, user);
  res.json({ ok: true });
});

app.post('/api/login', (req, res) => {
  const { email, password } = req.body || {};
  const user = readUsers().find((u) => u.email.toLowerCase() === (email || '').toLowerCase());
  if (!user || hashPw(password || '', user.salt) !== user.hash) {
    return res.status(401).json({ error: 'Wrong email or password.' });
  }
  startSession(res, user);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  const t = parseCookies(req).fa_session;
  if (t) { sessions.delete(t); saveSessions(); }
  res.clearCookie('fa_session');
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const u = currentUser(req);
  res.json({ loggedIn: !!u, name: u ? u.name : null, email: u ? u.email : null });
});

// List everyone with an account (safe fields only), flagging who's signed in now.
app.get('/api/users', (req, res) => {
  if (!currentUser(req)) return res.status(401).json({ error: 'Not signed in' });
  // "Online" means active in the last few minutes — not merely holding an
  // unexpired session, which now survives restarts.
  const cutoff = Date.now() - ONLINE_MS;
  const online = new Set([...sessions.values()]
    .filter((s) => (s.lastSeen || 0) > cutoff)
    .map((s) => (s.email || '').toLowerCase()));
  const users = readUsers()
    .map((u) => ({ name: u.name, email: u.email, created: u.created || '', online: online.has((u.email || '').toLowerCase()) }))
    .sort((a, b) => (b.online - a.online) || a.name.localeCompare(b.name));
  res.json({ users });
});

// Gate everything below this for signed-in users only.
function requireAuth(req, res, next) {
  if (currentUser(req)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not signed in' });
  return res.status(401).send('Please sign in to FreeAudit.');
}

/* ---------------- Live run state ---------------- */
let running = false; let child = null; let events = [];
const clients = [];
function broadcast(evt) {
  events.push(evt);
  if (events.length > 3000) events.shift();
  clients.forEach((c) => { try { c.write('data: ' + JSON.stringify(evt) + '\n\n'); } catch (e) { /* ignore */ } });
}

app.get('/api/status', requireAuth, (req, res) => {
  res.json({ running, startedBy: runStartedBy, kind: runKind, lines: events, reportExists: fs.existsSync(path.join(ROOT, 'audit-report.html')) });
});

// Health/freshness signals for the home dashboard.
app.get('/api/health', requireAuth, (req, res) => {
  let trackerUpdated = null; let trackerCount = 0;
  try {
    const xs = fs.readdirSync(ROOT).filter((f) => /\.xlsx$/i.test(f) && !f.startsWith('~$'));
    trackerCount = xs.length;
    const ms = xs.map((f) => fs.statSync(path.join(ROOT, f)).mtimeMs);
    if (ms.length) trackerUpdated = new Date(Math.max(...ms)).toISOString();
  } catch (e) { /* ignore */ }
  res.json({
    trackerUpdated, trackerCount,
    fullbayCredsSet: fbCredsSet(), vortoCredsSet: vortoCredsSet(),
  });
});

// Week-by-week scorecard: who submits orders, and what they keep missing.
app.get('/api/scorecard', requireAuth, (req, res) => {
  try {
    const weeks = Math.min(52, Math.max(1, parseInt(req.query.weeks, 10) || 8));
    res.json(require('./scorecard').aggregate({ weeks }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Latest-run impact summary for the dashboard.
app.get('/api/summary', requireAuth, (req, res) => {
  const f = path.join(ROOT, 'audit-summary.json');
  if (!fs.existsSync(f)) return res.json(null);
  try { res.json(JSON.parse(fs.readFileSync(f, 'utf8'))); } catch (e) { res.json(null); }
});

app.get('/api/events', requireAuth, (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  clients.push(res);
  req.on('close', () => { const i = clients.indexOf(res); if (i >= 0) clients.splice(i, 1); });
});

let runWatchdog = null;
let runStartedBy = '';
let runKind = '';
function startChild(args, res, byName, kind) {
  if (running) return res.status(409).json({ error: 'already running', startedBy: runStartedBy, kind: runKind });
  running = true; runStartedBy = byName || 'someone'; runKind = kind || 'audit'; events = [];
  broadcast({ type: 'start', by: runStartedBy, kind: runKind });
  child = spawn(process.execPath, args.map((a, i) => (i === 0 ? path.join(CODE_DIR, a) : a)), { cwd: ROOT, env: { ...process.env, FREEAUDIT_DATA_DIR: ROOT } });
  const childPid = child.pid;
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      broadcast({ type: 'log', line });
    }
  });
  child.stderr.on('data', (d) => broadcast({ type: 'log', line: '[err] ' + d.toString().trim() }));
  child.on('close', (code) => {
    if (runWatchdog) { clearTimeout(runWatchdog); runWatchdog = null; }
    if (buf.trim()) broadcast({ type: 'log', line: buf.trim() });
    running = false; child = null; runStartedBy = ''; runKind = '';
    broadcast({ type: 'done', code });
  });
  // Safety net: never let a stuck run lock everyone out forever.
  const maxMs = (readConfig().maxRunMinutes || 30) * 60000;
  runWatchdog = setTimeout(() => {
    broadcast({ type: 'log', line: '[stopped] Run exceeded the time limit and was stopped automatically.' });
    killTree(childPid);
  }, maxMs);
  return res.json({ ok: true });
}

app.post('/api/run', requireAuth, (req, res) => startChild(['audit.js'], res, (currentUser(req) || {}).name, 'audit'));
// Opens Fullbay's login in the automation browser (on the host PC) so a person can sign in.
app.post('/api/connect-fullbay', requireAuth, (req, res) => startChild(['audit.js', 'login'], res, (currentUser(req) || {}).name, 'signin'));
// Audits the OPEN service orders only. Kept separate from Run Audit because the
// two answer different questions and each is worth running on its own.
app.post('/api/run-open', requireAuth, (req, res) => startChild(['audit.js', 'open'], res, (currentUser(req) || {}).name, 'open'));

app.get('/open-report', requireAuth, (req, res) => {
  const f = path.join(ROOT, 'open-report.html');
  if (!fs.existsSync(f)) {
    return res.send('<p style="font-family:Segoe UI;color:#566380;padding:24px">'
      + 'No open-SO audit yet — press <b>Run Open Audit</b> to build one.</p>');
  }
  res.sendFile(f);
});

// Corrects Bill To / Ship To on every Ready-to-Invoice estimate to match its
// labour location. This is the ONLY action that writes to Fullbay, which is why
// it is a separate button rather than part of Run Audit.
app.post('/api/fix-addresses', requireAuth, (req, res) => startChild(['audit.js', 'fixaddresses'], res, (currentUser(req) || {}).name, 'addresses'));

// Opens the Vorto vendor portal in the automation browser (on the host PC) so a person can sign in.
app.post('/api/connect-vorto', requireAuth, (req, res) => startChild(['audit.js', 'vorto-login'], res, (currentUser(req) || {}).name, 'signin'));

// Stop/cancel whatever is running — frees the lock for everyone.
app.post('/api/cancel', requireAuth, (req, res) => {
  if (!running || !child) return res.json({ ok: true, note: 'nothing running' });
  broadcast({ type: 'log', line: '[stopped] Cancelled by a user.' });
  killTree(child.pid);
  return res.json({ ok: true });
});

/* ---------------- Settings ---------------- */
app.get('/api/config', requireAuth, (req, res) => {
  const c = readConfig();
  res.json({
    maxOrders: c.maxOrders, sheetFile: c.sheetFile, sheetYear: c.sheetYear,
    checkDuplicatePhotos: c.checkDuplicatePhotos, checkSheetCompletion: c.checkSheetCompletion,
    signupCode: c.signupCode,
    sheets: Array.isArray(c.sheets) ? c.sheets : (c.sheetUrl ? [c.sheetUrl] : []),
    googleApiKeySet: googleApiKeySet(), // whether a live-read key is saved; never the key itself
    // Sheets must be shared with this address for the tracker check to read them.
    serviceAccountEmail: gsheets.serviceAccountEmail(),
    fullbayUser: fbUser(), fullbayCredsSet: fbCredsSet(), // username only; never the password
    vortoUser: vortoUser(), vortoCredsSet: vortoCredsSet(), // username only; never the password
  });
});
app.post('/api/config', requireAuth, (req, res) => {
  const c = readConfig();
  ['maxOrders', 'sheetFile', 'sheetYear', 'checkDuplicatePhotos', 'checkSheetCompletion', 'signupCode', 'sheets'].forEach((k) => {
    if (req.body[k] !== undefined) c[k] = req.body[k];
  });
  writeConfig(c);
  // Google Sheets API key goes in its own file. Only updates when a new key is
  // typed (blank = keep the existing one).
  if (req.body.googleApiKey) {
    const g = readGoogleCreds();
    g.apiKey = req.body.googleApiKey.trim();
    fs.writeFileSync(GOOGLE_CREDS_PATH, JSON.stringify({ apiKey: g.apiKey }, null, 2), 'utf8');
  }
  // Fullbay auto-login credentials go in their own file. Username updates if provided;
  // password only updates when a new one is typed (blank = keep existing).
  if (req.body.fullbayUser !== undefined || req.body.fullbayPassword) {
    const fb = readFbCreds();
    if (req.body.fullbayUser !== undefined && req.body.fullbayUser.trim() !== '') fb.username = req.body.fullbayUser.trim();
    if (req.body.fullbayPassword) fb.password = req.body.fullbayPassword;
    fs.writeFileSync(FBCREDS_PATH, JSON.stringify({ username: fb.username || '', password: fb.password || '' }, null, 2), 'utf8');
  }
  // Vorto auto-login credentials — same pattern (blank password = keep existing).
  if (req.body.vortoUser !== undefined || req.body.vortoPassword) {
    const vt = readVortoCreds();
    if (req.body.vortoUser !== undefined && req.body.vortoUser.trim() !== '') vt.username = req.body.vortoUser.trim();
    if (req.body.vortoPassword) vt.password = req.body.vortoPassword;
    fs.writeFileSync(VORTOCREDS_PATH, JSON.stringify({ username: vt.username || '', password: vt.password || '' }, null, 2), 'utf8');
  }
  res.json({ ok: true });
});

/* ---------------- Report + photos + CSV (gated) ---------------- */
app.get('/report', requireAuth, (req, res) => {
  const f = path.join(ROOT, 'audit-report.html');
  if (!fs.existsSync(f)) return res.send('<p style="font-family:Segoe UI;color:#566380;padding:24px">No report yet — run an audit to generate one.</p>');
  res.sendFile(f);
});
app.get('/report-csv', requireAuth, (req, res) => {
  const f = path.join(ROOT, 'audit-results.csv');
  if (!fs.existsSync(f)) return res.status(404).send('No CSV yet — run an audit first.');
  res.download(f, 'audit-results.csv');
});

// Render the latest report to PDF on demand (via headless Chromium). The PDF is
// cached on disk and only rebuilt when the report HTML is newer, so repeat
// downloads are instant. Loading the HTML via a file:// URL lets the relative
// photos/ paths resolve to the local photos folder.
const REPORT_HTML = path.join(ROOT, 'audit-report.html');
const REPORT_PDF = path.join(ROOT, 'audit-report.pdf');
let pdfBuilding = null; // shared promise so concurrent requests reuse one build
async function buildReportPdf() {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto('file:///' + REPORT_HTML.replace(/\\/g, '/'), { waitUntil: 'networkidle' });
    // Force lazy-loaded images to load so they appear in the PDF, then wait for them.
    await page.evaluate(() => {
      document.querySelectorAll('img[loading]').forEach((img) => { img.loading = 'eager'; });
      return Promise.all([...document.images].filter((i) => !i.complete)
        .map((i) => new Promise((r) => { i.onload = i.onerror = r; })));
    });
    await page.pdf({
      path: REPORT_PDF, format: 'A4', printBackground: true,
      margin: { top: '14mm', bottom: '14mm', left: '10mm', right: '10mm' },
    });
  } finally {
    await browser.close();
  }
}
app.get('/report-pdf', requireAuth, async (req, res) => {
  if (!fs.existsSync(REPORT_HTML)) return res.status(404).send('No report yet — run an audit first.');
  try {
    const htmlMs = fs.statSync(REPORT_HTML).mtimeMs;
    const fresh = fs.existsSync(REPORT_PDF) && fs.statSync(REPORT_PDF).mtimeMs >= htmlMs;
    if (!fresh) {
      if (!pdfBuilding) pdfBuilding = buildReportPdf().finally(() => { pdfBuilding = null; });
      await pdfBuilding;
    }
    res.download(REPORT_PDF, 'audit-report.pdf');
  } catch (e) {
    res.status(500).send('Could not build PDF: ' + e.message);
  }
});
app.use('/photos', requireAuth, express.static(path.join(ROOT, 'photos')));

/* ---------------- UI (public static) ---------------- */
app.use(express.static(path.join(CODE_DIR, 'public')));

// Desktop install: loopback, so nothing is exposed to the network. Hosted (PORT
// set by the platform): 0.0.0.0, or the platform's router can't reach us.
const startCfg = readConfig();
const PORT = startCfg.webPort || 4477;
const HOST = startCfg.bindHost || '127.0.0.1';
app.listen(PORT, HOST, () => {
  const where = HOST === '127.0.0.1'
    ? 'http://localhost' + (PORT === 80 ? '' : ':' + PORT)
    : HOST + ':' + PORT;
  console.log('FreeAudit running at ' + where);
});

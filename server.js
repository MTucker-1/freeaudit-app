/*
 * server.js — FreeAudit local web app (with user accounts).
 *
 * Runs on this PC. Open http://localhost:<port> in a browser. Reach it remotely
 * through a secure private tunnel (see FREEAUDIT-SETUP.md). Your Fullbay login
 * and files stay on this machine.
 *
 * Start with:  node server.js   (or double-click "Start FreeAudit.bat")
 */
const express = require('express');
const { spawn, exec } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const connecteam = require('./connecteam');

// Force-kill a process and all its children (so a stuck audit + its Chromium are fully cleared).
function killTree(pid) { if (pid) { try { exec('taskkill /PID ' + pid + ' /T /F'); } catch (e) { /* ignore */ } } }

const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, 'config.json');
const USERS_PATH = path.join(ROOT, 'users.json');
const FBCREDS_PATH = path.join(ROOT, 'fullbay-credentials.json');
const GOOGLE_CREDS_PATH = path.join(ROOT, 'google-credentials.json');
const readConfig = () => JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
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
const sessions = new Map(); // token -> { name, email }

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
const currentUser = (req) => { const t = parseCookies(req).fa_session; return t ? sessions.get(t) : null; };
function startSession(res, user) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { name: user.name, email: user.email });
  res.cookie('fa_session', token, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 3600 * 1000 });
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
  if (t) sessions.delete(t);
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
  const online = new Set([...sessions.values()].map((s) => (s.email || '').toLowerCase()));
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
  res.json({ trackerUpdated, trackerCount, fullbayCredsSet: fbCredsSet(), connecteamSet: connecteam.isConfigured() });
});

// Connecteam clocked hours per mechanic over a date range, grouped by week or day
// (powers the scorecard). Cached briefly per query because each refresh makes
// several Connecteam API calls.
const isoLocal = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const clockedCache = new Map(); // key -> { at, data }
app.get('/api/clocked', requireAuth, async (req, res) => {
  if (!connecteam.isConfigured()) return res.json({ configured: false });
  const groupBy = req.query.groupBy === 'day' ? 'day' : 'week';
  let start = req.query.start;
  let end = req.query.end;
  // Default range: the last 6 weeks ending today.
  if (!start || !end) {
    const now = new Date();
    end = end || isoLocal(now);
    start = start || isoLocal(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 35));
  }
  const ok = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);
  if (!ok(start) || !ok(end)) return res.status(400).json({ configured: true, error: 'Dates must be YYYY-MM-DD.' });
  const key = groupBy + '|' + start + '|' + end;
  const hit = clockedCache.get(key);
  if (hit && (Date.now() - hit.at) < 10 * 60 * 1000) return res.json({ configured: true, cached: true, ...hit.data });
  try {
    const data = await connecteam.clockedRange(start, end, groupBy);
    clockedCache.set(key, { at: Date.now(), data });
    if (clockedCache.size > 40) clockedCache.delete(clockedCache.keys().next().value);
    res.json({ configured: true, cached: false, ...data });
  } catch (e) {
    res.status(502).json({ configured: true, error: e.message });
  }
});

// Fullbay "Completed Hours" = billed (invoiced) hours per mechanic by Mon–Sun week.
// Served from the cached JSON that `node audit.js billed` writes (a Fullbay browser
// session is required to refresh it, so it can't be fetched live per request).
app.get('/api/billed', requireAuth, (req, res) => {
  const f = path.join(ROOT, 'fullbay-completed-hours.json');
  if (!fs.existsSync(f)) return res.json({ available: false });
  try {
    const d = JSON.parse(fs.readFileSync(f, 'utf8'));
    res.json({ available: true, updatedAt: d.updatedAt || null, weeks: d.weeks || [], byEmployee: d.byEmployee || [] });
  } catch (e) { res.json({ available: false }); }
});
// Refresh billed hours from Fullbay (spawns the scraper; needs a Fullbay session/auto-login).
app.post('/api/refresh-billed', requireAuth, (req, res) => startChild(['audit.js', 'billed'], res, (currentUser(req) || {}).name, 'billed'));

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
  child = spawn(process.execPath, args, { cwd: ROOT });
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
    fullbayUser: fbUser(), fullbayCredsSet: fbCredsSet(), // username only; never the password
    vortoUser: vortoUser(), vortoCredsSet: vortoCredsSet(), // username only; never the password
  });
});
app.post('/api/config', requireAuth, (req, res) => {
  const c = readConfig();
  ['maxOrders', 'sheetFile', 'sheetYear', 'checkDuplicatePhotos', 'checkSheetCompletion', 'signupCode', 'sheets'].forEach((k) => {
    if (req.body[k] !== undefined) c[k] = req.body[k];
  });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2), 'utf8');
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
app.use(express.static(path.join(ROOT, 'public')));

const PORT = readConfig().webPort || 4400;
app.listen(PORT, () => {
  const url = PORT === 80 ? 'http://freeaudit.com' : 'http://freeaudit.com:' + PORT;
  console.log('FreeAudit running at ' + url);
});

/*
 * gsheets.js — read a Google Sheet LIVE via the Sheets API v4.
 *
 * Two auth modes, preferred in this order:
 *   1) SERVICE ACCOUNT (google-service-account.json) — the robust, private way.
 *      Share each sheet with the service account's email (Viewer). Works even
 *      when the Workspace admin blocks "anyone with the link" sharing, because
 *      you're granting a specific user. Read-only scope.
 *   2) API KEY (google-credentials.json {apiKey}) — only works for sheets shared
 *      "anyone with the link can view". Kept as a fallback.
 *
 * This is what keeps the completion check current: instead of reading a manually
 * exported .xlsx snapshot, the audit pulls the tracker tabs straight from Google
 * every time it runs, so it always sees what the sheet says right now.
 *
 * No external libraries — the service-account JWT is signed with Node's crypto.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR, dataPath } = require('./paths');

const CREDS_PATH = dataPath('google-credentials.json');
const SA_PATH = dataPath('google-service-account.json');
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';
// Listing every tracker shared with the service account is a Drive operation,
// not a Sheets one, so it needs its own scope (and the Drive API enabled).
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.metadata.readonly';

/* ---------------- credential loading ---------------- */
function apiKey() {
  try {
    if (!fs.existsSync(CREDS_PATH)) return '';
    const k = (JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8')).apiKey || '').trim();
    return /PUT-YOUR|YOUR-API-KEY/i.test(k) ? '' : k;
  } catch (e) { return ''; }
}
function serviceAccount() {
  try {
    if (!fs.existsSync(SA_PATH)) return null;
    const j = JSON.parse(fs.readFileSync(SA_PATH, 'utf8'));
    return (j.client_email && j.private_key) ? j : null;
  } catch (e) { return null; }
}
function isConfigured() { return !!(serviceAccount() || apiKey()); }
// The email the user must share their sheets with (when using a service account).
function serviceAccountEmail() { const sa = serviceAccount(); return sa ? sa.client_email : ''; }

/* ---------------- service-account OAuth (JWT bearer) ---------------- */
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const tokenCache = new Map(); // scope -> { token, exp } (exp in epoch seconds)

async function getAccessToken(sa, scope = SCOPE) {
  const now = Math.floor(Date.now() / 1000);
  const hit = tokenCache.get(scope);
  if (hit && hit.exp - 60 > now) return hit.token;
  const aud = sa.token_uri || 'https://oauth2.googleapis.com/token';
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({ iss: sa.client_email, scope, aud, iat: now, exp: now + 3600 }));
  const signingInput = header + '.' + claim;
  const signature = b64url(crypto.sign('RSA-SHA256', Buffer.from(signingInput), sa.private_key));
  const assertion = signingInput + '.' + signature;
  const body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion });
  const r = await fetch(aud, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error('token request failed: ' + (j.error_description || j.error || (r.status + ' ' + r.statusText)));
  tokenCache.set(scope, { token: j.access_token, exp: now + (j.expires_in || 3600) });
  return j.access_token;
}

/* ---------------- authorized GET (picks the available auth mode) ---------------- */
async function apiGet(url) {
  const sa = serviceAccount();
  let finalUrl = url;
  const opts = {};
  if (sa) {
    const token = await getAccessToken(sa);
    opts.headers = { Authorization: 'Bearer ' + token };
  } else {
    const key = apiKey();
    if (!key) throw new Error('no Google credentials set (service account or API key)');
    finalUrl += (url.indexOf('?') >= 0 ? '&' : '?') + 'key=' + key;
  }
  /*
   * Reading one tracker costs one request per tab, so a run across several
   * trackers can trip the Sheets API's per-minute read quota. That surfaces as
   * HTTP 429 and is purely transient — but if we let it through, the caller
   * drops an entire tracker and every unit in it looks "not found", which shows
   * up as bogus findings. So retry with backoff rather than failing the sheet.
   */
  const MAX_TRIES = 5;
  let wait = 2000;
  for (let attempt = 1; ; attempt++) {
    const r = await fetch(finalUrl, opts);
    if (r.ok) return r.json();

    let msg = r.status + ' ' + r.statusText;
    try { const e = await r.json(); if (e && e.error && e.error.message) msg = e.error.message; } catch (x) { /* ignore */ }

    const retryable = r.status === 429 || r.status >= 500;
    if (!retryable || attempt >= MAX_TRIES) throw new Error(msg);

    await new Promise((res) => setTimeout(res, wait));
    wait = Math.min(wait * 2, 30000); // 2s, 4s, 8s, 16s
  }
}

// Accept a full Google Sheets URL or a bare spreadsheet ID.
function idFromUrl(u) {
  if (!u) return '';
  const m = String(u).match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : String(u).trim();
}

// List the tab (worksheet) titles in a spreadsheet.
async function listTabs(id) {
  const url = 'https://sheets.googleapis.com/v4/spreadsheets/' + id + '?fields=properties.title,sheets.properties.title';
  const j = await apiGet(url);
  return {
    title: (j.properties && j.properties.title) || id,
    tabs: (j.sheets || []).map((s) => s.properties.title),
  };
}

// Fetch one tab's cells as a 2D array of strings (formatted, exactly as shown).
async function getTabValues(id, tabTitle) {
  const range = encodeURIComponent("'" + tabTitle.replace(/'/g, "''") + "'");
  const url = 'https://sheets.googleapis.com/v4/spreadsheets/' + id + '/values/' + range +
    '?valueRenderOption=FORMATTED_VALUE&majorDimension=ROWS';
  const j = await apiGet(url);
  return (j.values || []).map((row) => (row || []).map((c) => (c == null ? '' : String(c))));
}

// Read a spreadsheet and return { title, tabs:[{name, rows}] } for tabs passing filterFn.
async function readSpreadsheet(url, filterFn) {
  if (!isConfigured()) throw new Error('no Google credentials set');
  const id = idFromUrl(url);
  if (!id) throw new Error('could not read spreadsheet id from "' + url + '"');
  const { title, tabs } = await listTabs(id);
  const wanted = tabs.filter((t) => filterFn(t));
  const out = [];
  for (const t of wanted) out.push({ name: t, rows: await getTabValues(id, t) });
  return { title, tabs: out };
}

/*
 * listSpreadsheets — every Google Sheet the service account can see, i.e. every
 * tracker somebody has shared with serviceAccountEmail(). This is what lets the
 * completion check pick up a new market's tracker without anyone editing config.
 *
 * Requires BOTH a service account (an API key cannot list Drive) and the Drive
 * API enabled on the project. Throws a plain-language error otherwise, so the
 * caller can fall back to the configured list and tell the user what to fix.
 */
async function listSpreadsheets() {
  const sa = serviceAccount();
  if (!sa) throw new Error('auto-discovery needs a service account (an API key cannot list Drive)');
  const token = await getAccessToken(sa, DRIVE_SCOPE);
  const q = "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false";
  const out = [];
  let pageToken = '';
  do {
    const url = 'https://www.googleapis.com/drive/v3/files'
      + '?q=' + encodeURIComponent(q)
      + '&fields=nextPageToken,files(id,name,modifiedTime)'
      + '&pageSize=100&orderBy=name'
      + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = (j.error && j.error.message) || (r.status + ' ' + r.statusText);
      if (/has not been used in project|is disabled/i.test(msg)) {
        throw new Error('the Google Drive API is not enabled for the service account project — '
          + 'enable Drive API in the Google Cloud console, then re-run');
      }
      throw new Error(msg);
    }
    (j.files || []).forEach((f) => out.push({ id: f.id, name: f.name, modifiedTime: f.modifiedTime }));
    pageToken = j.nextPageToken || '';
  } while (pageToken);
  return out;
}

module.exports = {
  isConfigured, apiKey, serviceAccount, serviceAccountEmail,
  idFromUrl, readSpreadsheet, listSpreadsheets,
};

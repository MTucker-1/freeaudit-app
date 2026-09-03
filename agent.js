/*
 * agent.js — FreeAudit host agent.
 *
 * Lives in the FreeAudit folder on the host PC, alongside audit.js. Lets the
 * FLSS portal start an audit without any inbound connection to this machine:
 * the agent polls the portal for queued runs, runs audit.js exactly the way
 * server.js already does, streams the console back, and posts the results.
 *
 * Outbound HTTPS only. No open port, no tunnel, works behind NAT.
 *
 * The local FreeAudit app is untouched — keep using it. This is additive; both
 * can drive the same audit.js (though not at the same time, since they share
 * one browser profile).
 *
 * SETUP
 *   1. Put this file in the FreeAudit folder (next to audit.js).
 *   2. Create agent-credentials.json next to it:
 *        {
 *          "portalUrl": "https://<your-portal>.vercel.app",
 *          "agentSecret": "<the AUDIT_AGENT_SECRET value from Vercel>",
 *          "host": "mitch-pc"
 *        }
 *   3. node agent.js
 *
 * Node 18+ (uses global fetch). No npm install needed.
 */
const { spawn, exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
// Named *credentials* on purpose: this repo is public, and the existing
// .gitignore already excludes *credentials*.json. That way the secret is
// covered even if nobody remembers to add a new ignore line.
const CONFIG_PATH = path.join(ROOT, 'agent-credentials.json');
const LEGACY_CONFIG_PATH = path.join(ROOT, 'audit-agent.json');

const POLL_IDLE_MS = 20000;     // how often to ask for work when idle
const POLL_ERROR_MS = 60000;    // back off when the portal is unreachable
const HEARTBEAT_MS = 20000;     // liveness + the cancel check
const LOG_FLUSH_MS = 2000;      // how often buffered console lines are shipped
const LOG_FLUSH_LINES = 50;
const RESULT_CHUNK = 100;       // orders per results POST

const cfg = (() => {
  const p = fs.existsSync(CONFIG_PATH) ? CONFIG_PATH
    : (fs.existsSync(LEGACY_CONFIG_PATH) ? LEGACY_CONFIG_PATH : null);
  if (!p) {
    console.error('Missing agent-credentials.json next to agent.js — see the header of this file.');
    process.exit(1);
  }
  if (p === LEGACY_CONFIG_PATH) {
    console.warn('WARNING: using audit-agent.json. Rename it to agent-credentials.json — that name is '
      + 'already covered by .gitignore, and this repo is public.');
  }
  const c = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (!c.portalUrl || !c.agentSecret) {
    console.error(path.basename(p) + ' needs both portalUrl and agentSecret.');
    process.exit(1);
  }
  c.host = c.host || require('os').hostname();
  c.portalUrl = c.portalUrl.replace(/\/+$/, '');
  return c;
})();

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const stamp = () => new Date().toISOString().slice(11, 19);
const say = (...a) => console.log(`[${stamp()}]`, ...a);

// Kill the audit and every child it spawned, so a cancelled run doesn't leave
// an orphaned Chromium holding the browser profile.
function killTree(pid) {
  if (!pid) return;
  try { exec(`taskkill /PID ${pid} /T /F`); } catch (e) { /* already gone */ }
}

async function api(action, { method = 'POST', body = null, query = {} } = {}) {
  const qs = new URLSearchParams({ action, ...query }).toString();
  const res = await fetch(`${cfg.portalUrl}/api/audit?${qs}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-agent-secret': cfg.agentSecret },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* non-JSON error page */ }
  if (!res.ok) throw new Error(`${action} → ${res.status}: ${(json && json.error) || text.slice(0, 200)}`);
  return json || {};
}

/* ---------------------------------------------------------------- log stream */
// Buffers console lines and ships them in batches. seq preserves ordering even
// when several lines land in the same millisecond.
function makeLogger(runId) {
  let buf = [];
  let seq = 0;
  let timer = null;
  let flushing = false;

  const flush = async () => {
    if (flushing || !buf.length) return;
    flushing = true;
    const lines = buf;
    buf = [];
    try {
      const r = await api('log', { body: { run_id: runId, lines, seq_start: seq } });
      seq = r.next_seq != null ? r.next_seq : seq + lines.length;
    } catch (e) {
      // Don't lose the run over a dropped log batch — the audit is what matters.
      console.error('  log flush failed:', e.message);
    }
    flushing = false;
  };

  timer = setInterval(flush, LOG_FLUSH_MS);
  return {
    push(line) {
      buf.push(line);
      if (buf.length >= LOG_FLUSH_LINES) flush();
    },
    async stop() {
      clearInterval(timer);
      await flush();
      // One retry for whatever arrived during the final flush.
      await flush();
    }
  };
}

/* ------------------------------------------------------------- result upload */
// audit.js writes audit-results.json (the per-order detail) and
// audit-summary.json (the rollup). The detail file comes from a small additive
// patch to audit.js; if it isn't there yet the run still completes, just
// without per-finding rows.
function readJson(file) {
  const p = path.join(ROOT, file);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) {
    say(`  could not parse ${file}: ${e.message}`);
    return null;
  }
}

async function postResults(runId, detail) {
  const results = (detail && detail.results) || [];
  const photos = (detail && detail.photos) || [];
  const dupInfo = (detail && detail.dupInfo) || {};

  let sentOrders = 0;
  let sentFindings = 0;

  for (let i = 0; i < results.length; i += RESULT_CHUNK) {
    const slice = results.slice(i, i + RESULT_CHUNK);
    const orders = slice.map(r => ({
      so_number: r.soNumber,
      so_url: r.url || null,
      customer_name: r.customerName || null,
      unit_number: r.unitNumber || null,
      service_writer: r.serviceWriter || null,
      po_number: r.poNumber || null,
      technicians: Array.isArray(r.technicians) ? r.technicians : null,
      action_item_count: r.actionItemCount ?? null,
      findings_count: Array.isArray(r.findings) ? r.findings.length : 0,
      service_call: r.serviceCall ?? null,
      sheet_complete: r.sheetComplete ?? null,
      sheet_status: r.sheetStatus || null,
      vorto_resolved: r.vortoResolved ?? null,
      vorto_status: r.vortoStatus || null,
      notes: r.notes && r.notes.length ? r.notes : null,
      error: r.error || null
    }));

    const findings = [];
    slice.forEach(r => {
      (r.findings || []).forEach(f => {
        findings.push({
          so_number: r.soNumber,
          check_code: f.check || '?',
          severity: f.severity || 'blocker',
          title: f.title || '',
          detail: f.detail || null,
          technician: f.technician || null
        });
      });
    });

    await api('results', { body: { run_id: runId, orders, findings } });
    sentOrders += orders.length;
    sentFindings += findings.length;
  }

  // Photo hashes only — the images stay on the host for now. The hash is all
  // check F needs to prove the same photo was reused across service orders.
  for (let i = 0; i < photos.length; i += RESULT_CHUNK * 2) {
    const chunk = photos.slice(i, i + RESULT_CHUNK * 2).map(p => ({
      so_number: p.soNumber,
      ai_number: p.aiNumber,
      technician: p.technician || null,
      hash: p.hash,
      dup_with: dupInfo[p.hash] ? dupInfo[p.hash].filter(s => s !== p.soNumber) : null
    }));
    if (chunk.length) await api('results', { body: { run_id: runId, photos: chunk } });
  }

  return { sentOrders, sentFindings, sentPhotos: photos.length };
}

/* -------------------------------------------------------------------- runner */
async function runJob(job) {
  const args = job.kind === 'billed' ? ['audit.js', 'billed']
    : job.kind === 'signin' ? ['audit.js', 'login']
    : ['audit.js'];

  say(`Claimed ${job.kind} run ${job.id} (requested by ${job.requested_by_name || 'someone'})`);

  const logger = makeLogger(job.id);
  logger.push(`[agent] Starting on ${cfg.host}: node ${args.join(' ')}`);

  const child = spawn(process.execPath, args, { cwd: ROOT });
  const childPid = child.pid;
  let cancelled = false;

  // Heartbeat doubles as the cancel channel — the portal can't reach in here,
  // so we ask on every beat whether we've been told to stop.
  const beat = setInterval(async () => {
    try {
      const r = await api('heartbeat', { body: { run_id: job.id } });
      if (r.cancel_requested && !cancelled) {
        cancelled = true;
        logger.push('[agent] Cancel requested from the portal — stopping.');
        say('  cancel requested; killing the run');
        killTree(childPid);
      }
    } catch (e) { /* transient; next beat retries */ }
  }, HEARTBEAT_MS);

  // Line-buffer stdout so partial writes don't produce broken console lines.
  let out = '';
  child.stdout.on('data', d => {
    out += d.toString();
    let nl;
    while ((nl = out.indexOf('\n')) >= 0) {
      const line = out.slice(0, nl).replace(/\r$/, '');
      out = out.slice(nl + 1);
      logger.push(line);
    }
  });
  child.stderr.on('data', d => logger.push('[err] ' + d.toString().trim()));

  const code = await new Promise(resolve => child.on('close', resolve));
  clearInterval(beat);
  if (out.trim()) logger.push(out.trim());

  let status = cancelled ? 'cancelled' : (code === 0 ? 'success' : 'failed');
  let error = null;
  let summary = null;
  let ordersFound = null;

  if (status === 'success' && job.kind === 'audit') {
    const detail = readJson('audit-results.json');
    summary = readJson('audit-summary.json');
    if (summary) ordersFound = summary.ordersChecked ?? null;

    if (!detail) {
      logger.push('[agent] audit-results.json not found — posting the summary only. '
        + 'Apply the audit.js patch to get per-finding detail in the portal.');
      say('  audit-results.json missing — summary only');
    } else {
      try {
        const sent = await postResults(job.id, detail);
        logger.push(`[agent] Uploaded ${sent.sentOrders} orders, ${sent.sentFindings} findings, ${sent.sentPhotos} photo hashes.`);
      } catch (e) {
        status = 'failed';
        error = `Results upload failed: ${e.message}`;
        logger.push('[agent] ' + error);
      }
    }
  } else if (status === 'failed') {
    error = `audit.js exited with code ${code}.`;
  }

  await logger.stop();
  await api('complete', {
    body: { run_id: job.id, status, error, summary, orders_found: ordersFound }
  });
  say(`  run ${job.id} finished: ${status}`);
}

/* ---------------------------------------------------------------- poll loop */
async function main() {
  say(`FreeAudit agent starting — host "${cfg.host}", portal ${cfg.portalUrl}`);
  say('Polling for queued runs. Leave this window open.');

  for (;;) {
    let wait = POLL_IDLE_MS;
    try {
      const { job } = await api('claim', { query: { host: cfg.host } });
      if (job) {
        try { await runJob(job); }
        catch (e) {
          say('  run failed:', e.message);
          // Never leave a run stuck as 'running' — the portal would show a
          // phantom in-progress audit until the stale reaper caught it.
          try {
            await api('complete', { body: { run_id: job.id, status: 'failed', error: e.message } });
          } catch (e2) { say('  could not report the failure:', e2.message); }
        }
        wait = 2000; // check straight away in case another run is queued
      }
    } catch (e) {
      say('poll failed:', e.message);
      wait = POLL_ERROR_MS;
    }
    await sleep(wait);
  }
}

process.on('SIGINT', () => { say('Agent stopped.'); process.exit(0); });

main().catch(e => { console.error('Agent crashed:', e); process.exit(1); });

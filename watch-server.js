/*
 * watch-server.js — runs server.js and automatically restarts it whenever a
 * back-end source file changes, so edits to the server take effect without you
 * stopping and starting anything by hand.
 *
 * The FreeAudit launchers start this instead of server.js directly.
 * Front-end files (anything under public/) do NOT need a restart — just refresh
 * the browser. Only the files the server itself loads are watched here.
 */
const { spawn, exec } = require('child_process');
const path = require('path');

const ROOT = __dirname;
// Files loaded into the web-server process. A change to any of these needs a
// restart. (audit.js / checks.js run as separate child processes per audit, so
// they pick up changes on the next run without restarting the web server.)
const WATCH = ['server.js', 'connecteam.js'];

let child = null;
let restarting = false;
let restartTimer = null;

function start() {
  child = spawn(process.execPath, ['server.js'], { cwd: ROOT, stdio: 'inherit' });
  child.on('exit', (code, signal) => {
    child = null;
    // If it stopped on its own (e.g. a crash), bring it back — unless we're the
    // ones restarting it on purpose.
    if (!restarting) {
      console.log('\n[watch] server stopped (' + (signal || code) + '). Restarting in 1s…');
      setTimeout(start, 1000);
    }
  });
}

function restart(reason) {
  if (restarting) return;
  restarting = true;
  console.log('\n[watch] ' + reason + ' — restarting server…');
  const done = () => { restarting = false; start(); };
  if (child && child.pid) {
    const pid = child.pid;
    child.removeAllListeners('exit');
    child.once('exit', done);
    // Kill the server and any child Chromium so port 80 frees up cleanly.
    exec('taskkill /PID ' + pid + ' /T /F', () => {});
    // Safety net: if it somehow doesn't exit, carry on anyway.
    setTimeout(() => { if (restarting) done(); }, 4000);
  } else {
    done();
  }
}

// Editors/tools often fire several change events for one save, so debounce.
function scheduleRestart(file) {
  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => restart('changed ' + file), 300);
}

// Watch the project folder (non-recursive) and react only to the files above.
// Watching the directory survives atomic saves better than watching each file.
try {
  require('fs').watch(ROOT, (eventType, filename) => {
    if (filename && WATCH.includes(filename)) scheduleRestart(filename);
  });
} catch (e) {
  console.log('[watch] could not start file watcher: ' + e.message);
}

console.log('[watch] FreeAudit auto-reload active — watching: ' + WATCH.join(', '));
start();

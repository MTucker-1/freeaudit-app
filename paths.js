/*
 * paths.js — where FreeAudit reads and writes DATA (as opposed to code).
 *
 * Running on one person's PC, data sits next to the code and this is just
 * __dirname. Running hosted, one process serves many people, so each run needs
 * its own workspace — set FREEAUDIT_DATA_DIR per run and the whole engine
 * (config, credentials, browser profiles, photos, reports) follows it.
 *
 * Code paths must keep using __dirname. Only data goes through here.
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.FREEAUDIT_DATA_DIR
  ? path.resolve(process.env.FREEAUDIT_DATA_DIR)
  : __dirname;

/** Absolute path to a data file/folder inside this run's workspace. */
const dataPath = (...p) => path.join(DATA_DIR, ...p);

/** Make sure the workspace exists (a hosted run starts from an empty dir). */
function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  return DATA_DIR;
}

module.exports = { DATA_DIR, dataPath, ensureDataDir };

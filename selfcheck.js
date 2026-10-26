/*
 * selfcheck.js — proves an install has everything FreeAudit needs ON THIS PC.
 *
 * Nothing may be fetched at run time: the npm packages, the browser engine and
 * the OCR language data all ship in FreeAudit.exe. A file missing here (a bad
 * unpack, antivirus quarantining part of Chromium) would otherwise surface much
 * later as a confusing audit failure.
 *
 *   node selfcheck.js          quick: files and modules present (the launcher runs
 *                              this after every unpack; ~1 s)
 *   node selfcheck.js --deep   also launches the browser engine and loads the OCR
 *                              data with downloads blocked (build-portable.ps1)
 *
 * Prints "OK" or one problem per line; exit code 0 = everything present.
 */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
if (!process.env.PLAYWRIGHT_BROWSERS_PATH) process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(ROOT, 'browsers');
const deep = process.argv.includes('--deep');
const problems = [];

// 1) Every npm dependency loads from node_modules.
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
for (const dep of Object.keys(pkg.dependencies || {})) {
  try { require(dep); } catch (e) { problems.push(`npm package "${dep}" missing or broken: ${String(e.message).split('\n')[0]}`); }
}

// 2) Every browser build this Playwright version runs is unpacked, and complete
// (Playwright writes INSTALLATION_COMPLETE last).
try {
  // Not in playwright-core's "exports", so read it straight off disk.
  const browsersJson = path.join(ROOT, 'node_modules', 'playwright-core', 'browsers.json');
  const { browsers } = JSON.parse(fs.readFileSync(browsersJson, 'utf8'));
  for (const b of browsers.filter((x) => x.installByDefault && /^(chromium|chromium-headless-shell|ffmpeg|winldd)$/.test(x.name))) {
    const dir = path.join(process.env.PLAYWRIGHT_BROWSERS_PATH, `${b.name.replace(/-/g, '_')}-${b.revision}`);
    if (!fs.existsSync(dir)) problems.push(`browser engine part missing: ${path.basename(dir)}`);
    else if (!fs.existsSync(path.join(dir, 'INSTALLATION_COMPLETE'))) problems.push(`browser engine part incomplete: ${path.basename(dir)}`);
  }
  const { chromium } = require('playwright');
  if (!fs.existsSync(chromium.executablePath())) problems.push(`browser engine missing: ${chromium.executablePath()}`);
} catch (e) {
  problems.push(`could not check the browser engine: ${String(e.message).split('\n')[0]}`);
}

// 3) OCR language data for Check I, beside the code (mapocr.js reads it there).
const trained = path.join(ROOT, 'eng.traineddata');
if (!fs.existsSync(trained) || fs.statSync(trained).size < 1e6) problems.push('OCR language data missing: eng.traineddata');

async function deepChecks() {
  // The headless engine really starts (headed uses the same files, checked above).
  try {
    const { chromium } = require('playwright');
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.setContent('<p>ok</p>');
    await browser.close();
  } catch (e) {
    problems.push(`browser engine would not start: ${String(e.message).split('\n')[0]}`);
  }
  // OCR loads from the local file. langPath points nowhere, so if tesseract
  // tried to download the language data instead, this fails.
  try {
    const { createWorker } = require('tesseract.js');
    const worker = await createWorker('eng', 1, { cachePath: ROOT, langPath: path.join(ROOT, 'no-download-allowed') });
    await worker.terminate();
  } catch (e) {
    problems.push(`OCR would not load offline: ${String(e && e.message || e).split('\n')[0]}`);
  }
}

(async () => {
  if (deep && !problems.length) await deepChecks();
  if (problems.length) { console.log(problems.join('\n')); process.exit(1); }
  console.log('OK');
  process.exit(0);
})();

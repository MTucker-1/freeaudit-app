/*
 * mapocr.js — read the drive time off a map screenshot.
 *
 * Techs attach an Apple/Google Maps screenshot to each travel action item, and
 * the trip length is printed on it ("31 min Fastest", "25 min", "1 hr 5 min").
 * That printed figure is the only statement of how long the trip should take —
 * Fullbay stores no travel estimate, and the photo's own EXIF is stripped on
 * upload — so Check I reads it here and compares it with the hours billed.
 *
 * Everything runs locally through tesseract.js: the photos never leave the PC,
 * which is the same promise the rest of FreeAudit makes about shop data.
 */
const DUR_RE = /(?:(\d{1,2})\s*(?:hr|hour)s?\b)?[\s,]*(?:(\d{1,3})\s*m[i1l]n\b)?/gi;

/*
 * Every duration printed on the image, in minutes.
 *
 * Apple Maps lists the alternatives as well as the chosen route ("37 min" beside
 * "31 min Fastest"), so this returns all of them and the caller picks. OCR
 * reliably turns "min" into "nin"/"mln" on these screenshots, hence m[i1l]n.
 */
function durationsIn(text) {
  const out = [];
  for (const m of String(text || '').matchAll(DUR_RE)) {
    const hrs = m[1] ? parseInt(m[1], 10) : 0;
    const mins = m[2] ? parseInt(m[2], 10) : 0;
    if (!hrs && !mins) continue;
    const total = hrs * 60 + mins;
    // A map screenshot showing a whole day of driving is OCR noise, not a trip.
    if (total > 0 && total <= 12 * 60) out.push(total);
  }
  return out;
}

/*
 * Clock times on the image, as minutes past midnight.
 *
 * Used only for the turn-by-turn layout (below). A 12-hour clock with no AM/PM
 * is left as-is: the two readings are compared within one trip, so what matters
 * is the gap between them, not the absolute time of day.
 */
function clockTimes(text) {
  const out = [];
  for (const m of String(text || '').matchAll(/\b(\d{1,2}):([0-5]\d)\s*(AM|PM)?/gi)) {
    let h = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    if (h > 12 && !m[3]) { if (h > 23) continue; } // 24h clock is fine as-is
    const ap = (m[3] || '').toUpperCase();
    if (ap === 'PM' && h < 12) h += 12;
    if (ap === 'AM' && h === 12) h = 0;
    out.push({ mins: h * 60 + min, hadMeridiem: !!ap });
  }
  return out;
}

/*
 * Turn-by-turn navigation shows no "N min" that OCR can pair up: the bottom bar
 * stacks the number ABOVE its "min" label, and tesseract reliably misreads the
 * figure itself ("11" comes back as "1"). Guessing there would invent a variance
 * out of nothing, so the trip is derived from the two clock times instead — the
 * status-bar time and the arrival time — which OCR does read correctly.
 * "4:58 PM" with "5:09 arrival" is an 11-minute trip.
 */
function tripFromArrivalClock(text) {
  const times = clockTimes(text);
  if (times.length < 2) return null;
  let best = null;
  for (const start of times) {
    for (const arrive of times) {
      if (start === arrive) continue;
      // The arrival ("5:09") is usually printed with no AM/PM while the status
      // bar carries one ("4:58 PM"), so a bare reading may mean either half of
      // the day — try both and keep the sensible one.
      for (const shift of (arrive.hadMeridiem ? [0] : [0, 12 * 60])) {
        const gap = (arrive.mins + shift) - start.mins;
        // Beyond a few hours these are two unrelated numbers, not one trip.
        if (gap > 0 && gap <= 4 * 60 && (best === null || gap < best)) best = gap;
      }
    }
  }
  return best;
}

/*
 * The trip the tech would actually have driven: the SHORTEST route offered.
 * Apple Maps marks it "Fastest" and shows it alongside slower alternatives, and
 * taking the shortest is also the strict reading — it allows the least time, so
 * nothing gets excused by a route nobody took.
 */
function tripMinutes(text) {
  const all = durationsIn(text);
  if (all.length) return Math.min(...all);
  return tripFromArrivalClock(text);
}

/*
 * One OCR worker reused for the whole run — starting tesseract costs seconds, so
 * per-photo workers would dominate the audit. close() must be called.
 *
 * Returns null (rather than throwing) when OCR is unavailable, so a missing or
 * broken tesseract install degrades Check I to "couldn't read it" instead of
 * taking the whole audit down.
 */
async function createReader(log = () => {}) {
  let worker = null;
  try {
    const { createWorker } = require('tesseract.js');
    /* Pin the language data beside the CODE. Left to itself tesseract caches
     * eng.traineddata (5 MB) in the working directory and downloads it when it is
     * missing — which would mean a different copy per working directory, and a
     * scheduled run on a machine with no internet silently losing Check I. The
     * installer ships this file, so a fresh install never downloads anything. */
    worker = await createWorker('eng', 1, { cachePath: __dirname });
  } catch (e) {
    log(`  Drive-time OCR unavailable (${e.message}) — drive photos will not be read.`);
    return { read: async () => null, close: async () => {}, ok: false };
  }
  return {
    ok: true,
    async read(file) {
      try {
        const { data } = await worker.recognize(file);
        const minutes = tripMinutes(data.text);
        return { minutes, text: data.text, all: durationsIn(data.text) };
      } catch (e) {
        return null;
      }
    },
    async close() { try { await worker.terminate(); } catch (e) { /* already gone */ } },
  };
}

module.exports = { createReader, tripMinutes, durationsIn, clockTimes, tripFromArrivalClock };

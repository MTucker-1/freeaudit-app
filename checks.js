/*
 * checks.js — the four FLSS audit checks.
 *
 * These are ported directly from flss_audit_site.html (the classify() and
 * runAudit() functions) so the automated tool flags exactly what the
 * drag-and-drop tool flags. If you tweak the rules in one place, mirror them here.
 */

// Keyword lists — identical to the original tool.
const INSP_KW = ['dot', 'pm ', 'pm-', 'inspection', 'checklist', 'bit', 'annual', 'fhwa', 'pre-trip', 'pretrip'];
const REP_KW = ['replace', 'repair', 'r/r', 'r&r', 'install', 'rebuild', 'leak', 'brake', 'seal',
  'valve', 'drum', 'tire', 'light', 'bulb', 'belt', 'hose', 'pad', 'rotor', 'kit', 'filter', 'fluid'];

function classify(note) {
  const n = (note || '').toLowerCase();
  const hit = (kws) => kws.some((k) => n.indexOf(k) > -1);
  return { isInspection: hit(INSP_KW), isRepair: hit(REP_KW) };
}

// A real service call says "Service Call (In Hours)" / "Service Call-In hours" /
// "Service Call (Out of Hours)". We require the "in/out hours" part so we DON'T pick up
// the leftover "Drive to unit (Service Call)" wording that techs forget to delete.
const SERVICE_CALL_RE = /service\s*call\s*[-(]?\s*(in|out)\b[\s-]*(of\s*)?hours?/i;
function isServiceCall(note) { return SERVICE_CALL_RE.test(note || ''); }

// Services billed as shop supplies (not charged for parts) — exempt from the
// "No Parts but billed repair labor" check (B). Add phrases here as needed.
// Matching is case-insensitive substring, so "hand rubber" covers
// "5F - HAND RUBBERS/SEALS  R\R  BOTH" regardless of spacing.
const SHOP_SUPPLY_NOTES = ['hand rubber'];

function isShopSupply(note) {
  const n = (note || '').toLowerCase();
  return SHOP_SUPPLY_NOTES.some((k) => n.indexOf(k) > -1);
}

// "R/R" = repair-or-replace. These often legitimately need NO part (rewire,
// disconnect, weld — e.g. HINGE BUTT), so they're exempt from the "No Parts"
// check (B). Matches R/R, R\R, R&R, "R / R", etc.
const RR_RE = /\bR\s*[/\\&]\s*R\b/i;
function isRR(note) { return RR_RE.test(note || ''); }

// Services that are SUPPOSED to be billed at zero hours. The work is recorded
// on the order but carries no labour time, so Check D must not read 0.00 as
// "hours were never entered". Substring match, case-insensitive, so
// "TIRE PRESSURE", "TIRE PRESSURES" and "TIRE PRESSURE CHECK" all count.
const ZERO_HOUR_SERVICES = ['tire pressure'];

function isZeroHourService(note) {
  const n = (note || '').toLowerCase();
  return ZERO_HOUR_SERVICES.some((k) => n.indexOf(k) > -1);
}

/*
 * When an order has several action items for the SAME service — two ABS speed
 * sensors, say — the parts for all of them are often added to just one item.
 * The others then look like "billed labour, no parts" when the work is fully
 * parted out at the order level.
 *
 * So an item marked No Parts is not flagged when a SIBLING item on the same
 * order describes the same service and does carry parts.
 *
 * Note this compares services, not quantities: Fullbay's order page exposes only
 * a yes/no "No Parts" flag per item, never a part COUNT, so "two parts for two
 * sensors" cannot be verified from here. The trade is deliberate — it clears the
 * common false positive, at the cost of not catching a case where one part was
 * added for three identical services.
 */
function normService(note) {
  return String(note || '')
    .toLowerCase()
    .replace(/^\s*\d*[a-z]?\s*-\s*/, '')   // drop a leading job code like "5F - "
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function siblingCarriesParts(so, ai) {
  const key = normService(ai.originalNote);
  if (!key || key.length < 4) return false; // too vague to match on
  return (so.actionItems || []).some((other) => other !== ai
    && !other.noParts
    && normService(other.originalNote) === key);
}

/*
 * Inspection photos are frequently attached to the SERVICE ORDER as a whole
 * rather than inside the inspection action item — one set covering front, back,
 * both sides, grease points, landing gear, mudflaps, tires, and so on. That is a
 * complete, compliant inspection; the photos just aren't nested under the item.
 *
 * So an inspection action item with zero photos of its own is NOT flagged when
 * the order carries a full set at SO level. The bar is a count, because Fullbay's
 * SO-level badge gives us a number and not the individual captions — a partial
 * handful of SO photos still gets flagged.
 */
// 1 = any attachment on the order counts. Inspection photos live at the top of
// the SO, and observed orders carry 5–6 of them, so demanding a fixed larger set
// only produced false positives.
const INSPECTION_SO_PHOTO_MIN = 1;

function inspectionCoveredBySoPhotos(so, min) {
  const need = Number.isFinite(min) ? min : INSPECTION_SO_PHOTO_MIN;
  return (so.soAttachmentCount || 0) >= need;
}

// A technician/writer note that explains parts weren't needed — used to suppress the
// "No Parts but billed labor" flag (Check B) so legitimate no-part jobs aren't flagged red.
const NO_PART_NEEDED_PATTERNS = [
  /\bno (new |additional )?parts?\b/i,                                  // "no part", "no parts", "no new parts"
  /\bparts?\b[^.]{0,25}\b(not|were ?n'?t|was ?n'?t|are ?n'?t|is ?n'?t)\b[^.]{0,15}\b(need|require|necessary|use)/i,
  /\b(not|did ?n'?t|do ?n'?t|does ?n'?t|with ?out)\b[^.]{0,18}\bneed(ed)?\b[^.]{0,12}\bparts?\b/i,
  /\bparts?\b[^.]{0,8}\bn\/?a\b|\bn\/?a\b[^.]{0,8}\bparts?\b/i,         // "parts n/a"
  /\b(part|parts) not needed\b/i,
  /\bshop suppl(y|ies)\b/i,                                            // "used shop supplies"
];
function notesJustifyNoParts(notes) {
  if (!notes || !notes.length) return false;
  const text = notes.map((n) => n.text || '').join('  •  ');
  return NO_PART_NEEDED_PATTERNS.some((re) => re.test(text));
}

/*
 * runAudit(so) — takes one service order object (built by the scraper) and
 * returns an array of findings. Mirrors runAudit() in the original HTML tool.
 *
 * Expected `so` shape:
 *   { soNumber, soAttachmentCount, actionItems: [
 *       { id, number, status, technician, originalNote,
 *         invoicedHours, actualHours, noParts, photoCount } ] }
 */
function runAudit(so, opts = {}) {
  const findings = [];
  const soPhotoMin = opts.inspectionSoPhotoMin;

  // --- Check C (whole-order): inspection complaint but no attachments on the SO ---
  const hasInsp = so.actionItems.some((ai) => classify(ai.originalNote).isInspection);
  if (hasInsp && so.soAttachmentCount === 0) {
    findings.push({
      check: 'C', severity: 'blocker',
      title: 'Inspection sheet not uploaded',
      detail: 'Complaint references an inspection (DOT/PM/Checklist) but no attachments are on the SO.',
    });
  }

  // --- Check E (whole-order): PO number must be exactly "MT-" + 8 letters/numbers ---
  // Catches missing POs and irregularities like a leading colon (": MT-..."),
  // extra spaces, wrong length, or stray characters.
  const PO_RE = /^MT-[A-Za-z0-9]{8}$/;
  const po = (so.poNumber || '').trim();
  if (!po) {
    findings.push({
      check: 'E', severity: 'blocker',
      title: 'No PO attached',
      detail: 'No PO number on the service order. Expected MT- followed by 8 letters/numbers.',
    });
  } else if (!PO_RE.test(po)) {
    findings.push({
      check: 'E', severity: 'blocker',
      title: 'Irregular PO number',
      detail: 'PO "' + po + '" is not valid — expected exactly MT- followed by 8 letters/numbers ' +
        '(no leading colon, spaces, or extra characters).',
    });
  }

  // --- Per action item: Checks A, B, D ---
  so.actionItems.forEach((ai) => {
    const cls = classify(ai.originalNote);
    const label = 'Action Item ' + (ai.number || ai.id);
    const invReady = /Ready To Invoice|Invoiced/i.test(ai.status);

    const tech = ai.technician || '';

    // Check A — photos. A repair should have BOTH a before and an after photo,
    // so repair items need at least 2. Any Ready/Invoiced item with zero photos
    // is always flagged.
    if (invReady) {
      if (ai.photoCount === 0) {
        // An inspection item whose photos live on the SO as a whole is fine.
        if (!(cls.isInspection && inspectionCoveredBySoPhotos(so, soPhotoMin))) {
          findings.push({
            check: 'A', severity: 'blocker', technician: tech,
            title: 'No photos on ' + label,
            detail: 'Status "' + ai.status + '" but image count is 0'
              + (cls.isInspection
                ? ' — and nothing is attached to the service order either, so there are no inspection photos anywhere.'
                : '. Before/after repair photos expected.'),
          });
        }
      } else if (cls.isRepair && ai.photoCount !== null && ai.photoCount < 2) {
        findings.push({
          check: 'A', severity: 'blocker', technician: tech,
          title: 'Only ' + ai.photoCount + ' photo on ' + label,
          detail: 'Repair work ("' + (ai.originalNote || '').slice(0, 50) +
            '") should have before AND after photos — only ' + ai.photoCount + ' attached.',
        });
      }
    }

    // Check B — marked No Parts but billed repair labor.
    // Exempt: shop-supply services (e.g. hand rubbers/seals), R/R (repair-or-replace)
    // services that often need no part, AND any item whose notes explain a part
    // wasn't needed (e.g. "no parts needed", "part not needed").
    if (ai.noParts && ai.actualHours > 0 && cls.isRepair && !cls.isInspection
        && !isShopSupply(ai.originalNote) && !isRR(ai.originalNote) && !notesJustifyNoParts(ai.notes)
        && !siblingCarriesParts(so, ai)
        // A tyre-pressure check reads as a repair only because "tire" is a repair
        // keyword. It consumes no parts, so it must not be flagged for missing them.
        && !isZeroHourService(ai.originalNote)) {
      findings.push({
        check: 'B', severity: 'blocker', technician: tech,
        title: 'Parts not added to ' + label,
        detail: 'Billed ' + ai.actualHours.toFixed(2) + ' hr of repair work ("' +
          (ai.originalNote || '').slice(0, 60) + '") but marked No Parts.',
      });
    }

    // Check D — service at Ready/Invoiced status with 0.00 invoiced hours.
    // These need labor time entered in Fullbay before the order can be invoiced.
    // (The old "hours variance" check was removed; this flags missing hours, not variance.)
    if (invReady && ai.invoicedHours === 0 && !isZeroHourService(ai.originalNote)) {
      findings.push({
        check: 'D', severity: 'blocker', technician: tech,
        title: 'No invoiced hours on ' + label,
        detail: 'Invoiced hours is 0.00 — labor time needs to be entered in Fullbay before invoicing.',
      });
    }
  });

  return findings;
}

module.exports = {
  classify, runAudit, isServiceCall, isRR, siblingCarriesParts, normService,
  isZeroHourService, ZERO_HOUR_SERVICES,
  inspectionCoveredBySoPhotos, INSPECTION_SO_PHOTO_MIN, INSP_KW, REP_KW,
};

/* ----------------------------------------------------------------------------
 * OPEN SERVICE ORDERS
 *
 * A different job from the Ready-to-Invoice audit. Those orders are finished and
 * being checked before they go out; these are still being worked, so the
 * question is "what is stalling this order?" rather than "is it billable yet?".
 *
 * Checks A/B/D deliberately only fire at Ready/Invoiced status, so they stay
 * silent here. These O-checks cover the same ground for work in progress.
 * -------------------------------------------------------------------------- */

// The effective state of an action item. The status dropdown is often blank on an
// open order, where the truth sits in the progress steps instead.
function itemState(ai) {
  return String(ai.stepStatus || ai.status || '').trim();
}

const DONE_RE = /^(done|complete|completed|ready to invoice|invoiced)$/i;
const NOT_STARTED_RE = /^(open|waiting to be assigned|diagnose)$/i;
const IN_PROGRESS_RE = /^(repair in progress|in progress)$/i;
const QUOTE_RE = /waiting on parts pricing|needs? quote|quote needed|awaiting quote/i;

/**
 * runOpenAudit(so, opts) — what is outstanding on an order that is still open.
 * `so` is the same shape the Ready-to-Invoice audit uses, plus `ageText` from
 * the Open SOs list. Returns findings using O-prefixed checks.
 */
function runOpenAudit(so, opts = {}) {
  const findings = [];
  const staleDays = Number.isFinite(opts.staleDays) ? opts.staleDays : 3;

  // O1 — the order as a whole has been sitting too long.
  const days = ageInDays(so.ageText);
  if (days !== null && days >= staleDays) {
    findings.push({
      check: 'O1', severity: days >= staleDays * 3 ? 'blocker' : 'warning',
      title: 'Open ' + so.ageText,
      detail: `This order has been open for ${so.ageText} (service status "${so.serviceStatus || 'unknown'}").`,
    });
  }

  (so.actionItems || []).forEach((ai) => {
    const label = 'Action Item ' + (ai.number || ai.id);
    const state = itemState(ai);
    const tech = ai.technician || '';
    const cls = classify(ai.originalNote);
    if (DONE_RE.test(state)) return; // finished items are not this section's problem

    // O2 — still being worked.
    if (IN_PROGRESS_RE.test(state)) {
      findings.push({
        check: 'O2', severity: 'warning', technician: tech,
        title: label + ' still in progress',
        detail: `"${(ai.originalNote || '').slice(0, 60)}" is at "${state}".`,
      });
    }

    // O3 — never started.
    if (NOT_STARTED_RE.test(state)) {
      findings.push({
        check: 'O3', severity: 'warning', technician: tech,
        title: label + ' not started',
        detail: `"${(ai.originalNote || '').slice(0, 60)}" is still at "${state}".`,
      });
    }

    // O4 — parts were begun but never priced.
    if (ai.needsQuote || QUOTE_RE.test(state)) {
      findings.push({
        check: 'O4', severity: 'blocker', technician: tech,
        title: 'Parts awaiting a quote on ' + label,
        detail: `Parts on "${(ai.originalNote || '').slice(0, 60)}" are waiting on pricing, which holds up the whole order.`,
      });
    }

    // O5 — a repair with no parts. R/R legitimately needs none, and the same
    // exemptions as Check B apply so the two sections agree with each other.
    if (ai.noParts && cls.isRepair && !cls.isInspection
        && !isRR(ai.originalNote) && !isShopSupply(ai.originalNote)
        && !isZeroHourService(ai.originalNote) && !notesJustifyNoParts(ai.notes)
        && !siblingCarriesParts(so, ai)) {
      findings.push({
        check: 'O5', severity: 'warning', technician: tech,
        title: 'No parts on ' + label,
        detail: `Repair work ("${(ai.originalNote || '').slice(0, 60)}") is marked No Parts.`,
      });
    }

    // O6 / O7 — photos. Same expectation as a finished order: something for any
    // item, before AND after for a repair.
    if (ai.photoCount === 0) {
      findings.push({
        check: 'O6', severity: 'warning', technician: tech,
        title: 'No photos on ' + label,
        detail: `Nothing photographed yet on "${(ai.originalNote || '').slice(0, 60)}".`,
      });
    } else if (cls.isRepair && ai.photoCount !== null && ai.photoCount < 2) {
      findings.push({
        check: 'O7', severity: 'warning', technician: tech,
        title: 'Only ' + ai.photoCount + ' photo on ' + label,
        detail: `Repair work needs a before AND an after photo — ${ai.photoCount} attached.`,
      });
    }
  });

  return findings;
}

/** "8d 5h" / "11h 17m" / "0h 8m" -> days, or null when it cannot be read. */
function ageInDays(text) {
  const t = String(text || '');
  if (!t.trim()) return null;
  const d = (t.match(/(\d+)\s*d/i) || [])[1];
  const h = (t.match(/(\d+)\s*h/i) || [])[1];
  const m = (t.match(/(\d+)\s*m/i) || [])[1];
  if (d === undefined && h === undefined && m === undefined) return null;
  return (+(d || 0)) + (+(h || 0)) / 24 + (+(m || 0)) / 1440;
}

module.exports.runOpenAudit = runOpenAudit;
module.exports.itemState = itemState;
module.exports.ageInDays = ageInDays;

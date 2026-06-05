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
function runAudit(so) {
  const findings = [];

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
        findings.push({
          check: 'A', severity: 'blocker', technician: tech,
          title: 'No photos on ' + label,
          detail: 'Status "' + ai.status + '" but image count is 0. Before/after repair photos expected.',
        });
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
        && !isShopSupply(ai.originalNote) && !isRR(ai.originalNote) && !notesJustifyNoParts(ai.notes)) {
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
    if (invReady && ai.invoicedHours === 0) {
      findings.push({
        check: 'D', severity: 'blocker', technician: tech,
        title: 'No invoiced hours on ' + label,
        detail: 'Invoiced hours is 0.00 — labor time needs to be entered in Fullbay before invoicing.',
      });
    }
  });

  return findings;
}

module.exports = { classify, runAudit, isServiceCall, isRR, INSP_KW, REP_KW };

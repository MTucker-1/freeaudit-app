/*
 * parts.js — read each service's PARTS and QUANTITIES off Fullbay's parts list,
 * and say whether they match what the service calls for.
 *
 * Why a separate page: an action item's own markup carries nothing parts-like
 * (an earlier probe found zero part rows inside it). Parts live on
 * partsList.html, one page per repair order.
 *
 * How the page is laid out, established by walking it in document order:
 * each service's parts are listed one after another and the block is CLOSED by
 * that service's "Add Part" row, whose quantity box is id="newPartQuantity<id>".
 * So parts accumulate until an add-row is reached, and they belong to it. The
 * add-rows appear in the same order as the services listed in the page's
 * "Choose Complaint / Correction" list, which is how each block gets its name.
 * Verified on SO-12329: AIR BAG (3) -> 3 air springs, TIRE REPLACEMENT (2) ->
 * 2 tires and 2 casing fees, BRAKE SET (4) -> 4 shoe kits.
 */

/* A tire is named by its SIZE, never by the word "tire" — "FCR-T2 295/75R22.5".
 * Matching the size pattern covers every brand and vendor without a list that
 * somebody has to maintain. */
const TIRE_RE = /\b\d{3}\/\d{2}R\d{2}(\.\d)?\b/;
const CASING_RE = /casing\s*\+?\s*(and|&)?\s*disposal/i;
/* An air bag part is described as an air SPRING. The service says "AIR BAG", the
 * part never does, so the two have to be bridged explicitly. */
const AIRBAG_PART_RE = /\bair\s*(spring|bag)\b/i;

/*
 * What a service calls for. Returns null for anything we have no rule about, so
 * an unknown service is never flagged — silence is the right default when the
 * check can hold an invoice.
 *
 * "(n)" in the name is the count: "TIRE REPLACEMENT (2)". INNER/OUTER tire jobs
 * carry no number and mean one.
 */
function expectationFor(service) {
  const s = String(service || '').toUpperCase();
  const m = s.match(/\((\d{1,2})\)/);
  const stated = m ? parseInt(m[1], 10) : null;

  if (/TIRE\s*REPLACEMENT/.test(s)) {
    // INNER / OUTER name a single position, so one tire unless a count says more.
    const n = stated !== null ? stated : 1;
    return { kind: 'tire', want: [
      { label: 'tire', plural: 'tires', n, match: (d) => TIRE_RE.test(d) },
      // "casing + disposal fees" reads wrong; the line is a fee either way.
      { label: 'casing + disposal fee', plural: 'casing + disposal fees', n, match: (d) => CASING_RE.test(d) },
    ] };
  }
  if (/AIR\s*BAG/.test(s)) {
    const n = stated !== null ? stated : 1;
    return { kind: 'airbag', want: [{ label: 'air bag', plural: 'air bags', n, match: (d) => AIRBAG_PART_RE.test(d) }] };
  }
  return null;
}

/*
 * Read partsList.html for one order. `page` is a Playwright page already signed
 * in; it is navigated to the parts page, so pass a page that is not the one the
 * audit is reading the order from.
 */
async function readOrderParts(page, baseUrl, repairOrderId) {
  await page.goto(`${baseUrl}/office/workorder/partsList.html?repairOrderId=${repairOrderId}`,
    { waitUntil: 'domcontentloaded', timeout: 60000 });
  /* The blocks are rendered after the page settles. networkidle alone returned
   * nothing on 5 of 12 live orders — wait for the markup we actually read. */
  await page.waitForSelector('[id^="newPartQuantity"]', { timeout: 25000 }).catch(() => {});
  return page.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    /* Service names come from the "move parts" picker, which lists EVERY service
     * on the order in block order. Reading every <option> on the page and keeping
     * only "5F -" ones dropped the shop's own free-text complaints ("Damaged door
     * seal"), so the names fell out of step with the blocks and parts would have
     * been credited to the wrong service. */
    const sel = document.querySelector('[id^="movePartsRepairOrderActionItemCorrectionId"]');
    const names = sel
      ? Array.from(sel.options).map((o) => clean(o.textContent))
        .filter((t) => t && !/^choose\b/i.test(t))
      : [];
    const blocks = [];
    let pending = [];
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    for (let n = walk.currentNode; n; n = walk.nextNode()) {
      const id = n.id || '';
      if (/^quantity\d+$/.test(id) && n.tagName === 'INPUT') {
        let tr = n;
        for (let i = 0; i < 8 && tr; i++) { tr = tr.parentElement; if (tr && tr.tagName === 'TR') break; }
        const raw = tr ? clean(tr.textContent) : '';
        const desc = raw.replace(/^Updating Part\.\.\.\s*/, '').split('$')[0].trim();
        const qty = parseFloat(n.value);
        if (desc) pending.push({ desc: desc.slice(0, 90), qty: Number.isFinite(qty) ? qty : 0 });
      } else if (/^newPartQuantity\d+$/.test(id)) {
        // This add-row closes the current service's block.
        blocks.push({ correctionId: id.replace('newPartQuantity', ''), parts: pending });
        pending = [];
      }
    }
    return { names, blocks };
  });
}

/*
 * Compare each service's parts with what it calls for.
 * Returns [{ service, label, want, got }] for mismatches only.
 */
function partQuantityProblems({ names, blocks }) {
  const out = [];
  blocks.forEach((b, i) => {
    const service = names[i] || '';
    if (!service) return;                       // no name for this block: say nothing
    const exp = expectationFor(service);
    if (!exp) return;                           // no rule for this service
    for (const w of exp.want) {
      const got = b.parts.filter((p) => w.match(p.desc)).reduce((n, p) => n + p.qty, 0);
      // The option text is "5F - TIRE REPLACEMENT (2) - TWO TIRE REPLACEMENTS…";
      // keep the service, drop the description that follows it.
      const name = service.split(' - ').slice(0, 2).join(' - ').trim() || service;
      if (got !== w.n) out.push({ service: name, label: w.label, plural: w.plural || w.label + 's', want: w.n, got });
    }
  });
  return out;
}

module.exports = { readOrderParts, partQuantityProblems, expectationFor, TIRE_RE, CASING_RE, AIRBAG_PART_RE };

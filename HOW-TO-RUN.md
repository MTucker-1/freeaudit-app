# FLSS Ready-to-Invoice Auditor — How to run it

This tool logs into Fullbay, opens every service order that's in **Ready to Invoice**,
reads its Action Items tab, and runs these checks:

- **A · Photos** — Ready/Invoiced items with zero photos; repair items with fewer than 2
  photos (a repair should have a *before* and an *after* shot)
- **B · Parts** — "No Parts" but billed repair labor
- **C · Inspections** — DOT/PM/inspection complaints with no attachment (paperwork) on the SO
- **D · Hours** — Ready/Invoiced services with 0.00 invoiced hours (need labor entered in Fullbay)
- **E · PO** — missing, irregular (e.g. leading colon), or duplicated PO numbers
  (a valid PO is "MT-" followed by exactly 8 letters/numbers)
- **F · Duplicate photo** — the exact same photo (byte-for-byte) reused on a **different**
  service order — catches reused/"pencil-whipped" photos. (Reuse within one order is ignored.)

The report also shows **clickable photo thumbnails** for each action item (click to enlarge);
reused-across-orders photos are outlined in red with a "REUSED" badge. Photos are saved into
a **photos/** folder next to the report so the thumbnails display offline. That folder is
rebuilt fresh on each run.

(The original "hours variance" check was removed because the actual-hours data isn't reliable;
Check D now flags missing invoiced hours instead.)

## Running it

1. Open **PowerShell** (Start menu → type "PowerShell" → Enter).
2. Go to the folder:
   ```
   cd C:\Users\mitch\flss-audit
   ```
3. Run the audit:
   ```
   node audit.js
   ```
4. A Chrome window opens.
   - **First time / after Fullbay logs you out:** log in by hand in that window. The tool waits, then continues on its own. Your login is remembered for next time.
   - **Normally:** it goes straight to work — no login needed.
5. When it finishes, two files are written into this folder:
   - **audit-report.html** — open it in your browser to see the styled report.
   - **audit-results.csv** — open it in Excel.

## Test on just a few first (optional)

Open **config.json** and change `"maxOrders": 0` to `"maxOrders": 5` to audit only the
first 5 orders. Set it back to `0` to do all of them.

## Other settings (config.json)

- **listUrl** — the page that shows the Ready-to-Invoice table. Change only if it moves.
- **headless** — `false` shows the browser (recommended). `true` runs it hidden.
- **slowDownMs** — pause between pages; increase if the site is loading slowly.
- **checkDuplicatePhotos** — `true` downloads and fingerprints every photo to catch reused
  ones (Check F). Set to `false` for a much faster run that skips photo duplicate detection.
- **imageLimit** — max photos fetched per action item when fingerprinting (default 50).

## If something breaks

Run the calibration probe, which prints detailed diagnostics:
```
node audit.js probe
```
Then share what it prints.

## How it finds the orders (for reference)

The Ready-to-Invoice list doesn't put a clickable link on each row. The order ID is
stored in the table's data (a `windowOpen` field). The tool reads those IDs and opens
each order directly at:
`https://app.fullbay.com/office/workorder/viewRepairOrder.html?repairOrderId=<ID>`

# FreeAudit

Audits every Fullbay service order sitting in **Ready to Invoice** before it goes out the
door — photos, parts, inspection paperwork, labor hours, PO numbers, the completion
tracker, and Vorto — then writes a report you can hand to a service writer.

FreeAudit runs **on your own PC** with **your own** Fullbay and Vorto logins. Nothing is
hosted, nothing is exposed to the network, and no credentials ever leave your machine.

---

## Which install do I need?

| You are… | Use |
|---|---|
| A teammate who just wants to run audits | **[TEAM-INSTALL.md](TEAM-INSTALL.md)** — download `FreeAudit-Setup.exe`, run it, enter your logins |
| Working on the code | This file + **[HOW-TO-RUN.md](HOW-TO-RUN.md)** |
| **Hosting FreeAudit / plugging it into another app** | **[INTEGRATION.md](INTEGRATION.md)** — architecture, the multi-tenancy contract, Docker, output schema |

An installed copy **updates its own code on launch**, so teammates never reinstall for a
code change.

---

## First run (every install)

1. Open FreeAudit from the desktop icon.
2. Create your account with the **access code** (Settings → `signupCode`, currently `FLSS2026`).
3. Open **Settings** and enter **your own**:
   - Fullbay email + password — required; without it a run just stalls on a login page
   - Vorto phone + password — required for the MT-resolved check (H)
4. Click **Run Audit**.

The app shows a setup notice on the dashboard until both logins are saved.

---

## The checks

| | Check | Scope | Severity |
|---|---|---|---|
| A | Photos — Ready/Invoiced items with no photos; repairs with fewer than 2 (before **and** after) | action item | blocker |
| B | "No Parts" but billed repair labor — exempt: shop supplies, R/R, notes explaining no part was needed | action item | blocker |
| C | Inspection complaint (DOT/PM/checklist) with no attachment on the order | order | blocker |
| D | Ready/Invoiced with 0.00 invoiced hours | action item | blocker |
| E | PO number must be exactly `MT-` + 8 letters/numbers | order | blocker |
| F | The same photo (byte-for-byte) reused on a **different** order | order | blocker |
| G | Unit not marked complete in the tracker — inspection orders only | order | warning |
| H | Order's MT not resolved in the Vorto vendor portal | order | blocker if open |

A/B/C/D/E live in `checks.js`; F/G/H are computed in `audit.js` where they need
cross-order or live-lookup context.

---

## Running from source

```powershell
node server.js          # the web app on http://localhost:4477
node audit.js           # one full audit, straight to the report files
node audit.js probe     # diagnostics if something breaks
```

Or double-click **`Start FreeAudit (dev).bat`**, which runs `watch-server.js` and restarts
the app whenever `server.js` changes.

## Layout

| File | Does |
|---|---|
| `server.js` | Local web app: accounts, settings, run control, report serving |
| `audit.js` | Playwright scraper + report/CSV writer; checks F, G, H |
| `checks.js` | Checks A–E — pure functions over one service order |
| `settings.js` | Reads `config.json` merged over shipped defaults |
| `gsheets.js` | Live Google Sheets read for the completion tracker (G) |
| `vorto.js` | Vorto vendor-portal lookups (H) |
| `installer/` | Launcher, self-updater, and the Inno Setup script |
| `build-installer.ps1` | Builds `FreeAudit-Setup.exe` |
| `publish-update.ps1` | Bumps the version and pushes — installs self-update on next launch |

## Publishing a change

```powershell
.\publish-update.ps1 "what changed"
```

Bumps `version.json`, commits, pushes. Every installed copy picks it up on its next
launch. Rebuild the installer (`.\build-installer.ps1`) only when Node, the browser
engine, or `node_modules` change — a new dependency needs a fresh installer, because the
updater ships code only.

## What stays local

`config.json`, `users.json`, `sessions.json`, every `*-credentials.json`, the saved browser
profiles (`.fb-profile/`, `.vorto-profile/`), downloaded photos, and generated reports are
all gitignored. `publish-update.ps1` refuses to push if any of them is tracked.

# FreeAudit — team install & auto-update

FreeAudit now installs on **each person's own Windows PC** and runs **locally** on
their machine. Each person uses **their own** Fullbay + Vorto logins, and every
copy **auto-updates its code** on launch from one central place. No always-on
server, no dependency on anyone's computer being on.

---

## For a teammate (getting it) — 4 steps
1. **Download** `FreeAudit.exe` from the link you were given and **double-click it**.
   There is no installer: it's one file, no admin needed.
   - **Windows may show a blue "Windows protected your PC" box** (the app isn't
     code-signed). Click **More info → Run anyway.** Expected for an in-house app.
   - The first run sets FreeAudit up in **`C:\FreeAudit`** (about a minute) and
     puts a **FreeAudit** icon on the desktop. Use that icon from then on; the downloaded
     file can be deleted.
2. FreeAudit opens. Create your account using the **access code** (`FLSS2026`).
3. Open **Settings** and enter **your own** Fullbay email/password and Vorto
   phone/password, then **Save settings**.
4. Click **Run Audit**.

Already have the old installer version? Just run `FreeAudit.exe` once. It moves
your install from `AppData\Local\Programs\FreeAudit` to `C:\FreeAudit`, logins,
settings and scheduled runs included, and points your icons at the new launcher.

### Where it lives
- Everything is in **`C:\FreeAudit`**, never in Windows or System32. The folder
  is locked to your Windows account (plus administrators), because it holds your
  Fullbay and Vorto logins. A second Windows user on the same PC gets
  `C:\FreeAudit-<their name>`.
- Nothing is downloaded at run time: Node, the browser engine, every npm
  package and the OCR data ship inside `FreeAudit.exe`. After unpacking it checks
  they are all there, re-unpacks once if antivirus removed something, and
  otherwise says which file is missing. Edge (for the app window) and .NET
  Framework 4 (for the launcher) come with every Windows 10/11 PC.

### If FreeAudit won't open
A small **Starting FreeAudit...** window shows while it starts; the app opens by
itself once it's ready. If it can't start, that window says why. Click
**Try again**, or **Open log folder** (`C:\FreeAudit\logs`) and send the newest
`engine-*.log` to the admin.

### Your logins are yours
Every install starts with blank credential files. What you type in Settings stays
on your PC — in your install folder — and is never shared with anyone else or
sent anywhere. Your saved Fullbay browser session lives there too, so audits sign
in as **you**, and the work shows in Fullbay under your name.

Upgrading does not touch any of it: the installer only writes `config.json` and
the credential files when they don't already exist.

### What the buttons do
- **Techs** (left of Run) — whose orders the runs below work on. **Select all**
  covers every tech, including new ones; or tick just your team. Run Audit, Run
  Open Audit and Fix Addresses then skip everyone else's orders, so teams can
  run at the same time without working through each other's orders. Saved on
  your PC; the button turns white when it is narrowed, and every report says
  which techs it covers. **Refresh list from Fullbay** picks up new names.
- **Run Audit** — Ready-to-Invoice orders. Read-only; changes nothing in Fullbay.
- **Run Open Audit** — orders still being worked: how long open, what is still
  in progress, missing parts or photos. Also read-only.
- **Fix Addresses** — the only action that WRITES to Fullbay. Sets Bill To /
  Ship To on each estimate to match that order's labour location. Asks first.
- **Scorecard** — week by week, who submits orders and what they keep missing.

## For the admin (you) — one-time setup

### A) Distribute FreeAudit.exe (the "one link, forever")
- Build it with `.\build-portable.ps1`; the file is `installer-build\portable\FreeAudit.exe`.
  (`.\build-installer.ps1` still builds the old `FreeAudit-Setup.exe` if ever needed.)
- Upload it once to **Google Drive or Dropbox** and share that link. That **one
  link never changes** — every new teammate, now or later, uses the same link +
  the same access code. (It's just a file in storage, so it's always available
  regardless of whose computer is on.)
- Only rebuild when Node, the browser engine or dependencies change (rare) —
  code AND launcher changes reach everyone through auto-update. Replace the file
  at the same link.

### B) Auto-update channel — already set up
Updates are published from this repo:

- **Repo:** `MTucker-1/freeaudit-app` (public, code only — never secrets)
- Baked into every installer by `build-installer.ps1`, which writes `update.json`
  next to the app.
- On launch, `installer\update.ps1` compares the installed version against
  `version.json` on `main`. Newer? It pulls the code zip and swaps in the app
  code only — never `node.exe`, the browser engine, `node_modules`, credentials,
  `config.json`, or saved logins.
- It **fails safe**: offline, a bad download, or an unset channel all mean "keep
  the current version and run it."

Nothing to do here unless you move the repo — then change the `repo` line in
`build-installer.ps1` and rebuild the installer once.

### C) Publish an update (any time you/Claude change the code)
```powershell
.\publish-update.ps1 "what changed"
```
This bumps the version and pushes the code. **Every installed copy updates itself
on its next launch** — no re-installs, no new links. The big stuff (Node, browser
engine) stays local and never re-downloads; only the lightweight code refreshes.

---

## Security notes (read once)
- **Per-user logins stay local.** Each person's Fullbay/Vorto credentials live
  only on their own PC (in their install folder) — never in the repo, never shared.
- **The update repo is CODE ONLY.** `.gitignore` blocks all secrets and data
  (credentials, the Google service account, config, accounts, photos, reports).
  `publish-update.ps1` also refuses to run if a secret is accidentally tracked.
- **Bundled shared item:** the installer includes the **read-only Google Sheets
  service account** so the "complete in tracker" check works for everyone without
  each person setting up Google. It can only *read* the shop trackers. If you'd
  rather not distribute it, tell Claude to leave it out (the sheet check then
  needs per-user Google setup).
- **Access code** (`FLSS2026`) gates who can use a downloaded installer. Change it
  anytime in Settings → it's the `signupCode`.

---

## What changed vs. the old setup
- The old `free-audit.tail94d726.ts.net` tunnel link and the "runs on your PC,
  exposed to the internet" model are **retired** — nothing is exposed from your
  machine anymore. You can turn the tunnel off:
  `tailscale funnel --https=443 off`.
- Everyone now runs their own local, auto-updating copy.

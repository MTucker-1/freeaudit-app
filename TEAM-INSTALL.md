# FreeAudit — team install & auto-update

FreeAudit now installs on **each person's own Windows PC** and runs **locally** on
their machine. Each person uses **their own** Fullbay + Vorto logins, and every
copy **auto-updates its code** on launch from one central place. No always-on
server, no dependency on anyone's computer being on.

---

## For a teammate (installing it) — 3 steps
1. **Download** `FreeAudit-Setup.exe` from the link you were given and run it
   (no admin needed — it installs just for you).
   - **Windows may show a blue "Windows protected your PC" box** (because the
     installer isn't code-signed). Click **More info → Run anyway.** This is
     expected for an in-house app. (To remove this warning entirely we'd need a
     paid code-signing certificate — optional, see notes below.)
2. **Open FreeAudit** from the desktop icon. Create your account using the
   **access code** (`FLSS2026`).
3. Open **Settings** and enter **your own** Fullbay email/password and Vorto
   phone/password. Save. That's it — click **Run Audit** anytime.

Their copy runs entirely on their PC, with their logins, and quietly updates
itself whenever you publish a new version.

---

## For the admin (you) — one-time setup

### A) Distribute the installer (the "one link, forever")
- The built file is `installer-build\FreeAudit-Setup.exe`.
- Upload it once to **Google Drive or Dropbox** and share that link. That **one
  link never changes** — every new teammate, now or later, uses the same link +
  the same access code. (It's just a file in storage, so it's always available
  regardless of whose computer is on.)
- When you ship a new installer (only needed if Node/browser/deps change — rare),
  replace the file at the same link.

### B) Turn on auto-update (GitHub channel) — ~5 minutes, needs your GitHub login
Auto-update is built in but **dormant until you point it at a repo.** Do this once:

1. Create a **free GitHub account** (if you don't have one) and a **new public
   repository**, e.g. `freeaudit-app`. (Public so installs can pull updates with
   no token. Only CODE goes there — never secrets; see Security below.)
2. In this folder, set up git and push the code (PowerShell):
   ```powershell
   git init
   git add -A
   git commit -m "FreeAudit v1.0.0"
   git branch -M main
   git remote add origin https://github.com/<your-username>/freeaudit-app.git
   git push -u origin main
   ```
   (Git will prompt you to sign in to GitHub the first time.)
3. Tell FreeAudit where to look: open **`installer\config`**… actually set the
   repo in the build by editing `build-installer.ps1` — change the update line's
   `"repo": "OWNER/REPO"` to `"repo": "<your-username>/freeaudit-app"`, then
   re-run `.\build-installer.ps1` once. That bakes the channel into the installer
   you distribute. (Claude can do this for you — just give the repo name.)

After that, the workflow forever is:

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

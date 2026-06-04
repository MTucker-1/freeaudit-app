# FreeAudit — setup & use

FreeAudit is a small web app that runs **on this computer**. You open it in a browser
like a website, click **Run Audit**, watch live progress, and see the report — with the
photos, technician names, PO checks, and the "complete in sheet" check all in one place.

Because it must use your Fullbay login and read your local Excel export, it runs here, not
in the cloud. You can still reach it from elsewhere through a private secure link (below).

---

## Daily use (on this computer)

1. Double-click the **FreeAudit** icon on your Desktop. It opens in its own app window —
   no web address, no browser tabs, no domain needed. (A minimized "FreeAudit" engine window
   runs in the background; closing it stops the app.)
2. Before a run, make sure the **tracker is current**: open the Google Sheet, do
   **File → Download → Microsoft Excel (.xlsx)**, and save it into this folder
   (`C:\Users\mitch\flss-audit`). FreeAudit automatically uses the newest .xlsx.
3. Click **Run Audit**. A Chrome window opens; if it shows a Fullbay login, sign in once
   (it's remembered afterward). Progress streams on the page.
4. When it finishes, the report appears at the bottom and **View Report** / **Download CSV**
   become available.
5. To stop the app, close the black window.

**Settings** (gear/Settings section on the page): how many orders to audit, which checks run,
the tracker file/year, and the remote-access password. Click **Save settings**.

---

## Reaching FreeAudit from anywhere (public link — LIVE)

FreeAudit is published to a permanent public web address using **Tailscale Funnel**:

### >>> https://free-audit.tail94d726.ts.net <<<

Anyone can open that link in any browser, on any network — no Tailscale or install needed on
their end. They then **create an account using the signup code** (see Settings → "Signup code",
currently `FLSS2026`) and sign in. The login + signup code are what protect your data.

### How it was set up (for reference / if it ever needs redoing)
- Tailscale is installed on this PC and signed in.
- The device is named **free-audit** (so the public address has no personal name).
  To rename: `tailscale set --hostname=free-audit`, then `tailscale serve reset`
  and `tailscale funnel --bg 80` to republish under the new name.
- Funnel is enabled and running: `tailscale funnel --bg 80` (publishes local port 80).
- Check it: `tailscale funnel status`. Turn it off: `tailscale funnel --https=443 off`.

### Important notes
- The PC must be **on, with FreeAudit running and Tailscale running**, for the public link to work.
- Tailscale restarts automatically with Windows; just make sure FreeAudit itself is running
  (the **FreeAudit desktop icon**).
- The **first Fullbay login (and any re-login)** has to be done **at this PC**, because the
  Chrome window opens here. Routine runs work remotely once the session is saved.
- The Excel tracker is read from **this PC's folder** — keep exporting it here.

---

## If `node` isn't found when double-clicking
Node.js is installed at `C:\Program Files\nodejs`. The launchers use the full path, so this
shouldn't happen — but if it does, restart the computer once so Windows picks up Node on PATH.

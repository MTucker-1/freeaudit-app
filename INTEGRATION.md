# FreeAudit — integration guide

**For the developer folding FreeAudit into the FLSS mechanic-map dashboard.**

You do not need to read the audit logic to integrate this. You need §1 (the one
hard constraint), §3 (the multi-tenancy contract), and §5 (outputs).

---

## 1. The one hard constraint: this cannot run on Vercel serverless

FreeAudit drives a real **Chromium via Playwright** against Fullbay, because
**Fullbay has no API** — the data is scraped from the logged-in web UI. That means
a run:

- takes **minutes**, not milliseconds (the app's own default cap is 30 min)
- needs a **writable disk** for downloaded photos and saved browser sessions
- needs a **persistent process**, since it holds a browser open across the run

Vercel functions cap at 60s (Hobby) / 800s max (Pro) with an ephemeral filesystem,
so the audit engine cannot live there. This is a platform-model mismatch, not a
configuration problem.

**What works:** any host that runs a long-lived container with a volume —
Render, Railway, Fly.io, ECS, or a plain VM. A `Dockerfile` is included and ready.

---

## 2. Recommended architecture

```
  Browser
     |
     v
  mechanic-map on Vercel            <- your existing dashboard + auth + database
     |  server-side fetch (never call the worker from the browser)
     v
  FreeAudit worker (container, always-on, volume mounted at /data)
     |
     +-- Fullbay      (Playwright, per-user session)
     +-- Vorto portal (Playwright, per-user session)     -> check H
     +-- Google Sheets API                               -> check G
```

The dashboard owns identity, per-user credential storage, and the UI. The worker
owns "run an audit and produce results". Keep the worker off the public internet:
put it behind a shared secret or private networking, and proxy through your own
API routes. The worker's built-in accounts (§6) are for standalone desktop use and
are **not** an authorization model for a hosted deployment.

---

## 3. Multi-tenancy: the `FREEAUDIT_DATA_DIR` contract

This is the whole integration surface, so it is worth understanding precisely.

The engine reads and writes **all** state — config, credentials, saved browser
sessions, downloaded photos, generated reports — inside one directory:

```
FREEAUDIT_DATA_DIR=/data/users/<your-user-id>
```

Unset, it defaults to the app folder (how the desktop install works). Set it, and
the entire engine relocates. `paths.js` is the single place this is resolved; code
paths (`public/`, `audit.js`) always resolve from `__dirname`, so they are never
affected.

**Give each user their own directory.** That is what keeps one person's Fullbay
session, credentials, and photos separate from another's. Two workspaces are fully
independent — no shared global state.

Because saved browser sessions live here, **`/data` must be a persistent volume.**
If you lose it, every user has to sign in to Fullbay again.

### Populating a workspace

Before starting a run, write these into the user's directory. All are plain JSON,
**UTF-8 without a BOM** (Node's `JSON.parse` rejects a BOM):

| File | Contents | Needed for |
|---|---|---|
| `fullbay-credentials.json` | `{"username":"…","password":"…"}` | Required — everything |
| `vorto-credentials.json` | `{"username":"…","password":"…"}` | Check H |
| `google-credentials.json` | `{"apiKey":"…"}` | Check G (live sheet read) |
| `google-service-account.json` | Google service-account JSON | Check G (alternative to the API key) |
| `config.json` | Any subset of the settings | Optional — see below |

`config.json` is **merged over shipped defaults** (`settings.js` → `DEFAULTS`), so
you only write the keys you want to change. Anything omitted still works. Useful keys:

- `maxOrders` — `0` = every order; a small number is ideal for a smoke test
- `checkSheetCompletion`, `checkVortoResolved` — turn checks G/H off
- `sheets` — array of Google Sheet URLs for the completion tracker
- `maxRunMinutes` — watchdog; the run is killed past this

Credentials must be **decrypted only at the moment you write them**. Store them
encrypted in your database (see §7).

---

## 4. Running it

### Docker (how you will deploy)

```bash
docker build -t freeaudit .
docker run -p 4477:4477 -v freeaudit-data:/data \
  -e PORT=4477 -e FREEAUDIT_HEADLESS=true \
  -e FREEAUDIT_DATA_DIR=/data/users/alice \
  freeaudit
```

### Headless CLI (no web server — the cleanest thing to call from a job queue)

```bash
FREEAUDIT_DATA_DIR=/data/users/alice FREEAUDIT_HEADLESS=true node audit.js
```

Writes its outputs into that workspace and exits. Progress streams on stdout, one
line per order, so you can relay it to a UI. This is usually a better integration
point than the bundled web server.

### Environment variables

| Var | Default | Purpose |
|---|---|---|
| `FREEAUDIT_DATA_DIR` | app folder | **The workspace.** Set per user. |
| `PORT` | `4477` | Injected by most hosts. Setting it also flips the bind to `0.0.0.0`. |
| `FREEAUDIT_BIND` | `127.0.0.1`, or `0.0.0.0` when `PORT` is set | Explicit listen address. |
| `FREEAUDIT_HEADLESS` | `false` | **Must be `true` in a container** — there is no display. |

---

## 5. Outputs — what your UI renders

Written into the workspace at the end of a run:

| File | Use |
|---|---|
| **`audit-results.json`** | **Start here.** Full structured results — build your own UI from this. |
| `audit-summary.json` | Small roll-up: counts, blockers, per-check totals, runtime. |
| `audit-results.csv` | Excel export (UTF-8 BOM so Excel renders dashes correctly). |
| `audit-report.html` | Standalone styled report. Serve as-is if you want zero UI work. |
| `photos/` | Downloaded photos. `audit-report.html` references these relatively. |

`audit-results.json` (`schema: 1`):

```jsonc
{
  "schema": 1,
  "generatedAt": "2026-09-01T18:00:00.000Z",
  "checkNames": { "A": "Photos", "B": "Parts", "...": "..." },
  "counts": { "orders": 42, "flaggedOrders": 17, "findings": 31,
              "blockers": 28, "duplicatePhotoGroups": 2 },
  "orders": [{
    "soNumber": "SO-100",
    "url": "https://app.fullbay.com/...",     // deep link back to Fullbay
    "customerName": "…", "unitNumber": "…", "serviceWriter": "…",
    "technicians": ["…"], "poNumber": "MT-AB12CD34",
    "actionItemCount": 2, "serviceCall": false,
    "sheetComplete": false, "sheetStatus": "In Progress",
    "vorto": { "resolved": false, "where": "open" },
    "error": null,
    "findings": [{
      "check": "H", "checkName": "Vorto", "severity": "blocker",
      "title": "…", "detail": "…", "technician": "Ray"
    }],
    "photos": [{
      "file": "p1.jpg", "aiNumber": "1", "technician": "Ray",
      "duplicate": true, "reusedOn": ["SO-200"]
    }]
  }]
}
```

`severity` is `"blocker"` or `"warning"`. An order with `findings: []` is clean.
`error` non-null means that order could not be read; treat it as needing a human,
not as passing.

---

## 6. The bundled web app (optional)

`server.js` is a complete standalone app — accounts, settings, live progress via
SSE, report viewing. Two ways to use it:

- **Ignore it.** Call `node audit.js` from your own job runner and render
  `audit-results.json`. Cleanest, and what §2 assumes.
- **Proxy it.** Mount it behind your dashboard for a fast first version, then
  replace the UI later.

Routes, if you proxy: `POST /api/run`, `/api/cancel`, `/api/connect-fullbay`,
`/api/connect-vorto`; `GET /api/status`, `/api/health`, `/api/summary`,
`/api/events` (SSE progress), `/api/config`, `/report`, `/report-csv`,
`/report-pdf`, `/photos/*`. All except register/login/me require its session cookie.

`/api/connect-fullbay` opens a **visible browser for a human to log into** — it is
meaningless headless. In a hosted deployment, sign-in must be handled by storing
credentials (§3) rather than by this route.

---

## 7. Security

- **The repo is code-only.** All secrets are gitignored: every `*-credentials.json`,
  the Google service account, `config.json`, `users.json`, `sessions.json`, saved
  browser profiles, photos, reports. `.dockerignore` repeats this so a build from a
  live working folder cannot bake in someone's data.
- **Per-user Fullbay/Vorto credentials must be encrypted at rest** in your
  database, with the key in the host's secret store — never in the repo. They are
  real credentials to a system that holds customer and billing data.
- **Do not distribute the built `FreeAudit-Setup.exe` publicly.** It bundles a
  read-only Google service account for the tracker check. Fine for internal
  distribution, not for a public link.
- The worker holds many users' credentials, which makes it a higher-value target
  than any single laptop was. Keep it private, patched, and access-logged.

---

## 8. Known risks — please read before scoping

1. **Fullbay logins from a datacenter IP may be challenged.** New-device checks
   or 2FA would block an unattended run. **Test this first with one real account** —
   it is the single biggest risk to this whole approach, and it is cheap to check.
2. **The scraper depends on Fullbay's DOM.** A Fullbay redesign breaks selectors.
   `node audit.js probe` prints diagnostics for exactly this.
3. **Runs are long and heavy.** One Chromium plus photo downloads per run. Queue
   them; don't run many concurrently on a small instance.
4. **`node_modules` is not updated by the desktop auto-updater** — a new dependency
   requires a fresh installer for desktop users. Irrelevant to the container, but it
   explains why `package.json` is excluded from `installer/update.ps1`.

---

## 9. Repo map

| Path | What |
|---|---|
| `audit.js` | Scraper + report writers; checks F, G, H. The engine. |
| `checks.js` | Checks A–E — pure functions over one service order. Easy to read. |
| `settings.js` | `config.json` merged over defaults, plus env overrides. |
| `paths.js` | `FREEAUDIT_DATA_DIR` resolution — the multi-tenancy contract. |
| `gsheets.js` | Live Google Sheets read (check G). |
| `vorto.js` | Vorto vendor-portal lookups (check H). |
| `server.js` | Standalone web app (optional — see §6). |
| `Dockerfile` | Container build, pinned to the matching Playwright image. |
| `installer/`, `build-installer.ps1` | Windows desktop distribution. Not used when hosted. |

**What the checks flag** is documented in [README.md](README.md); the CLI and
config options are in [HOW-TO-RUN.md](HOW-TO-RUN.md).

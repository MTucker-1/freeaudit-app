# FreeAudit → FLSS portal: what changed, and what you need to know

For whoever maintains **flss-mechanic-map.vercel.app**.

Your `agent.js` and its README landed here and both work. This is the reply: what
FreeAudit is now, what your agent will find, and the three things that will bite
if nobody tells you.

Repo: **https://github.com/MTucker-1/freeaudit-app** (public, code only — every
secret and all shop data is gitignored). Current version **1.0.9**.

---

## 1. Your contract is satisfied — with one addition

Everything your README lists is present in `audit-results.json` and verified
field by field:

- per order (`results[]`): `soNumber`, `url`, `customerName`, `unitNumber`,
  `serviceWriter`, `poNumber`, `technicians[]`, `actionItemCount`,
  `serviceCall`, `sheetComplete`, `sheetStatus`, `notes[]`, `error`, `findings[]`
- per finding: `check`, `severity`, `title`, `detail`, `technician`
- per photo (`photos[]`): `soNumber`, `aiNumber`, `technician`, `hash`, plus `dupInfo`

**Added for you:** `vortoResolved` (bool) and `vortoStatus` (string) on each
order. Your agent already reads them and they were missing — Vorto is a large
share of blockers on a typical run, so those findings had no supporting state.

**What `vortoResolved` means changed in 1.0.8, and it matters for how you show
it.** The lookup used to match on the UNIT first and fall back to the MT. A unit
routinely carries several MTs — one resolved, another still open — so an order
whose own MT was still open passed because a different MT on the same trailer had
been closed. That was a false pass on an order that is not ready to invoice.

It now matches the MT on the SO **exactly**, and nothing else. `vortoResolved`
therefore answers "is THIS order's MT resolved", not "has this trailer ever been
resolved". Three outcomes reach you: resolved, open (with the portal's own status
in `vortoStatus`), and not-in-the-portal-at-all. Orders with no MT are the only
ones still matched by unit, and the raw result carries `matchedBy: 'unit'` so that
weaker evidence can be labelled differently if you want to.

**`audit-results.json` is a superset, not the file your patch would have made.**
It already existed with a `schema: 1` structure (`counts`, `orders[]`) that the
report and scorecard read. Your suggested patch added a *second* writer for the
same filename; it ran last and silently replaced that structure. So the raw
`results` / `photos` / `dupInfo` your agent wants are now emitted **alongside**
the existing keys, from one writer. Read `results`, ignore `orders`.

---

## 2. Three things that will bite

**a) `billed` mode no longer exists.** Your agent can queue `kind: 'billed'` →
`node audit.js billed`. That mode was removed with the efficiency scorecard.
`audit.js` used to fall through to a **full audit** for any unrecognised mode, so
a billed job would have run a 4-minute scrape and overwritten the report. It now
refuses unknown modes and exits **2**, which your agent already treats as failed.
Please drop `billed` from the portal's job kinds.

**b) `signin` cannot work remotely.** `kind: 'signin'` → `node audit.js login`,
which deliberately never auto-fills and waits **15 minutes for a human**, because
this Fullbay account signs in through Microsoft SSO. Nobody is at the host when
the portal asks. It will tie up the agent and then fail. Either drop it, or make
it clear in the UI that someone must be at that PC.

**c) The agent and the local app share one browser profile.** Your README notes
this; it is worth restating because the failure is silent. A second process
touching `.fb-profile` makes Playwright report *"Opening in existing browser
session"* and hand back a dead `about:blank` window — the run appears to start
and does nothing. The portal enforces one active run on its side, but nothing
stops someone pressing **Run Audit** locally mid-run. `audit.js` now clears a
genuinely stale profile lock on launch, but a truly concurrent run still loses.

---

## 3. The deployment model changed — this affects your host handling

FreeAudit is **not** one shared instance. Each person installs
`FreeAudit-Setup.exe` on their own PC and enters **their own** Fullbay and Vorto
credentials. Their credentials, browser session, config and reports never leave
that machine, and audits appear in Fullbay under their name.

So there is no single host. If the portal is to drive audits, expect **one agent
per PC**, each with its own `host` in `agent-credentials.json` — your `claim`
already takes `host`, so the shape is right. Two consequences:

- A queued run has to target a host, or you get whichever agent claims first —
  and it will run under *that* person's Fullbay login.
- A host is only reachable while that person's PC is on with the agent running.

There is no always-on host today. The earlier Tailscale tunnel has been **turned
off** on purpose: it exposed one machine running one person's credentials, which
is the opposite of what the shop needs.

**If you want a genuinely always-on FreeAudit**, see `INTEGRATION.md` in the
repo — `Dockerfile`, `.dockerignore` and the `FREEAUDIT_DATA_DIR` multi-tenancy
contract are already there and tested. Two things are NOT done:

1. `server.js` still resolves **one** workspace per process
   (`const ROOT = ensureDataDir()`). Hosted as-is, every user would share one set
   of credentials. Per-user logins need a workspace resolved per signed-in
   account.
2. **Nobody has tested whether Fullbay accepts a login from a datacenter IP.**
   If it challenges or demands 2FA, unattended hosted runs stop working. Cheap to
   test with one account, and it decides whether hosting is viable at all. Do
   this before building anything on the assumption that it works.

---

## 4. What the audit produces now

Two independent runs, each with its own report — they are separate on purpose and
should probably be separate in the portal too.

**Ready to Invoice** (`node audit.js`) — the billing gate. ~29 orders, ~4 min.
Checks A–H: photos, parts, inspection sheets, hours, PO format, duplicate photos
across orders, tracker completion, Vorto resolution.

**Open SOs** (`node audit.js open`) — work in progress, from Tech Home's Open SOs
tab. Writes `open-sos.json` and `open-report.html`. Checks **O1–O7**: open too
long, still in progress, never started, awaiting parts quote, repair with no
parts, no photos, missing before/after. Your agent does not know about this mode
yet — adding `kind: 'open'` would surface it in the portal.

`check` is free text your side, so **new checks need no portal change**. O1–O7
would render with their titles and details as soon as you queue that kind.

Also on the host, not currently uploaded: a week-by-week **scorecard** of
findings per employee (`scorecard-history.json`), and **Fix Addresses**, the one
action that writes to Fullbay — it sets Bill To / Ship To on each estimate to
match that order's labour location.

---

## 5. Still needed from you

- **The `AUDIT_AGENT_SECRET` value.** `agent-credentials.json` exists on the host
  with `"agentSecret": "PASTE_SECRET_HERE"`. The agent starts, reaches the portal
  and returns a clean `401: Bad agent secret` — everything else is wired.
- Confirmation of whether the portal embeds FreeAudit in an **iframe**. If so, its
  session cookie is `sameSite: 'lax'` and will not be sent cross-site: sign-in
  will appear to work and every request after it will be unauthenticated. It is a
  two-line change to `sameSite: 'none'; secure: true`, but that weakens CSRF
  protection, so it should be deliberate.

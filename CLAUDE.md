# Sales Claw

> Japanese version: [docs/ja/CLAUDE.md](docs/ja/CLAUDE.md)

## About This Project

A tool that automates B2B outreach through company contact forms.
Based on the user's company profile, target list, and value propositions
configured in settings, the Claude Code CLI performs: company analysis →
message generation → form filling.

## ABSOLUTE RULE: Never log `awaiting_approval` without form-fill + screenshot

**This is the single most important rule in this project. Violations are not
acceptable.**

Before logging an `awaiting_approval` action, you **MUST** complete every one
of the following steps:

1. **Open the form URL** — use the MCP Playwright `browser_navigate` /
   `browser_tabs` tools to open the official site / contact page.
2. **Parse the form structure** — use MCP Playwright `browser_snapshot` to
   identify each field.
3. **Actually fill every field** — use MCP Playwright `browser_fill_form` /
   `browser_type` / `browser_select_option` to enter company name, contact
   name, email, phone, and message body.
4. **Take a screenshot of the filled form** — use MCP Playwright
   `browser_take_screenshot` and save to `screenshots/ss-{No}-input.png`.
5. **Log in order**: `form_fill` → `confirm_reached` → `awaiting_approval`.
   - **The `details` payload for `awaiting_approval` / `submitted` MUST
     include `sentMessage`** (the exact text that was typed into the form
     body). Pass the actual string you typed into the contact form's body
     field, not the Phase A `templateDraft`.
   - From 1.2.100 onwards an API guard rejects requests with **422** if
     `sentMessage` is missing or shorter than 30 characters; the log entry
     will not be recorded.

### Forbidden actions

- Logging `awaiting_approval` after only generating a message (without
  touching the form).
- Writing a `form_fill` log entry without ever opening the form.
- Going to `awaiting_approval` without taking a screenshot.
- Silently going to `awaiting_approval` after "couldn't find the form" →
  must be an `error` log entry with the reason explicitly stated.
- **Omitting `sentMessage` from the `details` of `awaiting_approval` /
  `submitted`** (this causes the dashboard view to diverge from what was
  actually typed — a real-world incident root cause).
- **Typing a degenerate body that is just a contact-info dump (TEL / MAIL
  only)** — the body must use `companyProfile.companyName` +
  `valuePropositions.strengths`. Follow the output of
  `buildMessagePrompt(analysis)`.

### If form-filling fails

- **CAPTCHA / reCAPTCHA / hCaptcha / Turnstile**: do not stop. Fill every
  field you can → take `ss-{No}-input.png` → log `awaiting_approval`
  (the human solves the CAPTCHA and submits).
  - A visible checkbox-style reCAPTCHA v2 ("I'm not a robot") may be
    `browser_click`'d **once**. If an image challenge appears, give up and go
    to `awaiting_approval`.
  - Only when the form itself never renders / a Cloudflare-style page gate
    blocks you from reaching the form body should you log `error`.
- Form not found → `error` log + reason + what was searched.
- Filled what you could, but some fields are missing → take the screenshot of
  what you did fill → `awaiting_approval` + explicitly note the missing
  fields in the log.

### Handling "no solicitation" / out-of-scope forms

- If the page explicitly says things like
  「営業目的のお問い合わせはご遠慮ください」 (no sales inquiries),
  「既存顧客専用」 (existing customers only),
  「採用専用」 (hiring only),
  「IR専用」 (IR only),
  「報道専用」 (press only),
  the form is **out of scope**.
- For out-of-scope forms: **do not fill the form**.
- Do **not** log `awaiting_approval`.
- Record a `skipped` action via `curl POST /api/log-action` (details in the
  Workflow section).
- If possible, also reflect the reason in `live-monitor`.

### Field input rules

- Minimum required fields: `company name / contact name / email / phone /
  inquiry body`.
- `department / job title / contact name (kana) / postal code / address /
  mobile / fax / website` should only be filled when the form has an
  **explicit corresponding field**.
- **Never guess values that don't exist in settings.**
- `companyProfile.notes` and similar internal memos must **never** be typed
  into a form or used in a sent message.

**The user makes the send decision from the screenshot on the dashboard.
Without a screenshot, they cannot decide.**

## Architecture — CLI-driven

**Important: this project is driven by the Claude Code CLI.**

- Claude Code performs company analysis, message authoring, and form filling
  inline.
- The dashboard (localhost:configured port) shows AI work **live** in the
  「操作中」(operation) tab via Electron WebContentsView, plus
  「確認待ち」(awaiting approval), 「送信済み」(sent), 「スキップ」(skipped).

### Form-fill mode — internal MCP + WebContentsView (since v2.0.67)

**Default: `formFill.mode = "internal"`** (set in `data/settings.json`,
fallback also `internal` since v2.0.71).

The Claude CLI calls `mcp__playwright__browser_*` tools (name kept for
prompt compatibility), but those tools are actually served by the
**internal `sales-claw-form` MCP server** — NOT the external
`@playwright/mcp` Chromium process.

```
Claude CLI (managed PTY)
    │  stdio JSON-RPC 2.0
    ▼
sales-claw-form-mcp-server.cjs  (separate Node process)
    │  Named Pipe \\.\pipe\sales-claw-form-mcp-<random>
    ▼
Electron main / FormSessionManager + CdpBridge
    │  webContents.debugger.attach('1.3')   (Chrome DevTools Protocol)
    ▼
WebContentsView  (in-process Chromium, partition per session)
    │
    └─→ Visible in dashboard 「操作中」 tab, docked to HTML slot bbox
```

**Why this matters for Claude CLI prompts**:
- Tool names look identical to Playwright (`browser_navigate`,
  `browser_snapshot`, `browser_fill_form`, `browser_take_screenshot`,
  `browser_tabs`, `browser_click`, `browser_type`,
  `browser_select_option`, etc.) — there are 15 tools total at
  `src/mcp-servers/sales-claw-form/tools/`.
- Behavior is **almost** identical, but every `browser_*` call accepts /
  returns a `sessionId`. Each `sessionId` = one isolated WebContentsView
  with its own `partition: form-session-<id>` (separate cookies / storage).
- The user sees every `browser_*` operation happen live in the 操作中 tab.
  Don't do "invisible" exploration — the user is watching.

**Three rare modes** (settings `formFill.mode`):
- `"internal"` (default, v2.0.71+) — sales-claw-form MCP only
- `"playwright"` (legacy, ≤ v2.0.65) — external `@playwright/mcp` Chromium
- `"both"` (A/B testing only) — both MCP servers registered

**Do not assume external Chrome is launched.** Even if a `browser_*` tool
times out, the WebContentsView path is in-process. There is no separate
`chrome.exe` to kill.

### Parallel processing (3 layers)

| Layer | What runs in parallel | Cap | Implementation |
|---|---|---|---|
| **Phase A** — site analysis | haiku sub-agents (HTTP fetch only) | = batch size | `src/parallel-analysis.ts` |
| **Phase B parallel tabs** — form filling | WebContentsView sessions visible side-by-side in 操作中 tab | **3** | `src/form-session-manager.ts` + `resolvePhaseBParallelTabs` |
| **Phase B parallel dispatcher** (legacy) | Independent Claude processes, each with own MCP | 3 | `src/ai-runtime/parallel-dispatcher.ts` + `/api/ai-form-fill-parallel` |

The default Phase B path is "1 Claude CLI + up to 3 WebContentsView
sessions" (auto-resolves to `min(batchSize, 3)`).

Env override: `SALES_CLAW_PHASE_B_PARALLEL_TABS=2`.

### 操作中 tab UX contract

- Each WebContentsView is docked to an HTML slot `<div id="form-session-slot">`
  by `setViewBounds(sessionId, bbox)`. The bbox is HTML-side
  `getBoundingClientRect()` × `devicePixelRatio`.
- When the user switches to a non-operation tab,
  `/api/form-session/tab-changed` fires `hideAllSessions()` →
  `contentView.removeChildView()` for every session. WebViews are
  **detached, not destroyed** — when the user comes back, HTML re-issues
  `setViewBounds` and the same session re-attaches.
- Window resize is handled HTML-side: a resize listener re-emits
  `setViewBounds`. There is no main-side resize hook (the legacy no-op
  `onWindowResize` / `_positionView` were removed during the Phase 1 cleanup).
- On `before-quit`, `formSessionManager.destroyAllSessions()` is called
  to release every WebContentsView before the process exits
  (electron-main.ts).

### Session lifecycle contract (replaces old "Tab management contract")

For each company that goes through Phase B:

1. **createSession** — `POST /api/form-session` with `{ formUrl, companyNo }`
   returns a `sessionId`. The WebContentsView is created in
   partition `form-session-<sessionId>`, with SSRF /
   `validateFormUrlSafety` guards on every request.
2. **work within that sessionId** — all `browser_*` calls use the same
   `sessionId`. Do not mix sessions for one company.
3. **finalize** — after `browser_take_screenshot` saves
   `screenshots/ss-{No}-input.png`, log `awaiting_approval` via
   `curl POST /api/log-action`.
4. **on approve** — `POST /api/ai-submit-final` queues a new prompt. Since
   finalized sessions may already have been destroyed, the CLI opens the
   known `formUrl` in a new session, re-enters the exact approved
   `sentMessage`, clicks submit, takes `ss-{No}-sent.png`, and logs
   `submitted`.
5. **destroy** — the session is destroyed when the company is finalized
   (sent / skipped / errored) or on `before-quit`. There is **no need to
   close "tabs"** the way the old Playwright contract demanded — there
   are no Chromium browser tabs to track; one session = one WebView.

The legacy `browser_tabs`/`baselineTabs`/`workingTabs`/`finalFormTab`
contract from the Playwright era is **no longer needed**. `browser_tabs`
still exists as a tool but in internal MCP mode it returns the live
WebContentsView sessions, not Chromium tabs.

## Desktop Release / Auto Update Gate

**Never leave a gap between dev / web / installed Electron.**

When making changes that affect desktop distribution, Claude Code / Codex
**must** observe:

1. The preview dashboard must always be launched via the root
   `npm run dashboard:preview`. Do not treat the `.claude/worktrees/*` 3480
   instance as authoritative.
2. The canonical operational dashboard is `src/dashboard-server.ts` +
   `src/ui/**` + `src/routes/**`. Preview and Electron both start from this
   same source.
3. The web build `npm run lp:dev` is for the landing page / public web
   only. Do not use it as a substitute for the operational dashboard.
4. Do not infer "desktop build is up to date" merely from the output of
   `npm start` / `npm run dashboard:preview` / `npm run lp:dev`.
5. If this change targets a release, bump the version in `package.json` /
   `package-lock.json`.
6. Before building, run `npm run verify:release`.
7. Build the Windows artifact via
   `npm run dist:win -- --publish never`.
8. After building, run `npm run verify:dist` to confirm `app-update.yml` and
   `latest.yml` are consistent.
9. To install on the local PC, use `npm run install:win`. For the
   all-users install, run `scripts/install-latest-win.ps1 -AllUsers` from
   an administrator PowerShell.
10. Do **not** put `local-test` / `${env.GH_OWNER}` / `${env.GH_REPO}` back
    into `electron-builder.yml`.
11. Do not declare the auto-update pipeline ready until
    `npm run verify:dist` passes.
12. **Updates do not reach users until GitHub Releases publishes**: pushing
    to `git push origin main` triggers automatic tagging + release. After
    the release, run `npm run verify:github` to confirm the GitHub Releases
    `latest.yml` is reachable.

### Automatic release pipeline (v1.2.110+)

**Pushing to `main` is enough to trigger a release**:
- `.github/workflows/release.yml` automatically creates the
  `v{package.json version}` tag.
- Builds Windows / macOS / Linux and publishes them to GitHub Releases.
- Includes automated checks for `latest.yml` 0KB regressions and CDN
  reachability.

**How the update reaches users**:
- Installed apps check the GitHub Releases `latest.yml` 5 seconds after
  startup and every 6 hours thereafter.
- If a new version is found, it auto-downloads and shows
  "Restart to update".
- The "Check for updates" button in the dashboard header only works in
  packaged Electron installs (`npm run dashboard:preview` has
  `app.isPackaged=false` and is therefore disabled).

**Post-release verification**:
```bash
npm run verify:github   # Verify GitHub Releases latest.yml reachability
```

Full procedure: `docs/release-parity-and-autoupdate.md`. In Claude Code you
can also run `/release-parity`.

## Configuration

All settings live in `data/settings.json`. They can be edited from the
**Settings** tab of the dashboard.

### First-run setup wizard

A 5-step onboarding wizard is provided for non-engineer users. On first
launch (when `settings.json` is missing or still in sample state), the user
is automatically redirected to `/onboarding`.

**Open manually:**
```
http://127.0.0.1:3765/onboarding           # normal launch (resume progress)
http://127.0.0.1:3765/onboarding?fresh=1   # clear progress, restart from step 1
```

**Five steps:**
1. Welcome + terms of use (OSS / self-responsibility) consent
2. Company profile (`companyProfile`)
3. Your strengths (`valuePropositions.strengths`) — 8 presets + custom
4. Target list (Excel / CSV, can be skipped)
5. AI integration (Claude / Codex / Gemini login status check)

**Completion criterion:** `data/settings.json` gains an `_onboardedAt: <ISO>`
field, after which subsequent visits go directly to the normal dashboard.

**File layout:**
- `src/onboarding-wizard.cjs` — wizard renderer (HTML/CSS/JS embedded)
- `src/onboarding-validator.cjs` — input validation
- `src/routes/onboarding-api.cjs` — `/api/onboarding/*` endpoints
- `tests/onboarding-validator.test.cjs` — validator unit tests

### Reading settings

```javascript
const settings = require('./settings-manager.cjs');

// Sender / company info
const sender = settings.getSender();

// Strengths
const strengths = settings.getStrengths();

// Collaboration patterns
const patterns = settings.getSuccessPatterns();

// Industry-specific profiles
const profiles = settings.getIndustryProfiles();

// Target list path
const listPath = settings.getTargetListPath();

// Excluded statuses
const excludes = settings.getExcludeStatuses();
```

First-time setup:
```bash
cp data/sample-settings.json data/settings.json
```

## Compliance / Cost visibility / Crash recovery (1.2.31+)

### Compliance (P0-4)

`src/compliance.cjs` scans for the four required elements under Japan's
**特定電子メール法 (Specified Commercial Email Act)**:
1. Sender company name (`companyProfile.companyName`)
2. Sender personal name (`companyProfile.contactName`)
3. Contact email (`companyProfile.email`)
4. Opt-out instructions (Japanese phrases such as 「配信停止」「送信停止」
   「ご不要の場合」「今後ご連絡が不要」 etc.)

`finalizeMessage()` (`src/message-builder.ts`) auto-appends only the
missing elements when `preferences.complianceFooter` is true (default).

API: `POST /api/compliance/check  body:{message}` →
`{ ok, evaluation: { status: ok|warn|fail, missing[] } }`

### Cost visibility (P0-3)

`src/cost-estimator.cjs` aggregates `phase_b_prompt_compiled` entries from
`data/ai-run-metrics.jsonl` and converts to USD / JPY using Anthropic's
public pricing (Sonnet $3/MTok input, $15/MTok output).

API: `GET /api/cost/summary` →
`{ ok, summary: { today, thisMonth, avgJpyPerCompany, ... } }`

UI: an "AI cost estimate" chip in the bottom-left of the dashboard (today /
this month / per-company average). Override the FX rate via
`preferences.usdJpy`.

### Crash recovery (P0-5)

On dashboard server startup, `loadRecoverySnapshot()` checks for
`data/recovery/managed-ai-batches.json`. If a snapshot exists, an orange
banner appears at the top of the dashboard:
"Previous session was interrupted with N companies in flight. [Resume]
[Discard]".

API:
- `GET  /api/recovery/status`   `{ ok, hasSnapshot, batchCount, totalCompanies, companyNames[] }`
- `POST /api/recovery/resume`   re-queue + delete snapshot
- `POST /api/recovery/discard`  delete snapshot only

## List Builder feature (1.2.43+)

**Full spec**: `docs/list-builder-requirements.md` v2.0

### Overview

Discover, verify, and qualify candidate companies for outreach using only
public information and official data sources (Japan National Tax Agency
Corporate Number API / gBizINFO / EDINET) plus user-specified URLs.
Human approval is required before any candidate is added to the target list.

**Three input modes:**
- **URL mode**: enter the URL of a company-listing page (industry ranking /
  DX-certified company list / etc.) → paginate → extract details for each
  company.
- **Natural-language mode**: free text → Sonnet structures the query →
  SerpApi.
- **Category mode**: a preset UI keyed on industry × region × headcount ×
  revenue band × growth.

### URLs
- `GET /list-builder` — UI page (also reachable from the icon in the
  dashboard top-right)

### API
- `POST /api/list-builder/run` — start a run (background)
- `GET  /api/list-builder/stream/:runId` — SSE progress subscription
- `POST /api/list-builder/commit` — add the selected rows to the target list
- `GET  /api/list-builder/runs` / `runs/:runId` — list / detail
- `POST /api/list-builder/runs/:runId/cancel` / `retry-failed`
- `DELETE /api/list-builder/runs/:runId`
- `GET  /api/list-builder/api-key-status` — returns only whether keys are
  set (never the values)

### Required API keys (`data/settings.json::apiKeys`)
- `serpApi` (required for NLQ / category mode)
- `houjinBangou` (Japan NTA Corporate Number API, free, recommended)
- `gBizInfo` (gBizINFO, free, recommended)
- `edinet` (EDINET, optional, used for strict revenue-trend evaluation of
  listed companies)

### File layout
```
src/list-builder/
├ orchestrator.cjs          # 8-stage pipeline execution
├ run-manager.cjs           # run persistence / cancel / retry
├ extractor.cjs             # HTTP fetch + compliance check integration
├ enricher.cjs              # industry / headcount / revenue / form extraction
├ identity-resolver.cjs     # identity resolution via Corporate Number API + gBizINFO
├ qualification-scorer.cjs  # fitScore 0-100
├ compliance-precheck.cjs   # robots.txt + form-type + CAPTCHA detection
├ dedupe.cjs                # 4-layer + suppression-based dedup
├ suppression.cjs           # exclusion-list management
├ url-normalizer.cjs        # URL normalization (eTLD+1 / UTM strip / etc.)
├ name-normalizer.cjs       # company-name normalization (legal forms / fullwidth-halfwidth)
├ discovery/                # 3-mode discovery
│  ├ list-page.cjs / pagination.cjs / nlq.cjs / category.cjs
├ enrichers/                # individual-field extractors
│  ├ employee-count.cjs / revenue.cjs / growth-trend.cjs
└ official-clients/         # official API wrappers
   ├ http-client.cjs / houjin-bangou-client.cjs / gbizinfo-client.cjs / edinet-client.cjs

src/list-builder-page.cjs   # UI renderer
src/routes/list-builder-api.cjs  # REST + SSE endpoints

data/list-builder/
├ runs/{runId}/             # per-run persisted data
└ ...
data/suppression-list.json  # suppression list
```

### Design principles (spec §1.2) — **List Builder (discovery) phase only**
- Public information only (no Cloudflare bypass, no CAPTCHA evasion; stop on
  detection).
- Prefer official sources (Corporate Number API → gBizINFO → EDINET →
  search API → scraping).
- Explainability: every record stores `evidence` (source, fetched-at,
  confidence).
- Human-confirmed: never auto-add to `targets.xlsx`; always require
  preview → commit.
- Safe defaults: personal-email / personal-name extraction is off; on
  CAPTCHA / 403 / 429 detection, stop.

**Note**: form filling (Workflow Steps 4-7) treats CAPTCHA differently — it
fills the form as far as possible → takes `ss-{No}-input.png` →
`awaiting_approval` (the human solves the CAPTCHA and submits). See the
Workflow section for details.

### Scrapling auxiliary fetcher (optional, 1.2.43+)

**Positioning**: an auxiliary path for public pages that are hard to fetch
with plain HTTP + Playwright. Not for bypassing protections — for "reliably
fetching public information".

**Enable:**
1. `pip install "scrapling[all]"` (user installs; Sales Claw does not ship
   it)
2. `scrapling install` (browser binaries)
3. `data/settings.json::listBuilder.scraplingMcpEnabled = true`
4. Optionally set `scraplingPythonPath` to locate Python (default `python`)

**Behavior:**
- When enabled in settings, `extractor.cjs::extract` tries Scrapling first.
- If Scrapling returns `blocked` (403 / CAPTCHA / etc.), **stop there**
  (do not fall back).
- Only "not installed" / "timeout" / "spawn failed" cause a fallback to
  `defaultHttpFetch`.
- Results carry a `fetcherKind: 'scrapling' | 'http'` field.

**Files:**
- `scripts/scrapling-fetch.py` — Python worker script
- `src/list-builder/scrapling-client.cjs` — spawn wrapper + availability
  cache

## Workflow

**Per-company required flow (no step may be skipped):**
```
Step 0: MCP Playwright prerequisites
  → This batch runs inside a Claude Code CLI managed session
  → Form discovery / filling MUST use MCP Playwright browser_* tools
  → No need to check the Electron Form Session API. Do not switch to /api/form-session/*
  → If MCP Playwright is not visible, log an error attributing it to a connection problem and prompt the user to re-register / restart MCP on the Sales Claw side
```

**Important**: from 1.2.91, **`logAction` MUST go through
`curl POST /api/log-action`** (the legacy `node -e` shell path is removed
because it allowed shell / prompt injection RCE).

**From v2.0.9 the dashboard URL is passed via env vars**.
`$SALES_CLAW_SESSION` (token) and `$SALES_CLAW_DASHBOARD_URL`
(e.g. `http://127.0.0.1:3456`) are always injected when the managed PTY
starts. **Stop hardcoding `127.0.0.1:3765`** (there was an incident where
the dashboard started on port 3456 and every `curl` returned Connection
refused, losing all log entries).

```
curl -s -X POST -H "Content-Type: application/json" \
  -H "x-sales-claw-session: $SALES_CLAW_SESSION" \
  -d '{"no":<No>,"name":"<company name>","action":"<action>","details":"<details>"}' \
  "${SALES_CLAW_DASHBOARD_URL:-http://127.0.0.1:3765}/api/log-action"
```

Allowed `action` values: `awaiting_approval` `submitted` `skipped` `error`
`confirm_reached` `form_fill`

**From 1.2.100: `details` for `awaiting_approval` / `submitted` must be an
object and must include `sentMessage`**:

```
curl -s -X POST -H "Content-Type: application/json" \
  -H "x-sales-claw-session: $SALES_CLAW_SESSION" \
  -d '{
    "no":185,
    "name":"サンプル取引先株式会社",
    "action":"awaiting_approval",
    "details":{
      "sentMessage":"お世話になります。サンプル株式会社の担当者と申します。\n貴社の取り組みを拝見し、お役に立てる場面があるかもしれずご連絡いたしました。... (the exact string typed into the contact form body)",
      "screenshot":"ss-185-input.png",
      "tabKept":true,
      "finalFormTab":"https://contact.example.com/..."
    }
  }' \
  "${SALES_CLAW_DASHBOARD_URL:-http://127.0.0.1:3765}/api/log-action"
```

Guards:
- `details.sentMessage` missing → 422 (not recorded)
- `sentMessage` shorter than 30 characters → 422 (rejects degenerate
  TEL/MAIL-dump bodies)
- contains placeholder phrasing (e.g. 「【URL 不在のため、CLI 本体が公式
  サイト探索後に本文を最終化します】」) → 422
- screenshot missing / file does not exist → 422

```
Step 1: Company-site analysis
  → Use mcp__playwright__browser_navigate (= internal sales-claw-form MCP) to
    confirm the official site and the contact-form path
  → As needed, you may import compiled helpers from dist-ts:
      const company = require('./dist-ts/src/company-analyzer');
      const settings = require('./dist-ts/src/settings-manager');
  → Record a site_analysis action via curl POST /api/log-action (the Phase A subprocess may have already recorded it)

Step 2: Message generation
  → Read sender info / strengths / templates from dist-ts/src/settings-manager
  → Use only facts confirmed on the target site, and craft the body per company
  → message_draft is also pre-recorded by the Phase A subprocess (no re-record needed)

Step 3: Form-URL discovery
  → First company: browser_navigate to the official site or a known form candidate
  → Subsequent companies: browser_evaluate window.open(url,'_blank') → browser_tabs
  → If formUrl is absent or invalid, explore inside the official site for "Contact" / "お問い合わせ" / "Contact" / "資料請求" / "パートナー" via Playwright
  → If companyUrl itself is empty (urlMissing=true), use WebSearch to query "company name + 公式", identify the official domain, find the contact form
  → When using search results, always re-verify the official domain

Step 4: Form-structure analysis
  → browser_snapshot to parse the form
  → "no solicitation" / out-of-scope / existing-customers-only / hiring-only / IR-only / press-only → do not fill, mark as skipped (curl POST)
  → CAPTCHA detected → ★ KEEP filling (continue Step 5-7), leave final submit to the human (awaiting_approval)
  → Form not rendered / blocked by page gate → error (curl POST)

Step 5: Fill the form ★ NEVER SKIP
  → Actually input via browser_fill_form / browser_type / browser_select_option / browser_click
  → At minimum: company name / contact name / email / phone / inquiry body
  → Record a form_fill action via curl POST

Step 6: Screenshot ★ NEVER SKIP
  → browser_take_screenshot to screenshots/ss-{No}-input.png (required)
  → If a confirmation screen exists, screenshots/ss-{No}-confirm.png is also fine
  → Record a confirm_reached action via curl POST

Step 7: Register awaiting_approval
  → Record an awaiting_approval action via curl POST /api/log-action
  → ★ If Steps 5 and 6 are not complete, do NOT enter this step
  → Before logging awaiting_approval, execute the Tab management contract: keep only the finalFormTab for the filled form / confirmation screen
```

**Multi-company case (two-phase parallel processing):**
```
"Process up to 3 awaiting_approval" → keep going to the end. Do NOT stop mid-flight to ask for message approval.

Phase A (parallel — no MCP):
→ Process "site analysis + message-generation prompt construction" for every company in parallel sub-agents
→ How: spin up haiku sub-agents in parallel via the Agent tool:
    node dist-ts/src/parallel-analysis.js '{"no":1,"companyName":"<name>","url":"<URL>","type":"<type>","formUrl":"<form URL>"}'
→ Sub-agent internally uses company-analyzer + message-builder
→ Output: analysis + messagePrompt (CLI prompt) + templateDraft (fallback)
→ Do NOT use MCP Playwright (plain HTTP fetch only)
→ Notify dashboard progress via thinking() + updateLiveMonitor()
→ Do not advance to Phase A.5 until every company's Phase A is complete

Phase A.5 (message generation — leverage CLI's language ability):
→ Load each company's Phase A analysis + messagePrompt into the form-fill batch payload
→ The CLI uses messagePrompt to finalize the body per company; treat templateDraft only as fallback
→ messagePrompt includes approachObjective / approachGuardrails / site excerpts / gap analysis
→ The CLI writes natural Japanese (or English) that feels "written for this company only" — avoid template feel
→ templateDraft is used only when CLI generation fails

Phase B (parallel-tab — form filling, up to 3 sessions in 操作中 tab):
→ Each company gets its own sessionId / WebContentsView (partition-isolated).
→ `resolvePhaseBParallelTabs(batchSize)` decides how many tabs to open
   in parallel (cap = MAX_PHASE_B_PARALLEL_TABS = 3).
→ Per company (per sessionId):
     browser_navigate({ sessionId, url })
   → browser_snapshot({ sessionId })
   → browser_fill_form({ sessionId, mappings })
   → browser_take_screenshot({ sessionId, suffix: 'input' })
   → logAction(awaiting_approval) via /api/log-action
→ Each session is visible **live** to the user in the 操作中 tab.
→ Do NOT try to "browse around" outside the form's domain. SSRF guards
   in FormSessionManager will block unknown hosts.
→ On per-session failure, log `error`; the remaining sessions continue
   (Promise.allSettled semantics).

→ Notify dashboard progress via thinking() + updateLiveMonitor()

When all companies are done, summarize the results for the user
→ The actual send decision happens in the dashboard's Awaiting Approval tab (human in the loop)

"Send to <company>" case:
→ Show the draft to the user → on approval, proceed up to fill + screenshot
```

**Progress notification (required):**
```
At every step, call cli-logger so the dashboard reflects progress:

const { thinking, log } = require('./dist-ts/src/cli-logger');

Phase A start: thinking('Phase A start: parallel analysis of N companies')
Each company analysis start: thinking('[No.X] <name>: site analysis start')
Each company prompt: thinking('[No.X] <name>: building message prompt')
Phase A.5 start: thinking('Phase A.5 start: CLI message generation')
Each company CLI generation: thinking('[No.X] <name>: CLI personalizing message')
Phase B start: thinking('Phase B start: form filling (sequential)')
Each company form filling: thinking('[No.X] <name>: filling form')
Each company complete: log('[No.X] <name>: awaiting_approval registered', 'action')
```

## Message Generation

Messages are personalized per company by leveraging the CLI's language
ability.

### Generation flow
1. `src/parallel-analysis.ts` analyzes the company site → `analysis`
   (business domain, gaps, focus areas, site excerpts).
2. `src/message-builder.ts`'s `buildMessagePrompt(analysis)` builds the
   CLI prompt.
3. The CLI agent uses the prompt to craft a body that resonates with the
   target.
4. Fallback: `buildCustomMessage(analysis)`'s template body.

### Settings references
- `companyProfile` — sender info
- `valuePropositions.strengths` — our strengths (used in gap analysis)
- `valuePropositions.successPatterns` — collaboration record
- `valuePropositions.industryProfiles` — per-industry template (fallback)
- `messageTemplates` — tone / signature / CTA
- `messageTemplates.approachObjective` — outreach objective (auto-injected
  into the CLI prompt)
- `messageTemplates.approachGuardrails` — prohibited content (auto-injected
  into the CLI prompt)

### Message authoring guidelines (already embedded in the CLI prompt)
- Lead with what the other party wants to achieve (do not open with self-intro).
- Make it feel written only for this company (avoid template feel).
- Don't try to communicate everything (focus on 1-2 sharp strengths).
- Keep Win-Win subtle (no hard sell).
- Keep results understated (don't lead with named clients; numbers are OK).
- **Foreground what you can do for the other party.**
- Touch the other party's business explicitly ("貴社の〇〇事業を拝見").
- Propose combinations of their strengths × our strengths.
- Don't assume their problems.

## OMC (oh-my-claudecode) model routing — token savings

This project is integrated with OMC's model routing. By assigning the most
appropriate model to each step, you can reduce token cost by **60-70%**.

### Install (one-time)
```bash
claude /install oh-my-claudecode
```

### Per-step model assignment

| Step | Processing | Model | Reason |
|---------|---------|--------|------|
| Company site analysis | URL crawl → text extraction → domain detection | **haiku** | Pattern matching. Deep reasoning not needed |
| Form discovery | Link traversal → form URL identification | **haiku** | Simple web crawl |
| Form validation | Form structure analysis → fillability check | **haiku** | Structure check only |
| Message generation | Gap analysis → custom body | **sonnet** | Natural-language quality matters |
| Form filling | MCP Playwright ops → field input | **sonnet** | Form structure understanding + precision |
| Dashboard settings change | settings.json read/write | **haiku** | Simple CRUD |
| Exclusion / target selection | List scan → rule match | **haiku** | Rule-based |
| Error handling / debugging | Investigate form-fill failure root cause | **opus** | Complex problem solving |
| Whole-workflow orchestration | Multi-company parallel orchestration | **sonnet** | Main control |

### OMC agent mapping

```
Company analysis (parallel) → explore (haiku) × N companies
Message generation          → executor (sonnet) — message quality matters
Form filling                → main directly drives MCP (sonnet)
Settings change             → executor-low (haiku) — simple JSON ops
Error investigation         → architect (opus) — complex debugging only
```

### Typical "up to 3 awaiting_approval" token budget

```
All Opus (legacy):
  3 × (analysis + message + form fill) ≈ 150K tokens @ opus

With OMC routing:
  Analysis: 3 × 10K tokens @ haiku  = 30K (cost: 1/10 of opus)
  Message:  3 × 8K tokens @ sonnet = 24K (cost: 1/5 of opus)
  Form:     3 × 15K tokens @ sonnet = 45K (cost: 1/5 of opus)
  Total: 99K tokens, effective cost ≈ 25-30% of legacy
```

### Usage

If OMC is installed, model routing is applied automatically. To specify a
model manually:

```
# Run company analysis with haiku
Agent(model: "haiku", prompt: "Analyze the company")

# Run message generation with sonnet
Agent(model: "sonnet", prompt: "Generate the message")
```

To run in parallel via OMC's ultrawork mode:
```
/ultrawork
→ 3 company analyses run in parallel via 3 haiku agents
→ Then sonnet generates the messages
→ The main agent drives MCP Playwright for form filling
```

## File Structure (TypeScript port)

Most source files are now `.ts`. `.cjs` is intentionally kept only for
the internal MCP server entries (Claude CLI's MCP runtime requires CJS)
and a few dev scripts.

```
sales-claw-ts/
├── CLAUDE.md                          # This file (project description)
├── electron-main.ts                   # Electron main process
├── package.json / tsconfig.json
├── bin/
│   └── sales-claw-form-mcp.cjs        # internal MCP entry (Claude CLI spawns this)
├── src/
│   ├── dashboard-server.ts            # Dashboard + settings UI (HTTP server)
│   ├── settings-manager.ts            # Settings (single source of truth)
│   ├── action-logger.ts               # Action log management
│   ├── contact-history.ts             # Contact history
│   ├── company-analyzer.ts            # Company-site analysis (HTTP fetch)
│   ├── parallel-analysis.ts           # Phase A: parallel sub-agent analysis
│   ├── message-builder.ts             # Message generation (template fallback)
│   ├── llm-message-generator.ts       # CLI prompt construction (Phase A.5)
│   ├── llm-site-analyzer.ts           # LLM-driven site analysis
│   ├── form-session-manager.ts        # 操作中 tab: WebContentsView lifecycle
│   ├── cdp-bridge.ts                  # Chrome DevTools Protocol bridge
│   ├── form-mcp-dispatcher.ts         # MCP IPC dispatcher
│   ├── cli-logger.ts                  # Dashboard CLI Activity notifier
│   ├── live-monitor.ts                # Progress monitor management
│   ├── ai-runtime/
│   │   ├── parallel-dispatcher.ts     # Legacy: spawn N Claude processes
│   │   ├── batch-utils.ts             # batch chunking
│   │   └── redact.ts                  # secret redaction
│   ├── mcp-servers/sales-claw-form/   # internal MCP server (15 tools)
│   │   ├── server.cjs                 # MCP entrypoint (stdio JSON-RPC)
│   │   ├── ipc-client.cjs             # Named-Pipe client → Electron main
│   │   └── tools/                     # navigate / snapshot / fill_form / ...
│   ├── routes/
│   │   ├── form-session-api.ts        # /api/form-session/* (live-form tab API)
│   │   ├── ai-form-fill-api.ts        # /api/ai-form-fill
│   │   ├── ai-submit-final-api.ts     # /api/ai-submit-final (送信ボタン)
│   │   ├── approve-api.ts             # /api/approve (確認待ち判定)
│   │   ├── parallel-form-fill-api.ts  # /api/ai-form-fill-parallel (legacy)
│   │   └── ...                        # onboarding, list-builder, recovery, etc.
│   ├── list-builder/                  # Phase 0: list discovery + qualification
│   └── ui/client-scripts/             # bundled into dashboard HTML
├── data/
│   ├── settings.json                  # All settings (gitignored)
│   ├── sample-settings.json           # Settings sample
│   ├── sample-targets.csv             # Public sample targets
│   ├── action-log.json                # Full action log
│   └── contact-history.json           # Contact history
├── screenshots/                       # ss-{No}-input.png / ss-{No}-sent.png
└── tests/                             # Node-based test:unit suite (51 in CI)
```

## Agent Orchestration

This project is developed with a two-agent setup: **Claude (orchestrator) +
CODEX (backend implementation)**.

| Role | Agent | Scope |
|------|------------|------|
| Frontend / UI design / integration | **Claude** | HTML/CSS/i18n/dashboard UI |
| Backend implementation | **CODEX** | .cjs server logic / data processing / file ops |

### Invoking CODEX

```bash
codex exec -m gpt-5.4 -s workspace-write "<task>"
```

- Model: `gpt-5.4` (top model; `o3` is not available on the ChatGPT account)
- Working directory: `C:\bp-outreach-ts`

## AI session etiquette (preflight + cleanup)

**Run before touching any code at the start of a new session.**

### 1. Preflight

```bash
npm run preflight
```

This calls `scripts/preflight-ai.ps1`, which checks:

- `pwd` is the `C:\bp-outreach-ts` root (not inside `.claude/worktrees/*`).
- `git worktree list` has no non-`main` worktrees (detects orphaned
  sandboxes).
- `git status` is clean or only contains known work-in-progress.
- No `cmd.exe` / `node.exe` orphans older than 1 hour.
- No other Claude Code session is holding a worktree via `--add-dir`.
- The most recently installed Sales Claw
  (`%LOCALAPPDATA%\Programs\Sales Claw`) matches the current source version.

If anything is wrong, it emits a red WARN. Do not start working until it's
fixed.

### 2. Forbidden

- ❌ Do not use `.claude/worktrees/*` as a working directory (it's for agent
  isolation, not human edits).
- ❌ Do not leave `*.png` / `.tmp-*` at the project root (test screenshots
  go in `screenshots/`; temporary scripts must be deleted after use).
- ❌ If another Claude Code session has a worktree open via `--add-dir`, do
  NOT kill its processes (you'll break the other session).
- ❌ When running `npm run dist:win`, **always** add `-- --publish never`
  (so you don't accidentally publish to GitHub Releases).
- ❌ After launching Sales Claw and clicking "Launch Claude", do not kill
  the Claude PTY from outside the dashboard (a 5-minute watchdog will
  reap it on its own).

### 3. Cleanup after tests (always run)

```bash
npm run clean:workspace
```

`scripts/clean-workspace.ps1` will:

- Delete `*.png` / `*.tmp` / `.tmp-*.ps1` at the project root
  (`screenshots/`, `assets/`, `sample/` subtrees are not touched).
- Delete `.claude/worktrees/*` directories that are not listed by
  `git worktree list`.
- Stop orphan `cmd.exe` processes older than 1 hour (only those not bound
  to the current Claude Code session).
- Print `git status` so any leftovers are visible.

### 4. Sales Claw specifics

| Item | Value |
|------|-----|
| Dashboard URL | `$SALES_CLAW_DASHBOARD_URL` (managed PTY) / default `http://127.0.0.1:3765` (falls back to 3766 / 3767 / ... if taken) |
| Session token | `%APPDATA%\sales-claw\runtime\data\dashboard-session.json` |
| Runtime info | `%APPDATA%\sales-claw\runtime\data\dashboard-runtime.json` |
| Installed app | `%LOCALAPPDATA%\Programs\Sales Claw\` (per-user; not `Program Files`) |
| Settings / runtime data | `%APPDATA%\sales-claw\runtime\data\` |
| Build output | `dist/Sales-Claw-Setup-<version>.exe` |
| Distributable verifier | `npm run verify:dist` |

### 5. Known traps

| Symptom | Cause | Fix |
|------|------|------|
| Cannot delete worktree (`Permission denied`) | Old `cmd.exe` / `node.exe` still holds the cwd | `npm run clean:workspace` (only kills old orphans) |
| MCP `2 servers failed` | claude.ai cloud MCP servers needing auth (Microsoft 365 / Google Drive etc.) | Local `playwright` is a separate server; check with `claude mcp list` that `playwright: ✓ Connected` |
| `'\"...\\.bin\\claude.cmd\"' is not recognized` | cmd.exe quoting bug in <1.2.27 | Upgrade to 1.2.28+ |
| Electron disappears on "Launch Claude" | PTY uncaughtException bug in <1.2.26 | Upgrade to 1.2.28+ |
| Stuck on paste banner (>49 lines) | Claude UI requires a 2nd Enter | Fixed in 1.2.28+ |
| `auto mode unavailable for this model` | Model does not support auto mode | Launch via `bypassPermissions` (see Workflow Step 0) |

## Session Quick Start

1. **`npm run preflight`** for preflight (see "AI session etiquette" above).
2. Launch the dashboard via `npm start` or the Electron app.
3. Follow user instructions to execute outreach.
4. If settings are incomplete, encourage configuration via the Settings tab.
5. On exit, **`npm run clean:workspace`** to clean up.

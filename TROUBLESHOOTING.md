# Troubleshooting

> Japanese version: [docs/ja/TROUBLESHOOTING.md](./docs/ja/TROUBLESHOOTING.md)

This document catalogs the issues real Sales Claw users have encountered, the
root cause of each, and the concrete steps to resolve them. If you can't find
your symptom here, please file an issue on
[GitHub Issues](https://github.com/joseikininsight-hue/sales-claw-ts/issues)
with the relevant log excerpts.

## Table of contents

1. [AI launch / CLI issues](#category-1--ai-launch--cli-issues)
2. [Form-fill / Phase B issues](#category-2--form-fill--phase-b-issues)
3. [Settings / dashboard UI issues](#category-3--settings--dashboard-ui-issues)
4. [Updates / installation issues](#category-4--updates--installation-issues)
5. [Errors / performance issues](#category-5--errors--performance-issues)
6. [How to gather diagnostics](#how-to-gather-diagnostics)
7. [Related documents](#related-documents)

---

## Category 1 — AI launch / CLI issues

### 1.1 AI launch always fails after ~75 seconds

**Symptom**

You click **AI を起動 / Launch AI** in the dashboard, see a spinner for about
75 seconds, then the launch overlay disappears with an error or simply
returns to the idle state. `ai-runs/managed-claude-session.log` contains
repeated lines like:

```
managed_ai_launch_cancel_requested reason=timeout ageMs=74977
```

The AI never actually becomes "ready".

**Cause**

In versions **≤ 2.0.30** the three timeout budgets were inconsistent:

| Layer | File | Old value |
|---|---|---|
| Server cancel | `ai-runtime-api.ts` `LAUNCH_TIMEOUT_MS` | 75 s |
| Stale-lock | `dashboard-server.ts` `MANAGED_AI_LAUNCH_LOCK_STALE_MS` | 90 s |
| Client overlay | `cli-terminal.ts` `LAUNCH_REQUEST_TIMEOUT_MS` | 90 s |

The MCP Playwright registration step alone can spend up to 90 s
(list 20 s + remove 20 s + add 30 s + verify 20 s), which is **larger** than
the 75 s server cancel budget — so the launch was guaranteed to be killed
mid-flight.

**Fix**

Upgrade to **v2.0.31 or later**. The timeouts have been re-ordered as
client (130 s) > server stale-lock (130 s) > server cancel (120 s) >
MCP setup max (90 s) so the race is impossible.

```bash
# Verify the version you have
sales-claw --version    # or look at Help > About
```

If you can't upgrade immediately, work around it by pre-registering
MCP Playwright manually (see 1.3 below) so the launch path skips the
re-registration.

---

### 1.2 "Claude Code CLI is not logged in" right after a successful launch

**Symptom**

You launch the AI, the PTY clearly starts (`/api/ai/status` returns
`loggedIn: true`), but as soon as you submit a form-fill batch you get:

> Claude Code CLI が未ログインです / Claude Code CLI is not logged in

…and the batch is rejected. Repeating the launch doesn't help.

**Cause**

In versions **≤ 2.0.28** `ensureClaudeAutomationReady` (the auth gate at
Phase B dispatch) re-spawned `claude auth status --json` while the managed
PTY was already running. That second spawn raced against `credentials.json`
locks / `HOME` env switching and frequently returned a false "not logged in".

**Fix**

Upgrade to **v2.0.29 or later**. The fix in
`src/dashboard-managed-provider-home.ts` short-circuits the second spawn:
if the managed PTY is already running with the same provider, the dispatch
treats the session as authenticated.

---

### 1.3 `claude mcp list` returns empty / MCP Playwright not registered

**Symptom**

In the AI launch log you see lines like
`mcp_playwright_stale_entry` or `mcp_playwright_registration_loop`, and
running `claude mcp list` from a normal terminal prints no entries. Form
discovery in Phase B silently fails because the `browser_*` tools don't
exist.

**Cause**

Two common causes:

1. The user's `claude` CLI was installed in a different home directory than
   the one Sales Claw injects via `HOME` / `USERPROFILE`. The MCP registry
   that Sales Claw populated lives in a Sales Claw-owned home and is
   invisible to your shell.
2. Switching back and forth between the installed app
   (`Sales Claw.exe`) and dev mode (`electron.exe`) used to confuse the
   stale-entry detector and trigger a remove + re-add loop on every launch
   (fixed in v2.0.31).

**Fix**

First, upgrade to **v2.0.31+** so the stale-entry detector is more lenient.

If you still need to register MCP Playwright manually (e.g. you run
`claude` from your own shell), use:

```bash
claude mcp add --scope user playwright \
  -- npx --yes @playwright/mcp@latest
```

Verify with:

```bash
claude mcp list
# expected: playwright    ✓ Connected
```

If `playwright` is registered but shows `✗ Failed`, run
`claude mcp remove playwright` and add it again. A reboot may be needed to
pick up updated `PATH` after installing Node.js.

---

### 1.4 `'\"...\\.bin\\claude.cmd\"' is not recognized` on Windows

**Symptom**

Launch fails immediately on Windows with the message above (cmd.exe
quoting bug).

**Cause**

A `cmd.exe` quoting bug in Sales Claw < 1.2.27 (CJS edition).

**Fix**

Upgrade. The TypeScript edition (≥ 2.0.0) does not have this issue.

---

## Category 2 — Form-fill / Phase B issues

### 2.1 "対象が見つかりません" / "Target list file not found" forever

**Symptom**

You submit a form-fill batch and the dashboard immediately shows
**「対象が見つかりません」/ "Target list file not found"**. Re-importing the
list seems to do nothing; the next batch shows the same error.

**Cause**

`settings.targetList.filePath` still points to a target list file that has
been moved or deleted, so `readWorkbookBundle` throws on every dispatch
(reproduced by multiple users on v2.0.31).

**Fix**

Auto-recovery was added in **v2.0.32**. On startup the workbook reader now
scans `imports/` for the most recent `*-target-list.xlsx` and updates
`settings.json` automatically.

If you're on v2.0.32+ and still see the message:

1. Open **Settings → Target List**.
2. Click **Re-select file** and pick a valid `.xlsx` / `.csv`.
3. Or drop the file directly into `%APPDATA%\sales-claw\runtime\data\imports\`
   (Windows) and restart.

---

### 2.2 Forms reach `error` instead of `awaiting_approval` even though Phase B finished

**Symptom**

You watch Phase B and see Claude actually open the form, fill every field,
take a screenshot, and reach the confirmation page — but the dashboard
records **`error`** instead of `awaiting_approval`. The error message
mentions:

> site_analysis 不足 (739 字 / 必要 800 字)

…even though the form was completely filled.

**Cause**

A defensive guard in `src/routes/simple-api.ts` rejected the action when
`siteTextLength < minSiteTextLength` (default 800). For sites with short
public copy this rejected real, completed work.

**Fix**

Upgrade to **v2.0.32 or later**. The guard now treats
`form_fill + confirm_reached` as proof Claude completed all phases and
allows `awaiting_approval` to pass even when the site text is short. Final
sentMessage quality is still validated separately by
`validateSentMessageQuality`.

---

### 2.3 Phase B stops at a CAPTCHA

**Symptom**

The form-fill log shows "CAPTCHA detected" and the action is logged as
`awaiting_approval`. Nothing further happens automatically.

**Cause**

This is **by design**. Sales Claw never solves CAPTCHAs (reCAPTCHA,
hCaptcha, Cloudflare Turnstile, etc.) on its own — it would violate the
provider's terms and could be classified as bot abuse.

**Fix**

This is the human-in-the-loop step:

1. Open the **Awaiting Approval / 確認待ち** tab in the dashboard.
2. Click the row to open the screenshot.
3. Click **Open form** to focus the live MCP Playwright tab the agent kept
   open.
4. Solve the CAPTCHA in the visible browser, click submit, and then click
   **Mark as sent** in the dashboard.

If the form was never reached because of a Cloudflare-style page gate,
that's logged as `error` (not `awaiting_approval`), and you should follow
the manual investigation steps in the action log details.

---

### 2.4 Forms with "no solicitation" notices are auto-skipped

**Symptom**

A target company shows up as `skipped` in the dashboard with a reason like
「営業目的のお問い合わせはご遠慮ください」 / "no sales inquiries".

**Cause**

This is the **sendability gate** working as designed. Forms that explicitly
state they are out of scope (no sales / existing customers only / hiring
only / IR only / press only) are automatically skipped to keep your
outreach compliant and on-policy.

**Fix**

No fix needed — this is a feature, not a bug. If you genuinely have a
relationship that justifies contacting them anyway, use a non-form channel
(email / phone / LinkedIn) outside Sales Claw.

The detection patterns are in
`src/locale-pack/{ja,en}/sendability-exclusions.ts`.

---

## Category 3 — Settings / dashboard UI issues

### 3.1 "Select all and delete" doesn't work on the first click

**Symptom**

In the **Companies** or **Awaiting** tab you click the "Select all" checkbox,
then click **Delete selected**, and nothing happens. Browser console shows
`TypeError: bulkDeleteCompanies is undefined` or similar.

**Cause**

A v2.0.35 regression: `bulkDeleteCompanies()` used `await fetch(...)` but
the `function` keyword was missing the `async` modifier, causing the entire
function expression to fail to parse. Browsers silently dropped the function
from the global scope.

**Fix**

Upgrade to **v2.0.36 or later**. The `async` modifier was restored and
verified by Playwright with
`bulkDeleteCompanies.constructor.name === 'AsyncFunction'`.

---

### 3.2 "API endpoint not found / Sales Claw のバージョンが古い可能性があります"

**Symptom**

After the dashboard starts you see the "resume previous batch" banner.
Clicking **Resume** twice in a row, or clicking **Resume** then **Discard**
in quick succession, displays:

> APIエンドポイントが見つかりません。Sales Claw のバージョンが古い可能性があります

…even though you're on the latest version.

**Cause**

In v2.0.29 and earlier, `POST /api/recovery/resume` returned **404** when
the snapshot was already empty. The dashboard client interpreted any 404
as "endpoint missing → version is old", which mis-led the user.

**Fix**

Upgrade to **v2.0.30 or later**. The server now returns
**409 + `code: 'no_snapshot'`** for already-consumed snapshots, and the
client shows "Target not found (already processed or discarded)" instead of
the misleading version warning.

---

### 3.3 Language toggle doesn't take effect

**Symptom**

You click the 🌐 EN / 日本語 toggle in the header. The button updates but
some labels still show the old language until you reload.

**Cause**

The header toggle calls `PUT /api/settings/preferences` then triggers an
automatic page reload. If the reload is suppressed by a browser extension
or by an interrupted request, the dashboard ends up half-translated.

**Fix**

1. Press **Ctrl+R** (Windows / Linux) or **Cmd+R** (macOS) to force a hard
   reload.
2. If you're stuck after the toggle, check
   `data/settings.json::preferences.language` directly. It should be `'ja'`
   or `'en'`. If it's `'auto'`, the UI follows your system locale.

The bilingual conversion was completed in **v2.0.37** for Settings,
Awaiting, Sent, List Builder, Stats, Pagination and CLI Activity tabs. For
older versions you may still see Japanese strings in some panes.

---

### 3.4 Settings UI shows fields that don't seem to do anything

**Symptom**

You set values like `maxRetries`, `formFillTimeout`, `dateFormat`,
`listSourceMetadata`, or `requireApprovalBeforeSend` in the Settings tab,
save successfully, but no visible behavior changes.

**Cause**

These five preferences fields are documented in v2.0.24 changelog as
**unused holdovers** from the old Playwright-worker form-fill path or
duplicates of other settings (`requireApprovalBeforeSend` overlaps with
`autoSendEligibleForms`).

**Fix**

You can ignore these fields. They will be removed (or wired up) in a future
major release. See [ROADMAP.md](./ROADMAP.md) for status.

---

## Category 4 — Updates / installation issues

### 4.1 The "Check for updates" button is greyed out

**Symptom**

In dev mode (`npm run dashboard:preview`) the **Check for updates** button
in the header is disabled.

**Cause**

This is intentional. `app.isPackaged === false` in dev mode, so the
electron-updater path is unsafe — it might overwrite your repo. Only the
packaged Electron build (the installer from GitHub Releases) gets to
self-update.

**Fix**

To test the auto-update flow, install the released build from
[GitHub Releases](https://github.com/joseikininsight-hue/sales-claw-ts/releases),
not the `npm run dashboard:preview` flow.

---

### 4.2 Updates don't seem to arrive on installed Electron

**Symptom**

You're running the installed Sales Claw, you can see a newer version in the
GitHub Releases page, but the in-app updater does not download it.

**Cause**

The installed app polls `latest.yml` from
`https://github.com/joseikininsight-hue/sales-claw-ts/releases/latest/`
**5 seconds after startup** and **every 6 hours thereafter**. If the
update was published within the last few minutes, you may simply need to
wait, or trigger a manual check.

**Fix**

1. Click **Help → Check for updates** in the dashboard header (only enabled
   on packaged builds — see 4.1).
2. Verify reachability of `latest.yml` directly:
   ```bash
   curl -I https://github.com/joseikininsight-hue/sales-claw-ts/releases/latest/download/latest.yml
   # expected: HTTP/2 200 or 302
   ```
3. If your network blocks GitHub releases, see
   [ROADMAP.md](./ROADMAP.md#known-limitations) — private hosting is not
   currently supported.

If the auto-updater fails, you can always download the new installer from
GitHub Releases and run it on top of the existing install. Settings live
under `%APPDATA%\sales-claw\runtime\data\` and persist across reinstalls.

---

### 4.3 Migrating from the old CJS build (`bp-outreach`) to v2.0.x

**Symptom**

You've been running the older CJS edition and want to move to the
TypeScript v2.0.x stable line.

**Cause**

The CJS edition (`bp-outreach`, v1.2.x) and the TypeScript edition
(`sales-claw-ts`, v2.0.x) are technically separate apps and install to
different folders.

**Fix**

See [MIGRATION.md](./MIGRATION.md) for the full procedure. The short
version:

1. Stop the old app cleanly (`File → Quit`).
2. Copy `%APPDATA%\sales-claw\runtime\data\` to a backup location.
3. Install the v2.0.x release from
   [GitHub Releases](https://github.com/joseikininsight-hue/sales-claw-ts/releases).
4. Start the new app — it will pick up the same `data/` directory and
   migrate `settings.json` if needed.

---

### 4.4 Windows SmartScreen blocks the installer

**Symptom**

Running `Sales-Claw-Setup-x.x.x.exe` shows
**"Windows protected your PC / Microsoft Defender SmartScreen prevented an
unrecognized app from starting"**.

**Cause**

Sales Claw is **not yet code-signed** with a Windows EV certificate (cost:
$200-500/year + corporate identity). This is a known limitation tracked in
[ROADMAP.md](./ROADMAP.md#known-limitations).

**Fix**

1. Click **More info**.
2. Click **Run anyway**.

You can verify the installer's SHA-256 against the value published on the
GitHub Releases page if you want extra assurance.

---

## Category 5 — Errors / performance issues

### 5.1 Phase B auto-errors after 7-20 minutes

**Symptom**

A company that was actively being processed by Claude suddenly transitions
to `error` with no useful detail, and processing of the next batch begins.

**Cause**

The **stall watchdog** fired. The process for that company hadn't logged
any action for longer than the configured threshold:

| Condition | Threshold |
|---|---|
| Some logs exist, last update is stale | `stallMs` (default 20 min) |
| No logs at all (CLI hung before first action) | `emptyActionStallMs` (default `stallMs / 3` ≈ 7 min) |

This typically means the Claude PTY hung or the MCP Playwright session
got stuck on a page that never finished navigating.

**Fix**

1. Open the **CLI Activity / Logs** tab and find the company number.
2. Look at the last action recorded — usually you'll see the form URL where
   the agent got stuck.
3. If you want to give the agent more time, raise `preferences.stallMs` in
   `data/settings.json` (caution: a longer threshold leaves the queue
   blocked longer when the CLI really has crashed).
4. To manually retry, select the company in the Companies tab and click
   **Re-queue**.

The stall watchdog itself was hardened in v2.0.23 to also catch the
"no actions at all" case.

---

### 5.2 5-company parallel runs feel slow

**Symptom**

You expected 5-company parallel processing to be ~5× faster than serial,
but you're only seeing ~1.5-2.5× speedup.

**Cause**

This is expected. The MCP Playwright session is single-browser by design;
only **navigation / submit I/O waits** can overlap (cooperative tab
pipeline). The Claude agent's thinking time stays serial.

Measured speedup with the dummy form server (v2.0.28):

| Companies | Serial (tabs=1) | Parallel (tabs=2/3) | Speedup |
|---|---|---|---|
| 2 | 7,371 ms | 3,867 ms | **1.91×** |
| 3 | 11,030 ms | 3,988 ms | **2.77×** |

**Fix**

1. Set `preferences.parallelTabs` to `2` (recommended) or `3` (aggressive)
   in **Settings → Preferences**, or via env var
   `SALES_CLAW_PHASE_B_PARALLEL_TABS=2`.
2. Don't go above `3` — the agent loses track of which tab belongs to which
   company.
3. Watch `data/ai-run-metrics.jsonl` with
   `node scripts/watch-phase-b-perf.cjs` for live timing data.

---

### 5.3 "site_analysis text under 800 chars" error

**Symptom**

Same as 2.2 above — the company has thin public copy and the legacy guard
rejected the `awaiting_approval` log entry.

**Fix**

Upgrade to **v2.0.32+**. As long as both `form_fill` and `confirm_reached`
were logged, the short-text guard is now bypassed.

---

### 5.4 100 / 200-company batch stops after 7 companies

**Symptom**

You submit 200 companies, the first ~7 process correctly, then the queue
hangs forever and no further dispatches happen.

**Cause**

A combination of two pre-v2.0.23 bugs:

1. The stall watchdog ignored companies whose `action` field was still
   empty (CLI crashed before logging anything).
2. The "AI not logged in" false positive (1.2 above, fixed in v2.0.29) was
   rejecting follow-up batches.

**Fix**

Upgrade to **v2.0.29 or later** (preferably the latest 2.0.x). Both bugs
have explicit regression tests now (`tests/stop-clears-queue.test.cjs`,
`tests/bulk-delete.test.cjs`).

---

## How to gather diagnostics

When filing a bug, please include the following:

| File | Path | What it shows |
|---|---|---|
| Action log | `%APPDATA%\sales-claw\runtime\data\action-log.json` | Per-company action history (form_fill, awaiting_approval, etc.) |
| Diagnostics | `%APPDATA%\sales-claw\runtime\data\dashboard-diagnostics.jsonl` | Server-side events (launch attempts, stall detection, recovery banners) |
| Managed session | `%APPDATA%\sales-claw\runtime\data\ai-runs\managed-claude-session.log` | PTY transcript of the latest Claude session |
| AI metrics | `%APPDATA%\sales-claw\runtime\data\ai-run-metrics.jsonl` | Token counts, batch durations, parallelTabs |
| Settings | `%APPDATA%\sales-claw\runtime\data\settings.json` (REDACT API keys!) | Active configuration |
| Screenshots | `%APPDATA%\sales-claw\runtime\data\screenshots\ss-{No}-*.png` | Form-fill evidence |

On macOS / Linux the parent path is
`~/Library/Application Support/sales-claw/runtime/data/` /
`~/.config/sales-claw/runtime/data/` respectively.

**Always redact `settings.json::apiKeys.*` and any
`provider-homes/<provider>/.claude/credentials.json` before sharing.**

---

## Related documents

- [README.md](./README.md) — project overview, install, quick start
- [CHANGELOG.md](./CHANGELOG.md) — full version-by-version history
- [ROADMAP.md](./ROADMAP.md) — known limitations, planned work
- [PRIVACY.md](./PRIVACY.md) — what data is stored where
- [SECURITY.md](./SECURITY.md) — vulnerability disclosure policy
- [CLAUDE.md](./CLAUDE.md) — project-internal rules for Claude Code agents
- [FAQ.md](./FAQ.md) — short-form Q&A
- [MIGRATION.md](./MIGRATION.md) — moving from CJS edition to v2.0.x

If your issue isn't covered here, please open an issue on
[GitHub Issues](https://github.com/joseikininsight-hue/sales-claw-ts/issues).

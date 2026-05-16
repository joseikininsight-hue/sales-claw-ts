# FAQ — Sales Claw

> Japanese version: [docs/ja/FAQ.md](./docs/ja/FAQ.md)

Frequently asked questions about Sales Claw. For specific bugs / symptoms,
see [TROUBLESHOOTING.md](./TROUBLESHOOTING.md). For the full project
description, see [README.md](./README.md).

## Table of contents

- [General](#general)
- [Setup](#setup)
- [Usage](#usage)
- [Compliance & legal](#compliance--legal)
- [Bilingual support](#bilingual-support)
- [Troubleshooting](#troubleshooting)

---

## General

### What is Sales Claw?

Sales Claw is a desktop tool that automates **B2B outreach via web contact
forms**. The Claude / Codex / Gemini CLIs analyze each target company's
website, draft a personalized message, and fill out the company's contact
form. A local Electron dashboard keeps the human in the loop for the final
send decision.

The tool is Japan-focused (Japanese forms, Japanese compliance) but the UI
and prompts are bilingual; English locale packs are first-class
([since v2.0.35](./CHANGELOG.md#2035---2026-05-16--i18n-フル対応-完遂-phase-2-5-全完了)).

### Is this a SaaS or a local app?

**Local desktop app**. Sales Claw runs entirely on your PC. Project
maintainers do not receive, store, or view any of your data. See
[PRIVACY.md](./PRIVACY.md) for the full data-handling breakdown.

The only outbound calls are:

- Your chosen LLM provider (Anthropic / OpenAI / Google) for analysis +
  message generation.
- The target company's website (analysis + form submission).
- GitHub Releases (auto-update check).
- Optional: SerpApi, Japan NTA Corporate Number API, gBizINFO, EDINET (only
  when you've configured the API key).

### Is Sales Claw free? Paid?

Sales Claw itself is **MIT-licensed open source — free**.

You will need one of the following to power the AI:

| Option | Cost |
|---|---|
| Claude.ai subscription (Pro / Team / Enterprise) | Subscription rates |
| Anthropic API key | Pay-per-token |
| OpenAI Codex (ChatGPT Pro or API key) | Subscription / pay-per-token |
| Google Gemini (subscription or API key) | Subscription / pay-per-token |

The dashboard's **AI cost estimate** chip (bottom-left) shows daily / monthly
spend so you don't get surprise bills.

### Which OS does Sales Claw support?

All three Electron platforms:

| OS | File |
|---|---|
| Windows | `Sales-Claw-Setup-x.x.x.exe` |
| macOS (Apple Silicon) | `Sales-Claw-x.x.x-arm64.dmg` |
| macOS (Intel) | `Sales-Claw-x.x.x-x64.dmg` |
| Linux | `Sales-Claw-x.x.x-x64.AppImage` |

Download from
[GitHub Releases](https://github.com/joseikininsight-hue/sales-claw-ts/releases).

### Is the installer code-signed?

**Not yet.** Code signing requires a Windows EV cert ($200-500/year + a
corporate identity), which the project does not yet have. Expect a
SmartScreen warning on first run — click **More info → Run anyway**. See
[ROADMAP.md](./ROADMAP.md#known-limitations).

You can verify the published SHA-256 hash on the GitHub Releases page if
you want extra assurance.

### Where are my settings / data stored?

| OS | Path |
|---|---|
| Windows | `%APPDATA%\sales-claw\runtime\data\` |
| macOS | `~/Library/Application Support/sales-claw/runtime/data/` |
| Linux | `~/.config/sales-claw/runtime/data/` |

Inside, `settings.json` is the single source of truth for configuration.
`action-log.json`, `contact-history.json`, screenshots, etc. live alongside
it. Full layout: [PRIVACY.md](./PRIVACY.md).

---

## Setup

### Do I need the Claude Code CLI?

**Yes — at least one of**: Claude Code CLI, Codex CLI, or Gemini CLI. They
are the engines that actually drive form analysis / generation / filling.
Sales Claw acts as the orchestrator + dashboard around them.

The default and most-tested provider is the Claude Code CLI.

### Do I need an API key?

It depends on your AI provider:

| Provider auth | API key needed? |
|---|---|
| Claude.ai subscription (Pro / Team / Enterprise) | **No** — OAuth login is enough |
| Anthropic API key | **Yes** — set `ANTHROPIC_API_KEY` |
| Codex via ChatGPT subscription | **No** — OAuth login |
| Codex via OpenAI API key | **Yes** — set `OPENAI_API_KEY` |
| Gemini via subscription | **No** — OAuth |
| Gemini via API key | **Yes** — `GEMINI_API_KEY` |

If you use only your Claude.ai subscription, no API key is required and
you'll never be billed per-token by Anthropic.

### What is MCP Playwright for?

**MCP Playwright** is the bridge that lets the Claude CLI control a real
browser via the Model Context Protocol. Sales Claw's form filling is
**MCP Playwright only** — the agent uses the `browser_*` tools to
navigate, snapshot, fill, and screenshot each contact form.

It's registered automatically on the first AI launch. If you want to
register it manually:

```bash
claude mcp add --scope user playwright \
  -- npx --yes @playwright/mcp@latest
```

See TROUBLESHOOTING [1.3](./TROUBLESHOOTING.md#13-claude-mcp-list-returns-empty--mcp-playwright-not-registered)
for details.

### How do I do the first-time setup?

On first launch (when `settings.json` is absent or in sample state) you're
auto-redirected to the **5-step onboarding wizard**:

1. Welcome + terms of use consent
2. Company profile (`companyProfile`)
3. Your strengths (`valuePropositions.strengths`)
4. Target list upload (Excel / CSV — can be skipped)
5. AI integration (Claude / Codex / Gemini login check)

To re-open it manually:

```
http://127.0.0.1:3765/onboarding           # resume
http://127.0.0.1:3765/onboarding?fresh=1   # restart from step 1
```

---

## Usage

### How does multi-company parallel processing work?

Set **`preferences.parallelTabs`** (1-3, default 1) in Settings. The
form-fill phase (Phase B) overlaps the navigation / submit I/O of multiple
companies in a single browser via cooperative tab pipelining.

Realistic speedup measured against a dummy form server (v2.0.28):

| Companies | Serial (tabs=1) | Parallel (tabs=3) | Speedup |
|---|---|---|---|
| 2 | 7,371 ms | 3,867 ms | 1.91× |
| 3 | 11,030 ms | 3,988 ms | 2.77× |

Each company takes roughly **5-7 minutes end-to-end** in real production
runs (analysis + message + form fill + screenshot). 100 companies at
parallelTabs=2 ≈ 4.5-6 hours. **Don't go above 3** — the agent loses track
of which tab belongs to which company.

### What's the difference between Phase A and Phase B?

| Phase | What | Parallel? | Tools |
|---|---|---|---|
| **Phase A** | Site analysis + message-prompt construction | **Parallel** (haiku sub-agents) | Plain HTTP fetch only |
| **Phase A.5** | CLI personalizes the message body per company | Parallel within one CLI | LLM only |
| **Phase B** | Form discovery + structure analysis + filling + screenshot | **Sequential** (with optional tab pipelining) | MCP Playwright |

Phase A is fast and cheap because it doesn't touch the browser. Phase B is
the slow / expensive phase because it drives a real browser through MCP
Playwright. Splitting them lets the dashboard show useful progress
("analyzed 50 / 100, filling form 13 / 100") even on long batches.

### What can I do from the Awaiting Approval tab?

Each `awaiting_approval` row shows the screenshot of the filled form plus
the action history. From there you can:

- **Mark as sent** — record the company as `submitted`.
- **Skip** — record as `skipped` with a reason.
- **Edit and resend** — open the message body, edit it, and re-queue the
  company. Useful for fine-tuning AI output before sending.
- **Open form** — re-focus the live MCP Playwright tab the agent kept open
  (for CAPTCHA solving / final check).

The send button on the dashboard is the single human gate before any
message actually leaves your machine.

### What if the AI writes a wrong / off-target message?

You have two options:

1. **Edit and resend** — open the row in Awaiting Approval, edit the
   message body inline, and re-queue. The edited body becomes the new
   `sentMessage`.
2. **Skip + retry** — mark the company as `skipped` with reason
   "regenerate", then re-queue from the Companies tab. The agent will
   redo the analysis from scratch.

To prevent the same kind of misfire on other companies, refine your
**Settings → Message Templates → Approach Objective** and **Approach
Guardrails** — those are auto-injected into the CLI prompt.

### How do I keep the queue clean if a batch hangs?

1. Click **STOP** in the header AI status chip — this kills the active
   batch.
2. Click the purple **キュー / QUEUE** button next to STOP — this clears
   `pending` + `activeBatch` so you can re-submit cleanly.

The QUEUE button was added in v2.0.24. A confirmation dialog protects
against misclicks.

---

## Compliance & legal

### Does Sales Claw guarantee CAN-SPAM / GDPR / 特定電子メール法 compliance?

**No.** Sales Claw provides best-effort safety rails but does not
substitute for legal review. From [README.md](./README.md):

> The user is solely responsible for complying with anti-spam laws and
> unsolicited-contact regulations in their jurisdiction.

What Sales Claw provides:

- A **compliance scanner** (`src/compliance.ts`) that checks for the four
  required elements of Japan's 特定電子メール法 and warns when missing.
- A **4-locale Compliance Registry** (since v2.0.35 Phase 4):
  - `ja-jp` — 特定電子メール法 (sender / contact email / opt-out)
  - `en-us` — CAN-SPAM (sender / **postal address required** / opt-out /
    commercial purpose)
  - `en-eu` — GDPR Art.6/13 (lawful basis / data controller / opt-out +
    withdraw consent)
  - `other` — minimum requirements
- An always-on **`awaiting_approval` human gate** before any message is
  actually sent.
- A **"no solicitation" detector** that auto-skips out-of-scope forms
  (no sales / existing customers only / hiring only / IR only / press
  only).

These are tools to help you stay compliant, not a guarantee. **Use at your
own risk.**

### How is personal information handled?

Personal information is **stored locally only** and never sent to project
maintainers. The detailed inventory is in [PRIVACY.md](./PRIVACY.md).

External services (LLM providers, target company websites, etc.) only
receive what you explicitly send them — your settings, the company name
you're targeting, the website content you're analyzing, etc.

By default, Sales Claw **does not extract personal email addresses or
personal names** from third-party sites — see
[CLAUDE.md](./CLAUDE.md#design-principles-spec-12--list-builder-discovery-phase-only)
"Safe defaults".

### Does Sales Claw ever send a message without my approval?

By default, **no** — every message goes through the `awaiting_approval`
human gate.

If you set `preferences.autoSendEligibleForms = true` and the message
passes every safety check (compliance scan + sendability gate +
`validateSentMessageQuality`), the dashboard will auto-mark it as `sent`.
This is opt-in and disabled by default. Refer to
[CLAUDE.md](./CLAUDE.md) for the exact gates.

---

## Bilingual support

### How do I switch the UI language?

Click the **🌐 EN / 🌐 日本語** toggle in the dashboard header (top-right,
next to the theme toggle). The page reloads automatically into the new
language.

The current language is shown by displaying the **opposite** language on
the button (i.e. "EN" when you're currently in Japanese, "日本語" when in
English).

Available since v2.0.33. Full UI coverage (Settings, Awaiting, Sent,
List Builder, Stats, etc.) was completed in v2.0.37.

### Will my Japanese settings break if I switch to English mode?

**No.** All settings stay valid. The language toggle only affects what
labels the UI displays — it doesn't change `settings.json` field
semantics or values.

Default = `'ja'` for full backward compatibility with existing Japanese
users (v2.0.36 added an extra safety net to ensure
`messageTemplates.language === 'ja'` users keep the previous Japanese-first
behavior).

### How do I send English messages to English-speaking companies?

Open **Settings → Message Templates** and set:

| Field | Value | Behavior |
|---|---|---|
| `language` | `'auto'` (default) | Sales Claw auto-detects the target site's language (HTML lang attribute → meta → CJK ratio → default). English sites get an English message; Japanese sites get a Japanese message. |
| `language` | `'ja'` | Always Japanese (legacy behavior). |
| `language` | `'en'` | Always English. |

For mixed batches (some companies JA, some EN), `'auto'` mode resolves
each company independently and uses majority vote for the batch-level
prompt rules. Each company's `targetLanguage` is preserved in the
`payload`.

### How do I add a new language locale?

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full procedure. Roughly:

1. Add a new directory under `src/locale-pack/<locale>/`
2. Implement the same files as `ja/` and `en/` (form-finder-hints,
   sendability-exclusions, keyword-dict, cli-prompts, llm-prompts,
   message-templates, compliance-rules)
3. Register it in `src/locale-pack/index.ts`
4. Add UI strings to `src/i18n.ts`

PRs welcome.

---

## Troubleshooting

### "AI won't launch" — what should I check?

See [TROUBLESHOOTING.md Category 1](./TROUBLESHOOTING.md#category-1--ai-launch--cli-issues).
Most common causes:

- v2.0.30 or earlier (timeout bug) → upgrade to v2.0.31+
- MCP Playwright not registered → run `claude mcp add ...` manually
- "Logged in" false-negative → upgrade to v2.0.29+

### "Target list file not found" — how do I fix it?

See [TROUBLESHOOTING 2.1](./TROUBLESHOOTING.md#21-対象が見つかりません--target-list-file-not-found-forever).
Auto-recovery was added in v2.0.32. If you're on v2.0.32+ and still see
the error, re-select the file in **Settings → Target List**.

### "Phase B says error even though the form was filled" — why?

See [TROUBLESHOOTING 2.2](./TROUBLESHOOTING.md#22-forms-reach-error-instead-of-awaiting_approval-even-though-phase-b-finished).
The 800-character `site_analysis` guard rejected real, completed work in
v2.0.31 and earlier. Upgrade to v2.0.32+.

### Where do I find logs to attach to a bug report?

See
[TROUBLESHOOTING — How to gather diagnostics](./TROUBLESHOOTING.md#how-to-gather-diagnostics)
for the full list. Always **redact `settings.json::apiKeys.*` and
`provider-homes/<provider>/.claude/credentials.json`** before sharing.

### The dashboard port keeps changing

The dashboard server tries port **3765** first and falls back to
**3766 → 3767 → ...** if the port is taken. The actual port is written to
`%APPDATA%\sales-claw\runtime\data\dashboard-runtime.json` and exposed to
the AI session as `$SALES_CLAW_DASHBOARD_URL`.

If you script against the dashboard, always read the port from
`dashboard-runtime.json` rather than hardcoding `3765`.

---

## Related documents

- [README.md](./README.md) — project overview
- [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) — bug catalog with fixes
- [CHANGELOG.md](./CHANGELOG.md) — version history
- [ROADMAP.md](./ROADMAP.md) — known limitations + future plans
- [PRIVACY.md](./PRIVACY.md) — data handling
- [SECURITY.md](./SECURITY.md) — vulnerability disclosure
- [CONTRIBUTING.md](./CONTRIBUTING.md) — how to contribute
- [CLAUDE.md](./CLAUDE.md) — project rules for Claude Code agents
- [MIGRATION.md](./MIGRATION.md) — moving from CJS edition

For anything not covered, please open an issue on
[GitHub Issues](https://github.com/joseikininsight-hue/sales-claw-ts/issues).

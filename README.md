# Sales Claw

[![Release](https://img.shields.io/github/v/release/joseikininsight-hue/sales-claw-ts?style=flat-square)](https://github.com/joseikininsight-hue/sales-claw-ts/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-100%25-blue.svg?style=flat-square)](https://www.typescriptlang.org/)
[![Bilingual](https://img.shields.io/badge/UI-JA%20%2F%20EN-brightgreen.svg?style=flat-square)](#bilingual-support)

> Japanese version: [docs/ja/README.md](./docs/ja/README.md)

**B2B outreach automation for web contact forms.** Sales Claw drives the
Claude Code CLI (or Codex / Gemini) to analyze a target company's website,
draft a personalized message, and fill out the company's contact form —
autonomously and at scale. A local Electron dashboard keeps a human in the
loop for the final send decision.

> **v2.0.37** (2026-05): Full bilingual support — every UI surface
> (header, onboarding, settings, awaiting / sent tabs, list builder, stats)
> now ships with first-class Japanese and English locale packs. See the
> [CHANGELOG](./CHANGELOG.md) for the rollout history (Phase 1 → Phase 5).

Latest releases: [GitHub Releases](https://github.com/joseikininsight-hue/sales-claw-ts/releases)

---

## Table of contents

- [Highlights](#highlights)
- [System requirements](#system-requirements)
- [Quick start (5 minutes)](#quick-start-5-minutes)
- [Bilingual support](#bilingual-support)
- [Architecture overview](#architecture-overview)
- [Send policy](#send-policy)
- [Disclaimer](#disclaimer)
- [Documentation](#documentation)
- [Contributing](#contributing)
- [Security](#security)
- [License](#license)

---

## Highlights

### Core capabilities (v2.0.37)

- **AI-driven form filling** — Phase A runs N parallel company analyses
  (plain HTTP, no browser, `parallelTabs` configurable 1–3), then Phase B
  drives a single MCP Playwright session sequentially to fill, screenshot,
  and queue each form for human approval. See the
  [pipeline diagram](#architecture-overview) below.
- **Bilingual UI** — header language toggle (🇯🇵 ⇄ 🇺🇸) plus an onboarding
  language picker. The chosen locale propagates to message-generation
  prompts so the AI drafts in the same language.
- **Locale-aware message generation** — `messageTemplates.locale` selects
  Japanese or English tone, signature format, and compliance footer
  language; the AI prompt is rendered in the target locale automatically.
- **Compliance Registry (4 locales)**:
  | Locale | Statute / framework | Auto-appended |
  |--------|--------------------|---------------|
  | `ja-jp` | 特定電子メール法 (Specified Commercial Email Act) | Sender, contact email, opt-out wording |
  | `en-us` | CAN-SPAM Act | Sender, physical postal address, opt-out link |
  | `en-eu` | GDPR / ePrivacy | Lawful basis, controller identity, opt-out |
  | `other` | Generic / best-effort | Sender + opt-out wording only |
- **List Builder** (1.2.43+) — discover and qualify candidate companies
  using three input modes (URL crawl / natural language / category preset)
  and Japanese official APIs: 国税庁法人番号 (Corporate Number API),
  gBizINFO, EDINET. Every record is human-confirmed before being added to
  the target list.
- **Crash recovery** — interrupted batches are restored from
  `data/recovery/managed-ai-batches.json` on next launch; the dashboard
  shows a "Resume / Discard" banner.
- **Cost visibility** — a live AI-cost estimator chip (today / this month /
  per-company average) uses Anthropic's public pricing and your configured
  `preferences.usdJpy` rate.
- **Screenshot audit trail** — every `awaiting_approval` record includes
  the exact text typed into the form and a screenshot
  (`screenshots/ss-{No}-input.png`). A 422 API guard rejects records that
  omit either.
- **Auto-update** — installed apps poll GitHub Releases 5 s after launch
  and every 6 h thereafter; updates download silently and prompt
  "Restart to update".

### Supported AI CLIs (pluggable per session)

- Claude Code CLI 2.0+ (primary)
- Codex CLI 0.128+
- Gemini CLI 0.1+

---

## System requirements

| | Minimum | Recommended |
|-|---------|-------------|
| OS | Windows 10 / 11, macOS 13+, Ubuntu 22.04+ | Windows 11 |
| RAM | 4 GB | 8 GB |
| Disk | 1 GB free | 2 GB free |
| Network | Outbound HTTPS to AI provider + GitHub | Same |
| **Node.js** | 20+ *(only for development from source)* | 20 LTS |
| **AI CLI** | One of Claude / Codex / Gemini | Claude Code CLI 2.0+ |

The packaged Electron installers bundle their own Node runtime — end users
do **not** need to install Node.js.

---

## Quick start (5 minutes)

### 1. Download the installer

Grab the latest from
[GitHub Releases](https://github.com/joseikininsight-hue/sales-claw-ts/releases/latest):

| OS | File |
|----|------|
| Windows | `Sales-Claw-Setup-2.0.37.exe` |
| macOS (Apple Silicon) | `Sales-Claw-2.0.37-arm64.dmg` |
| macOS (Intel) | `Sales-Claw-2.0.37-x64.dmg` |
| Linux | `Sales-Claw-2.0.37-x64.AppImage` |

### 2. Install (per-user, no admin required) and launch

The Windows installer drops Sales Claw into
`%LOCALAPPDATA%\Programs\Sales Claw\` and adds a Start Menu shortcut. No
elevation prompt is needed. On macOS, drag the app into Applications. On
Linux, `chmod +x` the AppImage and double-click.

### 3. Run the onboarding wizard

On first launch, the dashboard auto-redirects to `/onboarding`. Walk
through 5 steps:

1. **Welcome + Language** — pick 🇯🇵 Japanese or 🇺🇸 English and accept
   the OSS terms of use.
2. **Company profile** — your sender identity (company name, contact name,
   email, phone). Used in every message and in the compliance scanner.
3. **Strengths** — pick 1–2 from 8 presets (or add custom). These drive
   the gap-analysis prompt that personalizes each message.
4. **Target list** — drop in an Excel/CSV; skippable.
5. **AI integration** — verify at least one of Claude / Codex / Gemini is
   installed and authenticated.

A `_onboardedAt` timestamp is written to `data/settings.json`; subsequent
launches go straight to the dashboard. Re-run anytime via
`http://127.0.0.1:3765/onboarding?fresh=1`.

### 4. Trigger an AI form-fill run

On the **Companies** tab, select one or more targets and click
**AI Form Fill**. Sales Claw spawns a managed Claude / Codex / Gemini PTY
that:

- **Phase A** (parallel, no browser): analyzes each company's website,
  builds a personalized message prompt, and resolves the contact-form URL.
- **Phase B** (sequential, MCP Playwright): navigates each form, fills
  every field, takes a screenshot, and logs `awaiting_approval`.

The CLI Activity panel (bottom-right FAB) streams live progress.

### 5. Review and send

Open the **Awaiting** tab. Each row shows the filled form's screenshot,
the exact message body, and the form URL. Click **Mark Sent** (or **Skip**
with a reason) to finalize. If `autoSendEligibleForms` is enabled, forms
with no CAPTCHA / manual confirmation / sales-NG marker auto-submit.

---

## Bilingual support

Sales Claw v2.0.37 ships full Japanese / English locale packs covering:

- Header chrome, sidebar navigation, status badges
- Onboarding wizard (5 steps)
- Settings (every tab: profile, strengths, templates, list builder keys,
  preferences)
- Awaiting Approval, Sent History, Skipped, Errors tabs
- List Builder UI (URL / natural-language / category modes)
- Stats panel, pipeline bar, donut chart, 7-day trend

Switch language anytime via the header toggle button (state persists in
`localStorage`). The same `locale` flows into the message-generation
prompt, so AI-authored content matches the UI language.

To add a new locale, follow the Phase 2 Locale Pack pattern under
`src/locale-pack/` and register it in `src/i18n/registry.ts`.

---

## Architecture overview

```
┌──────────────────────────────────────────────────────────┐
│        Claude / Codex / Gemini CLI (managed PTY)         │
│  Phase A: parallel analysis · Phase B: form-fill driver  │
└─────────────┬─────────────────────────────┬──────────────┘
              │                             │
      ┌───────▼─────────┐         ┌─────────▼──────────┐
      │  MCP Playwright │         │  Node.js modules    │
      │ (browser_*)     │         │  (analysis / gen)   │
      └───────┬─────────┘         └─────────┬──────────┘
              │                             │
      ┌───────▼─────────────────────────────▼──────────┐
      │   Electron app + local dashboard server          │
      │   (TypeScript, 127.0.0.1, session-token gated)   │
      │   Companies | Awaiting | Sent | Settings         │
      └──────────────────────────────────────────────────┘
                              │
                  ┌───────────▼────────────┐
                  │  data/settings.json    │
                  │  (single source of     │
                  │   truth, gitignored)   │
                  └────────────────────────┘
```

- **Electron + TypeScript dashboard server** — all UI, settings, target
  list, approval queue, sent log, real-time CLI activity. Source of truth
  lives in `data/settings.json`. Dashboard binds to `127.0.0.1` only.
- **Claude PTY for autonomous form filling** — Sales Claw spawns the AI
  CLI in a managed PTY with a sanitized environment (API keys stripped
  before spawn). The CLI drives MCP Playwright to navigate, fill, and
  screenshot.
- **MCP Playwright for browser automation** — every form interaction goes
  through `browser_navigate` / `browser_snapshot` / `browser_fill_form` /
  `browser_take_screenshot`. No direct JS automation or custom Playwright
  worker is permitted.
- **Auto-update** — `electron-updater` + `.github/workflows/release.yml`
  publishes Windows / macOS / Linux artifacts plus `latest*.yml` to
  GitHub Releases on every push to `main`.

For the exhaustive operating contract that the AI CLI itself reads, see
[CLAUDE.md](./CLAUDE.md).

---

## Send policy

- **Default**: stop at `awaiting_approval`. A human reviews the screenshot
  and clicks **Mark Sent**. The `details` payload of `awaiting_approval`
  / `submitted` must include `sentMessage` (the exact body typed) — a
  422 API guard rejects entries that omit it or are shorter than 30
  characters.
- **Optional**: enable `preferences.autoSendEligibleForms` to auto-submit
  forms with no CAPTCHA, no "manual confirmation required" marker, and no
  "no solicitation" notice.
- **Always stops at `awaiting_approval`** regardless of auto-send: any
  CAPTCHA (reCAPTCHA / hCaptcha / Turnstile), "no solicitation" /
  existing-customers-only / hiring-only / IR-only / press-only forms
  (these are logged as `skipped`), and any ambiguous case.

---

## Disclaimer

**This tool does NOT guarantee legal compliance.** The user is solely
responsible for:

- Complying with anti-spam / unsolicited-contact laws in their
  jurisdiction (CAN-SPAM in the US, GDPR / ePrivacy in the EU,
  特定電子メール法 / 特定商取引法 in Japan, and equivalent statutes
  elsewhere).
- The appropriateness of outreach to each recipient, including respecting
  "no solicitation" notices, opt-out requests, and any policies stated on
  the contact form.
- The factual accuracy of every message generated and sent.
- All consequences arising from messages sent through this tool.

Sales Claw provides best-effort safety rails:

- A **compliance scanner** (`src/compliance.cjs`) that checks for the
  required elements of each registered locale (sender, contact email,
  opt-out wording, etc.) and warns when they are missing.
- An always-on **human-in-the-loop approval gate** (`awaiting_approval`)
  before any message is actually sent.
- A **"no solicitation" detector** that auto-skips forms explicitly
  marked as not-for-sales / existing-customers-only / hiring-only /
  IR-only / press-only.
- A **screenshot audit trail** — every approval row carries the exact
  text typed and an `ss-{No}-input.png` screenshot, enforced by a 422
  API guard.

These are not a substitute for legal review. **Use at your own risk.**

---

## Documentation

### For end users

- [SETUP.md](./SETUP.md) — Step-by-step installation, onboarding, and
  first-run guide *(in preparation)*
- [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) — Common errors and fixes
  *(in preparation)*
- [FAQ.md](./FAQ.md) — Frequently asked questions *(in preparation)*
- [SUPPORT.md](./SUPPORT.md) — How to get help / report bugs
- [PRIVACY.md](./PRIVACY.md) — What data Sales Claw stores locally and
  what it sends to AI providers

### For AI agents and developers

- [CLAUDE.md](./CLAUDE.md) — The operating contract the Claude / Codex /
  Gemini CLI reads as its system prompt (English)
- [AGENTS.md](./AGENTS.md) — Agent orchestration rules
- [CONTRIBUTING.md](./CONTRIBUTING.md) — Coding style, PR flow, test
  requirements
- [SECURITY.md](./SECURITY.md) — Threat model, private-disclosure flow,
  security defaults
- [MIGRATION.md](./MIGRATION.md) — v1.2.111 → v2.0.0 migration notes
- [ROADMAP.md](./ROADMAP.md) — Upcoming work and version goals
- [CHANGELOG.md](./CHANGELOG.md) — Full per-version release notes
- [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md) — Community standards

### Deep dives

- [docs/list-builder-requirements.md](./docs/list-builder-requirements.md)
  — Full List Builder spec (v2.0)
- [docs/release-parity-and-autoupdate.md](./docs/release-parity-and-autoupdate.md)
  — Desktop release pipeline + auto-update
- [docs/dashboard-port-lifecycle.md](./docs/dashboard-port-lifecycle.md)
  — Dashboard port allocation, `runtime.json`, lock semantics
- [docs/typescript-migration-roadmap.md](./docs/typescript-migration-roadmap.md)
  — History of the v2.0 TypeScript migration
- [docs/programmatic-credit-migration.md](./docs/programmatic-credit-migration.md)
  — Anthropic 2026-06-15 policy compliance
- [docs/form-fill-rules-and-settings-audit.md](./docs/form-fill-rules-and-settings-audit.md)
  — Form-fill rule audit log

### Japanese versions

- [docs/ja/README.md](./docs/ja/README.md) — Japanese README
- [docs/ja/CLAUDE.md](./docs/ja/CLAUDE.md) — Japanese CLAUDE.md
- [docs/ja/CONTRIBUTING.md](./docs/ja/CONTRIBUTING.md) — Japanese
  CONTRIBUTING.md

---

## Contributing

PRs, bug reports, translations, and docs improvements are welcome.

Please read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening a PR and
follow our [Code of Conduct](./CODE_OF_CONDUCT.md).

To add a new UI locale, follow the Phase 2 Locale Pack pattern in
`src/locale-pack/` and register it via `src/i18n/registry.ts`.

To build from source:

```bash
git clone https://github.com/joseikininsight-hue/sales-claw-ts.git
cd sales-claw-ts
npm install
npx playwright install chromium
npm start                # Electron app
# or
npm run dashboard        # dashboard server only (browser)
```

---

## Security

To report a vulnerability, please use the GitHub Private Security Advisory
flow described in [SECURITY.md](./SECURITY.md) — **do not open a public
issue** for security problems.

Security defaults (more in `SECURITY.md`):

- Dashboard binds to `127.0.0.1` only — never reachable from the network.
- Every API request requires a per-launch session token
  (`x-sales-claw-session` header), stored under
  `%APPDATA%\sales-claw\runtime\data\dashboard-session.json`.
- `data/settings.json` is in `.gitignore` — API keys never get committed.
- Child-process environment is sanitized before spawning AI CLIs
  (`ANTHROPIC_API_KEY`, `AWS_*`, `OPENAI_API_KEY`, etc. are stripped by
  default).
- SSRF protection on all server-side URL fetches
  (`parallel-analysis.ts::isSafeUrl`).
- `logAction` is shell-free: only `curl POST /api/log-action` is
  accepted, the legacy `node -e` path was removed in 1.2.91 because it
  allowed shell / prompt injection RCE.
- 422 API guard on `awaiting_approval` / `submitted`: rejects records
  missing `sentMessage` or screenshot, and rejects degenerate
  TEL/MAIL-dump bodies (<30 chars).

---

## License

[MIT License](./LICENSE). See [`package.json`](./package.json) (`license`
field) — `MIT` is the project's declared license.

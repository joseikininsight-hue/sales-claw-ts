# Sales Claw

[![Release](https://img.shields.io/github/v/release/joseikininsight-hue/sales-claw-ts?style=flat-square)](https://github.com/joseikininsight-hue/sales-claw-ts/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-100%25-blue.svg?style=flat-square)](https://www.typescriptlang.org/)

> Japanese version: [docs/ja/README.md](docs/ja/README.md)

**B2B outreach automation via web contact forms.** Sales Claw lets the
Claude / Codex / Gemini CLIs analyze a target company's website, draft a
personalized message, and fill out the company's contact form — autonomously
and at scale. A local Electron dashboard keeps the human in the loop for the
final send decision.

The tool is Japan-focused (Japanese forms, Japanese compliance) but the UI and
prompts are bilingual; English locale packs are first-class.

> **2.0.0 (2026-05-14)**: First stable release of the fully TypeScript port.
> `src/` is now 100% TypeScript with end-to-end type safety on the server
> side. See [CHANGELOG](./CHANGELOG.md) for details.

Latest releases: [GitHub Releases](https://github.com/joseikininsight-hue/sales-claw-ts/releases)

Supported AI CLIs (pluggable per session):

- Claude Code CLI
- Codex CLI
- Gemini CLI

---

## Disclaimer

**This tool does NOT guarantee legal compliance.** The user is solely
responsible for:

- Complying with anti-spam laws and unsolicited-contact regulations in their
  jurisdiction (CAN-SPAM in the US, GDPR / ePrivacy in the EU,
  特定電子メール法 / 特定商取引法 in Japan, and equivalent statutes elsewhere).
- The appropriateness of outreach to each recipient, including respecting
  "no solicitation" notices, opt-out requests, and company policies stated on
  the contact form.
- The factual accuracy of every message generated and sent.
- All consequences arising from messages sent through this tool.

Sales Claw provides:

- A "compliance scanner" (`src/compliance.cjs`) that checks for the four
  required elements of Japan's 特定電子メール法 (sender company name, sender
  personal name, contact email, and opt-out instructions) and warns when they
  are missing.
- An always-on human-in-the-loop approval gate (`awaiting_approval`) before
  any message is actually sent.
- A "no solicitation" detector that auto-skips forms explicitly marked as
  not-for-sales / existing-customers-only / hiring-only / IR-only.

These are best-effort safety rails, not a substitute for legal review.
**Use at your own risk.**

---

## Quick Start

### 1. Install

Download a prebuilt installer from
[GitHub Releases](https://github.com/joseikininsight-hue/sales-claw-ts/releases):

| OS | File |
|----|------|
| **Windows** | `Sales-Claw-Setup-x.x.x.exe` |
| **macOS (Apple Silicon)** | `Sales-Claw-x.x.x-arm64.dmg` |
| **macOS (Intel)** | `Sales-Claw-x.x.x-x64.dmg` |
| **Linux** | `Sales-Claw-x.x.x-x64.AppImage` |

Or build from source (Node.js 18+ required):

```bash
git clone https://github.com/joseikininsight-hue/sales-claw-ts.git
cd sales-claw-ts
npm install
npx playwright install chromium
npm start
```

### 2. Launch the app and run the Onboarding Wizard

On first launch (no `data/settings.json` yet), the dashboard automatically
redirects to `/onboarding`. Walk through 5 steps:

1. Welcome + terms of use (OSS, self-responsibility) acknowledgement
2. Company profile (name, contact name, email, phone)
3. Your strengths — pick 1-2 from 8 presets or add custom
4. Target list (Excel / CSV; can be skipped)
5. AI integration — verify Claude / Codex / Gemini are installed and logged in

### 3. Select language (Japanese / English)

The wizard and the dashboard both support Japanese and English. The locale
also affects message-generation prompts, so the AI CLI will draft messages in
the chosen language.

### 4. Configure company profile and select strengths

Open the **Settings** tab. The "Setup progress tracker" shows which sections
are filled in. Populate:

- `companyProfile` — your sender identity (used in every message and in
  compliance checks).
- `valuePropositions.strengths` — what you offer. Used for gap-analysis
  against each target company.
- `messageTemplates.approachObjective` / `approachGuardrails` — a free-text
  description of "what you want to achieve" and "what to avoid". These are
  injected verbatim into the message-generation prompt.

### 5. Install at least one AI CLI

Sales Claw drives an external AI CLI to do the analysis and form-filling.
Install one or more:

```bash
# Claude Code (recommended)
npm install -g @anthropic-ai/claude-code

# Codex
npm install -g @openai/codex

# Gemini
npm install -g @google/gemini-cli
```

Then in the dashboard, click **AI Form Fill** (or in the managed AI panel,
say something like `"Process the first 3 targets up to the approval queue"`)
and the CLI will start working through your target list.

The human stays in the loop: every filled form pauses in the **Approval
Queue** tab with a screenshot, and you click **Send** when ready.

---

## Architecture overview

```
┌─────────────────────────────────────────────────────┐
│          Claude / Codex / Gemini CLI                │
│   (analyzes companies, drafts messages, fills forms) │
└────────────┬────────────────────────┬────────────────┘
             │                        │
     ┌───────▼───────┐       ┌───────▼────────┐
     │  MCP Playwright │       │  Node.js modules │
     │ (browser actions)│       │ (analysis / gen) │
     └───────┬───────┘       └───────┬────────┘
             │                        │
     ┌───────▼────────────────────────▼────────┐
     │   Electron app + local dashboard          │
     │   (127.0.0.1:3765, session-token gated)   │
     │   targets | approval | sent | settings    │
     └─────────────────────────────────────────┘
```

- **Electron + TypeScript dashboard** — settings UI, target list, approval
  queue, sent log, real-time CLI activity stream. Source of truth for all
  configuration lives in `data/settings.json`.
- **Claude / Codex / Gemini CLI as the form-filler** — Sales Claw spawns the
  CLI in a managed PTY, passes it a sanitized environment (API keys
  stripped), and lets the AI navigate / fill / screenshot via MCP Playwright.
- **Two-phase parallel pipeline** — Phase A (analysis + prompt building) runs
  N companies in parallel via plain Node HTTP fetch (no browser). Phase B
  (form fill + screenshot) runs sequentially through MCP Playwright so the
  browser session stays clean.
- **Human approval gate** — every filled form ends in `awaiting_approval`
  with a mandatory screenshot and the exact text that was typed into the
  form body. No message is sent until the user clicks **Send** in the UI.

For full operating rules read [CLAUDE.md](./CLAUDE.md) (this is what the
Claude CLI itself loads as its instructions).

---

## Send policy

- **Default**: stop at `awaiting_approval`. A human reviews the screenshot
  and clicks Send.
- **Optional**: enable `autoSendEligibleForms` to auto-submit forms that have
  no CAPTCHA / no "manual confirmation required" / no "no solicitation"
  marker.
- CAPTCHA forms and ambiguous forms always stop at `awaiting_approval`
  regardless of the auto-send setting.

---

## Documentation

- [CLAUDE.md](./CLAUDE.md) — the operating rules the AI CLI reads (English).
- [docs/ja/CLAUDE.md](./docs/ja/CLAUDE.md) — Japanese version of CLAUDE.md.
- [docs/ja/README.md](./docs/ja/README.md) — Japanese version of this README.
- [docs/list-builder-requirements.md](./docs/list-builder-requirements.md) —
  Spec for the List Builder feature (target-company discovery).
- [docs/release-parity-and-autoupdate.md](./docs/release-parity-and-autoupdate.md) —
  Desktop release pipeline + auto-update.
- [docs/typescript-migration-roadmap.md](./docs/typescript-migration-roadmap.md) —
  TS migration history.
- [docs/dashboard-port-lifecycle.md](./docs/dashboard-port-lifecycle.md) —
  Dashboard port allocation / runtime.json / lock semantics.
- [docs/programmatic-credit-migration.md](./docs/programmatic-credit-migration.md) —
  Anthropic 2026-06-15 policy compliance.
- [CHANGELOG.md](./CHANGELOG.md) — Per-version release notes.

---

## Contributing

PRs, bug reports, translations, and docs improvements are welcome.

Please read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening a PR, and
follow our [Code of Conduct](./CODE_OF_CONDUCT.md).

To add a new UI locale, follow the Phase 2 Locale Pack pattern in
`src/locale-pack/`.

---

## Security

To report a vulnerability, please use the GitHub Private Security Advisory
flow described in [SECURITY.md](./SECURITY.md) — **do not open a public
issue** for security problems.

Security defaults (more in `SECURITY.md`):

- Dashboard binds to `127.0.0.1` only.
- All API requests require a per-launch session token
  (`x-sales-claw-session` header).
- `data/settings.json` is in `.gitignore` — never commit API keys.
- Child-process environment is sanitized (`ANTHROPIC_API_KEY`, `AWS_*`,
  `OPENAI_API_KEY`, etc. removed by default before spawning CLIs).
- MCP Playwright runs in its own browser context, separate from the
  dashboard.
- SSRF protection on all server-side URL fetches
  (`parallel-analysis.ts::isSafeUrl`).

---

## License

[MIT License](./LICENSE). See [`package.json`](./package.json) (`license`
field) — `MIT` is the project's declared license.

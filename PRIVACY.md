# Privacy & Data Handling

> Japanese version: [docs/ja/PRIVACY.md](./docs/ja/PRIVACY.md)

This document explains exactly what data Sales Claw handles and where. It
doubles as our privacy policy — Sales Claw itself is not a SaaS, but a
desktop application running on the user's machine, so the project operators
collect no data.

## Summary — Sales Claw runs entirely locally

Sales Claw is a tool that **runs entirely on the user's local PC**. The
project operators (Sales Claw contributors) never receive, store, or view
user data.

However, if the user opts into any of the external services listed below,
that service's privacy policy applies:

| External service | Use | Data destination |
|---|---|---|
| Claude API (Anthropic) | Company analysis / message generation | https://api.anthropic.com ([Anthropic privacy policy](https://www.anthropic.com/legal/privacy)) |
| OpenAI Codex API | Same as above (when Codex is selected) | [OpenAI privacy policy](https://openai.com/policies/privacy-policy) |
| Google Gemini API | Same as above (when Gemini is selected) | [Google privacy policy](https://policies.google.com/privacy) |
| SerpApi | Company-list discovery (NLQ / category mode) | https://serpapi.com (optional, only when an API key is set) |
| Japan NTA Corporate Number Web API | Corporate existence verification | https://www.houjin-bangou.nta.go.jp (optional, only when an API key is set) |
| gBizINFO | Company detail information | https://info.gbiz.go.jp (optional, only when an API key is set) |
| EDINET | Listed-company financial data | https://disclosure.edinet-fsa.go.jp (optional, only when an API key is set) |
| Target company website | Official site analysis / contact-form submission | The domain the user specified |
| GitHub (auto-update) | Update check on startup | https://api.github.com (releases metadata only) |

## Locally stored data

User data lives under these directories:

### Windows
```
%APPDATA%\sales-claw\runtime\data\
├── settings.json              User settings (own company info / strengths / API keys / etc.)
├── action-log.json            Sent log
├── contact-history.json       Contact history
├── outreach-targets.json      Target list
├── live-monitor.json          Progress state
├── dashboard-runtime.json     Dashboard launch info
├── ai-runs/                   AI execution logs (PTY sessions)
├── ai-prompts/                Prompts sent to the AI
├── claude-prompts/            Claude prompt history
├── provider-homes/<provider>/ Per-AI-CLI credentials (subscription token)
├── cache/analysis/            Company-analysis cache (30-day TTL, sha256 hash key)
├── recovery/                  Crash-recovery snapshot
└── screenshots/               Screenshots taken during form fill
```

### macOS
```
~/Library/Application Support/sales-claw/runtime/data/
```

### Linux
```
~/.config/sales-claw/runtime/data/
```

## API keys / credentials

- API keys stored in `data/settings.json::apiKeys` are kept in **plaintext**
  (Phase 1 design).
  - Encryption is planned for Phase 8 (see [CHANGELOG](./CHANGELOG.md) and
    the roadmap).
  - The file is in `.gitignore` to avoid accidentally committing keys to a
    shared machine or public repo.
- AI CLI subscription tokens are stored under
  `provider-homes/<provider>/.claude/credentials.json` and similar paths.
  These follow each CLI vendor's specification.

## Logs / screenshots

- Form-submit screenshots contain **the body the user typed and the target
  company's info**.
- AI session logs contain the **prompt sent and the full AI response**.
- All of these are stored locally — none are sent externally.
- If you redistribute or share them, exclude or mask them first.

## Legal responsibility

Sales Claw is a **tool that assists with automating sales outreach**. The
**actual sending and contact use are entirely the user's responsibility**.

### When used in Japan (must comply)

#### 1. Specified Commercial Email Act (特定電子メール法)

If you send email, the body must contain these four elements:

1. The sender's name or business name.
2. The sender's contact (URL / email address).
3. A notice that the recipient can opt out, plus where to send the opt-out.
4. Optional: postal address / phone number.

> Sales Claw's `src/compliance.ts` automatically detects + auto-completes
> these four elements (`preferences.complianceFooter: true` by default).

#### 2. Act on the Protection of Personal Information (個人情報保護法)

- Publicly available **corporate information** (company name,
  representative name, representative URL, official contact form) is
  generally not personal information, but the individual contact person's
  name and personal email can be.
- It is recommended to record the source (where the target list came from)
  in `preferences.listSourceMetadata`.

#### 3. Other

- **Comply with the target site's terms of use**: Sales Claw checks
  robots.txt and detects CAPTCHA, but ultimate compliance is on the user.
- **No spamming / bulk blasting**: follow the law and general etiquette;
  use Sales Claw at a sensible cadence.
- **Do not submit to "no solicitation", "hiring only", etc.** contact
  windows. (Sales Claw detects these automatically and marks them
  `skipped`.)

## When used in the EU / UK (GDPR / UK GDPR)

If you are contacting an individual in the EU / UK or an EU / UK company,
GDPR applies:

- Even in B2B contact, an individual name is personal data.
- When relying on Legitimate Interest, observe the data-minimization
  principle.
- Where the target company exposes a DPA (Data Protection Officer) contact
  form, prefer that.

## When used in the United States (CAN-SPAM Act)

- The subject line and sender display must not be misleading.
- A physical postal address must be included.
- An opt-out must be offered.
- Opt-out requests must be honored within 10 business days.

## DISCLAIMER

Sales Claw is provided **"AS IS"** (see [LICENSE](./LICENSE)).

- The project operators are not liable for any damages (legal liability,
  financial loss, reputational harm, etc.) arising from the use of this
  tool.
- Uses that violate the law are forbidden.
- Uses that are ethically / socially harmful (spam, harassment,
  impersonation, etc.) are forbidden.

## Contact

- Security issues: [SECURITY.md](./SECURITY.md)
- Privacy inquiries: [GitHub Private Security Advisory](https://github.com/joseikininsight-hue/sales-claw-ts/security/advisories/new) (prefix the title with `[Privacy]`)

## Revision history

| Date | Notes |
|---|---|
| 2026-05-14 | Initial version (created at the 2.0.0 release). |

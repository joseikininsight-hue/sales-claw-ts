# Support

> Japanese version: [docs/ja/SUPPORT.md](./docs/ja/SUPPORT.md)

This document lays out Sales Claw's support channels and how to reach us.

## Where to ask

| Type of question | Where it goes |
|---|---|
| **Bug report** | [GitHub Issues](https://github.com/joseikininsight-hue/sales-claw-ts/issues/new?template=bug_report.md) (use the bug_report template) |
| **Feature request** | [GitHub Issues](https://github.com/joseikininsight-hue/sales-claw-ts/issues/new?template=feature_request.md) (use the feature_request template) |
| **Usage questions** | [GitHub Discussions](https://github.com/joseikininsight-hue/sales-claw-ts/discussions) (once enabled) |
| **Security vulnerability** | **Do not open a public issue** — follow [SECURITY.md](./SECURITY.md) |
| **Code-of-Conduct violation** | [GitHub Private Security Advisory](https://github.com/joseikininsight-hue/sales-claw-ts/security/advisories/new) (prefix the title with `[CoC]`) |

## Supported versions

| Version | Support | Notes |
|---|---|---|
| 2.0.x | ✅ Active | Recommended. Latest features and auto-update. |
| 1.2.x | 🟡 Security only | Security fixes only. |
| < 1.2 | ❌ End-of-life | Please upgrade to 2.x. |

## Pre-flight checklist

To save everyone's time, please check these first:

1. **[README.md](./README.md)** covers setup and basic usage.
2. **[CHANGELOG.md](./CHANGELOG.md)** lists known fixes and changes.
3. **[Existing issues](https://github.com/joseikininsight-hue/sales-claw-ts/issues?q=is%3Aissue)** — search whether the same issue is already reported.
4. **`%APPDATA%\sales-claw\runtime\data\dashboard-diagnostics.jsonl`** contains the app's diagnostic log (recommended to attach to bug reports).

## Response-time expectations

| Category | Initial response |
|---|---|
| Critical security vulnerability | Within 3 business days |
| Bug report | Within 7 business days |
| Feature request | Within 14 business days (acknowledgement that we've started reviewing) |
| General question | Best effort |

> ⚠️ Sales Claw is an OSS project. We do not provide commercial support or a
> contractual SLA. The numbers above are best-effort guidelines, not
> guarantees. If we don't reply, please bump the thread.

## Contributing

If you'd like to contribute beyond just using the project — code or
translations — please see [CONTRIBUTING.md](./CONTRIBUTING.md).

## FAQ

### Q: Windows shows a SmartScreen warning.
A: Windows code signing is not in place yet (details in
[ROADMAP.md](./ROADMAP.md) under Known Limitations). You can run the app via
"More info" → "Run anyway".

### Q: Auto-update isn't reaching me.
A: The app polls GitHub Releases' `latest.yml` 5 seconds after launch and
every 6 hours thereafter. Make sure your firewall isn't blocking
`api.github.com`.

### Q: Where do I install the AI CLI (Claude / Codex / Gemini)?
A: Separately from Sales Claw — for example
`npm install -g @anthropic-ai/claude-code`. See [README.md](./README.md) for
details.

### Q: Are there license / usage fees?
A: Sales Claw itself is free under the MIT license. You will still need
your own AI CLI subscription (e.g. Claude Pro) or API-key usage fees,
depending on what you wire up.

### Q: Can I contact people in the EU under GDPR?
A: That's your responsibility as the user. See the GDPR section in
[PRIVACY.md](./PRIVACY.md).

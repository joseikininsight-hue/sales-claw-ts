# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 2.0.x   | :white_check_mark: |
| 1.2.x   | :white_check_mark: (security fixes only) |
| < 1.2   | :x:                |

## Reporting a Vulnerability

**Please do NOT open public GitHub Issues for security vulnerabilities.**

If you discover a security vulnerability in Sales Claw, please report it by:

1. **Email (preferred)**: [abckeishi@gmail.com](mailto:abckeishi@gmail.com)
   - Subject: `[SECURITY] Sales Claw - <brief description>`
2. **GitHub Security Advisory** (private): Use the
   [Security Advisory](https://github.com/joseikininsight-hue/sales-claw-ts/security/advisories/new)
   form to submit privately.

Include in your report:
- A clear description of the vulnerability
- Steps to reproduce
- Potential impact (e.g., RCE, credential leak, DoS)
- Suggested mitigation if you have one
- Whether you'd like to be credited in the advisory

## Response Timeline

- **Acknowledgement**: within 3 business days
- **Initial assessment**: within 7 business days
- **Fix release**: target within 30 days for high-severity issues
- **Public disclosure**: coordinated after a fix is released

## Scope

In scope:
- The Electron desktop app itself (`Sales Claw.exe` / `.dmg` / `.AppImage`)
- The local dashboard server (`http://127.0.0.1:3765` / configured port)
- Form-fill automation via MCP Playwright
- AI runtime spawn handling (`claude -p` / `codex` / `gemini`)
- Settings / credential file storage (`%APPDATA%/sales-claw/` etc.)
- Auto-updater (`electron-updater` integration with GitHub Releases)
- Dependency vulnerabilities that affect Sales Claw's runtime

Out of scope:
- Vulnerabilities in upstream tools (`claude` CLI, `codex` CLI, etc.) — report to those projects
- Issues that require physical access to the user's machine
- Brute-force / DoS against the local-only dashboard port (it doesn't bind to 0.0.0.0 by default)
- Social engineering attacks

## Hardening Defaults

Sales Claw includes the following security defaults out of the box:

1. **Local-only dashboard binding** (`127.0.0.1`) — not exposed to LAN/internet
2. **Dashboard session token** (`x-sales-claw-session` header) — random-generated per launch
3. **Spawn env sanitization** — removes `ANTHROPIC_API_KEY` / `AWS_*` / `OPENAI_API_KEY` etc.
   from child processes by default (see `src/spawn-env-sanitizer.ts`)
4. **Provider-home isolation** — Claude / Codex / Gemini credentials stored in
   separate `provider-homes/<id>/` directories, not the user's `~/.claude`
5. **SSRF protection** — `parallel-analysis.ts::isSafeUrl` blocks private IPs,
   10進数/16進数 IPs, and `localhost` URLs
6. **Path traversal protection** — file paths are resolved and validated
7. **electron-builder publish locked** — release artifacts come from the official
   GitHub Releases owned by `joseikininsight-hue`, with `PLACEHOLDER_UPDATE_OWNERS`
   blocking local-test/placeholder feeds

## Security Tests

Automated tests in `tests/` cover several attack surfaces:
- `tests/redact.test.cjs` — secret redaction in logs (64 cases)
- `tests/spawn-env-sanitizer.test.cjs` — env sanitization (17 cases)
- `tests/awaiting-approval-guard.test.cjs` — API input validation
- `tests/security-quickwins.test.cjs` — common XSS/javascript-URL patterns

Run them with `npm run test:unit`.

## Credits

Thank you to the security researchers who help keep Sales Claw safe.
We will credit responsible disclosures in the release notes unless you
prefer to remain anonymous.

# OSS Readiness Review

Date: 2026-04-01

## Executive Summary

This review was performed by splitting the investigation into three lenses:

1. Exposure and repository hygiene
2. Setup, packaging, and reproducibility
3. Operational safety, auditability, and user experience

Verdict: **do not broadly open-source the project in its current state**.

The codebase is close to being publishable as a technical preview for advanced users, but it is not yet in a condition where third parties can safely clone, run, and trust it without significant friction or risk. The main blockers are:

- local machine-specific files and generated artifacts are still mixed into the repository and packaging surface
- the localhost control plane has no authentication or origin protection
- the packaged app writes runtime state into the install tree
- the documented setup path is incomplete for the actual Claude Code CLI + MCP Playwright architecture
- some UI settings appear configurable but are not consistently enforced in runtime behavior

## Overall Assessment

### What is already in good shape

- MIT license is present in [LICENSE](../LICENSE)
- sample configuration and sample target data exist in [data/sample-settings.json](../data/sample-settings.json) and [data/sample-targets.csv](../data/sample-targets.csv)
- runtime host is forced to loopback in [src/settings-manager.cjs](../src/settings-manager.cjs)
- release automation exists in [.github/workflows/release.yml](../.github/workflows/release.yml)
- the project now enforces CLI-led execution instead of the older direct-JS submission path
- screenshot and approval artifacts are conceptually built into the workflow

### Release Recommendation

- `Public OSS release`: **Not recommended yet**
- `Private/internal use by the current team`: **Acceptable with current operator knowledge**
- `Limited technical preview for advanced users`: **Possible only after the critical items below are fixed**

## Critical Blockers

### 1. Localhost control plane can be driven without authentication

The dashboard exposes powerful local endpoints and a PTY WebSocket, but there is no session auth, CSRF protection, or origin verification. That means another local or browser context could potentially trigger Claude install, launch, stop, or terminal attachment behavior through localhost routes.

Relevant files:

- [src/dashboard-server.cjs](../src/dashboard-server.cjs) lines 47, 57, 1043, 5158, 5225, 5272, 5315, 5517

Why this blocks OSS:

- an internal-only tool can rely on trust assumptions
- a public OSS desktop app should not expose unauthenticated automation controls by default

Required fix before release:

- add session authentication
- enforce `Origin` and CSRF checks on state-changing routes
- default-disable PTY and install APIs unless explicitly enabled

### 2. Packaged app writes runtime data into the install directory

The app bootstraps and persists settings under the project/install tree, and other runtime paths default under `PROJECT_ROOT`. This is fragile for packaged desktop installs under `Program Files`, `.app`, and AppImage-style environments.

Relevant files:

- [electron-main.js](../electron-main.js) line 147
- [src/settings-manager.cjs](../src/settings-manager.cjs) lines 10, 196, 204, 205, 206, 322
- [src/data-paths.cjs](../src/data-paths.cjs) line 14

Why this blocks OSS:

- public users expect an installed app to store mutable state under user-writable app data directories
- current behavior will be environment-dependent and may fail silently or unpredictably

Required fix before release:

- move all mutable runtime state to per-user application data
- stop mirroring saved settings back into repo-local `data/settings.json` after `dataDir` is changed

### 3. Machine-local Claude configuration is tracked and surfaced

The repository currently includes `.claude/settings.local.json`, even though the repo itself describes it as user-local and potentially credential-bearing. The application also reads and writes to it.

Relevant files:

- [.claude/settings.local.json](../.claude/settings.local.json)
- [.gitignore](../.gitignore) lines 72-73
- [src/dashboard-server.cjs](../src/dashboard-server.cjs) line 4824
- [README.md](../README.md) line 244

Why this blocks OSS:

- it risks exposing machine-specific permissions, local tool wiring, and runtime assumptions
- it creates confusion over which settings are repo-owned and which are user-owned

Required fix before release:

- remove `.claude/settings.local.json` from tracked release surface
- replace it with a sanitized example if needed
- move user-local runtime settings to a true per-user location

### 4. Setup documentation is incomplete for the actual architecture

The public setup path does not explain the full Claude Code CLI + MCP Playwright dependency chain. README mentions Playwright browser install, but not the MCP server registration that the actual prompting model relies on.

Relevant files:

- [README.md](../README.md) lines 23, 78, 97, 103, 128, 129, 203
- [src/dashboard-server.cjs](../src/dashboard-server.cjs) lines 649, 744
- [.claude/settings.local.json](../.claude/settings.local.json) line 10
- [CONTRIBUTING.md](../CONTRIBUTING.md) lines 17, 21

Why this blocks OSS:

- third parties following the docs will not reproduce the intended behavior
- support burden will be high from day one

Required fix before release:

- publish a canonical install guide for Claude Code CLI, MCP Playwright registration, and Electron-specific requirements
- fix Windows-hostile `cp` instructions and stale contributor commands

## High-Risk Issues

### 5. Approval audit currently accepts input screenshot as confirm fallback

The artifact checker allows `input` to substitute for `confirm`, which weakens the rule that approval should be based on a real confirmation-state artifact.

Relevant files:

- [src/approval-artifacts.cjs](../src/approval-artifacts.cjs) lines 23, 25, 30, 34, 64, 65
- [src/dashboard-server.cjs](../src/dashboard-server.cjs) line 5025

Why it matters:

- the dashboard can mark a company as ready for approval without a true confirm screenshot
- that undermines the project’s core audit guarantee

Recommended fix:

- require a distinct confirm artifact again, or explicitly block approval for input-only states

### 6. Sensitive prompt material is written to repository-adjacent paths

Claude prompt files include sender information and company notes, but `data/claude-prompts/**` is not clearly excluded from git or packaging.

Relevant files:

- [src/dashboard-server.cjs](../src/dashboard-server.cjs) lines 617, 626, 630, 715, 731
- [.gitignore](../.gitignore) lines 4, 19
- [electron-builder.yml](../electron-builder.yml) lines 19, 30

Why it matters:

- local or manual packaging workflows may leak operational prompt data
- advanced users may assume `dataDir` fully externalizes private runtime material when it does not

Recommended fix:

- write prompt files into a temp or per-user runtime directory
- ignore and exclude prompt-output folders from git and packaged artifacts

### 7. Cross-platform claim does not match current implementation

The project claims Windows, macOS, and Linux packaging, but at least one settings feature is implemented as Windows-only.

Relevant files:

- [README.md](../README.md)
- [electron-builder.yml](../electron-builder.yml)
- [src/dashboard-server.cjs](../src/dashboard-server.cjs) line 482

Why it matters:

- OSS users will treat platform claims literally
- unexpected Windows-only behavior damages trust quickly

Recommended fix:

- either scope the first OSS release to Windows only
- or finish cross-platform implementations before claiming broad support

### 8. Public branding and runtime assumptions are internally inconsistent

The repo mixes Codex-oriented project docs with Claude-oriented runtime UI, API names, and setup paths. The result is unclear: is the product “Codex-driven”, “Claude-driven”, or a hybrid?

Relevant files:

- [AGENTS.md](../AGENTS.md) line 6
- [README.md](../README.md) line 23
- [electron-main.js](../electron-main.js) line 159
- [src/dashboard-server.cjs](../src/dashboard-server.cjs) line 649
- [src/i18n.cjs](../src/i18n.cjs) line 830

Why it matters:

- contributors and users need one canonical mental model
- OSS projects suffer quickly when docs, UI, and architecture language diverge

Recommended fix:

- declare one canonical runtime stack in the README and product copy
- isolate compatibility layers instead of blending them into the primary narrative

## Medium-Risk Issues

### 9. Settings imply flexibility that the runtime does not always honor

Some settings are surfaced in the dashboard but are not consistently enforced across all runtime modules.

Examples:

- `emailProvider` offers `Outlook`, `Gmail`, and `Other`, but only Outlook is implemented
- `company-analyzer.cjs` uses `headless`, `userAgent`, `locale`, and `pageTimeout`, while `form-finder.cjs` and `form-validator.cjs` hardcode browser settings
- `requireApprovalBeforeSend` is visible in UI but the flow behaves as approval-required regardless

Relevant files:

- [src/dashboard-server.cjs](../src/dashboard-server.cjs) lines 2307-2311, 2346, 4673, 5044
- [src/settings-manager.cjs](../src/settings-manager.cjs) lines 144, 375
- [src/email-fetcher.cjs](../src/email-fetcher.cjs) lines 29, 33
- [src/company-analyzer.cjs](../src/company-analyzer.cjs) lines 16-26
- [src/form-finder.cjs](../src/form-finder.cjs) lines 8-11
- [src/form-validator.cjs](../src/form-validator.cjs) lines 13-16

Recommended fix:

- remove unsupported settings from OSS UI
- or make all surfaced settings authoritative across the stack

### 10. Runtime artifacts and generated files are not fully sanitized for publication

There are still generated or environment-specific items that do not belong in a clean public repository or release surface.

Examples:

- `launch-silent.vbs` contains a hardcoded absolute path
- README and release config still hardcode the current GitHub owner
- sample settings retain strong internal sales-ops flavor

Relevant files:

- [launch-silent.vbs](../launch-silent.vbs) line 4
- [setup.bat](../setup.bat) line 52
- [README.md](../README.md) lines 10, 85
- [electron-builder.yml](../electron-builder.yml) line 8
- [data/sample-settings.json](../data/sample-settings.json) lines 26, 58, 100, 106, 140

Recommended fix:

- regenerate or delete user-specific artifacts
- neutralize sample data
- parameterize repository owner and release metadata

### 11. Development readiness for outside contributors is still weak

There is no visible test or lint command in `package.json`, and the release workflow builds artifacts without validating core behavior. The main dashboard server is also a large monolith, which raises contribution risk.

Relevant files:

- [package.json](../package.json) lines 7, 8, 29
- [.github/workflows/release.yml](../.github/workflows/release.yml) lines 44, 124
- [src/dashboard-server.cjs](../src/dashboard-server.cjs)

Recommended fix:

- add at least one automated smoke test path and one lint/static validation path
- gate release builds on those checks
- gradually split the dashboard server into smaller modules

### 12. Data retention defaults are heavy for public distribution

The application stores contact history, message bodies, and audit detail for long periods and can export them directly. That is operationally useful, but it is a privacy-sensitive default for public OSS.

Relevant files:

- [src/contact-history.cjs](../src/contact-history.cjs) lines 48, 51, 123
- [src/dashboard-server.cjs](../src/dashboard-server.cjs) lines 5418, 5433

Recommended fix:

- add retention windows
- add redacted exports
- add masking guidance in docs

## Publishability Decision

### If you publish today

Expected outcome:

- technically skilled users may be able to run it after trial and error
- many outside users will fail during setup
- some users will assume settings are authoritative when they are not
- there is unnecessary risk of leaking local runtime material
- security reviewers will likely flag the localhost control surface

### Minimum bar for a first public OSS release

1. Remove machine-local and generated artifacts from tracked/package surfaces.
2. Move runtime state to per-user application data.
3. Add authentication and origin protection to local control endpoints.
4. Publish a canonical setup guide for Claude Code CLI and MCP Playwright.
5. Make approval evidence strict again.
6. Trim or fully implement settings that appear in the UI.
7. Decide the support scope: Windows-only first, or truly cross-platform.

## Recommended Release Strategy

### Phase 1: Pre-public hardening

- fix the critical blockers
- sanitize samples and packaging
- align docs, UI, and runtime vocabulary around one canonical architecture

### Phase 2: Technical preview release

- disclose supported OS and dependency assumptions explicitly
- mark advanced setup requirements prominently
- keep auto-update conservative until repo owner/release channels are final

### Phase 3: Broad OSS release

- add automated smoke coverage
- add contributor-ready development docs
- add privacy and acceptable-use guidance for automated outreach

## Final Verdict

This project is **not yet ready for broad OSS publication**.

It is promising and already has a real operator workflow, but it still behaves like an internal, expert-operated system rather than a public, safe-by-default open-source product. If the team fixes the critical blockers first, the project can reasonably move into a limited technical preview. After that, a broader OSS release becomes realistic.

# Contributing to Sales Claw

Thanks for your interest in contributing to Sales Claw. Bug reports, feature
requests, PRs, docs improvements, and translations are all welcome.

> Japanese version: [docs/ja/CONTRIBUTING.md](docs/ja/CONTRIBUTING.md)

## Code of Conduct

This project adopts a [Code of Conduct](./CODE_OF_CONDUCT.md). Please read
it before opening a PR or issue.

## Security

For security issues, **do not open a public GitHub issue**. Follow the
process in [SECURITY.md](./SECURITY.md) instead (GitHub Private Security
Advisory).

---

## Quick Start (development setup)

### Prerequisites

- Node.js 22+ ([nodejs.org](https://nodejs.org/))
- Git
- At least one AI CLI (`claude` / `codex` / `gemini`) — used in tests

### Setup

```bash
git clone https://github.com/joseikininsight-hue/sales-claw-ts.git
cd sales-claw-ts
npm install
# First time only — copy sample settings
npm run setup
# Install the Playwright browser binary
npx playwright install chromium
# Build (TypeScript → dist-ts)
npm run build
# Launch
npm start
```

`npm start` launches the Electron desktop app.

If you want to inspect the dashboard standalone:

```bash
npm run dashboard:preview  # http://127.0.0.1:3480
```

### Development loop

```bash
# Watch build (run in a second terminal)
npm run build:watch

# Type check
npm run typecheck

# Lint (project currently has ~1100 warnings; 0 errors is required)
npm run lint

# Unit tests
npm run test:unit

# Pre-release verification
npm run verify:release
```

---

## Branch strategy

This project uses a **`main`-only** workflow by convention; feature branches
are not required for small changes.

For external contributors via fork: open the PR from a topic branch on your
fork against `main`. We squash-merge.

---

## Before opening a PR

1. **`npm run typecheck`** — 0 errors
2. **`npm run lint`** — 0 errors (warnings tolerated, but document large
   increases in the PR body)
3. **`npm run test:unit`** — all pass
4. **`npm run verify:release`** — passes (for any release-affecting change)
5. **`CHANGELOG.md`** — add a 1-2 line entry under Unreleased
6. **Update relevant `docs/`** — when applicable
7. **For new features**: add tests
8. **For bug fixes**: add a regression test that fails before your fix and
   passes after

## Commit messages

Follow [Conventional Commits](https://www.conventionalcommits.org/).

Examples:
- `feat: add category mode to List Builder`
- `fix: delete stale dashboard-server lock on startup`
- `refactor: tighten dashboard-runtime.ts types`
- `docs: add 2.0.0 release notes to README`
- `test: expand spawn-env-sanitizer coverage`
- `chore: deps - bump eslint to 10.4`
- `ci: add macos-13 to release.yml matrix`
- `perf: cache parallel-analysis HTTP responses`

For breaking changes, use `feat!:` / `fix!:` or include
`BREAKING CHANGE: <description>` in the commit body.

---

## Coding standards

### TypeScript

- New files in `src/` must be **TypeScript** (`.cjs` additions are
  discouraged).
- Avoid `any` in new code (the existing 949 occurrences are being migrated
  in stages).
- Prefer `unknown` + a type guard. Use the helpers in
  `src/types/helpers.ts`:
  - `parseJsonAs<T>` / `Result<T, E>` / `isPlainObject` / `getString`, etc.
- Strict null handling (`strictNullChecks: true`).
- Explicit type annotations on exported function signatures are recommended.

### File layout

- Aim for 200-400 lines per file, max ~800.
- One responsibility per file.
- Put shared types in `src/types/` and avoid cyclic imports.

### Comments

- Document **why**, not what.
- Mark hacks / workarounds with an explanation.
- TODOs should reference an issue: `TODO(issue #123)`.

---

## Project structure

```
src/
├── *.ts                     Core logic (47 files, 100% TS)
├── ai-runtime/             Claude / Codex / Gemini process management
├── list-builder/           Company-list discovery (URL / NLQ / category modes)
├── routes/                 Dashboard API handlers
├── types/                  Shared types + type helpers (helpers.ts)
└── ui/client-scripts/      Browser-side scripts (TS / esbuild bundle)

dist-ts/                    tsc + esbuild build output (gitignored)
docs/                       Design and operations docs
scripts/                    Build / verification scripts
tests/                      Direct-Node unit tests (.test.cjs)
.github/workflows/          CI (ci.yml) + Release (release.yml)
```

Design references:
- [docs/typescript-migration-roadmap.md](./docs/typescript-migration-roadmap.md) — staged TS migration plan
- [docs/dashboard-port-lifecycle.md](./docs/dashboard-port-lifecycle.md) — port / runtime.json / lock semantics
- [docs/programmatic-credit-migration.md](./docs/programmatic-credit-migration.md) — Anthropic 2026-06-15 policy migration
- [docs/release-parity-and-autoupdate.md](./docs/release-parity-and-autoupdate.md) — release / auto-update
- [docs/list-builder-requirements.md](./docs/list-builder-requirements.md) — List Builder spec

---

## Adding a new UI locale

The dashboard ships a Phase 2 Locale Pack system under `src/locale-pack/`.
To add a new locale (for example, French):

1. Add `src/locale-pack/fr.ts` cloned from the closest existing locale.
2. Register the pack in `src/locale-pack/index.ts`.
3. Run `npm run build` and verify the new locale appears in the dashboard's
   Settings → Language selector.
4. Update any locale-aware tests under `tests/locale-pack.test.cjs`.

---

## Testing

Unit tests live in `tests/*.test.cjs` and run directly under Node.

```bash
node tests/spawn-env-sanitizer.test.cjs
node tests/analysis-cache.test.cjs
# Or run the lot
npm run test:unit
```

When adding a new test, also register it in `package.json::scripts.test:unit`.

E2E tests use Playwright:

```bash
npm test  # test:unit + playwright test
```

### Testing principles

- **Always cover boundary conditions**: empty string / null / undefined / 0 /
  negative / very large.
- **Cover failure paths**: not just "success" but "fails correctly on
  failure".
- **Minimize side effects**: file I/O goes to tmpdir.
- **Be deterministic**: stub timers and randomness.

---

## Pull request workflow

1. Fork the repository.
2. Create a topic branch on your fork.
3. Run all checks listed in "Before opening a PR".
4. Open a PR against `main`.
5. The CI will run `ci.yml` (build + typecheck + lint + unit tests +
   Playwright E2E on every push).
6. Maintainers will review and squash-merge.

---

## Release process

Releases are automated:

1. Bump `package.json::version` (semver; e.g. `2.0.0` → `2.0.1`).
2. Move the Unreleased section of `CHANGELOG.md` under the new version
   heading.
3. Push to `main`.
4. `.github/workflows/release.yml` automatically:
   - Creates the `v{version}` tag
   - Builds Windows / macOS / Linux
   - Publishes to GitHub Releases
5. Within a few hours, installed apps will auto-update.

Details: [docs/release-parity-and-autoupdate.md](./docs/release-parity-and-autoupdate.md)

---

## Reviewer checklist

When reviewing a PR, look for:

- **Programmatic Credit** changes (`claude -p` / `spawn` env) must go
  through `spawn-env-sanitizer`.
- **`dashboard-server`** startup-sequence changes must preserve
  `clearStaleRuntimes` / `claimStandaloneDashboardLock` consistency.
- **Browser inline scripts** must live in `src/ui/client-scripts/` so that
  esbuild picks them up.
- **New secrets / API keys** must only come from
  `data/settings.json::apiKeys`, never appear in logs
  (covered by `redact.ts` tests).
- **Lint-warning increases**: justify them in the PR description.

---

## License

By submitting a PR, you agree that your contribution will be licensed under
the MIT License (the project's existing license).

Thank you for contributing.

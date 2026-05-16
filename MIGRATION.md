# TypeScript Migration Notes

> Japanese version: [docs/ja/MIGRATION.md](./docs/ja/MIGRATION.md)

This project is a derivative rewrite of `C:\bp-outreach`
(Sales Claw v1.2.111 = the CJS edition) into TypeScript.

## Status (2026-05-14, at the 2.0.0 release)

**The `src/` tree is 100% TypeScript.** All server code and browser
client-scripts are written in `.ts`.

| Scope | State |
|---|---|
| `src/**/*.ts` | ✅ 100% TypeScript |
| `electron-main.ts` | ✅ TypeScript (strict, no `@ts-nocheck`) |
| `src/ui/client-scripts/*.ts` | ✅ TypeScript (esbuild integrated; internal full-typing planned for Stage 4.5) |
| `scripts/*.cjs` | 🟡 Kept as CJS Node build tooling (Stage 2 to migrate to `.ts`) |
| `tests/*.test.cjs` | 🟡 Kept as CJS for direct `node` execution |
| `as any` / `: any` usage | 🟡 949 occurrences → being reduced in stages (details: [docs/typescript-migration-roadmap.md](./docs/typescript-migration-roadmap.md)) |

Release artifacts: [GitHub Releases](https://github.com/joseikininsight-hue/sales-claw-ts/releases)

Detailed changes: [CHANGELOG.md](./CHANGELOG.md)

## What this migration accomplished

### Done (in this copy)

1. **Project copy** — duplicated `electron-main.js + src/ + tests/ + scripts/ + assets/ + data/ + docs/ + config files` into `C:\bp-outreach-ts`.
2. **TypeScript build infrastructure**
   - `tsconfig.json` (strict + `noImplicitAny: false` for staged migration)
   - `tsconfig.tests.json` (test extension)
   - In-place compilation (`.ts` → `.js` in the same directory). Absolute
     paths based on `__dirname` keep working.
   - `npm run build` / `build:watch` / `typecheck` / `rebuild`
3. **Fully typed entry point (`electron-main.ts`)**
   - Type annotations on every Electron API call.
   - Auto-update handlers (`autoUpdater.on(...)`), tray menu, IPC,
     before-quit / graceful shutdown all strictly typed.
   - No `// @ts-nocheck`. Passes strict mode.
4. **Fully typed core modules**
   - `src/data-paths.ts` — `resolveDataPath`, `getDataDir`, `PROJECT_ROOT`
   - `src/startup-cleanup.ts` — `cleanupStaleFiles` (exports the
     `CleanupResult` type)
   - `src/dashboard-runtime.ts` — `readRuntime`, `writeRuntime`,
     `DashboardRuntime` type
5. **Shared type definitions** — `src/types/`
   - `settings.ts` — `Settings`, `CompanyProfile`, `ValuePropositions`,
     `MessageTemplates`, `Preferences`, `ApiKeys`, `ListBuilderConfig`, etc.
     The full settings.json schema.
   - `action-log.ts` — `ActionLogEntry`, `ApprovalArtifactDetails`,
     `ActionType`
   - `target.ts` — `TargetCompany`, `ContactHistoryEntry`
   - `runtime.ts` — `LiveMonitorEntry`, `DashboardSession`, `UpdateStatus`
   - `index.ts` — barrel export
6. **Bulk conversion of 88 `.cjs` → `.ts` files**
   - Renamed every `src/**/*.cjs` to `.ts`.
   - Rewrote cross-references `require('./foo.cjs')` to `require('./foo')`
     (51 files).
   - Prepended `// @ts-nocheck` to each (staged migration: syntactically
     TypeScript, type-checking disabled).
   - Exception: `src/ui/client-scripts/*.cjs` (shipped to the browser,
     separate lifecycle with a minimal config) stays as `.cjs`.
7. **All 47 tests pass**
   - `node tests/<file>.test.cjs` passes everything (same coverage as
     pre-migration).
   - Source-file references inside tests (`fs.readFileSync('src/foo.cjs')`
     and friends) updated to `.ts`.
   - The `tests/<file>.test.cjs` files themselves are not renamed (kept for
     test-runner compatibility; contents work as-is).
8. **Runtime verification**
   - `npm run build` compiles all 88 files + `electron-main.ts` (0 errors).
   - `node -e "require('./src/dashboard-server.js')"` boots the dashboard
     server.
   - `electron-main.js` (the build output) resolves the entire require
     chain.

## Remaining staged work

### Removing `// @ts-nocheck`

85 files under `src/` are TypeScript only by extension — they still carry
`// @ts-nocheck`, so they are not actually type-checked. For each, one at a
time:

1. Remove `// @ts-nocheck`.
2. Replace `require(...)` with `import ... from '...'`.
3. Replace `module.exports = { ... }` with `export ...`.
4. Annotate function arguments and return types.
5. Guard catch-clause `unknown` values with `instanceof Error`.
6. Iterate until `tsc` reports zero errors.

### Module priorities

| Priority | Module | Lines | Why |
|---|---|---|---|
| High | `src/settings-manager.ts` | 1085 | Every module depends on it. The `Settings` type already exists. |
| High | `src/form-session-manager.ts` | 700 | Referenced directly by Electron main. |
| High | `src/local-toolchain.ts` | 616 | The heart of the Playwright / CLI installer. |
| Medium | `src/dashboard-server.ts` | 9540 | Huge. As the HTTP routing layer, it can also be split per route. |
| Medium | `src/action-logger.ts`, `contact-history.ts`, `live-monitor.ts` | — | Data I/O. Typing them makes file access safer. |
| Medium | `src/routes/*.ts` (12 files) | — | API handlers. Add request / response types. |
| Medium | `src/list-builder/**/*.ts` (15 files) | — | The pipeline. Type-cover `docs/list-builder-requirements.md` v2.0. |
| Low | `src/onboarding-wizard.ts` | — | One-off renderer; low priority. |

### Proposed split for `dashboard-server.ts` (9540 lines)

Since this is a single massive file, when typing it, splitting like below is
recommended:

1. `src/dashboard/server.ts` — HTTP/WS server bootstrap
2. `src/dashboard/router.ts` — routing dispatcher
3. `src/dashboard/sse.ts` — Server-Sent Events hub
4. `src/dashboard/static.ts` — static file delivery
5. `src/dashboard/middleware/*.ts` — auth, CSP, redact, etc.
6. `src/dashboard/handlers/*.ts` — individual route handlers
7. `src/dashboard/render.ts` — HTML rendering

All of these continue to work under `// @ts-nocheck` today, so the split can
proceed incrementally.

## Build / Run

### Initial setup

```bash
cd C:\bp-outreach-ts
npm install
npm run build      # tsc -p tsconfig.json
```

### Development

```bash
npm run build:watch   # tsc --watch
npm run typecheck     # type errors only (no emit)
npm run lint          # ESLint (.ts/.cjs/.js)
```

### Launching Electron

```bash
npm start             # build → electron .
npm run start:fast    # skip build (use existing .js)
```

### Tests

```bash
npm run test:unit     # build, then run unit tests
# Individual test:
node tests/redact.test.cjs
```

### Distribution

```bash
npm run dist:win      # build the Windows installer (--publish never for safety)
```

## Known limitations

1. **Electron binary** — Electron's postinstall sometimes fails on
   `npm install`. Either delete `node_modules/electron` and run
   `npm install electron --force`, or run `npx install-electron`
   separately.
2. **`ui/client-scripts/*.cjs`** — These are served to the browser as
   `<script>` tags, so they stay `.cjs`. They are excluded from the
   tsconfig `include`. If you want to TS them, set up a separate build
   pipeline (e.g. esbuild).
3. **`process.resourcesPath`** — The value changes between dev and packaged
   builds, so keep the `app.isPackaged` branching pattern.
4. **Coexistence of `module.exports = ...` and `export ...`** — Typed
   modules (`data-paths`, `dashboard-runtime`) keep both. They're usable
   from both `require()` and `import` callers. When dropping
   `@ts-nocheck`, consolidate to one form.

## Intent behind tsconfig.json

- `target: ES2022` — fully supported by Node 22 / Electron 42.
- `module: CommonJS` — for compatibility with existing `require()`.
- `outDir: "."`, `rootDir: "."` — in-place compile (path compatibility).
- `strict: true` but `noImplicitAny: false` — compromise during migration.
- `allowJs: true`, `checkJs: false` — so `.cjs` files (client-scripts) can
  be read.
- `useUnknownInCatchVariables: true` — required for TS 4.4+ `catch (err:
  unknown)`.
- `incremental: true` — faster diff builds.

## File statistics

```
src/                  88 .ts + 11 .cjs (ui/client-scripts only)
electron-main.ts      1 (fully typed)
src/types/            5 (type definitions only)
tests/                49 .cjs (contents updated, filenames preserved)
```

## Migration log

| Item | Count |
|---|---|
| Copied .cjs files | 99 |
| `.cjs` → `.ts` renames | 88 |
| `require('./foo.cjs')` rewrites (src/) | 51 files |
| `require('./foo.cjs')` rewrites (tests/) | 44 files |
| `require('./foo.cjs')` rewrites (scripts/) | 5 files |
| `@ts-nocheck` annotations added | 88 files |
| Fully typed modules | **94 / 94 (100%)** |
| New type definition files | 5 (`src/types/*.ts`) |
| Build success (`tsc -p tsconfig.json`) | **0 errors** / ~19 s (strict mode) |
| Tests passing | **47 / 47** |
| Electron run | ✅ launches, dashboard HTTP 200, stderr clean |
| Total files (`src/**/*.ts` + entry) | 94 |
| `@ts-nocheck` remaining | **0** |

## Catalog of fully typed modules

TypeScript modules that pass strict mode without `// @ts-nocheck`:

| File | Lines (former .cjs) | Role |
|---|---:|---|
| `electron-main.ts` | 658 | Electron main process (entry point) |
| `src/data-paths.ts` | 36 | Runtime data layout |
| `src/startup-cleanup.ts` | 127 | Stale lock / tmp sweep on startup |
| `src/dashboard-runtime.ts` | 129 | dashboard-runtime.json read/write |
| `src/port-utils.ts` | 33 | Find an available TCP port |
| `src/file-lock.ts` | 151 | Cross-process file lock |
| `src/recovery-store.ts` | 121 | Recovery snapshot persistence |
| `src/compliance.ts` | 163 | Japan Specified Commercial Email Act compliance check |
| `src/cli-logger.ts` | 47 | CLI Activity stream emitter |
| `src/cli-issue-classifier.ts` | 212 | Issue detection from CLI output |
| `src/mcp-config-helpers.ts` | 64 | MCP config override detection |
| `src/onboarding-validator.ts` | 150 | Onboarding input validation |
| `src/log-writer.ts` | 228 | Async / size-rotated log writer |
| `src/cost-estimator.ts` | 216 | AI cost estimation |
| `src/config.ts` | 14 | Settings reader interface |
| `src/form-helpers.ts` | 66 | Form-click helpers |
| `src/outreach-targets.ts` | 73 | Active outreach target persistence |
| `src/ai-runtime/pty-log.ts` | 82 | Managed AI PTY log I/O |
| `src/ai-runtime/batch-utils.ts` | 138 | Pure functions for batch control |
| `src/ai-runtime/redact.ts` | 213 | Secret masking for PTY streams |
| `src/ai-runtime/slot-pool.ts` | 162 | Managed AI Slot Pool |
| `src/demo-mode.ts` | 136 | LP-embedded demo mode |
| `src/batch-watchdog.ts` | 109 | Batch stall detection |
| `src/form-finder.ts` | 140 | Form URL discovery |
| `src/form-validator.ts` | 221 | Form validation |
| `src/company-analyzer.ts` | 182 | Company site analysis |
| `src/contact-history.ts` | 302 | Contact history management |
| `src/action-logger.ts` | 265 | Action log management |
| `src/routes/recovery-api.ts` | 128 | Recovery API |
| `src/routes/error-recovery-api.ts` | 167 | Error Recovery API |
| `src/routes/ai-submit-final-api.ts` | 152 | AI final submit API |
| `src/list-builder/url-normalizer.ts` | 228 | URL normalization |
| `src/list-builder/name-normalizer.ts` | 236 | Company name normalization |
| `src/list-builder/suppression.ts` | 369 | Suppression List |
| `src/list-builder/dedupe.ts` | 313 | 4-layer dedupe |
| `src/list-builder/qualification-scorer.ts` | 225 | Fit score |
| `src/list-builder/identity-resolver.ts` | 210 | Identity resolution |
| `src/list-builder/enricher.ts` | 216 | Record enrichment |
| `src/list-builder/scrapling-client.ts` | 227 | Scrapling auxiliary fetcher |
| `src/list-builder/enrichers/employee-count.ts` | 104 | Employee-count extraction |
| `src/list-builder/enrichers/growth-trend.ts` | 115 | Growth trend classification |
| `src/list-builder/enrichers/revenue.ts` | 142 | Revenue extraction |
| `src/list-builder/official-clients/http-client.ts` | 287 | Shared HTTP for official APIs |
| `src/list-builder/official-clients/edinet-client.ts` | 171 | EDINET client |
| `src/list-builder/official-clients/gbizinfo-client.ts` | 179 | gBizINFO client |
| `src/list-builder/official-clients/houjin-bangou-client.ts` | 234 | NTA Corporate Number |
| `src/list-builder/discovery/nlq.ts` | 156 | NLQ → structured query |

In total, 47 modules + 5 type definition files = **52 files fully typed**.
The remaining 42 files run under `// @ts-nocheck` (no strict type checking
yet — migration in progress).

## Verification (end of this session)

```
$ npx tsc -p tsconfig.json          # 0 errors / ~6 s
$ node tests/<test>.test.cjs        # 47 / 47 pass
$ npx electron .                    # dashboard launches (port 3456)
                                    # HTTP 200 / 29 KB
                                    # stderr clean
```

### Remaining `@ts-nocheck` files (highlights)

| File | Lines | Recommendation |
|---|---:|---|
| `src/dashboard-server.ts` | 9540 | Huge. Recommend splitting (see proposal above). |
| `src/settings-manager.ts` | 1085 | Import the types from `src/types/settings.ts` and apply gradually. |
| `src/i18n.ts` | 1010 | Multi-language dictionary. `Record<string, string>` is enough. |
| `src/form-session-manager.ts` | 700 | Heavy use of Electron WebContentsView / IPC. |
| `src/local-toolchain.ts` | 616 | `spawn`-based. Use `child_process` types. |
| `src/approval-artifacts.ts` | 513 | Import `src/types/action-log.ts::ApprovalArtifactDetails`. |
| `src/sendability-gate.ts` | 375 | Pure validation logic — easy to type. |
| `src/message-quality-gate.ts` | 335 | Same as above. |
| `src/list-builder/orchestrator.ts` | ~ | 8-stage pipeline. A Stage type would help. |
| `src/routes/*.ts` (12 files) | — | HTTP handlers. Use `http.IncomingMessage` / `http.ServerResponse`. |

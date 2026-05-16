# Sales Claw Roadmap

> Japanese version: [docs/ja/ROADMAP.md](./docs/ja/ROADMAP.md)

This document spells out Sales Claw's upcoming development plans and known
limitations. Surfacing undocumented behavior and future work gives users and
contributors visibility into where the project is going.

## Known Limitations

| Item | Impact | Status |
|---|---|---|
| No Windows code signing | SmartScreen warning on first launch | Code signing certificates cost $200-500/year and require a registered entity, so we don't have one yet. Workaround: "More info" → "Run anyway". |
| `data/settings.json::apiKeys` is stored in plaintext | API key leakage risk on a shared machine | Phase 8 plans encryption via the OS keystore. |
| Auto-update only via GitHub Releases | Does not work in environments where the corporate firewall blocks GitHub | Private hosting is not currently planned. |
| 748 `as any` remaining | Partial type safety | Being reduced in Stage 2 (`docs/typescript-migration-roadmap.md`). |
| Programmatic Credit switch is effective on 2026-06-15 or later | Until then, API-key usage is metered | The spawn-env sanitizer is already in place; we're waiting for the policy to take effect. |

## Stage 2-4.5 progress (TypeScript Migration)

| Stage | Progress | Details |
|---|---|---|
| Stage 1: Foundation | ✅ Done (2.0.0-rc.1) | `src/types/helpers.ts` / lint warns on `no-explicit-any` |
| Stage 2: Reduce `any` | 🔄 In progress (83 removed / ~865 remaining) | Working from the top 15 files. Migrating to `unknown` + type guards. |
| Stage 3: Strict tsconfig | 🔄 Partial (3 options enabled) | `useUnknownInCatchVariables` deferred because of 164 errors. |
| Stage 4: Split `dashboard-server.ts` | 🔄 Started (1 module extracted) | 9540 lines → target of 6 files at 200-400 lines. |
| Stage 4.5: TS-ify the browser code | 🔄 Foundation only | `tsconfig.browser.json` + `src/ui/client-scripts/browser/` ready. Template-literal decomposition is future work. |

Overall roadmap: [docs/typescript-migration-roadmap.md](./docs/typescript-migration-roadmap.md)

## Mid- to long-term (next 6 months horizon)

### Features
- **Internationalization (i18n)** complete: ✅ Achieved in v2.0.37 — full
  EN / JA bilingual coverage.
- **List Builder Web API mode**: stabilize NLQ / category mode.
- **CRM integration**: sync with HubSpot / Salesforce (two-way contact
  history).
- **Send scheduling**: time-window targeting and send-pace control.

### Quality
- **Code signing rollout**: get serious about a Windows EV cert or Mac
  notarization.
- **E2E test expansion**: Playwright scenarios across every primary flow.
- **Settings encryption**: route `data/settings.json::apiKeys` through the
  OS keystore.
- **Telemetry (opt-in)**: anonymized metrics required for crash repro
  (opt-in only).

### Community
- **Contributor guide**: document design decisions, establish a review
  flow.
- **Issue triage**: report → verify → respond SLA.
- **Bilingual JA / EN support**: ✅ Done in v2.0.37 (both UI and docs).

## Short-term (next 30 days horizon)

- [ ] Remove 200 `as any` (Stage 2 top 5 files).
- [ ] Extract `dashboard-managed-provider-home.ts` out of
      `dashboard-server.ts`.
- [ ] Add `npm run test:unit` coverage measurement in CI.
- [ ] Add a Q&A / FAQ section to README.
- [ ] Add CODEOWNERS / SUPPORT.md.

## Suggestions & requests

For feature requests, please open an issue using the feature_request
template at [Issues](https://github.com/joseikininsight-hue/sales-claw-ts/issues).

We weigh priority by:
- User impact (how many people are blocked).
- Implementation cost (effort, breakage risk).
- Alignment with the existing roadmap.
- Security / compliance necessity.

## Revision history

| Date | Notes |
|---|---|
| 2026-05-14 | Initial version (created at the 2.0.1 release). |
| 2026-05-16 | Updated i18n full-bilingual to ✅ Done (v2.0.37). |

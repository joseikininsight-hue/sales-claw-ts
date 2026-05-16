# Sales Claw — AI Agent Instructions

> Japanese version: [docs/ja/AGENTS.md](./docs/ja/AGENTS.md)
>
> This file is an **entry point for AI agents that read `AGENTS.md`**
> (Codex CLI / Gemini CLI / etc.).
>
> **The canonical operational rules, workflow, and MCP usage contract live in
> [`CLAUDE.md`](./CLAUDE.md).** Read that file as the single source of truth.
>
> Historically we maintained AGENTS.md and CLAUDE.md separately, but they
> drifted apart. From 2.0.0 onward, CLAUDE.md is the only authoritative source.

## Quick Pointers

- **Absolute rule (form-fill + screenshot + `sentMessage` required)**: [CLAUDE.md](./CLAUDE.md)
- **Programmatic Credit (2026-06-15 policy)**: [docs/programmatic-credit-migration.md](./docs/programmatic-credit-migration.md)
- **Dashboard Port Lifecycle**: [docs/dashboard-port-lifecycle.md](./docs/dashboard-port-lifecycle.md)
- **TypeScript Migration Roadmap**: [docs/typescript-migration-roadmap.md](./docs/typescript-migration-roadmap.md)
- **Contribution guide**: [CONTRIBUTING.md](./CONTRIBUTING.md)
- **Security reports**: [SECURITY.md](./SECURITY.md)

## Forbidden actions (excerpt from CLAUDE.md)

Agents **must never** do the following. See the "ABSOLUTE RULE" section in
[CLAUDE.md](./CLAUDE.md) for the full list.

- Logging `awaiting_approval` after only generating a message (without
  touching the form).
- Writing a `form_fill` log entry without ever opening the form.
- Going to `awaiting_approval` without taking a screenshot.
- Silently going to `awaiting_approval` after "couldn't find the form" — this
  must be an `error` log entry with the reason explicitly stated.
- Omitting `sentMessage` from the `details` of `awaiting_approval` /
  `submitted`.
- Typing a degenerate body that is just a contact-info dump (TEL / MAIL only).

## Workflow (excerpt from CLAUDE.md)

Per-company required flow (no step may be skipped):

```
Step 0: MCP Playwright prerequisites
Step 1: Company-site analysis
Step 2: Message generation
Step 3: Form-URL discovery
Step 4: Form-structure analysis
Step 5: Fill the form  ★ NEVER SKIP
Step 6: Screenshot     ★ NEVER SKIP
Step 7: Register awaiting_approval
```

For all details — the tab-management contract, log spec, retry behavior, and
multi-company two-phase processing — see [CLAUDE.md](./CLAUDE.md).

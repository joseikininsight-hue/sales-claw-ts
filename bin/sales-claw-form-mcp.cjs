#!/usr/bin/env node
'use strict';

// Thin shim for Claude CLI (and other MCP clients) to spawn the
// sales-claw-form MCP server.
//
// Why a shim?
//   - Claude CLI invokes `command [args...]` registered via `claude mcp add`.
//     We point that command at this shim so installs/upgrades don't require
//     touching the user's mcp config.
//   - The shim resolves the actual server.cjs path relative to the installed
//     Sales Claw bundle (or from npm-global / dev source, in that priority).
//
// Phase 1: 単純 require して同プロセスで動かす (Node 単体で起動可能)。
// Phase 2: Electron 同梱の Node binary を `extraResources` 経由で同梱し、
//   `electron-builder.yml::extraResources` から resolve するように拡張する。

const path = require('path');
const fs = require('fs');

function findServerEntry() {
  const candidates = [
    // 1) Same package (npm-install / dev source)
    path.resolve(__dirname, '..', 'src', 'mcp-servers', 'sales-claw-form', 'server.cjs'),
    // 2) Compiled output
    path.resolve(__dirname, '..', 'dist-ts', 'src', 'mcp-servers', 'sales-claw-form', 'server.cjs'),
    // 3) Bundled inside installer (Phase 2)
    process.env.SALES_CLAW_FORM_MCP_SERVER_PATH || '',
  ].filter(Boolean);
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; }
    catch (_) { /* ignore */ }
  }
  return null;
}

const entry = findServerEntry();
if (!entry) {
  process.stderr.write('[sales-claw-form-mcp] server.cjs not found in any known path.\n');
  process.exit(1);
}

require(entry);

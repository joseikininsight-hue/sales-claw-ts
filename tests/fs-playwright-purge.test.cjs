'use strict';

// v2.0.74: Verify fs-direct playwright purge logic works on representative
// .claude.json shapes (root.playwright, mcpServers.playwright, projects[*]).
//
// We test the *logic* (in-memory JSON mutation) by extracting the same
// algorithm. The actual dispatch code lives in dashboard-server.ts:
// ensureProviderPlaywrightMcp internal-mode branch.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

function purgePlaywrightFromClaudeJson(json) {
  let changed = false;
  if (json && json.playwright) { delete json.playwright; changed = true; }
  if (json && json.mcpServers && json.mcpServers.playwright) {
    delete json.mcpServers.playwright;
    changed = true;
  }
  if (json && json.projects && typeof json.projects === 'object') {
    for (const k of Object.keys(json.projects)) {
      const proj = json.projects[k];
      if (proj && proj.mcpServers && proj.mcpServers.playwright) {
        delete proj.mcpServers.playwright;
        changed = true;
      }
    }
  }
  return { json, changed };
}

// ── Test cases (cover every real-world shape seen in user diagnostics) ──

// 1) root.playwright (managed home .claude.json shape today 2026-05-27 18:45)
{
  const before = {
    playwright: { type: 'stdio', command: 'Sales Claw.exe', args: ['wrapper.cjs'] },
    otherStuff: 'preserved',
  };
  const { json, changed } = purgePlaywrightFromClaudeJson(structuredClone(before));
  assert.strictEqual(changed, true, 'root.playwright should be removed');
  assert.ok(!json.playwright, 'root.playwright should be gone');
  assert.strictEqual(json.otherStuff, 'preserved', 'other top-level keys preserved');
  console.log('  ✓ root.playwright removed');
}

// 2) mcpServers.playwright (claude managed .claude/.claude.json shape)
{
  const before = {
    mcpServers: {
      playwright: { command: 'electron' },
      'sales-claw-form': { command: 'node', args: ['shim.cjs'] },
    },
    settings: { theme: 'dark' },
  };
  const { json, changed } = purgePlaywrightFromClaudeJson(structuredClone(before));
  assert.strictEqual(changed, true);
  assert.ok(!json.mcpServers.playwright, 'mcpServers.playwright should be gone');
  assert.ok(json.mcpServers['sales-claw-form'], 'sales-claw-form must be preserved');
  assert.strictEqual(json.settings.theme, 'dark');
  console.log('  ✓ mcpServers.playwright removed, sales-claw-form preserved');
}

// 3) projects[cwd].mcpServers.playwright (local-scope playwright registration)
{
  const before = {
    projects: {
      'C:\\some\\project': {
        mcpServers: {
          playwright: { command: 'playwright-mcp' },
          'custom-tool': { command: 'foo' },
        },
      },
      'C:\\other\\project': {
        mcpServers: { 'sales-claw-form': { command: 'bar' } },
      },
    },
  };
  const { json, changed } = purgePlaywrightFromClaudeJson(structuredClone(before));
  assert.strictEqual(changed, true);
  assert.ok(!json.projects['C:\\some\\project'].mcpServers.playwright);
  assert.ok(json.projects['C:\\some\\project'].mcpServers['custom-tool']);
  assert.ok(json.projects['C:\\other\\project'].mcpServers['sales-claw-form']);
  console.log('  ✓ projects[*].mcpServers.playwright removed, others preserved');
}

// 4) No playwright anywhere → no change
{
  const before = { mcpServers: { 'sales-claw-form': { command: 'x' } }, foo: 1 };
  const { changed } = purgePlaywrightFromClaudeJson(structuredClone(before));
  assert.strictEqual(changed, false, 'no playwright = no change');
  console.log('  ✓ no-op when playwright absent');
}

// 5) Combined: root + mcpServers + projects all have playwright
{
  const before = {
    playwright: { command: 'a' },
    mcpServers: { playwright: { command: 'b' }, keep: { command: 'k' } },
    projects: {
      proj1: { mcpServers: { playwright: { command: 'c' } } },
    },
  };
  const { json, changed } = purgePlaywrightFromClaudeJson(structuredClone(before));
  assert.strictEqual(changed, true);
  assert.ok(!json.playwright);
  assert.ok(!json.mcpServers.playwright);
  assert.ok(json.mcpServers.keep);
  assert.ok(!json.projects.proj1.mcpServers.playwright);
  console.log('  ✓ combined: all 3 playwright entries removed in one pass');
}

// 6) Real file roundtrip (write → purge → read → assert)
{
  const tmpFile = path.join(os.tmpdir(), `sales-claw-purge-test-${Date.now()}.json`);
  const content = {
    playwright: { command: 'Sales Claw.exe' },
    mcpServers: { playwright: { command: 'x' }, 'sales-claw-form': { command: 'y' } },
    other: { keep: true },
  };
  fs.writeFileSync(tmpFile, JSON.stringify(content, null, 2), 'utf8');

  const raw = fs.readFileSync(tmpFile, 'utf8');
  const json = JSON.parse(raw.replace(/^﻿/, ''));
  const { json: cleaned, changed } = purgePlaywrightFromClaudeJson(json);
  assert.strictEqual(changed, true);
  fs.writeFileSync(tmpFile, JSON.stringify(cleaned, null, 2), 'utf8');

  // Re-read & verify persisted
  const verifyRaw = fs.readFileSync(tmpFile, 'utf8');
  const verifyJson = JSON.parse(verifyRaw);
  assert.ok(!verifyJson.playwright);
  assert.ok(!verifyJson.mcpServers.playwright);
  assert.ok(verifyJson.mcpServers['sales-claw-form'], 'sales-claw-form survived round trip');
  assert.strictEqual(verifyJson.other.keep, true);
  fs.unlinkSync(tmpFile);
  console.log('  ✓ real-file roundtrip (write → purge → reread) preserves non-playwright');
}

// 7) BOM-prefixed JSON (PowerShell Set-Content -Encoding UTF8 leaves a BOM)
{
  const raw = '﻿' + JSON.stringify({ mcpServers: { playwright: { x: 1 } } });
  const json = JSON.parse(raw.replace(/^﻿/, ''));
  const { changed } = purgePlaywrightFromClaudeJson(json);
  assert.strictEqual(changed, true, 'BOM-prefixed JSON parses and purges');
  console.log('  ✓ BOM-prefixed JSON handled correctly');
}

console.log('\nAll purge-logic tests passed.');

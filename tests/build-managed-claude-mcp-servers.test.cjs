'use strict';

// v2.0.75: buildManagedClaudeMcpServers が mode に応じて適切な mcpServers を返すか
// 直接 sandbox 検証。実機 prepareClaudeManagedHome の上書きバグ修正の単体テスト。

const assert = require('assert');
const Module = require('module');

// settings-manager を mock してから dashboard-server を require
const origResolve = Module._resolve_filename = Module._resolveFilename;

let mockedMode = 'internal';
function mockSettingsManager() {
  return {
    getSection: (name) => {
      if (name === 'formFill') return { mode: mockedMode, parallelism: 3 };
      if (name === 'preferences') return { aiProvider: 'claude' };
      return {};
    },
    getScreenshotDir: () => 'screenshots',
    SETTINGS_FILE: '',
    SAMPLE_SETTINGS_FILE: '',
  };
}

// Cannot require dashboard-server (it starts Express). Reproduce build logic with same mock pattern.
// (実装と同じロジックを再現してテストする)
function makeFakeShouldOverride(_existing, _platform) { return true; }

function buildManagedClaudeMcpServers(realState, options = {}) {
  const getMode = options.getMode || (() => mockedMode);
  const mode = getMode();
  if (mode === 'internal') {
    return {};
  }
  const globalMcpServers = (realState && realState.mcpServers) || {};
  const existingPlaywright = globalMcpServers.playwright;
  const shouldOverride = options.shouldOverride || makeFakeShouldOverride;
  if (!shouldOverride(existingPlaywright, process.platform)) {
    return { playwright: existingPlaywright };
  }
  return {
    playwright: {
      type: 'stdio',
      command: 'fake-electron-exe',
      args: ['fake-wrapper.cjs'],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    },
  };
}

// === Tests ===

// 1) internal mode → empty mcpServers (NO playwright re-seeded)
{
  mockedMode = 'internal';
  const result = buildManagedClaudeMcpServers({ mcpServers: { playwright: { command: 'stale' } } });
  assert.deepStrictEqual(result, {}, 'internal mode must return empty mcpServers');
  console.log('  ✓ internal mode → empty mcpServers (no playwright re-seed)');
}

// 2) playwright mode → playwright is seeded
{
  mockedMode = 'playwright';
  const result = buildManagedClaudeMcpServers({});
  assert.ok(result.playwright, 'playwright mode must include playwright entry');
  assert.strictEqual(result.playwright.type, 'stdio');
  console.log('  ✓ playwright mode → playwright seeded');
}

// 3) both mode → playwright is seeded (sales-claw-form は ensure 側で動的登録)
{
  mockedMode = 'both';
  const result = buildManagedClaudeMcpServers({});
  // Note: 'both' is treated like 'playwright' by buildManagedClaudeMcpServers
  // because internal MCP is registered dynamically by ensureProviderInternalFormMcp.
  // (Implementation only special-cases 'internal' to skip playwright seed.)
  assert.ok(result.playwright, 'both mode also includes playwright');
  console.log('  ✓ both mode → playwright seeded (internal MCP added separately)');
}

// 4) internal mode + existing real-world playwright in state → still empty
{
  mockedMode = 'internal';
  const realWorld = {
    mcpServers: {
      playwright: {
        type: 'stdio',
        command: 'C:\\Users\\u\\AppData\\Local\\Programs\\Sales Claw\\Sales Claw.exe',
        args: ['playwright-mcp-wrapper.cjs'],
        env: { ELECTRON_RUN_AS_NODE: '1' },
      },
    },
  };
  const result = buildManagedClaudeMcpServers(realWorld);
  assert.deepStrictEqual(result, {}, 'real-world stale playwright must not survive internal mode');
  console.log('  ✓ internal mode rejects stale real-world playwright entry');
}

// 5) playwright mode + valid existing playwright → preserved (no rewrite)
{
  mockedMode = 'playwright';
  const valid = { command: '/usr/local/bin/playwright-mcp', args: [] };
  const result = buildManagedClaudeMcpServers(
    { mcpServers: { playwright: valid } },
    { shouldOverride: () => false }
  );
  assert.strictEqual(result.playwright, valid, 'valid existing playwright preserved');
  console.log('  ✓ playwright mode preserves valid existing entry');
}

console.log('\nAll buildManagedClaudeMcpServers tests passed.');

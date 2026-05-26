'use strict';

/**
 * Unit tests for src/mcp-config-helpers.cjs
 * Covers bug_001 (playwright-mcp override scope on Linux/macOS, .exe handling).
 *
 * Run: node tests/mcp-config-helpers.test.cjs
 */

const { shouldOverridePlaywrightMcpConfig, shouldOverrideInternalFormMcpConfig } = require('../dist-ts/src/mcp-config-helpers');

let passed = 0;
let failed = 0;
const failures = [];

function assertEquals(actual, expected, message) {
  if (actual === expected) { passed += 1; return; }
  failed += 1;
  failures.push({ message, actual, expected });
}

// ────────────────────────────────────────────────────────────
// No existing config → must override (we have to write something)
// ────────────────────────────────────────────────────────────
assertEquals(shouldOverridePlaywrightMcpConfig(null, 'win32'), true, 'null → override (no config to preserve)');
assertEquals(shouldOverridePlaywrightMcpConfig(undefined, 'linux'), true, 'undefined → override');
assertEquals(shouldOverridePlaywrightMcpConfig({}, 'darwin'), true, 'empty object → override');

// ────────────────────────────────────────────────────────────
// npm / npx based — override on EVERY platform (regression: npm/npx
// is always wrong, regardless of OS)
// ────────────────────────────────────────────────────────────
{
  const npx = { command: 'npx', args: ['@playwright/mcp@latest'] };
  assertEquals(shouldOverridePlaywrightMcpConfig(npx, 'win32'), true, 'npx → override on Windows');
  assertEquals(shouldOverridePlaywrightMcpConfig(npx, 'linux'), true, 'npx → override on Linux');
  assertEquals(shouldOverridePlaywrightMcpConfig(npx, 'darwin'), true, 'npx → override on macOS');

  const npxCmd = { command: 'C:\\Program Files\\nodejs\\npx.cmd', args: ['@playwright/mcp@latest'] };
  assertEquals(shouldOverridePlaywrightMcpConfig(npxCmd, 'win32'), true, 'full-path npx.cmd → override');

  const npmAsArg = { command: 'node', args: ['npm', 'exec', 'playwright-mcp'] };
  assertEquals(shouldOverridePlaywrightMcpConfig(npmAsArg, 'linux'), true, 'npm in args → override');
}

// ────────────────────────────────────────────────────────────
// .cmd / .bat shims — override ONLY on Windows
// (bug_001: previous regression overrode everywhere)
// ────────────────────────────────────────────────────────────
{
  const cmdShim = { command: 'C:\\Users\\u\\AppData\\Roaming\\sales-claw\\runtime\\tools\\bin\\playwright-mcp.cmd', args: [] };
  assertEquals(shouldOverridePlaywrightMcpConfig(cmdShim, 'win32'), true, '.cmd shim → override on Windows');
  assertEquals(shouldOverridePlaywrightMcpConfig(cmdShim, 'linux'), false, '.cmd path on Linux → preserve (theoretical, unusual)');

  const batShim = { command: 'C:\\bin\\playwright-mcp.bat', args: [] };
  assertEquals(shouldOverridePlaywrightMcpConfig(batShim, 'win32'), true, '.bat shim → override on Windows');
}

// ────────────────────────────────────────────────────────────
// bundled basename (no extension) — override ONLY on Windows
// because PATH lookup will resolve to .cmd. On Linux, basename means
// a real binary already on PATH and must be preserved.
// ────────────────────────────────────────────────────────────
{
  const bundled = { command: 'playwright-mcp', args: ['--browser', 'chrome'] };
  assertEquals(shouldOverridePlaywrightMcpConfig(bundled, 'win32'), true, 'basename "playwright-mcp" → override on Windows');
  assertEquals(shouldOverridePlaywrightMcpConfig(bundled, 'linux'), false, 'basename "playwright-mcp" → preserve on Linux');
  assertEquals(shouldOverridePlaywrightMcpConfig(bundled, 'darwin'), false, 'basename "playwright-mcp" → preserve on macOS');
}

// ────────────────────────────────────────────────────────────
// Real .exe file — preserve on EVERY platform (bug_001 root cause:
// previous code stripped .exe from basename and matched "playwright-mcp",
// regressing real-exe configs)
// ────────────────────────────────────────────────────────────
{
  const realExe = { command: 'C:\\bin\\playwright-mcp.exe', args: ['--debug'] };
  assertEquals(shouldOverridePlaywrightMcpConfig(realExe, 'win32'), false, 'real .exe → preserve on Windows');
  assertEquals(shouldOverridePlaywrightMcpConfig(realExe, 'linux'), false, 'real .exe path → preserve on Linux');
}

// ────────────────────────────────────────────────────────────
// Linux/macOS standard install paths — preserve
// ────────────────────────────────────────────────────────────
{
  const linuxBin = { command: '/usr/local/bin/playwright-mcp', args: [] };
  assertEquals(shouldOverridePlaywrightMcpConfig(linuxBin, 'linux'), false, '/usr/local/bin/playwright-mcp → preserve');

  const macBin = { command: '/opt/homebrew/bin/playwright-mcp', args: [] };
  assertEquals(shouldOverridePlaywrightMcpConfig(macBin, 'darwin'), false, '/opt/homebrew/bin/playwright-mcp → preserve');

  const userScript = { command: '/home/alice/scripts/playwright-mcp-wrapper.sh', args: [] };
  assertEquals(shouldOverridePlaywrightMcpConfig(userScript, 'linux'), false, 'custom user wrapper → preserve');
}

// ────────────────────────────────────────────────────────────
// Sales Claw managed config (Sales Claw.exe + ELECTRON_RUN_AS_NODE)
// — preserve, because we generated it ourselves
// ────────────────────────────────────────────────────────────
{
  const salesClaw = {
    command: 'C:\\Program Files\\Sales Claw\\Sales Claw.exe',
    args: ['C:\\Users\\u\\AppData\\Roaming\\sales-claw\\runtime\\tools\\bin\\playwright-mcp-wrapper.cjs'],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  };
  assertEquals(shouldOverridePlaywrightMcpConfig(salesClaw, 'win32'), false, 'Sales Claw exe-based config → preserve');
}

// ════════════════════════════════════════════════════════════
// shouldOverrideInternalFormMcpConfig (v2.1.0 Phase 2d)
// ════════════════════════════════════════════════════════════

// 既存設定が無ければ override
assertEquals(shouldOverrideInternalFormMcpConfig(null, 'win32'), true, 'internal: null → override');
assertEquals(shouldOverrideInternalFormMcpConfig({}, 'win32'), true, 'internal: empty obj → override');
assertEquals(shouldOverrideInternalFormMcpConfig({ command: '' }, 'win32'), true, 'internal: empty command → override');

// npm/npx 系 → override
assertEquals(
  shouldOverrideInternalFormMcpConfig({ command: 'npx', args: ['sales-claw-form-mcp'] }, 'linux'),
  true,
  'internal: npx → override',
);
assertEquals(
  shouldOverrideInternalFormMcpConfig({ command: 'C:\\Program Files\\nodejs\\npm.cmd', args: [] }, 'win32'),
  true,
  'internal: npm.cmd → override',
);

// 我々の shim を正しく指している → preserve
{
  const correct = {
    command: 'C:\\Users\\u\\AppData\\Local\\Programs\\Sales Claw\\Sales Claw.exe',
    args: ['C:\\bp-outreach-ts\\bin\\sales-claw-form-mcp.cjs'],
  };
  assertEquals(
    shouldOverrideInternalFormMcpConfig(correct, 'win32'),
    false,
    'internal: shim path 正しい → preserve',
  );
}
{
  const correctUnix = {
    command: '/usr/bin/node',
    args: ['/opt/sales-claw/bin/sales-claw-form-mcp.cjs'],
  };
  assertEquals(
    shouldOverrideInternalFormMcpConfig(correctUnix, 'linux'),
    false,
    'internal: unix node + shim → preserve',
  );
}

// shim 以外を指している → override (basename 一致しない)
{
  const wrong = { command: '/usr/bin/node', args: ['/some/other/script.cjs'] };
  assertEquals(
    shouldOverrideInternalFormMcpConfig(wrong, 'linux'),
    true,
    'internal: 別 script 指定 → override',
  );
}

// Windows で .cmd / .bat 経由は override (popup 回避)
{
  const cmdShim = { command: 'C:\\some\\sales-claw-form-mcp.cmd', args: [] };
  assertEquals(
    shouldOverrideInternalFormMcpConfig(cmdShim, 'win32'),
    true,
    'internal: .cmd shim on win32 → override',
  );
}

// ────────────────────────────────────────────────────────────
// Output
// ────────────────────────────────────────────────────────────
console.log('');
console.log(`PASSED: ${passed}`);
console.log(`FAILED: ${failed}`);
if (failed > 0) {
  for (const f of failures) {
    console.log(`  FAIL: ${f.message}`);
    console.log(`    actual:   ${JSON.stringify(f.actual)}`);
    console.log(`    expected: ${JSON.stringify(f.expected)}`);
  }
  process.exitCode = 1;
} else {
  console.log('all mcp-config-helpers tests passed.');
}

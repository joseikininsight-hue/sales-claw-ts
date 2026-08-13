'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function describe(n, f) { console.log('\n=== ' + n + ' ==='); f(); }
function it(n, f) {
  try { f(); console.log('  OK  ' + n); }
  catch (e) { console.error('  FAIL ' + n + ' - ' + e.message); process.exitCode = 1; }
}

function readProjectFile(...parts) {
  return fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8');
}

describe('dashboard performance guards', () => {
  it('does not auto-load P1 operations APIs when the operations panel mounts', () => {
    const renderAnalyticsScript = require('../dist-ts/src/ui/client-scripts/dashboard-analytics.js');
    const script = renderAnalyticsScript();
    const start = script.indexOf('function ensureOpsQuickPanel()');
    const end = script.indexOf('window.ensureOpsQuickPanel = ensureOpsQuickPanel;', start);
    assert.notEqual(start, -1, 'ensureOpsQuickPanel should exist');
    assert.notEqual(end, -1, 'ensureOpsQuickPanel export should exist');
    const body = script.slice(start, end);
    assert.match(body, /onclick="loadTargetValidationResult\(\)"/, 'manual data-quality result button should remain');
    assert.match(body, /onclick="loadErrorRecoveryGroups\(\)"/, 'manual error refresh button should remain');
    assert.doesNotMatch(body, /^\s*loadTargetValidationResult\(\);\s*$/m, 'validation result must be user-triggered');
    assert.doesNotMatch(body, /^\s*loadErrorRecoveryGroups\(\);\s*$/m, 'grouped errors must be user-triggered');
  });

  it('keeps AI launch/status probes off the Electron main thread', () => {
    const source = readProjectFile('src', 'dashboard-server.ts');
    assert.doesNotMatch(source, /\bspawnSync\b/, 'AI CLI probes must not use spawnSync');
    assert.match(source, /const _aiStatusInFlight = new Map(?:<[^>]+>)?\(\)/, 'AI status probes should be coalesced');
    assert.match(source, /const _aiDiagnosticsInFlight = new Map(?:<[^>]+>)?\(\)/, 'AI diagnostics probes should be coalesced');
    assert.match(source, /AI_DIAGNOSTICS_CACHE_TTL_MS/, 'AI diagnostics should be cached briefly');
  });

  it('guards the AI launch modal from repeated clicks', () => {
    const serverSource = readProjectFile('src', 'dashboard-server.ts');
    const guardSource = readProjectFile('src', 'ui', 'client-scripts', 'launch-crash-guard.ts');
    const routeSource = readProjectFile('src', 'routes', 'ai-runtime-api.ts');
    assert.match(serverSource, /renderLaunchCrashGuardScript\(\)/, 'launch crash guard should be injected into dashboard HTML');
    assert.match(guardSource, /wrapGlobal\('confirmLaunch'/, 'confirmLaunch should be wrapped');
    assert.match(guardSource, /wrapGlobal\('loadLaunchSetupDiagnostics'/, 'diagnostics should be debounced client-side');
    assert.match(routeSource, /allowReuse:\s*body\.restart === true \? false : true/, 'launch API should reuse same active session by default');
  });

  it('keeps provider-specific launch diagnostics actionable', () => {
    const serverSource = readProjectFile('src', 'dashboard-server.ts');
    const routeSource = readProjectFile('src', 'routes', 'ai-runtime-api.ts');
    assert.match(serverSource, /getProviderVersionWarning/, 'old CLI versions should be detected before launch');
    assert.match(serverSource, /cliTooOld:\s*!!versionWarning/, 'AI status should expose old CLI warnings');
    assert.match(serverSource, /versionWarning:\s*cliStatus\.versionWarning/, 'setup diagnostics should expose old CLI warnings');
    assert.match(serverSource, /normalizedProviderId === 'gemini' \? \['--debug', 'mcp', 'list'\]/, 'Gemini MCP list needs --debug to print configured servers');
    assert.match(serverSource, /addArgs = \['--debug', 'mcp', 'add', 'playwright'/, 'Gemini MCP add should use the debuggable command path');
    assert.match(routeSource, /getManagedAiProvider/, 'stop-ai should report the active managed provider');
    assert.match(routeSource, /managedPty && typeof getManagedAiProvider === 'function'/, 'stop-ai should prefer the active PTY provider over selected settings');
  });

  it('does not leave AI launch locks stuck after stop or timeout', () => {
    const serverSource = readProjectFile('src', 'dashboard-server.ts');
    const routeSource = readProjectFile('src', 'routes', 'ai-runtime-api.ts');
    const terminalSource = readProjectFile('src', 'ui', 'client-scripts', 'cli-terminal.ts');
    assert.match(serverSource, /MANAGED_AI_LAUNCH_LOCK_STALE_MS/, 'server should expire stale launch locks');
    assert.match(serverSource, /function cancelManagedAiLaunch/, 'server should expose launch cancellation');
    assert.match(serverSource, /assertManagedAiLaunchActive\(launchToken, 'after-mcp-setup'\)/, 'cancelled launches must not spawn after MCP setup returns');
    assert.match(routeSource, /cancelManagedAiLaunch\('stop-api'\)/, 'stop-ai should cancel any in-flight launch');
    assert.match(routeSource, /reason:\s*'launch_cancelled'/, 'launch API should return structured cancellation');
    assert.match(terminalSource, /AbortController/, 'client launch fetch should be abortable');
    assert.match(terminalSource, /function cancelPendingLaunch/, 'client should clear launch lock on stop');
    // server 側 stale lock と client 側 abort timeout は揃える。
    // MCP playwright add (最大 30s) + version probe (5s) + 他 で 50s 超
    // 行く場合があるので 45s では client が abort してしまっていた。
    assert.match(terminalSource, /LAUNCH_REQUEST_TIMEOUT_MS = 200000/, 'client should time out stuck launch requests');
    assert.match(serverSource, /MANAGED_AI_LAUNCH_LOCK_STALE_MS = 200000/, 'server stale-lock should match the client launch timeout');
    assert.match(serverSource, /_launchSpawnedChildren/, 'cancelManagedAiLaunch must kill in-flight CLI children');
  });

  it('passes configured models to every managed CLI launch path', () => {
    const { buildLaunchArgs } = require('../dist-ts/src/ai-providers');
    assert.deepEqual(
      buildLaunchArgs('claude', 'auto', { model: 'claude-sonnet-4-6', sessionId: 'session-1' }),
      ['--permission-mode', 'auto', '--model', 'claude-sonnet-4-6', '--session-id', 'session-1'],
      'Claude should receive the configured model with --model',
    );
    assert.deepEqual(
      buildLaunchArgs('codex', 'auto', { model: 'gpt-5-codex' }),
      ['-a', 'never', '-s', 'danger-full-access', '-m', 'gpt-5-codex'],
      'Codex should receive the configured model with -m',
    );
    assert.deepEqual(
      buildLaunchArgs('gemini', 'auto', { model: 'gemini-2.5-pro' }),
      ['--approval-mode', 'auto_edit', '-m', 'gemini-2.5-pro'],
      'Gemini should receive the configured model with -m',
    );
  });

  it('keeps desktop auto-update recoverable after a missed startup check', () => {
    const mainSource = readProjectFile('electron-main.ts');
    const serverSource = readProjectFile('src', 'dashboard-server.ts');
    const simpleApiSource = readProjectFile('src', 'routes', 'simple-api.ts');
    assert.match(mainSource, /check-update\.flag/, 'Electron should watch a manual update-check flag');
    assert.match(mainSource, /setInterval\(\(\) => checkForUpdates\('periodic'\)/, 'Electron should periodically re-check while the app stays open');
    assert.match(simpleApiSource, /pathname === '\/api\/check-update'/, 'Dashboard API should expose manual update checks');
    assert.match(serverSource, /id="updateCheckBtn"/, 'Dashboard header should expose a manual update button');
    assert.match(serverSource, /renderUpdateCheckControlsScript\(\)/, 'Manual update button should have client-side behavior');
  });

  it('keeps the list-builder history modal closable even if client init is interrupted', () => {
    const serverSource = readProjectFile('src', 'dashboard-server.ts');
    assert.match(
      serverSource,
      /id="lb2HistoryModal" hidden onclick="if\(event\.target===this\)this\.hidden=true"/,
      'history modal backdrop should close inline',
    );
    assert.match(
      serverSource,
      /id="lb2HistoryModalClose" type="button" aria-label="close" onclick="event\.preventDefault\(\);event\.stopPropagation\(\);var m=document\.getElementById\('lb2HistoryModal'\);if\(m\)m\.hidden=true"/,
      'history modal close button should work even before delegated handlers run',
    );
    assert.match(serverSource, /function closeHistoryModal\(\) \{ setHistoryModalOpen\(false\); \}/, 'history modal should have a shared close helper');
    assert.match(serverSource, /if \(ev\.key === 'Escape'\) closeHistoryModal\(\);/, 'Escape should close the history modal');
  });
});

describe('target-list import performance guards', () => {
  it('does not start full URL validation from settings import', () => {
    const source = readProjectFile('src', 'routes', 'settings-api.ts');
    assert.doesNotMatch(source, /startTargetListValidationAfterImport/);
    assert.doesNotMatch(source, /require\(['"]\.\.\/target-list-validator\.cjs['"]\)/);
    assert.match(source, /validationDeferred:\s*true/);
  });

  it('does not start full URL validation from onboarding import', () => {
    const source = readProjectFile('src', 'routes', 'onboarding-api.ts');
    assert.doesNotMatch(source, /startTargetListValidationAfterImport/);
    assert.doesNotMatch(source, /require\(['"]\.\.\/target-list-validator\.cjs['"]\)/);
    assert.match(source, /target-list-validation-deferred/);
  });
});

console.log('\nall performance guard tests passed.');

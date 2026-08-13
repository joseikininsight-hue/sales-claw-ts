'use strict';

/**
 * Unit tests for src/action-logger.cjs
 *
 * Coverage targets:
 *   - logAction (JSON path)
 *   - getCompanyLog / getAllLogs / getLatestActions / removeCompanyLogs
 *   - SQLite stub fallthrough (getSqliteAdapter() always null)
 *   - JSON corruption recovery (.corrupt.{ts} backup)
 *   - signature-based cache reload
 *   - acquireFileLock timeout swallow
 *   - notifyCliLog HTTP best-effort failure (silent)
 *
 * Run: node tests/action-logger.test.cjs
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// ─── Sandbox isolation: point runtime root at temp dir BEFORE requiring modules ───
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'sales-claw-action-logger-test-'));
process.env.SALES_CLAW_USER_DATA_DIR = sandbox;
// Keep CLI notify silent (won't reach a server but try is wrapped in try/catch + req.on('error'))
delete process.env.SALES_CLAW_CLI_TOKEN;

// Re-require (no cache) to pick up env override.
function freshRequire(modulePath) {
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];
  return require(modulePath);
}

const settings = freshRequire('../dist-ts/src/settings-manager');
freshRequire('../dist-ts/src/data-paths');
const actionLogger = freshRequire('../dist-ts/src/action-logger');

let passed = 0;
let failed = 0;
const failures = [];

function assertEq(name, actual, expected) {
  if (actual === expected) { passed += 1; return; }
  failed += 1;
  failures.push({ name, actual, expected });
}
function assertOk(name, value) { assertEq(name, !!value, true); }
function assertNot(name, value) { assertEq(name, !value, true); }
function assertDeep(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passed += 1; return; }
  failed += 1;
  failures.push({ name, actual: a, expected: e });
}

const dataDir = path.join(sandbox, 'data');
const logFile = path.join(dataDir, 'action-log.json');

function resetLogFile() {
  if (actionLogger._test && typeof actionLogger._test.resetCache === 'function') {
    actionLogger._test.resetCache();
  }
  // Write empty array + bump mtime forward so the in-module cache (keyed by
  // filePath + mtime/size) is invalidated. Plain unlink leaves both filePath
  // and signature=null cache states matching, so a stale array would be
  // returned on next read.
  try { fs.mkdirSync(dataDir, { recursive: true }); } catch (_) {}
  fs.writeFileSync(logFile, '[]', 'utf-8');
  // Bump mtime forward by an offset that grows each call so signature differs.
  resetLogFile._tick = (resetLogFile._tick || 0) + 1;
  const ts = new Date(Date.now() + resetLogFile._tick * 60000);
  fs.utimesSync(logFile, ts, ts);
  if (actionLogger._test && typeof actionLogger._test.resetCache === 'function') {
    actionLogger._test.resetCache();
  }
  // Wipe corrupt backups
  try {
    const dir = fs.readdirSync(dataDir);
    for (const f of dir) {
      if (f.startsWith('action-log.json.corrupt.') || f === 'action-log.json.bak' || f === 'action-log.json.lock') {
        try { fs.unlinkSync(path.join(dataDir, f)); } catch (_) {}
      }
    }
  } catch (_) {}
}

// ─────────────────────────────────────────────────────────────
// 1. logAction creates file, returns count
// ─────────────────────────────────────────────────────────────
{
  resetLogFile();
  const count = actionLogger.logAction(1, '株式会社テスト', 'awaiting_approval', 'first detail');
  assertEq('logAction returns 1 for first entry', count, 1);
  assertOk('action-log.json was created', fs.existsSync(logFile));

  const raw = JSON.parse(fs.readFileSync(logFile, 'utf-8'));
  assertEq('entry count on disk = 1', raw.length, 1);
  assertEq('entry companyNo persisted', raw[0].companyNo, 1);
  assertEq('entry action persisted', raw[0].action, 'awaiting_approval');
  assertEq('entry details persisted', raw[0].details, 'first detail');
  assertOk('entry has ISO timestamp', typeof raw[0].timestamp === 'string' && raw[0].timestamp.includes('T'));
}

// ─────────────────────────────────────────────────────────────
// 2. logAction appends multiple entries (different companies)
// ─────────────────────────────────────────────────────────────
{
  resetLogFile();
  actionLogger.logAction(1, 'A社', 'site_analysis', 'd1');
  actionLogger.logAction(2, 'B社', 'message_draft', 'd2');
  actionLogger.logAction(1, 'A社', 'form_fill', 'd3');
  const all = actionLogger.getAllLogs();
  assertEq('getAllLogs returns 3 total', all.length, 3);
  assertEq('first entry company is A社', all[0].companyName, 'A社');
  assertEq('third entry action form_fill', all[2].action, 'form_fill');
}

// ─────────────────────────────────────────────────────────────
// 3. getCompanyLog filters by companyNo
// ─────────────────────────────────────────────────────────────
{
  // re-use entries from test 2
  const a = actionLogger.getCompanyLog(1);
  assertEq('A社 logs count = 2', a.length, 2);
  assertOk('all returned entries belong to A社', a.every(e => e.companyNo === 1));

  const b = actionLogger.getCompanyLog(2);
  assertEq('B社 logs count = 1', b.length, 1);
  assertEq('B社 single entry action message_draft', b[0].action, 'message_draft');

  // Empty
  const none = actionLogger.getCompanyLog(999);
  assertEq('non-existent company = []', none.length, 0);
}

// ─────────────────────────────────────────────────────────────
// 4. getCompanyLog returns deep clone (mutations don't affect cache)
// ─────────────────────────────────────────────────────────────
{
  const c1 = actionLogger.getCompanyLog(1);
  c1[0].action = 'mutated';
  const c2 = actionLogger.getCompanyLog(1);
  assertNot('mutation on returned array does not affect cache', c2[0].action === 'mutated');
}

// ─────────────────────────────────────────────────────────────
// 5. getLatestActions returns latest entry per company
// ─────────────────────────────────────────────────────────────
{
  // existing: A社 site_analysis(d1), B社 message_draft(d2), A社 form_fill(d3)
  const latest = actionLogger.getLatestActions();
  assertEq('latest actions count = 2 unique companies', latest.length, 2);
  const aLatest = latest.find(e => e.companyNo === 1);
  const bLatest = latest.find(e => e.companyNo === 2);
  assertEq('A社 latest action is form_fill', aLatest && aLatest.action, 'form_fill');
  assertEq('B社 latest action is message_draft', bLatest && bLatest.action, 'message_draft');
}

// ─────────────────────────────────────────────────────────────
// 6. removeCompanyLogs deletes only that company's entries
// ─────────────────────────────────────────────────────────────
{
  const removed = actionLogger.removeCompanyLogs(1);
  assertEq('removed 2 entries for company 1', removed, 2);
  const remaining = actionLogger.getAllLogs();
  assertEq('remaining count = 1', remaining.length, 1);
  assertEq('remaining is B社', remaining[0].companyNo, 2);

  // Removing again: 0
  const removedAgain = actionLogger.removeCompanyLogs(1);
  assertEq('removing absent company returns 0', removedAgain, 0);

  // Removing non-existent: 0
  const removedMissing = actionLogger.removeCompanyLogs(12345);
  assertEq('removing non-existent company returns 0', removedMissing, 0);
}

// ─────────────────────────────────────────────────────────────
// 7. removeCompanyLogs handles string vs number companyNo
// ─────────────────────────────────────────────────────────────
{
  resetLogFile();
  actionLogger.logAction('99', 'String社', 'submitted', 'x');
  actionLogger.logAction(99, 'String社', 'awaiting_approval', 'y');
  // Both should be considered same key (String(99) === '99')
  const removed = actionLogger.removeCompanyLogs(99);
  assertEq('removeCompanyLogs treats 99 and "99" as same key', removed, 2);
}

// ─────────────────────────────────────────────────────────────
// 8. JSON corruption recovery: malformed file → .corrupt.{ts} backup, returns []
// ─────────────────────────────────────────────────────────────
{
  resetLogFile();
  fs.writeFileSync(logFile, '{not valid json', 'utf-8');
  // Suppress console.warn for clean test output
  const origWarn = console.warn;
  let warned = false;
  console.warn = () => { warned = true; };
  try {
    const all = actionLogger.getAllLogs();
    assertDeep('corrupt JSON yields empty array', all, []);
    assertOk('console.warn was called for corrupt JSON', warned);
    // Backup file should exist
    const dirContents = fs.readdirSync(dataDir);
    const backups = dirContents.filter(f => f.startsWith('action-log.json.corrupt.'));
    assertOk('corrupt backup file exists', backups.length >= 1);
  } finally {
    console.warn = origWarn;
  }
}

// ─────────────────────────────────────────────────────────────
// 9. logAction works on top of corruption (continues with empty fallback)
// ─────────────────────────────────────────────────────────────
{
  resetLogFile();
  fs.writeFileSync(logFile, '@@@ broken @@@', 'utf-8');
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    const count = actionLogger.logAction(7, 'Recovery社', 'submitted', 'after corrupt');
    assertEq('logAction after corruption returns 1', count, 1);
    const all = actionLogger.getAllLogs();
    assertEq('all logs has 1 after recovery', all.length, 1);
    assertEq('the entry is the new one', all[0].companyName, 'Recovery社');
  } finally {
    console.warn = origWarn;
  }
}

// ─────────────────────────────────────────────────────────────
// 10. cache invalidation: external modification triggers reload via signature.
//     v2.1.6: 別プロセスの書き込みで cache を全置換すると、自プロセスの
//     flush 待ちエントリが消える lost update があった。現仕様は
//     「ディスク ∪ (メモリ − ディスク)」のマージで両方を保持する。
// ─────────────────────────────────────────────────────────────
{
  resetLogFile();
  actionLogger.logAction(1, 'CacheTest', 'a1', 'd'); // non-terminal → flush 待ちのまま
  // Manually write a new file (simulating another process)
  const externalEntries = [
    { timestamp: new Date().toISOString(), companyNo: 1, companyName: 'CacheTest', action: 'a1', details: 'd' },
    { timestamp: new Date().toISOString(), companyNo: 2, companyName: 'External', action: 'submitted', details: 'ext' },
  ];
  // Need different mtime/size to bust cache
  fs.writeFileSync(logFile, JSON.stringify(externalEntries, null, 2), 'utf-8');
  // Bump mtime explicitly forward
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(logFile, future, future);

  const all = actionLogger.getAllLogs();
  // 外部書き込み 2 件 + 自プロセスの flush 待ち 1 件 (timestamp が異なる別エントリ)
  assertEq('external write merged with pending entries', all.length, 3);
  assertEq('external entry visible', all.filter((e) => e.companyName === 'External').length, 1);
  assertEq('pending own entry preserved (no lost update)', all.filter((e) => e.companyName === 'CacheTest').length, 2);
}

// ─────────────────────────────────────────────────────────────
// 11. saveLog respects maxLogEntries trim (test the lower bound clamp)
// ─────────────────────────────────────────────────────────────
{
  resetLogFile();
  // Override preferences.maxLogEntries to a small value via settings
  const prefs = settings.getSection('preferences') || {};
  const originalMax = prefs.maxLogEntries;
  // The clamp is Math.max(100, ...). Try setting to 50 → should clamp to 100, then push 105 entries
  // and verify only last 100 retained.
  try {
    settings.updateSection('preferences', { maxLogEntries: 50 });
    for (let i = 0; i < 105; i++) {
      actionLogger.logAction(i + 1, `c${i}`, 'submitted', `d${i}`);
    }
    const all = actionLogger.getAllLogs();
    assertEq('trimmed to 100 (Math.max clamp)', all.length, 100);
    assertEq('first kept entry is c5 (105 - 100)', all[0].companyName, 'c5');
  } finally {
    if (originalMax !== undefined) {
      settings.updateSection('preferences', { maxLogEntries: originalMax });
    }
  }
}

// ─────────────────────────────────────────────────────────────
// 12. Missing file → returns []
// ─────────────────────────────────────────────────────────────
{
  resetLogFile();
  // Now actually delete the file to test missing-file branch
  try { fs.unlinkSync(logFile); } catch (_) {}
  const all = actionLogger.getAllLogs();
  assertDeep('missing file returns empty array', all, []);
  const co = actionLogger.getCompanyLog(1);
  assertDeep('missing file getCompanyLog = []', co, []);
  const latest = actionLogger.getLatestActions();
  assertDeep('missing file getLatestActions = []', latest, []);
}

// ─────────────────────────────────────────────────────────────
// 13. Object-shaped details preserved
// ─────────────────────────────────────────────────────────────
{
  resetLogFile();
  const detailsObj = { url: 'https://example.com', tabs: 3, finalFormTab: 'https://example.com/contact' };
  actionLogger.logAction(42, 'DetailObj社', 'awaiting_approval', detailsObj);
  const all = actionLogger.getAllLogs();
  assertEq('object details preserved (has url)', all[0].details && all[0].details.url, 'https://example.com');
  assertEq('object details preserved (tabs)', all[0].details && all[0].details.tabs, 3);
}

// ─────────────────────────────────────────────────────────────
// Cleanup
// ─────────────────────────────────────────────────────────────
try {
  // Allow any pending notifyCliLog HTTP requests to settle then cleanup
  setTimeout(() => {
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch (_) {}
  }, 50);
} catch (_) {}

// ─────────────────────────────────────────────────────────────
// Output
// ─────────────────────────────────────────────────────────────
console.log('');
console.log(`PASSED: ${passed}`);
console.log(`FAILED: ${failed}`);
if (failed > 0) {
  for (const f of failures) {
    console.log(`  FAIL: ${f.name}`);
    console.log(`    actual:   ${typeof f.actual === 'string' ? f.actual : JSON.stringify(f.actual)}`);
    console.log(`    expected: ${typeof f.expected === 'string' ? f.expected : JSON.stringify(f.expected)}`);
  }
  process.exitCode = 1;
} else {
  console.log('all action-logger tests passed.');
}

'use strict';

/**
 * /api/data smoke test — calls loadData() directly to ensure it doesn't throw
 * regardless of file state edge cases (missing files, empty files, broken
 * action-log etc).
 *
 * 2026-05-15 incident: dashboard's "読込失敗: Cannot read properties of
 * undefined (reading 'length')" was traced to loadData() → contact-history.
 * This test ensures loadData() never crashes on common bad inputs.
 *
 * NOTE: build を経由するので、build error が起きると先に test が落ちる。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'loaddata-smoke-'));
process.env.SALES_CLAW_USER_DATA_DIR = tmpRoot;
const dataDir = path.join(tmpRoot, 'data');
fs.mkdirSync(dataDir, { recursive: true });

let passed = 0;
let failed = 0;
const failures = [];

function assertNoThrow(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (e) {
    failed += 1;
    failures.push({ name, error: e.stack || e.message });
  }
}

function freshLoadData() {
  // Clear all related module caches so each test gets a clean slate.
  Object.keys(require.cache).forEach((p) => {
    if (p.includes('dist-ts') && (
      p.includes('dashboard-server') ||
      p.includes('contact-history') ||
      p.includes('action-logger') ||
      p.includes('live-monitor') ||
      p.includes('data-paths') ||
      p.includes('settings-manager') ||
      p.includes('target-list') ||
      p.includes('outreach-targets')
    )) {
      delete require.cache[p];
    }
  });
  return require('../dist-ts/src/dashboard-server').loadData;
}

// ─────────────────────────────────────────────────────────────
// 1. 完全に空 (ファイル無し)
// ─────────────────────────────────────────────────────────────
assertNoThrow('loadData with empty data dir', () => {
  const loadData = freshLoadData();
  const r = loadData({ force: true });
  if (!Array.isArray(r.companies)) throw new Error('companies not array');
  if (!Array.isArray(r.recentLogs)) throw new Error('recentLogs not array');
});

// ─────────────────────────────────────────────────────────────
// 2. 壊れた contact-history.json (Array)
// ─────────────────────────────────────────────────────────────
fs.writeFileSync(path.join(dataDir, 'contact-history.json'), JSON.stringify([
  { companyNo: 70, companyName: 'X' },
]));
assertNoThrow('loadData with Array contact-history', () => {
  const loadData = freshLoadData();
  const r = loadData({ force: true });
  if (!Array.isArray(r.companies)) throw new Error('companies not array');
});

// ─────────────────────────────────────────────────────────────
// 3. contacts 欠如エントリ
// ─────────────────────────────────────────────────────────────
fs.writeFileSync(path.join(dataDir, 'contact-history.json'), JSON.stringify({
  '70': { companyNo: 70, companyName: 'X' },
}));
assertNoThrow('loadData with broken object contact-history', () => {
  const loadData = freshLoadData();
  const r = loadData({ force: true });
  if (!Array.isArray(r.companies)) throw new Error('companies not array');
});

// ─────────────────────────────────────────────────────────────
// 4. 空ファイル
// ─────────────────────────────────────────────────────────────
fs.writeFileSync(path.join(dataDir, 'contact-history.json'), '');
assertNoThrow('loadData with empty contact-history file', () => {
  const loadData = freshLoadData();
  const r = loadData({ force: true });
  if (!Array.isArray(r.companies)) throw new Error('companies not array');
});

// ─────────────────────────────────────────────────────────────
// 5. 壊れた JSON
// ─────────────────────────────────────────────────────────────
fs.writeFileSync(path.join(dataDir, 'contact-history.json'), '{not valid json');
assertNoThrow('loadData with corrupted JSON contact-history', () => {
  const loadData = freshLoadData();
  const r = loadData({ force: true });
  if (!Array.isArray(r.companies)) throw new Error('companies not array');
});

// Cleanup
try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}

console.log('');
console.log(`PASSED: ${passed}`);
console.log(`FAILED: ${failed}`);
if (failed > 0) {
  for (const f of failures) {
    console.log('  FAIL:', f.name);
    console.log('   ', f.error.split('\n').slice(0, 5).join('\n    '));
  }
  process.exitCode = 1;
} else {
  console.log('all load-data smoke tests passed.');
}

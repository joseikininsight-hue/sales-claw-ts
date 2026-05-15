'use strict';

/**
 * Regression test for contact-history defensive guards.
 *
 * 2026-05-15 incident: 手動復旧で書いた contact-history.json が top-level
 * Array (本来は object map) で、`getAllHistorySummary()` が
 * `h.contacts.length` で TypeError を投げ、 `/api/data` が 500 を返し続け
 * ダッシュボードが「読込失敗: Cannot read properties of undefined
 * (reading 'length')」を出した。
 *
 * このテストは:
 *   1. 壊れた history (Array / contacts 欠如 / contacts が Array でない)
 *      でも crash しない
 *   2. 正しい history は今まで通り動く
 * を保証する。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// 一時 dir を作って SALES_CLAW_USER_DATA_DIR を差し替える。
// dist-ts は SALES_CLAW_USER_DATA_DIR を見るので、これで隔離できる。
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'contact-hist-test-'));
process.env.SALES_CLAW_USER_DATA_DIR = tmpRoot;
const dataDir = path.join(tmpRoot, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const historyFile = path.join(dataDir, 'contact-history.json');

// Module を fresh で require (cache invalidation)
function freshRequire() {
  const p = require.resolve('../dist-ts/src/contact-history');
  delete require.cache[p];
  return require('../dist-ts/src/contact-history');
}

let passed = 0;
let failed = 0;
const failures = [];

function assertEq(name, actual, expected) {
  if (actual === expected) { passed += 1; return; }
  failed += 1;
  failures.push({ name, actual, expected });
}
function assertNoThrow(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (e) {
    failed += 1;
    failures.push({ name, error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────
// 1. 壊れた history (top-level Array) でも crash しない
// ─────────────────────────────────────────────────────────────
fs.writeFileSync(historyFile, JSON.stringify([
  { companyNo: 70, companyName: 'サイバネット', contactedAt: '2026-05-15T00:00:00Z' },
]));
{
  const ch = freshRequire();
  assertNoThrow('getAllHistorySummary on Array history', () => ch.getAllHistorySummary());
  assertEq('Array history → empty summary', ch.getAllHistorySummary().length, 0);
  assertNoThrow('getContactCount on Array history', () => ch.getContactCount(70));
}

// ─────────────────────────────────────────────────────────────
// 2. contacts が undefined (object map だが contacts キー欠如)
// ─────────────────────────────────────────────────────────────
fs.writeFileSync(historyFile, JSON.stringify({
  '70': { companyNo: 70, companyName: 'サイバネット' /* no contacts */ },
}));
{
  const ch = freshRequire();
  assertNoThrow('getAllHistorySummary on missing contacts', () => ch.getAllHistorySummary());
  const summary = ch.getAllHistorySummary();
  assertEq('missing contacts → 1 summary entry', summary.length, 1);
  assertEq('missing contacts → contactCount 0', summary[0].contactCount, 0);
  assertEq('missing contacts → lastDate null', summary[0].lastDate, null);
  assertEq('getContactCount → 0 for missing contacts', ch.getContactCount(70), 0);
  assertEq('getLastMessage → null for missing contacts', ch.getLastMessage(70), null);
}

// ─────────────────────────────────────────────────────────────
// 3. contacts が string や object (not Array) でも crash しない
// ─────────────────────────────────────────────────────────────
fs.writeFileSync(historyFile, JSON.stringify({
  '70': { companyNo: 70, companyName: 'サイバネット', contacts: 'broken' },
  '71': { companyNo: 71, companyName: '別の会社', contacts: { foo: 'bar' } },
}));
{
  const ch = freshRequire();
  assertNoThrow('getAllHistorySummary on non-array contacts', () => ch.getAllHistorySummary());
  const summary = ch.getAllHistorySummary();
  assertEq('non-array contacts → 2 summary entries', summary.length, 2);
  summary.forEach((entry, i) => {
    assertEq(`entry ${i} contactCount = 0 for non-array`, entry.contactCount, 0);
  });
}

// ─────────────────────────────────────────────────────────────
// 4. 正常な history は今まで通り動く
// ─────────────────────────────────────────────────────────────
fs.writeFileSync(historyFile, JSON.stringify({
  '70': {
    companyNo: 70,
    companyName: 'サイバネット',
    contacts: [
      { contactNo: 1, date: '2026-05-15T00:00:00Z', message: 'first contact', status: 'submitted' },
      { contactNo: 2, date: '2026-05-15T01:00:00Z', message: 'second contact', status: 'submitted' },
    ],
  },
}));
{
  const ch = freshRequire();
  const summary = ch.getAllHistorySummary();
  assertEq('valid history summary length', summary.length, 1);
  assertEq('valid contactCount = 2', summary[0].contactCount, 2);
  assertEq('valid lastDate', summary[0].lastDate, '2026-05-15T01:00:00Z');
  assertEq('getContactCount → 2', ch.getContactCount(70), 2);
  assertEq('getLastMessage → second contact', ch.getLastMessage(70), 'second contact');
}

// ─────────────────────────────────────────────────────────────
// 5. recordContact が壊れた既存 entry を上書き再初期化する
// ─────────────────────────────────────────────────────────────
fs.writeFileSync(historyFile, JSON.stringify({
  '70': { companyNo: 70, companyName: 'サイバネット' /* no contacts */ },
}));
{
  const ch = freshRequire();
  assertNoThrow('recordContact heals broken entry', () => {
    ch.recordContact(70, 'サイバネット', { message: 'test message', status: 'submitted' });
  });
  assertEq('after recordContact, contactCount = 1', ch.getContactCount(70), 1);
}

// ─────────────────────────────────────────────────────────────
// Cleanup
// ─────────────────────────────────────────────────────────────
try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}

console.log('');
console.log(`PASSED: ${passed}`);
console.log(`FAILED: ${failed}`);
if (failed > 0) {
  for (const f of failures) {
    console.log('  FAIL:', f.name);
    if ('error' in f) console.log('    error:', f.error);
    else console.log('    expected:', JSON.stringify(f.expected), 'actual:', JSON.stringify(f.actual));
  }
  process.exitCode = 1;
} else {
  console.log('all contact-history defensive tests passed.');
}

'use strict';

/**
 * Regression test for deleteCompaniesBatch (v2.0.16).
 *
 * Root cause of "370 件削除に 5 回必要" was deleteCompany を 1 件ずつループで
 * 呼んで N 回 workbook 全文 read+write していたこと。新 API は 1 回の
 * I/O で全削除する。
 *
 * 検証ポイント:
 *   - 大量削除 (例: 200 件) でも 1 回の I/O で完結
 *   - 存在しない no は notFound に分類
 *   - 一部存在 / 一部不在 の混在シナリオ
 *   - notFound には正規化前の value がそのまま入る (元の入力を返却)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bulk-delete-batch-'));
process.env.SALES_CLAW_USER_DATA_DIR = tmpRoot;
const dataDir = path.join(tmpRoot, 'data');
fs.mkdirSync(dataDir, { recursive: true });

function freshRequire() {
  Object.keys(require.cache).forEach((p) => {
    if (p.includes('dist-ts') && (
      p.includes('target-list') ||
      p.includes('data-paths') ||
      p.includes('settings-manager') ||
      p.includes('outreach-targets')
    )) delete require.cache[p];
  });
  return require('../dist-ts/src/target-list');
}

let passed = 0;
let failed = 0;
const failures = [];
function assertEq(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed += 1; return; }
  failed += 1;
  failures.push({ name, actual: a, expected: e });
}

// ─────────────────────────────────────────────────────────────
// 1. 200 件 import → 200 件削除を 1 回で完了
// ─────────────────────────────────────────────────────────────
{
  const tl = freshRequire();
  const lines = ['会社名,URL,フォームURL'];
  for (let i = 1; i <= 200; i++) lines.push(`Test${i}社,https://t${i}.com,https://t${i}.com/contact`);
  const csv = '﻿' + lines.join('\n');
  tl.importTargetList({ fileName: 'big.csv', buffer: Buffer.from(csv, 'utf8'), mode: 'replace' });

  const before = tl.readTargetList();
  assertEq('imported 200 companies', before.companies.length, 200);

  const allNos = before.companies.map((c) => c.no);
  const t0 = Date.now();
  const result = tl.deleteCompaniesBatch(allNos);
  const elapsed = Date.now() - t0;
  assertEq('batch delete ok=true', result.ok, true);
  assertEq('batch delete count=200', result.deleted.length, 200);
  assertEq('batch delete notFound=0', result.notFound.length, 0);

  const after = tl.readTargetList();
  assertEq('after batch: 0 companies left', after.ok ? after.companies.length : -1, 0);

  // パフォーマンス sanity: 200 件で 5 秒未満であるべき (旧実装は数十秒〜タイムアウト)
  if (elapsed > 5000) {
    console.warn(`WARN: 200-company batch delete took ${elapsed}ms (sanity expects <5000)`);
  } else {
    console.log(`OK: 200-company batch delete in ${elapsed}ms`);
  }
}

// ─────────────────────────────────────────────────────────────
// 2. 部分一致 (5 件中 3 件存在)
// ─────────────────────────────────────────────────────────────
{
  const tl = freshRequire();
  const csv = '﻿会社名,URL,フォームURL\nA社,https://a.com,\nB社,https://b.com,\nC社,https://c.com,';
  tl.importTargetList({ fileName: 'small.csv', buffer: Buffer.from(csv, 'utf8'), mode: 'replace' });

  const before = tl.readTargetList();
  assertEq('imported 3 companies', before.companies.length, 3);
  const existingNos = before.companies.map((c) => c.no);
  const targetNos = [...existingNos, 'NOT-EXIST-1', 'NOT-EXIST-2'];

  const result = tl.deleteCompaniesBatch(targetNos);
  assertEq('partial delete count=3', result.deleted.length, 3);
  assertEq('partial delete notFound=2', result.notFound.length, 2);
  assertEq('partial: notFound contains NOT-EXIST-1', result.notFound.includes('NOT-EXIST-1'), true);
  assertEq('partial: notFound contains NOT-EXIST-2', result.notFound.includes('NOT-EXIST-2'), true);

  const after = tl.readTargetList();
  assertEq('after partial: 0 companies left', after.ok ? after.companies.length : -1, 0);
}

// ─────────────────────────────────────────────────────────────
// 3. 空削除 (companyNos=[]) → エラーにならず ok:true、deleted=[]
// ─────────────────────────────────────────────────────────────
{
  const tl = freshRequire();
  const csv = '﻿会社名,URL,フォームURL\nA社,https://a.com,';
  tl.importTargetList({ fileName: 'one.csv', buffer: Buffer.from(csv, 'utf8'), mode: 'replace' });
  const result = tl.deleteCompaniesBatch([]);
  assertEq('empty batch: ok=true', result.ok, true);
  assertEq('empty batch: deleted=0', result.deleted.length, 0);
  const after = tl.readTargetList();
  assertEq('empty batch: 1 company still there', after.companies.length, 1);
}

try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}

console.log('');
console.log(`PASSED: ${passed}`);
console.log(`FAILED: ${failed}`);
if (failed > 0) {
  for (const f of failures) {
    console.log('  FAIL:', f.name);
    console.log('    expected:', f.expected);
    console.log('    actual:  ', f.actual);
  }
  process.exitCode = 1;
} else {
  console.log('all bulk-delete-batch tests passed.');
}

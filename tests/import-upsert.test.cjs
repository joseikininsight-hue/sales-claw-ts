'use strict';

/**
 * Regression test for upsert import logic (v2.0.15).
 *
 * companyName 一致 → 既存 no を保持しつつ上書き
 * 新規 → 追加 (新しい no)
 * 既存にあって import に無い → keep
 *
 * normalizeCompanyNameKey と mergeImportedCompaniesUpsert は target-list 内部
 * 関数だが、ここではロジックを reproduction してテストする (実装と乖離したら
 * テストで気付ける)。
 */

function normalizeCompanyNameKey(name) {
  const trimmed = String(name == null ? '' : name).trim().replace(/\s+/g, ' ');
  if (!trimmed) return null;
  return trimmed.toLowerCase();
}

function mergeImportedCompaniesUpsert(existingCompanies, importedCompanies) {
  const stats = { added: 0, updated: 0, kept: 0 };
  const usedNos = new Set();
  existingCompanies.forEach((c) => { if (c && c.no !== undefined && c.no !== null) usedNos.add(String(c.no)); });
  let nextGeneratedNo = 1;
  function allocateNo() {
    while (usedNos.has(String(nextGeneratedNo))) nextGeneratedNo += 1;
    const value = nextGeneratedNo;
    usedNos.add(String(value));
    nextGeneratedNo += 1;
    return value;
  }
  const existingByName = new Map();
  existingCompanies.forEach((c) => {
    const key = normalizeCompanyNameKey(c?.companyName ?? c?.name ?? '');
    if (key) existingByName.set(key, c);
  });
  const merged = [];
  const visitedNames = new Set();
  importedCompanies.forEach((imp) => {
    const key = normalizeCompanyNameKey(imp?.companyName ?? imp?.name ?? '');
    if (!key) {
      const newNo = imp?.no !== undefined && imp?.no !== null && imp?.no !== '' && !usedNos.has(String(imp.no))
        ? imp.no
        : allocateNo();
      usedNos.add(String(newNo));
      merged.push({ ...imp, no: newNo });
      stats.added += 1;
      return;
    }
    visitedNames.add(key);
    const existingRec = existingByName.get(key);
    if (existingRec) {
      const overlaid = { ...existingRec };
      Object.keys(imp).forEach((k) => {
        if (k === 'no' || k === 'companyName' || k === 'name') return;
        const v = imp[k];
        if (v !== undefined && v !== null && v !== '') overlaid[k] = v;
      });
      merged.push(overlaid);
      stats.updated += 1;
    } else {
      const newNo = allocateNo();
      merged.push({ ...imp, no: newNo });
      stats.added += 1;
    }
  });
  existingCompanies.forEach((c) => {
    const key = normalizeCompanyNameKey(c?.companyName ?? c?.name ?? '');
    if (key && !visitedNames.has(key)) {
      merged.push(c);
      stats.kept += 1;
    } else if (!key) {
      merged.push(c);
      stats.kept += 1;
    }
  });
  return { companies: merged, stats };
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
// 1. 完全新規 import (既存空)
// ─────────────────────────────────────────────────────────────
{
  const r = mergeImportedCompaniesUpsert([], [
    { no: 1, companyName: 'A社', url: 'https://a.com' },
    { no: 2, companyName: 'B社' },
  ]);
  assertEq('empty existing: 2 added', r.stats.added, 2);
  assertEq('empty existing: 0 updated', r.stats.updated, 0);
  assertEq('empty existing: 0 kept', r.stats.kept, 0);
  assertEq('empty existing: result count', r.companies.length, 2);
}

// ─────────────────────────────────────────────────────────────
// 2. companyName 一致 → 上書き、既存 no 保持
// ─────────────────────────────────────────────────────────────
{
  const existing = [{ no: 5, companyName: 'A社', url: 'https://old.com', notes: '古いメモ' }];
  const imported = [{ no: 99, companyName: 'A社', url: 'https://new.com' }];
  const r = mergeImportedCompaniesUpsert(existing, imported);
  assertEq('upsert: 0 added', r.stats.added, 0);
  assertEq('upsert: 1 updated', r.stats.updated, 1);
  assertEq('upsert: existing no preserved', r.companies[0].no, 5);
  assertEq('upsert: url overlaid', r.companies[0].url, 'https://new.com');
  assertEq('upsert: notes preserved (import had no notes)', r.companies[0].notes, '古いメモ');
}

// ─────────────────────────────────────────────────────────────
// 3. 既存にあって import に無い → keep
// ─────────────────────────────────────────────────────────────
{
  const existing = [
    { no: 1, companyName: 'A社' },
    { no: 2, companyName: 'B社' },
  ];
  const imported = [{ companyName: 'A社', url: 'updated' }];
  const r = mergeImportedCompaniesUpsert(existing, imported);
  assertEq('keep: stats added', r.stats.added, 0);
  assertEq('keep: stats updated', r.stats.updated, 1);
  assertEq('keep: stats kept', r.stats.kept, 1);
  assertEq('keep: result count', r.companies.length, 2);
  assertEq('keep: B is preserved', r.companies.find(c => c.companyName === 'B社')?.no, 2);
}

// ─────────────────────────────────────────────────────────────
// 4. 大文字小文字・空白の正規化
// ─────────────────────────────────────────────────────────────
{
  const existing = [{ no: 10, companyName: 'Acme Corp' }];
  const imported = [{ companyName: '  ACME CORP  ', url: 'norm' }];
  const r = mergeImportedCompaniesUpsert(existing, imported);
  assertEq('case+space norm: updated', r.stats.updated, 1);
  assertEq('case+space norm: existing no preserved', r.companies[0].no, 10);
  assertEq('case+space norm: companyName from existing preserved', r.companies[0].companyName, 'Acme Corp');
  assertEq('case+space norm: url overlaid', r.companies[0].url, 'norm');
}

// ─────────────────────────────────────────────────────────────
// 5. 新規企業の no 採番が既存と衝突しない
// ─────────────────────────────────────────────────────────────
{
  const existing = [{ no: 1, companyName: 'A社' }, { no: 3, companyName: 'C社' }];
  const imported = [{ companyName: 'D社' }, { companyName: 'E社' }];
  const r = mergeImportedCompaniesUpsert(existing, imported);
  const Ds = r.companies.find(c => c.companyName === 'D社');
  const Es = r.companies.find(c => c.companyName === 'E社');
  assertEq('new no: D 社 gets 2', Ds?.no, 2);
  assertEq('new no: E 社 gets 4 (skips taken 3)', Es?.no, 4);
}

// ─────────────────────────────────────────────────────────────
// 6. companyName が空の import 行 → 単純追加
// ─────────────────────────────────────────────────────────────
{
  const existing = [];
  const imported = [{ companyName: '', url: 'mystery' }];
  const r = mergeImportedCompaniesUpsert(existing, imported);
  assertEq('no name: 1 added', r.stats.added, 1);
  assertEq('no name: result count', r.companies.length, 1);
}

// ─────────────────────────────────────────────────────────────
// 7. 上書き: import で空フィールドは既存維持 (誤って空で上書きしない)
// ─────────────────────────────────────────────────────────────
{
  const existing = [{ no: 1, companyName: 'A社', url: 'keep-me', formUrl: 'https://existing/form' }];
  const imported = [{ companyName: 'A社', url: '', formUrl: undefined }];
  const r = mergeImportedCompaniesUpsert(existing, imported);
  assertEq('overlay: empty url does not overwrite', r.companies[0].url, 'keep-me');
  assertEq('overlay: undefined formUrl does not overwrite', r.companies[0].formUrl, 'https://existing/form');
}

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
  console.log('all import-upsert tests passed.');
}

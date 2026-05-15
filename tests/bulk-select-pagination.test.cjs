'use strict';

/**
 * Regression test for bulk-select pagination fix (v2.0.15).
 *
 * 旧バグ: 「全選択」が現在ページの行 (display !== 'none') だけを選んでいたため、
 * 100 社中 page1 の 20 件しか選ばれず、削除も 20 件しか走らなかった。
 *
 * 新仕様: pagination で hidden な行 (data-pgn-hidden="1") も「全選択」対象。
 * filter で hidden な行 (data-pgn-hidden 無し かつ display:none) は除外。
 *
 * jsdom が無いので、isCheckboxFilterEligible のロジックを reconstruction
 * して minimal な DOM stub でテスト。
 */

// dashboard.ts と同じ判定ロジック
function isCheckboxFilterEligible(checkbox) {
  const row = checkbox.closest('tr');
  if (!row) return false;
  if (checkbox.disabled) return false;
  if (row.dataset.pgnHidden === '1') return true;            // pagination は対象
  return row.style.display !== 'none';                        // filter で hidden は除外
}

let passed = 0;
let failed = 0;
const failures = [];

function assertEq(name, actual, expected) {
  if (actual === expected) { passed += 1; return; }
  failed += 1;
  failures.push({ name, actual, expected });
}

function makeRow({ display = '', pgnHidden = '0', disabled = false }) {
  const row = {
    dataset: { pgnHidden },
    style: { display },
  };
  const checkbox = {
    disabled,
    closest: () => row,
  };
  return { row, checkbox };
}

// ─────────────────────────────────────────────────────────────
// 1. 通常表示中 → 対象
// ─────────────────────────────────────────────────────────────
{
  const { checkbox } = makeRow({});
  assertEq('visible normal row: eligible', isCheckboxFilterEligible(checkbox), true);
}

// ─────────────────────────────────────────────────────────────
// 2. pagination で hidden → 対象 (旧バグはここで false を返していた)
// ─────────────────────────────────────────────────────────────
{
  const { checkbox } = makeRow({ display: 'none', pgnHidden: '1' });
  assertEq('pagination-hidden row: ELIGIBLE (was bug)', isCheckboxFilterEligible(checkbox), true);
}

// ─────────────────────────────────────────────────────────────
// 3. filter で hidden → 除外
// ─────────────────────────────────────────────────────────────
{
  const { checkbox } = makeRow({ display: 'none', pgnHidden: '0' });
  assertEq('filter-hidden row: not eligible', isCheckboxFilterEligible(checkbox), false);
}

// ─────────────────────────────────────────────────────────────
// 4. disabled checkbox → 除外
// ─────────────────────────────────────────────────────────────
{
  const { checkbox } = makeRow({ disabled: true });
  assertEq('disabled checkbox: not eligible', isCheckboxFilterEligible(checkbox), false);
}

// ─────────────────────────────────────────────────────────────
// 5. row が無い → 除外
// ─────────────────────────────────────────────────────────────
{
  const cb = { disabled: false, closest: () => null };
  assertEq('no row: not eligible', isCheckboxFilterEligible(cb), false);
}

// ─────────────────────────────────────────────────────────────
// 6. 100 社シナリオ: page1 visible 20 + page2-5 pagination-hidden 80
//    → 全 100 件が eligible
// ─────────────────────────────────────────────────────────────
{
  const checkboxes = [];
  for (let i = 0; i < 20; i++) checkboxes.push(makeRow({}).checkbox);
  for (let i = 0; i < 80; i++) checkboxes.push(makeRow({ display: 'none', pgnHidden: '1' }).checkbox);
  const eligible = checkboxes.filter(isCheckboxFilterEligible);
  assertEq('100 社シナリオ: 100 eligible (was 20 with bug)', eligible.length, 100);
}

// ─────────────────────────────────────────────────────────────
// 7. mixed: filter で 30 除外 + pagination で 50 hidden + visible 20
//    → 70 eligible (フィルタ通過後の全件)
// ─────────────────────────────────────────────────────────────
{
  const checkboxes = [];
  for (let i = 0; i < 20; i++) checkboxes.push(makeRow({}).checkbox);
  for (let i = 0; i < 50; i++) checkboxes.push(makeRow({ display: 'none', pgnHidden: '1' }).checkbox);
  for (let i = 0; i < 30; i++) checkboxes.push(makeRow({ display: 'none', pgnHidden: '0' }).checkbox);
  const eligible = checkboxes.filter(isCheckboxFilterEligible);
  assertEq('filter+pagination mixed: 70 eligible', eligible.length, 70);
}

console.log('');
console.log(`PASSED: ${passed}`);
console.log(`FAILED: ${failed}`);
if (failed > 0) {
  for (const f of failures) {
    console.log('  FAIL:', f.name);
    console.log('    expected:', JSON.stringify(f.expected), 'actual:', JSON.stringify(f.actual));
  }
  process.exitCode = 1;
} else {
  console.log('all bulk-select-pagination tests passed.');
}

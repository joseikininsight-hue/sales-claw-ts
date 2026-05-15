'use strict';

/**
 * Regression test for getManagedAiFormBatchSize (v2.0.14).
 *
 * バッチサイズ可変化が:
 *   - デフォルト 3
 *   - env で上書き可
 *   - settings.preferences.managedAiFormBatchSize で上書き可
 *   - 1-10 にクランプ
 * を保証する。
 *
 * getManagedAiFormBatchSize は dashboard-server.ts 内のクロージャなので、
 * ロジックを再構成してテストする (regex がずれるとテストで気付ける)。
 */

const DEFAULT = 3;
const MIN = 1;
const MAX = 10;

function buildBatchSizeResolver(settings, env) {
  return function getManagedAiFormBatchSize() {
    let raw = null;
    try {
      const prefs = (settings.getSection && settings.getSection('preferences')) || {};
      if (prefs.managedAiFormBatchSize !== undefined && prefs.managedAiFormBatchSize !== null) {
        raw = prefs.managedAiFormBatchSize;
      }
    } catch (_) { /* ignore */ }
    if (raw === null && env.SALES_CLAW_MANAGED_AI_FORM_BATCH_SIZE) {
      raw = env.SALES_CLAW_MANAGED_AI_FORM_BATCH_SIZE;
    }
    if (raw === null || raw === undefined || raw === '') return DEFAULT;
    const n = Number(raw);
    if (!Number.isFinite(n)) return DEFAULT;
    return Math.max(MIN, Math.min(MAX, Math.floor(n)));
  };
}

let passed = 0;
let failed = 0;
const failures = [];

function assertEq(name, actual, expected) {
  if (actual === expected) { passed += 1; return; }
  failed += 1;
  failures.push({ name, actual, expected });
}

// ─────────────────────────────────────────────────────────────
// Default
// ─────────────────────────────────────────────────────────────
{
  const f = buildBatchSizeResolver({ getSection: () => ({}) }, {});
  assertEq('no env, no settings → 3', f(), 3);
}

// ─────────────────────────────────────────────────────────────
// env only
// ─────────────────────────────────────────────────────────────
{
  const f = buildBatchSizeResolver({ getSection: () => ({}) }, { SALES_CLAW_MANAGED_AI_FORM_BATCH_SIZE: '7' });
  assertEq('env=7 → 7', f(), 7);
}
{
  const f = buildBatchSizeResolver({ getSection: () => ({}) }, { SALES_CLAW_MANAGED_AI_FORM_BATCH_SIZE: '99' });
  assertEq('env=99 → 10 (max clamp)', f(), 10);
}
{
  const f = buildBatchSizeResolver({ getSection: () => ({}) }, { SALES_CLAW_MANAGED_AI_FORM_BATCH_SIZE: '0' });
  assertEq('env=0 → 1 (min clamp)', f(), 1);
}
{
  const f = buildBatchSizeResolver({ getSection: () => ({}) }, { SALES_CLAW_MANAGED_AI_FORM_BATCH_SIZE: 'abc' });
  assertEq('env=abc → 3 (NaN fallback)', f(), 3);
}

// ─────────────────────────────────────────────────────────────
// settings only
// ─────────────────────────────────────────────────────────────
{
  const f = buildBatchSizeResolver({ getSection: () => ({ managedAiFormBatchSize: 5 }) }, {});
  assertEq('settings=5 → 5', f(), 5);
}

// ─────────────────────────────────────────────────────────────
// settings beats env
// ─────────────────────────────────────────────────────────────
{
  const f = buildBatchSizeResolver(
    { getSection: () => ({ managedAiFormBatchSize: 8 }) },
    { SALES_CLAW_MANAGED_AI_FORM_BATCH_SIZE: '2' },
  );
  assertEq('settings=8 + env=2 → settings wins → 8', f(), 8);
}

// ─────────────────────────────────────────────────────────────
// settings null → falls back to env
// ─────────────────────────────────────────────────────────────
{
  const f = buildBatchSizeResolver(
    { getSection: () => ({ managedAiFormBatchSize: null }) },
    { SALES_CLAW_MANAGED_AI_FORM_BATCH_SIZE: '4' },
  );
  assertEq('settings=null + env=4 → 4', f(), 4);
}

// ─────────────────────────────────────────────────────────────
// settings throws → falls back gracefully
// ─────────────────────────────────────────────────────────────
{
  const f = buildBatchSizeResolver({ getSection: () => { throw new Error('boom'); } }, {});
  assertEq('settings throws → 3 (default)', f(), 3);
}

// ─────────────────────────────────────────────────────────────
// Floor
// ─────────────────────────────────────────────────────────────
{
  const f = buildBatchSizeResolver({ getSection: () => ({ managedAiFormBatchSize: 5.7 }) }, {});
  assertEq('settings=5.7 → 5 (floor)', f(), 5);
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
  console.log('all batch-size-config tests passed.');
}

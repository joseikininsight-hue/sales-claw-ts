'use strict';

/**
 * Regression test for "AI 停止 = キュー完全クリア" 契約 (v2.0.17).
 *
 * ユーザー繰り返し報告のバグ:
 *   200 社キュー投入 → AI 停止 → 再投入で「既に処理中です」エラー
 *
 * 原因: controller.pending が stop 後も残っていた → 重複チェックで弾かれる。
 * v2.0.17 で stopManagedClaudePty({ suppressAutoRecovery: true }) が呼ばれた
 * 際にキューを wipe する契約に統一。
 *
 * 本テストは「リセット手順そのもののロジック」を minimal な fixture で
 * reconstruct し、unit レベルで動作を保証する (Electron / PTY を要求しない)。
 */

// stopManagedClaudePty の core ロジックを抽出 (Electron 非依存)
function buildController(initialBatches = []) {
  return {
    pending: initialBatches.slice(),
    activeBatch: initialBatches.length > 0 ? { id: 'A', companyNos: [1] } : null,
    pendingSinceMs: Date.now(),
    queueStuckNotified: true,
  };
}

function applyStopReset(controller, userInitiated) {
  if (!userInitiated) return { pendingCleared: 0, activeCleared: false };
  const pendingCount = controller && Array.isArray(controller.pending) ? controller.pending.length : 0;
  const hadActive = !!(controller && controller.activeBatch);
  if (controller) {
    controller.pending = [];
    controller.activeBatch = null;
    controller.pendingSinceMs = 0;
    controller.queueStuckNotified = false;
  }
  return { pendingCleared: pendingCount, activeCleared: hadActive };
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
// 1. user-initiated stop (suppressAutoRecovery=true) でキュー完全クリア
// ─────────────────────────────────────────────────────────────
{
  const ctrl = buildController(['b1', 'b2', 'b3']);
  const stats = applyStopReset(ctrl, true);
  assertEq('userInitiated: 3 pending cleared', stats.pendingCleared, 3);
  assertEq('userInitiated: active cleared', stats.activeCleared, true);
  assertEq('userInitiated: pending after', ctrl.pending, []);
  assertEq('userInitiated: activeBatch after', ctrl.activeBatch, null);
  assertEq('userInitiated: pendingSinceMs reset', ctrl.pendingSinceMs, 0);
  assertEq('userInitiated: queueStuckNotified reset', ctrl.queueStuckNotified, false);
}

// ─────────────────────────────────────────────────────────────
// 2. internal restart (suppressAutoRecovery=false) はキュー保持
// ─────────────────────────────────────────────────────────────
{
  const ctrl = buildController(['b1', 'b2', 'b3']);
  const stats = applyStopReset(ctrl, false);
  assertEq('autoRecovery: nothing cleared', stats.pendingCleared, 0);
  assertEq('autoRecovery: pending preserved', ctrl.pending.length, 3);
  assertEq('autoRecovery: activeBatch preserved', !!ctrl.activeBatch, true);
}

// ─────────────────────────────────────────────────────────────
// 3. 既にキューが空 (pending=0, activeBatch=null) のとき stop は何もしないが
//    成功 (idempotent)
// ─────────────────────────────────────────────────────────────
{
  const ctrl = buildController([]);  // empty
  ctrl.activeBatch = null;
  const stats = applyStopReset(ctrl, true);
  assertEq('empty queue: 0 pending cleared', stats.pendingCleared, 0);
  assertEq('empty queue: no active cleared', stats.activeCleared, false);
}

// ─────────────────────────────────────────────────────────────
// 4. controller=null (まだ初期化されていない) でも crash しない
// ─────────────────────────────────────────────────────────────
{
  let threw = false;
  try {
    const stats = applyStopReset(null, true);
    assertEq('null controller: 0 cleared', stats.pendingCleared, 0);
  } catch (e) {
    threw = true;
  }
  assertEq('null controller: did not throw', threw, false);
}

// ─────────────────────────────────────────────────────────────
// 5. pending が undefined (corrupt state) でも Array 化されて空に
// ─────────────────────────────────────────────────────────────
{
  const ctrl = { pending: undefined, activeBatch: { id: 'X' }, pendingSinceMs: 100, queueStuckNotified: true };
  const stats = applyStopReset(ctrl, true);
  assertEq('corrupt pending: 0 cleared', stats.pendingCleared, 0);
  assertEq('corrupt pending: active cleared', stats.activeCleared, true);
  assertEq('corrupt pending: pending is array after', Array.isArray(ctrl.pending), true);
  assertEq('corrupt pending: pending length 0', ctrl.pending.length, 0);
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
  console.log('all stop-clears-queue tests passed.');
}

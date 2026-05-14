'use strict';

/**
 * Unit tests for src/retry-helper.ts
 *
 * withRetry が:
 *   - 1 回目 success なら追加試行しない
 *   - N 回目で success すれば成功を返す
 *   - 全失敗なら最後の error を投げる
 *   - shouldRetry が false を返したら即終了
 *   - exponential back-off (jitter 込み) でも attempts 上限を守る
 */

const { withRetry } = require('../dist-ts/src/retry-helper');

let passed = 0;
let failed = 0;
const failures = [];

function assertEq(name, actual, expected) {
  if (actual === expected) { passed += 1; return; }
  failed += 1;
  failures.push({ name, actual, expected });
}
function assertOk(name, value) { assertEq(name, !!value, true); }

(async () => {
  // ─────────────────────────────────────────────────────────────
  // 1. 初回 success → 1 回しか呼ばれない
  // ─────────────────────────────────────────────────────────────
  {
    let calls = 0;
    const r = await withRetry(async () => { calls += 1; return 'ok'; }, { attempts: 3, initialDelayMs: 10 });
    assertEq('1st success returns value', r, 'ok');
    assertEq('1st success: called once', calls, 1);
  }

  // ─────────────────────────────────────────────────────────────
  // 2. 2 回目で成功 → calls=2
  // ─────────────────────────────────────────────────────────────
  {
    let calls = 0;
    const r = await withRetry(async () => {
      calls += 1;
      if (calls < 2) throw new Error('transient');
      return 'recovered';
    }, { attempts: 3, initialDelayMs: 10, maxDelayMs: 20 });
    assertEq('2nd attempt returns recovered', r, 'recovered');
    assertEq('2nd success: called twice', calls, 2);
  }

  // ─────────────────────────────────────────────────────────────
  // 3. 全部失敗 → 最後の error を throw
  // ─────────────────────────────────────────────────────────────
  {
    let calls = 0;
    let thrown = null;
    try {
      await withRetry(async () => {
        calls += 1;
        throw new Error(`fail-${calls}`);
      }, { attempts: 3, initialDelayMs: 5, maxDelayMs: 10 });
    } catch (e) {
      thrown = e;
    }
    assertOk('all-fail: threw error', thrown);
    assertEq('all-fail: called 3 times', calls, 3);
    assertEq('all-fail: last error wins', thrown && thrown.message, 'fail-3');
  }

  // ─────────────────────────────────────────────────────────────
  // 4. shouldRetry が false → 1 回で終了
  // ─────────────────────────────────────────────────────────────
  {
    let calls = 0;
    let thrown = null;
    try {
      await withRetry(async () => {
        calls += 1;
        const err = new Error('fatal');
        err.code = 'CLI_NOT_INSTALLED';
        throw err;
      }, {
        attempts: 5,
        initialDelayMs: 5,
        shouldRetry: (err) => err.code !== 'CLI_NOT_INSTALLED',
      });
    } catch (e) {
      thrown = e;
    }
    assertOk('shouldRetry=false: threw', thrown);
    assertEq('shouldRetry=false: called once', calls, 1);
  }

  // ─────────────────────────────────────────────────────────────
  // 5. onAttempt が各試行ごとに呼ばれる
  // ─────────────────────────────────────────────────────────────
  {
    const attempts = [];
    let calls = 0;
    try {
      await withRetry(async () => {
        calls += 1;
        throw new Error('boom');
      }, {
        attempts: 3,
        initialDelayMs: 5,
        onAttempt: (n, err) => attempts.push({ n, hasErr: !!err }),
      });
    } catch (_) { /* expected */ }
    // 初回: n=1, err=null. 失敗: n=1, err=Error. 2回目: n=2, err=null. 失敗: n=2 err=Error ...
    assertEq('onAttempt called 6 times (3 enter + 3 catch)', attempts.length, 6);
  }

  // ─────────────────────────────────────────────────────────────
  // 6. attempts=1 → retry なし
  // ─────────────────────────────────────────────────────────────
  {
    let calls = 0;
    try {
      await withRetry(async () => { calls += 1; throw new Error('x'); }, { attempts: 1, initialDelayMs: 5 });
    } catch (_) {}
    assertEq('attempts=1: called once', calls, 1);
  }

  // ─────────────────────────────────────────────────────────────
  // Output
  // ─────────────────────────────────────────────────────────────
  console.log('');
  console.log(`PASSED: ${passed}`);
  console.log(`FAILED: ${failed}`);
  if (failed > 0) {
    for (const f of failures) {
      console.log(`  FAIL: ${f.name}`);
      console.log(`    actual:   ${JSON.stringify(f.actual)}`);
      console.log(`    expected: ${JSON.stringify(f.expected)}`);
    }
    process.exitCode = 1;
  } else {
    console.log('all retry-helper tests passed.');
  }
})().catch((e) => {
  console.error('TEST RUNNER CRASHED:', e);
  process.exitCode = 1;
});

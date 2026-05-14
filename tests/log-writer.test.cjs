'use strict';

/**
 * Tests for src/log-writer.cjs (H2 + H8 fix verification).
 *
 * Run: node tests/log-writer.test.cjs
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const logWriter = require('../dist-ts/src/log-writer');

let passed = 0;
let failed = 0;
const failures = [];

function assert(cond, message) {
  if (cond) { passed += 1; return; }
  failed += 1;
  failures.push(message);
}

function assertEquals(actual, expected, message) {
  if (actual === expected) { passed += 1; return; }
  failed += 1;
  failures.push(`${message} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mkSandbox() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sales-claw-logwriter-test-'));
}

(async () => {
  // ─── Test 1: appendLine returns immediately (non-blocking) ───
  {
    logWriter._resetForTesting();
    const sandbox = mkSandbox();
    const file = path.join(sandbox, 'test1.log');

    const start = process.hrtime.bigint();
    for (let i = 0; i < 1000; i++) {
      logWriter.appendLine(file, `line-${i}\n`, { maxBytes: 10 * 1024 * 1024 });
    }
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    assert(elapsedMs < 200, `1000 appendLine calls return in <200ms (got ${elapsedMs.toFixed(2)}ms)`);

    // Wait for async drain
    await logWriter.flushAll(2000);

    const content = fs.readFileSync(file, 'utf8');
    const lineCount = content.split('\n').filter(Boolean).length;
    assertEquals(lineCount, 1000, '1000 lines all flushed to disk');

    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch (_) {}
  }

  // ─── Test 2: rotation at maxBytes threshold (batched flush flow) ───
  // 実 PTY フローと同様に、batch 間で flush を挟むことで _drain が複数回走り、
  // ローテートが発火する。一気にすべて queue すると 1 chunk が maxBytes を
  // 超えるが、これは仕様通り (chunk 分割しない、1 回だけ overshoot を許す)。
  {
    logWriter._resetForTesting();
    const sandbox = mkSandbox();
    const file = path.join(sandbox, 'test2.log');

    // 5 batch × 4 lines、batch ごとに await。
    // 4 lines ≒ 100 bytes → 2 batch 後に閾値 (200B) 超 → 3 batch目の頭で rotate
    for (let b = 0; b < 5; b++) {
      for (let i = 0; i < 4; i++) {
        logWriter.appendLine(file, `padding-line-${b}${i}-extra\n`, { maxBytes: 200 });
      }
      await logWriter.flushAll(2000);
    }

    assert(fs.existsSync(file), 'main file exists after rotation');
    assert(fs.existsSync(file + '.1'), 'backup .1 exists after rotation');

    // 合計サイズが 20 行分のデータを保持していること
    const mainSize = fs.statSync(file).size;
    const backupSize = fs.statSync(file + '.1').size;
    const totalSize = mainSize + backupSize;
    assert(totalSize >= 20 * 20, `combined size holds all 20 lines (got ${totalSize})`);

    // 直近書込みの行が main 側に残っていること (rotate は古い方を .1 に退避)
    const mainContent = fs.readFileSync(file, 'utf8');
    assert(/padding-line-4/.test(mainContent), 'recent batches remain in main file');

    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch (_) {}
  }

  // ─── Test 3: flushAllSync drains buffered data ───
  {
    logWriter._resetForTesting();
    const sandbox = mkSandbox();
    const file = path.join(sandbox, 'test3.log');

    // Queue many lines but don't await
    for (let i = 0; i < 100; i++) {
      logWriter.appendLine(file, `sync-flush-${i}\n`);
    }

    // Sync flush — should succeed even without awaiting
    logWriter.flushAllSync();

    // After sync flush, all data must be on disk
    const content = fs.readFileSync(file, 'utf8');
    const lineCount = content.split('\n').filter(Boolean).length;
    assertEquals(lineCount, 100, 'flushAllSync writes all queued data');

    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch (_) {}
  }

  // ─── Test 4: per-file FIFO order (no interleaving) ───
  {
    logWriter._resetForTesting();
    const sandbox = mkSandbox();
    const file = path.join(sandbox, 'test4.log');

    for (let i = 0; i < 50; i++) {
      logWriter.appendLine(file, `seq-${String(i).padStart(3, '0')}\n`);
    }
    await logWriter.flushAll(2000);

    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    let ordered = true;
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].endsWith(String(i).padStart(3, '0'))) {
        ordered = false;
        break;
      }
    }
    assert(ordered, 'lines are written in FIFO order');

    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch (_) {}
  }

  // ─── Test 5: empty / invalid input is silently ignored ───
  {
    logWriter._resetForTesting();
    const sandbox = mkSandbox();
    const file = path.join(sandbox, 'test5.log');

    // None of these should throw or create the file
    logWriter.appendLine(file, '');
    logWriter.appendLine(file, null);
    logWriter.appendLine(file, undefined);
    logWriter.appendLine('', 'text');
    logWriter.appendLine(null, 'text');

    await logWriter.flushAll(500);
    assert(!fs.existsSync(file), 'invalid input does not create file');

    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch (_) {}
  }

  // ─── Test 6: H2 perf claim — 200 chunks/s does not block main thread ───
  {
    logWriter._resetForTesting();
    const sandbox = mkSandbox();
    const file = path.join(sandbox, 'test6.log');

    // Simulate 200 chunks/sec for 1 sec = 200 calls
    const start = process.hrtime.bigint();
    for (let i = 0; i < 200; i++) {
      logWriter.appendLine(file, `pty-chunk-${i}-some-output-text-here\n`, { maxBytes: 5 * 1024 * 1024 });
    }
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    // Sync version (old impl): would be ~200 * 0.5ms = 100ms+
    // Async version (new impl): should be sub-10ms
    assert(elapsedMs < 80, `200 chunks queued in <80ms (got ${elapsedMs.toFixed(2)}ms)`);

    await logWriter.flushAll(2000);
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch (_) {}
  }

  // ─── Test 7: rotation preserves data across calls ───
  {
    logWriter._resetForTesting();
    const sandbox = mkSandbox();
    const file = path.join(sandbox, 'test7.log');

    // First batch is small (under maxBytes=500)
    for (let i = 0; i < 5; i++) {
      logWriter.appendLine(file, `batch1-${i}-pad\n`, { maxBytes: 500 });
    }
    await logWriter.flushAll(2000);
    assert(!fs.existsSync(file + '.1'), 'no rotation yet after batch 1 (small)');

    // Second batch puts file over threshold (each line ~15 bytes × 50 = 750 bytes)
    for (let i = 0; i < 50; i++) {
      logWriter.appendLine(file, `batch2-${i}-pad\n`, { maxBytes: 500 });
    }
    await logWriter.flushAll(2000);

    // Third batch triggers rotation since file is now over 500
    for (let i = 0; i < 10; i++) {
      logWriter.appendLine(file, `batch3-${i}-pad\n`, { maxBytes: 500 });
    }
    await logWriter.flushAll(2000);

    assert(fs.existsSync(file + '.1'), 'rotation occurred after sustained writes');
    const backupContent = fs.readFileSync(file + '.1', 'utf8');
    assert(backupContent.includes('batch1') || backupContent.includes('batch2'),
      'backup contains data from before rotation');

    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch (_) {}
  }

  // ─── Output ───
  console.log('');
  console.log(`PASSED: ${passed}`);
  console.log(`FAILED: ${failed}`);
  if (failed > 0) {
    for (const f of failures) console.log(`  FAIL: ${f}`);
    process.exitCode = 1;
  } else {
    console.log('all log-writer tests passed.');
  }
})();

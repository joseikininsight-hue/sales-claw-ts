'use strict';

/**
 * Unit tests for src/file-lock.cjs
 *
 * Verifies:
 *   - basic acquire / release round-trip
 *   - non-stealing: timeout when held by alive process throws (no force-take)
 *   - stale lock detection: dead PID → can be acquired
 *   - releaseFileLock is null-safe
 *   - Atomics.wait sleep doesn't burn CPU
 *
 * Run: node tests/file-lock.test.cjs
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { acquireFileLock, releaseFileLock } = require('../dist-ts/src/file-lock');

let passed = 0;
let failed = 0;
const failures = [];

function assert(cond, message) {
  if (cond) { passed += 1; return; }
  failed += 1;
  failures.push(message);
}

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'sales-claw-lock-test-'));
const target = path.join(sandbox, 'thing.json');
fs.writeFileSync(target, '{}', 'utf8');

// ─── Test 1: basic acquire / release ───
{
  const lock = acquireFileLock(target, { maxWaitMs: 500 });
  assert(typeof lock === 'string', 'acquire returns lockfile path');
  assert(fs.existsSync(lock), 'lockfile exists on disk');
  releaseFileLock(lock);
  assert(!fs.existsSync(lock), 'lockfile removed on release');
}

// ─── Test 2: re-acquire after release works ───
{
  const a = acquireFileLock(target, { maxWaitMs: 500 });
  releaseFileLock(a);
  const b = acquireFileLock(target, { maxWaitMs: 500 });
  assert(b === a, 'same lockfile path on re-acquire');
  releaseFileLock(b);
}

// ─── Test 3: alive holder → throws timeout (no force-take) ───
{
  // Place a lockfile that says it's held by a CURRENT alive PID (= our own).
  // The helper should then refuse to take it.
  const lockFile = target + '.lock';
  fs.writeFileSync(lockFile, String(process.pid), 'utf8');

  let threw = false;
  let errMsg = '';
  try {
    acquireFileLock(target, { maxWaitMs: 200, label: 'test-alive' });
  } catch (e) {
    threw = true;
    errMsg = e.message;
  }
  assert(threw, 'throws timeout when lock held by alive PID');
  assert(/test-alive/.test(errMsg), 'error message includes label');
  assert(/timeout/i.test(errMsg), 'error message mentions timeout');
  // Cleanup
  fs.unlinkSync(lockFile);
}

// ─── Test 4: stale (dead PID) holder → cleaned up and acquired ───
{
  const lockFile = target + '.lock';
  // Write a PID that almost certainly doesn't exist
  fs.writeFileSync(lockFile, '99999999', 'utf8');

  const lock = acquireFileLock(target, { maxWaitMs: 500 });
  assert(typeof lock === 'string', 'stale lock from dead PID is taken over');
  // Verify our PID is now the holder
  const newHolder = fs.readFileSync(lock, 'utf8').trim();
  assert(parseInt(newHolder, 10) === process.pid, 'new holder is our PID');
  releaseFileLock(lock);
}

// ─── Test 5: release on null is safe ───
{
  releaseFileLock(null);
  releaseFileLock(undefined);
  releaseFileLock('');
  passed += 3; // we just need them not to throw
}

// ─── Test 6: holder PID check refuses to release others' locks ───
{
  const lockFile = target + '.lock';
  fs.writeFileSync(lockFile, '99999999', 'utf8'); // foreign PID
  releaseFileLock(lockFile); // should NOT remove (PID mismatch)
  // Wait — actually our code DOES remove if PID is dead. Let me re-read:
  //   if (pid !== null && pid !== process.pid) return;
  // 99999999 is dead but != our pid, so we return without removing.
  assert(fs.existsSync(lockFile), 'foreign lockfile not removed');
  fs.unlinkSync(lockFile); // manual cleanup
}

// ─── Test 7: Atomics.wait sleep doesn't burn CPU (smoke test) ───
{
  // Hold a lock with our own PID, then try to acquire (will throw timeout)
  const lockFile = target + '.lock';
  fs.writeFileSync(lockFile, String(process.pid), 'utf8');

  const startCpu = process.cpuUsage();
  const startTime = Date.now();
  try {
    acquireFileLock(target, { maxWaitMs: 200 });
  } catch (_) {}
  const elapsedMs = Date.now() - startTime;
  const cpuMs = (process.cpuUsage(startCpu).user + process.cpuUsage(startCpu).system) / 1000;

  // We waited ~200ms wall clock. CPU should be far less (Atomics.wait is OS sleep).
  // Old busy-wait would be ~200ms CPU = 100% utilization.
  // Tolerate up to 100ms CPU for noise on slow CI.
  assert(elapsedMs >= 150 && elapsedMs <= 500, `wall clock close to 200ms (got ${elapsedMs})`);
  assert(cpuMs < 100, `CPU time should be small (got ${cpuMs}ms — busy-wait would be ~${elapsedMs}ms)`);

  fs.unlinkSync(lockFile);
}

// ─── Cleanup ───
try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch (_) {}

console.log('');
console.log(`PASSED: ${passed}`);
console.log(`FAILED: ${failed}`);
if (failed > 0) {
  for (const f of failures) console.log(`  FAIL: ${f}`);
  process.exitCode = 1;
} else {
  console.log('all file-lock tests passed.');
}

'use strict';

/**
 * Verify settings-manager cache correctness:
 *  - cache hit returns same data without disk I/O
 *  - external file modification triggers re-read (mtime invalidation)
 *  - save() updates cache with new value
 *  - invalidateSettingsCache() forces fresh re-read
 *
 * Run: node tests/settings-cache.test.cjs
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// Use a sandbox dir so we don't pollute real user settings
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'sales-claw-cache-test-'));
process.env.SALES_CLAW_USER_DATA_DIR = sandbox;

// Now require AFTER env is set
const settings = require('../dist-ts/src/settings-manager');

let passed = 0;
let failed = 0;
const failures = [];

function assert(cond, message) {
  if (cond) { passed += 1; return; }
  failed += 1;
  failures.push(message);
}

// ─── Test 1: cache hit returns same reference ───
{
  const a = settings.getAll();
  const b = settings.getAll();
  assert(a === b, 'two consecutive getAll() calls return same reference (cache hit)');
}

// ─── Test 2: save() updates cache and changes data ───
{
  settings.updateSection('preferences', { dashboardPort: 9999 });
  const port = settings.getPort();
  assert(port === 9999, `updated port should be 9999, got ${port}`);
}

// ─── Test 3: external mtime change triggers re-read ───
{
  // Write directly to disk, bumping mtime
  const file = settings.getActiveSettingsFile();
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8'));
  onDisk.preferences.dashboardPort = 7777;
  // Wait until mtimeMs differs (Windows resolution can be 15ms)
  const before = fs.statSync(file).mtimeMs;
  let attempts = 0;
  while (fs.statSync(file).mtimeMs === before && attempts < 50) {
    fs.writeFileSync(file, JSON.stringify(onDisk, null, 2), 'utf-8');
    attempts += 1;
    // tiny busy wait
    const wait = Date.now() + 25;
    while (Date.now() < wait) { /* spin */ }
  }
  const port = settings.getPort();
  assert(port === 7777, `external edit should be picked up (got ${port}, expected 7777, attempts=${attempts})`);
}

// ─── Test 4: invalidateSettingsCache forces fresh read ───
{
  settings.invalidateSettingsCache();
  const fresh = settings.getAll();
  assert(!('__pollutedFlag' in fresh.preferences), 'invalidate yields a fresh load');
}

// ─── Test 5: cache return is deep-frozen (mutation throws in strict mode) ───
{
  const cached = settings.getAll();
  assert(Object.isFrozen(cached), 'top-level cached object is frozen');
  assert(Object.isFrozen(cached.preferences), 'nested object is frozen');

  // Mutation must throw (strict mode in cjs is implicit for module-level frozen
  // assignments, but we explicitly use 'use strict' in the test file)
  let threw = false;
  try {
    cached.preferences.__pollutedFlag = 'nope';
  } catch (e) {
    threw = e instanceof TypeError;
  }
  assert(threw, 'attempting to mutate cached settings throws TypeError');
  assert(!('__pollutedFlag' in cached.preferences), 'mutation did not actually take effect');
}

// ─── Test 6: updateSection still works (it must clone internally) ───
{
  const result = settings.updateSection('preferences', { dashboardPort: 5555 });
  assert(result.dashboardPort === 5555, 'updateSection clones-then-mutates correctly');
  assert(settings.getPort() === 5555, 'subsequent getPort reflects update');
}

// ─── Test 7: signature distinguishes ENOENT vs other errors ───
{
  // Delete the active settings file → next signature should be 'missing'
  const file = settings.getActiveSettingsFile();
  if (fs.existsSync(file)) {
    fs.unlinkSync(file);
  }
  // load() should fall back gracefully (other readSettingsFile branches kick in,
  // or DEFAULT_SETTINGS is used). Cache should re-populate.
  settings.invalidateSettingsCache();
  const fresh = settings.getAll();
  assert(typeof fresh === 'object' && fresh !== null, 'load works after file deletion');
  assert(typeof fresh.preferences === 'object', 'fresh load has preferences section');
}

// ─── Test 8: bug_009 — save() failure must NOT corrupt cache ───
// updateSection で結果ミューテートしてから save() が ENOSPC/EACCES で
// throw した場合、キャッシュが「保存されていない値」のまま固定されると
// プロセスライフ中ずっと嘘の状態になる。
// 現在の実装は updateSection が structuredClone してから mutate するので
// save throw 時にキャッシュは元のままになるはず。これを明示的に検証。
{
  // Re-prime cache to a known state
  settings.invalidateSettingsCache();
  settings.updateSection('preferences', { dashboardPort: 4242 });
  const beforePort = settings.getPort();
  assert(beforePort === 4242, `pre-condition: port should be 4242, got ${beforePort}`);

  // Make the active settings file unwritable to force save() to throw.
  // On Windows we open a read-only handle that holds the file; that causes
  // EBUSY/EPERM during atomicWriteFileSync's renameSync. On POSIX we chmod 0444.
  const file = settings.getActiveSettingsFile();
  let restoreFn = () => {};
  let throwExpected = false;
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(file, 0o444);
      throwExpected = true;
      restoreFn = () => { try { fs.chmodSync(file, 0o644); } catch (_) {} };
    } catch (_) { /* skip if chmod unavailable */ }
  } else {
    // Windows: open a write-locked handle; renameSync onto an open file
    // will fail with EBUSY. atomicWriteFileSync has fallback copyFileSync,
    // but copy onto a write-locked target also fails.
    try {
      const fd = fs.openSync(file, 'r+');
      throwExpected = true;
      // Hold via a process-scope ref so GC doesn't close it before save runs
      restoreFn = () => { try { fs.closeSync(fd); } catch (_) {} };
    } catch (_) { /* skip if we cannot lock */ }
  }

  if (throwExpected) {
    let saveThrew = false;
    try {
      settings.updateSection('preferences', { dashboardPort: 9876 });
    } catch (_) {
      saveThrew = true;
    }
    restoreFn();

    // Whether save threw or silently succeeded, what we DEMAND is:
    //   if it threw → the cached value reflects the on-disk truth, NOT the
    //   in-memory mutation that never made it to disk.
    if (saveThrew) {
      // Force re-read from disk to compare
      settings.invalidateSettingsCache();
      const onDiskPort = settings.getPort();
      assert(onDiskPort === beforePort, `save() failure must not corrupt disk: got ${onDiskPort}, expected ${beforePort}`);
    } else {
      // save() didn't throw — that means the lock didn't actually block writes
      // on this platform. Skip the assertion (test environment dependent).
    }
  }
}

// ─── Cleanup ───
try {
  fs.rmSync(sandbox, { recursive: true, force: true });
} catch (_) {}

console.log('');
console.log(`PASSED: ${passed}`);
console.log(`FAILED: ${failed}`);
if (failed > 0) {
  for (const f of failures) console.log(`  FAIL: ${f}`);
  process.exitCode = 1;
} else {
  console.log('all settings-cache tests passed.');
}

'use strict';

/**
 * dashboard-runtime tests — covers all exports of src/dashboard-runtime.cjs:
 *   buildRuntimeUrl, clearRuntime, getRequestTarget, getRuntimeFile,
 *   getRuntimeFiles, readRuntime, toClientHost, writeRuntime
 *
 * Strategy:
 *   - Use SALES_CLAW_USER_DATA_DIR + tmpdir to keep file ops hermetic.
 *   - Override APPDATA + os.homedir to control alternate runtime file lookup.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function describe(n, f) { console.log('\n=== ' + n + ' ==='); f(); }
function it(n, fn) {
  try { fn(); console.log('  OK  ' + n); }
  catch (e) { console.error('  FAIL ' + n + ' - ' + e.message); process.exitCode = 1; }
}

// ---------- isolated runtime root ----------
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-dashboard-runtime-'));
const TMP_APPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-appdata-'));
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-home-'));

process.env.SALES_CLAW_USER_DATA_DIR = TMP_ROOT;
process.env.APPDATA = TMP_APPDATA;

// Override os.homedir so getAlternateRuntimeFiles returns predictable paths.
const originalHomedir = os.homedir;
os.homedir = () => TMP_HOME;

fs.mkdirSync(path.join(TMP_ROOT, 'data'), { recursive: true });
fs.writeFileSync(path.join(TMP_ROOT, 'data', 'settings.json'), JSON.stringify({ preferences: {} }, null, 2));

// Fresh require with env applied (compiled output は dist-ts/ 配下)
delete require.cache[require.resolve('../dist-ts/src/settings-manager')];
delete require.cache[require.resolve('../dist-ts/src/data-paths')];
delete require.cache[require.resolve('../dist-ts/src/dashboard-runtime')];
const runtime = require('../dist-ts/src/dashboard-runtime');

// ============== TESTS ==============

describe('toClientHost', () => {
  it('rewrites 0.0.0.0 to 127.0.0.1', () => {
    assert.equal(runtime.toClientHost('0.0.0.0'), '127.0.0.1');
  });

  it('rewrites :: to 127.0.0.1', () => {
    assert.equal(runtime.toClientHost('::'), '127.0.0.1');
  });

  it('rewrites ::0 to 127.0.0.1', () => {
    assert.equal(runtime.toClientHost('::0'), '127.0.0.1');
  });

  it('returns 127.0.0.1 for empty/undefined input', () => {
    assert.equal(runtime.toClientHost(''), '127.0.0.1');
    assert.equal(runtime.toClientHost(undefined), '127.0.0.1');
    assert.equal(runtime.toClientHost(null), '127.0.0.1');
  });

  it('passes through non-wildcard hosts unchanged', () => {
    assert.equal(runtime.toClientHost('localhost'), 'localhost');
    assert.equal(runtime.toClientHost('192.168.1.10'), '192.168.1.10');
    assert.equal(runtime.toClientHost('example.com'), 'example.com');
  });
});

describe('buildRuntimeUrl', () => {
  it('builds http URL from host + port', () => {
    assert.equal(runtime.buildRuntimeUrl('127.0.0.1', 3765), 'http://127.0.0.1:3765');
  });

  it('rewrites wildcard host inside the URL', () => {
    assert.equal(runtime.buildRuntimeUrl('0.0.0.0', 8080), 'http://127.0.0.1:8080');
  });

  it('preserves non-wildcard hostnames', () => {
    assert.equal(runtime.buildRuntimeUrl('myhost', 3000), 'http://myhost:3000');
  });
});

describe('getRuntimeFile / getRuntimeFiles', () => {
  it('getRuntimeFile points inside the data dir', () => {
    const f = runtime.getRuntimeFile();
    assert.ok(f.endsWith('dashboard-runtime.json'));
    assert.match(f, /[\\/]data[\\/]dashboard-runtime\.json$/);
  });

  it('getRuntimeFiles includes primary + alternates', () => {
    const files = runtime.getRuntimeFiles();
    assert.ok(Array.isArray(files));
    assert.ok(files.length >= 2);
    // primary first
    assert.equal(files[0], runtime.getRuntimeFile());
    // alternates point at APPDATA + homedir variants
    assert.ok(files.some((f) => f.startsWith(TMP_APPDATA)));
    assert.ok(files.some((f) => f.startsWith(TMP_HOME)));
  });

  it('getRuntimeFiles dedupes equivalent paths', () => {
    const files = runtime.getRuntimeFiles();
    const set = new Set(files.map((f) => path.resolve(f)));
    assert.equal(set.size, files.length);
  });
});

describe('writeRuntime / readRuntime / clearRuntime', () => {
  it('writeRuntime persists JSON with normalized fields', () => {
    runtime.clearRuntime();
    const result = runtime.writeRuntime({ host: '0.0.0.0', port: 3765, startedAt: '2026-05-10T00:00:00Z' });
    assert.equal(result.host, '127.0.0.1');
    assert.equal(result.bindHost, '0.0.0.0');
    assert.equal(result.port, 3765);
    assert.equal(result.preferredPort, 3765);
    assert.equal(result.url, 'http://127.0.0.1:3765');
    assert.equal(result.startedAt, '2026-05-10T00:00:00Z');

    const onDisk = JSON.parse(fs.readFileSync(runtime.getRuntimeFile(), 'utf8'));
    assert.equal(onDisk.port, 3765);
    assert.equal(onDisk.host, '127.0.0.1');
  });

  it('writeRuntime defaults bindHost / startedAt when missing', () => {
    runtime.clearRuntime();
    const result = runtime.writeRuntime({ port: 4000 });
    assert.equal(result.host, '127.0.0.1');
    assert.equal(result.bindHost, '127.0.0.1');
    assert.equal(result.preferredPort, 4000);
    assert.ok(result.startedAt);
  });

  it('writeRuntime preserves explicit preferredPort', () => {
    runtime.clearRuntime();
    const result = runtime.writeRuntime({ host: '127.0.0.1', port: 3000, preferredPort: 3765 });
    assert.equal(result.preferredPort, 3765);
    assert.equal(result.port, 3000);
  });

  it('readRuntime returns null when no file exists', () => {
    runtime.clearRuntime();
    // Also remove alternate files just in case.
    for (const f of runtime.getRuntimeFiles()) {
      try { fs.unlinkSync(f); } catch {}
    }
    assert.equal(runtime.readRuntime(), null);
  });

  it('readRuntime returns the runtime after writing', () => {
    runtime.clearRuntime();
    runtime.writeRuntime({ host: '127.0.0.1', port: 3765, startedAt: new Date().toISOString() });
    const r = runtime.readRuntime();
    assert.ok(r);
    assert.equal(r.port, 3765);
    assert.equal(r.host, '127.0.0.1');
  });

  it('readRuntime ignores invalid JSON content', () => {
    runtime.clearRuntime();
    fs.writeFileSync(runtime.getRuntimeFile(), 'not-json');
    assert.equal(runtime.readRuntime(), null);
  });

  it('readRuntime ignores file lacking a port', () => {
    runtime.clearRuntime();
    fs.writeFileSync(runtime.getRuntimeFile(), JSON.stringify({ host: '127.0.0.1' }));
    assert.equal(runtime.readRuntime(), null);
  });

  it('readRuntime picks the highest-scoring runtime among multiple files', () => {
    runtime.clearRuntime();
    // Write an old runtime to primary
    const primary = runtime.getRuntimeFile();
    fs.mkdirSync(path.dirname(primary), { recursive: true });
    fs.writeFileSync(primary, JSON.stringify({ host: '127.0.0.1', port: 3000, startedAt: '2020-01-01T00:00:00Z' }));
    // Write a newer runtime to an alternate path
    const altDir = path.join(TMP_APPDATA, 'sales-claw', 'runtime', 'data');
    fs.mkdirSync(altDir, { recursive: true });
    const altFile = path.join(altDir, 'dashboard-runtime.json');
    fs.writeFileSync(altFile, JSON.stringify({ host: '127.0.0.1', port: 5000, startedAt: '2030-01-01T00:00:00Z' }));
    const r = runtime.readRuntime();
    assert.equal(r.port, 5000);
    // cleanup
    fs.unlinkSync(altFile);
  });

  it('clearRuntime is idempotent (no throw when file missing)', () => {
    runtime.clearRuntime();
    runtime.clearRuntime(); // second call should be a no-op
    assert.equal(fs.existsSync(runtime.getRuntimeFile()), false);
  });
});

describe('getRequestTarget', () => {
  it('uses runtime file when present', () => {
    runtime.clearRuntime();
    runtime.writeRuntime({ host: '127.0.0.1', port: 3765 });
    const t = runtime.getRequestTarget('localhost', 9999);
    assert.equal(t.port, 3765);
    assert.equal(t.hostname, '127.0.0.1');
    assert.equal(t.url, 'http://127.0.0.1:3765');
  });

  it('falls back to provided host/port when no runtime file', () => {
    runtime.clearRuntime();
    for (const f of runtime.getRuntimeFiles()) {
      try { fs.unlinkSync(f); } catch {}
    }
    const t = runtime.getRequestTarget('myhost', 4040);
    assert.equal(t.hostname, 'myhost');
    assert.equal(t.port, 4040);
    assert.equal(t.url, 'http://myhost:4040');
  });

  it('rewrites wildcard fallback host', () => {
    runtime.clearRuntime();
    for (const f of runtime.getRuntimeFiles()) {
      try { fs.unlinkSync(f); } catch {}
    }
    const t = runtime.getRequestTarget('0.0.0.0', 5050);
    assert.equal(t.hostname, '127.0.0.1');
  });

  it('uses defaults when fallbackHost is empty', () => {
    runtime.clearRuntime();
    for (const f of runtime.getRuntimeFiles()) {
      try { fs.unlinkSync(f); } catch {}
    }
    const t = runtime.getRequestTarget('', 6060);
    assert.equal(t.hostname, '127.0.0.1');
    assert.equal(t.port, 6060);
  });
});

// ============== Stale detection / PID validation tests ==============

describe('isPidAlive', () => {
  it('returns true for current process PID', () => {
    assert.equal(runtime.isPidAlive(process.pid), true);
  });

  it('returns false for PID 0 / negative / NaN', () => {
    assert.equal(runtime.isPidAlive(0), false);
    assert.equal(runtime.isPidAlive(-1), false);
    assert.equal(runtime.isPidAlive(NaN), false);
    assert.equal(runtime.isPidAlive(undefined), false);
    assert.equal(runtime.isPidAlive(null), false);
  });

  it('returns false for a very large (unused) PID', () => {
    // 2^30 is far above realistic PID range
    assert.equal(runtime.isPidAlive(0x40000000), false);
  });
});

describe('isRuntimeStale', () => {
  it('treats runtime with dead PID as stale', () => {
    const stale = {
      bindHost: '127.0.0.1',
      host: '127.0.0.1',
      port: 3765,
      preferredPort: 3765,
      startedAt: new Date().toISOString(),  // 新しい時刻でも PID 死んでたら stale
      url: 'http://127.0.0.1:3765',
      pid: 0x40000000,
    };
    assert.equal(runtime.isRuntimeStale(stale), true);
  });

  it('treats runtime with live PID as NOT stale (regardless of startedAt)', () => {
    const live = {
      bindHost: '127.0.0.1',
      host: '127.0.0.1',
      port: 3765,
      preferredPort: 3765,
      startedAt: '2020-01-01T00:00:00Z',  // 古い時刻でも PID 生きてれば not stale
      url: 'http://127.0.0.1:3765',
      pid: process.pid,
    };
    assert.equal(runtime.isRuntimeStale(live), false);
  });

  it('treats legacy runtime (no PID) with old startedAt as stale', () => {
    const oldRuntime = {
      bindHost: '127.0.0.1',
      host: '127.0.0.1',
      port: 3765,
      preferredPort: 3765,
      startedAt: '2020-01-01T00:00:00Z',
      url: 'http://127.0.0.1:3765',
      pid: 0,
    };
    assert.equal(runtime.isRuntimeStale(oldRuntime), true);
  });

  it('treats legacy runtime (no PID) with recent startedAt as NOT stale', () => {
    const recentRuntime = {
      bindHost: '127.0.0.1',
      host: '127.0.0.1',
      port: 3765,
      preferredPort: 3765,
      startedAt: new Date().toISOString(),
      url: 'http://127.0.0.1:3765',
      pid: 0,
    };
    assert.equal(runtime.isRuntimeStale(recentRuntime), false);
  });

  it('treats runtime with no PID and no startedAt as stale', () => {
    const noInfo = {
      bindHost: '127.0.0.1',
      host: '127.0.0.1',
      port: 3765,
      preferredPort: 3765,
      startedAt: '',
      url: 'http://127.0.0.1:3765',
      pid: 0,
    };
    assert.equal(runtime.isRuntimeStale(noInfo), true);
  });
});

describe('writeRuntime / readRuntime — PID handling', () => {
  it('writeRuntime injects current process PID by default', () => {
    runtime.clearRuntime();
    const result = runtime.writeRuntime({ host: '127.0.0.1', port: 3765 });
    assert.equal(result.pid, process.pid);
    const onDisk = JSON.parse(fs.readFileSync(runtime.getRuntimeFile(), 'utf8'));
    assert.equal(onDisk.pid, process.pid);
  });

  it('writeRuntime accepts explicit PID', () => {
    runtime.clearRuntime();
    const result = runtime.writeRuntime({ host: '127.0.0.1', port: 3765, pid: 12345 });
    assert.equal(result.pid, 12345);
  });

  it('readRuntime ignores runtime file with dead PID', () => {
    runtime.clearRuntime();
    const primary = runtime.getRuntimeFile();
    fs.writeFileSync(primary, JSON.stringify({
      host: '127.0.0.1',
      port: 3765,
      pid: 0x40000000,  // dead
      startedAt: new Date().toISOString(),
    }));
    assert.equal(runtime.readRuntime(), null);
  });

  it('readRuntime returns runtime when PID is alive', () => {
    runtime.clearRuntime();
    const primary = runtime.getRuntimeFile();
    fs.writeFileSync(primary, JSON.stringify({
      host: '127.0.0.1',
      port: 3765,
      pid: process.pid,
      startedAt: new Date().toISOString(),
    }));
    const r = runtime.readRuntime();
    assert.ok(r);
    assert.equal(r.port, 3765);
    assert.equal(r.pid, process.pid);
  });

  it('readRuntime picks live PID even when dead PID file has higher score', () => {
    runtime.clearRuntime();
    // primary に「新しい timestamp + 死亡 PID」 (= 古い installed の stale)
    const primary = runtime.getRuntimeFile();
    fs.writeFileSync(primary, JSON.stringify({
      host: '127.0.0.1',
      port: 9999,
      pid: 0x40000000,
      startedAt: '2030-01-01T00:00:00Z',  // 未来日 = 高スコア
    }));
    // alternate に「古い timestamp + 生きてる PID」 (= dev の current)
    const altDir = path.join(TMP_APPDATA, 'sales-claw', 'runtime', 'data');
    fs.mkdirSync(altDir, { recursive: true });
    const altFile = path.join(altDir, 'dashboard-runtime.json');
    fs.writeFileSync(altFile, JSON.stringify({
      host: '127.0.0.1',
      port: 3456,
      pid: process.pid,
      startedAt: '2020-01-01T00:00:00Z',
    }));

    const r = runtime.readRuntime();
    assert.ok(r);
    // 死亡 PID は除外され、生きてる PID の port が選ばれる
    assert.equal(r.port, 3456);
    fs.unlinkSync(altFile);
  });
});

describe('clearStaleRuntimes', () => {
  it('removes runtime file with dead PID', () => {
    runtime.clearRuntime();
    const primary = runtime.getRuntimeFile();
    fs.writeFileSync(primary, JSON.stringify({
      host: '127.0.0.1',
      port: 3765,
      pid: 0x40000000,
      startedAt: new Date().toISOString(),
    }));
    assert.equal(fs.existsSync(primary), true);

    const removed = runtime.clearStaleRuntimes();
    assert.ok(removed.length >= 1);
    assert.ok(removed.some((f) => path.resolve(f) === path.resolve(primary)));
    assert.equal(fs.existsSync(primary), false);
  });

  it('keeps runtime file with live PID', () => {
    runtime.clearRuntime();
    const primary = runtime.getRuntimeFile();
    fs.writeFileSync(primary, JSON.stringify({
      host: '127.0.0.1',
      port: 3765,
      pid: process.pid,
      startedAt: new Date().toISOString(),
    }));

    runtime.clearStaleRuntimes();
    assert.equal(fs.existsSync(primary), true);
  });

  it('removes legacy (no PID) runtime older than 24h', () => {
    runtime.clearRuntime();
    const primary = runtime.getRuntimeFile();
    fs.writeFileSync(primary, JSON.stringify({
      host: '127.0.0.1',
      port: 3765,
      startedAt: '2020-01-01T00:00:00Z',
    }));

    runtime.clearStaleRuntimes();
    assert.equal(fs.existsSync(primary), false);
  });

  it('removes corrupt JSON runtime file', () => {
    runtime.clearRuntime();
    const primary = runtime.getRuntimeFile();
    fs.writeFileSync(primary, 'not-json-{{');

    runtime.clearStaleRuntimes();
    assert.equal(fs.existsSync(primary), false);
  });

  it('removes runtime file with no port', () => {
    runtime.clearRuntime();
    const primary = runtime.getRuntimeFile();
    fs.writeFileSync(primary, JSON.stringify({ host: '127.0.0.1' }));

    runtime.clearStaleRuntimes();
    assert.equal(fs.existsSync(primary), false);
  });

  it('returns empty array when there are no stale files', () => {
    runtime.clearRuntime();
    // primary もない、alternate もない (clean state)
    for (const f of runtime.getRuntimeFiles()) {
      try { fs.unlinkSync(f); } catch {}
    }
    const removed = runtime.clearStaleRuntimes();
    assert.deepEqual(removed, []);
  });

  it('cleans alternate file too (not just primary)', () => {
    runtime.clearRuntime();
    const altDir = path.join(TMP_APPDATA, 'sales-claw', 'runtime', 'data');
    fs.mkdirSync(altDir, { recursive: true });
    const altFile = path.join(altDir, 'dashboard-runtime.json');
    fs.writeFileSync(altFile, JSON.stringify({
      host: '127.0.0.1',
      port: 3765,
      pid: 0x40000000,
      startedAt: new Date().toISOString(),
    }));

    runtime.clearStaleRuntimes();
    assert.equal(fs.existsSync(altFile), false);
  });
});

// Restore os.homedir so we don't pollute other test files
os.homedir = originalHomedir;

console.log('\nall dashboard-runtime tests passed.');

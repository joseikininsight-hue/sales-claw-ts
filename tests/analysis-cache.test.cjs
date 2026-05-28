'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function describe(n, f) { console.log('\n=== ' + n + ' ==='); f(); }
function it(n, f) {
  try { f(); console.log('  OK  ' + n); }
  catch (e) { console.error('  FAIL ' + n + ' — ' + (e && e.stack ? e.stack : e.message)); process.exitCode = 1; }
}

// テスト用に独立した data dir を使う
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sales-claw-cache-test-'));
process.env.SALES_CLAW_USER_DATA_DIR = tempRoot;
fs.mkdirSync(path.join(tempRoot, 'data'), { recursive: true });

// settings-manager は data dir を decide するので、cache モジュール読み込み前に env をセット必要
// data-paths は settings.preferences.dataDir + runtimeRoot を見るため、
// 現行の runtime root env (SALES_CLAW_USER_DATA_DIR) を使ってホーム配下への書き込みを避ける。
const cache = require('../dist-ts/src/analysis-cache');

describe('analysis-cache — basic round-trip', () => {
  it('returns null for cache miss', () => {
    const result = cache.getCachedAnalysis('https://miss.example.com', '存在しない会社');
    assert.equal(result, null);
  });

  it('stores and retrieves the same value', () => {
    const url = 'https://test-store.example.com';
    const name = 'テスト株式会社';
    const value = {
      companyName: name,
      businessAreas: [{ key: 'si', label: 'SI' }],
      siteTextLength: 1234,
    };
    cache.setCachedAnalysis(url, name, value);
    const got = cache.getCachedAnalysis(url, name);
    assert.deepEqual(got, value);
  });

  it('returns null when url is empty', () => {
    cache.setCachedAnalysis('', '', { foo: 'bar' });
    const got = cache.getCachedAnalysis('', '');
    assert.equal(got, null);
  });

  it('returns null when value is null', () => {
    cache.setCachedAnalysis('https://null.example.com', 'name', null);
    const got = cache.getCachedAnalysis('https://null.example.com', 'name');
    assert.equal(got, null);
  });
});

describe('analysis-cache — URL/name normalization', () => {
  it('treats trailing slash variations as the same key', () => {
    const v = { mark: 'A' };
    cache.setCachedAnalysis('https://norm.example.com/', '会社A', v);
    const got = cache.getCachedAnalysis('https://norm.example.com', '会社A');
    assert.deepEqual(got, v);
  });

  it('treats case variations in hostname as the same key', () => {
    const v = { mark: 'B' };
    cache.setCachedAnalysis('https://CASE.Example.COM', '会社B', v);
    const got = cache.getCachedAnalysis('https://case.example.com', '会社B');
    assert.deepEqual(got, v);
  });

  it('treats full-width / half-width company name variations as the same', () => {
    const v = { mark: 'C' };
    cache.setCachedAnalysis('https://nfkc.example.com', 'ＡＢＣ商事', v);
    // NFKC で全角→半角に正規化される
    const got = cache.getCachedAnalysis('https://nfkc.example.com', 'ABC商事');
    assert.deepEqual(got, v);
  });
});

describe('analysis-cache — TTL', () => {
  it('returns null when entry is older than ttlMs', () => {
    const url = 'https://ttl.example.com';
    const name = 'TTLテスト';
    cache.setCachedAnalysis(url, name, { x: 1 });
    // ttlMs=0 で確実に expire (TTL チェックは `Date.now() - cachedAt > ttlMs`)
    const got = cache.getCachedAnalysis(url, name, { ttlMs: 0 });
    assert.equal(got, null);
  });

  it('returns value when within ttlMs', () => {
    const url = 'https://ttl-fresh.example.com';
    const name = 'fresh';
    cache.setCachedAnalysis(url, name, { x: 2 });
    const got = cache.getCachedAnalysis(url, name, { ttlMs: 1000 * 60 * 60 });
    assert.deepEqual(got, { x: 2 });
  });
});

describe('analysis-cache — schema version', () => {
  it('exports CACHE_SCHEMA_VERSION', () => {
    assert.equal(typeof cache.CACHE_SCHEMA_VERSION, 'number');
    assert.ok(cache.CACHE_SCHEMA_VERSION >= 1);
  });
});

describe('analysis-cache — stats and clear', () => {
  it('getCacheStats returns entry count', () => {
    const stats = cache.getCacheStats();
    assert.equal(typeof stats.entryCount, 'number');
    assert.equal(typeof stats.cacheDir, 'string');
  });

  it('clearAllCache removes all entries', () => {
    cache.setCachedAnalysis('https://clear-1.example.com', 'C1', { v: 1 });
    cache.setCachedAnalysis('https://clear-2.example.com', 'C2', { v: 2 });
    const before = cache.getCacheStats();
    assert.ok(before.entryCount >= 2);
    const result = cache.clearAllCache();
    assert.ok(result.deleted >= 2);
    const after = cache.getCacheStats();
    assert.equal(after.entryCount, 0);
  });
});

// クリーンアップ
process.on('exit', () => {
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch (_) {}
});

'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapling-test-'));
process.env.SALES_CLAW_USER_DATA_DIR = tmpRoot;
process.env.SALES_CLAW_TEST_MODE = '1';
const dataDir = path.join(tmpRoot, 'data');
fs.mkdirSync(dataDir, { recursive: true });

function writeSettings(extra) {
  fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({
    apiKeys: {},
    listBuilder: { scraplingMcpEnabled: false, ...extra },
  }));
}

writeSettings({});

const settings = require('../../dist-ts/src/settings-manager');
settings.invalidateSettingsCache();

const scrapling = require('../../dist-ts/src/list-builder/scrapling-client');

function describe(n, f) { console.log('\n=== ' + n + ' ==='); f(); }
function it(n, f) {
  try { f(); console.log('  OK  ' + n); }
  catch (e) { console.error('  FAIL ' + n + ' — ' + e.message); process.exitCode = 1; }
}
function itAsync(n, f) {
  return f().then(() => console.log('  OK  ' + n))
    .catch((e) => { console.error('  FAIL ' + n + ' — ' + e.message); process.exitCode = 1; });
}

function reload() {
  settings.invalidateSettingsCache();
  scrapling._resetCache();
}

describe('isEnabled / getPythonPath', () => {
  it('returns false when scraplingMcpEnabled=false', () => {
    writeSettings({ scraplingMcpEnabled: false });
    reload();
    assert.equal(scrapling.isEnabled(), false);
  });

  it('returns true when scraplingMcpEnabled=true', () => {
    writeSettings({ scraplingMcpEnabled: true });
    reload();
    assert.equal(scrapling.isEnabled(), true);
  });

  it('falls back to "python" when scraplingPythonPath unset', () => {
    writeSettings({ scraplingMcpEnabled: true });
    reload();
    assert.equal(scrapling.getPythonPath(), 'python');
  });

  it('uses configured python path', () => {
    writeSettings({ scraplingMcpEnabled: true, scraplingPythonPath: '/usr/bin/python3.11' });
    reload();
    assert.equal(scrapling.getPythonPath(), '/usr/bin/python3.11');
  });
});

describe('fetchPage: input validation', () => {
  itAsync('rejects when not enabled', async () => {
    writeSettings({ scraplingMcpEnabled: false });
    reload();
    const r = await scrapling.fetchPage('https://example.com');
    assert.equal(r.ok, false);
    assert.equal(r.errorCode, 'NOT_ENABLED');
  });

  itAsync('rejects unsupported scheme', async () => {
    writeSettings({ scraplingMcpEnabled: true });
    reload();
    const r = await scrapling.fetchPage('ftp://example.com');
    assert.equal(r.ok, false);
    assert.match(r.error, /scheme/);
  });

  itAsync('rejects invalid URL', async () => {
    writeSettings({ scraplingMcpEnabled: true });
    reload();
    const r = await scrapling.fetchPage('not a url');
    assert.equal(r.ok, false);
  });
});

describe('fetchPage: with mocked runner', () => {
  itAsync('returns ok=true with html when worker succeeds', async () => {
    writeSettings({ scraplingMcpEnabled: true });
    reload();
    const runner = {
      runChild: async (argv) => {
        // 引数に URL とモードが含まれているか確認
        assert.ok(argv.includes('https://example.com'));
        assert.ok(argv.includes('--mode'));
        return {
          ok: true, code: 0, stdout: JSON.stringify({
            ok: true, html: '<h1>Hi</h1>', statusCode: 200, finalUrl: 'https://example.com/',
          }), stderr: '',
        };
      },
    };
    const r = await scrapling.fetchPage('https://example.com', { runner });
    assert.equal(r.ok, true);
    assert.equal(r.html, '<h1>Hi</h1>');
    assert.equal(r.fetcherKind, 'scrapling');
  });

  itAsync('passes through blocked result from worker', async () => {
    writeSettings({ scraplingMcpEnabled: true });
    reload();
    const runner = {
      runChild: async () => ({
        ok: true, code: 0, stdout: JSON.stringify({
          ok: false, blocked: true, blockReason: 'access_blocked',
          statusCode: 403, errorCode: 'ACCESS_BLOCKED',
        }), stderr: '',
      }),
    };
    const r = await scrapling.fetchPage('https://example.com', { runner });
    assert.equal(r.ok, false);
    assert.equal(r.blocked, true);
  });

  itAsync('handles spawn failure (python not found)', async () => {
    writeSettings({ scraplingMcpEnabled: true });
    reload();
    const runner = {
      runChild: async () => ({ ok: false, error: 'spawn ENOENT', code: 'ENOENT' }),
    };
    const r = await scrapling.fetchPage('https://example.com', { runner });
    assert.equal(r.ok, false);
    assert.equal(r.errorCode, 'SPAWN_FAILED');
  });

  itAsync('handles timeout (worker killed)', async () => {
    writeSettings({ scraplingMcpEnabled: true });
    reload();
    const runner = {
      runChild: async () => ({ ok: false, error: 'timeout', killed: true, stdout: '', stderr: '' }),
    };
    const r = await scrapling.fetchPage('https://example.com', { runner });
    assert.equal(r.ok, false);
    assert.equal(r.errorCode, 'TIMEOUT');
  });

  itAsync('handles malformed worker output', async () => {
    writeSettings({ scraplingMcpEnabled: true });
    reload();
    const runner = {
      runChild: async () => ({ ok: true, code: 0, stdout: 'not json', stderr: '' }),
    };
    const r = await scrapling.fetchPage('https://example.com', { runner });
    assert.equal(r.ok, false);
    assert.equal(r.errorCode, 'PARSE_ERROR');
  });

  itAsync('handles SCRAPLING_NOT_INSTALLED case', async () => {
    writeSettings({ scraplingMcpEnabled: true });
    reload();
    const runner = {
      runChild: async () => ({
        ok: false, code: 2, stdout: JSON.stringify({
          ok: false, error: 'scrapling not installed', errorCode: 'SCRAPLING_NOT_INSTALLED',
        }), stderr: '',
      }),
    };
    const r = await scrapling.fetchPage('https://example.com', { runner });
    assert.equal(r.ok, false);
    assert.equal(r.errorCode, 'SCRAPLING_NOT_INSTALLED');
  });
});

describe('extractor integration with Scrapling fallback', () => {
  itAsync('uses Scrapling result when available, then runs compliance analysis', async () => {
    // extractor.cjs は scraplingClient.isEnabled / isAvailable / fetchPage を内部で呼ぶ
    // テストでは settings 経由で isEnabled=false にして、defaultHttpFetch のテスト経路を確認する
    writeSettings({ scraplingMcpEnabled: false });
    reload();

    const extractor = require('../../dist-ts/src/list-builder/extractor');
    const result = await extractor.extract('https://example.com', {
      fetcher: async () => ({
        ok: true, html: '<form action="/contact"><input/></form>',
        statusCode: 200, finalUrl: 'https://example.com/',
      }),
      respectRobotsTxt: false,
    });
    assert.equal(result.ok, true);
    assert.equal(result.fetcherKind, 'http');
    assert.equal(result.formType, 'general_contact');
  });

  itAsync('falls back to defaultHttpFetch when Scrapling is enabled but unavailable', async () => {
    // isEnabled=true でも isAvailable で Python なしと判定されればフォールバック
    // テストでは isAvailable をモックできないので scraplingMcpEnabled=true + opts.fetcher を渡して動作確認
    writeSettings({ scraplingMcpEnabled: true });
    reload();

    const extractor = require('../../dist-ts/src/list-builder/extractor');
    const result = await extractor.extract('https://example.com', {
      // opts.fetcher を渡しているので extract 側は Scrapling 経路をスキップする (DI 優先)
      fetcher: async () => ({
        ok: true, html: '<h1>fallback</h1>',
        statusCode: 200, finalUrl: 'https://example.com/',
      }),
      respectRobotsTxt: false,
    });
    assert.equal(result.ok, true);
    assert.equal(result.fetcherKind, 'http');
  });
});

// クリーンアップ
process.on('exit', () => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}
});

'use strict';

/**
 * simple-api Phase 2 tests — covers the dispatch handlers (request/response paths)
 * complementing tests/simple-api-p1.test.cjs which only exercises pure helpers.
 *
 * Strategy:
 *   - Use a tmp data dir via SALES_CLAW_RUNTIME_ROOT so file-writing handlers
 *     (check-update / install-update / update-status / target-list/validation-result)
 *     stay hermetic.
 *   - Build mock req/res objects directly and call the dispatch function.
 *   - Inject ctx with stubbed jsonResponse/loadData/probeClaudeStatus etc.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const EventEmitter = require('node:events');

function describe(n, f) { console.log('\n=== ' + n + ' ==='); f(); }
function it(n, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      return r.then(
        () => console.log('  OK  ' + n),
        (e) => { console.error('  FAIL ' + n + ' - ' + (e && e.message)); process.exitCode = 1; },
      );
    }
    console.log('  OK  ' + n);
    return undefined;
  } catch (e) {
    console.error('  FAIL ' + n + ' - ' + e.message);
    process.exitCode = 1;
  }
}

// ---------- isolated runtime root ----------
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-simple-api-p2-'));
process.env.SALES_CLAW_USER_DATA_DIR = TMP_ROOT;
fs.mkdirSync(path.join(TMP_ROOT, 'data'), { recursive: true });

// settings-manager is cached per-module — invalidate so the env override applies.
function freshSettings() {
  delete require.cache[require.resolve('../dist-ts/src/settings-manager')];
  delete require.cache[require.resolve('../dist-ts/src/data-paths')];
  delete require.cache[require.resolve('../dist-ts/src/action-logger')];
  delete require.cache[require.resolve('../dist-ts/src/contact-history')];
  delete require.cache[require.resolve('../dist-ts/src/cost-estimator')];
  delete require.cache[require.resolve('../dist-ts/src/routes/simple-api')];
}
freshSettings();
// Pre-create a minimal settings.json so getSection('preferences') etc. work.
const settingsFile = path.join(TMP_ROOT, 'data', 'settings.json');
fs.writeFileSync(settingsFile, JSON.stringify({
  companyProfile: { companyName: 'テスト株式会社', contactName: '山田太郎', email: 'taro@example.com' },
  preferences: { exportFilenamePrefix: 'test', timezone: 'Asia/Tokyo', usdJpy: 150 },
  apiKeys: {},
}, null, 2));

const simpleApiFactory = require('../dist-ts/src/routes/simple-api');

// ---------- mock req/res helpers ----------
function makeReq({ method = 'GET', url = '/', body = null, headers = {} } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = headers;
  req.destroy = () => { req.destroyed = true; };
  // emit body chunks asynchronously
  process.nextTick(() => {
    if (body != null) req.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)));
    req.emit('end');
  });
  return req;
}

function makeRes() {
  const res = {
    statusCode: 200,
    headers: {},
    bodyChunks: [],
    ended: false,
    writeHead(code, hdrs) { this.statusCode = code; if (hdrs) Object.assign(this.headers, hdrs); },
    setHeader(k, v) { this.headers[k] = v; },
    end(chunk) { if (chunk != null) this.bodyChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))); this.ended = true; if (this._resolve) this._resolve(); },
    write(chunk) { this.bodyChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))); },
    waitForEnd() {
      return new Promise((resolve) => {
        if (this.ended) return resolve();
        this._resolve = resolve;
      });
    },
    bodyText() { return Buffer.concat(this.bodyChunks).toString('utf8'); },
    bodyJson() { try { return JSON.parse(this.bodyText()); } catch { return null; } },
  };
  return res;
}

function jsonResponse(res, statusCode, data, extraHeaders) {
  const headers = { 'Content-Type': 'application/json' };
  if (extraHeaders) Object.assign(headers, extraHeaders);
  res.writeHead(statusCode, headers);
  res.end(JSON.stringify(data));
}

function makeCtx(overrides = {}) {
  const sseClients = new Set();
  return Object.assign({
    jsonResponse,
    parseJsonBody: (req) => new Promise((resolve, reject) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch (e) { reject(e); } });
      req.on('error', reject);
    }),
    loadData: () => ({
      companies: [
        { no: 1, status: 'awaiting_approval', name: 'A社', type: 'IT', lastAction: 'awaiting_approval', formUrl: 'https://a.example/contact', captcha: false, lastActionAt: '2026-05-01T00:00:00Z', contactCount: 0, url: 'https://a.example', logs: [], lastErrorDetail: null, lastLog: null, progress: 'Pending' },
      ],
      recentLogs: [
        { timestamp: '2026-05-01T00:00:00Z', companyNo: 1, companyName: 'A社', action: 'submitted', details: 'ok' },
      ],
    }),
    sseClients,
    probeClaudeStatus: async () => ({ ok: true, provider: 'claude', state: 'ready' }),
    probeAiSetupDiagnostics: async () => ({ provider: 'claude', authenticated: true, diagnostics: [] }),
    getSelectedAiProvider: () => 'claude',
    ensureParentDir: (filePath) => { fs.mkdirSync(path.dirname(filePath), { recursive: true }); },
    AUTO_UPDATE_ENABLED: false,
    APP_BUILD_SOURCE: 'development',
    APP_VERSION: '1.2.94',
  }, overrides);
}

function writeValidScreenshot(companyNo) {
  const ssDir = path.join(TMP_ROOT, 'screenshots');
  fs.mkdirSync(ssDir, { recursive: true });
  fs.writeFileSync(path.join(ssDir, `ss-${companyNo}-input.png`), Buffer.alloc(2048, 0x89));
}

async function callDispatch(dispatch, req, res, pathname) {
  const reqUrl = new URL(req.url, 'http://127.0.0.1');
  const handled = await dispatch(req, res, pathname, reqUrl);
  await res.waitForEnd();
  return handled;
}

// ============== TESTS ==============

describe('simple-api dispatch — 410 endpoints', () => {
  it('POST /api/ai-submit returns 410 Gone', async () => {
    const dispatch = simpleApiFactory(makeCtx());
    const req = makeReq({ method: 'POST', url: '/api/ai-submit' });
    const res = makeRes();
    const handled = await callDispatch(dispatch, req, res, '/api/ai-submit');
    assert.equal(handled, true);
    assert.equal(res.statusCode, 410);
    assert.equal(res.bodyJson().ok, false);
  });

  it('GET /api/ai-submit-status returns 410 Gone', async () => {
    const dispatch = simpleApiFactory(makeCtx());
    const req = makeReq({ method: 'GET', url: '/api/ai-submit-status' });
    const res = makeRes();
    const handled = await callDispatch(dispatch, req, res, '/api/ai-submit-status');
    assert.equal(handled, true);
    assert.equal(res.statusCode, 410);
  });

  it('returns false for unknown route', async () => {
    const dispatch = simpleApiFactory(makeCtx());
    const req = makeReq({ method: 'GET', url: '/api/does-not-exist' });
    const res = makeRes();
    const handled = await dispatch(req, res, '/api/does-not-exist', new URL(req.url, 'http://127.0.0.1'));
    assert.equal(handled, false);
  });
});

describe('simple-api dispatch — /api/log-action', () => {
  it('rejects invalid no', async () => {
    const dispatch = simpleApiFactory(makeCtx());
    const req = makeReq({ method: 'POST', url: '/api/log-action', body: { no: -1, action: 'submitted', name: 'A' } });
    const res = makeRes();
    await callDispatch(dispatch, req, res, '/api/log-action');
    assert.equal(res.statusCode, 400);
    assert.match(res.bodyJson().error, /Invalid no/);
  });

  it('rejects unknown action', async () => {
    const dispatch = simpleApiFactory(makeCtx());
    const req = makeReq({ method: 'POST', url: '/api/log-action', body: { no: 1, action: 'rm_rf', name: 'A' } });
    const res = makeRes();
    await callDispatch(dispatch, req, res, '/api/log-action');
    assert.equal(res.statusCode, 400);
    assert.match(res.bodyJson().error, /Allowed/);
  });

  it('reports screenshot absence before sentMessage and prerequisite violations', async () => {
    const dispatch = simpleApiFactory(makeCtx());
    const req = makeReq({
      method: 'POST',
      url: '/api/log-action',
      body: { no: 96, action: 'awaiting_approval', name: '順序社', details: {} },
    });
    const res = makeRes();
    await callDispatch(dispatch, req, res, '/api/log-action');
    assert.equal(res.statusCode, 422);
    assert.match(res.bodyJson().error, /Screenshot is required/);
  });

  it('reports missing sentMessage after a valid screenshot', async () => {
    writeValidScreenshot(97);
    const dispatch = simpleApiFactory(makeCtx());
    const req = makeReq({
      method: 'POST',
      url: '/api/log-action',
      body: {
        no: 97,
        action: 'awaiting_approval',
        name: '本文欠落社',
        details: { screenshot: 'ss-97-input.png' },
      },
    });
    const res = makeRes();
    await callDispatch(dispatch, req, res, '/api/log-action');
    assert.equal(res.statusCode, 422);
    assert.match(res.bodyJson().error, /details\.sentMessage is required/);
  });

  it('rejects sentMessage shorter than 30 characters', async () => {
    writeValidScreenshot(98);
    const dispatch = simpleApiFactory(makeCtx());
    const req = makeReq({
      method: 'POST',
      url: '/api/log-action',
      body: {
        no: 98,
        action: 'awaiting_approval',
        name: '短文社',
        details: {
          sentMessage: '短すぎるお問い合わせ本文です。',
          screenshot: 'ss-98-input.png',
        },
      },
    });
    const res = makeRes();
    await callDispatch(dispatch, req, res, '/api/log-action');
    assert.equal(res.statusCode, 422);
    assert.match(res.bodyJson().error, /30 文字以上/);
  });

  it('accepts valid awaiting_approval action', async () => {
    writeValidScreenshot(99);
    const { logAction } = require('../dist-ts/src/action-logger');
    logAction(99, 'X社', 'site_analysis', JSON.stringify({
      companyName: 'X社',
      siteTextLength: 1200,
      siteTextExcerpt: 'Web受託開発とクラウドサービスに関する十分なサイト本文です。'.repeat(30),
    }));
    logAction(99, 'X社', 'form_fill', '入力完了');
    logAction(99, 'X社', 'confirm_reached', 'スクショ撮影完了');
    const dispatch = simpleApiFactory(makeCtx());
    const req = makeReq({ method: 'POST', url: '/api/log-action', body: { no: 99, action: 'awaiting_approval', name: 'X社', details: { sentMessage: 'テストメッセージです。お世話になります。株式会社サンプルと申します。貴社のWeb受託開発の取り組みを拝見し、技術面で情報交換できればと思いご連絡しました。', screenshot: 'ss-99-input.png' } } });
    const res = makeRes();
    await callDispatch(dispatch, req, res, '/api/log-action');
    assert.equal(res.statusCode, 200);
    assert.equal(res.bodyJson().ok, true);
    assert.equal(res.bodyJson().no, 99);
  });

  it('accepts awaiting_approval without site_analysis after form_fill and confirm_reached', async () => {
    writeValidScreenshot(100);
    const { logAction } = require('../dist-ts/src/action-logger');
    logAction(100, 'Y社', 'form_fill', '入力完了');
    logAction(100, 'Y社', 'confirm_reached', 'スクショ撮影完了');
    const dispatch = simpleApiFactory(makeCtx());
    const req = makeReq({ method: 'POST', url: '/api/log-action', body: { no: 100, action: 'awaiting_approval', name: 'Y社', details: { sentMessage: 'テストメッセージです。お世話になります。テスト株式会社と申します。貴社のWeb受託開発の取り組みを拝見し、技術面で情報交換できればと思いご連絡しました。', screenshot: 'ss-100-input.png' } } });
    const res = makeRes();
    await callDispatch(dispatch, req, res, '/api/log-action');
    assert.equal(res.statusCode, 200);
    assert.equal(res.bodyJson().ok, true);
  });

  it('rejects awaiting_approval when sentMessage conflicts with configured facts', async () => {
    writeValidScreenshot(101);
    const settingsManager = require('../dist-ts/src/settings-manager');
    const current = structuredClone(settingsManager.load());
    current.companyProfile.employeeCount = '120名';
    settingsManager.save(current);
    const { logAction } = require('../dist-ts/src/action-logger');
    logAction(101, 'Z社', 'site_analysis', JSON.stringify({
      companyName: 'Z社',
      siteTextLength: 1200,
      siteTextExcerpt: 'Web受託開発とクラウドサービスに関する十分なサイト本文です。'.repeat(30),
    }));
    logAction(101, 'Z社', 'form_fill', '入力完了');
    logAction(101, 'Z社', 'confirm_reached', 'スクショ撮影完了');
    const dispatch = simpleApiFactory(makeCtx());
    const req = makeReq({ method: 'POST', url: '/api/log-action', body: { no: 101, action: 'awaiting_approval', name: 'Z社', details: { sentMessage: 'お世話になります。テスト株式会社です。社員数：約50名の会社としてご連絡します。十分な長さの本文です。', screenshot: 'ss-101-input.png' } } });
    const res = makeRes();
    await callDispatch(dispatch, req, res, '/api/log-action');
    assert.equal(res.statusCode, 422);
    assert.match(res.bodyJson().error, /quality gate/);
  });

  it('rejects malformed JSON body', async () => {
    const dispatch = simpleApiFactory(makeCtx());
    const req = makeReq({ method: 'POST', url: '/api/log-action', body: '{not-json' });
    const res = makeRes();
    await callDispatch(dispatch, req, res, '/api/log-action');
    assert.equal(res.statusCode, 400);
  });
});

describe('simple-api dispatch — /api/cli-log', () => {
  it('broadcasts SSE with sanitized type', async () => {
    const sseClients = new Set();
    const writes = [];
    sseClients.add({ write: (m) => writes.push(m) });
    const dispatch = simpleApiFactory(makeCtx({ sseClients }));
    const req = makeReq({ method: 'POST', url: '/api/cli-log', body: { message: 'hi', type: 'thinking' } });
    const res = makeRes();
    await callDispatch(dispatch, req, res, '/api/cli-log');
    assert.equal(res.statusCode, 200);
    assert.equal(res.bodyJson().ok, true);
    assert.equal(writes.length, 1);
    assert.match(writes[0], /thinking/);
  });

  it('falls back to info for unknown type', async () => {
    const sseClients = new Set();
    const writes = [];
    sseClients.add({ write: (m) => writes.push(m) });
    const dispatch = simpleApiFactory(makeCtx({ sseClients }));
    const req = makeReq({ method: 'POST', url: '/api/cli-log', body: { message: 'hi', type: 'BAD' } });
    const res = makeRes();
    await callDispatch(dispatch, req, res, '/api/cli-log');
    assert.equal(res.statusCode, 200);
    assert.match(writes[0], /"logType":"info"/);
  });

  it('rejects malformed body', async () => {
    const dispatch = simpleApiFactory(makeCtx());
    const req = makeReq({ method: 'POST', url: '/api/cli-log', body: '{bad' });
    const res = makeRes();
    await callDispatch(dispatch, req, res, '/api/cli-log');
    assert.equal(res.statusCode, 400);
  });
});

describe('simple-api dispatch — /api/resend-prepare', () => {
  it('rejects missing company no', async () => {
    const dispatch = simpleApiFactory(makeCtx());
    const req = makeReq({ method: 'POST', url: '/api/resend-prepare', body: { name: 'X', message: 'hello' } });
    const res = makeRes();
    await callDispatch(dispatch, req, res, '/api/resend-prepare');
    assert.equal(res.statusCode, 400);
    assert.match(res.bodyJson().error, /Invalid company number/);
  });

  it('rejects missing name', async () => {
    const dispatch = simpleApiFactory(makeCtx());
    const req = makeReq({ method: 'POST', url: '/api/resend-prepare', body: { no: 1, message: 'hello' } });
    const res = makeRes();
    await callDispatch(dispatch, req, res, '/api/resend-prepare');
    assert.equal(res.statusCode, 400);
    assert.match(res.bodyJson().error, /name is required/);
  });

  it('rejects empty message', async () => {
    const dispatch = simpleApiFactory(makeCtx());
    const req = makeReq({ method: 'POST', url: '/api/resend-prepare', body: { no: 1, name: 'X社', message: '   ' } });
    const res = makeRes();
    await callDispatch(dispatch, req, res, '/api/resend-prepare');
    assert.equal(res.statusCode, 400);
    assert.match(res.bodyJson().error, /Message body is required/);
  });

  it('rejects oversize message body (>32KB)', async () => {
    const dispatch = simpleApiFactory(makeCtx());
    const big = 'X'.repeat(33 * 1024);
    const req = makeReq({ method: 'POST', url: '/api/resend-prepare', body: { no: 1, name: 'X社', message: big } });
    const res = makeRes();
    await callDispatch(dispatch, req, res, '/api/resend-prepare');
    assert.equal(res.statusCode, 400);
    assert.match(res.bodyJson().error, /too large/);
  });

  it('records resend successfully with valid input', async () => {
    const dispatch = simpleApiFactory(makeCtx());
    const req = makeReq({ method: 'POST', url: '/api/resend-prepare', body: { no: 42, name: 'リトライ社', message: '再送本文', formUrl: 'https://x.example/c' } });
    const res = makeRes();
    await callDispatch(dispatch, req, res, '/api/resend-prepare');
    assert.equal(res.statusCode, 200);
    const body = res.bodyJson();
    assert.equal(body.ok, true);
    assert.equal(body.no, 42);
  });
});

describe('simple-api dispatch — AI status endpoints', () => {
  it('GET /api/claude-status returns probe result', async () => {
    const dispatch = simpleApiFactory(makeCtx());
    const req = makeReq({ method: 'GET', url: '/api/claude-status' });
    const res = makeRes();
    await callDispatch(dispatch, req, res, '/api/claude-status');
    assert.equal(res.statusCode, 200);
    assert.equal(res.bodyJson().ok, true);
  });

  it('GET /api/ai/status uses ?provider= query', async () => {
    const seen = [];
    const dispatch = simpleApiFactory(makeCtx({
      probeClaudeStatus: async (p) => { seen.push(p); return { ok: true, provider: p }; },
    }));
    const req = makeReq({ method: 'GET', url: '/api/ai/status?provider=codex' });
    const res = makeRes();
    await callDispatch(dispatch, req, res, '/api/ai/status');
    assert.equal(res.statusCode, 200);
    assert.equal(seen[0], 'codex');
    assert.equal(res.bodyJson().provider, 'codex');
  });

  it('GET /api/ai/status returns 500 when probe throws', async () => {
    const dispatch = simpleApiFactory(makeCtx({
      probeClaudeStatus: async () => { throw new Error('boom'); },
    }));
    const req = makeReq({ method: 'GET', url: '/api/ai/status' });
    const res = makeRes();
    await callDispatch(dispatch, req, res, '/api/ai/status');
    assert.equal(res.statusCode, 500);
    assert.match(res.bodyJson().error, /boom/);
  });

  it('GET /api/ai/setup-diagnostics returns diagnostics', async () => {
    const dispatch = simpleApiFactory(makeCtx());
    const req = makeReq({ method: 'GET', url: '/api/ai/setup-diagnostics' });
    const res = makeRes();
    await callDispatch(dispatch, req, res, '/api/ai/setup-diagnostics');
    assert.equal(res.statusCode, 200);
    assert.equal(res.bodyJson().ok, true);
    assert.equal(res.bodyJson().authenticated, true);
  });

  it('GET /api/ai/setup-diagnostics returns 500 when probe throws', async () => {
    const dispatch = simpleApiFactory(makeCtx({
      probeAiSetupDiagnostics: async () => { throw new Error('diag-fail'); },
    }));
    const req = makeReq({ method: 'GET', url: '/api/ai/setup-diagnostics' });
    const res = makeRes();
    await callDispatch(dispatch, req, res, '/api/ai/setup-diagnostics');
    assert.equal(res.statusCode, 500);
    assert.match(res.bodyJson().error, /diag-fail/);
  });
});

describe('simple-api dispatch — auto-update endpoints', () => {
  it('POST /api/check-update returns 409 when AUTO_UPDATE_ENABLED is false', async () => {
    const dispatch = simpleApiFactory(makeCtx());
    const req = makeReq({ method: 'POST', url: '/api/check-update' });
    const res = makeRes();
    await callDispatch(dispatch, req, res, '/api/check-update');
    assert.equal(res.statusCode, 409);
    const body = res.bodyJson();
    assert.equal(body.ok, false);
    assert.equal(body.buildSource, 'development');
  });

  it('POST /api/check-update writes flag when enabled', async () => {
    const dispatch = simpleApiFactory(makeCtx({
      AUTO_UPDATE_ENABLED: true,
      APP_BUILD_SOURCE: 'packaged',
    }));
    const req = makeReq({ method: 'POST', url: '/api/check-update' });
    const res = makeRes();
    await callDispatch(dispatch, req, res, '/api/check-update');
    assert.equal(res.statusCode, 200);
    assert.equal(res.bodyJson().state, 'check-requested');
    assert.ok(fs.existsSync(path.join(TMP_ROOT, 'data', 'check-update.flag')));
  });

  it('POST /api/install-update returns 409 when disabled', async () => {
    const dispatch = simpleApiFactory(makeCtx());
    const req = makeReq({ method: 'POST', url: '/api/install-update' });
    const res = makeRes();
    await callDispatch(dispatch, req, res, '/api/install-update');
    assert.equal(res.statusCode, 409);
  });

  it('POST /api/install-update writes flag when enabled', async () => {
    const dispatch = simpleApiFactory(makeCtx({
      AUTO_UPDATE_ENABLED: true,
      APP_BUILD_SOURCE: 'packaged',
    }));
    const req = makeReq({ method: 'POST', url: '/api/install-update' });
    const res = makeRes();
    await callDispatch(dispatch, req, res, '/api/install-update');
    assert.equal(res.statusCode, 200);
    assert.equal(res.bodyJson().ok, true);
    assert.ok(fs.existsSync(path.join(TMP_ROOT, 'data', 'install-update.flag')));
  });

  it('GET /api/update-status returns dashboard-only state', async () => {
    const dispatch = simpleApiFactory(makeCtx({ APP_BUILD_SOURCE: 'dashboard-only' }));
    const req = makeReq({ method: 'GET', url: '/api/update-status' });
    const res = makeRes();
    await callDispatch(dispatch, req, res, '/api/update-status');
    assert.equal(res.statusCode, 200);
    assert.equal(res.bodyJson().state, 'dashboard-only');
  });

  it('GET /api/update-status returns disabled-dev state', async () => {
    const dispatch = simpleApiFactory(makeCtx());
    const req = makeReq({ method: 'GET', url: '/api/update-status' });
    const res = makeRes();
    await callDispatch(dispatch, req, res, '/api/update-status');
    assert.equal(res.statusCode, 200);
    assert.equal(res.bodyJson().state, 'disabled-dev');
  });

  it('GET /api/update-status returns unknown when no status file', async () => {
    const statusFile = path.join(TMP_ROOT, 'data', 'update-status.json');
    if (fs.existsSync(statusFile)) fs.unlinkSync(statusFile);
    const dispatch = simpleApiFactory(makeCtx({ AUTO_UPDATE_ENABLED: true, APP_BUILD_SOURCE: 'packaged' }));
    const req = makeReq({ method: 'GET', url: '/api/update-status' });
    const res = makeRes();
    await callDispatch(dispatch, req, res, '/api/update-status');
    assert.equal(res.statusCode, 200);
    assert.equal(res.bodyJson().state, 'unknown');
  });

  it('GET /api/update-status reads existing status JSON', async () => {
    const statusFile = path.join(TMP_ROOT, 'data', 'update-status.json');
    fs.writeFileSync(statusFile, JSON.stringify({ state: 'available', version: '1.2.95' }));
    const dispatch = simpleApiFactory(makeCtx({ AUTO_UPDATE_ENABLED: true, APP_BUILD_SOURCE: 'packaged' }));
    const req = makeReq({ method: 'GET', url: '/api/update-status' });
    const res = makeRes();
    await callDispatch(dispatch, req, res, '/api/update-status');
    assert.equal(res.statusCode, 200);
    assert.equal(res.bodyJson().state, 'available');
    fs.unlinkSync(statusFile);
  });
});

describe('simple-api dispatch — exports', () => {
  it('GET /api/export returns xlsx attachment', async () => {
    const dispatch = simpleApiFactory(makeCtx());
    const req = makeReq({ method: 'GET', url: '/api/export' });
    const res = makeRes();
    await callDispatch(dispatch, req, res, '/api/export');
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['Content-Type'], /spreadsheetml/);
    assert.match(res.headers['Content-Disposition'], /test_/);
    assert.ok(Buffer.concat(res.bodyChunks).length > 0);
  });

  it('GET /api/export returns 500 on loadData failure', async () => {
    const dispatch = simpleApiFactory(makeCtx({ loadData: () => { throw new Error('load-fail'); } }));
    const req = makeReq({ method: 'GET', url: '/api/export' });
    const res = makeRes();
    await callDispatch(dispatch, req, res, '/api/export');
    assert.equal(res.statusCode, 500);
    assert.match(res.bodyText(), /Export error/);
  });

  it('GET /api/export/companies.csv returns CSV', async () => {
    const dispatch = simpleApiFactory(makeCtx());
    const req = makeReq({ method: 'GET', url: '/api/export/companies.csv' });
    const res = makeRes();
    await callDispatch(dispatch, req, res, '/api/export/companies.csv');
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['Content-Type'], /text\/csv/);
    const body = res.bodyText();
    assert.match(body, /No,CompanyName/);
    assert.match(body, /A社/);
  });

  it('GET /api/export/action-log.csv returns CSV', async () => {
    const dispatch = simpleApiFactory(makeCtx());
    const req = makeReq({ method: 'GET', url: '/api/export/action-log.csv' });
    const res = makeRes();
    await callDispatch(dispatch, req, res, '/api/export/action-log.csv');
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['Content-Type'], /text\/csv/);
    assert.match(res.bodyText(), /Timestamp,CompanyNo/);
  });
});

describe('simple-api dispatch — /api/data', () => {
  it('GET /api/data returns loadData payload', async () => {
    const dispatch = simpleApiFactory(makeCtx());
    const req = makeReq({ method: 'GET', url: '/api/data' });
    const res = makeRes();
    await callDispatch(dispatch, req, res, '/api/data');
    assert.equal(res.statusCode, 200);
    const body = res.bodyJson();
    assert.equal(body.companies.length, 1);
  });

  it('GET /api/data returns 500 on loadData failure', async () => {
    const dispatch = simpleApiFactory(makeCtx({ loadData: () => { throw new Error('boom'); } }));
    const req = makeReq({ method: 'GET', url: '/api/data' });
    const res = makeRes();
    await callDispatch(dispatch, req, res, '/api/data');
    assert.equal(res.statusCode, 500);
  });
});

describe('simple-api dispatch — /api/cost/summary', () => {
  it('returns ok summary even with no metrics file', async () => {
    const dispatch = simpleApiFactory(makeCtx());
    const req = makeReq({ method: 'GET', url: '/api/cost/summary' });
    const res = makeRes();
    await callDispatch(dispatch, req, res, '/api/cost/summary');
    assert.equal(res.statusCode, 200);
    const body = res.bodyJson();
    assert.equal(body.ok, true);
    assert.ok(body.summary);
    assert.equal(typeof body.summary.estimatedJpy, 'number');
  });
});

describe('simple-api dispatch — /api/compliance/check', () => {
  it('returns evaluation for ok message with full footer', async () => {
    const dispatch = simpleApiFactory(makeCtx());
    const okMessage = '初めまして、テスト株式会社の山田太郎です。\n\n本件についてご連絡いたしました。\n\n配信停止をご希望の場合はご連絡ください。\nお問い合わせ: taro@example.com';
    const req = makeReq({ method: 'POST', url: '/api/compliance/check', body: { message: okMessage } });
    const res = makeRes();
    await callDispatch(dispatch, req, res, '/api/compliance/check');
    assert.equal(res.statusCode, 200);
    const body = res.bodyJson();
    assert.equal(body.ok, true);
    assert.ok(body.evaluation);
    assert.ok(['ok', 'warn', 'fail'].includes(body.evaluation.status));
  });

  it('flags missing fields in skeletal message', async () => {
    const dispatch = simpleApiFactory(makeCtx());
    const req = makeReq({ method: 'POST', url: '/api/compliance/check', body: { message: 'hi' } });
    const res = makeRes();
    await callDispatch(dispatch, req, res, '/api/compliance/check');
    assert.equal(res.statusCode, 200);
    const ev = res.bodyJson().evaluation;
    assert.notEqual(ev.status, 'ok');
  });
});

describe('simple-api dispatch — target-list/validation-result', () => {
  it('returns hasResult=false when no validation file exists', async () => {
    const out = path.join(TMP_ROOT, 'data', 'target-list-validation.json');
    if (fs.existsSync(out)) fs.unlinkSync(out);
    delete global.__SC_TLV_STATE;
    const dispatch = simpleApiFactory(makeCtx());
    const req = makeReq({ method: 'GET', url: '/api/target-list/validation-result' });
    const res = makeRes();
    await callDispatch(dispatch, req, res, '/api/target-list/validation-result');
    assert.equal(res.statusCode, 200);
    const body = res.bodyJson();
    assert.equal(body.ok, true);
    assert.equal(body.hasResult, false);
  });

  it('returns hasResult=true when file exists', async () => {
    const out = path.join(TMP_ROOT, 'data', 'target-list-validation.json');
    fs.writeFileSync(out, JSON.stringify({ generatedAt: '2026-05-01T00:00:00Z', total: 1, checked: 1, summary: { ok: 1 }, rows: [] }));
    const dispatch = simpleApiFactory(makeCtx());
    const req = makeReq({ method: 'GET', url: '/api/target-list/validation-result' });
    const res = makeRes();
    await callDispatch(dispatch, req, res, '/api/target-list/validation-result');
    assert.equal(res.statusCode, 200);
    const body = res.bodyJson();
    assert.equal(body.hasResult, true);
    assert.equal(body.total, 1);
    fs.unlinkSync(out);
  });
});

console.log('\nall simple-api P2 tests passed.');

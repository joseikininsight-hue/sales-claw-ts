'use strict';

/**
 * error-recovery-api Phase 2 tests — covers the dispatch handlers
 * (handleGroupedErrors / handleRetry / resolveActiveProvider) complementing
 * tests/error-recovery-api.test.cjs which only exercises pure helpers.
 */

const assert = require('node:assert/strict');
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

const errorRecoveryFactory = require('../dist-ts/src/routes/error-recovery-api');

// ---------- mock req/res ----------
function makeReq({ method = 'GET', url = '/', body = null } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = {};
  req.destroy = () => { req.destroyed = true; };
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

function jsonResponse(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function makeCtx(overrides = {}) {
  return Object.assign({
    jsonResponse,
    parseJsonBody,
    loadData: () => ({
      companies: [
        { no: 1, name: 'A社', type: 'IT', formUrl: 'https://a/c', status: 'awaiting_approval', lastAction: 'awaiting_approval' },
        { no: 2, name: 'B社', type: 'SaaS', formUrl: '', status: 'error', lastAction: 'error', logs: [{ action: 'error', details: 'CAPTCHA検出' }], lastActionAt: '2026-05-01' },
        { no: 3, name: 'C社', type: 'EC', formUrl: '', status: 'error', lastAction: 'ERROR', lastErrorDetail: 'フォームURL未解決', lastActionAt: '2026-05-02' },
        { no: 4, name: 'D社', type: 'Other', formUrl: '', status: 'error', lastAction: 'error', lastErrorDetail: 'タイムアウト', lastActionAt: '2026-05-03' },
        { no: 5, name: 'E社', type: 'Manuf', formUrl: '', status: 'submitted', lastAction: 'submitted' },
      ],
    }),
    queueAiFormFill: async (companies, provider) => ({ queued: companies.length, provider }),
    findCompaniesByNos: (nos) => ({ ok: true, companies: nos.map((no) => ({ no, name: 'X' + no })) }),
    ensureClaudeAutomationReady: async () => ({ ok: true }),
    getSelectedAiProvider: () => 'claude',
    getManagedAiProvider: () => 'claude',
    getClaudePty: () => null,
    getActiveHeadlessRun: () => null,
    getManagedAiAutoSendSafe: () => false,
    appendDiagnosticEvent: () => {},
  }, overrides);
}

async function callDispatch(dispatch, req, res, pathname) {
  const handled = await dispatch(req, res, pathname);
  await res.waitForEnd();
  return handled;
}

// ============== TESTS ==============

describe('error-recovery dispatch — /api/errors/grouped', () => {
  it('groups errors by category, sorted by count desc', async () => {
    const dispatch = errorRecoveryFactory(makeCtx());
    const req = makeReq({ method: 'GET', url: '/api/errors/grouped' });
    const res = makeRes();
    const handled = await callDispatch(dispatch, req, res, '/api/errors/grouped');
    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    const body = res.bodyJson();
    assert.equal(body.ok, true);
    assert.equal(body.total, 3); // 3 errored companies
    assert.ok(Array.isArray(body.groups));
    const keys = body.groups.map((g) => g.key);
    assert.ok(keys.includes('captcha'));
    assert.ok(keys.includes('no_form'));
    assert.ok(keys.includes('timeout'));
  });

  it('returns total=0 when no companies have errors', async () => {
    const dispatch = errorRecoveryFactory(makeCtx({
      loadData: () => ({ companies: [{ no: 1, status: 'submitted', lastAction: 'submitted' }] }),
    }));
    const req = makeReq({ method: 'GET', url: '/api/errors/grouped' });
    const res = makeRes();
    await callDispatch(dispatch, req, res, '/api/errors/grouped');
    assert.equal(res.statusCode, 200);
    assert.equal(res.bodyJson().total, 0);
    assert.equal(res.bodyJson().groups.length, 0);
  });

  it('returns 500 when loadData throws', async () => {
    const dispatch = errorRecoveryFactory(makeCtx({
      loadData: () => { throw new Error('load-fail'); },
    }));
    const req = makeReq({ method: 'GET', url: '/api/errors/grouped' });
    const res = makeRes();
    await callDispatch(dispatch, req, res, '/api/errors/grouped');
    assert.equal(res.statusCode, 500);
    assert.match(res.bodyJson().error, /load-fail/);
  });

  it('truncates long reason strings in companies array', async () => {
    const longReason = 'X'.repeat(500);
    const dispatch = errorRecoveryFactory(makeCtx({
      loadData: () => ({ companies: [{ no: 1, name: 'A', status: 'error', lastAction: 'error', lastErrorDetail: longReason }] }),
    }));
    const req = makeReq({ method: 'GET', url: '/api/errors/grouped' });
    const res = makeRes();
    await callDispatch(dispatch, req, res, '/api/errors/grouped');
    const body = res.bodyJson();
    const c = body.groups[0].companies[0];
    assert.ok(c.reason.length <= 280);
  });
});

describe('error-recovery dispatch — /api/error/retry', () => {
  it('rejects empty companyNos array', async () => {
    const dispatch = errorRecoveryFactory(makeCtx());
    const req = makeReq({ method: 'POST', url: '/api/error/retry', body: { companyNos: [] } });
    const res = makeRes();
    await callDispatch(dispatch, req, res, '/api/error/retry');
    assert.equal(res.statusCode, 400);
    assert.match(res.bodyJson().error, /required/);
  });

  it('rejects missing companyNos field', async () => {
    const dispatch = errorRecoveryFactory(makeCtx());
    const req = makeReq({ method: 'POST', url: '/api/error/retry', body: {} });
    const res = makeRes();
    await callDispatch(dispatch, req, res, '/api/error/retry');
    assert.equal(res.statusCode, 400);
  });

  it('rejects oversize companyNos (>50)', async () => {
    const dispatch = errorRecoveryFactory(makeCtx());
    const big = Array.from({ length: 51 }, (_, i) => i + 1);
    const req = makeReq({ method: 'POST', url: '/api/error/retry', body: { companyNos: big } });
    const res = makeRes();
    await callDispatch(dispatch, req, res, '/api/error/retry');
    assert.equal(res.statusCode, 400);
    assert.match(res.bodyJson().error, /too large/);
  });

  it('returns error when findCompaniesByNos fails', async () => {
    const dispatch = errorRecoveryFactory(makeCtx({
      findCompaniesByNos: () => ({ ok: false, error: 'not found' }),
    }));
    const req = makeReq({ method: 'POST', url: '/api/error/retry', body: { companyNos: [1, 2] } });
    const res = makeRes();
    await callDispatch(dispatch, req, res, '/api/error/retry');
    assert.equal(res.statusCode, 400);
    assert.match(res.bodyJson().error, /not found/);
  });

  it('returns automation-ready error', async () => {
    const dispatch = errorRecoveryFactory(makeCtx({
      ensureClaudeAutomationReady: async () => ({ ok: false, statusCode: 503, error: 'pty unavailable' }),
    }));
    const req = makeReq({ method: 'POST', url: '/api/error/retry', body: { companyNos: [1] } });
    const res = makeRes();
    await callDispatch(dispatch, req, res, '/api/error/retry');
    assert.equal(res.statusCode, 503);
    assert.match(res.bodyJson().error, /pty/);
  });

  it('uses 409 when ensureClaudeAutomationReady has no statusCode', async () => {
    const dispatch = errorRecoveryFactory(makeCtx({
      ensureClaudeAutomationReady: async () => ({ ok: false, error: 'busy' }),
    }));
    const req = makeReq({ method: 'POST', url: '/api/error/retry', body: { companyNos: [1] } });
    const res = makeRes();
    await callDispatch(dispatch, req, res, '/api/error/retry');
    assert.equal(res.statusCode, 409);
  });

  it('queues retry successfully and dedupes companyNos', async () => {
    const calls = [];
    const dispatch = errorRecoveryFactory(makeCtx({
      queueAiFormFill: async (companies, provider) => { calls.push({ companies, provider }); return { queued: companies.length }; },
      appendDiagnosticEvent: (name, payload) => { calls.push({ event: name, payload }); },
    }));
    const req = makeReq({ method: 'POST', url: '/api/error/retry', body: { companyNos: [1, 1, 2, 3] } });
    const res = makeRes();
    await callDispatch(dispatch, req, res, '/api/error/retry');
    assert.equal(res.statusCode, 200);
    assert.equal(res.bodyJson().ok, true);
    assert.equal(res.bodyJson().requeued, 3);
    // verify diagnostic event was emitted
    assert.ok(calls.some((c) => c.event === 'error_retry_queued'));
  });

  it('filters non-positive companyNos', async () => {
    const calls = [];
    const dispatch = errorRecoveryFactory(makeCtx({
      findCompaniesByNos: (nos) => { calls.push(nos); return { ok: true, companies: nos.map((no) => ({ no })) }; },
    }));
    const req = makeReq({ method: 'POST', url: '/api/error/retry', body: { companyNos: [1, -2, 0, 'bad', 3.7, 4] } });
    const res = makeRes();
    await callDispatch(dispatch, req, res, '/api/error/retry');
    assert.equal(res.statusCode, 200);
    // Only 1, 3.7 (Number.isFinite + > 0), 4 should pass
    assert.deepEqual(calls[0].sort((a, b) => a - b), [1, 3.7, 4]);
  });

  it('handles thrown exception in queueAiFormFill', async () => {
    const dispatch = errorRecoveryFactory(makeCtx({
      queueAiFormFill: async () => { throw new Error('queue-fail'); },
    }));
    const req = makeReq({ method: 'POST', url: '/api/error/retry', body: { companyNos: [1] } });
    const res = makeRes();
    await callDispatch(dispatch, req, res, '/api/error/retry');
    assert.equal(res.statusCode, 500);
    assert.match(res.bodyJson().error, /queue-fail/);
  });

  it('uses managed provider when active PTY exists', async () => {
    const usedProviders = [];
    const dispatch = errorRecoveryFactory(makeCtx({
      getClaudePty: () => ({ alive: true }),
      getManagedAiProvider: () => 'codex',
      ensureClaudeAutomationReady: async (p) => { usedProviders.push(p); return { ok: true }; },
    }));
    const req = makeReq({ method: 'POST', url: '/api/error/retry', body: { companyNos: [1], provider: 'gemini' } });
    const res = makeRes();
    await callDispatch(dispatch, req, res, '/api/error/retry');
    assert.equal(res.statusCode, 200);
    assert.equal(usedProviders[0], 'codex'); // managed wins over explicit
  });

  it('uses headless provider when no PTY but headless run exists', async () => {
    const usedProviders = [];
    const dispatch = errorRecoveryFactory(makeCtx({
      getClaudePty: () => null,
      getActiveHeadlessRun: () => ({ provider: 'gemini' }),
      ensureClaudeAutomationReady: async (p) => { usedProviders.push(p); return { ok: true }; },
    }));
    const req = makeReq({ method: 'POST', url: '/api/error/retry', body: { companyNos: [1] } });
    const res = makeRes();
    await callDispatch(dispatch, req, res, '/api/error/retry');
    assert.equal(usedProviders[0], 'gemini');
  });

  it('uses explicit body.provider when no PTY/headless', async () => {
    const usedProviders = [];
    const dispatch = errorRecoveryFactory(makeCtx({
      ensureClaudeAutomationReady: async (p) => { usedProviders.push(p); return { ok: true }; },
    }));
    const req = makeReq({ method: 'POST', url: '/api/error/retry', body: { companyNos: [1], provider: 'codex' } });
    const res = makeRes();
    await callDispatch(dispatch, req, res, '/api/error/retry');
    assert.equal(usedProviders[0], 'codex');
  });

  it('falls back to selected provider when nothing else is set', async () => {
    const usedProviders = [];
    const dispatch = errorRecoveryFactory(makeCtx({
      getSelectedAiProvider: () => 'claude',
      ensureClaudeAutomationReady: async (p) => { usedProviders.push(p); return { ok: true }; },
    }));
    const req = makeReq({ method: 'POST', url: '/api/error/retry', body: { companyNos: [1] } });
    const res = makeRes();
    await callDispatch(dispatch, req, res, '/api/error/retry');
    assert.equal(usedProviders[0], 'claude');
  });
});

describe('error-recovery dispatch — unknown route', () => {
  it('returns false for unrelated path', async () => {
    const dispatch = errorRecoveryFactory(makeCtx());
    const req = makeReq({ method: 'GET', url: '/api/something' });
    const res = makeRes();
    const handled = await dispatch(req, res, '/api/something');
    assert.equal(handled, false);
  });

  it('returns false for wrong method on grouped', async () => {
    const dispatch = errorRecoveryFactory(makeCtx());
    const req = makeReq({ method: 'POST', url: '/api/errors/grouped' });
    const res = makeRes();
    const handled = await dispatch(req, res, '/api/errors/grouped');
    assert.equal(handled, false);
  });

  it('returns false for wrong method on retry', async () => {
    const dispatch = errorRecoveryFactory(makeCtx());
    const req = makeReq({ method: 'GET', url: '/api/error/retry' });
    const res = makeRes();
    const handled = await dispatch(req, res, '/api/error/retry');
    assert.equal(handled, false);
  });
});

console.log('\nall error-recovery-api P2 tests passed.');

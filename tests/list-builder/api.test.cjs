'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'list-builder-api-test-'));
process.env.SALES_CLAW_USER_DATA_DIR = tmpRoot;
process.env.SALES_CLAW_TEST_MODE = '1';

const dataDir = path.join(tmpRoot, 'data');
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({
  apiKeys: { houjinBangou: 'k1', gBizInfo: '', edinet: '' },
}));

const settings = require('../../dist-ts/src/settings-manager');
settings.invalidateSettingsCache();

const createListBuilderRoutes = require('../../dist-ts/src/routes/list-builder-api');
const runManager = require('../../dist-ts/src/list-builder/run-manager');

function describe(n, f) { console.log('\n=== ' + n + ' ==='); f(); }
function it(n, f) {
  try { f(); console.log('  OK  ' + n); }
  catch (e) { console.error('  FAIL ' + n + ' — ' + e.message); process.exitCode = 1; }
}
function itAsync(n, f) {
  return f().then(() => console.log('  OK  ' + n))
    .catch((e) => { console.error('  FAIL ' + n + ' — ' + e.message); process.exitCode = 1; });
}

// テスト用 res / req のスタブ
function makeRes() {
  const res = {
    statusCode: null,
    headers: {},
    body: null,
    headersSent: false,
    writes: [],
    ended: false,
    writeHead(code, headers) { this.statusCode = code; Object.assign(this.headers, headers || {}); this.headersSent = true; },
    write(chunk) { this.writes.push(chunk); },
    end(chunk) { if (chunk) this.writes.push(chunk); this.ended = true; },
  };
  return res;
}
function makeReq(method, body) {
  const req = {
    method,
    headers: {},
    on: () => {},
    body,
  };
  return req;
}

const ctx = {
  jsonResponse: (res, status, body) => {
    res.statusCode = status;
    res.body = body;
    res.ended = true;
    res.headers['Content-Type'] = 'application/json';
  },
  parseJsonBody: async (req) => req.body || {},
  appendCompany: (data) => ({ ok: true, no: 1, ...data }),
  readTargetList: () => ({ ok: true, companies: [] }),
};

const dispatch = createListBuilderRoutes(ctx);

// ============================================================
// validateRunInput
// ============================================================
describe('validateRunInput', () => {
  it('rejects missing body', () => {
    const r = createListBuilderRoutes.validateRunInput(null);
    assert.equal(r.ok, false);
  });

  it('rejects invalid mode', () => {
    const r = createListBuilderRoutes.validateRunInput({ mode: 'foo', payload: {} });
    assert.equal(r.ok, false);
  });

  it('rejects URL mode without urls array', () => {
    const r = createListBuilderRoutes.validateRunInput({ mode: 'url', payload: {} });
    assert.equal(r.ok, false);
  });

  it('rejects URL mode with too many URLs', () => {
    const urls = Array(15).fill('https://x.com');
    const r = createListBuilderRoutes.validateRunInput({ mode: 'url', payload: { urls } });
    assert.equal(r.ok, false);
    assert.match(r.error, /max 10/);
  });

  it('accepts valid URL mode', () => {
    const r = createListBuilderRoutes.validateRunInput({
      mode: 'url', payload: { urls: ['https://x.com', 'https://y.com'] },
    });
    assert.equal(r.ok, true);
  });

  it('rejects NLQ mode with empty query', () => {
    const r = createListBuilderRoutes.validateRunInput({ mode: 'nlq', payload: { query: '' } });
    assert.equal(r.ok, false);
  });

  it('rejects NLQ mode with too long query', () => {
    const r = createListBuilderRoutes.validateRunInput({
      mode: 'nlq', payload: { query: 'a'.repeat(600) },
    });
    assert.equal(r.ok, false);
  });

  it('rejects category mode with invalid limit', () => {
    const r1 = createListBuilderRoutes.validateRunInput({
      mode: 'category', payload: { limit: 1000 },
    });
    assert.equal(r1.ok, false);
    const r2 = createListBuilderRoutes.validateRunInput({
      mode: 'category', payload: { limit: 0 },
    });
    assert.equal(r2.ok, false);
  });

  it('accepts valid category mode', () => {
    const r = createListBuilderRoutes.validateRunInput({
      mode: 'category', payload: { industries: ['SaaS'], limit: 50 },
    });
    assert.equal(r.ok, true);
  });
});

// ============================================================
// dispatch routes
// ============================================================
describe('dispatch: returns false for unmatched paths', () => {
  itAsync('returns false for /api/other', async () => {
    const res = makeRes();
    const req = makeReq('GET');
    const handled = await dispatch(req, res, '/api/other');
    assert.equal(handled, false);
  });
});

describe('POST /api/list-builder/run', () => {
  itAsync('rejects invalid input with 400', async () => {
    const res = makeRes();
    const req = makeReq('POST', { mode: 'invalid', payload: {} });
    const handled = await dispatch(req, res, '/api/list-builder/run');
    assert.equal(handled, true);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.ok, false);
  });

  itAsync('creates run and returns runId', async () => {
    const res = makeRes();
    const req = makeReq('POST', {
      mode: 'url',
      payload: { urls: ['https://x.com'] },
    });
    const handled = await dispatch(req, res, '/api/list-builder/run');
    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.match(res.body.runId, /^run_/);
    assert.equal(res.body.status, 'queued');
    assert.ok(res.body.estimated);
  });
});

describe('GET /api/list-builder/api-key-status', () => {
  itAsync('returns boolean status without leaking values', async () => {
    const res = makeRes();
    const req = makeReq('GET');
    const handled = await dispatch(req, res, '/api/list-builder/api-key-status');
    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.apiKeys.houjinBangou, true);
    assert.equal(res.body.apiKeys.gBizInfo, false);
    // 値そのものは含まれない
    assert.ok(!JSON.stringify(res.body).includes('k1'));
  });
});

describe('GET /api/list-builder/runs', () => {
  itAsync('lists runs (initially empty or with previous runs)', async () => {
    const res = makeRes();
    const req = makeReq('GET');
    const params = new URLSearchParams();
    const handled = await dispatch(req, res, '/api/list-builder/runs', params);
    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.ok(Array.isArray(res.body.runs));
  });
});

describe('GET /api/list-builder/runs/:runId', () => {
  itAsync('returns 404 for non-existent run', async () => {
    const res = makeRes();
    const req = makeReq('GET');
    const handled = await dispatch(req, res, '/api/list-builder/runs/run_nonexistent_123');
    assert.equal(handled, true);
    assert.equal(res.statusCode, 404);
  });

  itAsync('returns run with candidates', async () => {
    const r = runManager.createRun({ mode: 'url', payload: {} });
    runManager.saveCandidates(r.runId, [{ companyName: 'A', url: 'https://a.com' }]);

    const res = makeRes();
    const req = makeReq('GET');
    const handled = await dispatch(req, res, `/api/list-builder/runs/${r.runId}`);
    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.candidates.length, 1);
  });

  itAsync('sanitizes candidate internals before returning run details', async () => {
    const r = runManager.createRun({ mode: 'url', payload: {} });
    runManager.saveCandidates(r.runId, [{
      companyName: 'A',
      url: 'https://a.com',
      html: '<html>secret body</html>',
      dedupeMatchedAgainst: {
        source: 'targets',
        companyName: 'Existing A',
        url: 'https://a.com',
        notes: 'private memo must not leak',
      },
    }]);

    const res = makeRes();
    const req = makeReq('GET');
    await dispatch(req, res, `/api/list-builder/runs/${r.runId}`);
    const text = JSON.stringify(res.body);
    assert.equal(res.statusCode, 200);
    assert.equal(text.includes('secret body'), false);
    assert.equal(text.includes('private memo'), false);
    assert.equal(res.body.candidates[0].dedupeMatchedAgainst.companyName, 'Existing A');
  });
});

describe('POST /api/list-builder/runs/:runId/cancel', () => {
  itAsync('cancels existing run', async () => {
    const r = runManager.createRun({ mode: 'url', payload: {} });
    const res = makeRes();
    const req = makeReq('POST');
    const handled = await dispatch(req, res, `/api/list-builder/runs/${r.runId}/cancel`);
    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.equal(runManager.isCancelled(r.runId), true);
  });
});

describe('DELETE /api/list-builder/runs/:runId', () => {
  itAsync('deletes a run', async () => {
    const r = runManager.createRun({ mode: 'url', payload: {} });
    const res = makeRes();
    const req = makeReq('DELETE');
    const handled = await dispatch(req, res, `/api/list-builder/runs/${r.runId}`);
    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.equal(runManager.getRun(r.runId), null);
  });
});

describe('POST /api/list-builder/commit', () => {
  itAsync('rejects without runId or recordIds', async () => {
    const res = makeRes();
    const req = makeReq('POST', {});
    const handled = await dispatch(req, res, '/api/list-builder/commit');
    assert.equal(handled, true);
    assert.equal(res.statusCode, 400);
  });

  itAsync('rejects empty recordIds (no implicit "commit all")', async () => {
    const r = runManager.createRun({ mode: 'url', payload: {} });
    runManager.saveCandidates(r.runId, [{ id: 'c1', companyName: 'A', url: 'https://a.com' }]);
    const res = makeRes();
    const req = makeReq('POST', { runId: r.runId, recordIds: [] });
    const handled = await dispatch(req, res, '/api/list-builder/commit');
    assert.equal(handled, true);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /must not be empty/);
  });

  itAsync('commits selected unique candidates', async () => {
    const r = runManager.createRun({ mode: 'url', payload: {} });
    runManager.saveCandidates(r.runId, [
      { id: 'c1', companyName: 'A', url: 'https://a.com', dedupeDecision: 'unique' },
      { id: 'c2', companyName: 'B', url: 'https://b.com', dedupeDecision: 'duplicate', dedupeMatchedAgainst: { source: 'targets' } },
      { id: 'c3', companyName: 'C', url: 'https://c.com', dedupeDecision: 'unique' },
    ]);

    const res = makeRes();
    const req = makeReq('POST', { runId: r.runId, recordIds: ['c1', 'c3'] });
    const handled = await dispatch(req, res, '/api/list-builder/commit');
    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.appended, 2);
  });

  itAsync('re-checks latest targets at commit time and skips stale duplicates', async () => {
    const r = runManager.createRun({ mode: 'url', payload: {} });
    runManager.saveCandidates(r.runId, [
      { id: 'c_latest_dup', companyName: 'New A', url: 'https://same.example.com', dedupeDecision: 'unique' },
    ]);
    let appendCalls = 0;
    const localDispatch = createListBuilderRoutes({
      ...ctx,
      appendCompany: () => { appendCalls++; return { ok: true, company: { no: 10 } }; },
      readTargetList: () => ({
        ok: true,
        companies: [{ no: 1, companyName: 'Existing A', url: 'https://same.example.com', notes: 'do not leak' }],
      }),
      getAllHistorySummary: () => [],
    });

    const res = makeRes();
    const req = makeReq('POST', { runId: r.runId, recordIds: ['c_latest_dup'] });
    const handled = await localDispatch(req, res, '/api/list-builder/commit');
    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.appended, 0);
    assert.equal(res.body.skippedDuplicate, 1);
    assert.equal(appendCalls, 0);
    assert.equal(JSON.stringify(res.body.duplicateDetails).includes('do not leak'), false);
  });

  itAsync('does not commit blocked compliance-risk candidates even when selected', async () => {
    const r = runManager.createRun({ mode: 'url', payload: {} });
    runManager.saveCandidates(r.runId, [
      {
        id: 'c_blocked',
        companyName: 'Blocked Co',
        url: 'https://blocked.example.com',
        dedupeDecision: 'unique',
        riskFlags: ['sales_prohibited'],
      },
    ]);
    let appendCalls = 0;
    const localDispatch = createListBuilderRoutes({
      ...ctx,
      appendCompany: () => { appendCalls++; return { ok: true, company: { no: 11 } }; },
      readTargetList: () => ({ ok: true, companies: [] }),
      getAllHistorySummary: () => [],
    });

    const res = makeRes();
    const req = makeReq('POST', { runId: r.runId, recordIds: ['c_blocked'] });
    await localDispatch(req, res, '/api/list-builder/commit');
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.appended, 0);
    assert.equal(res.body.skippedBlocked, 1);
    assert.equal(appendCalls, 0);
  });

  itAsync('passes extended list-builder fields through appendCompany', async () => {
    const r = runManager.createRun({ mode: 'url', payload: {} });
    runManager.saveCandidates(r.runId, [
      {
        id: 'c_ext',
        companyName: 'Extended Co',
        url: 'https://extended.example.com',
        dedupeDecision: 'unique',
        corporateNumber: '1234567890123',
        officialName: 'Extended Co Official',
        domainRoot: 'extended.example.com',
        fitScore: 88,
        sourceConfidence: 'high',
      },
    ]);
    let captured = null;
    const localDispatch = createListBuilderRoutes({
      ...ctx,
      appendCompany: (data) => {
        captured = data;
        return { ok: true, company: { no: 12, companyName: data.companyName, url: data.url } };
      },
      readTargetList: () => ({ ok: true, companies: [] }),
      getAllHistorySummary: () => [],
    });

    const res = makeRes();
    const req = makeReq('POST', { runId: r.runId, recordIds: ['c_ext'] });
    await localDispatch(req, res, '/api/list-builder/commit');
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.appended, 1);
    assert.equal(captured.corporateNumber, '1234567890123');
    assert.equal(captured.officialName, 'Extended Co Official');
    assert.equal(captured.fitScore, 88);
    assert.equal(captured.listBuilderRunId, r.runId);
    assert.equal(captured.listBuilderRecordId, 'c_ext');
  });
});

describe('target-list extended companion fields', () => {
  it('persists extended fields to companion JSON and merges them on read', () => {
    const targetList = require('../../dist-ts/src/target-list');
    const targetPath = path.join(dataDir, 'list-builder-targets.csv');
    settings.updateSection('targetList', {
      filePath: targetPath,
      fileType: 'csv',
      sheetIndex: 0,
      columnMapping: targetList.DEFAULT_COLUMN_MAPPING,
    });

    const appended = targetList.appendCompany({
      companyName: 'Companion Co',
      url: 'https://companion.example.com',
      corporateNumber: '1234567890123',
      domainRoot: 'companion.example.com',
      fitScore: 92,
      sourceConfidence: 'high',
    });
    assert.equal(appended.ok, true);

    const data = targetList.readTargetList();
    assert.equal(data.ok, true);
    const company = data.companies.find((row) => row.companyName === 'Companion Co');
    assert.ok(company);
    assert.equal(company.corporateNumber, '1234567890123');
    assert.equal(company.domainRoot, 'companion.example.com');
    assert.equal(Number(company.fitScore), 92);
    assert.equal(company.sourceConfidence, 'high');
  });
});

// クリーンアップ
process.on('exit', () => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}
});

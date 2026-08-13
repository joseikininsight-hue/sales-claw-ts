'use strict';

const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sales-claw-approve-api-'));
process.env.SALES_CLAW_USER_DATA_DIR = runtimeRoot;
fs.mkdirSync(path.join(runtimeRoot, 'data'), { recursive: true });
fs.writeFileSync(path.join(runtimeRoot, 'data', 'settings.json'), JSON.stringify({
  companyProfile: {},
  preferences: {},
}, null, 2));

const createApproveRoutes = require('../dist-ts/src/routes/approve-api');

function makeReq(body) {
  const req = new EventEmitter();
  req.method = 'POST';
  req.destroy = () => {};
  process.nextTick(() => {
    req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  });
  return req;
}

function makeRes() {
  let resolveEnd;
  const done = new Promise((resolve) => { resolveEnd = resolve; });
  return {
    statusCode: 200,
    chunks: [],
    done,
    writeHead(code) { this.statusCode = code; },
    end(chunk) {
      if (chunk) this.chunks.push(Buffer.from(String(chunk)));
      resolveEnd();
    },
    json() { return JSON.parse(Buffer.concat(this.chunks).toString('utf8')); },
  };
}

function makeCtx(overrides = {}) {
  return {
    getUiLang: () => 'ja',
    i18nT: (_lang, key) => key,
    appendDiagnosticEvent: () => {},
    getCompanyLogContext: () => ({ lastAction: 'awaiting_approval', logs: [], screenshot: {} }),
    isAwaitingTransitionAllowed: (lastAction) => lastAction === 'awaiting_approval',
    findRuntimeCompanyRecord: () => ({ formUrl: 'https://example.test/contact' }),
    getKnownFormUrl: () => 'https://example.test/contact',
    ensureSubmittedContactHistory: () => {},
    stringifyLogDetails: (value) => String(value || ''),
    getLatestLog: () => null,
    updateCompany: () => {},
    notifyClients: () => {},
    ensureParentDir: (file) => fs.mkdirSync(path.dirname(file), { recursive: true }),
    getFormSessionManager: () => null,
    ...overrides,
  };
}

async function call(dispatch, body) {
  const req = makeReq(body);
  const res = makeRes();
  const handled = await dispatch(req, res, '/api/approve');
  await res.done;
  return { handled, res };
}

(async () => {
  {
    const dispatch = createApproveRoutes(makeCtx({
      getCompanyLogContext: () => ({ lastAction: 'submitted', logs: [], screenshot: {} }),
    }));
    const { handled, res } = await call(dispatch, {
      companyNo: 1,
      companyName: '固定株式会社',
      decision: 'skip',
    });
    assert.equal(handled, true);
    assert.equal(res.statusCode, 409);
    assert.match(res.json().error, /audit\.blockedInvalidState/);
  }

  {
    let destroyedCompanyNo = null;
    let updated = null;
    const dispatch = createApproveRoutes(makeCtx({
      getFormSessionManager: () => ({
        destroySessionsByCompanyNo(no) { destroyedCompanyNo = no; },
      }),
      updateCompany: (no, patch) => { updated = { no, patch }; },
    }));
    const { res } = await call(dispatch, {
      companyNo: 2,
      companyName: 'スキップ株式会社',
      decision: 'skip',
      feedback: '対象外',
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().ok, true);
    assert.equal(destroyedCompanyNo, 2);
    assert.deepEqual(updated, { no: 2, patch: { progress: 'スキップ' } });
  }

  console.log('approve-api tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

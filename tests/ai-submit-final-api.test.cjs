'use strict';

const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const createAiSubmitFinalRoutes = require('../dist-ts/src/routes/ai-submit-final-api');

function makeReq(body) {
  const req = new EventEmitter();
  req.method = 'POST';
  req.body = body;
  return req;
}

function makeRes() {
  return { statusCode: 0, body: null };
}

function jsonResponse(res, statusCode, body) {
  res.statusCode = statusCode;
  res.body = body;
}

(async () => {
  {
    const dispatch = createAiSubmitFinalRoutes({
      jsonResponse,
      parseJsonBody: async (req) => req.body,
      findCompaniesByNos: () => ({
        ok: true,
        companies: [{ no: 7, companyName: '固定株式会社', formUrl: 'https://example.test/contact' }],
      }),
      getCompanyLogContext: () => ({
        lastAction: 'submitted',
        logs: [],
        awaitingLog: null,
      }),
      queueManagedAiPrompt: () => ({ queueLength: 0 }),
    });
    const res = makeRes();
    const handled = await dispatch(makeReq({ companyNo: 7 }), res, '/api/ai-submit-final');
    assert.equal(handled, true);
    assert.equal(res.statusCode, 409);
  }

  {
    let queued = null;
    let readinessProvider = null;
    const sentMessage = '承認済みの固定本文です。内容を変更せず、そのままフォームへ再入力して送信します。';
    const dispatch = createAiSubmitFinalRoutes({
      jsonResponse,
      parseJsonBody: async (req) => req.body,
      findCompaniesByNos: () => ({
        ok: true,
        companies: [{ no: 8, companyName: '再送株式会社', formUrl: 'https://example.test/contact' }],
      }),
      getCompanyLogContext: () => ({
        lastAction: 'awaiting_approval',
        logs: [],
        awaitingLog: { details: { sentMessage } },
        screenshot: {},
      }),
      getClaudePty: () => null,
      ensureManagedAiReadyForPrompt: async (provider) => {
        readinessProvider = provider;
        return { ok: true, relaunched: true };
      },
      getSelectedAiProvider: () => 'claude',
      getKnownFormUrl: () => 'https://example.test/contact',
      queueManagedAiPrompt: (prompt, provider) => {
        queued = { prompt, provider };
        return { queueLength: 1 };
      },
    });
    const res = makeRes();
    await dispatch(makeReq({ companyNo: 8 }), res, '/api/ai-submit-final');
    assert.equal(res.statusCode, 202);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.relaunched, true);
    assert.equal(readinessProvider, 'claude');
    assert.equal(queued.provider, 'claude');
    assert.match(queued.prompt, /browser_navigate/);
    assert.match(queued.prompt, /https:\/\/example\.test\/contact/);
    assert.match(queued.prompt, new RegExp(sentMessage));
    assert.match(queued.prompt, /フォームセッションは既に破棄されているため/);
  }

  console.log('ai-submit-final-api tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

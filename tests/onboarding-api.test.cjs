'use strict';

const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const createOnboardingRoutes = require('../dist-ts/src/routes/onboarding-api');

function describe(n, f) { console.log('\n=== ' + n + ' ==='); f(); }
function it(n, f) {
  Promise.resolve()
    .then(f)
    .then(() => console.log('  OK  ' + n))
    .catch((e) => { console.error('  FAIL ' + n + ' - ' + e.message); process.exitCode = 1; });
}

function createHarness(overrides = {}) {
  const savedSettings = [];
  const events = [];
  const settingsState = {
    companyProfile: {},
    valuePropositions: { strengths: [] },
    preferences: {},
  };
  const ctx = {
    jsonResponse(res, status, body) {
      res.status = status;
      res.body = body;
    },
    parseJsonBody: async (req) => req.body || {},
    settingsManager: {
      getAll: () => JSON.parse(JSON.stringify(settingsState)),
      save: (next) => { savedSettings.push(next); Object.assign(settingsState, next); },
    },
    getDataPath: (name) => path.join(os.tmpdir(), 'sales-claw-onboarding-api-test', name),
    probeClaudeAuthStatus: async () => ({ provider: 'claude', installed: true, loggedIn: true }),
    importTargetList: () => ({ ok: true, companyCount: 2, filePath: 'data/imports/test-target-list.xlsx' }),
    readTargetList: () => ({
      ok: true,
      companies: [
        { no: 1, companyName: 'A社', url: 'https://a.example', formUrl: 'https://a.example/contact' },
        { no: 2, companyName: 'B社', url: 'https://b.example', formUrl: '' },
      ],
    }),
    refreshWatchTargets: () => events.push('refresh'),
    notifyClients: (event) => events.push(event.reason),
    appendDiagnosticEvent: (name) => events.push(name),
    getDashboardSessionToken: () => 'test-token',
    ...overrides,
  };
  return {
    dispatch: createOnboardingRoutes(ctx),
    savedSettings,
    events,
  };
}

describe('onboarding-api', () => {
  it('imports target list through canonical importer', async () => {
    let importCalled = false;
    const h = createHarness({
      importTargetList: ({ fileName, buffer }) => {
        importCalled = true;
        assert.equal(fileName, 'targets.csv');
        assert.equal(Buffer.isBuffer(buffer), true);
        return { ok: true, companyCount: 2, filePath: 'data/imports/targets-target-list.xlsx' };
      },
    });
    const res = {};
    const handled = await h.dispatch({
      method: 'POST',
      body: { fileName: 'targets.csv', contentBase64: Buffer.from('x').toString('base64') },
    }, res, '/api/onboarding/import-targets', new URLSearchParams());
    assert.equal(handled, true);
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.count, 2);
    assert.equal(res.body.targets[0].name, 'A社');
    assert.equal(importCalled, true);
    assert.ok(h.events.includes('refresh'));
  });

  it('complete stores onboarding marker without rewriting target file', async () => {
    const h = createHarness();
    const res = {};
    const handled = await h.dispatch({
      method: 'POST',
      body: {
        companyProfile: {
          companyName: '株式会社サンプル',
          contactName: '山田 太郎',
          email: 'taro@example.com',
          phone: '03-1234-5678',
          address: '東京都千代田区1-1-1',
        },
        valuePropositions: { strengths: [{ label: 'CMS', detail: 'CMS構築' }] },
        targetList: [{ name: 'A社' }],
        aiAuthStatus: { installed: true, loggedIn: true, provider: 'claude' },
      },
    }, res, '/api/onboarding/complete', new URLSearchParams());
    assert.equal(handled, true);
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(h.savedSettings.length, 1);
    assert.equal(h.savedSettings[0]._onboardingVersion, 2);
    assert.equal(h.savedSettings[0].companyProfile.address, '東京都千代田区1-1-1');
  });
});

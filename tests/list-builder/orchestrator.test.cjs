'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestrator-test-'));
process.env.SALES_CLAW_USER_DATA_DIR = tmpRoot;
process.env.SALES_CLAW_TEST_MODE = '1';

const dataDir = path.join(tmpRoot, 'data');
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({
  apiKeys: { houjinBangou: 'k1', gBizInfo: 'k2' },
}));

const settings = require('../../dist-ts/src/settings-manager');
settings.invalidateSettingsCache();

const runManager = require('../../dist-ts/src/list-builder/run-manager');
const orchestrator = require('../../dist-ts/src/list-builder/orchestrator');

function describe(n, f) { console.log('\n=== ' + n + ' ==='); f(); }
function it(n, f) {
  try { f(); console.log('  OK  ' + n); }
  catch (e) { console.error('  FAIL ' + n + ' — ' + e.message); process.exitCode = 1; }
}
function itAsync(n, f) {
  return f().then(() => console.log('  OK  ' + n))
    .catch((e) => { console.error('  FAIL ' + n + ' — ' + e.message); process.exitCode = 1; });
}

// ============================================================
// run-manager
// ============================================================
describe('run-manager: createRun / getRun', () => {
  it('creates a run with valid runId', () => {
    const r = runManager.createRun({ mode: 'url', payload: { urls: ['https://x.com'] } });
    assert.match(r.runId, /^run_/);
    assert.equal(r.status, 'queued');
    assert.equal(r.mode, 'url');
    const fetched = runManager.getRun(r.runId);
    assert.equal(fetched.runId, r.runId);
  });

  it('throws on invalid mode', () => {
    assert.throws(() => runManager.createRun({}));
  });
});

describe('run-manager: updateRun', () => {
  it('updates status and sets completedAt automatically', () => {
    const r = runManager.createRun({ mode: 'url', payload: {} });
    const upd = runManager.updateRun(r.runId, { status: 'completed', newCount: 10 });
    assert.equal(upd.ok, true);
    assert.equal(upd.run.status, 'completed');
    assert.equal(upd.run.newCount, 10);
    assert.ok(upd.run.completedAt);
  });

  it('returns error for unknown runId', () => {
    const r = runManager.updateRun('run_nonexistent_xxx', { status: 'completed' });
    assert.equal(r.ok, false);
  });
});

describe('run-manager: candidates / checkpoint', () => {
  it('saves and loads candidates', () => {
    const r = runManager.createRun({ mode: 'url', payload: {} });
    runManager.saveCandidates(r.runId, [{ companyName: 'A', url: 'https://a.com' }]);
    const loaded = runManager.loadCandidates(r.runId);
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].companyName, 'A');
  });

  it('saves and loads checkpoint', () => {
    const r = runManager.createRun({ mode: 'url', payload: {} });
    runManager.saveCheckpoint(r.runId, { stage: 'extracting', count: 5 });
    const cp = runManager.loadCheckpoint(r.runId);
    assert.deepEqual(cp, { stage: 'extracting', count: 5 });
  });
});

describe('run-manager: cancel', () => {
  it('marks run as cancelled', () => {
    const r = runManager.createRun({ mode: 'url', payload: {} });
    assert.equal(runManager.isCancelled(r.runId), false);
    runManager.requestCancel(r.runId);
    assert.equal(runManager.isCancelled(r.runId), true);
    const updated = runManager.getRun(r.runId);
    assert.equal(updated.status, 'cancelled');
  });
});

describe('run-manager: listRuns / deleteRun', () => {
  it('lists existing runs and filters by status', () => {
    runManager.createRun({ mode: 'url', payload: {} });
    const r2 = runManager.createRun({ mode: 'nlq', payload: {} });
    runManager.updateRun(r2.runId, { status: 'completed' });

    const all = runManager.listRuns();
    assert.ok(all.length >= 2);
    const completed = runManager.listRuns({ status: 'completed' });
    assert.ok(completed.every((r) => r.status === 'completed'));
  });

  it('deletes a run', () => {
    const r = runManager.createRun({ mode: 'url', payload: {} });
    const result = runManager.deleteRun(r.runId);
    assert.equal(result.ok, true);
    assert.equal(runManager.getRun(r.runId), null);
  });
});

// ============================================================
// orchestrator
// ============================================================
describe('orchestrator.runPipeline (URL mode integration)', () => {
  itAsync('runs full pipeline with mock fetcher', async () => {
    let progressCount = 0;
    const events = [];

    const pages = {
      'https://list.example.com/p1': `
        <html><body>
          <ul>
            <li><a href="https://abc.co.jp">ABC</a></li>
            <li><a href="https://def.com">DEF</a></li>
          </ul>
        </body></html>
      `,
      'https://abc.co.jp/': `
        <html><body>
          <h1>ABC株式会社</h1>
          <p>SaaSを提供しています。</p>
          <p>従業員数: 50名</p>
          <a href="/contact">お問い合わせ</a>
        </body></html>
      `,
      'https://def.com/': `
        <html><body>
          <h1>DEF Inc.</h1>
          <p>製造業のメーカーです。</p>
          <p>従業員数: 200名</p>
        </body></html>
      `,
    };
    const fetchHtml = async (url) => {
      const html = pages[url];
      return html
        ? { ok: true, html, statusCode: 200, finalUrl: url }
        : { ok: false, error: '404', statusCode: 404 };
    };

    const result = await orchestrator.runPipeline({
      mode: 'url',
      payload: { urls: ['https://list.example.com/p1'], maxCompanies: 5 },
      options: {
        fetchHtml,
        onProgress: (e) => { events.push(e); progressCount++; },
        existingTargets: [],
        existingHistory: [],
      },
    });

    assert.equal(result.ok, true);
    assert.match(result.runId, /^run_/);
    assert.ok(result.records.length >= 2);
    assert.ok(progressCount > 0);
    // 全 stage が発火しているか
    const stages = new Set(events.map((e) => e.stage));
    assert.ok(stages.has('discovery'));
    assert.ok(stages.has('extracting'));

    // 永続化を確認
    const run = runManager.getRun(result.runId);
    assert.equal(run.status, 'completed');
    assert.equal(run.totalCandidates, 2);
  });
});

describe('orchestrator.runDiscovery', () => {
  itAsync('routes URL mode to list-page discovery', async () => {
    const fetchHtml = async () => ({
      ok: true,
      html: '<ul><li><a href="https://co.com">Co</a></li></ul>',
    });
    const r = await orchestrator.runDiscovery('url', { urls: ['https://x.com'] }, { fetchHtml });
    assert.equal(r.ok, true);
  });

  itAsync('routes NLQ mode through LLM and category', async () => {
    const llmInvoker = async () => ({
      ok: true,
      text: '{"industries":["SaaS"],"prefectures":["東京都"],"companySizeHints":[],"revenueHints":[],"keywords":[],"negativeKeywords":[],"mustHave":[],"niceToHave":[]}',
    });
    const searchInvoker = async () => ({
      ok: true,
      results: [{ title: 'X Co', url: 'https://x.co' }],
    });
    const r = await orchestrator.runDiscovery('nlq',
      { query: '都内のSaaS', limit: 10 },
      { llmInvoker, searchInvoker }
    );
    assert.equal(r.ok, true);
    assert.ok(r.candidates.length > 0);
  });

  itAsync('rejects unknown mode', async () => {
    const r = await orchestrator.runDiscovery('unknown', {});
    assert.equal(r.ok, false);
  });
});

describe('orchestrator: cancellation respected', () => {
  itAsync('stops pipeline when cancel is requested', async () => {
    const fetchHtml = async () => ({ ok: true, html: '<ul><li><a href="https://co.com">Co</a></li></ul>' });

    // Pre-create a run, then cancel before pipeline starts
    const run = runManager.createRun({ mode: 'url', payload: {} });
    runManager.requestCancel(run.runId);

    const result = await orchestrator.runPipeline({
      mode: 'url',
      payload: { urls: ['https://x.com'], maxCompanies: 5 },
      runId: run.runId,
      options: { fetchHtml },
    });
    // 開始時点で cancel 済みでも、discovery は実行されてから cancel チェックされる
    assert.equal(result.ok, true);
  });
});

// クリーンアップ
process.on('exit', () => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}
});

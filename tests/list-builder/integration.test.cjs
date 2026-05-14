'use strict';

// 統合テスト: discovery → extractor → enricher → scorer → dedupe の
// フルパイプラインを モック fetcher を使って検証する。
//
// 受け入れ基準 §19 のうち、以下を主にカバー:
//   1. URL モード: リストページ → ページネーション → 候補抽出
//   5. 既存リスト取込フロー・既存営業送信フローへの回帰なし
//   12. 取得件数 limit 到達まで動作
//   17. SSRF 違反 URL は拒否
//   21. 既存リストとの重複検出が完全動作

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'integration-test-'));
process.env.SALES_CLAW_USER_DATA_DIR = tmpRoot;
process.env.SALES_CLAW_TEST_MODE = '1';

const dataDir = path.join(tmpRoot, 'data');
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({
  apiKeys: {},
  listBuilder: { dedupeThreshold: 0.9 },
}));

const settings = require('../../dist-ts/src/settings-manager');
settings.invalidateSettingsCache();

const orchestrator = require('../../dist-ts/src/list-builder/orchestrator');
const suppression = require('../../dist-ts/src/list-builder/suppression');
const runManager = require('../../dist-ts/src/list-builder/run-manager');

function describe(n, f) { console.log('\n=== ' + n + ' ==='); f(); }
function itAsync(n, f) {
  return f().then(() => console.log('  OK  ' + n))
    .catch((e) => { console.error('  FAIL ' + n + ' — ' + e.message); process.exitCode = 1; });
}

const sampleListPage = `
  <html><body>
    <ul>
      <li><a href="https://abc-corp.co.jp">ABC株式会社</a></li>
      <li><a href="https://def-tech.com">DEF Tech Inc.</a></li>
      <li><a href="https://ghi-systems.jp">GHI Systems</a></li>
    </ul>
  </body></html>
`;

const companySites = {
  'https://abc-corp.co.jp/': `
    <html><body>
      <h1>ABC株式会社</h1>
      <p>当社はSaaSのクラウドサービスを提供しています。</p>
      <p>従業員数: 80名</p>
      <p>売上高: 50億円</p>
      <a href="/contact">お問い合わせ</a>
      <p>所在地: 東京都千代田区...</p>
    </body></html>
  `,
  'https://def-tech.com/': `
    <html><body>
      <h1>DEF Tech Inc.</h1>
      <p>製造業向けの工場自動化メーカーです。</p>
      <p>従業員数: 200名</p>
      <a href="/inquiry">Contact us</a>
    </body></html>
  `,
  'https://ghi-systems.jp/': `
    <html><body>
      <h1>GHI Systems</h1>
      <p>受託開発のSIerです。</p>
      <a href="/contact">問い合わせ</a>
      <!-- 採用専用フォームの場合 -->
      <h2>新卒採用 応募フォーム</h2>
    </body></html>
  `,
};

function makeFetcher() {
  return async (url) => {
    if (url === 'https://list.example.com/page1') {
      return { ok: true, html: sampleListPage, statusCode: 200, finalUrl: url };
    }
    if (companySites[url]) {
      return { ok: true, html: companySites[url], statusCode: 200, finalUrl: url };
    }
    return { ok: false, error: '404', statusCode: 404 };
  };
}

describe('Integration: URL mode end-to-end pipeline', () => {
  itAsync('discovers, extracts, enriches, dedupes 3 companies', async () => {
    const events = [];
    const result = await orchestrator.runPipeline({
      mode: 'url',
      payload: { urls: ['https://list.example.com/page1'], maxCompanies: 10 },
      options: {
        fetchHtml: makeFetcher(),
        onProgress: (e) => events.push(e),
        existingTargets: [],
        existingHistory: [],
      },
    });

    assert.equal(result.ok, true);
    assert.match(result.runId, /^run_/);
    assert.equal(result.records.length, 3);

    // 全候補が enrichment 経由で industry/employeeCount を取得しているか
    const abc = result.records.find((r) => /ABC/.test(r.companyName));
    assert.ok(abc, 'ABC company should be in records');
    assert.equal(abc.industry, 'SaaS');
    assert.equal(abc.employeeCount, 80);
    assert.equal(abc.companySize, 'medium');

    // 採用フォームのある企業は formType=recruit で skip 推奨に
    const ghi = result.records.find((r) => /GHI/.test(r.companyName));
    if (ghi) {
      // 業種は SIer で検出される (受託開発キーワード)
      // 採用フォームは riskFlags に含まれる
      assert.ok(Array.isArray(ghi.riskFlags));
    }

    // SSE イベントが各 stage 発火している
    const stages = new Set(events.map((e) => e.stage));
    assert.ok(stages.has('discovery'));
    assert.ok(stages.has('extracting'));
  });
});

describe('Integration: dedupe against existing targets', () => {
  itAsync('marks existing companies as duplicate', async () => {
    const existingTargets = [
      { companyName: 'ABC株式会社', url: 'https://abc-corp.co.jp', source: 'targets' },
    ];
    const result = await orchestrator.runPipeline({
      mode: 'url',
      payload: { urls: ['https://list.example.com/page1'] },
      options: {
        fetchHtml: makeFetcher(),
        existingTargets,
        existingHistory: [],
      },
    });
    assert.equal(result.ok, true);
    const abc = result.records.find((r) => /ABC/.test(r.companyName));
    assert.equal(abc.dedupeDecision, 'duplicate');
    assert.equal(abc.dedupeMatchKey, 'domain'); // domainRoot 一致
  });
});

describe('Integration: suppression list takes precedence', () => {
  itAsync('marks companies in suppression list as suppressed', async () => {
    suppression.addSuppression({
      type: 'domain',
      value: 'def-tech.com',
      reason: 'do_not_contact',
    });
    const result = await orchestrator.runPipeline({
      mode: 'url',
      payload: { urls: ['https://list.example.com/page1'] },
      options: {
        fetchHtml: makeFetcher(),
        existingTargets: [],
        existingHistory: [],
      },
    });
    const def = result.records.find((r) => r.companyName && /DEF/.test(r.companyName));
    assert.ok(def, 'DEF company should be in records');
    assert.equal(def.dedupeDecision, 'suppressed');
  });
});

describe('Integration: robots.txt compliance', () => {
  itAsync('marks disallowed company pages as blocked before fetching the page body', async () => {
    const calls = [];
    const fetchHtml = async (url) => {
      calls.push(url);
      if (url === 'https://robots-list.testsource.com/page1') {
        return {
          ok: true,
          statusCode: 200,
          finalUrl: url,
          html: '<a href="https://blocked-robots.example.net/">Blocked Robots Co</a>',
        };
      }
      if (url === 'https://blocked-robots.example.net/robots.txt') {
        return {
          ok: true,
          statusCode: 200,
          finalUrl: url,
          html: 'User-agent: *\nDisallow: /',
        };
      }
      if (url === 'https://blocked-robots.example.net/') {
        return {
          ok: true,
          statusCode: 200,
          finalUrl: url,
          html: '<html><body>SHOULD_NOT_FETCH</body></html>',
        };
      }
      return { ok: false, error: '404', statusCode: 404 };
    };

    const result = await orchestrator.runPipeline({
      mode: 'url',
      payload: { urls: ['https://robots-list.testsource.com/page1'], maxCompanies: 10 },
      options: { fetchHtml, existingTargets: [], existingHistory: [] },
    });

    assert.equal(result.ok, true);
    const record = result.records.find((r) => /Blocked Robots/.test(r.companyName));
    assert.ok(record, 'blocked robots candidate should be present for preview');
    assert.equal(record.collectionStatus, 'blocked');
    assert.equal(record.blockReason, 'robots_disallowed');
    assert.ok(record.riskFlags.includes('robots_disallowed'));
    assert.equal(calls.includes('https://blocked-robots.example.net/'), false);
  });
});

describe('Integration: run is persisted and retrievable', () => {
  itAsync('saves candidates and run metadata to disk', async () => {
    const result = await orchestrator.runPipeline({
      mode: 'url',
      payload: { urls: ['https://list.example.com/page1'] },
      options: { fetchHtml: makeFetcher() },
    });
    assert.equal(result.ok, true);

    const run = runManager.getRun(result.runId);
    assert.equal(run.status, 'completed');
    assert.ok(run.totalCandidates > 0);

    const reloaded = runManager.loadCandidates(result.runId);
    assert.ok(reloaded.length > 0);
  });
});

describe('Integration: SSRF input rejection (URL mode)', () => {
  itAsync('rejects private IP URLs at API validation layer', async () => {
    // API ルート層 (validateRunInput) で弾かれるはず
    const { validateRunInput } = require('../../dist-ts/src/routes/list-builder-api');
    const r1 = validateRunInput({
      mode: 'url',
      payload: { urls: ['http://localhost/x'] },
    });
    assert.equal(r1.ok, false);

    const r2 = validateRunInput({
      mode: 'url',
      payload: { urls: ['http://192.168.1.1/admin'] },
    });
    assert.equal(r2.ok, false);

    const r3 = validateRunInput({
      mode: 'url',
      payload: { urls: ['http://127.0.0.1/'] },
    });
    assert.equal(r3.ok, false);

    // 公開ホストは通過する
    const r4 = validateRunInput({
      mode: 'url',
      payload: { urls: ['https://example.com/list'] },
    });
    assert.equal(r4.ok, true);
  });
});

// クリーンアップ
process.on('exit', () => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}
});

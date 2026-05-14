'use strict';

/**
 * Unit tests for executeBackendPhaseABatch の result classification
 *
 * 検証目的:
 *   parallel-analysis.cjs の subprocess 戻り値 ({ ok, skipped, error 等}) を、
 *   呼び出し側 (executeBackendPhaseABatch) が正しく
 *   - successes (ok=true)
 *   - skipped (ok=false, skipped=true) — URL 未設定 / 営業お断り / dealBreakers 等の正常な skip
 *   - failures (ok=false, skipped 不在/false) — subprocess crash / HTTP error / 想定外
 *   の 3 カテゴリに分類することを保証する。
 *
 * Regression テスト:
 *   1.2.80 以前は ok:false 全部を failure 扱いし、URL 未設定企業ばかり選ぶと
 *   「Phase A 全件失敗」の誤誘導エラーになっていた。
 */

let passed = 0;
let failed = 0;
const failures = [];
const { isUrlMissingGateSkip } = require('../dist-ts/src/parallel-analysis');
const {
  buildOfficialSiteQueries,
  resolveOfficialSiteByCompanyName,
} = require('../dist-ts/src/official-site-resolver');

function classify(results) {
  // executeBackendPhaseABatch の本体ロジックを抽出
  const successes = [];
  const failuresList = [];
  const skipped = [];
  results.forEach((result) => {
    if (!result) {
      failuresList.push(result);
    } else if (result.ok) {
      successes.push(result);
    } else if (result.skipped === true) {
      skipped.push(result);
    } else {
      failuresList.push(result);
    }
  });
  return { successes, skipped, failures: failuresList };
}

function assertEq(name, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { passed += 1; return; }
  failed += 1;
  failures.push({ name, actual, expected });
}

// 1. 全件 URL 未設定 → 全件 skipped
{
  const r = classify([
    { ok: false, no: 1, skipped: true, skipKind: 'no_url', reason: 'URL未設定' },
    { ok: false, no: 2, skipped: true, skipKind: 'no_url', reason: 'URL未設定' },
  ]);
  assertEq('all no_url → 0 success / 2 skipped / 0 failure', { s: r.successes.length, k: r.skipped.length, f: r.failures.length }, { s: 0, k: 2, f: 0 });
}

// 2. 全件 success
{
  const r = classify([
    { ok: true, no: 1, message: 'msg1' },
    { ok: true, no: 2, message: 'msg2' },
  ]);
  assertEq('all success', { s: r.successes.length, k: r.skipped.length, f: r.failures.length }, { s: 2, k: 0, f: 0 });
}

// 3. 全件 failure (subprocess crash 等)
{
  const r = classify([
    { ok: false, no: 1, error: 'spawn ENOENT' },
    { ok: false, no: 2, error: 'timeout' },
  ]);
  assertEq('all failure', { s: r.successes.length, k: r.skipped.length, f: r.failures.length }, { s: 0, k: 0, f: 2 });
}

// 4. 混在 (success + skipped + failure)
{
  const r = classify([
    { ok: true, no: 1 },
    { ok: false, no: 2, skipped: true, skipKind: 'no_url' },
    { ok: false, no: 3, skipped: true, skipKind: 'llm_fit_skip' },
    { ok: false, no: 4, error: 'parse failure' },
  ]);
  assertEq('mixed', { s: r.successes.length, k: r.skipped.length, f: r.failures.length }, { s: 1, k: 2, f: 1 });
}

// 5. null / undefined results は failure 扱い
{
  const r = classify([null, undefined, { ok: true, no: 1 }]);
  assertEq('null/undefined → failures', { s: r.successes.length, k: r.skipped.length, f: r.failures.length }, { s: 1, k: 0, f: 2 });
}

// 6. skipped: false は failure (たとえば process.exit(1) で terminated だが skipped flag 無し)
{
  const r = classify([
    { ok: false, no: 1, skipped: false, error: 'crash' },
  ]);
  assertEq('explicit skipped:false → failure', { s: r.successes.length, k: r.skipped.length, f: r.failures.length }, { s: 0, k: 0, f: 1 });
}

// 7. 営業お断り / dealBreakers の skip も skipped カテゴリ
{
  const r = classify([
    { ok: false, no: 1, skipped: true, reason: '[skip] no_sales_block: 営業お断り検出' },
    { ok: false, no: 2, skipped: true, reason: '[skip] no_deal_breaker_match: deal_breakers にマッチ' },
  ]);
  assertEq('gate skip categories', { s: r.successes.length, k: r.skipped.length, f: r.failures.length }, { s: 0, k: 2, f: 0 });
}

// 8. LLM フィット判定の skip も skipped カテゴリ
{
  const r = classify([
    { ok: false, no: 1, skipped: true, skipKind: 'llm_fit_skip', reason: 'LLM フィット判定: skip' },
  ]);
  assertEq('llm_fit_skip → skipped', { s: r.successes.length, k: r.skipped.length, f: r.failures.length }, { s: 0, k: 1, f: 0 });
}

// 9. sendability-gate の URL 未設定 fatal は Phase A 集計では no_url skip に変換
{
  assertEq(
    'urlMissing siteText_sufficient fatal → no_url skip helper',
    isUrlMissingGateSkip(
      { urlMissing: true },
      { failures: [{ name: 'siteText_sufficient', severity: 'fatal' }] },
    ),
    true,
  );
  assertEq(
    'non-urlMissing fatal stays failure',
    isUrlMissingGateSkip(
      { urlMissing: false },
      { failures: [{ name: 'siteText_sufficient', severity: 'fatal' }] },
    ),
    false,
  );
  assertEq(
    'other fatal stays failure',
    isUrlMissingGateSkip(
      { urlMissing: true },
      { failures: [{ name: 'analysis_present', severity: 'fatal' }] },
    ),
    false,
  );
}

async function runAsyncTests() {
  // 10. URL 未設定でも会社名から公式サイト候補を探索できる
  {
    const queries = buildOfficialSiteQueries('株式会社ランドコンピュータ（SIer・東京都）');
    assertEq(
      'official-site queries strip parenthetical notes',
      queries.slice(0, 2),
      ['株式会社ランドコンピュータ 公式', '株式会社ランドコンピュータ 会社概要'],
    );
  }

  // 11. 求人媒体を除外し、公式サイトを検証して採用する
  {
    const resolved = await resolveOfficialSiteByCompanyName('株式会社ランドコンピュータ（SIer・東京都）', {
      queries: ['株式会社ランドコンピュータ 公式'],
      searchInvoker: async () => [
        {
          title: '(株)ランドコンピュータの新卒採用・会社概要 | マイナビ2027',
          url: 'https://job.mynavi.jp/27/pc/search/corp63535/outline.html',
          description: '株式会社ランドコンピュータの採用情報です。',
          rank: 1,
        },
        {
          title: '株式会社ランドコンピュータ',
          url: 'https://www.rand.co.jp/',
          description: '株式会社ランドコンピュータの公式サイトです。高度なシステム構築力で価値を創造します。',
          rank: 2,
        },
      ],
      fetcher: async () => ({
        title: '株式会社ランドコンピュータ',
        text: '株式会社ランドコンピュータの公式サイトです。システム開発、インフラ、クラウド、DX支援を提供します。',
      }),
    });
    assertEq('official-site resolver chooses verified corporate site', {
      ok: resolved.ok,
      url: resolved.url,
      method: resolved.method,
    }, {
      ok: true,
      url: 'https://www.rand.co.jp/',
      method: 'company-name-search',
    });
  }

  // 12. 「ジャパン」表記の会社でもブランド名表記の公式サイトを検証できる
  {
    const resolved = await resolveOfficialSiteByCompanyName('コグニザントジャパン株式会社', {
      queries: ['コグニザントジャパン株式会社 公式'],
      searchInvoker: async () => [
        {
          title: 'Intuition engineered — 直感を確信に | Cognizant 日本',
          url: 'https://www.cognizant.com/jp/ja',
          description: 'コグニザントは、近代的なビジネスをつくり出し、日常生活を改善します。',
          rank: 1,
        },
      ],
      fetcher: async () => ({
        title: 'Cognizant 日本',
        text: 'コグニザントは、世界をリードするプロフェッショナルサービス企業です。会社概要、サービス、お問い合わせをご案内します。',
      }),
    });
    assertEq('official-site resolver accepts Japan brand variant', {
      ok: resolved.ok,
      url: resolved.url,
      matchedVariant: resolved.matchedVariant,
    }, {
      ok: true,
      url: 'https://www.cognizant.com/jp/ja',
      matchedVariant: 'コグニザント',
    });
  }
}

runAsyncTests()
  .catch((e) => {
    failed += 1;
    failures.push({ name: 'async official-site resolver tests', actual: e && e.message || String(e), expected: 'no exception' });
  })
  .finally(() => {
    console.log('');
    console.log(`PASSED: ${passed}`);
    console.log(`FAILED: ${failed}`);
    if (failed > 0) {
      for (const f of failures) {
        console.log(`  FAIL: ${f.name}`);
        console.log(`    actual:   ${JSON.stringify(f.actual)}`);
        console.log(`    expected: ${JSON.stringify(f.expected)}`);
      }
      process.exitCode = 1;
    } else {
      console.log('all phase-a-classifier tests passed.');
    }
  });

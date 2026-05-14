'use strict';

/**
 * Unit tests for src/sendability-gate.cjs
 *
 * 7 項目品質ゲートが、春光社のような「拝見し」嘘事故と
 * OOH 専業のような業態ミスマッチを構造的に止めることを検証。
 */

const gate = require('../dist-ts/src/sendability-gate');

let passed = 0;
let failed = 0;
const failures = [];

function assertEq(name, actual, expected) {
  if (actual === expected) { passed += 1; return; }
  failed += 1;
  failures.push({ name, actual, expected });
}

function assertOk(name, value) { assertEq(name, !!value, true); }
function assertNot(name, value) { assertEq(name, !value, true); }

// ─────────────────────────────────────────────────────────────
// Helper: 完全に valid な analysis (gate を全 pass する)
// ─────────────────────────────────────────────────────────────
function validAnalysis(overrides = {}) {
  return {
    companyName: '株式会社サンプル',
    companyType: 'SIer',
    companyUrl: 'https://example.com',
    siteTextLength: 1500,
    siteTextExcerpt: '当社はWeb受託開発を主力としています。要件定義から実装まで対応します。',
    metaDescription: 'システム開発のサンプル株式会社',
    notes: '',
    businessAreas: [{ key: 'si', label: 'システム開発', matchCount: 3, confidence: 1.0 }],
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────
// 1. siteTextLength < 800 → error (春光社 disaster)
// ─────────────────────────────────────────────────────────────
{
  const r = gate.evaluate({ analysis: validAnalysis({ siteTextLength: 1 }), idealCustomer: null });
  assertNot('siteText=1 should fail gate', r.ok);
  assertEq('siteText=1 action should be error', r.action, 'error');
  assertOk('failure reason mentions siteText', r.failures.some((f) => f.name === 'siteText_sufficient'));
}
{
  const r = gate.evaluate({ analysis: validAnalysis({ siteTextLength: 100 }), idealCustomer: null });
  assertNot('siteText=100 should fail gate', r.ok);
  assertEq('siteText=100 action should be error', r.action, 'error');
}
{
  const r = gate.evaluate({ analysis: validAnalysis({ siteTextLength: 0, urlMissing: true }), idealCustomer: null });
  assertNot('urlMissing should fail gate before message_draft', r.ok);
  assertEq('urlMissing action should be error', r.action, 'error');
}
{
  const r = gate.evaluate({ analysis: validAnalysis({ siteTextLength: 850 }), idealCustomer: null });
  assertOk('siteText=850 should pass siteText check', r.ok || !r.failures.some((f) => f.name === 'siteText_sufficient'));
}

// ─────────────────────────────────────────────────────────────
// 2. 営業お断り検出 → skip
// ─────────────────────────────────────────────────────────────
{
  const r = gate.evaluate({
    analysis: validAnalysis({ siteTextExcerpt: '当社サービス。営業お断り。' }),
    idealCustomer: null,
  });
  assertNot('営業お断り should fail gate', r.ok);
  assertEq('営業お断り action should be skip', r.action, 'skip');
  assertOk('failure reason mentions no_sales_block', r.failures.some((f) => f.name === 'no_sales_block'));
}
{
  const r = gate.evaluate({
    analysis: validAnalysis({ siteTextExcerpt: '採用専用フォームです。それ以外のお問い合わせはご遠慮ください。' }),
    idealCustomer: null,
  });
  assertEq('採用専用 should skip', r.action, 'skip');
}
{
  const r = gate.evaluate({
    analysis: validAnalysis({ notes: 'IR専用窓口' }),  // notes 経由の検出
    idealCustomer: null,
  });
  assertEq('IR専用 (in notes) should skip', r.action, 'skip');
}

// ─────────────────────────────────────────────────────────────
// 3. dealBreakers マッチ → skip (春光社 OOH 問題)
// ─────────────────────────────────────────────────────────────
{
  // 春光社のような OOH 専業ケース
  const r = gate.evaluate({
    analysis: validAnalysis({
      companyName: '春光社',
      companyType: '広告代理店',
      siteTextExcerpt: '電車中吊り・駅看板・デジタルサイネージ等の交通広告 (OOH) を取り扱う老舗代理店です。',
    }),
    idealCustomer: {
      minSiteTextLength: 800,
      dealBreakers: ['OOH (交通広告) 専業の老舗代理店'],
      exclusionKeywords: { patterns: [] },
      competitors: { patterns: [] },
    },
  });
  assertNot('OOH 専業 should fail gate', r.ok);
  assertEq('OOH 専業 action should be skip', r.action, 'skip');
  assertOk('failure mentions deal_breaker', r.failures.some((f) => f.name === 'no_deal_breaker_match'));
}

// ─────────────────────────────────────────────────────────────
// 4. 競合除外
// ─────────────────────────────────────────────────────────────
{
  const r = gate.evaluate({
    analysis: validAnalysis({ siteTextExcerpt: '当社は WordPress VIP の認定パートナーです。' }),
    idealCustomer: {
      minSiteTextLength: 800,
      dealBreakers: [],
      exclusionKeywords: { patterns: [] },
      competitors: { patterns: ['WordPress VIP'] },
    },
  });
  assertEq('WordPress VIP competitor should skip', r.action, 'skip');
  assertOk('failure mentions not_competitor', r.failures.some((f) => f.name === 'not_competitor'));
}

// ─────────────────────────────────────────────────────────────
// 4.5. 保護グループ除外 (P2)
// ─────────────────────────────────────────────────────────────
{
  const r = gate.evaluate({
    analysis: validAnalysis({
      companyName: '株式会社NTTデータNJK',
      siteTextExcerpt: 'システム開発サービスを提供しています。',
    }),
    idealCustomer: null,
    protectedGroups: [
      { name: 'NTTデータ', reason: '既存協業先・グループ会社含む' },
    ],
  });
  assertEq('protected group name-only schema should skip', r.action, 'skip');
  assertOk('failure mentions protected group', r.failures.some((f) => f.name === 'not_protected_group'));
}

// ─────────────────────────────────────────────────────────────
// 5. すべて pass → send
// ─────────────────────────────────────────────────────────────
{
  const r = gate.evaluate({
    analysis: validAnalysis(),
    idealCustomer: {
      minSiteTextLength: 800,
      dealBreakers: ['OOH 交通広告', '独立系 SIer 自社で完結'],
      exclusionKeywords: { patterns: [] },
      competitors: { patterns: [] },
    },
  });
  assertOk('valid analysis should pass gate', r.ok);
  assertEq('valid action should be send', r.action, 'send');
}

// ─────────────────────────────────────────────────────────────
// 6. analysis 未取得 → error
// ─────────────────────────────────────────────────────────────
{
  const r = gate.evaluate({ analysis: null, idealCustomer: null });
  assertNot('null analysis should fail', r.ok);
  assertEq('null analysis action should be error', r.action, 'error');
}
{
  const r = gate.evaluate({ analysis: undefined, idealCustomer: null });
  assertEq('undefined analysis action should be error', r.action, 'error');
}

// ─────────────────────────────────────────────────────────────
// 7. 会社名不正 → error
// ─────────────────────────────────────────────────────────────
{
  const r = gate.evaluate({
    analysis: validAnalysis({ companyName: 'X' }),
    idealCustomer: null,
  });
  assertNot('1-char companyName should fail', r.ok);
  assertEq('1-char companyName action should be error', r.action, 'error');
}

// ─────────────────────────────────────────────────────────────
// 8. minSiteTextLength の上書き
// ─────────────────────────────────────────────────────────────
{
  const r = gate.evaluate({
    analysis: validAnalysis({ siteTextLength: 500 }),
    idealCustomer: {
      minSiteTextLength: 300,  // ユーザー設定で緩和
      dealBreakers: [],
      exclusionKeywords: { patterns: [] },
      competitors: { patterns: [] },
    },
  });
  assertOk('siteText=500 with min=300 should pass siteText check', r.ok || r.action === 'send');
}

// ─────────────────────────────────────────────────────────────
// 9. matchDealBreaker の token 抽出 (内部関数)
// ─────────────────────────────────────────────────────────────
{
  const hit = gate.matchDealBreaker(
    validAnalysis({ siteTextExcerpt: '当社は独立系 SIer として自社で開発を完結する体制です。' }),
    ['自社で完結する開発体制を持つ独立系 SIer'],
  );
  assertOk('matchDealBreaker should hit on 独立系/SIer/自社/完結 tokens', !!hit);
}
{
  const hit = gate.matchDealBreaker(
    validAnalysis({ siteTextExcerpt: '当社はマーケティングコンサルです。' }),
    ['自社で完結する開発体制を持つ独立系 SIer'],
  );
  assertNot('matchDealBreaker should NOT hit on unrelated content', hit);
}

// ─────────────────────────────────────────────────────────────
// 10. 不動産業者シナリオ (汎用性検証)
// ─────────────────────────────────────────────────────────────
{
  // 不動産買取業者が dealBreakers に「新築物件」を入れた状態
  const r = gate.evaluate({
    analysis: validAnalysis({
      companyName: 'サンプル新築マンション販売会社',
      companyType: '不動産販売',
      siteTextExcerpt: '当社は新築物件のみを取り扱う販売会社です。',
    }),
    idealCustomer: {
      minSiteTextLength: 800,
      dealBreakers: ['新築物件', '土地のみ'],
      exclusionKeywords: { patterns: [] },
      competitors: { patterns: [] },
    },
  });
  assertEq('real estate scenario: 新築 should skip', r.action, 'skip');
}

// ─────────────────────────────────────────────────────────────
// Output
// ─────────────────────────────────────────────────────────────
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
  console.log('all sendability-gate tests passed.');
}

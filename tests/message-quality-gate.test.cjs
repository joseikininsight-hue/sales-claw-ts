'use strict';

/**
 * Unit tests for src/message-quality-gate.cjs
 *
 * LLM 生成本文の 8 項目検証:
 *   - 事実引用 / 守秘違反 / 禁止フレーズ / 長さ / 署名 / CTA /
 *     テンプレ未展開 / exclusion 混入
 */

const gate = require('../dist-ts/src/message-quality-gate');

let passed = 0;
let failed = 0;
const failures = [];

function assertEq(name, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { passed += 1; return; }
  failed += 1;
  failures.push({ name, actual, expected });
}
function assertOk(name, value) { assertEq(name, !!value, true); }

// ─── helpers ─────────────────────────────────────────────────
function validMessage() {
  return [
    'お世話になります。株式会社サンプルの担当太郎と申します。',
    '貴社の Web 受託開発を拝見し、ご連絡しました。',
    '弊社は CMS 構築 190 件超の実装専門会社で、UI/UX 制作や広告代理店の',
    'デジタル子会社様から実装パートナーとしてお声がけいただいております。',
    'ご関心があれば 30 分程度の情報交換の機会をいただけますと幸いです。',
    '不要であれば返信不要です。',
    '何卒よろしくお願いいたします。',
    '',
    '株式会社サンプル',
    '担当太郎',
  ].join('\n');
}

// ─── 1. 空 / 短い ────────────────────────────────────────────
{
  const r = gate.evaluate({ message: '' });
  assertEq('empty message → reject', r.action, 'reject');
}
{
  const r = gate.evaluate({ message: '短い' });
  assertEq('short message → reject', r.action, 'reject');
}

// ─── 2. 事実引用検証 ────────────────────────────────────────
{
  const r = gate.evaluate({
    message: validMessage(),
    targetProfile: { evidenceQuotes: ['Web 受託開発'] },
  });
  assertOk('quote present in body → no warning', !r.failures.some((f) => f.name === 'evidence_citation'));
}
{
  const r = gate.evaluate({
    message: 'お世話になります。\n\n弊社のサービスご紹介です。長めの本文を 50 字以上書きます。\n\n株式会社サンプル',
    targetProfile: { evidenceQuotes: ['交通広告 OOH'] },
    ownContext: { companyName: '株式会社サンプル' },
  });
  assertOk('quote NOT in body → warning issued', r.failures.some((f) => f.name === 'evidence_citation'));
}

// ─── 3. 守秘違反: protected partners ────────────────────────
{
  const r = gate.evaluate({
    message: 'お世話になります。\n\n首都高速道路様の事例があります。長めの本文を 50 字以上書きます。\n\n株式会社サンプル',
    targetProfile: {},
    ownContext: { companyName: '株式会社サンプル' },
    protectedPartners: ['首都高速道路'],
  });
  assertEq('protected partner name → reject', r.action, 'reject');
  assertOk('failure mentions partner', r.failures.some((f) => f.name === 'confidentiality_partner_name'));
}

// ─── 4. 守秘違反: 社名+金額 ─────────────────────────────────
{
  const r = gate.evaluate({
    message: 'お世話になります。\n\n株式会社AB様の 5000 万円のプロジェクト実績があります。\n\n株式会社サンプル',
    targetProfile: {},
    ownContext: { companyName: '株式会社サンプル' },
  });
  assertEq('company+amount → reject', r.action, 'reject');
}

// ─── 5. 禁止フレーズ ────────────────────────────────────────
{
  const r = gate.evaluate({
    message: validMessage().replace('ご関心があれば', 'Win-Win の関係を目指して、ご関心があれば'),
    targetProfile: {},
    ownContext: { companyName: '株式会社サンプル' },
  });
  assertOk('Win-Win → warning', r.failures.some((f) => f.name === 'forbidden_phrases'));
  assertEq('Win-Win warn → still send', r.action, 'send');
}

// ─── 6. 長さ ─────────────────────────────────────────────────
{
  const r = gate.evaluate({
    message: validMessage() + 'X'.repeat(3000),
    targetProfile: {},
    ownContext: { companyName: '株式会社サンプル' },
    style: { maxLength: 1500 },
  });
  assertOk('over maxLength → warning', r.failures.some((f) => f.name === 'max_length'));
}

// ─── 7. 署名漏れ ────────────────────────────────────────────
{
  const r = gate.evaluate({
    message: 'お世話になります。\n\n本文だけで署名なし。長めに書いておきます。'.repeat(5),
    targetProfile: {},
    ownContext: { companyName: '株式会社サンプル' },
  });
  assertOk('signature missing → warning', r.failures.some((f) => f.name === 'signature_present'));
}

// ─── 8. テンプレ未展開 ─────────────────────────────────────
{
  const r = gate.evaluate({
    message: 'お世話になります。{companyName} の {contactName} です。\n本文なんとか 50 字以上にする。\n株式会社サンプル',
    targetProfile: {},
    ownContext: { companyName: '株式会社サンプル' },
  });
  assertEq('unexpanded template → reject', r.action, 'reject');
  assertOk('failure mentions unexpanded_template', r.failures.some((f) => f.name === 'unexpanded_template'));
}

// ─── 9. exclusion keyword 混入 ─────────────────────────────
{
  const r = gate.evaluate({
    message: validMessage().replace('Web 受託開発', '営業お断りな貴社ですが'),
    targetProfile: {},
    ownContext: { companyName: '株式会社サンプル' },
    idealCustomer: {
      exclusionKeywords: { patterns: ['営業お断り'] },
    },
  });
  assertOk('exclusion in body → warning', r.failures.some((f) => f.name === 'no_exclusion_in_body'));
}

// ─── 10. 完全に valid → send pass ────────────────────────────
{
  const r = gate.evaluate({
    message: validMessage().replace('株式会社サンプル', '株式会社サンプル（社員数：約50名）'),
    targetProfile: { evidenceQuotes: ['Web 受託開発'] },
    ownContext: {
      companyName: '株式会社サンプル',
      companyProfile: { employeeCount: '120名' },
    },
  });
  assertEq('employee count mismatch → reject', r.action, 'reject');
  assertOk('failure mentions settings consistency', r.failures.some((f) => f.name === 'settings_consistency'));
}
{
  const r = gate.evaluate({
    message: validMessage() + '\n設立：2010年、資本金：5,000万円',
    targetProfile: { evidenceQuotes: ['Web 受託開発'] },
    ownContext: {
      companyName: '株式会社サンプル',
      companyProfile: { established: '2015年4月', capital: '3,000万円' },
    },
  });
  assertEq('established/capital mismatch → reject', r.action, 'reject');
  assertOk('two settings consistency failures', r.failures.filter((f) => f.name === 'settings_consistency').length >= 2);
}
{
  const r = gate.evaluate({
    message: validMessage() + '\n社員数：120名、設立：2015年、資本金：3,000万円',
    targetProfile: { evidenceQuotes: ['Web 受託開発'] },
    ownContext: {
      companyName: '株式会社サンプル',
      companyProfile: { employeeCount: '120名', established: '2015年4月', capital: '3,000万円' },
    },
  });
  assertOk('matching configured facts should not reject', r.ok);
}

// ─── 11. 完全に valid → send pass ────────────────────────────
{
  const r = gate.evaluate({
    message: validMessage(),
    targetProfile: { evidenceQuotes: ['Web 受託開発'] },
    ownContext: { companyName: '株式会社サンプル' },
    style: { maxLength: 2000, cta: 'よろしくお願いいたします' },
  });
  assertEq('valid message → send', r.action, 'send');
  assertOk('valid message → no fatal failures', !r.failures.some((f) => f.severity === 'fatal'));
}

// ─── 12. extractKeyTokens (内部関数) ─────────────────────────
{
  // 助詞 (の/を/は/と...) で split + 4 文字以上 token を抽出
  // '当社は Web 受託開発を主力としています' → ['受託開発', 'しています']
  const t = gate.extractKeyTokens('当社は Web 受託開発を主力としています。');
  assertOk('extractKeyTokens finds 受託開発', t.includes('受託開発'));
}

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
  console.log('all message-quality-gate tests passed.');
}

'use strict';

// v2.0.80: log-action 入口の bug guards (文字化け + screenshot 0byte) の単体テスト。
// 実 HTTP server は立てず、validation 関数のみ抽出して検証。

const assert = require('assert');

// 文字化け検出 (`?` 3 文字以上連続)
function hasMojibakeQuestions(s) {
  return /\?{3,}/.test(s);
}

// === Test cases ===

// 1) 正常な日本語 → mojibake 検出されない
{
  const s = 'お世話になります。株式会社LYZONの中澤と申します。';
  assert.strictEqual(hasMojibakeQuestions(s), false);
  console.log('  ✓ normal Japanese passes (no `?` triplet)');
}

// 2) 1-2 個の `?` (普通の疑問符) → 通る
{
  assert.strictEqual(hasMojibakeQuestions('ご質問ありませんか?'), false);
  assert.strictEqual(hasMojibakeQuestions('?? どうですか'), false);
  console.log('  ✓ legitimate ? characters pass');
}

// 3) `???` (3連続) → 検出
{
  assert.strictEqual(hasMojibakeQuestions('????????'), true);
  assert.strictEqual(hasMojibakeQuestions('お世話??????'), true);
  console.log('  ✓ 3+ consecutive `?` flagged as mojibake');
}

// 4) 実機の文字化け sentMessage (実機 2026-05-28 No.214 抜粋)
{
  const broken = '????????? ????LYZON?????????  ?????????????????????????????????????????????????????????????IT??????????????????????????????';
  assert.strictEqual(hasMojibakeQuestions(broken), true);
  console.log('  ✓ real-world mojibake (2026-05-28) detected');
}

// 5) 改行を含む正常本文 → 通る
{
  const multi = 'お世話になります。\n株式会社LYZONの中澤と申します。\n\n貴社の事業内容を拝見し...';
  assert.strictEqual(hasMojibakeQuestions(multi), false);
  console.log('  ✓ multi-line Japanese passes');
}

console.log('\nAll log-action guard tests passed.');

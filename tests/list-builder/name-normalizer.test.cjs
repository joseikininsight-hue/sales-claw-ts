'use strict';

const assert = require('node:assert/strict');
const nameNormalizer = require('../../dist-ts/src/list-builder/name-normalizer');

function describe(n, f) { console.log('\n=== ' + n + ' ==='); f(); }
function it(n, f) {
  try { f(); console.log('  OK  ' + n); }
  catch (e) { console.error('  FAIL ' + n + ' — ' + e.message); process.exitCode = 1; }
}

describe('name-normalizer.normalize() corporate forms', () => {
  it('strips 株式会社 (mae-kabu / pre-form)', () => {
    const r = nameNormalizer.normalize('株式会社サンプル');
    assert.equal(r.prefix, '株式会社');
    assert.equal(r.base, 'サンプル');
    assert.equal(r.suffix, '');
  });

  it('strips 株式会社 (ato-kabu / post-form)', () => {
    const r = nameNormalizer.normalize('サンプル株式会社');
    assert.equal(r.prefix, '');
    assert.equal(r.base, 'サンプル');
    assert.equal(r.suffix, '株式会社');
  });

  it('strips (株) abbreviation', () => {
    const r1 = nameNormalizer.normalize('(株)サンプル');
    assert.equal(r1.base, 'サンプル');
    const r2 = nameNormalizer.normalize('サンプル(株)');
    assert.equal(r2.base, 'サンプル');
  });

  it('strips ㈱ unicode form', () => {
    const r = nameNormalizer.normalize('㈱サンプル');
    assert.equal(r.base, 'サンプル');
  });

  it('strips English corporate forms (Inc., Co.,Ltd., Corp., Ltd.)', () => {
    assert.equal(nameNormalizer.normalize('Sample Inc.').base, 'Sample');
    assert.equal(nameNormalizer.normalize('Sample Co., Ltd.').base, 'Sample');
    assert.equal(nameNormalizer.normalize('Sample Corp.').base, 'Sample');
    assert.equal(nameNormalizer.normalize('Sample Ltd.').base, 'Sample');
    assert.equal(nameNormalizer.normalize('Sample LLC').base, 'Sample');
  });

  it('strips 有限会社 / 合同会社 / 一般社団法人 etc.', () => {
    assert.equal(nameNormalizer.normalize('有限会社サンプル').base, 'サンプル');
    assert.equal(nameNormalizer.normalize('合同会社サンプル').base, 'サンプル');
    assert.equal(nameNormalizer.normalize('一般社団法人サンプル').base, 'サンプル');
    assert.equal(nameNormalizer.normalize('医療法人サンプル').base, 'サンプル');
  });
});

describe('name-normalizer normalized key (Layer 2 dedupe)', () => {
  it('produces same normalized key for 株式会社ABC / (株)ABC / ABC株式会社', () => {
    const a = nameNormalizer.normalize('株式会社ABC');
    const b = nameNormalizer.normalize('(株)ABC');
    const c = nameNormalizer.normalize('ABC株式会社');
    assert.equal(a.normalized, b.normalized);
    assert.equal(a.normalized, c.normalized);
    assert.equal(a.normalized, 'abc');
  });

  it('absorbs full-width / half-width variations', () => {
    const a = nameNormalizer.normalize('株式会社ＡＢＣ');
    const b = nameNormalizer.normalize('株式会社ABC');
    assert.equal(a.normalized, b.normalized);
  });

  it('absorbs full-width and half-width spaces', () => {
    const a = nameNormalizer.normalize('株式会社 サンプル');
    const b = nameNormalizer.normalize('株式会社　サンプル');
    const c = nameNormalizer.normalize('株式会社サンプル');
    assert.equal(a.normalized, b.normalized);
    assert.equal(a.normalized, c.normalized);
  });

  it('absorbs katakana / hiragana variation in dedupe key', () => {
    const a = nameNormalizer.normalize('株式会社サンプル');
    const b = nameNormalizer.normalize('株式会社さんぷる');
    assert.equal(a.normalized, b.normalized);
  });

  it('strips punctuation / hyphens / dots from key', () => {
    const a = nameNormalizer.normalize('A.B.C Co.,Ltd.');
    const b = nameNormalizer.normalize('A B C Co.,Ltd.');
    const c = nameNormalizer.normalize('ABC Co.,Ltd.');
    assert.equal(a.normalized, b.normalized);
    assert.equal(a.normalized, c.normalized);
  });

  it('lowercases english names', () => {
    const a = nameNormalizer.normalize('SAMPLE Inc.');
    const b = nameNormalizer.normalize('Sample Inc.');
    const c = nameNormalizer.normalize('sample inc.');
    assert.equal(a.normalized, b.normalized);
    assert.equal(a.normalized, c.normalized);
    // base: 'SAMPLE' / 'Sample' / 'sample' → normalized: 'sample'
    assert.equal(a.normalized, 'sample');
  });
});

describe('name-normalizer.isSameName', () => {
  it('matches different representations of the same company', () => {
    assert.equal(nameNormalizer.isSameName('株式会社サンプル', '(株)サンプル'), true);
    assert.equal(nameNormalizer.isSameName('株式会社ABC', 'ABC株式会社'), true);
    assert.equal(nameNormalizer.isSameName('Sample Inc.', 'Sample Co., Ltd.'), true);
  });

  it('does not match different companies', () => {
    assert.equal(nameNormalizer.isSameName('株式会社サンプルA', '株式会社サンプルB'), false);
    assert.equal(nameNormalizer.isSameName('Sample Inc.', 'Example Inc.'), false);
  });

  it('returns false for empty input', () => {
    assert.equal(nameNormalizer.isSameName('', '株式会社サンプル'), false);
    assert.equal(nameNormalizer.isSameName(null, undefined), false);
  });
});

describe('name-normalizer holdings detection', () => {
  it('detects HD / Holdings / ホールディングス', () => {
    assert.equal(nameNormalizer.normalize('株式会社サンプルホールディングス').isHoldings, true);
    assert.equal(nameNormalizer.normalize('Sample Holdings Inc.').isHoldings, true);
    assert.equal(nameNormalizer.normalize('Sample Group').isHoldings, true);
  });

  it('does not flag normal companies as holdings', () => {
    assert.equal(nameNormalizer.normalize('株式会社サンプル').isHoldings, false);
    assert.equal(nameNormalizer.normalize('Sample Inc.').isHoldings, false);
  });

  it('Holdings / Group must NOT be stripped as corporate forms (regression for review feedback)', () => {
    // 'Sample Holdings' と 'Sample Corp.' を誤って同一視してはいけない
    assert.notEqual(
      nameNormalizer.normalize('Sample Holdings').normalized,
      nameNormalizer.normalize('Sample Corp.').normalized
    );
    // 'Sample Group' と 'Sample' も別企業候補
    assert.notEqual(
      nameNormalizer.normalize('Sample Group').normalized,
      nameNormalizer.normalize('Sample').normalized
    );
    // ただし 'Sample Holdings' は isHoldings=true で要確認フラグが立つ
    assert.equal(nameNormalizer.normalize('Sample Holdings').isHoldings, true);
  });
});

describe('name-normalizer punctuation removal in dedupe key', () => {
  it('strips fullwidth hyphen / wave dash / chouon', () => {
    // 'サンプル-テック' (半角ハイフン) と 'サンプルテック' は同一
    assert.equal(
      nameNormalizer.normalize('株式会社サンプル-テック').normalized,
      nameNormalizer.normalize('株式会社サンプルテック').normalized
    );
    // 'サンプル−テック' (全角マイナス) も同様
    assert.equal(
      nameNormalizer.normalize('株式会社サンプル−テック').normalized,
      nameNormalizer.normalize('株式会社サンプルテック').normalized
    );
    // 'サンプル〜テック' (波ダッシュ) も同様
    assert.equal(
      nameNormalizer.normalize('株式会社サンプル〜テック').normalized,
      nameNormalizer.normalize('株式会社サンプルテック').normalized
    );
  });
});

describe('name-normalizer.toHalfwidth / toHiragana', () => {
  it('converts fullwidth ASCII to halfwidth', () => {
    assert.equal(nameNormalizer.toHalfwidth('ＡＢＣ１２３'), 'ABC123');
    assert.equal(nameNormalizer.toHalfwidth('ＡＢＣ ｆｏｏ'), 'ABC foo');
  });

  it('converts katakana to hiragana', () => {
    assert.equal(nameNormalizer.toHiragana('サンプル'), 'さんぷる');
    assert.equal(nameNormalizer.toHiragana('テスト'), 'てすと');
  });

  it('passes through non-target characters', () => {
    assert.equal(nameNormalizer.toHalfwidth('hello'), 'hello');
    assert.equal(nameNormalizer.toHiragana('abc'), 'abc');
  });
});

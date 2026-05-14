'use strict';

const assert = require('node:assert/strict');
const dedupe = require('../../dist-ts/src/list-builder/dedupe');

function describe(n, f) { console.log('\n=== ' + n + ' ==='); f(); }
function it(n, f) {
  try { f(); console.log('  OK  ' + n); }
  catch (e) { console.error('  FAIL ' + n + ' — ' + e.message); process.exitCode = 1; }
}

describe('levenshteinDistance', () => {
  it('returns 0 for identical strings', () => {
    assert.equal(dedupe.levenshteinDistance('abc', 'abc'), 0);
    assert.equal(dedupe.levenshteinDistance('', ''), 0);
  });

  it('handles empty strings', () => {
    assert.equal(dedupe.levenshteinDistance('', 'abc'), 3);
    assert.equal(dedupe.levenshteinDistance('abc', ''), 3);
  });

  it('counts single character changes', () => {
    assert.equal(dedupe.levenshteinDistance('abc', 'abd'), 1);   // substitute
    assert.equal(dedupe.levenshteinDistance('abc', 'abcd'), 1);  // insert
    assert.equal(dedupe.levenshteinDistance('abc', 'ab'), 1);    // delete
  });

  it('handles longer transformations', () => {
    assert.equal(dedupe.levenshteinDistance('kitten', 'sitting'), 3);
  });
});

describe('similarityRatio', () => {
  it('returns 1.0 for identical', () => {
    assert.equal(dedupe.similarityRatio('abc', 'abc'), 1);
  });

  it('returns 0 when one is empty', () => {
    assert.equal(dedupe.similarityRatio('', 'abc'), 0);
  });

  it('approximates expected ratio', () => {
    // 'sample' vs 'simple' = 1 substitution / 6 chars → 1 - 1/6 ≈ 0.833
    const r = dedupe.similarityRatio('sample', 'simple');
    assert.ok(r > 0.8 && r < 0.9, `expected ~0.83, got ${r}`);
  });
});

describe('checkDuplicate Layer 1: 法人番号 + ドメイン', () => {
  it('detects duplicate by corporate number', () => {
    const candidate = { companyName: '株式会社A', corporateNumber: '1234567890123' };
    const existing = [
      { source: 'targets', companyName: '株式会社B', corporateNumber: '1234567890123' },
    ];
    const r = dedupe.checkDuplicate(candidate, existing);
    assert.equal(r.decision, 'duplicate');
    assert.equal(r.matchKey, 'corporateNumber');
    assert.equal(r.similarity, 1.0);
  });

  it('detects duplicate by domain root (eTLD+1)', () => {
    const candidate = { companyName: '株式会社A', url: 'https://www.example.co.jp/about' };
    const existing = [
      { source: 'targets', companyName: 'Different', url: 'https://example.co.jp/' },
    ];
    const r = dedupe.checkDuplicate(candidate, existing);
    assert.equal(r.decision, 'duplicate');
    assert.equal(r.matchKey, 'domain');
  });

  it('does not match different domains', () => {
    const candidate = { companyName: 'A', url: 'https://a.com' };
    const existing = [{ source: 'targets', companyName: 'B', url: 'https://b.com' }];
    const r = dedupe.checkDuplicate(candidate, existing);
    assert.equal(r.decision, 'unique');
  });

  it('strips non-digit characters from corporate number', () => {
    const candidate = { companyName: 'A', corporateNumber: '1234-5678-9012-3' };
    const existing = [{ source: 'targets', companyName: 'B', corporateNumber: '1234567890123' }];
    const r = dedupe.checkDuplicate(candidate, existing);
    assert.equal(r.decision, 'duplicate');
    assert.equal(r.matchKey, 'corporateNumber');
  });
});

describe('checkDuplicate Layer 2: URL 正規化マッチ', () => {
  it('matches www. / non-www variations', () => {
    const candidate = { companyName: 'A', url: 'https://www.example.com/about/' };
    const existing = [
      { source: 'targets', companyName: 'A_old', url: 'http://example.com/about' },
    ];
    const r = dedupe.checkDuplicate(candidate, existing);
    // Layer 1b (domain) で先に一致するため URL ではなく domain
    assert.equal(r.decision, 'duplicate');
  });
});

describe('checkDuplicate Layer 3: 会社名正規化', () => {
  it('matches 株式会社X / (株)X', () => {
    const candidate = { companyName: '株式会社サンプル' };
    const existing = [{ source: 'targets', companyName: '(株)サンプル' }];
    const r = dedupe.checkDuplicate(candidate, existing);
    assert.equal(r.decision, 'duplicate');
    assert.equal(r.matchKey, 'name');
  });

  it('matches 前株 / 後株', () => {
    const candidate = { companyName: '株式会社ABC' };
    const existing = [{ source: 'targets', companyName: 'ABC株式会社' }];
    const r = dedupe.checkDuplicate(candidate, existing);
    assert.equal(r.decision, 'duplicate');
    assert.equal(r.matchKey, 'name');
  });

  it('matches Inc. / Co.,Ltd.', () => {
    const candidate = { companyName: 'Sample Inc.' };
    const existing = [{ source: 'targets', companyName: 'Sample Co., Ltd.' }];
    const r = dedupe.checkDuplicate(candidate, existing);
    assert.equal(r.decision, 'duplicate');
    assert.equal(r.matchKey, 'name');
  });
});

describe('checkDuplicate Layer 4: ファジーマッチ', () => {
  it('flags similar names as needs_review (>= 0.9)', () => {
    // 長めの会社名で 1 文字違い → 比率 0.9 以上
    // 'さんぷるてくのろじーずほーるでぃんぐ' (18文字) vs 1文字違い → ratio 17/18 ≈ 0.944
    const candidate = { companyName: '株式会社サンプルテクノロジーズホールディング' };
    const existing = [
      { source: 'targets', companyName: '株式会社サンプルテクノロジーズホールデイング' }, // 1文字違い
    ];
    const r = dedupe.checkDuplicate(candidate, existing);
    assert.equal(r.decision, 'needs_review');
    assert.equal(r.matchKey, 'fuzzy');
    assert.ok(r.similarity >= 0.9, `got ${r.similarity}`);
  });

  it('does not flag clearly different names', () => {
    const candidate = { companyName: '株式会社サンプル' };
    const existing = [{ source: 'targets', companyName: '株式会社全然違う名前' }];
    const r = dedupe.checkDuplicate(candidate, existing);
    assert.equal(r.decision, 'unique');
  });

  it('respects custom fuzzyThreshold', () => {
    const candidate = { companyName: '株式会社サンプル' };
    const existing = [{ source: 'targets', companyName: '株式会社サンフル' }];
    // 厳しいしきい値だと needs_review に上がらない
    const strict = dedupe.checkDuplicate(candidate, existing, [], { fuzzyThreshold: 0.99 });
    assert.equal(strict.decision, 'unique');
    // 緩いしきい値だと上がる
    const loose = dedupe.checkDuplicate(candidate, existing, [], { fuzzyThreshold: 0.5 });
    assert.equal(loose.decision, 'needs_review');
  });
});

describe('checkDuplicate Layer 5: Suppression', () => {
  // companyName 用の正規化キーは name-normalizer に作らせる
  // (漢字→ひらがな読み替えは行われないので、'禁止企業' は '禁止企業' のまま)
  const nameNormalizer = require('../../dist-ts/src/list-builder/name-normalizer');
  const blockedNameKey = nameNormalizer.normalize('禁止企業').normalized;

  const suppressionRecords = [
    {
      id: 'sup_a', type: 'domain', value: 'blocked.com',
      normalizedValue: 'blocked.com', reason: 'user_blocked', createdAt: '2026-01-01',
    },
    {
      id: 'sup_b', type: 'corporateNumber', value: '9999999999999',
      normalizedValue: '9999999999999', reason: 'do_not_contact', createdAt: '2026-01-01',
    },
    {
      id: 'sup_c', type: 'companyName', value: '禁止企業',
      normalizedValue: blockedNameKey, reason: 'complaint', createdAt: '2026-01-01',
    },
  ];

  it('returns suppressed for domain match', () => {
    const candidate = { companyName: 'A', url: 'https://blocked.com' };
    const r = dedupe.checkDuplicate(candidate, [], suppressionRecords);
    assert.equal(r.decision, 'suppressed');
    assert.equal(r.matchKey, 'suppression');
    assert.equal(r.matchedAgainst.id, 'sup_a');
  });

  it('returns suppressed for corporate number match', () => {
    const candidate = { companyName: 'A', corporateNumber: '9999999999999' };
    const r = dedupe.checkDuplicate(candidate, [], suppressionRecords);
    assert.equal(r.decision, 'suppressed');
    assert.equal(r.matchedAgainst.id, 'sup_b');
  });

  it('returns suppressed for company name match', () => {
    const candidate = { companyName: '株式会社禁止企業' };
    const r = dedupe.checkDuplicate(candidate, [], suppressionRecords);
    assert.equal(r.decision, 'suppressed');
    assert.equal(r.matchedAgainst.id, 'sup_c');
  });

  it('suppression takes precedence over duplicate detection', () => {
    // 既存に同じ会社があって、かつ Suppression にも入っている
    const candidate = { companyName: 'A', url: 'https://blocked.com' };
    const existing = [{ source: 'targets', companyName: 'A', url: 'https://blocked.com' }];
    const r = dedupe.checkDuplicate(candidate, existing, suppressionRecords);
    assert.equal(r.decision, 'suppressed');
  });

  it('returns unique when no suppression matches', () => {
    const candidate = { companyName: 'A', url: 'https://safe.com' };
    const r = dedupe.checkDuplicate(candidate, [], suppressionRecords);
    assert.equal(r.decision, 'unique');
  });
});

describe('checkDuplicates batch processing', () => {
  it('detects within-batch duplicates', () => {
    const candidates = [
      { companyName: '株式会社A', url: 'https://a.com' },
      { companyName: '株式会社A', url: 'https://a.com' },     // バッチ内重複
      { companyName: '株式会社B', url: 'https://b.com' },
    ];
    const results = dedupe.checkDuplicates(candidates, [], []);
    assert.equal(results.length, 3);
    assert.equal(results[0].decision, 'unique');
    assert.equal(results[1].decision, 'duplicate');
    assert.equal(results[2].decision, 'unique');
  });

  it('combines existing and within-batch detection', () => {
    const candidates = [
      { companyName: '株式会社A', url: 'https://a.com' },
      { companyName: '株式会社B', url: 'https://b.com' },     // 既存と重複
    ];
    const existing = [{ source: 'targets', companyName: '株式会社B', url: 'https://b.com' }];
    const results = dedupe.checkDuplicates(candidates, existing, []);
    assert.equal(results[0].decision, 'unique');
    assert.equal(results[1].decision, 'duplicate');
  });
});

describe('checkDuplicate edge cases', () => {
  it('rejects non-13-digit corporate numbers (phone-like input)', () => {
    // 電話番号 '03-1234-5678' (10 digits) は法人番号扱いしない
    const candidate = { companyName: 'A', corporateNumber: '03-1234-5678', url: 'https://a.com' };
    const existing = [
      { source: 'targets', companyName: 'B', corporateNumber: '0312345678', url: 'https://b.com' },
    ];
    const r = dedupe.checkDuplicate(candidate, existing);
    // corporateNumber が両方無効化されるため、他の手がかりがなければ unique
    assert.equal(r.decision, 'unique');
  });

  it('matchedAgainst for suppression does NOT leak createdBy / createdAt / value', () => {
    const candidate = { companyName: 'A', url: 'https://blocked.com' };
    const sup = [{
      id: 'sup_x', type: 'domain', value: 'blocked.com',
      normalizedValue: 'blocked.com',
      reason: 'user_blocked',
      createdAt: '2026-01-01T00:00:00Z',
      createdBy: 'admin@internal',
    }];
    const r = dedupe.checkDuplicate(candidate, [], sup);
    assert.equal(r.decision, 'suppressed');
    assert.equal(r.matchedAgainst.id, 'sup_x');
    assert.equal(r.matchedAgainst.reason, 'user_blocked');
    assert.equal(r.matchedAgainst.type, 'domain');
    // 漏洩してはいけないフィールド
    assert.equal(r.matchedAgainst.createdBy, undefined);
    assert.equal(r.matchedAgainst.createdAt, undefined);
    assert.equal(r.matchedAgainst.value, undefined);
    assert.equal(r.matchedAgainst.normalizedValue, undefined);
  });

  it('handles empty existing array', () => {
    const r = dedupe.checkDuplicate({ companyName: 'A' }, []);
    assert.equal(r.decision, 'unique');
  });

  it('checkDuplicates handles empty input', () => {
    assert.deepEqual(dedupe.checkDuplicates([], [], []), []);
  });

  it('checkDuplicates handles null entries gracefully', () => {
    const results = dedupe.checkDuplicates(
      [{ companyName: 'A' }],
      [null, undefined, { companyName: 'B' }],
      []
    );
    assert.equal(results.length, 1);
    assert.equal(results[0].decision, 'unique');
  });
});

describe('precomputeKeys', () => {
  it('extracts all keys from a complete record', () => {
    const r = dedupe.precomputeKeys({
      companyName: '株式会社サンプル',
      url: 'https://www.example.co.jp/about',
      corporateNumber: '1234567890123',
    });
    assert.equal(r.corporateNumber, '1234567890123');
    assert.equal(r.domainRoot, 'example.co.jp');
    assert.equal(r.normalizedUrl, 'https://example.co.jp/about');
    assert.ok(r.normalizedName.length > 0);
  });

  it('handles partial records', () => {
    const r = dedupe.precomputeKeys({ companyName: 'A' });
    assert.equal(r.corporateNumber, '');
    assert.equal(r.domainRoot, '');
    assert.equal(r.normalizedUrl, '');
    assert.equal(r.normalizedName, 'a');
  });

  it('handles null/undefined safely', () => {
    const r = dedupe.precomputeKeys(null);
    assert.equal(r.corporateNumber, '');
    assert.equal(r.normalizedName, '');
  });
});

'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// テスト用の data ディレクトリを動的に切り替えるため、suppression.cjs 読込前に
// 環境変数で resolveDataPath が指す先をオーバーライドする。
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'suppression-test-'));
process.env.SALES_CLAW_USER_DATA_DIR = tmpRoot;
// _invalidateCache を本番でブロックするガードを通すため、明示的にテストモードを設定
process.env.SALES_CLAW_TEST_MODE = '1';

const suppression = require('../../dist-ts/src/list-builder/suppression');

function describe(n, f) { console.log('\n=== ' + n + ' ==='); f(); }
function it(n, f) {
  try { f(); console.log('  OK  ' + n); }
  catch (e) { console.error('  FAIL ' + n + ' — ' + e.message); process.exitCode = 1; }
}

function reset() {
  // テスト間でファイルを消してキャッシュをクリア
  const file = path.join(tmpRoot, 'data', 'suppression-list.json');
  if (fs.existsSync(file)) fs.unlinkSync(file);
  suppression._invalidateCache();
}

describe('buildNormalizedValue', () => {
  it('normalizes domain to eTLD+1', () => {
    assert.equal(suppression.buildNormalizedValue('domain', 'https://www.example.co.jp/foo'), 'example.co.jp');
    assert.equal(suppression.buildNormalizedValue('domain', 'EXAMPLE.com'), 'example.com');
    assert.equal(suppression.buildNormalizedValue('domain', 'sub.foo.example.co.jp'), 'example.co.jp');
  });

  it('normalizes formUrl', () => {
    const v = suppression.buildNormalizedValue('formUrl', 'https://www.example.com/contact/?utm_source=ad');
    assert.equal(v, 'https://example.com/contact');
  });

  it('normalizes companyName via name-normalizer', () => {
    assert.equal(
      suppression.buildNormalizedValue('companyName', '株式会社サンプル'),
      suppression.buildNormalizedValue('companyName', '(株)サンプル')
    );
  });

  it('strips non-digits from corporate number', () => {
    assert.equal(suppression.buildNormalizedValue('corporateNumber', '1234-5678-9012-3'), '1234567890123');
    assert.equal(suppression.buildNormalizedValue('corporateNumber', ' 1234567890123 '), '1234567890123');
  });

  it('rejects non-13-digit corporate number values', () => {
    // 電話番号や短い数字列は法人番号扱いしない (空文字を返す)
    assert.equal(suppression.buildNormalizedValue('corporateNumber', '03-1234-5678'), '');
    assert.equal(suppression.buildNormalizedValue('corporateNumber', '12345'), '');
    // 14桁も無効
    assert.equal(suppression.buildNormalizedValue('corporateNumber', '12345678901234'), '');
  });
});

describe('addSuppression: corporateNumber length validation', () => {
  it('rejects adding non-13-digit corporate numbers', () => {
    reset();
    const r = suppression.addSuppression({
      type: 'corporateNumber', value: '03-1234-5678', reason: 'user_blocked',
    });
    assert.equal(r.ok, false);
    assert.match(r.error, /normalization failed/);
  });
});

describe('addSuppression / listSuppressions', () => {
  it('adds a record', () => {
    reset();
    const r = suppression.addSuppression({
      type: 'domain', value: 'example.com', reason: 'past_contacted',
    });
    assert.equal(r.ok, true);
    assert.equal(r.alreadyExists, false);
    assert.equal(r.record.type, 'domain');
    assert.equal(r.record.normalizedValue, 'example.com');
  });

  it('rejects invalid type', () => {
    reset();
    const r = suppression.addSuppression({ type: 'invalid', value: 'x' });
    assert.equal(r.ok, false);
  });

  it('rejects invalid reason', () => {
    reset();
    const r = suppression.addSuppression({
      type: 'domain', value: 'example.com', reason: 'made-up-reason',
    });
    assert.equal(r.ok, false);
  });

  it('rejects empty value', () => {
    reset();
    const r = suppression.addSuppression({ type: 'domain', value: '' });
    assert.equal(r.ok, false);
  });

  it('detects already-existing record (deduplication)', () => {
    reset();
    suppression.addSuppression({ type: 'domain', value: 'example.com', reason: 'user_blocked' });
    const r2 = suppression.addSuppression({ type: 'domain', value: 'EXAMPLE.com', reason: 'user_blocked' });
    assert.equal(r2.ok, true);
    assert.equal(r2.alreadyExists, true);
    const all = suppression.listSuppressions();
    assert.equal(all.length, 1);
  });

  it('lists with type filter', () => {
    reset();
    suppression.addSuppression({ type: 'domain', value: 'a.com', reason: 'user_blocked' });
    suppression.addSuppression({ type: 'companyName', value: 'X', reason: 'user_blocked' });
    const domains = suppression.listSuppressions({ type: 'domain' });
    assert.equal(domains.length, 1);
    assert.equal(domains[0].type, 'domain');
  });

  it('lists with reason filter', () => {
    reset();
    suppression.addSuppression({ type: 'domain', value: 'a.com', reason: 'user_blocked' });
    suppression.addSuppression({ type: 'domain', value: 'b.com', reason: 'past_contacted' });
    const filtered = suppression.listSuppressions({ reason: 'user_blocked' });
    assert.equal(filtered.length, 1);
  });
});

describe('removeSuppression', () => {
  it('removes a record by id', () => {
    reset();
    const added = suppression.addSuppression({ type: 'domain', value: 'rm.com', reason: 'user_blocked' });
    const r = suppression.removeSuppression(added.record.id);
    assert.equal(r.ok, true);
    assert.equal(suppression.listSuppressions().length, 0);
  });

  it('returns error for unknown id', () => {
    reset();
    const r = suppression.removeSuppression('nonexistent');
    assert.equal(r.ok, false);
  });
});

describe('isSuppressed / matchSuppression', () => {
  it('matches by domain', () => {
    reset();
    suppression.addSuppression({ type: 'domain', value: 'blocked.co.jp', reason: 'user_blocked' });
    assert.equal(suppression.isSuppressed({ url: 'https://www.blocked.co.jp/contact' }), true);
    assert.equal(suppression.isSuppressed({ url: 'https://safe.com' }), false);
  });

  it('matches by company name (normalized)', () => {
    reset();
    suppression.addSuppression({ type: 'companyName', value: '株式会社禁止', reason: 'complaint' });
    assert.equal(suppression.isSuppressed({ companyName: '(株)禁止' }), true);
    assert.equal(suppression.isSuppressed({ companyName: '株式会社別会社' }), false);
  });

  it('matches by corporate number', () => {
    reset();
    suppression.addSuppression({ type: 'corporateNumber', value: '1234567890123', reason: 'do_not_contact' });
    assert.equal(suppression.isSuppressed({ corporateNumber: '1234-5678-9012-3' }), true);
  });

  it('matches by formUrl', () => {
    reset();
    suppression.addSuppression({
      type: 'formUrl',
      value: 'https://www.example.com/contact/',
      reason: 'past_contacted',
    });
    assert.equal(
      suppression.isSuppressed({ formUrl: 'http://example.com/contact?utm_source=test' }),
      true
    );
  });

  it('returns full Suppression record from matchSuppression', () => {
    reset();
    suppression.addSuppression({ type: 'domain', value: 'example.com', reason: 'competitor' });
    const m = suppression.matchSuppression({ url: 'https://example.com' });
    assert.ok(m);
    assert.equal(m.reason, 'competitor');
    assert.equal(m.type, 'domain');
  });
});

describe('persistence: data is saved to JSON file', () => {
  it('writes to disk and reloads', () => {
    reset();
    suppression.addSuppression({ type: 'domain', value: 'persist.com', reason: 'user_blocked' });
    suppression._invalidateCache();
    const reloaded = suppression.listSuppressions();
    assert.equal(reloaded.length, 1);
    assert.equal(reloaded[0].normalizedValue, 'persist.com');
  });
});

// テスト終了後のクリーンアップ
process.on('exit', () => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}
});

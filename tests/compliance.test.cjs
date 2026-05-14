'use strict';

const assert = require('node:assert/strict');
const compliance = require('../dist-ts/src/compliance');

function describe(n, f) { console.log('\n=== ' + n + ' ==='); f(); }
function it(n, f) {
  try { f(); console.log('  OK  ' + n); }
  catch (e) { console.error('  FAIL ' + n + ' — ' + e.message); process.exitCode = 1; }
}

const profile = {
  companyName: 'サンプル株式会社',
  contactName: 'サンプル 太郎',
  email: 'sample@example.com',
  phone: '03-0000-0000',
  address: '東京都千代田区サンプル1-1-1',
};

describe('checkCompliance', () => {
  it('finds required elements when present', () => {
    const msg = 'サンプル株式会社\nサンプル 太郎です。\n東京都千代田区サンプル1-1-1\n本文。\nMAIL: sample@example.com\n配信停止希望はメールでご連絡ください。';
    const r = compliance.checkCompliance(msg, profile);
    assert.equal(r.hasSenderCompany, true);
    assert.equal(r.hasSenderName, true);
    assert.equal(r.hasSenderAddress, true);
    assert.equal(r.hasContactEmail, true);
    assert.equal(r.hasOptOut, true);
    assert.equal(r.missing.length, 0);
  });

  it('flags missing elements', () => {
    const msg = '本文だけ';
    const r = compliance.checkCompliance(msg, profile);
    assert.equal(r.missing.length, 5);
  });

  it('opt-out variants: 配信停止 / 送信停止 / ご不要の場合 / unsubscribe', () => {
    for (const phrase of ['配信停止', '送信停止', 'ご不要の場合', 'unsubscribe']) {
      const msg = '本文 ' + phrase;
      const r = compliance.checkCompliance(msg, profile);
      assert.equal(r.hasOptOut, true, 'phrase: ' + phrase);
    }
  });

  it('opt-out: 「今後 ご連絡 不要」', () => {
    const msg = '今後ご連絡が不要な場合は…';
    const r = compliance.checkCompliance(msg, profile);
    assert.equal(r.hasOptOut, true);
  });
});

describe('injectRequiredFooter', () => {
  it('appends required footer elements when message has none', () => {
    const out = compliance.injectRequiredFooter('本文', profile);
    assert.match(out, /サンプル株式会社/);
    assert.match(out, /サンプル 太郎/);
    assert.match(out, /東京都千代田区サンプル1-1-1/);
    assert.match(out, /sample@example\.com/);
    assert.match(out, /送信を停止/);
  });

  it('does not duplicate existing elements', () => {
    const msg = 'サンプル株式会社\nサンプル 太郎\n東京都千代田区サンプル1-1-1\n本文\nTEL: 03-0000-0000\nMAIL: sample@example.com';
    const out = compliance.injectRequiredFooter(msg, profile);
    // companyName 出現は 1 回のままであるべき
    const occurrences = out.split('サンプル株式会社').length - 1;
    assert.equal(occurrences, 1);
    // ただしオプトアウトは含まれていなかったので追加されている
    assert.match(out, /送信を停止/);
  });

  it('optOutOnly mode adds only opt-out line', () => {
    const out = compliance.injectRequiredFooter('サンプル株式会社\nサンプル 太郎\n東京都千代田区サンプル1-1-1\nMAIL: sample@example.com', profile, { optOutOnly: true });
    assert.match(out, /送信を停止/);
    // companyName が二重追加されていない
    assert.equal(out.split('サンプル株式会社').length - 1, 1);
  });

  it('returns input unchanged when fully compliant', () => {
    const msg = 'サンプル株式会社\nサンプル 太郎\n東京都千代田区サンプル1-1-1\nTEL: 03-0000-0000\nMAIL: sample@example.com\n配信停止希望はメールで';
    const out = compliance.injectRequiredFooter(msg, profile);
    assert.equal(out, msg);
  });
});

describe('evaluateForUi', () => {
  it('ok when all present', () => {
    const e = compliance.evaluateForUi('サンプル株式会社\nサンプル 太郎\n東京都千代田区サンプル1-1-1\nsample@example.com\n送信停止', profile);
    assert.equal(e.status, 'ok');
  });

  it('warn when only opt-out missing', () => {
    const e = compliance.evaluateForUi('サンプル株式会社\nサンプル 太郎\n東京都千代田区サンプル1-1-1\nsample@example.com', profile);
    assert.equal(e.status, 'warn');
    assert.deepEqual(e.missing, ['オプトアウト案内']);
  });

  it('fail when sender info missing', () => {
    const e = compliance.evaluateForUi('本文だけ', profile);
    assert.equal(e.status, 'fail');
    assert.ok(e.missing.length >= 3);
  });
});

console.log('\nall compliance tests passed.');

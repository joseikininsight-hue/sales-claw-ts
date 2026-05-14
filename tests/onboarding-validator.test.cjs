'use strict';

// Onboarding wizard validator のテスト。
// node tests/onboarding-validator.test.cjs で実行。

const assert = require('node:assert/strict');
const v = require('../dist-ts/src/onboarding-validator');

function describe(name, fn) {
  console.log('\n=== ' + name + ' ===');
  fn();
}
function it(name, fn) {
  try { fn(); console.log('  OK  ' + name); }
  catch (e) { console.error('  FAIL ' + name + ' — ' + e.message); process.exitCode = 1; }
}

describe('validateCompanyProfile', () => {
  it('rejects empty profile with 5 required errors', () => {
    const errs = v.validateCompanyProfile({});
    const codes = errs.map(e => e.code);
    const fields = errs.map(e => e.field);
    assert.equal(errs.length, 5);
    assert.deepEqual(codes.sort(), ['required','required','required','required','required']);
    assert.deepEqual(fields.sort(), ['address','companyName','contactName','email','phone']);
  });

  it('accepts a full valid profile', () => {
    const errs = v.validateCompanyProfile({
      companyName: '株式会社サンプル',
      contactName: 'サンプル 太郎',
      email: 'sample@example.com',
      phone: '03-1234-5678',
      address: '東京都千代田区サンプル1-1-1',
    });
    assert.equal(errs.length, 0);
  });

  it('rejects malformed email', () => {
    const errs = v.validateCompanyProfile({
      companyName: 'X', contactName: 'Y', email: 'not-an-email', phone: '03-0', address: '東京都',
    });
    const emailErr = errs.find(e => e.field === 'email');
    assert.ok(emailErr);
    assert.equal(emailErr.code, 'invalid');
  });

  it('rejects too-short phone', () => {
    const errs = v.validateCompanyProfile({
      companyName: 'X', contactName: 'Y', email: 'a@b.c', phone: '12', address: '東京都',
    });
    const phoneErr = errs.find(e => e.field === 'phone');
    assert.ok(phoneErr);
    assert.equal(phoneErr.code, 'invalid');
  });

  it('rejects website without scheme', () => {
    const errs = v.validateCompanyProfile({
      companyName: 'X', contactName: 'Y', email: 'a@b.c', phone: '03-1234-5678',
      address: '東京都',
      website: 'www.example.com',
    });
    const webErr = errs.find(e => e.field === 'website');
    assert.ok(webErr);
    assert.equal(webErr.code, 'invalid');
  });

  it('accepts whitespace-trimmed email', () => {
    const errs = v.validateCompanyProfile({
      companyName: 'X', contactName: 'Y', email: '  a@b.com  ', phone: '03-1234-5678', address: '東京都',
    });
    assert.equal(errs.filter(e => e.field === 'email').length, 0);
  });
});

describe('validateStrengths', () => {
  it('rejects empty array', () => {
    const errs = v.validateStrengths([]);
    assert.equal(errs.length, 1);
    assert.equal(errs[0].code, 'min_length');
  });

  it('rejects null', () => {
    const errs = v.validateStrengths(null);
    assert.equal(errs.length, 1);
    assert.equal(errs[0].code, 'min_length');
  });

  it('accepts at least one valid strength', () => {
    const errs = v.validateStrengths([{ label: 'CMS', detail: 'WordPress 開発', keywords: ['cms'] }]);
    assert.equal(errs.length, 0);
  });

  it('rejects strength without label', () => {
    const errs = v.validateStrengths([{ detail: 'd' }]);
    const e = errs.find(x => x.field === 'strengths[0].label');
    assert.ok(e);
  });

  it('rejects strength without detail', () => {
    const errs = v.validateStrengths([{ label: 'X' }]);
    const e = errs.find(x => x.field === 'strengths[0].detail');
    assert.ok(e);
  });
});

describe('validateTargetList', () => {
  it('passes through null (skip is allowed)', () => {
    assert.equal(v.validateTargetList(null).length, 0);
  });

  it('passes through undefined', () => {
    assert.equal(v.validateTargetList(undefined).length, 0);
  });

  it('rejects empty array (uploaded but no rows)', () => {
    const errs = v.validateTargetList([]);
    assert.equal(errs.length, 1);
    assert.equal(errs[0].code, 'min_length');
  });

  it('flags rows missing name', () => {
    const errs = v.validateTargetList([{ name: 'OK' }, { name: '' }, { foo: 'bar' }]);
    const e = errs.find(x => x.field === 'targets');
    assert.ok(e);
    assert.match(e.message, /2 件/);
  });

  it('accepts list with all names present', () => {
    const errs = v.validateTargetList([{ name: 'A' }, { name: 'B' }]);
    assert.equal(errs.length, 0);
  });

  it('accepts canonical target-list rows with companyName', () => {
    const errs = v.validateTargetList([{ companyName: 'A社' }, { companyName: 'B社' }]);
    assert.equal(errs.length, 0);
  });
});

describe('validateAiAuth', () => {
  it('passes when bypassAi=true even without status', () => {
    assert.equal(v.validateAiAuth(null, { bypassAi: true }).length, 0);
  });

  it('rejects null status without bypass', () => {
    const errs = v.validateAiAuth(null);
    assert.equal(errs.length, 1);
  });

  it('rejects when not installed', () => {
    const errs = v.validateAiAuth({ installed: false, loggedIn: false, providerLabel: 'Claude' });
    assert.ok(errs.length > 0);
  });

  it('rejects when installed but not logged in', () => {
    const errs = v.validateAiAuth({ installed: true, loggedIn: false, providerLabel: 'Claude' });
    assert.equal(errs.length, 1);
    assert.match(errs[0].message, /ログイン/);
  });

  it('accepts when fully connected', () => {
    const errs = v.validateAiAuth({ installed: true, loggedIn: true, providerLabel: 'Claude' });
    assert.equal(errs.length, 0);
  });
});

describe('validateAll', () => {
  it('aggregates errors across all steps', () => {
    const errs = v.validateAll({
      companyProfile: {},
      valuePropositions: { strengths: [] },
      targetList: null,
      aiAuthStatus: null,
    });
    // 5 (profile) + 1 (strengths) + 1 (ai auth) = 7
    assert.equal(errs.length, 7);
  });

  it('returns empty for fully valid payload with bypassAi', () => {
    const errs = v.validateAll({
      companyProfile: {
        companyName: 'X', contactName: 'Y', email: 'a@b.c', phone: '03-1234-5678', address: '東京都',
      },
      valuePropositions: { strengths: [{ label: 'L', detail: 'D' }] },
      targetList: [{ name: 'Co A' }],
      bypassAi: true,
    });
    assert.equal(errs.length, 0);
  });

  it('returns empty for fully valid payload with logged-in AI', () => {
    const errs = v.validateAll({
      companyProfile: {
        companyName: 'X', contactName: 'Y', email: 'a@b.c', phone: '03-1234-5678', address: '東京都',
      },
      valuePropositions: { strengths: [{ label: 'L', detail: 'D' }] },
      targetList: null,
      aiAuthStatus: { installed: true, loggedIn: true, providerLabel: 'Claude' },
    });
    assert.equal(errs.length, 0);
  });
});

console.log('\nall onboarding-validator tests passed.');

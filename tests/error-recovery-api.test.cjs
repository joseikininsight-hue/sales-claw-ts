'use strict';

const assert = require('node:assert/strict');
const recovery = require('../dist-ts/src/routes/error-recovery-api');

function describe(n, f) { console.log('\n=== ' + n + ' ==='); f(); }
function it(n, f) {
  try { f(); console.log('  OK  ' + n); }
  catch (e) { console.error('  FAIL ' + n + ' - ' + e.message); process.exitCode = 1; }
}

describe('categorizeError', () => {
  it('categorizes common no-form Japanese wording', () => {
    assert.equal(recovery.categorizeError('フォームが見つからないため停止').key, 'no_form');
    assert.equal(recovery.categorizeError('お問い合わせフォームなし').key, 'no_form');
    assert.equal(recovery.categorizeError('問い合わせ窓口が見当たらない').key, 'no_form');
    assert.equal(recovery.categorizeError('フォームURL未解決').key, 'no_form');
  });

  it('categorizes captcha and timeout', () => {
    assert.equal(recovery.categorizeError('CAPTCHA検出').key, 'captcha');
    assert.equal(recovery.categorizeError('フェーズB遷移タイムアウト').key, 'timeout');
  });
});

describe('company error extraction', () => {
  it('extracts reason from nested/latest log fields', () => {
    assert.equal(recovery.getCompanyErrorReason({
      logs: [
        { action: 'site_analysis', details: 'ok' },
        { action: 'error', details: 'CAPTCHA検出' },
      ],
    }), 'CAPTCHA検出');
    assert.equal(recovery.getCompanyErrorReason({
      lastLog: { details: 'フォームURL未解決' },
    }), 'フォームURL未解決');
  });

  it('detects errored companies case-insensitively', () => {
    assert.equal(recovery.isErroredCompany({ lastAction: 'ERROR' }), true);
    assert.equal(recovery.isErroredCompany({ status: 'Error' }), true);
    assert.equal(recovery.isErroredCompany({ status: 'awaiting_approval' }), false);
  });
});

console.log('\nall error-recovery-api tests passed.');

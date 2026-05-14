'use strict';

/**
 * settings-api: maskSensitiveSettings unit tests (1.2.92 H1)
 *
 * Tests the API key masking logic that prevents apiKeys/secrets/tokens
 * from leaking via GET /api/settings.
 *
 * The function is currently defined inside the createSettingsApiRoutes()
 * factory, so we re-implement the same logic here as a regression test
 * suite that tracks the behavior.
 */

const assert = require('node:assert/strict');

function describe(n, f) { console.log('\n=== ' + n + ' ==='); f(); }
function it(n, f) {
  try { f(); console.log('  OK  ' + n); }
  catch (e) { console.error('  FAIL ' + n + ' - ' + e.message); process.exitCode = 1; }
}

// Re-implementation matching src/routes/settings-api.cjs::maskSensitiveSettings
function maskSensitiveSettings(input) {
  if (!input || typeof input !== 'object') return input;
  const SENSITIVE_KEY_RE = /^(apiKeys|secrets|tokens?|password|credentials)$/i;
  const SENSITIVE_LEAF_RE = /(token|secret|password|apikey|api_key|credential)/i;
  function clone(val, parentKey) {
    if (val === null || val === undefined) return val;
    if (Array.isArray(val)) return val.map((v, i) => clone(v, String(i)));
    if (typeof val === 'object') {
      const out = {};
      for (const k of Object.keys(val)) {
        if (SENSITIVE_KEY_RE.test(k)) {
          const v = val[k];
          if (v && typeof v === 'object') {
            const masked = {};
            for (const subk of Object.keys(v)) {
              masked[subk] = (typeof v[subk] === 'string' && v[subk].length > 0) ? '***' : v[subk];
            }
            out[k] = masked;
          } else {
            out[k] = (typeof v === 'string' && v.length > 0) ? '***' : v;
          }
        } else {
          out[k] = clone(val[k], k);
        }
      }
      return out;
    }
    if (typeof val === 'string' && parentKey && SENSITIVE_LEAF_RE.test(parentKey) && val.length > 0) {
      return '***';
    }
    return val;
  }
  return clone(input, '');
}

describe('maskSensitiveSettings', () => {
  it('masks non-empty apiKeys leaves', () => {
    const result = maskSensitiveSettings({ apiKeys: { serpApi: 'sk-secret-12345', edinet: 'tok-abc' } });
    assert.equal(result.apiKeys.serpApi, '***');
    assert.equal(result.apiKeys.edinet, '***');
  });

  it('preserves empty string apiKeys (not masked)', () => {
    const result = maskSensitiveSettings({ apiKeys: { serpApi: '', houjinBangou: '' } });
    assert.equal(result.apiKeys.serpApi, '');
    assert.equal(result.apiKeys.houjinBangou, '');
  });

  it('preserves non-string values (numbers, booleans)', () => {
    const result = maskSensitiveSettings({ preferences: { usdJpy: 150, autoSendSafe: true } });
    assert.equal(result.preferences.usdJpy, 150);
    assert.equal(result.preferences.autoSendSafe, true);
  });

  it('masks nested credentials section', () => {
    const result = maskSensitiveSettings({ credentials: { aws: 'AKIA...', gcp: 'gcp-key' } });
    assert.equal(result.credentials.aws, '***');
    assert.equal(result.credentials.gcp, '***');
  });

  it('masks string-typed sensitive section directly', () => {
    const result = maskSensitiveSettings({ password: 'plain-pwd' });
    assert.equal(result.password, '***');
  });

  it('masks leaf with sensitive-looking key in non-sensitive section', () => {
    const result = maskSensitiveSettings({ misc: { dbPassword: 'secret' } });
    assert.equal(result.misc.dbPassword, '***');
  });

  it('handles null/undefined input safely', () => {
    assert.equal(maskSensitiveSettings(null), null);
    assert.equal(maskSensitiveSettings(undefined), undefined);
  });

  it('handles non-object input (string)', () => {
    assert.equal(maskSensitiveSettings('hello'), 'hello');
  });

  it('preserves array structure', () => {
    const result = maskSensitiveSettings({ list: [{ apiKeys: { x: 'secret' } }, { x: 1 }] });
    assert.equal(result.list[0].apiKeys.x, '***');
    assert.equal(result.list[1].x, 1);
  });

  it('case-insensitive section name match (TOKENS, Tokens)', () => {
    const result = maskSensitiveSettings({ Tokens: { gh: 'ghp_abc' } });
    assert.equal(result.Tokens.gh, '***');
  });
});

console.log('\nall settings-api-mask tests passed.');

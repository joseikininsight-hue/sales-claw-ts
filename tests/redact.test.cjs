'use strict';

/**
 * Unit tests for src/ai-runtime/redact.cjs
 *
 * シンプルな自前 assert で書いている (mocha/jest 等を導入しない)。
 * 実行: `node tests/redact.test.cjs`
 * 終了コード: 0 = 全 PASS / 1 = 失敗あり
 */

const { redactSecrets, findSecretMatches, setRedactDebugHook } = require('../dist-ts/src/ai-runtime/redact');

let passed = 0;
let failed = 0;
const failures = [];

function assertEquals(actual, expected, message) {
  if (actual === expected) {
    passed += 1;
    return;
  }
  failed += 1;
  failures.push({ message, actual, expected });
}

function assertContains(actual, needle, message) {
  if (typeof actual === 'string' && actual.includes(needle)) {
    passed += 1;
    return;
  }
  failed += 1;
  failures.push({ message, actual, expected: 'contains: ' + needle });
}

function assertNotContains(actual, needle, message) {
  if (typeof actual === 'string' && !actual.includes(needle)) {
    passed += 1;
    return;
  }
  failed += 1;
  failures.push({ message, actual, expected: 'NOT contains: ' + needle });
}

// ────────────────────────────────────────────────────────────
// Anthropic API key (sk-ant-)
// ────────────────────────────────────────────────────────────
{
  const text = 'export ANTHROPIC_API_KEY=sk-ant-api03-0123456789abcdefABCDEFGHIJKLMNOPQRSTUVWXYZ-_=abc123';
  const out = redactSecrets(text);
  assertContains(out, '[REDACTED:api-key]', 'sk-ant- key should be redacted');
  assertNotContains(out, 'sk-ant-api03-', 'original Anthropic key must not survive');
}

// ────────────────────────────────────────────────────────────
// OpenAI API key (sk-)
// ────────────────────────────────────────────────────────────
{
  const text = 'OPENAI_API_KEY=sk-proj-1234567890abcdef1234567890abcdef1234567890abcdef';
  const out = redactSecrets(text);
  assertContains(out, '[REDACTED:api-key]', 'sk-proj- key should be redacted');
  assertNotContains(out, 'sk-proj-', 'OpenAI key must not survive');
}

// ────────────────────────────────────────────────────────────
// GitHub PAT
// ────────────────────────────────────────────────────────────
{
  const cases = [
    'ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    'ghs_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    'gho_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
    'ghu_DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD',
  ];
  for (const c of cases) {
    const out = redactSecrets(`token=${c} suffix`);
    assertContains(out, '[REDACTED:github]', `${c.slice(0, 4)} should be redacted`);
    assertNotContains(out, c, `original ${c.slice(0, 4)} must not survive`);
  }
}

// ────────────────────────────────────────────────────────────
// AWS access key
// ────────────────────────────────────────────────────────────
{
  const text = 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE';
  const out = redactSecrets(text);
  assertContains(out, '[REDACTED:aws]', 'AKIA key should be redacted');
  assertNotContains(out, 'AKIAIOSFODNN7EXAMPLE', 'AWS key must not survive');
}

// ────────────────────────────────────────────────────────────
// Google API key
// ────────────────────────────────────────────────────────────
{
  // Real Google API key shape: AIza + exactly 35 chars.
  // String is split at literal level so GitHub secret-scanner does not
  // flag the test fixture as a leaked credential (this is a dummy value).
  const fixture = 'AIza' + 'SyD1234567890abcdefghijklmnopqrstuv';
  const text = `gcp key: ${fixture}`;
  const out = redactSecrets(text);
  assertContains(out, '[REDACTED:gcp]', 'AIza key should be redacted');
  assertNotContains(out, fixture.slice(0, 8), 'GCP key must not survive');
}

// ────────────────────────────────────────────────────────────
// JWT
// ────────────────────────────────────────────────────────────
{
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
  const out = redactSecrets(`Authorization: ${jwt}`);
  assertContains(out, '[REDACTED:jwt]', 'JWT should be redacted');
  assertNotContains(out, jwt, 'original JWT must not survive');
}

// ────────────────────────────────────────────────────────────
// Bearer token (Authorization header value preserved key, value masked)
// ────────────────────────────────────────────────────────────
{
  const text = 'Authorization: Bearer abcdef1234567890ABCDEF';
  const out = redactSecrets(text);
  assertContains(out, 'Authorization: Bearer ', 'header name and Bearer prefix preserved');
  assertContains(out, '[REDACTED:bearer]', 'Bearer value redacted');
  assertNotContains(out, 'abcdef1234567890ABCDEF', 'original bearer value must not survive');
}

// ────────────────────────────────────────────────────────────
// Bearer/Basic without Authorization prefix (custom header / curl)
// ────────────────────────────────────────────────────────────
{
  const text1 = 'curl -H "X-Token: Bearer abcdef1234567890ABCDEFGH"';
  const out1 = redactSecrets(text1);
  assertContains(out1, '[REDACTED:bearer]', 'Bearer in custom header value redacted');
  assertNotContains(out1, 'abcdef1234567890ABCDEFGH', 'custom-header bearer must not survive');

  const text2 = 'curl --header "Auth: Bearer ZZZZZZZZZZZZZZZZZZZZ"';
  const out2 = redactSecrets(text2);
  assertContains(out2, '[REDACTED:bearer]', 'Bearer behind Auth: prefix redacted');
  assertNotContains(out2, 'ZZZZZZZZZZZZZZZZZZZZ', 'custom Auth: bearer must not survive');

  const text3 = 'Basic dXNlcjpwYXNzd29yZA==';
  const out3 = redactSecrets(text3);
  assertContains(out3, '[REDACTED:basic-auth]', 'Basic without Authorization prefix redacted');
}

// ────────────────────────────────────────────────────────────
// Custom secret-bearing headers (X-API-Key etc.)
// ────────────────────────────────────────────────────────────
{
  const cases = [
    'X-API-Key: ABC1234567890XYZ',
    'X-Auth-Token: abcdef1234567890',
    'X-Access-Token: tok_zzzzzzzzzzzzz',
    'X-Session-Token: sess_aaaaaaaaaaaaaa',
  ];
  for (const c of cases) {
    const out = redactSecrets(c);
    assertContains(out, '[REDACTED:bearer]', `${c.split(':')[0]} value redacted`);
    assertNotContains(out, c.split(': ')[1], `${c.split(':')[0]} value must not survive`);
  }
}

// ────────────────────────────────────────────────────────────
// PEM private key (multi-line)
// ────────────────────────────────────────────────────────────
{
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEAabc...\n-----END RSA PRIVATE KEY-----';
  const out = redactSecrets(`pem:\n${pem}\nend.`);
  assertContains(out, '[REDACTED:private-key]', 'PEM block should be redacted');
  assertNotContains(out, 'MIIEpAIBAAKCAQEA', 'PEM body must not survive');
}

// ────────────────────────────────────────────────────────────
// PEM ENCRYPTED PRIVATE KEY (PKCS#8 暗号化鍵, bug_002a)
// ────────────────────────────────────────────────────────────
{
  const pem = '-----BEGIN ENCRYPTED PRIVATE KEY-----\nMIIFHDBOBgkqhkiG9w0BBQ0wQTApBgkqhkiG9w0BBQwwHAQI...\n-----END ENCRYPTED PRIVATE KEY-----';
  const out = redactSecrets(`config:\n${pem}\nend.`);
  assertContains(out, '[REDACTED:private-key]', 'ENCRYPTED PRIVATE KEY block should be redacted');
  assertNotContains(out, 'MIIFHDBOBgkqhkiG9w0BBQ0wQTApBgkqhkiG9w0BBQwwHAQI', 'encrypted PEM body must not survive');
}

// ────────────────────────────────────────────────────────────
// PEM chunk-split fallback: BEGIN/END markers on isolated lines (bug_002b)
// ────────────────────────────────────────────────────────────
{
  // Simulate a chunk that contains ONLY the BEGIN marker (END came in next chunk)
  const chunk1 = 'log line\nsome text -----BEGIN RSA PRIVATE KEY----- and some more\nnext line';
  const out1 = redactSecrets(chunk1);
  assertNotContains(out1, '-----BEGIN RSA PRIVATE KEY-----', 'isolated BEGIN line should be redacted');
  assertContains(out1, '[REDACTED:private-key]', 'fallback marker present');

  // Simulate END-only chunk
  const chunk2 = 'tail line\n-----END RSA PRIVATE KEY-----\nokay';
  const out2 = redactSecrets(chunk2);
  assertNotContains(out2, '-----END RSA PRIVATE KEY-----', 'isolated END line should be redacted');

  // ENCRYPTED variant should also be caught at line level
  const chunk3 = '-----BEGIN ENCRYPTED PRIVATE KEY-----';
  const out3 = redactSecrets(chunk3);
  assertNotContains(out3, '-----BEGIN ENCRYPTED PRIVATE KEY-----', 'ENCRYPTED begin line caught');
}

// ────────────────────────────────────────────────────────────
// password=... in URL query
// ────────────────────────────────────────────────────────────
{
  const text = 'curl https://example.com/?user=foo&password=hunter2&page=1';
  const out = redactSecrets(text);
  assertContains(out, 'password=[REDACTED:password]', 'password= value redacted, key preserved');
  assertNotContains(out, 'hunter2', 'password value must not survive');
  assertContains(out, 'user=foo', 'unrelated query param preserved');
  assertContains(out, 'page=1', 'unrelated query param preserved');
}

// ────────────────────────────────────────────────────────────
// Mixed: plain log line with one secret, rest preserved
// ────────────────────────────────────────────────────────────
{
  // Suffix isolated with whitespace because [A-Za-z0-9_-] regex is greedy
  // (intentional: we want the WHOLE token consumed, even if it has dashes).
  const text = 'starting claude --api-key sk-ant-api03-XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX done';
  const out = redactSecrets(text);
  assertContains(out, 'starting claude', 'prefix preserved');
  assertContains(out, ' done', 'suffix preserved');
  assertNotContains(out, 'sk-ant-api03', 'key must not survive');
}

// ────────────────────────────────────────────────────────────
// Empty / null / non-string inputs are handled gracefully
// ────────────────────────────────────────────────────────────
{
  assertEquals(redactSecrets(''), '', 'empty string returns empty');
  assertEquals(redactSecrets(null), null, 'null returns null');
  assertEquals(redactSecrets(undefined), undefined, 'undefined returns undefined');
  assertEquals(redactSecrets(42), 42, 'number returns number');
}

// ────────────────────────────────────────────────────────────
// Idempotency: redacting a redacted string should be stable
// ────────────────────────────────────────────────────────────
{
  const original = 'sk-ant-api03-XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
  const once = redactSecrets(original);
  const twice = redactSecrets(once);
  assertEquals(once, twice, 'redaction is idempotent');
}

// ────────────────────────────────────────────────────────────
// findSecretMatches enumerates all matches (debug / test only)
// ────────────────────────────────────────────────────────────
{
  const text = 'a sk-ant-api03-XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX b ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA c';
  const matches = findSecretMatches(text);
  assertEquals(matches.length >= 2, true, 'at least 2 matches expected');
  const labels = matches.map((m) => m.label).sort();
  assertContains(labels.join(','), 'api-key', 'api-key label appears');
  assertContains(labels.join(','), 'github', 'github label appears');
}

// ────────────────────────────────────────────────────────────
// False positive guard: ordinary identifiers must NOT be redacted
// ────────────────────────────────────────────────────────────
{
  const benign = 'function getCompanyByNo(no) { return companies.find(c => c.no === no); }';
  assertEquals(redactSecrets(benign), benign, 'plain JS code must not be touched');

  const url = 'https://example.com/path/to/resource?lang=ja';
  assertEquals(redactSecrets(url), url, 'plain URL must not be touched');

  const log = '[2026-04-27T11:30:00Z] [info] connected to dashboard on port 3765';
  assertEquals(redactSecrets(log), log, 'normal log line must not be touched');
}

// ────────────────────────────────────────────────────────────
// Debug hook fires only when there ARE matches
// ────────────────────────────────────────────────────────────
{
  let calls = [];
  setRedactDebugHook((matches, len) => {
    calls.push({ count: matches.length, len });
  });

  // Ordinary log line — must NOT trigger hook
  redactSecrets('starting analysis for company 123');
  assertEquals(calls.length, 0, 'debug hook silent on benign input');

  // Secret-bearing line — must trigger hook
  redactSecrets('token=ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA next');
  assertEquals(calls.length, 1, 'debug hook fires when there are matches');
  assertEquals(calls[0].count >= 1, true, 'hook receives at least one match');

  // Disable hook
  setRedactDebugHook(null);
  redactSecrets('token=ghp_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB next');
  assertEquals(calls.length, 1, 'hook disabled, no further calls');
}

// ────────────────────────────────────────────────────────────
// Output
// ────────────────────────────────────────────────────────────
console.log('');
console.log(`PASSED: ${passed}`);
console.log(`FAILED: ${failed}`);
if (failed > 0) {
  console.log('');
  for (const f of failures) {
    console.log(`  FAIL: ${f.message}`);
    console.log(`    actual:   ${JSON.stringify(f.actual).slice(0, 200)}`);
    console.log(`    expected: ${JSON.stringify(f.expected).slice(0, 200)}`);
  }
  process.exitCode = 1;
} else {
  console.log('');
  console.log('all redaction tests passed.');
}

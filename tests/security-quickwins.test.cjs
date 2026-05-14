'use strict';

/**
 * Tests for High-priority security quick wins:
 *   H4: __proto__ guard in deepMerge (prototype pollution defense)
 *   H10: isSafeDashboardUrl (loopback-only URL validator)
 *
 * H7 (install script kill scope) is a shell script, tested via diff review.
 * H12 (PTY WS raw bytes) is integration-level, tested via running Sales Claw.
 *
 * Run: node tests/security-quickwins.test.cjs
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// Use a sandbox dir so we don't touch real settings
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'sales-claw-secquick-test-'));
process.env.SALES_CLAW_USER_DATA_DIR = sandbox;

const settings = require('../dist-ts/src/settings-manager');

let passed = 0;
let failed = 0;
const failures = [];

function assert(cond, message) {
  if (cond) { passed += 1; return; }
  failed += 1;
  failures.push(message);
}

// ────────────────────────────────────────────────────────────
// H4: __proto__ injection via PUT /api/settings/:section payload
// (deepMerge is the merge primitive used by updateSection)
// ────────────────────────────────────────────────────────────
{
  // Sanity: Object.prototype is clean before
  assert(typeof ({}).__pollutedH4 === 'undefined', 'pre: Object.prototype clean');

  // Attacker-controlled payload that would normally pollute prototype
  const evil = JSON.parse('{"__proto__": {"__pollutedH4": "p0wned"}}');

  // Direct invocation through the public API: updateSection.
  // We need a section that accepts arbitrary nested objects; messageTemplates
  // typically does. Use it with the evil payload.
  try {
    settings.updateSection('messageTemplates', evil);
  } catch (e) {
    // updateSection might throw if section validation rejects; that's fine.
  }

  // Object.prototype must NOT be polluted
  assert(typeof ({}).__pollutedH4 === 'undefined',
    `post: Object.prototype must remain clean (got typeof ({}).__pollutedH4 = ${typeof ({}).__pollutedH4})`);

  // Same for arrays / null-proto objects
  assert(typeof ([]).__pollutedH4 === 'undefined', 'post: arrays not polluted');
  assert(typeof (Object.create(null)).__pollutedH4 === 'undefined', 'post: null-proto objects not polluted');

  // Bonus: constructor / prototype keys also blocked
  const evilCtor = JSON.parse('{"constructor": {"prototype": {"__pollutedH4ctor": "p0wned"}}}');
  try { settings.updateSection('messageTemplates', evilCtor); } catch (_) {}
  assert(typeof ({}).__pollutedH4ctor === 'undefined', 'post: constructor.prototype walk blocked');
}

// ────────────────────────────────────────────────────────────
// H10: isSafeDashboardUrl validator
// We can't require electron-main.js (it instantiates Electron), so we
// test the same logic by extracting it inline. If the implementation
// drifts, this test must be updated alongside.
// ────────────────────────────────────────────────────────────
function isSafeDashboardUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) return false;
  let parsed;
  try { parsed = new URL(rawUrl); } catch { return false; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') return false;
  return true;
}

// True positives — should be allowed
{
  const allowed = [
    'http://127.0.0.1:3765',
    'http://127.0.0.1:3765/',
    'http://localhost:3765',
    'http://localhost:3765/dashboard',
    'http://[::1]:3765',
    'https://127.0.0.1:3765',
  ];
  for (const url of allowed) {
    assert(isSafeDashboardUrl(url), `should allow: ${url}`);
  }
}

// True negatives — must be blocked
{
  const blocked = [
    'javascript:alert(1)',
    'file:///etc/passwd',
    'file://C:/Windows/System32/calc.exe',
    'data:text/html,<script>alert(1)</script>',
    'http://evil.com/',
    'http://192.168.1.1:3765',
    'http://10.0.0.1:3765',
    'http://attacker.example.com/',
    'about:blank',
    '',
    null,
    undefined,
    'http://',                       // malformed
    'not-a-url',
    'http://127.0.0.1.evil.com:3765', // suffix attack
    'http://localhost.evil.com:3765',
  ];
  for (const url of blocked) {
    assert(!isSafeDashboardUrl(url), `should BLOCK: ${JSON.stringify(url)}`);
  }
}

// Cleanup
try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch (_) {}

// ────────────────────────────────────────────────────────────
// Output
// ────────────────────────────────────────────────────────────
console.log('');
console.log(`PASSED: ${passed}`);
console.log(`FAILED: ${failed}`);
if (failed > 0) {
  for (const f of failures) console.log(`  FAIL: ${f}`);
  process.exitCode = 1;
} else {
  console.log('all security-quickwins tests passed.');
}

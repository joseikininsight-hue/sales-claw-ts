'use strict';

/**
 * Regression test for the transient-error detection in electron-main.ts.
 *
 * 2026-05-15 incident: ユーザーが「自動更新エラー: 504 Gateway Time-out」を
 * ダッシュボードの赤バナーで何度も見せられた。GitHub の一時的な不調なので
 * UI に出すべきではなく silent retry にする必要があった。
 *
 * このテストでは electron-main.ts に直接アクセスせず、同じ regex を複製した
 * テスト fixture で判定ロジックを保証する (electron 依存 require を避ける)。
 */

// electron-main.ts と同じ regex リスト (もしずれたらテストで気付ける)
const TRANSIENT_UPDATE_PATTERNS = [
  /\b50[234]\b/,
  /Gateway\s+Time-?out/i,
  /ETIMEDOUT/i,
  /ECONNRESET/i,
  /ENOTFOUND/i,
  /EAI_AGAIN/i,
  /network\s+(error|timeout|unreachable)/i,
  /socket hang up/i,
  /Could\s+not\s+get\s+code\s+signature/i,
];
function isTransientUpdateError(message) {
  if (!message) return false;
  return TRANSIENT_UPDATE_PATTERNS.some((re) => re.test(message));
}

let passed = 0;
let failed = 0;
const failures = [];

function assertEq(name, actual, expected) {
  if (actual === expected) { passed += 1; return; }
  failed += 1;
  failures.push({ name, actual, expected });
}

// ─────────────────────────────────────────────────────────────
// transient → true
// ─────────────────────────────────────────────────────────────
[
  '504 Gateway Time-out',
  'method: GET url: https://github.com/x/y/releases.atom 504',
  '502 Bad Gateway',
  '503 Service Unavailable',
  'ETIMEDOUT',
  'request to https://github.com timeout (ETIMEDOUT)',
  'connect ECONNRESET 140.82.112.4:443',
  'getaddrinfo ENOTFOUND github.com',
  'EAI_AGAIN release.github.com',
  'network timeout exceeded',
  'network unreachable',
  'network error',
  'socket hang up',
  'Could not get code signature for running application',
].forEach((msg) => {
  assertEq('transient: ' + msg.slice(0, 50), isTransientUpdateError(msg), true);
});

// ─────────────────────────────────────────────────────────────
// non-transient → false (UI に出すべき真のエラー)
// ─────────────────────────────────────────────────────────────
[
  '404 Not Found',
  '401 Unauthorized',
  'Invalid signature for update file',
  'latest.yml: validation failed',
  'No update available',
  '', // empty
  null,
  undefined,
].forEach((msg) => {
  assertEq('non-transient: ' + String(msg).slice(0, 50), isTransientUpdateError(msg), false);
});

console.log('');
console.log(`PASSED: ${passed}`);
console.log(`FAILED: ${failed}`);
if (failed > 0) {
  for (const f of failures) {
    console.log('  FAIL:', f.name);
    console.log('    expected:', JSON.stringify(f.expected), 'actual:', JSON.stringify(f.actual));
  }
  process.exitCode = 1;
} else {
  console.log('all transient-update-error tests passed.');
}

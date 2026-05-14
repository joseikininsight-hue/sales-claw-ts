'use strict';

/**
 * Unit tests for src/mcp-idempotency.ts
 *
 * 2026-05-15 のフォーム入力 stuck 事故を再発させないための regression test。
 * Phase B 自動起動時に `claude mcp add playwright` が "already exists in
 * user config" で fail → ensureProviderPlaywrightMcp が false を返す →
 * フォーム入力が 47 バッチ滞留した。
 *
 * isAlreadyExistsError がベンダー横断 (claude/codex/gemini) で確実に
 * 「冪等性エラー」を識別できることを保証する。
 */

const { isAlreadyExistsError, isNotFoundError } = require('../dist-ts/src/mcp-idempotency');

let passed = 0;
let failed = 0;
const failures = [];

function assertEq(name, actual, expected) {
  if (actual === expected) { passed += 1; return; }
  failed += 1;
  failures.push({ name, actual, expected });
}

// ─────────────────────────────────────────────────────────────
// isAlreadyExistsError
// ─────────────────────────────────────────────────────────────

// 実際の claude CLI のエラー文言
assertEq(
  'claude: MCP server playwright already exists in user config',
  isAlreadyExistsError('Error: MCP server playwright already exists in user config'),
  true,
);
// codex
assertEq(
  'codex: server already registered',
  isAlreadyExistsError('server "playwright" is already registered'),
  true,
);
// gemini
assertEq(
  'gemini: already configured',
  isAlreadyExistsError('playwright already configured'),
  true,
);
// 汎用
assertEq(
  'generic: duplicate entry',
  isAlreadyExistsError('duplicate entry: playwright'),
  true,
);
assertEq(
  'case-insensitive: ALREADY EXISTS',
  isAlreadyExistsError('ALREADY EXISTS'),
  true,
);

// false 判定 (関係ないエラー)
assertEq(
  'unrelated: connection refused',
  isAlreadyExistsError('connection refused'),
  false,
);
assertEq(
  'unrelated: invalid argument',
  isAlreadyExistsError('Invalid argument: --foo'),
  false,
);
assertEq(
  'unrelated: permission denied',
  isAlreadyExistsError('Permission denied'),
  false,
);
assertEq(
  'empty string',
  isAlreadyExistsError(''),
  false,
);
assertEq(
  'null',
  isAlreadyExistsError(null),
  false,
);
assertEq(
  'undefined',
  isAlreadyExistsError(undefined),
  false,
);

// ─────────────────────────────────────────────────────────────
// isNotFoundError
// ─────────────────────────────────────────────────────────────

assertEq(
  'not found',
  isNotFoundError('MCP server playwright not found'),
  true,
);
assertEq(
  'does not exist',
  isNotFoundError('server "playwright" does not exist'),
  true,
);
assertEq(
  'no such server',
  isNotFoundError('no such server: playwright'),
  true,
);
assertEq(
  'unknown server',
  isNotFoundError('unknown server: playwright'),
  true,
);

assertEq(
  'unrelated for notFound: invalid arg',
  isNotFoundError('Invalid argument'),
  false,
);
assertEq(
  'unrelated for notFound: empty',
  isNotFoundError(''),
  false,
);

// ─────────────────────────────────────────────────────────────
// 互いに衝突しない (同じ文字列で両方 true にならない)
// ─────────────────────────────────────────────────────────────
const conflictCheck = (msg) => {
  const aE = isAlreadyExistsError(msg);
  const nF = isNotFoundError(msg);
  return !(aE && nF);  // 両方 true は NG
};
assertEq('claude already exists not also notFound', conflictCheck('MCP server playwright already exists'), true);
assertEq('not found not also already exists', conflictCheck('MCP server playwright not found'), true);

// ─────────────────────────────────────────────────────────────
// Output
// ─────────────────────────────────────────────────────────────
console.log('');
console.log(`PASSED: ${passed}`);
console.log(`FAILED: ${failed}`);
if (failed > 0) {
  for (const f of failures) {
    console.log(`  FAIL: ${f.name}`);
    console.log(`    actual:   ${JSON.stringify(f.actual)}`);
    console.log(`    expected: ${JSON.stringify(f.expected)}`);
  }
  process.exitCode = 1;
} else {
  console.log('all mcp-idempotency tests passed.');
}

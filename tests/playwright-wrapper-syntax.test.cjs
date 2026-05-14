'use strict';

/**
 * Regression test: ensureToolchainFiles() must emit valid CommonJS for
 *                  playwright-mcp-wrapper.cjs.
 *
 * 過去ケース (2026-05-14): src/local-toolchain.ts 内の TS 型注釈
 *   (`let entries: any[]`, `(entry: any)`) が .cjs テンプレ文字列リテラルに
 *   混入し、生成された playwright-mcp-wrapper.cjs が Node の SyntaxError で
 *   クラッシュ。結果として ensureClaudeAutomationReady が
 *   「Playwright MCP / Chromium が未準備です」を返し、AI CLI が起動不能になった。
 *
 * このテストは、テンプレ文字列に TS 構文が再混入したら CI を落とす。
 *
 * 実行: `node tests/playwright-wrapper-syntax.test.cjs`
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

let passed = 0;
let failed = 0;
const failures = [];

function assert(cond, message) {
  if (cond) { passed += 1; return; }
  failed += 1;
  failures.push(message);
}

// 一時 userData ディレクトリに切り替えて副作用を隔離
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'salesclaw-toolchain-test-'));
const prevEnv = process.env.SALES_CLAW_USER_DATA_DIR;
process.env.SALES_CLAW_USER_DATA_DIR = tmpRoot;

try {
  const toolchain = require('../dist-ts/src/local-toolchain');
  toolchain.ensureToolchainFiles();

  const wrapperFile = path.join(tmpRoot, 'tools', 'bin', 'playwright-mcp-wrapper.cjs');
  assert(fs.existsSync(wrapperFile), `wrapper.cjs が生成されていない: ${wrapperFile}`);

  if (fs.existsSync(wrapperFile)) {
    const source = fs.readFileSync(wrapperFile, 'utf8');

    // TS 型注釈の混入を検出
    assert(!/:\s*any(?:\[\])?\s*[=,);]/.test(source),
      'wrapper.cjs に TS 型注釈 ": any" / ": any[]" が混入している');
    assert(!/\(\s*[A-Za-z_$][\w$]*\s*:\s*[A-Za-z]/.test(source),
      'wrapper.cjs にパラメータ型注釈 ("(x: Foo)") が混入している');

    // Node でパースできることを確認
    let parseError = null;
    try {
      new vm.Script(source, { filename: wrapperFile });
    } catch (e) {
      parseError = e.message;
    }
    assert(parseError === null, `wrapper.cjs が Node でパースできない: ${parseError}`);
  }
} finally {
  if (prevEnv === undefined) delete process.env.SALES_CLAW_USER_DATA_DIR;
  else process.env.SALES_CLAW_USER_DATA_DIR = prevEnv;
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}
}

console.log(`\nPlaywright wrapper syntax tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of failures) console.error('  FAIL: ' + f);
  process.exit(1);
}

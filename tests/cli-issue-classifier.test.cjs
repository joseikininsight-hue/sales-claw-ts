'use strict';

/**
 * Unit tests for src/cli-issue-classifier.cjs
 *
 * Regression tests target the actual false-positive samples that the user
 * pasted from CLI Activity log on 2026-04-27 (sample batch fixtures).
 * Every fixture is a real chunk of PTY output —
 * if any of them re-classifies as 'MCP接続エラー' the test fails.
 *
 * Run: node tests/cli-issue-classifier.test.cjs
 */

const { classifyCliText } = require('../dist-ts/src/cli-issue-classifier');

let passed = 0;
let failed = 0;
const failures = [];

function assertNoMatch(text, message) {
  const result = classifyCliText(text);
  if (result === null) { passed += 1; return; }
  failed += 1;
  failures.push({ message, gotLabel: result.rule.label, gotLine: result.line });
}

function assertMatchLabel(text, expectedLabel, message) {
  const result = classifyCliText(text);
  if (result && result.rule.label === expectedLabel) { passed += 1; return; }
  failed += 1;
  failures.push({ message, expected: expectedLabel, got: result ? result.rule.label : '(no match)' });
}

// ────────────────────────────────────────────────────────────────────
// Regression: real false-positive chunks from 2026-04-27 user logs
//
// These should NOT classify as 'MCP接続エラー' (the original false-positive
// label that polluted CLI Activity).  They MAY classify as
// 'Electron モード推奨' (a constructive WARN hint) since Sales Claw is
// running and Form Session API is available — that's better UX than
// silently dropping the signal.
// ────────────────────────────────────────────────────────────────────
const fixtureCompanyNarrativeWithMcpMention = `
ご興味がございましたら、30分程度の情報交換の場をいただけないでしょうか。
貴社のお取り組みについてもお伺いできれば幸いです。
サンプル株式会社
サンプル 太郎
TEL: 03-0000-0000 MAIL: sample@example.com
---
次にフォームを探索します。
Ran 1 shell command
●MCP Playwright ツールが見当たりません。CLAUDE.md の規定に従い、error ログを記録してユーザーに通知します。
Ran 1 shell command
●No.18 サンプル取引先 — エラー停止
現在のセッションで MCP Playwright (browser_* ツール) が接続されていません。
`;
{
  // Critical regression: must NOT be the alarming 'MCP接続エラー' label
  const result = classifyCliText(fixtureCompanyNarrativeWithMcpMention);
  if (result && result.rule.label === 'MCP接続エラー') {
    failed += 1;
    failures.push({ message: 'company narrative MUST NOT classify as MCP接続エラー (the original spam)', got: result.rule.label });
  } else {
    passed += 1;
  }
}
// And it SHOULD classify as the constructive Electron hint
assertMatchLabel(fixtureCompanyNarrativeWithMcpMention, 'Electron モード推奨', 'narrative classifies as actionable Electron hint instead');

const fixtureClaudeBanner = '▐▛███▜▌ Claude Code v2.1.119';
assertNoMatch(fixtureClaudeBanner, 'Claude banner must not classify');

const fixtureMcpToolListing = `
Project MCPs:
  playwright    connected
  /mcp for help
`;
assertNoMatch(fixtureMcpToolListing, '/mcp listing output must not classify (excludePattern)');

const fixtureCompanyName = 'サンプル株式会社';
assertNoMatch(fixtureCompanyName, 'short company name must not classify');

const fixtureMessageBody = `もしご関心をお持ちいただけましたら、短時間でも情報交換の機会をいただけますと幸いです。
貴社の取り組みについても伺えればと思っております。何卒よろしくお願いいたします。`;
assertNoMatch(fixtureMessageBody, 'outreach message body must not classify');

const fixturePartnerUrl = 'https://www.example.com/lp/partner_sample/';
assertNoMatch(fixturePartnerUrl, 'partner URL must not classify');

// ────────────────────────────────────────────────────────────────────
// Electron mode hint — narrative-style "MCP missing" classifies as
// actionable WARN (not error), since Sales Claw process being up means
// the Form Session API alternative exists.
// ────────────────────────────────────────────────────────────────────
{
  const cases = [
    'MCP Playwright ツールが見当たりません',
    'MCP Playwright が見つかりません',
    'MCP Playwright (browser_* ツール) が接続されていません',
    'MCP Playwright not connected',
    'MCP Playwright not found',
    'browser_* ツールが見当たりません',
  ];
  for (const c of cases) {
    const result = classifyCliText(c);
    if (result && result.rule.label === 'Electron モード推奨' && result.rule.type === 'warn') {
      passed += 1;
    } else {
      failed += 1;
      failures.push({ message: `"${c}" should classify as Electron モード推奨 (warn)`, got: result ? `${result.rule.label} (${result.rule.type})` : '(no match)' });
    }
  }
}

// ────────────────────────────────────────────────────────────────────
// True positives — these MUST still classify
// ────────────────────────────────────────────────────────────────────
const fixtureRealMcpFail = 'MCP server playwright failed to connect: ECONNREFUSED 127.0.0.1:5555';
assertMatchLabel(fixtureRealMcpFail, 'MCP接続エラー', 'real MCP server failure must classify');

const fixtureRealMcpExited = 'Error: MCP server playwright exited unexpectedly';
assertMatchLabel(fixtureRealMcpExited, 'MCP接続エラー', 'MCP server exit must classify');

const fixtureRealConnRefused = 'Error: connect ECONNREFUSED 127.0.0.1:3000';
assertMatchLabel(fixtureRealConnRefused, '接続エラー', 'low-level ECONNREFUSED must classify');

const fixtureRealAuthFail = 'HTTP 401 unauthorized';
assertMatchLabel(fixtureRealAuthFail, '認証エラー', 'auth fail must classify');

const fixtureRealRateLimit = 'rate-limit hit, HTTP 429 too many requests';
assertMatchLabel(fixtureRealRateLimit, 'レート制限', 'rate limit must classify');

const fixtureRealCliError = 'Error: Cannot find module \'./missing\'';
assertMatchLabel(fixtureRealCliError, 'CLIエラー', 'CLI Error: prefix at line start must classify');

// ────────────────────────────────────────────────────────────────────
// Edge cases
// ────────────────────────────────────────────────────────────────────
assertNoMatch('', 'empty string returns null');
assertNoMatch('abc', 'too-short text returns null');
assertNoMatch(null, 'null returns null');

// "fatal" word in narrative context (e.g., describing a fatal error in docs)
// — the requirement is line-start so prose mentioning fatal somewhere
// should NOT trigger.
assertNoMatch('The function returns nothing if a fatal condition is encountered.', 'narrative use of "fatal" must not classify');

// Token-window discussion in code review context
const tokenContext = 'context window size is 200000 tokens for this model';
assertNoMatch(tokenContext, 'description of context window size must not classify');

// User's narrative including "y/n" question form
const yesNoNarrative = 'and would you like (y/n) prompt-style support?';
assertMatchLabel(yesNoNarrative, '承認要求', '(y/n) prompt MUST classify (this is a real prompt indicator)');

// ────────────────────────────────────────────────────────────────────
// Multi-line chunks: only the matched LINE is reported, not whole chunk
// ────────────────────────────────────────────────────────────────────
{
  const chunk = `
ご検討よろしくお願いいたします。
サンプル株式会社
連絡先: 070-1234-5678
Error: connect ECONNREFUSED 127.0.0.1:8080
ありがとうございました。
  `;
  const result = classifyCliText(chunk);
  if (result && /ECONNREFUSED/.test(result.line) && !/サンプル株式会社/.test(result.line)) {
    passed += 1;
  } else {
    failed += 1;
    failures.push({
      message: 'multi-line chunk: classified line should be the ECONNREFUSED line, not the whole chunk',
      got: result ? result.line : '(null)',
    });
  }
}

// ────────────────────────────────────────────────────────────
// New: playwright MCP failure → ERR (essential), 他は WARN (noise)
// 2026-05-08: ユーザーが notion / promptshelf MCP failure を ERR バナー
// で見て不安だった issue の regression test。
// ────────────────────────────────────────────────────────────
assertMatchLabel(
  '⚠ MCP client for `playwright` failed to start: connection closed',
  'MCP接続エラー',
  'playwright MCP failure must remain ERR (Sales Claw 必須)'
);
assertMatchLabel(
  '⚠ MCP client for `notion` failed to start: MCP startup failed: handshaking with MCP server failed: connection closed: initialize response',
  'MCP接続不安定',
  'notion MCP failure should be WARN, not ERR (non-essential user MCP)'
);
assertMatchLabel(
  '⚠ MCP client for `promptshelf` failed to start: connection closed: initialize response',
  'MCP接続不安定',
  'promptshelf MCP failure should be WARN'
);
assertMatchLabel(
  'MCP server code-review-graph failed to spawn: ENOENT',
  'MCP接続不安定',
  'arbitrary user MCP failure should be WARN'
);

// ────────────────────────────────────────────────────────────
// Output
// ────────────────────────────────────────────────────────────
console.log('');
console.log(`PASSED: ${passed}`);
console.log(`FAILED: ${failed}`);
if (failed > 0) {
  for (const f of failures) {
    console.log(`  FAIL: ${f.message}`);
    if (f.expected !== undefined) console.log(`    expected: ${f.expected}, got: ${f.got}`);
    else if (f.gotLabel) console.log(`    got: ${f.gotLabel} → ${f.gotLine}`);
    else console.log(`    got: ${JSON.stringify(f.got)}`);
  }
  process.exitCode = 1;
} else {
  console.log('all cli-issue-classifier tests passed.');
}

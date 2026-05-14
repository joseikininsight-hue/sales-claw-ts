'use strict';

/**
 * MCP CLI 操作の冪等性判定ユーティリティ。
 *
 * Claude / Codex / Gemini CLI の `mcp add` / `mcp remove` 等は、対象が
 * 既に存在する/存在しない時にエラーで終わる。これを「実害なし」として
 * success に丸める判定を共通化する。
 *
 * 背景: 2026-05-15 に発覚した致命バグ。
 *   ユーザーが手動 `claude mcp add playwright ...` した後 Sales Claw を
 *   起動 → 自動セットアップが "MCP server playwright already exists in
 *   user config" で fail → Phase B (フォーム入力) が永久に走らず 47 バッチ
 *   滞留。ぶ厚いハードコード判定ではなく、横展開しやすい単一場所に切り出す。
 *
 * 設計:
 *   - シンプルな regex マッチ
 *   - provider 非依存 (claude/codex/gemini 共通)
 *   - 「対象あり」「対象なし」両方向を判定可能
 */

/** "already exists" 系のエラー文言 (add 時) */
const ALREADY_EXISTS_PATTERNS = [
  /\balready\s+exists?\b/i,           // "already exists" / "already exist"
  /\balready\s+registered\b/i,        // codex の言い回し
  /\balready\s+configured\b/i,        // 一般
  /\bduplicate\b/i,                   // "duplicate entry"
  /MCP\s+server\s+\w+\s+already/i,    // claude 特定文言
];

/** "not found" 系のエラー文言 (remove 時) */
const NOT_FOUND_PATTERNS = [
  /\bnot\s+found\b/i,
  /\bdoes\s+not\s+exist\b/i,
  /\bno\s+such\s+(server|entry|configuration)\b/i,
  /\bunknown\s+(server|entry)\b/i,
];

/**
 * MCP add コマンドの失敗が「既に登録済み」由来かを判定。
 * true なら、その後の verify (mcp list) が通れば success に丸める。
 */
export function isAlreadyExistsError(stderrOut: string): boolean {
  if (!stderrOut) return false;
  return ALREADY_EXISTS_PATTERNS.some((re) => re.test(stderrOut));
}

/**
 * MCP remove コマンドの失敗が「そもそも登録されていない」由来かを判定。
 * true なら、remove は no-op として success に丸める。
 */
export function isNotFoundError(stderrOut: string): boolean {
  if (!stderrOut) return false;
  return NOT_FOUND_PATTERNS.some((re) => re.test(stderrOut));
}

module.exports = {
  isAlreadyExistsError,
  isNotFoundError,
  // テスト用 export
  ALREADY_EXISTS_PATTERNS,
  NOT_FOUND_PATTERNS,
};

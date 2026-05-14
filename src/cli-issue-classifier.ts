// CLI 出力からの issue 検知ロジック (pure)。
//
// dashboard-server から切り出してテスト可能にした。
//
// 設計方針:
//  - **line-level マッチ** が原則。`m` フラグ + `^` `$` で 1 行内に閉じる。
//    1 チャンクが 5KB を超えるケースもあるので、ある一文に "MCP" 別の場所に
//    "error" だけで全文 200 文字を「MCP接続エラー」ラベルにしてしまうのは
//    実害が大きい (修正前の挙動)。
//  - Claude / Codex / Gemini の **自己 narrative** (「見当たりません」
//    「error ログを記録します」など) は実際の接続エラーではないので
//    excludePattern で除外する。
//  - 真の MCP 接続エラーは Claude Code 側が以下のような明確な形で出す:
//      "MCP server X failed to connect: ECONNREFUSED ..."
//      "Error: MCP server X exited unexpectedly"
//      "Failed to start MCP server <name>"
//    この特定形式に絞ると false positive をほぼゼロにできる。

export type CliIssueType = 'error' | 'warn';

export interface CliIssueRule {
  /** ヒット判定用の正規表現 */
  pattern: RegExp;
  /** ログレベル */
  type: CliIssueType;
  /** UI に出すラベル */
  label: string;
  /** マッチしてもこの正規表現にもマッチするなら無視 */
  excludePattern?: RegExp;
  /** マッチした行に追加で要求する正規表現 (例: playwright のみ) */
  requirePattern?: RegExp;
}

export interface CliIssueClassification {
  rule: CliIssueRule;
  line: string;
}

/**
 * Claude / Codex / Gemini が日本語/英語で「これから error ログを残す」のような
 * narrative を喋るときに引っかかる単語の集合。
 * 真の接続エラーには出てこないが、CLAUDE.md ガイドラインに従って動いている
 * Claude の自己説明には頻繁に出てくる。
 */
export const NARRATIVE_PHRASES_RE = /見当たりません|見つかりません|未接続|未準備|規定に従[いっ]|error\s*ログを記録|errorログを記録|エラーログを記録|エラー停止|loggin?g\s+(?:an\s+)?error|will\s+log|to\s+log\s+an\s+error|ツールが\s*ない|browser_\*\s*ツール/i;

/**
 * 順序が重要: より具体的なルールを上に置く。
 *  1. MCP 系 (最も具体的、narrative excludePattern 必須)
 *  2. ネットワーク低レベル (ECONNREFUSED 等)
 *  3. 認証/レート/クォータ (HTTP 状態固有)
 *  4. トークン制限 (具体的な "limit" フレーズのみ)
 *  5. 承認要求 (プロンプト形式)
 *  6. 致命的エラー / 汎用 CLI Error: (catch-all、最後)
 */
export const CLI_ISSUE_PATTERNS: CliIssueRule[] = [
  // ─── MCP 関連 (最優先・narrowed) ──────────────────────────────────────
  {
    pattern: /^[^\n]*\bMCP\b[^\n]*\b(?:server\s+\S+\s+(?:failed|crashed|exited|disconnected)|failed\s+to\s+(?:connect|start|spawn)|connection\s+(?:refused|lost|closed))\b[^\n]*$/im,
    type: 'error',
    label: 'MCP接続エラー',
    excludePattern: /Project MCPs|\bManage MCP servers\b|\/mcp for help|needs authentication|to navigate.*to confirm|見当たりません|見つかりません|規定に従[いっ]|error\s*ログを記録|errorログを記録|エラーログを記録/i,
    requirePattern: /\bplaywright\b/i,
  },
  {
    pattern: /^[^\n]*\bMCP\b[^\n]*\b(?:client\s+for\s+`[^`]+`\s+failed|server\s+\S+\s+(?:failed|crashed|exited|disconnected)|failed\s+to\s+(?:connect|start|spawn)|connection\s+(?:refused|lost|closed))\b[^\n]*$/im,
    type: 'warn',
    label: 'MCP接続不安定',
    excludePattern: /\bplaywright\b|Project MCPs|\bManage MCP servers\b|\/mcp for help|needs authentication|to navigate.*to confirm|見当たりません|見つかりません|規定に従[いっ]|error\s*ログを記録|errorログを記録|エラーログを記録/i,
  },
  {
    pattern: /^[^\n]*\bMCP\b[^\n]*\btimeout\b[^\n]*$/im,
    type: 'warn',
    label: 'MCPタイムアウト',
    excludePattern: NARRATIVE_PHRASES_RE,
  },

  // ─── ネットワーク低レベル ─────────────────────────────────────────────
  {
    pattern: /^[^\n]*\b(?:ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EPIPE)\b[^\n]*$/im,
    type: 'error',
    label: '接続エラー',
  },

  // ─── 認証 (HTTP 状態固有) ─────────────────────────────────────────────
  {
    pattern: /^[^\n]*(?:API.?key.?invalid|\bauth\w*\s+fail|\bunauthorized\b|\bHTTP\s+401\b)[^\n]*$/im,
    type: 'error',
    label: '認証エラー',
  },

  // ─── レート/クォータ ─────────────────────────────────────────────────
  {
    pattern: /^[^\n]*(?:\brate.?limit\b|too many requests|\bHTTP\s+429\b)[^\n]*$/im,
    type: 'warn',
    label: 'レート制限',
    excludePattern: NARRATIVE_PHRASES_RE,
  },
  {
    pattern: /^[^\n]*(?:\bquota\b[^\n]*\bexceeded\b|\bbilling\b[^\n]*\berror\b)[^\n]*$/im,
    type: 'warn',
    label: 'クォータ超過',
  },

  // ─── トークン制限 (narrowed: "limit" / "exceeded" のみ) ──────────────
  {
    pattern: /^[^\n]*\b(?:token|context).?(?:limit\b[^\n]*\bexceeded|window\s+(?:full|exceeded|exhausted))[^\n]*$/im,
    type: 'warn',
    label: 'トークン制限',
    excludePattern: NARRATIVE_PHRASES_RE,
  },

  // ─── 承認・確認要求 ───────────────────────────────────────────────────
  {
    pattern: /\(y\/n\)|\(yes\/no\)/i,
    type: 'warn',
    label: '承認要求',
  },
  {
    pattern: /^[^\n]*(?:waiting for[^\n]*\bapproval\b|user[^\n]*input[^\n]*required)[^\n]*$/im,
    type: 'warn',
    label: 'ユーザー入力待ち',
  },

  // ─── 致命的エラー (line-start) ────────────────────────────────────────
  {
    pattern: /^[^\n]*\bfatal\b[:\s][^\n]*$/im,
    type: 'error',
    label: '致命的エラー',
    excludePattern: /\b(?:if|when|describe|describes|description|notes?)\b.*\bfatal\b|\bfatal\s+(?:condition|error)\s+(?:is|may|can|might|could)\s+/i,
  },

  // ─── 汎用 CLI Error: (catch-all、最後) ───────────────────────────────
  {
    pattern: /^(?:Error|TypeError|ReferenceError|SyntaxError|RangeError):[^\n]*$/im,
    type: 'error',
    label: 'CLIエラー',
    excludePattern: /\bERROR:\s*The process "?\d+"? (?:not found|could not be terminated)/i,
  },

  // ─── Electron モード切替の推奨 hint ──────────────────────────────────
  {
    pattern: /(?:MCP\s+Playwright[^\n]{0,80}(?:見当たりません|見つかりません|未接続|未準備|接続されていません|not\s+(?:found|connected|available)))|(?:browser_\*[^\n]{0,40}ツール[^\n]{0,40}(?:見当たりません|未接続|接続されていません))/i,
    type: 'warn',
    label: 'Electron モード推奨',
  },
];

/**
 * raw text に当てはまる最初のルールを返す (既知 issue が無ければ null)。
 * 副作用なし、テスト可能。
 *
 * @param rawText - ANSI 等は呼び出し側で除去済み想定
 */
export function classifyCliText(rawText: string): CliIssueClassification | null {
  if (typeof rawText !== 'string' || rawText.length < 5) return null;
  for (const rule of CLI_ISSUE_PATTERNS) {
    rule.pattern.lastIndex = 0;
    if (!rule.pattern.test(rawText)) continue;
    if (rule.excludePattern && rule.excludePattern.test(rawText)) continue;
    if (rule.requirePattern) {
      const probe = rawText.match(rule.pattern);
      const probeLine = probe?.[0] ?? '';
      if (!rule.requirePattern.test(probeLine)) continue;
    }
    const m = rawText.match(rule.pattern);
    const matchedSegment = m?.[0] ?? rawText;
    const firstLine = matchedSegment.replace(/[\r\n]+/g, ' ').trim().slice(0, 200);
    return { rule, line: firstLine };
  }
  return null;
}

module.exports = {
  CLI_ISSUE_PATTERNS,
  NARRATIVE_PHRASES_RE,
  classifyCliText,
};

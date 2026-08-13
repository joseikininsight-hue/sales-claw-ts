# Phase B ヘッドレス化設計 (PTY → `claude -p --output-format stream-json`)

Status: 設計ドラフト (2026-08-13) / 実装未着手
Owner: 次期リファクタリング (v2.2.x 想定)

## 背景 / 動機

現行の Phase B は「対話 TUI を node-pty で擬似操作」しており、以下の脆い機構の
塊になっている (2026-08-13 のパイプライン分析で確定):

| 現行機構 | 場所 | 脆さ |
|---|---|---|
| bracketed paste + Enter 2 回 | dashboard-server.ts `flushManagedAiPromptQueue` | Claude UI 文言依存の banner 検出 (`[Pasted text`) |
| paste banner 検出 fallback 8s | `MANAGED_AI_CLAUDE_PASTE_FALLBACK_MS` | 検出漏れで毎回 8 秒損失 |
| ready 検出 (TUI マーカー + 1.5s タイマー) | `getManagedAiReadyMarkers` | CLI の UI 変更で壊れる (v2.1.6 で実際に発生) |
| バッチ stall watchdog 20 分 | `MANAGED_AI_BATCH_STALL_MS` | 成否を「ログ有無」から推測 |
| コスト推定 chars/4 × 出力比 0.7 | cost-estimator.ts | 実測でない |

`claude -p --output-format stream-json` に移行すると、これら全部が
「stdout の構造化イベントを読む」だけになる。

## ゴール

1. Phase B バッチを headless プロセスとして起動し、成否を stream-json の
   `result` イベントで判定する (ログ有無ヒューリスティック廃止)。
2. `result.usage` (input/output/cache_creation/cache_read tokens) を
   `ai-run-metrics.jsonl` に記録し、cost-estimator を実測ベースへ置換。
3. PTY 固有機構 (paste banner / 2nd Enter / ready マーカー / 8s fallback) の削除。
4. 操作中タブの WebContentsView ライブ表示は**維持** (internal MCP は
   headless でも同じ named pipe 経由で動く — MCP 設定はプロセス起動時の
   `--mcp-config` で渡す)。

## 非ゴール

- Phase A の変更 (既に headless / 無課金設計)
- 操作中タブ UI の変更
- parallel-dispatcher (legacy) の削除 — 移行完了後に別途

## 設計

### 起動形態

```
claude -p --output-format stream-json --include-partial-messages \
  --dangerously-skip-permissions --permission-mode bypassPermissions \
  --model <phase-b model> \
  [--resume <sessionId>]   # 2 バッチ目以降
```

- プロンプトは stdin 流し込み (`parallel-dispatcher.ts:189-194` と同方式。
  cmd.exe の引数長・エスケープ問題を回避)。
- env は既存 `buildManagedProviderEnv()` をそのまま使う
  (SALES_CLAW_SESSION / DASHBOARD_URL / FORM_IPC_PIPE)。

### セッション継続 (最重要の注意点)

現行 PTY は常駐セッションのため「初回バッチのみフル指示、2 回目以降は
payload だけ」(dashboard-server.ts:6244-6250) が成立している。headless で
毎回新プロセスにすると毎回フル指示 = トークン増になる。

対策: 初回 `result` イベントの `session_id` を保存し、2 バッチ目以降は
`--resume <session_id>` で同一セッションを再開する。resume 失敗時
(セッション expired 等) はフル指示付きで新規セッションへフォールバック。

### 進捗のライブ表示

- stream-json の `assistant` / `tool_use` イベントを既存の
  `emitClaudeAutomationLog` / SSE `cli-log` に転送すれば、現行の
  「CLI Activity」表示はそのまま生きる。
- PTY viewer (ターミナル表示) は headless モードでは stream-json の
  整形テキストを流す表示に置換 (または非表示)。

### 成否判定・watchdog

- `result` イベント (`subtype: success | error_*`) で確定判定。
- watchdog は「プロセス生存 + 最終イベントからの経過時間」に単純化
  (現行の per-company 6/10/15/20 分の多段推測を削減)。
- 会社単位の完了は従来どおり log-action の terminal 記録で突合し、
  `result` 到達時に未記録の会社へ error を補完 (headless 経路の
  `markHeadlessAutomationFailure` を流用)。

### コスト実測

- `result.usage` を `appendAiRunMetric('phase_b_result_usage', …)` で記録。
- cost-estimator: `phase_b_result_usage` があれば実測、無ければ従来推定に
  フォールバック (後方互換)。

### 設定・段階導入

- `preferences.phaseBRuntime: "pty" | "headless"` (既定 "pty") を新設。
- 実機で headless を数バッチ検証 → 既定を "headless" に反転 → PTY 経路を
  1 リリース維持した後に削除。

## 移行手順 (実装順)

1. `src/ai-runtime/headless-batch-runner.ts` 新設: spawn + stream-json パース
   + result/usage 抽出 (llm-message-generator の `runCliHeadless` 重複解消と
   同時に `llm-cli-runner.ts` へ共通化 — refactoring-plan.md:176 の既存案)。
2. dashboard-server の `queueManagedAiPrompt` に runtime 分岐を追加
   (queue 契約は不変。dispatch 先だけ PTY / headless で切替)。
3. `--resume` セッション管理 + フォールバック。
4. usage 記録 + cost-estimator 実測対応。
5. 実機 A/B (`phaseBRuntime` 切替) → 既定反転 → PTY 機構削除。

## 補足: CLAUDE.md 10.5K トークン問題

CLAUDE.md (42KB) は CLI 起動毎にシステムプロンプトへ読み込まれる。
headless 化後は `SALES_CLAW_CLI_WORKSPACE` を CLAUDE.md の無い専用
ディレクトリへ向け、フォーム入力規範はバッチプロンプト側 (既にフル指示を
内包) に一本化することで、1 プロセスあたり約 10K トークンを削減できる。
ただし規範の二重管理を解消してからでないと挙動退行のリスクがあるため、
手順 5 の後に実施する。

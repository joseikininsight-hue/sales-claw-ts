# Sales Claw — AI Agent Instructions

> English version: [AGENTS.md](../../AGENTS.md)
>
> このファイルは Codex CLI / Gemini CLI 等の **`AGENTS.md` を読む AI エージェント向け**の
> エントリーポイントです。
>
> **本体の運用ルール・ワークフロー・MCP 使用契約は [`CLAUDE.md`](../../CLAUDE.md) に
> 一本化されています。** こちらを参照してください。
>
> 過去には AGENTS.md と CLAUDE.md を別々に保守していましたが、内容が drift する
> 問題があったため、2.0.0 から CLAUDE.md を唯一のソースオブトゥルースにしました。

## Quick Pointers

- **絶対ルール (フォーム入力 + スクショ + sentMessage 必須)**: [CLAUDE.md](../../CLAUDE.md)
- **Programmatic Credit (2026-06-15 ポリシー対応)**: [docs/programmatic-credit-migration.md](../programmatic-credit-migration.md)
- **Dashboard Port Lifecycle**: [docs/dashboard-port-lifecycle.md](../dashboard-port-lifecycle.md)
- **TypeScript Migration Roadmap**: [docs/typescript-migration-roadmap.md](../typescript-migration-roadmap.md)
- **コントリビュート手順**: [CONTRIBUTING.md](../../CONTRIBUTING.md)
- **セキュリティ報告**: [SECURITY.md](../../SECURITY.md)

## 禁止事項 (CLAUDE.md からの抜粋)

エージェントは以下を **絶対に** 行ってはいけません。詳細は [CLAUDE.md](../../CLAUDE.md)
の "ABSOLUTE RULE" セクションを参照してください。

- メッセージを生成しただけで (フォームに触れずに) `awaiting_approval` をログしない
- フォームを一度も開かずに `form_fill` をログしない
- スクリーンショットなしで `awaiting_approval` に進まない
- 「フォームが見つからなかった」を無言で `awaiting_approval` にしない (必ず `error` ログ + 理由)
- `awaiting_approval` / `submitted` の `details` から `sentMessage` を欠落させない
- 連絡先 (TEL / MAIL) のみの退化した本文を入力しない

## ワークフロー (CLAUDE.md からの抜粋)

会社ごとに必須の流れ (どのステップも省略不可):

```
Step 0: MCP Playwright の前提確認
Step 1: 企業サイト分析
Step 2: メッセージ生成
Step 3: フォーム URL 発見
Step 4: フォーム構造解析
Step 5: フォーム入力 ★ NEVER SKIP
Step 6: スクリーンショット ★ NEVER SKIP
Step 7: awaiting_approval 登録
```

すべての詳細・タブ管理契約・ログ仕様は [CLAUDE.md](../../CLAUDE.md) を参照してください。

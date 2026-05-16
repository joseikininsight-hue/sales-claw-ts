# Privacy & Data Handling

> English version: [PRIVACY.md](../../PRIVACY.md)

このドキュメントは Sales Claw がどのようなデータをどこで扱うかを明示します。
プライバシーポリシーの代わりにもなります (Sales Claw 自体は SaaS ではなく、
ユーザーのマシンで動くデスクトップアプリのため、運営側がデータを収集することは
ありません)。

## 概要 — Sales Claw は完全ローカル動作

Sales Claw は **ユーザーのローカル PC 内で完結する**ツールです。
プロジェクト運営者 (Sales Claw contributors) はユーザーのデータを一切
受信・保存・閲覧しません。

ただし、ユーザーが下記の外部サービスを利用する場合、
そのサービスのプライバシーポリシーが適用されます:

| 外部サービス | 用途 | データ送信先 |
|---|---|---|
| Claude API (Anthropic) | 企業分析・メッセージ生成 | https://api.anthropic.com (Anthropic の[プライバシーポリシー](https://www.anthropic.com/legal/privacy)) |
| OpenAI Codex API | 同上 (Codex を選択時) | OpenAI の[プライバシーポリシー](https://openai.com/policies/privacy-policy) |
| Google Gemini API | 同上 (Gemini を選択時) | Google の[プライバシーポリシー](https://policies.google.com/privacy) |
| SerpApi | 企業リスト発見 (NLQ/カテゴリモード) | https://serpapi.com (任意機能、API キー設定時のみ) |
| 国税庁 法人番号 Web API | 法人実在性検証 | https://www.houjin-bangou.nta.go.jp (任意機能、API キー設定時のみ) |
| gBizINFO | 企業詳細情報 | https://info.gbiz.go.jp (任意機能、API キー設定時のみ) |
| EDINET | 上場企業財務情報 | https://disclosure.edinet-fsa.go.jp (任意機能、API キー設定時のみ) |
| ターゲット企業の Web サイト | 公式サイト分析・問い合わせフォーム送信 | ユーザーが指定したドメイン |
| GitHub (自動更新) | 起動時の更新チェック | https://api.github.com (releases メタデータの取得のみ) |

## ローカル保存データ

以下のディレクトリにユーザーデータが保存されます:

### Windows
```
%APPDATA%\sales-claw\runtime\data\
├── settings.json              ユーザー設定 (自社情報・強み・API キー等)
├── action-log.json            送信ログ
├── contact-history.json       連絡履歴
├── outreach-targets.json      ターゲットリスト
├── live-monitor.json          進行状況
├── dashboard-runtime.json     ダッシュボード起動情報
├── ai-runs/                   AI 実行ログ (PTY セッション)
├── ai-prompts/                AI へ送ったプロンプト
├── claude-prompts/            Claude 用プロンプト履歴
├── provider-homes/<provider>/ 各 AI CLI の認証情報 (subscription token)
├── cache/analysis/            企業分析キャッシュ (30 日 TTL, sha256 ハッシュキー)
├── recovery/                  クラッシュ復旧用スナップショット
└── screenshots/               フォーム入力時のスクリーンショット
```

### macOS
```
~/Library/Application Support/sales-claw/runtime/data/
```

### Linux
```
~/.config/sales-claw/runtime/data/
```

## API キー / 認証情報

- `data/settings.json::apiKeys` に保存される API キーは **平文** です (Phase 1 設計)
  - Phase 8 で暗号化対応予定 ([CHANGELOG](../../CHANGELOG.md) / ロードマップ参照)
  - 共有マシン / 公開リポジトリへの誤コミットを避けるため `.gitignore` 済
- AI CLI の subscription token は `provider-homes/<provider>/.claude/credentials.json`
  などに保存されます。各 CLI ベンダーの仕様に準拠

## ログ / スクリーンショット

- フォーム送信時のスクリーンショットには **ユーザーが入力した本文と相手企業の情報** が含まれます
- AI セッションログには **送信プロンプトと AI の応答全文** が含まれます
- これらは全てローカル保存。外部送信されません
- 配布や共有を行う場合は、これらを除外/マスクしてください

## 法的責任

Sales Claw は**営業活動の自動化を支援するツール**であり、
**実際の送信 / 連絡先利用は全てユーザーの責任**で行います。

### 日本国内でご利用の場合 (要遵守)

#### 1. 特定電子メールの送信の適正化等に関する法律 (特定電子メール法)

メール送信を行う場合、以下の 4 要素を本文に含める必要があります:

1. 送信者の氏名又は名称
2. 送信者の連絡先 (URL / メールアドレス)
3. 受信拒否の通知ができる旨と通知先
4. 任意:住所・電話番号

> Sales Claw の `src/compliance.ts` がこれら 4 要素の自動検出 + 自動補完を
> 行います (`preferences.complianceFooter: true` がデフォルト)。

#### 2. 個人情報の保護に関する法律 (個人情報保護法)

- 公開されている**法人情報** (会社名・代表者名・代表 URL・公式問い合わせフォーム) は
  個人情報に該当しないことが多いですが、担当者の個人氏名・私用メールアドレス等は
  個人情報になり得ます
- 取得経路 (どこから入手したターゲットリストか) を `preferences.listSourceMetadata`
  に記録することを推奨

#### 3. その他

- **送信先サイトの利用規約遵守**: Sales Claw は robots.txt / CAPTCHA 検出を行いますが、
  最終的な遵守責任はユーザーにあります
- **連投・大量送信の禁止**: 法令 + 一般的なマナーに従い、適切な頻度で利用してください
- **「営業お断り」「採用専用」等の明示**がある問い合わせ窓口には送らないでください
  (Sales Claw はこれを自動検出して `skipped` にする機能を持ちます)

## EU/UK でのご利用 (GDPR/UK GDPR)

EU/UK 在住の個人または EU/UK の企業にコンタクトする場合、GDPR が適用されます:

- B2B コンタクトであっても個人氏名は個人データに該当
- Legitimate Interest (正当な利益) を根拠とする場合、データ最小化原則を守る
- DPA (Data Protection Officer) への問い合わせフォームが用意されている場合は
  そちらを優先

## 米国でのご利用 (CAN-SPAM Act)

- メール件名・送信者表示が誤解を招くものでないこと
- 物理住所の記載
- オプトアウトの提供
- オプトアウト要請に 10 営業日以内に対応

## DISCLAIMER

Sales Claw は **"AS IS"** で提供されます ([LICENSE](../../LICENSE) 参照)。

- 本ツールの使用により生じたいかなる損害 (法的責任・経済的損失・評判の損失等)
  についても、プロジェクト運営者は一切の責任を負いません
- 法令違反となる使い方は禁止します
- 倫理的・社会的に問題のある使い方 (スパム・嫌がらせ・なりすまし等) は禁止します

## 連絡

- セキュリティ問題: [SECURITY.md](../../SECURITY.md)
- プライバシー関連の問い合わせ: [GitHub Private Security Advisory](https://github.com/joseikininsight-hue/sales-claw-ts/security/advisories/new) (タイトルに `[Privacy]` を付けてください)

## 改訂履歴

| 日付 | 内容 |
|---|---|
| 2026-05-14 | 初版 (2.0.0 リリース時に新規作成) |

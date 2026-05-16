# Sales Claw

[![Release](https://img.shields.io/github/v/release/joseikininsight-hue/sales-claw-ts?style=flat-square)](https://github.com/joseikininsight-hue/sales-claw-ts/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](../../LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-100%25-blue.svg?style=flat-square)](https://www.typescriptlang.org/)
[![Bilingual](https://img.shields.io/badge/UI-JA%20%2F%20EN-brightgreen.svg?style=flat-square)](#バイリンガル対応)

> English version: [README.md](../../README.md)

**Web 問い合わせフォーム経由の B2B 営業アプローチを自動化するツール。**
Sales Claw は Claude Code CLI (または Codex / Gemini) を駆動して、
ターゲット企業の Web サイトを分析し、企業ごとにパーソナライズした
メッセージを作成し、問い合わせフォームに自動入力します。最終的な
送信判断はローカルの Electron ダッシュボードで人間が行う
human-in-the-loop 設計です。

> **v2.0.37** (2026-05): バイリンガル対応が完成しました。ヘッダー /
> オンボーディング / 設定 / 確認待ち / 送信済み / リストビルダー / 統計
> まで全 UI 面で日本語・英語のロケールパックを完備しています。詳細な
> ロールアウト履歴は [CHANGELOG](../../CHANGELOG.md) (Phase 1 → Phase 5)
> を参照してください。

最新バージョン: [GitHub Releases](https://github.com/joseikininsight-hue/sales-claw-ts/releases)

---

## 目次

- [主要機能](#主要機能)
- [システム要件](#システム要件)
- [クイックスタート (5 分)](#クイックスタート-5-分)
- [バイリンガル対応](#バイリンガル対応)
- [アーキテクチャ概要](#アーキテクチャ概要)
- [送信ポリシー](#送信ポリシー)
- [免責事項](#免責事項)
- [ドキュメント](#ドキュメント)
- [コントリビューション](#コントリビューション)
- [セキュリティ](#セキュリティ)
- [ライセンス](#ライセンス)

---

## 主要機能

### コア機能 (v2.0.37)

- **AI 自動フォーム入力** — Phase A で N 社の分析を並列実行 (プレーン
  HTTP・ブラウザ未使用、`parallelTabs` は 1〜3 で設定可能)、Phase B で
  MCP Playwright を 1 セッション順次駆動してフォーム入力 → スクショ →
  人間承認待ちに登録。詳細は[パイプライン図](#アーキテクチャ概要)参照。
- **バイリンガル UI** — ヘッダーの言語トグルボタン (🇯🇵 ⇄ 🇺🇸) +
  オンボーディングでの言語選択。選択したロケールはメッセージ生成
  プロンプトにも反映され、AI が同じ言語で文面を作成します。
- **ロケール対応メッセージ生成** — `messageTemplates.locale` で日本語 /
  英語のトーン・署名形式・コンプライアンスフッター言語を自動切り替え。
- **コンプライアンスレジストリ (4 ロケール)**:
  | ロケール | 法令・枠組 | 自動追記項目 |
  |----------|------------|-------------|
  | `ja-jp` | 特定電子メール法 | 送信元会社名 / 連絡先メール / オプトアウト文言 |
  | `en-us` | CAN-SPAM Act | 送信者 / 物理住所 / オプトアウトリンク |
  | `en-eu` | GDPR / ePrivacy | 法的根拠 / 管理者情報 / オプトアウト |
  | `other` | 汎用・ベストエフォート | 送信者 + オプトアウト文言のみ |
- **List Builder (企業リスト自動作成、1.2.43+)** — 3 つの入力モード
  (URL クロール / 自然言語 / カテゴリプリセット) と、日本専用の公式 API
  (国税庁法人番号 API / gBizINFO / EDINET) を組み合わせて、営業候補企業を
  発見・検証・適合度評価。全レコードは人間承認の上でターゲットリストに
  追加されます。
- **クラッシュリカバリ** — 中断されたバッチは
  `data/recovery/managed-ai-batches.json` から次回起動時に復元され、
  ダッシュボードに「続きから / 破棄」バナーが表示されます。
- **コスト可視化** — AI コスト推定 chip (今日 / 今月 / 1 社平均) が
  ダッシュボードに常時表示。Anthropic 公開価格と
  `preferences.usdJpy` の為替レートを使用します。
- **スクショ監査トレイル** — 全 `awaiting_approval` レコードに、実際に
  フォーム本文欄に入力した文字列とスクリーンショット
  (`screenshots/ss-{No}-input.png`) を必ず添付。欠如時は 422 API ガードで
  拒否されます。
- **自動アップデート** — インストール済みアプリが起動 5 秒後 + 6 時間
  ごとに GitHub Releases をポーリングし、新版を静かにダウンロード →
  「再起動で更新」を表示。

### 対応 AI CLI (セッションごとに切替可能)

- Claude Code CLI 2.0+ (推奨)
- Codex CLI 0.128+
- Gemini CLI 0.1+

---

## システム要件

| | 最小 | 推奨 |
|-|------|------|
| OS | Windows 10 / 11、macOS 13+、Ubuntu 22.04+ | Windows 11 |
| メモリ | 4 GB | 8 GB |
| ディスク | 1 GB 空き | 2 GB 空き |
| ネットワーク | AI プロバイダーと GitHub への HTTPS 出方向 | 同左 |
| **Node.js** | 20+ *(ソースからビルドする場合のみ)* | 20 LTS |
| **AI CLI** | Claude / Codex / Gemini のいずれか | Claude Code CLI 2.0+ |

パッケージ済み Electron インストーラには Node ランタイムが同梱されて
います。エンドユーザーは Node.js を別途インストールする**必要はありません**。

---

## クイックスタート (5 分)

### 1. インストーラをダウンロード

[GitHub Releases (最新)](https://github.com/joseikininsight-hue/sales-claw-ts/releases/latest)
から OS に合ったファイルを取得します。

| OS | ファイル |
|----|---------|
| Windows | `Sales-Claw-Setup-2.0.37.exe` |
| macOS (Apple Silicon) | `Sales-Claw-2.0.37-arm64.dmg` |
| macOS (Intel) | `Sales-Claw-2.0.37-x64.dmg` |
| Linux | `Sales-Claw-2.0.37-x64.AppImage` |

### 2. インストール (per-user、管理者権限不要) と起動

Windows インストーラは Sales Claw を
`%LOCALAPPDATA%\Programs\Sales Claw\` に配置し、スタートメニューに
ショートカットを追加します。UAC は表示されません。macOS は
Applications にドラッグ、Linux は AppImage を `chmod +x` してダブル
クリックしてください。

### 3. オンボーディングウィザード

初回起動時、ダッシュボードは `/onboarding` に自動リダイレクトします。
5 ステップを順に進めてください:

1. **ようこそ + 言語選択** — 🇯🇵 日本語 / 🇺🇸 英語を選択し、OSS 利用
   規約に同意。
2. **自社情報** — 送信者アイデンティティ (社名・担当者名・メール・電話)。
   全メッセージとコンプライアンススキャナーで使用されます。
3. **自社の強み** — プリセット 8 種から 1〜2 個 (またはカスタム追加)。
   メッセージのパーソナライズを駆動するギャップ分析プロンプトに使われます。
4. **ターゲットリスト** — Excel / CSV ファイルをドロップ (スキップ可)。
5. **AI 連携** — Claude / Codex / Gemini のいずれかがインストール済み &
   ログイン済みであることを確認。

完了すると `data/settings.json` に `_onboardedAt` タイムスタンプが
書き込まれ、以降は通常ダッシュボードへ直接遷移します。再実行は
`http://127.0.0.1:3765/onboarding?fresh=1` から可能です。

### 4. AI フォーム入力を起動

**企業一覧** タブで対象を選択し、**AI フォーム入力** をクリック。
Sales Claw が Claude / Codex / Gemini の managed PTY を起動し、以下を
実行します:

- **Phase A** (並列・ブラウザ未使用): 各社の Web サイト分析・メッセージ
  プロンプト構築・問い合わせフォーム URL の自動解決。
- **Phase B** (順次・MCP Playwright 使用): 各フォームに対して
  navigate → 全フィールド入力 → スクショ → `awaiting_approval` ログ。

CLI Activity パネル (右下の FAB) で進行状況をリアルタイム確認できます。

### 5. 確認 & 送信

**確認待ち** タブを開きます。各行に入力済みフォームのスクショ・実送信
本文・フォーム URL が表示されます。**送信済みにする** (またはスキップ
理由つき **スキップ**) をクリックして確定。`autoSendEligibleForms` を
有効化していれば、CAPTCHA / 手動確認 / 営業 NG マーカーのないフォームは
自動送信されます。

---

## バイリンガル対応

Sales Claw v2.0.37 では日本語 / 英語のロケールパックが以下の全領域を
カバーします:

- ヘッダー・サイドバーナビゲーション・ステータスバッジ
- オンボーディングウィザード (5 ステップ)
- 設定 (全タブ: プロフィール / 強み / テンプレート / List Builder キー /
  各種設定)
- 確認待ち・送信済み・スキップ・エラー タブ
- List Builder UI (URL / 自然言語 / カテゴリ各モード)
- 統計パネル・パイプラインバー・ドーナツチャート・7 日トレンド

ヘッダーの言語トグルボタンでいつでも切替可能 (状態は `localStorage` に
保存)。同じ `locale` がメッセージ生成プロンプトにも流れるため、AI が
作成する文面も UI 言語と一致します。

新規ロケール追加は `src/locale-pack/` の Phase 2 ロケールパックパターン
に従い、`src/i18n/registry.ts` で登録してください。

---

## アーキテクチャ概要

```
┌──────────────────────────────────────────────────────────┐
│      Claude / Codex / Gemini CLI (managed PTY)           │
│   Phase A: 並列分析  ·  Phase B: フォーム入力ドライバー  │
└─────────────┬─────────────────────────────┬──────────────┘
              │                             │
      ┌───────▼─────────┐         ┌─────────▼──────────┐
      │  MCP Playwright │         │  Node.js モジュール │
      │  (browser_*)    │         │  (分析・文面生成)   │
      └───────┬─────────┘         └─────────┬──────────┘
              │                             │
      ┌───────▼─────────────────────────────▼──────────┐
      │  Electron アプリ + ローカルダッシュボードサーバ   │
      │  (TypeScript・127.0.0.1・セッショントークンガード) │
      │  企業一覧 | 確認待ち | 送信済み | 設定           │
      └──────────────────────────────────────────────────┘
                              │
                  ┌───────────▼────────────┐
                  │  data/settings.json    │
                  │  (Single Source of     │
                  │   Truth・gitignore 済) │
                  └────────────────────────┘
```

- **Electron + TypeScript ダッシュボードサーバ** — UI・設定・ターゲット
  リスト・承認キュー・送信済みログ・リアルタイム CLI Activity の全てを
  提供。設定の正本は `data/settings.json`。ダッシュボードは `127.0.0.1`
  にのみバインドします。
- **Claude PTY による自律フォーム入力** — Sales Claw は AI CLI を
  managed PTY で起動し、API キーをスタートアップ前に環境から削除して
  渡します。CLI が MCP Playwright を駆動して navigate / fill /
  screenshot を実行します。
- **MCP Playwright によるブラウザ自動化** — 全フォーム操作は
  `browser_navigate` / `browser_snapshot` / `browser_fill_form` /
  `browser_take_screenshot` を経由します。direct JS automation や
  独自 Playwright worker による代替は禁止です。
- **自動アップデート** — `electron-updater` と
  `.github/workflows/release.yml` が main への push ごとに
  Windows / macOS / Linux 成果物と `latest*.yml` を GitHub Releases へ
  公開します。

AI CLI 自身が system prompt として読む完全な運用契約は
[CLAUDE.md](../../CLAUDE.md) (英語) / [docs/ja/CLAUDE.md](./CLAUDE.md)
(日本語) を参照してください。

---

## 送信ポリシー

- **既定**: `awaiting_approval` で停止。人間がスクショを確認して
  **送信済みにする** をクリック。`awaiting_approval` / `submitted` の
  `details` には `sentMessage` (実際にフォーム本文欄に入力した文字列
  そのもの) が必須で、欠如 / 30 文字未満は 422 API ガードで拒否されます。
- **オプション**: `preferences.autoSendEligibleForms` を有効化すると、
  CAPTCHA なし・手動確認なし・営業 NG マーカーなしのフォームのみ自動
  送信します。
- **設定に関わらず常に `awaiting_approval` で停止**: CAPTCHA
  (reCAPTCHA / hCaptcha / Turnstile) を検出した場合、「営業お断り」
  「既存顧客専用」「採用専用」「IR 専用」「報道専用」のフォーム
  (これらは `skipped` でログ)、判断が難しい曖昧なケース。

---

## 免責事項

**本ツールは法令適合を保証しません。** 利用者は以下に対して**全責任**を
負います:

- 各国・各地域の迷惑メール規制 / 営業勧誘規制への適合
  (日本の特定電子メール法・特定商取引法、米国の CAN-SPAM、EU の
  GDPR / ePrivacy など)。
- 各送信先への営業アプローチの妥当性 (「営業お断り」「オプトアウト要請」、
  フォームに明記された会社のポリシー等の尊重)。
- 生成・送信された各メッセージの事実関係の正確性。
- 本ツールを通じて送信されたメッセージに起因する一切の結果。

Sales Claw は **best-effort のセーフティレール**を提供します:

- **コンプライアンススキャナ** (`src/compliance.cjs`) — 登録された
  ロケールごとに必要要素 (送信者・連絡先メール・オプトアウト文言など)
  をチェックし、不足を警告。
- **常時有効な human-in-the-loop 承認ゲート** (`awaiting_approval`) —
  実際の送信前に必ず人間が確認。
- **「営業 NG」検出器** — 営業お断り / 既存顧客専用 / 採用専用 /
  IR 専用 / 報道専用 と明示されたフォームを自動 skip。
- **スクショ監査トレイル** — 全承認レコードに実送信本文と
  `ss-{No}-input.png` を強制添付 (422 API ガード)。

これらは法的レビューの代替ではありません。**自己責任でご利用ください。**

---

## ドキュメント

### エンドユーザー向け

- [SETUP.md](../../SETUP.md) — インストール・オンボーディング・初回
  起動の詳細ガイド *(英語版・準備中)*
- [docs/ja/SETUP.md](./SETUP.md) — 日本語版セットアップガイド
  *(準備中)*
- [TROUBLESHOOTING.md](../../TROUBLESHOOTING.md) — よくあるエラーと
  対処 *(準備中)*
- [FAQ.md](../../FAQ.md) — よくある質問 *(準備中)*
- [SUPPORT.md](../../SUPPORT.md) — サポート・バグ報告窓口
- [PRIVACY.md](../../PRIVACY.md) — Sales Claw がローカル保存する
  データと、AI プロバイダーに送信されるデータの一覧

### AI エージェント・開発者向け

- [CLAUDE.md](../../CLAUDE.md) — Claude / Codex / Gemini CLI が
  system prompt として読む運用契約 (英語)
- [docs/ja/CLAUDE.md](./CLAUDE.md) — 同・日本語版
- [AGENTS.md](../../AGENTS.md) — エージェントオーケストレーション
  ルール
- [CONTRIBUTING.md](../../CONTRIBUTING.md) — コーディングスタイル・
  PR フロー・テスト要件 (英語)
- [docs/ja/CONTRIBUTING.md](./CONTRIBUTING.md) — 同・日本語版
- [SECURITY.md](../../SECURITY.md) — 脅威モデル・private disclosure
  フロー・セキュリティ既定値
- [MIGRATION.md](../../MIGRATION.md) — v1.2.111 → v2.0.0 移行ノート
- [ROADMAP.md](../../ROADMAP.md) — 今後の予定とバージョンゴール
- [CHANGELOG.md](../../CHANGELOG.md) — 全バージョン別リリースノート
- [CODE_OF_CONDUCT.md](../../CODE_OF_CONDUCT.md) — コミュニティ行動規範

### 深掘りドキュメント

- [docs/list-builder-requirements.md](../list-builder-requirements.md)
  — List Builder 完全仕様 (v2.0)
- [docs/release-parity-and-autoupdate.md](../release-parity-and-autoupdate.md)
  — デスクトップリリースパイプライン + 自動アップデート
- [docs/dashboard-port-lifecycle.md](../dashboard-port-lifecycle.md)
  — ダッシュボードポート割当・`runtime.json`・ロックセマンティクス
- [docs/typescript-migration-roadmap.md](../typescript-migration-roadmap.md)
  — v2.0 TypeScript 移行の経緯
- [docs/programmatic-credit-migration.md](../programmatic-credit-migration.md)
  — Anthropic 2026-06-15 ポリシー対応
- [docs/form-fill-rules-and-settings-audit.md](../form-fill-rules-and-settings-audit.md)
  — フォーム入力ルール監査ログ

---

## コントリビューション

PR・バグ報告・翻訳・ドキュメント改善を歓迎します。

PR を送る前に [CONTRIBUTING.md](../../CONTRIBUTING.md) を読み、
[Code of Conduct](../../CODE_OF_CONDUCT.md) に従ってください。

新規 UI ロケールを追加する場合は `src/locale-pack/` の Phase 2 ロケール
パックパターンに従い、`src/i18n/registry.ts` で登録します。

ソースからビルドする場合:

```bash
git clone https://github.com/joseikininsight-hue/sales-claw-ts.git
cd sales-claw-ts
npm install
npx playwright install chromium
npm start                # Electron アプリ
# または
npm run dashboard        # ダッシュボードサーバのみ (ブラウザ利用)
```

---

## セキュリティ

脆弱性報告は [SECURITY.md](../../SECURITY.md) に記載の GitHub Private
Security Advisory フローを使用してください。**public issue では報告
しない**でください。

セキュリティ既定値 (詳細は `SECURITY.md`):

- ダッシュボードは `127.0.0.1` にのみバインド (ネットワークから到達不能)。
- 全 API リクエストは起動ごとのセッショントークン
  (`x-sales-claw-session` ヘッダ) を要求。トークンは
  `%APPDATA%\sales-claw\runtime\data\dashboard-session.json` に保存。
- `data/settings.json` は `.gitignore` 対象 — API キーが commit される
  ことはありません。
- AI CLI 起動前に子プロセス環境を sanitize
  (`ANTHROPIC_API_KEY` / `AWS_*` / `OPENAI_API_KEY` 等を既定で削除)。
- 全サーバサイド URL fetch に SSRF 防御
  (`parallel-analysis.ts::isSafeUrl`)。
- `logAction` は shell-free: `curl POST /api/log-action` のみ受理。
  旧 `node -e` 経路は shell / prompt injection RCE を許容したため
  1.2.91 で廃止。
- `awaiting_approval` / `submitted` への 422 API ガード:
  `sentMessage` / スクショ欠如、TEL/MAIL ダンプのみの縮退本文 (30 文字
  未満) を拒否。

---

## ライセンス

[MIT License](../../LICENSE)。`package.json` の `license` フィールド
(`MIT`) が本プロジェクトの公式ライセンスです。

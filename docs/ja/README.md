# Sales Claw

[![Release](https://img.shields.io/github/v/release/joseikininsight-hue/sales-claw-ts?style=flat-square)](https://github.com/joseikininsight-hue/sales-claw-ts/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-100%25-blue.svg?style=flat-square)](https://www.typescriptlang.org/)

AI CLI を活用した企業問い合わせフォーム営業ツールです。
ターゲット企業のWebサイトを分析し、カスタマイズされたメッセージを生成し、問い合わせフォームへの入力を支援します。

> **2.0.0 (2026-05-14)**: TypeScript 完全移植版の初回安定リリース。`src/` 配下は
> 100% TypeScript、サーバー側コードの型安全性が確立しました。
> 詳細は [CHANGELOG](./CHANGELOG.md) を参照してください。

最新バージョンは [GitHub Releases](https://github.com/joseikininsight-hue/sales-claw-ts/releases) を参照してください。

現在は次の CLI を切り替えて利用できます。

- Claude Code CLI
- Codex CLI
- Gemini CLI

## ダウンロード・インストール

### Step 1 — アプリをダウンロード

公開先リポジトリの [Releases](https://github.com/joseikininsight-hue/sales-claw-ts/releases) ページから OS に合ったファイルをダウンロードしてください。

| OS | ダウンロードするファイル |
|----|----------------------|
| **Windows** | `Sales-Claw-Setup-x.x.x.exe` |
| **macOS (Apple Silicon)** | `Sales-Claw-x.x.x-arm64.dmg` |
| **macOS (Intel)** | `Sales-Claw-x.x.x-x64.dmg` |
| **Linux** | `Sales-Claw-x.x.x-x64.AppImage` |

> **Source code (zip/tar.gz) は開発者向けです。一般ユーザーは不要です。**
> デスクトップ版を使うだけなら Node.js の別途インストールは不要です。

ダウンロードしたファイルを実行してインストールしてください。

### Step 2 — 利用する AI CLI をインストール（必須・別途）

Sales Claw の AI 機能は CLI を 1 つ以上インストールして使います。
アプリとは別にインストールが必要です。

```bash
# Claude
npm install -g @anthropic-ai/claude-code

# Codex
npm install -g @openai/codex

# Gemini
npm install -g @google/gemini-cli
```

> ソースコード版から使う場合は Node.js 18+ が必要です。[nodejs.org](https://nodejs.org/) からインストールしてください。

### Step 3 — 初期設定

1. Sales Claw を起動する
2. **Settings タブ**を開く（セットアップ進捗トラッカーで完了状況を確認）
3. 自社情報（社名・担当者名・連絡先など）を入力して保存
4. `AI Provider` で利用する CLI を選ぶ
5. `営業アプローチ方針` に「何をしたいか / 何を避けたいか」を自然文で入力する

### Step 4 — ターゲットリストを用意する

Excel (.xlsx) または CSV にターゲット企業を記載し、Settings タブの「ターゲットリスト」でファイルを指定します。

### Step 5 — 営業開始

ダッシュボードの `AI を起動` から選択中の CLI を managed セッションとして起動できます。ログインや API キー入力が必要な場合は `外部ターミナル` を使ってください。

```
> 3社確認待ちまで進めて
> 企業Aに問い合わせを送って
```

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│          Claude / Codex / Gemini CLI                │
│   (企業分析・メッセージ生成・フォーム入力を指示)        │
└────────────┬────────────────────────┬────────────────┘
             │                        │
     ┌───────▼───────┐       ┌───────▼────────┐
     │  MCP Playwright │       │  Node.js Modules │
     │  (ブラウザ操作)  │       │  (分析・生成)     │
     └───────┬───────┘       └───────┬────────┘
             │                        │
     ┌───────▼────────────────────────▼────────┐
     │   Desktop App / Local Dashboard (127.0.0.1) │
     │  企業一覧 | 確認待ち | 送信済み | 設定     │
     └─────────────────────────────────────────┘
```

### 2フェーズ並列処理

複数企業をまとめて処理する場合、トークンコスト削減と速度最適化のため2フェーズに分離：

| フェーズ | 処理 | 実行主体 | 並列 |
|---------|------|---------|------|
| **A** | サイト分析 + メッセージ生成 + フォームURL自動解決 | バックエンド（Node.js直接） | N社同時 |
| **B** | フォーム入力 + スクリーンショット | AI managed セッション + Playwright | 1社ずつ |

### 送信ポリシー

- **既定**: 確認待ちで停止（人間が送信判断）
- **オプション**: `安全なフォームは自動送信する` を有効にすると、CAPTCHA/手動確認/営業NGがないフォームのみ自動送信
- CAPTCHA・判断が難しいフォームは設定に関わらず確認待ちで停止

## Prerequisites

- **Node.js** 18+（ソースコード版のみ）
- **Claude Code CLI** または **Codex CLI** または **Gemini CLI**
- **Playwright** — `npx playwright install chromium`

## Quick Start

### 1. Install

```bash
git clone https://github.com/joseikininsight-hue/sales-claw-ts.git
cd sales-claw
npm install
npx playwright install chromium
```

### 2. Configure

**Option A: Dashboard UI (推奨)**

```bash
# サンプル設定をコピー
# Windows (PowerShell): Copy-Item data/sample-settings.json data/settings.json
# macOS / Linux: cp data/sample-settings.json data/settings.json

# デスクトップアプリを起動
npm start

# ブラウザ版だけ使いたい場合
npm run dashboard
```

**Option B: テキストファイルで設定**

```bash
# サンプル設定をコピーして編集
# Windows (PowerShell): Copy-Item data/sample-settings.json data/settings.json
# macOS / Linux: cp data/sample-settings.json data/settings.json
# data/settings.json をエディタで開き、自社情報を入力
```

### 3. Prepare Target List

Excel (.xlsx) または CSV ファイルにターゲット企業を記載します。

| No. | ステータス | 企業名 | 種別 | WebサイトURL | 問い合わせフォームURL |
|-----|----------|--------|------|-------------|-------------------|
| 1   | 〇       | 企業A  | SIer | https://... | https://...       |
| 2   |          | 企業B  | コンサル | https://... |               |

ファイルパスをダッシュボードの「ターゲットリスト」設定で指定してください。

### 4. Start Outreach

```bash
# 選択した CLI で指示
# Claude: claude
# Codex: codex
# Gemini: gemini

# 以下のように指示するだけ
> 3社確認待ちまで進めて
> 企業Aに問い合わせを送って
```

## Release

`v*` タグを push すると [release workflow](./.github/workflows/release.yml) が動き、GitHub Releases に各 OS 向けの成果物を公開します。

一般ユーザー向けに案内するのは次のファイルです。

- Windows: `Sales-Claw-Setup-<version>.exe`
- macOS: `Sales-Claw-<version>-*.dmg`
- Linux: `Sales-Claw-<version>-*.AppImage`

`latest*.yml` は自動アップデート用で、通常ユーザーは手動でダウンロードする必要はありません。

## Configuration

### data/settings.json

全設定を管理する単一ファイルです。ダッシュボードのSettingsタブから編集できます。

| セクション | 内容 |
|-----------|------|
| `companyProfile` | 自社の会社情報（社名・担当者・連絡先・備考等） |
| `valuePropositions` | 自社の強み・実績・業種別プロフィール・サービスURL・ドキュメント |
| `targetList` | ターゲットリストのファイルパス・カラムマッピング |
| `exclusionRules` | 競合・既存顧客・NGリスト・除外ステータス |
| `messageTemplates` | メッセージのトーン・テンプレート・署名・書面設定 |
| `preferences` | ポート・言語・AIプロバイダー・送信ポリシー・ログ設定 |

詳細は `data/sample-settings.json` を参照してください。

## Dashboard

通常は `npm start` でデスクトップアプリとして起動します。
ブラウザのみで使う場合は `npm run dashboard`。
待受はローカル専用 `127.0.0.1` で、設定ポートが埋まっている場合は近い空きポートへ自動退避します。

| タブ | 機能 |
|------|------|
| **企業一覧** | ターゲット企業の状態一覧（フィルタ・検索・ソート）+ 統合アナリティクスパネル |
| **確認待ち** | フォーム入力済み → 人間の送信判断待ち |
| **送信済み** | 送信完了企業の文面・スクショ・連絡履歴 |
| **CLI Activity** | AI CLI からのリアルタイムアクションログ |
| **Settings** | 全設定をUIから管理（セットアップ進捗トラッカー付き） |

### 統合アナリティクスパネル

企業一覧タブ上部に常時表示：

- **パイプラインバー**: ステージ別進捗を水平バーで可視化
- **リアルタイム統計**: 対象数・フォーム有数・入力済数・確認待ち数
- **ステータス内訳**: ドーナツチャート
- **処理推移**: 7日間のエリアチャート

### 進行状況ログ

右下のフローティングボタン（FAB）から開閉。チャットボット風のイベントストリームで処理状況をリアルタイム表示。パネルを閉じた状態でもトースト通知で新着を通知。

## File Structure

```
sales-claw/
├── electron-main.js          # Electron メインプロセス（自動更新・システムトレイ）
├── DESIGN.md                 # UIデザインシステムドキュメント
├── src/
│   ├── dashboard-server.cjs  # ダッシュボード（メインサーバー + UI）
│   ├── settings-manager.cjs  # 設定管理（Single Source of Truth）
│   ├── ai-providers.cjs      # マルチAIプロバイダー管理
│   ├── company-analyzer.cjs  # 企業サイト分析（Playwright）
│   ├── parallel-analysis.cjs # 並列分析エンジン（HTTPベース、MCP不使用）
│   ├── form-url-resolver.cjs # フォームURL自律探索（SSRF安全）
│   ├── form-finder.cjs       # フォームURL探索
│   ├── form-validator.cjs    # フォーム事前検証
│   ├── form-helpers.cjs      # フォーム操作ヘルパー
│   ├── message-builder.cjs   # メッセージ生成
│   ├── live-monitor.cjs      # 進行状況モニター（ファイルロック付き）
│   ├── action-logger.cjs     # 操作ログ（ファイルロック+アトミックライト）
│   ├── contact-history.cjs   # 連絡履歴管理（マルチコンタクト対応）
│   ├── approval-artifacts.cjs # 承認フロー制御（スクショ監査）
│   ├── cli-logger.cjs        # CLIログ + 思考中インジケーター
│   ├── email-fetcher.cjs     # Outlookメール取得
│   ├── config.cjs            # 設定読み取りインターフェース
│   └── ...                   # その他ユーティリティ
├── data/
│   ├── sample-settings.json  # 設定サンプル
│   ├── sample-targets.csv    # 公開用サンプルターゲット
│   └── settings.json         # 実際の設定（.gitignore対象）
├── screenshots/              # フォーム入力・確認画面のスクショ
├── CLAUDE.md                 # Claude Code 用プロジェクト説明
├── package.json
├── LICENSE                   # MIT
├── README.md                 # このファイル
└── CONTRIBUTING.md           # コントリビューションガイド
```

## How It Works

1. **企業分析**: `company-analyzer.cjs` / `parallel-analysis.cjs` がターゲット企業のWebサイトを分析し、事業領域・注力分野を検出
2. **フォームURL解決**: `form-url-resolver.cjs` が問い合わせフォームURLを自律的に探索（SSRF安全）
3. **ギャップ検出**: 自社の強み（settings）とターゲットの弱みを比較し、協業ポイントを特定
4. **メッセージ生成**: `message-builder.cjs` が分析結果に基づいてパーソナライズされたメッセージを生成
5. **フォーム入力**: AI CLI managed セッション + MCP Playwright でフォームに自動入力
6. **人間が確認**: ダッシュボードの「確認待ち」タブでスクショ・文面を確認し、送信判断（安全フォーム自動送信オプションあり）
7. **履歴管理**: 送信履歴・レスポンスを記録し、2回目以降のフォローに活用

## Security

- `data/settings.json` には会社情報が含まれます。`.gitignore` で除外済みですが、取り扱いに注意してください
- 実運用のターゲットリスト（`.xlsx` / `.csv`）は Git 管理・配布対象から除外しています。公開用サンプルは `data/sample-targets.csv` のみです
- メール機能は Outlook Web のセッションを使用します。セッション情報は `data/outlook-session/` に保存されます
- 送信前の承認フローがデフォルトで有効です（`preferences.requireApprovalBeforeSend`）
- `autoSendEligibleForms` を有効にすると、CAPTCHA等がない安全なフォームのみ自動送信可能

## Token Optimization with OMC（Claude 利用時）

[oh-my-claudecode (OMC)](https://github.com/Yeachan-Heo/oh-my-claudecode) によるモデルルーティングが**プロジェクトに組み込み済み**です。
各処理ステップに最適なモデルを自動割り当てし、トークンコストを**70-75%削減**します。

v1.1.0 では Phase B prompt のトークン最適化も実施済み（compact payload + session contract で初回 1,283 token、2回目以降 1,160 token）。

この仕組みは Claude Code CLI を使う場合の最適化です。Codex / Gemini を使う場合は OMC は前提にしません。

### セットアップ

```bash
# OMCプラグインをインストール（初回のみ）
claude /install oh-my-claudecode
# ルーティング設定は .claude/omc-routing.json に定義済み
```

### モデルルーティング

| ステップ | モデル | トークン目安 | コスト比(vs全Opus) |
|---------|--------|-----------|-----------------|
| 企業サイト分析 | **Haiku** | ~10K/社 | 1/10 |
| フォーム探索・検証 | **Haiku** | ~5K/社 | 1/10 |
| メッセージ生成 | **Sonnet** | ~8K/社 | 1/5 |
| フォーム入力+スクショ | **Sonnet** | ~15K/社 | 1/5 |
| エラー対応 | **Opus** | ~20K/件 | 1x（低頻度） |

### 3社アプローチの実コスト比較

```
全て Opus:  150K tokens — コスト 1.0x
OMC適用:    99K tokens — コスト 0.25x（75%削減）
```

設定ファイル: `.claude/omc-routing.json`, `data/settings.json`
詳細: [CLAUDE.md](./CLAUDE.md) のOMCセクション参照

## License

MIT License. See [LICENSE](./LICENSE).

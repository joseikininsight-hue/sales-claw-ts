# Sales Claw

## About This Project

企業の問い合わせフォーム経由で営業アプローチを自動化するツール。
ユーザーが設定した自社情報・ターゲットリスト・提供価値に基づいて、Claude Code CLIが企業分析→メッセージ生成→フォーム入力を実行する。

## 絶対ルール: フォーム入力+スクショなしで「確認待ち」にするな

**これはこのプロジェクトで最も重要なルール。違反は許されない。**

「確認待ち」(awaiting_approval) にログを記録する前に、以下の全ステップを**必ず完了**すること:

1. **フォームURLにアクセス** — MCP Playwrightでフォームページを開く
2. **フォーム構造を解析** — `browser_snapshot` でフィールドを特定
3. **全フィールドに実際に入力** — `browser_fill_form` で会社名・氏名・メール・電話・本文を入力
4. **入力済みフォームのスクリーンショット撮影** — `browser_take_screenshot` で `screenshots/ss-{No}-input.png` に保存
   - 確認画面や次画面が存在する場合は `screenshots/ss-{No}-confirm.png` も追加で保存してよい
   - ただし `awaiting_approval` の必須条件は **input スクショ**。`confirm` は任意の追加アーティファクト
5. **ログ記録** — `form_fill` → `confirm_reached` → `awaiting_approval` の順でログ

### やってはいけないこと（厳禁）:
- メッセージを生成しただけで `awaiting_approval` にする
- フォームにアクセスせずに `form_fill` ログを書く
- スクリーンショットを撮らずに確認待ちにする
- 「フォームが見つからなかった」で黙って確認待ちにする → `error` ログにして理由を明記

### フォーム入力に失敗した場合:
- CAPTCHA・reCAPTCHA → `error` ログ + 理由「CAPTCHA検出」+ スクショ
- フォームが見つからない → `error` ログ + 理由 + フォーム探索結果
- 入力はできたがフィールド不足 → 入力できた分のスクショを撮って `awaiting_approval` + 不足内容をログに明記

### 営業NG・対象外フォームの扱い:
- 「営業目的のお問い合わせはご遠慮ください」「既存顧客専用」「採用専用」「IR専用」「報道専用」などの記載がある場合は**送信対象外**
- 送信対象外の場合は**フォーム入力しない**
- `awaiting_approval` にしてはいけない
- `logAction(no, name, 'skipped', '営業NG/対象外: 理由')` を記録して終了する
- 可能なら理由を `live-monitor` にも反映する

### 入力項目ルール:
- 最低限の基本項目は `会社名 / 担当者名 / メール / 電話 / 問い合わせ本文`
- `部署 / 役職 / 担当者名カナ / 郵便番号 / 住所 / 携帯 / FAX / Webサイト` は、フォームに明示的な対応項目がある場合だけ入力する
- 設定に存在しない値を推測して埋めてはいけない
- `companyProfile.notes` のような内部メモはフォーム入力や送信本文に使ってはいけない

**ユーザーはダッシュボードのスクショを見て送信判断する。スクショがなければ判断できない。**

## Architecture — CLI主体

**重要: このプロジェクトはClaude Code CLIが主体で動く。**

- Claude Codeがその場で企業を分析し、メッセージを作成し、Playwrightでフォームに入力する
- フォームごとにClaude Codeが構造を見て専用ロジックを書く
- ダッシュボード（localhost:設定ポート）はUI表示・操作・設定管理
- **MCP Playwrightで1社ずつタブ切替・確実入力**
  - MCP Playwrightは1ブラウザ共有。並列エージェントから同時にMCPを呼んではいけない
  - 調査フェーズ: サブエージェントが並列で Bash + node -e 実行（MCP不使用）
  - 入力フェーズ: メインがMCP Playwrightで snapshot→ref指定→fill_form で1社ずつ確実入力
  - 各社を別タブで処理し、タブは閉じない（ユーザーが各タブで送信操作可能）

## Desktop Release / Auto Update Gate

**開発環境・Web環境・インストール済みElectronの差分を放置してはいけない。**

デスクトップ配布に関わる変更をした場合、Claude Code / Codex は以下を必ず守る:

1. プレビューダッシュボードは必ずルートの `npm run dashboard:preview` を使う。`.claude/worktrees/*` の 3480 表示だけを最新扱いしない
2. 運用ダッシュボードの正本は `src/dashboard-server.cjs` + `src/ui/**` + `src/routes/**`。プレビュー/Electron は同じ正本から起動する
3. Web版 `npm run lp:dev` はランディング/公開Web用。運用ダッシュボードの代替正本にしてはいけない
4. `npm start` / `npm run dashboard:preview` / `npm run lp:dev` の表示だけで「デスクトップ版も最新」と判断しない
5. リリース対象なら `package.json` / `package-lock.json` の version を必ず上げる
6. ビルド前に `npm run verify:release` を実行する
7. Windows配布物は `npm run dist:win -- --publish never` で生成する
8. ビルド後に `npm run verify:dist` を実行し、`app-update.yml` と `latest.yml` の整合を確認する
9. ローカルPCへ入れる場合は `npm run install:win` を使う。全ユーザー版は管理者PowerShellで `scripts/install-latest-win.ps1 -AllUsers`
10. `electron-builder.yml` に `local-test` / `${env.GH_OWNER}` / `${env.GH_REPO}` を戻してはいけない
11. `npm run verify:dist` が通るまで、自動アップデート準備完了と言ってはいけない

詳細手順は `docs/release-parity-and-autoupdate.md`。Claude Code では `/release-parity` コマンドを使える。

## Configuration

全設定は `data/settings.json` で管理。ダッシュボードのSettingsタブから編集可能。

### 設定の読み取り方法

```javascript
const settings = require('./settings-manager.cjs');

// 会社情報
const sender = settings.getSender();

// 自社の強み
const strengths = settings.getStrengths();

// 協業パターン
const patterns = settings.getSuccessPatterns();

// 業種別プロフィール
const profiles = settings.getIndustryProfiles();

// ターゲットリストパス
const listPath = settings.getTargetListPath();

// 除外ステータス
const excludes = settings.getExcludeStatuses();
```

初回セットアップ:
```bash
cp data/sample-settings.json data/settings.json
```

## Workflow

**1社あたりの必須フロー（省略不可）:**
```
Step 1: 企業サイト分析
  → company-analyzer.cjs or MCP Playwrightでサイト巡回
  → logAction(no, name, 'site_analysis', 分析結果)

Step 2: メッセージ生成
  → message-builder.cjs の buildCustomMessage(analysis) で草案生成
  → buildMessagePrompt(analysis) で CLI 用パーソナライズ prompt も構築
  → Phase B の CLI は messagePrompt を使って本文を最終化し、templateDraft はフォールバックとして扱う
  → logAction(no, name, 'message_draft', メッセージ全文)

Step 3: フォームにアクセス
  → MCP Playwright: browser_navigate でフォームURLを開く
  → browser_snapshot でフォーム構造を解析

Step 4: フォームに入力 ★ 絶対省略するな
  → browser_fill_form で全フィールドに入力
  → 会社名・氏名・メール・電話・部署・本文を settings から読み取って入力
  → logAction(no, name, 'form_fill', '入力完了')

Step 5: スクリーンショット ★ 絶対省略するな
  → browser_take_screenshot で screenshots/ss-{No}-input.png に保存（必須）
  → 確認画面や次画面がある場合は screenshots/ss-{No}-confirm.png も追加で保存（任意）
  → ダッシュボード監査の必須条件は ss-{No}-input.png。confirm は追加の確認用として扱う
  → logAction(no, name, 'confirm_reached', 'スクショ撮影完了')

Step 6: 確認待ちに登録
  → logAction(no, name, 'awaiting_approval', 'ダッシュボードで確認待ち')
  → ★ Step 4, 5 が完了していない場合、このステップに進んではいけない
```

**複数社の場合:**
```
「3社確認待ちまで」と指示された場合:
→ 一気に最後まで進める。途中でメッセージ承認を求めて止まらない。
→ Step 1-2 は並列エージェントで同時処理可能（MCP不使用）
→ Step 3-6 はメインが1社ずつ順番にMCP Playwrightで処理（MCP共有のため並列不可）

1. メインでN社選定 + フォーム検証（並列）
2. 各社の分析→メッセージ生成を並列Agent実行（MCP不使用）
3. メインがMCP Playwrightで1社ずつフォーム入力→スクショ→確認待ち登録
4. 全社完了後、結果を集約してユーザーに報告
→ 送信判断はダッシュボードの確認待ちタブで人間が行う

「〇〇に送って」の場合:
→ メッセージ案をユーザーに提示 → 承認されたら入力→スクショまで進める
```

## Message Generation

メッセージは `data/settings.json` の以下を参照して生成:
- `companyProfile` — 送信者情報
- `valuePropositions.strengths` — 自社の強み（ギャップ分析に使用）
- `valuePropositions.successPatterns` — 協業実績
- `valuePropositions.industryProfiles` — 業種別テンプレート
- `messageTemplates` — 文面のトーン・署名・CTA

### メッセージ作成方針
- 実績は控えめに（企業名を全面に出さない。数字は使ってOK）
- **相手に何を提供できるかを前面に**（箇条書きで明確に）
- 相手の事業に触れる（「貴社の〇〇事業を拝見」）
- 相手の強み × 自社の強みの組み合わせ提案

## OMC（oh-my-claudecode）モデルルーティング — トークン節約

このプロジェクトはOMCのモデルルーティングに対応。
各ステップで最適なモデルを使い分けることで、**トークンコストを60-70%削減**できる。

### インストール（初回のみ）
```bash
claude /install oh-my-claudecode
```

### ステップ別モデル割り当て

| ステップ | 処理内容 | モデル | 理由 |
|---------|---------|--------|------|
| 企業サイト分析 | URL巡回→テキスト抽出→事業領域検出 | **haiku** | パターンマッチング。深い推論不要 |
| フォーム探索 | リンク辿り→フォームURL特定 | **haiku** | 単純なWeb巡回 |
| フォーム検証 | フォーム構造解析→入力可否判定 | **haiku** | 構造チェックのみ |
| メッセージ生成 | ギャップ分析→カスタム文面作成 | **sonnet** | 自然な日本語の文章生成が必要 |
| フォーム入力 | MCP Playwright操作→フィールド入力 | **sonnet** | フォーム構造の理解+正確な操作 |
| ダッシュボード設定変更 | settings.json読み書き | **haiku** | CRUD操作のみ |
| 除外判定・企業選定 | リスト走査→条件マッチ | **haiku** | ルールベース判定 |
| エラー対応・デバッグ | フォーム入力失敗の原因調査 | **opus** | 複雑な問題解決 |
| ワークフロー全体指揮 | 複数社の並列処理オーケストレーション | **sonnet** | メイン制御 |

### OMCエージェント活用マッピング

```
企業分析（並列）  → explore (haiku) × N社同時
メッセージ生成     → executor (sonnet) — 文章品質が重要
フォーム入力       → メインが直接MCP操作 (sonnet)
設定変更          → executor-low (haiku) — 単純なJSON操作
エラー調査        → architect (opus) — 複雑なデバッグのみ
```

### 典型的な「3社確認待ちまで」のトークン配分

```
従来（全てopusで実行した場合）:
  3社 × (分析 + メッセージ + フォーム入力) ≈ 150K tokens @ opus

OMCルーティング適用後:
  分析:     3社 × 10K tokens @ haiku  = 30K (コスト: opus比 1/10)
  メッセージ: 3社 × 8K tokens @ sonnet = 24K (コスト: opus比 1/5)
  フォーム:   3社 × 15K tokens @ sonnet = 45K (コスト: opus比 1/5)
  合計: 99K tokens, 実効コスト ≈ 従来の 25-30%
```

### 使い方

OMCインストール済みなら、自動的にモデルルーティングが適用される。
手動でモデルを指定する場合:

```
# 企業分析を haiku で実行
Agent(model: "haiku", prompt: "企業分析して")

# メッセージ生成を sonnet で実行
Agent(model: "sonnet", prompt: "メッセージ生成して")
```

OMCのultraworkモードで並列実行する場合:
```
/ultrawork
→ 3社の企業分析を haiku エージェント3つで同時実行
→ 完了後、sonnet でメッセージ生成
→ メインがMCP Playwrightでフォーム入力
```

## File Structure

```
sales-claw/
├── AGENTS.md                   # このファイル（プロジェクト説明）
├── settings-manager.cjs        # 設定管理（全設定のSingle Source of Truth）
├── config.cjs                  # 設定読み取りインターフェース
├── electron-main.js            # Electron メインプロセス
├── src/
│   ├── dashboard-server.cjs    # ダッシュボード + 設定UI
│   ├── action-logger.cjs       # 操作ログ管理
│   ├── contact-history.cjs     # 連絡履歴管理
│   ├── company-analyzer.cjs    # 企業サイト分析
│   ├── form-validator.cjs      # フォーム事前検証
│   ├── form-finder.cjs         # フォームURL探索
│   ├── form-helpers.cjs        # フォーム操作ヘルパー
│   ├── live-monitor.cjs        # 進行状況モニター管理
│   ├── message-builder.cjs     # メッセージ生成
│   ├── email-fetcher.cjs       # Outlookメール取得
│   └── cli-logger.cjs          # ダッシュボードCLI Activity通知
├── data/
│   ├── settings.json           # 全設定（.gitignore対象）
│   ├── sample-settings.json    # 設定サンプル
│   ├── sample-targets.csv      # 公開用サンプルターゲット
│   ├── action-log.json         # 全操作ログ
│   └── contact-history.json    # 連絡履歴
└── screenshots/                # フォーム入力・確認画面のスクショ
```

## Agent Orchestration

このプロジェクトは **Claude Code（オーケストラ）+ Codex（バックエンド実装補助）** の2エージェント体制で開発できる。

| 担当 | エージェント | 対象 |
|------|------------|------|
| フロントエンド・UI設計・統合・メイン制御 | **Claude Code** | HTML/CSS/i18n/ダッシュボードUI/フォーム入力 |
| バックエンド実装補助 | **Codex** | .cjs サーバーロジック・データ処理・ファイル操作 |

### Codex 呼び出し（オプション）

```bash
codex exec -m o3 -s workspace-write "タスク内容"
```

- モデル: `o3`（推奨）または `o4-mini`（コスト重視）
- 作業ディレクトリ: リポジトリルート

## Session Quick Start

1. `npm start` または Electron アプリでダッシュボード起動
2. ユーザーの指示に従って営業アプローチを実行
3. 設定が未完了の場合はダッシュボードのSettingsタブで設定を促す

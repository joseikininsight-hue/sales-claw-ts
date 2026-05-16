# Sales Claw — セットアップガイド

> English version: [SETUP.md](../../SETUP.md)

このガイドは「インストーラをダウンロードした」状態から「最初のメッセージが
人間の承認待ちに乗る」状態まで、約 15 分で到達するための手順です。
Windows / macOS / Linux すべてのプラットフォーム、Claude Code / Codex /
Gemini すべての AI CLI に対応しています。

すでに Node.js に慣れていてワンライナーだけ知りたい方は
[5. 初回送信 (5 分)](#5-初回送信-5-分) まで飛ばしてください。

---

## 目次

1. [動作環境](#1-動作環境)
2. [インストール](#2-インストール)
3. [初回起動](#3-初回起動)
4. [AI プロバイダのセットアップ](#4-ai-プロバイダのセットアップ)
5. [初回送信 (5 分)](#5-初回送信-5-分)
6. [バイリンガル設定 (v2.0.37+)](#6-バイリンガル設定-v2037)
7. [自動アップデート](#7-自動アップデート)
8. [旧バージョンからの移行](#8-旧バージョンからの移行)
9. [アンインストール](#9-アンインストール)

---

## 1. 動作環境

### OS

| OS | サポート | インストーラ | 備考 |
|----|--------|-----------|------|
| **Windows 10 (1809+) / Windows 11** | 推奨 | NSIS `.exe` | ユーザー単位インストール (管理者権限不要) |
| **macOS 11 (Big Sur) 以降** | 対応 | `.dmg` (arm64 / x64) | Apple Silicon 推奨 |
| **Linux (x86_64, glibc 2.31+)** | 対応 | `.AppImage` | Ubuntu 22.04 / Fedora 38 で検証済み |

> Windows on ARM、32bit Linux、古い macOS (≤ 10.15 Catalina) は未検証です。
> Ubuntu 20.04 は実用上動作しますが、公式サポート対象外です。

### ランタイム

| コンポーネント | 必要なケース | 最低バージョン |
|----|----|----|
| **Node.js** | ソースビルド時のみ (インストーラには同梱済み) | 20.0.0 |
| **Claude Code CLI** | デフォルトの AI ドライバ | 2.0.0 |
| **Codex CLI** | 代替 AI ドライバ | 0.128.0 (gpt-5.5 対応) |
| **Gemini CLI** | 代替 AI ドライバ | 0.5.0 |
| **Git** | ソースビルド + `npm run preflight` | 2.30+ |

3 つの CLI のうち **どれか 1 つ** だけで動作します。Claude Code がデフォルト
かつ最も検証されています。

### ブラウザ

Electron 版は Chromium を内包しているので、フォーム入力用の追加ブラウザ
インストールは不要です。MCP Playwright も初回起動時にヘッドレス Chromium を
自動ダウンロード (~150 MB) します。

### ディスク・メモリ

| リソース | 推奨 |
|----|----|
| ディスク (アプリ本体) | ~500 MB |
| ディスク (ランタイムデータ + スクリーンショット) | ~1 GB (使用に応じて増加) |
| RAM | 最低 4 GB、推奨 8 GB |

> List Builder で 1,000 社規模のリストを処理する場合、一時的に 1.5 GB の
> RAM を使うことがあります。その規模で運用する場合は 16 GB を割り当ててください。

困ったら [TROUBLESHOOTING.md](../../TROUBLESHOOTING.md) /
[FAQ.md](../../FAQ.md) / [SUPPORT.md](../../SUPPORT.md) を参照してください。

---

## 2. インストール

### オプション A: ビルド済みインストーラ (推奨)

最新版を **[GitHub Releases](https://github.com/joseikininsight-hue/sales-claw-ts/releases)**
からダウンロードしてください。

#### Windows

1. `Sales-Claw-Setup-2.0.37.exe` をダウンロード。
2. ダブルクリックしてインストーラを起動。
3. **SmartScreen 警告** — 現状ビルドは自己管理証明書で署名されているため、
   Windows Defender SmartScreen が「Windows によって PC が保護されました」
   と表示することがあります。**詳細情報** → **実行** をクリックしてください。
4. ユーザー単位インストールなので管理者昇格は不要です。
5. デフォルトのインストール先:
   `%LOCALAPPDATA%\Programs\Sales Claw\` (例:
   `C:\Users\you\AppData\Local\Programs\Sales Claw\`)。
6. スタートメニュー (オプションでデスクトップ) にショートカットが作成されます。

代わりに **全ユーザー向け** にインストールする場合 (管理者権限必要):

```powershell
# 管理者権限の PowerShell から実行
scripts\install-latest-win.ps1 -AllUsers
```

#### macOS

1. ご利用の機種に合った `.dmg` をダウンロード:
   - Apple Silicon (M1/M2/M3): `Sales-Claw-2.0.37-arm64.dmg`
   - Intel: `Sales-Claw-2.0.37-x64.dmg`
2. DMG をダブルクリックし、**Sales Claw.app** を `/Applications` に
   ドラッグ。
3. 初回起動: 未署名アプリのため macOS Gatekeeper がブロックします。
   システム設定 → プライバシーとセキュリティ → 「Sales Claw はブロック
   されました」までスクロール → **このまま開く** をクリック。
4. 再度確認ダイアログで **開く** を選択。

#### Linux

1. `Sales-Claw-2.0.37-x86_64.AppImage` をダウンロード。
2. 実行権を付与して起動:

```bash
chmod +x Sales-Claw-2.0.37-x86_64.AppImage
./Sales-Claw-2.0.37-x86_64.AppImage
```

3. オプションでデスクトップ統合:
   [AppImageLauncher](https://github.com/TheAssassin/AppImageLauncher) を
   インストールすると AppImage をダブルクリックで管理できます。

### オプション B: ソースからビルド

コントリビュータ・セキュリティ監査者・未対応プラットフォームのユーザー向け。

```bash
git clone https://github.com/joseikininsight-hue/sales-claw-ts.git
cd sales-claw-ts

# 依存解決 (~5 分)
npm install

# TypeScript ビルド
npm run build

# ダッシュボードを開発モードで起動
npm start
```

ダッシュボードは `http://127.0.0.1:3765` で起動します (ポートが使用中なら
3766, 3767, … にフォールバック)。実 URL は管理 PTY 起動時に
`$SALES_CLAW_DASHBOARD_URL` として CLI セッションに渡されます。

ローカルでネイティブインストーラをビルドする場合:

```bash
# Windows (Windows 上の PowerShell から実行)
npm run dist:win -- --publish never

# macOS (macOS 上で実行)
npm run dist:mac -- --publish never

# Linux (Linux 上で実行)
npm run dist:linux -- --publish never
```

成果物は `dist/` に出力されます。

> GitHub Releases に意図的に push する場合を除き、`npm run dist:*` は
> **必ず** `-- --publish never` を付けてください。

困ったら [TROUBLESHOOTING.md](../../TROUBLESHOOTING.md) /
[FAQ.md](../../FAQ.md) / [SUPPORT.md](../../SUPPORT.md) を参照してください。

---

## 3. 初回起動

### 3.1 オンボーディングウィザード

初回起動時 (`settings.json` が存在しない、または sample 状態) には、
Sales Claw が `http://127.0.0.1:3765/onboarding` の 5 ステップウィザードに
自動リダイレクトします。

後でウィザードを再度開く場合:

```
http://127.0.0.1:3765/onboarding           # 通常起動 (進捗を再開)
http://127.0.0.1:3765/onboarding?fresh=1   # 進捗をクリアして 1 から
```

#### ステップ 1: 言語と利用規約

- UI 言語を選択: 🇯🇵 日本語 / 🇺🇸 English。
- OSS / 自己責任の同意にチェック。
- 免責事項 (迷惑メール法、配信停止義務、事実性) が選択言語で表示されます。

#### ステップ 2: 自社プロフィール

ここで入力した内容がすべてのコンタクトフォームに転記されます。正確に
入力してください。

| 項目 | 必須 | 補足 |
|----|----|----|
| `companyName` | ✅ | 自社の正式名称 |
| `contactName` | ✅ | 送信者個人名 |
| `email` | ✅ | 返信先アドレス (実際に届く必要あり) |
| `phone` | ✅ | オフィス電話 (フォームで電話番号必須の場合に使用) |
| `address` | ✅ | 郵便住所 (CAN-SPAM・特定商取引法で必須) |
| `department` | 任意 | フォームに対応欄がある場合のみ入力 |
| `contactTitle` | 任意 | 例: 「営業部長」 |
| `mobile` | 任意 | フォームが携帯と固定電話を区別する場合のみ |
| `website` | 任意 | 自社 URL |

> Sales Claw は設定にない値を **絶対に** 推測しません。任意項目を
> 空欄にした場合、フォーム入力時も空欄のままです。

#### ステップ 3: 自社の強み

8 種類のプリセット (例:「コスト削減」「DX 支援」「マーケ加速」) から該当
するものを選ぶか、独自の強みを 1〜3 個記入します。これらの値は AI が
メッセージを書く際のフックとして使われます。

#### ステップ 4: ターゲットリスト

下記のいずれか:

- `.xlsx` または `.csv` をドロップ (スキーマはリポジトリ同梱の
  `data/sample-targets.csv` と同じ)
- スキップしてダッシュボードから後で手動追加

#### ステップ 5: AI プロバイダ

Claude / Codex / Gemini から **1 つ** を選択。ウィザードが CLI の
インストール状況とログイン状況をチェックし、未設定なら修復コマンドを
表示します。プロバイダ別の詳細は [4. AI プロバイダのセットアップ](#4-ai-プロバイダのセットアップ)
を参照してください。

5 ステップが完了すると `data/settings.json` に
`_onboardedAt: "<ISO タイムスタンプ>"` フィールドが追加され、以降は
通常のダッシュボードに直接遷移します。

### 3.2 設定ファイルの保存場所

| OS | パス |
|----|----|
| Windows | `%APPDATA%\sales-claw-ts\runtime\data\settings.json` |
| macOS | `~/Library/Application Support/sales-claw-ts/runtime/data/settings.json` |
| Linux | `~/.config/sales-claw-ts/runtime/data/settings.json` |

ダッシュボードの Settings タブから編集するのが正規の方法です。手動で
JSON を編集する場合は自己責任で (次回起動時にバリデーションされます)。

困ったら [TROUBLESHOOTING.md](../../TROUBLESHOOTING.md) /
[FAQ.md](../../FAQ.md) / [SUPPORT.md](../../SUPPORT.md) を参照してください。

---

## 4. AI プロバイダのセットアップ

オンボーディングのステップ 5 で選択したプロバイダだけ設定すれば OK です。
**Settings → AI provider** から後で切り替えも可能です。

### 4.1 Claude Code CLI (推奨)

#### インストール

```bash
# npm でグローバルインストール
npm install -g @anthropic-ai/claude-code

# バージョン確認
claude --version
# → claude-code 2.0.x
```

最低サポートバージョン: **2.0.0** (それより古いバージョンには Windows の
`cmd.exe` クォーティングバグがあります。CLAUDE.md → Known traps 参照)。

#### ログイン

2 つの方法:

**オプション A — Anthropic サブスクリプション (Sales Claw 推奨):**

```bash
claude
# ブラウザで OAuth ログイン画面が開きます
# Pro / Team / Max ワークスペースを選択
```

`ANTHROPIC_API_KEY` は不要。利用量はサブスクリプションに対して
カウントされます。

**オプション B — 従量課金 API キー:**

```bash
# Linux / macOS
export ANTHROPIC_API_KEY=sk-ant-...

# Windows (PowerShell)
$env:ANTHROPIC_API_KEY = "sk-ant-..."

# Windows (永続化)
setx ANTHROPIC_API_KEY "sk-ant-..."
```

> Sales Claw の運用では、企業あたりのコストが上限つきで予測可能になる
> **サブスクリプション** を推奨します。API キーモードは少量利用・実験用途
> には十分です。

ログイン状態を確認:

```bash
claude auth status --json
# → { "loggedIn": true, "account": "your@email", ... }
```

#### MCP Playwright

Sales Claw が CLI から実ブラウザを操作するため、Playwright MCP サーバーを
登録する必要があります。**Sales Claw が初回起動時に自動登録** します:

```bash
claude mcp add --scope user playwright -- node /path/to/playwright-mcp-wrapper.cjs
```

手動登録 (自動セットアップが失敗した場合のみ):

```bash
# ラッパーパスを取得
node -e "console.log(require.resolve('@playwright/mcp/lib/server.js'))"

# 登録
claude mcp add --scope user playwright -- node <wrapper-path>
```

確認:

```bash
claude mcp list
# → playwright: ✓ Connected
```

`playwright: ✗ Failed to connect` と出る場合、最も多い原因は古い Node
バージョンです。
[TROUBLESHOOTING.md → Category 1](../../TROUBLESHOOTING.md) を参照してください。

#### Claude Code のトラブルシューティング

| 症状 | 対処 |
|----|----|
| MCP 登録タイムアウト | MCP を再起動: `claude mcp remove playwright && claude mcp add ...`。TROUBLESHOOTING.md → Category 1 |
| `claude: command not found` (npm i -g 後) | npm のグローバル bin を `$PATH` に追加: `npm config get prefix` |
| ログインのブラウザが開かない | `claude --print-login-url` で URL を取得し手動で開く |
| `auto mode unavailable for this model` | `bypassPermissions` 経由で起動 (CLAUDE.md → Workflow Step 0 参照) |

### 4.2 Codex CLI

#### インストール

```bash
npm install -g @openai/codex

# バージョン確認
codex --version
# → codex 0.128.x 以降
```

最低サポートバージョン: **0.128.0** (Sales Claw の Phase A.5 メッセージ
生成には gpt-5.5 モデルサポートが必要)。

#### ログイン

Codex は API キー認証のみ (現状 OAuth サブスクリプションモードは未対応):

```bash
# Linux / macOS
export OPENAI_API_KEY=sk-...

# Windows (PowerShell, 永続化)
setx OPENAI_API_KEY "sk-..."
```

Sales Claw のダッシュボードからキーを入力することもできます:
**Settings → AI provider → Codex → API key**。値は `settings.json` ではなく
OS のキーリング (Windows 資格情報マネージャ / macOS キーチェーン / Linux の
libsecret) に保存されます。

#### MCP Playwright

Sales Claw が初回起動時に自動登録します:

```bash
codex mcp add playwright -- node /path/to/playwright-mcp-wrapper.cjs
```

確認:

```bash
codex mcp list
# → playwright: connected
```

#### Sales Claw からの動作確認

```bash
# Codex が正しく接続されているか確認
codex exec -m gpt-5.5 -s workspace-write "echo hello"
```

`hello` と出力されれば、Sales Claw から Codex を駆動できる状態です。

### 4.3 Gemini CLI

#### インストール

```bash
npm install -g @google/gemini-cli

# バージョン確認
gemini --version
# → gemini-cli 0.5.x
```

#### ログイン

2 つの方法:

**オプション A — Google アカウント OAuth (推奨):**

```bash
gemini auth login
# ブラウザで Google ログイン画面が開きます
```

**オプション B — API キー:**

```bash
# Linux / macOS
export GEMINI_API_KEY=...

# Windows (PowerShell, 永続化)
setx GEMINI_API_KEY "..."
```

確認:

```bash
gemini auth status
# → Authenticated as your@gmail.com
```

#### MCP Playwright

Sales Claw が自動登録します:

```bash
gemini mcp add playwright -- node /path/to/playwright-mcp-wrapper.cjs
```

`gemini mcp list` で確認してください。

> Gemini の MCP サポートは Claude / Codex に比べて新しいので、不安定なら
> Claude Code にフォールバックしてください。

困ったら [TROUBLESHOOTING.md](../../TROUBLESHOOTING.md) /
[FAQ.md](../../FAQ.md) / [SUPPORT.md](../../SUPPORT.md) を参照してください。

---

## 5. 初回送信 (5 分)

セットアップ完了です。エンドツーエンドで動作することを確認するために、
テスト送信をしてみましょう。

1. **Sales Claw を起動。** ダッシュボードが
   `http://127.0.0.1:3765` (またはタイトルバーに表示されたポート) で
   開きます。
2. **設定を確認** — Settings タブ → 自社プロフィールと強みが正しいか
   確認。
3. **サンプルリストをインポート** — リポジトリには
   `data/sample-targets.csv` (架空企業 5 社) が同梱されています。
   List Builder → ファイルインポート、またはドラッグ & ドロップで
   読み込みます。
4. **1〜3 社を選択** して **AI Form Fill** ボタンをクリック。最初から
   100 社を流してはいけません。
5. **Live Monitor パネルで進捗を観察:**
   - Phase A (分析) は 1 社あたり ~1 分 (並列)。
   - Phase A.5 (メッセージ生成) は ~30 秒。
   - Phase B (フォーム入力) は 1 社あたり ~5 分 (逐次)。
6. 各社が完了したら **Awaiting** タブで **レビュー**。下記が表示されます:
   - スクリーンショット `screenshots/ss-{No}-input.png` (入力済みフォーム)。
   - フォーム本文に実際にタイプされた `sentMessage`。
   - 最終フォームタブの URL。
7. **判断:**
   - 「OK」 → **Mark Sent** をクリック (メッセージはすでにフォームに
     入っているので、サイト上で送信ボタンを押すか、CAPTCHA を解いて
     送信してください)。
   - 「ダメ」 → 理由を添えて **Skip**。

これで全ループの確認は完了です。信頼できると感じたら 10〜20 社の
バッチに拡大してください。

> **重要:** Sales Claw は自動送信しません。「送信」の判断は必ず
> スクリーンショットを目視確認した上で、ウェブサイト上で人間が行います。

困ったら [TROUBLESHOOTING.md](../../TROUBLESHOOTING.md) /
[FAQ.md](../../FAQ.md) / [SUPPORT.md](../../SUPPORT.md) を参照してください。

---

## 6. バイリンガル設定 (v2.0.37+)

v2.0.37 以降、UI 全体およびメッセージ生成パイプラインがバイリンガル
対応しました。

### 6.1 UI を英語に切り替え

- ダッシュボードヘッダー右上の **🌐 EN** ボタンをクリック。
- ページがリロードされ、Settings / Awaiting / Sent / List Builder / Stats /
  オンボーディングウィザードがすべて英語に切り替わります。
- 選択は `localStorage` および `settings.preferences.locale` に
  永続化されます。

日本語に戻すには **🌐 JA** をクリック。

### 6.2 英語企業に英語メッセージを送る

**Settings → Message Templates → language**:

| 値 | 動作 |
|----|----|
| `auto` (デフォルト) | 企業サイトの主要言語を Sales Claw が自動検出し、それに合わせます (日本語サイト → 日本語メッセージ; 英語サイト → 英語メッセージ) |
| `en` | サイト言語に関わらず英語強制 |
| `ja` | サイト言語に関わらず日本語強制 |

メッセージテンプレートは両言語で揃っています。Strengths /
`approachObjective` / `approachGuardrails` は初回利用時に自動翻訳されます。

### 6.3 国・地域別コンプライアンス

**Settings → Company Profile → country**:

| 値 | 適用されるコンプライアンス |
|----|----|
| `ja-jp` | 特定電子メール法 — 送信者氏名・送信者会社名・連絡先メール・配信停止案内 |
| `en-us` | CAN-SPAM Act — 郵便住所必須、有効な配信停止リンク自動付与 |
| `en-eu` | GDPR / ePrivacy — 法的根拠の明示、「同意撤回」オプション |
| `other` | 自動フッターなし。コンプライアンスは利用者が個別管理 |

`preferences.complianceFooter` が `true` の場合のみ (デフォルト)
コンプライアンスフッターが追加されます。コンプライアンススキャナは
フッター追加前と追加後の両方で実行され、警告は Awaiting タブに黄色の
チップとして表示されます。

> コンプライアンススキャナはあくまでベストエフォートの安全装置であり、
> 法務レビューの **代替ではありません**。詳細は [README.md](README.md) の
> 免責事項を参照してください。

困ったら [TROUBLESHOOTING.md](../../TROUBLESHOOTING.md) /
[FAQ.md](../../FAQ.md) / [SUPPORT.md](../../SUPPORT.md) を参照してください。

---

## 7. 自動アップデート

インストール済みの Sales Claw は自動でアップデートをチェックします:

- **起動 5 秒後** — 初回チェック。
- **以降 6 時間ごと** — 定期チェック。
- **手動** — ヘッダーの **Update** ボタン (パッケージ済み Electron のみ。
  開発プレビューは `app.isPackaged === false` のため無効化されます)。

新バージョンが見つかると:

1. Sales Claw がバックグラウンドで静かにダウンロード。
2. ダッシュボード上部にトースト表示: 「アップデート可能です。
   再起動してインストール」。
3. **Restart to update** をクリック。Sales Claw がいったん閉じて
   バイナリを差し替え、新バージョンで再起動します。

アップデートチャネルは **GitHub Releases** (`latest.yml` + OS 別成果物)
です。中央配信サーバーは存在しません — `github.com` にアクセスできれば
アップデートできます。

アップデート経路を自分で監査する場合:

```bash
npm run verify:github   # latest.yml がネットワーク的に到達可能かを確認
```

困ったら [TROUBLESHOOTING.md](../../TROUBLESHOOTING.md) /
[FAQ.md](../../FAQ.md) / [SUPPORT.md](../../SUPPORT.md) を参照してください。

---

## 8. 旧バージョンからの移行

### v1.2.x (旧 CJS 版 `sales-claw`) → v2.0.x (本リポジトリ `sales-claw-ts`)

両プロダクトは **アプリデータの namespace が別** です:

- v1.2.x: `%APPDATA%\sales-claw\`
- v2.0.x: `%APPDATA%\sales-claw-ts\`

このため **自動データ移行は行われません**。v2.0.x は新規セットアップ
として扱ってください:

1. [2. インストール](#2-インストール) の手順で v2.0.x をインストール。
2. オンボーディングウィザードを再実施。
3. (任意) 旧ターゲットリスト (`.xlsx` / `.csv`) を新 List Builder に
   コピー。
4. (任意) v1.2.x の `data/settings.json` を v2.0.x の Settings タブと
   並べて見ながら、独自の strengths とメッセージテンプレートを手動で
   移植。
5. v2.0.x の動作を確認したら v1.2.x をアンインストール。

### v2.0.0〜v2.0.36 → v2.0.37

通常のポイントリリースです:

- 自動アップデートで完了します。プロンプトに従って
  **Restart to update** をクリックするだけ。
- 設定移行は不要。バイリンガル拡張は加算的なので、既存の
  `settings.json` はそのまま有効です。

困ったら [TROUBLESHOOTING.md](../../TROUBLESHOOTING.md) /
[FAQ.md](../../FAQ.md) / [SUPPORT.md](../../SUPPORT.md) を参照してください。

---

## 9. アンインストール

### Windows

1. **設定 → アプリ → インストールされているアプリ** → 「Sales Claw」を
   検索 → **アンインストール** をクリック。
2. アプリのバイナリは `%LOCALAPPDATA%\Programs\Sales Claw\` から
   削除されます。
3. **データは保持されます** (`%APPDATA%\sales-claw-ts\`)。完全に
   消去するには:

```powershell
Remove-Item -Recurse -Force "$env:APPDATA\sales-claw-ts"
```

### macOS

1. `/Applications` 内の **Sales Claw.app** をゴミ箱にドラッグ。
2. データを完全消去するには:

```bash
rm -rf ~/Library/Application\ Support/sales-claw-ts
rm -rf ~/Library/Caches/sales-claw-ts
rm -rf ~/Library/Logs/sales-claw-ts
```

### Linux

1. AppImage ファイルを削除。
2. データを完全消去するには:

```bash
rm -rf ~/.config/sales-claw-ts
rm -rf ~/.cache/sales-claw-ts
```

### ソースビルド版

```bash
# クローン先ディレクトリ内で
git clean -fdx        # ビルド出力・node_modules を削除
cd ..
rm -rf sales-claw-ts  # リポジトリ自体を削除
```

CLI プロバイダ (Claude / Codex / Gemini) と MCP 登録は、Sales Claw とは
独立しているため **そのまま残ります**。必要なら個別に削除してください:

```bash
npm uninstall -g @anthropic-ai/claude-code
npm uninstall -g @openai/codex
npm uninstall -g @google/gemini-cli
```

困ったら [TROUBLESHOOTING.md](../../TROUBLESHOOTING.md) /
[FAQ.md](../../FAQ.md) / [SUPPORT.md](../../SUPPORT.md) を参照してください。

---

**セットアップ完了です。** 最初のバッチを送信する準備ができました。
日々の運用では **Awaiting** タブが拠点になります — それ以外は一度
設定したら忘れて構いません。

# FAQ — Sales Claw

> English version: [FAQ.md](../../FAQ.md)

Sales Claw に関するよくある質問。具体的なバグ・症状については
[トラブルシューティング](./TROUBLESHOOTING.md) を、プロジェクト全体の説明
は [README](./README.md) を参照してください。

## 目次

- [全般](#全般)
- [セットアップ](#セットアップ)
- [使い方](#使い方)
- [コンプライアンス・法務](#コンプライアンス法務)
- [bilingual 対応](#bilingual-対応)
- [トラブルシューティング](#トラブルシューティング)

---

## 全般

### Sales Claw とは何ですか?

Sales Claw は **Web 問い合わせフォームを通じた B2B アウトリーチを自動化**
するデスクトップツールです。Claude / Codex / Gemini CLI が各ターゲット企業
の Web サイトを分析し、パーソナライズされたメッセージを起草し、企業の問い
合わせフォームに入力します。最終的な送信判断は、ローカルの Electron
ダッシュボードを介して人間が行う human-in-the-loop 設計です。

ツールは日本市場フォーカス (日本語フォーム / 日本の法令) ですが、UI と
prompt は bilingual で、英語ロケールパックも一級サポートです
([v2.0.35 以降](../../CHANGELOG.md#2035---2026-05-16--i18n-フル対応-完遂-phase-2-5-全完了))。

### SaaS ですか? ローカルアプリですか?

**ローカルデスクトップアプリ** です。Sales Claw は完全にユーザーの PC 上で
動作します。プロジェクト運営者はユーザーのデータを一切受信・保存・閲覧
しません。詳細なデータ取扱いは [PRIVACY.md](../../PRIVACY.md) を参照。

外部に出るのは以下のみ:

- ユーザーが選んだ LLM プロバイダ (Anthropic / OpenAI / Google) — 分析と
  メッセージ生成
- ターゲット企業の Web サイト (分析とフォーム送信)
- GitHub Releases (自動更新チェック)
- 任意: SerpApi / 国税庁法人番号 API / gBizINFO / EDINET (API キーを設定
  した場合のみ)

### 無料ですか? 有料ですか?

Sales Claw 自体は **MIT ライセンスの OSS — 無料** です。

AI を動かすには以下のいずれかが必要です:

| オプション | コスト |
|---|---|
| Claude.ai サブスクリプション (Pro / Team / Enterprise) | サブスクリプション料 |
| Anthropic API キー | 従量課金 |
| OpenAI Codex (ChatGPT Pro または API キー) | サブスクリプション / 従量 |
| Google Gemini (サブスクまたは API キー) | サブスクリプション / 従量 |

ダッシュボード左下の **AI コスト見積** chip で日次・月次の利用額が表示
されるので、突然の高額請求を防げます。

### サポート OS は?

Electron 3 プラットフォーム全部:

| OS | ファイル |
|---|---|
| Windows | `Sales-Claw-Setup-x.x.x.exe` |
| macOS (Apple Silicon) | `Sales-Claw-x.x.x-arm64.dmg` |
| macOS (Intel) | `Sales-Claw-x.x.x-x64.dmg` |
| Linux | `Sales-Claw-x.x.x-x64.AppImage` |

[GitHub Releases](https://github.com/joseikininsight-hue/sales-claw-ts/releases)
からダウンロードできます。

### インストーラはコード署名されていますか?

**まだです。** Windows EV 証明書 (年 $200-500 + 法人格が必要) のため、
プロジェクトは未取得です。初回起動時に SmartScreen 警告が出るので、
**詳細情報 → 実行** をクリックしてください。詳細は
[ROADMAP.md](../../ROADMAP.md#known-limitations) を参照。

念のため GitHub Releases ページに公開されている SHA-256 ハッシュと
インストーラのハッシュを照合できます。

### 設定 / データはどこに保存されますか?

| OS | パス |
|---|---|
| Windows | `%APPDATA%\sales-claw\runtime\data\` |
| macOS | `~/Library/Application Support/sales-claw/runtime/data/` |
| Linux | `~/.config/sales-claw/runtime/data/` |

`settings.json` が設定の単一情報源です。`action-log.json` /
`contact-history.json` / スクリーンショットなども同じディレクトリに
保存されます。完全なレイアウトは [PRIVACY.md](../../PRIVACY.md) を参照。

---

## セットアップ

### Claude Code CLI が必要ですか?

**はい — Claude Code CLI / Codex CLI / Gemini CLI のいずれかは必須** です。
これらが実際にフォーム解析・メッセージ生成・フォーム入力を駆動するエンジン
です。Sales Claw はその周りのオーケストレータ + ダッシュボードとして
動作します。

デフォルトで最もよくテストされているプロバイダは Claude Code CLI です。

### API キーは必要ですか?

AI プロバイダ次第:

| プロバイダ認証 | API キー必要? |
|---|---|
| Claude.ai サブスクリプション (Pro / Team / Enterprise) | **不要** — OAuth ログインで OK |
| Anthropic API キー | **必要** — `ANTHROPIC_API_KEY` |
| Codex via ChatGPT サブスクリプション | **不要** — OAuth |
| Codex via OpenAI API キー | **必要** — `OPENAI_API_KEY` |
| Gemini via サブスク | **不要** — OAuth |
| Gemini via API キー | **必要** — `GEMINI_API_KEY` |

Claude.ai サブスクリプションのみ使う場合は API キー不要、Anthropic から
従量課金されることもありません。

### MCP Playwright は何のためですか?

**MCP Playwright** は Claude CLI が Model Context Protocol 経由で実ブラウザ
を制御するためのブリッジです。Sales Claw のフォーム入力は **MCP Playwright
専用** で、エージェントは `browser_*` ツールを使って各問い合わせフォームの
ナビゲーション / スナップショット / 入力 / スクリーンショットを実行します。

初回 AI 起動時に自動登録されます。手動登録したい場合:

```bash
claude mcp add --scope user playwright \
  -- npx --yes @playwright/mcp@latest
```

詳細は
[トラブルシューティング 1.3](./TROUBLESHOOTING.md#13-claude-mcp-list-が空--mcp-playwright-が未登録)
を参照。

### 初回セットアップはどうやりますか?

初回起動時 (`settings.json` が無い・サンプル状態の場合) は **5 ステップの
オンボーディングウィザード** に自動リダイレクトされます:

1. ようこそ + 利用規約同意
2. 自社プロフィール (`companyProfile`)
3. 自社の強み (`valuePropositions.strengths`)
4. ターゲットリストアップロード (Excel / CSV — スキップ可)
5. AI 連携 (Claude / Codex / Gemini ログイン確認)

手動で再開:

```
http://127.0.0.1:3765/onboarding           # 進捗から再開
http://127.0.0.1:3765/onboarding?fresh=1   # ステップ 1 から再スタート
```

---

## 使い方

### 並列処理はどう動作しますか?

設定で **`preferences.parallelTabs`** (1-3, default 1) を変更してください。
フォーム入力フェーズ (Phase B) で複数会社のナビゲーション / submit I/O
を 1 つのブラウザ内で cooperative tab pipeline でオーバーラップします。

ダミーフォームサーバでの実測スピードアップ (v2.0.28):

| 社数 | 直列 (tabs=1) | 並列 (tabs=3) | スピードアップ |
|---|---|---|---|
| 2 社 | 7,371 ms | 3,867 ms | 1.91× |
| 3 社 | 11,030 ms | 3,988 ms | 2.77× |

実本番では 1 社あたり **5-7 分** (分析 + メッセージ + フォーム入力 +
スクショ)。100 社を parallelTabs=2 で約 4.5-6 時間。**3 を超えないでください**
— エージェントがどのタブがどの会社か追えなくなります。

### Phase A と Phase B の違いは?

| Phase | 何をする | 並列? | ツール |
|---|---|---|---|
| **Phase A** | サイト分析 + メッセージ prompt 構築 | **並列** (haiku サブエージェント) | プレーン HTTP fetch のみ |
| **Phase A.5** | CLI が会社別にメッセージ本文をパーソナライズ | 1 CLI 内で並列 | LLM のみ |
| **Phase B** | フォーム探索 + 構造分析 + 入力 + スクショ | **直列** (tab pipeline 任意) | MCP Playwright |

Phase A はブラウザに触らないので速くて安価、Phase B は実ブラウザを MCP
Playwright で動かすので遅くて高価です。フェーズ分割により、長いバッチでも
ダッシュボードに有用な進捗 (「分析 50 / 100、フォーム入力 13 / 100」) を
表示できます。

### 確認待ちタブで何ができますか?

各 `awaiting_approval` 行には入力済みフォームのスクリーンショット +
action 履歴が表示されます。そこから:

- **送信済みにマーク** — 会社を `submitted` として記録
- **スキップ** — 理由付きで `skipped` 記録
- **編集して再送** — メッセージ本文を開いて編集、会社を再キュー投入。
  AI 出力の微調整に便利
- **フォームを開く** — エージェントが残しておいた MCP Playwright タブに
  再フォーカス (CAPTCHA 解き / 最終確認用)

ダッシュボードの送信ボタンが、メッセージが実際にユーザーのマシンを離れる
前の唯一の人間ゲートです。

### AI が間違ったメッセージを書いたら?

選択肢 2 つ:

1. **編集して再送** — 確認待ちタブで行を開き、メッセージ本文をインライン
   編集して再キュー投入。編集後の本文が新しい `sentMessage` になります
2. **スキップ + リトライ** — 会社を「再生成」理由で `skipped` にしてから
   企業一覧タブで再キュー投入。エージェントが分析からやり直します

他の会社で同じミスを防ぎたい場合は、**設定 → メッセージテンプレート →
アプローチ目的** および **アプローチガードレール** を見直してください
— これらは CLI prompt に自動注入されます。

### バッチがハングしたらキューはどうクリアしますか?

1. ヘッダーの AI ステータス chip にある **STOP** をクリック — アクティブ
   バッチを kill
2. STOP の隣の紫 **キュー / QUEUE** ボタンをクリック — `pending` +
   `activeBatch` をクリアして再投入できる状態に戻す

QUEUE ボタンは v2.0.24 で追加。誤操作防止の確認ダイアログ付き。

---

## コンプライアンス・法務

### CAN-SPAM / GDPR / 特定電子メール法 への準拠を保証しますか?

**いいえ。** Sales Claw はベストエフォートのセーフティレールを提供しますが、
法務レビューの代替にはなりません。[README.md](../../README.md) より:

> ユーザーは自分の管轄区域における anti-spam 法および unsolicited contact
> 規制への準拠について単独で責任を負います。

Sales Claw が提供するもの:

- **コンプライアンススキャナ** (`src/compliance.ts`) — 日本の特定電子メール法
  4 要件を検査し、欠落時に警告
- **4 ロケール Compliance Registry** (v2.0.35 Phase 4 以降):
  - `ja-jp` — 特定電子メール法 (sender / contact email / opt-out)
  - `en-us` — CAN-SPAM (sender / **postal address 必須** / opt-out /
    commercial purpose)
  - `en-eu` — GDPR Art.6/13 (lawful basis / data controller / opt-out +
    withdraw consent)
  - `other` — 最小要件
- メッセージが実際に送信される前の **常時 `awaiting_approval` 人間ゲート**
- スコープ外フォーム (営業 NG / 既存顧客専用 / 採用専用 / IR 専用 / 報道
  専用) を自動 skip する **「営業お断り」検出器**

これらは準拠を助けるツールであり、保証ではありません。**自己責任で利用
してください。**

### 個人情報の取扱いは?

個人情報は **ローカル保存のみ** で、プロジェクト運営者には送信されません。
詳細インベントリは [PRIVACY.md](../../PRIVACY.md) を参照。

外部サービス (LLM プロバイダ / ターゲット企業の Web サイト等) には、
ユーザーが明示的に送るもの (設定 / ターゲット企業名 / 分析中の Web コンテンツ
等) のみが送信されます。

デフォルトでは Sales Claw は **第三者サイトから個人メールアドレス・個人名
を抽出しません** —
[CLAUDE.md "Safe defaults"](../../CLAUDE.md#design-principles-spec-12--list-builder-discovery-phase-only)
参照。

### 承認なしでメッセージが送信されることはありますか?

デフォルトでは **ありません** — すべてのメッセージは `awaiting_approval`
人間ゲートを通過します。

`preferences.autoSendEligibleForms = true` を設定し、メッセージが全安全
チェック (compliance scan + sendability gate +
`validateSentMessageQuality`) を通過した場合のみ、ダッシュボードが自動的
に `sent` マークします。これは opt-in でデフォルト無効です。正確なゲート
は [CLAUDE.md](../../CLAUDE.md) を参照。

---

## bilingual 対応

### UI 言語はどう切り替えますか?

ダッシュボードヘッダー (右上、テーマトグルの隣) の **🌐 EN / 🌐 日本語**
トグルをクリック。ページが新言語で自動リロードされます。

現在の言語はボタンに **逆の言語** が表示されることで分かります
(日本語表示中は "EN"、英語表示中は "日本語")。

v2.0.33 で追加。フル UI カバレッジ (Settings / Awaiting / Sent /
List Builder / Stats 等) は v2.0.37 で完了。

### 英語モードに切り替えると日本語設定が壊れますか?

**いいえ。** すべての設定はそのまま有効です。言語トグルは UI 表示ラベル
だけに影響し、`settings.json` フィールドの意味や値を変えません。

デフォルト = `'ja'` で既存日本語ユーザーとの完全互換 (v2.0.36 で
`messageTemplates.language === 'ja'` ユーザーが従来の日本語優先動作を
維持する追加保険策あり)。

### 英語企業に英語メッセージを送るには?

**設定 → メッセージテンプレート** を開いて以下を設定:

| フィールド | 値 | 動作 |
|---|---|---|
| `language` | `'auto'` (デフォルト) | Sales Claw がターゲットサイトの言語を自動判定 (HTML lang 属性 → meta → CJK 比率 → デフォルト)。英語サイトは英語、日本語サイトは日本語 |
| `language` | `'ja'` | 常に日本語 (レガシー動作) |
| `language` | `'en'` | 常に英語 |

混在バッチ (一部 JA / 一部 EN) では `'auto'` モードが各社を独立に解決し、
バッチレベルの prompt rules には多数決を使います。各社の `targetLanguage`
は `payload` に保持されます。

### 新しい言語ロケールを追加するには?

完全な手順は [CONTRIBUTING.md](./CONTRIBUTING.md) を参照。概要:

1. `src/locale-pack/<locale>/` 配下に新ディレクトリ作成
2. `ja/` と `en/` と同じファイル群を実装 (form-finder-hints,
   sendability-exclusions, keyword-dict, cli-prompts, llm-prompts,
   message-templates, compliance-rules)
3. `src/locale-pack/index.ts` に登録
4. UI 文字列を `src/i18n.ts` に追加

PR 歓迎。

---

## トラブルシューティング

### 「AI が起動しない」場合はどこをチェック?

[トラブルシューティング カテゴリ 1](./TROUBLESHOOTING.md#カテゴリ-1--ai-起動cli-関連)
を参照。最も一般的な原因:

- v2.0.30 以前 (タイムアウトバグ) → v2.0.31+ にアップデート
- MCP Playwright が未登録 → `claude mcp add ...` で手動登録
- 「ログイン済」誤検知 → v2.0.29+ にアップデート

### 「対象が見つかりません」をどう直す?

[トラブルシューティング 2.1](./TROUBLESHOOTING.md#21-対象が見つかりませんが永久に出る)
を参照。Auto-recovery は v2.0.32 で追加されました。v2.0.32+ でも出る場合は
**設定 → ターゲットリスト** でファイルを再選択してください。

### 「Phase B が完了したのに error」のなぜ?

[トラブルシューティング 2.2](./TROUBLESHOOTING.md#22-phase-b-が完走したのに-error-になる)
を参照。v2.0.31 以前では 800 字 `site_analysis` ガードが完了済みの作業を
拒否していました。v2.0.32+ にアップデートしてください。

### バグ報告に添付するログはどこですか?

完全リストは
[トラブルシューティング — 診断情報の集め方](./TROUBLESHOOTING.md#診断情報の集め方)
を参照。**`settings.json::apiKeys.*` および
`provider-homes/<provider>/.claude/credentials.json` は必ず伏字** にしてから
共有してください。

### ダッシュボードのポートが変わるのですが

ダッシュボードサーバはまずポート **3765** を試し、使われていれば
**3766 → 3767 → ...** にフォールバックします。実際のポートは
`%APPDATA%\sales-claw\runtime\data\dashboard-runtime.json` に書き込まれ、
AI セッションには `$SALES_CLAW_DASHBOARD_URL` として公開されます。

ダッシュボードに対するスクリプトを書く場合は、`3765` をハードコードせず
`dashboard-runtime.json` からポートを読んでください。

---

## 関連ドキュメント

- [README.md](./README.md) — プロジェクト概要
- [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) — バグカタログと修正
- [CHANGELOG.md](../../CHANGELOG.md) — バージョン履歴
- [ROADMAP.md](../../ROADMAP.md) — 既知の制約 + 将来計画
- [PRIVACY.md](../../PRIVACY.md) — データ取扱い
- [SECURITY.md](../../SECURITY.md) — 脆弱性開示
- [CONTRIBUTING.md](./CONTRIBUTING.md) — コントリビュート方法
- [CLAUDE.md](./CLAUDE.md) — Claude Code エージェント向けプロジェクトルール
- [MIGRATION.md](../../MIGRATION.md) — CJS 版から v2.0.x への移行

ここに該当しない場合は
[GitHub Issues](https://github.com/joseikininsight-hue/sales-claw-ts/issues)
に報告してください。

# トラブルシューティング

> English version: [TROUBLESHOOTING.md](../../TROUBLESHOOTING.md)

実際のユーザーが Sales Claw 利用中に遭遇した症状と、その原因・解決手順を
カタログ化したドキュメントです。該当する症状が見つからない場合は
[GitHub Issues](https://github.com/joseikininsight-hue/sales-claw-ts/issues)
にログ抜粋を添えて報告してください。

## 目次

1. [AI 起動・CLI 関連](#カテゴリ-1--ai-起動--cli-関連)
2. [フォーム入力・Phase B 関連](#カテゴリ-2--フォーム入力--phase-b-関連)
3. [設定・ダッシュボード UI 関連](#カテゴリ-3--設定--ダッシュボード-ui-関連)
4. [アップデート・インストール関連](#カテゴリ-4--アップデート--インストール関連)
5. [エラー・パフォーマンス関連](#カテゴリ-5--エラー--パフォーマンス関連)
6. [診断情報の集め方](#診断情報の集め方)
7. [関連ドキュメント](#関連ドキュメント)

---

## カテゴリ 1 — AI 起動・CLI 関連

### 1.1 AI 起動が必ず約 75 秒でタイムアウトする

**症状**

ダッシュボードの **AI を起動** ボタンを押すと、約 75 秒スピナーが回り続けた
末にエラーまたは無音で初期状態に戻る。
`ai-runs/managed-claude-session.log` に以下のログが繰り返される:

```
managed_ai_launch_cancel_requested reason=timeout ageMs=74977
```

AI が永久に起動完了しない状態。

**原因**

**v2.0.30 以前** ではタイムアウト 3 値が不整合だった:

| レイヤ | ファイル | 旧値 |
|---|---|---|
| サーバ cancel | `ai-runtime-api.ts` `LAUNCH_TIMEOUT_MS` | 75 秒 |
| stale-lock | `dashboard-server.ts` `MANAGED_AI_LAUNCH_LOCK_STALE_MS` | 90 秒 |
| クライアント overlay | `cli-terminal.ts` `LAUNCH_REQUEST_TIMEOUT_MS` | 90 秒 |

MCP Playwright の登録だけで最大 90 秒
(list 20 + remove 20 + add 30 + verify 20) かかるため、サーバの 75 秒 cancel
が必ず先に走り、起動が必ず途中で殺される。

**解決策**

**v2.0.31 以降にアップデート**してください。
タイムアウトは client (130 秒) > server stale-lock (130 秒) >
server cancel (120 秒) > MCP setup max (90 秒) の順に整列され、レースが
発生しなくなりました。

```bash
# 現在のバージョン確認
sales-claw --version    # または ヘルプ → バージョン情報
```

すぐにアップデートできない場合は、MCP Playwright を手動で事前登録
(下記 1.3 参照) すると起動経路の再登録が走らないため回避できます。

---

### 1.2 起動成功直後なのに「Claude Code CLI が未ログインです」

**症状**

AI を起動して PTY が確かに立ち上がり (`/api/ai/status` が
`loggedIn: true` を返す)、しかしフォーム入力バッチを投入すると:

> Claude Code CLI が未ログインです

…と弾かれる。再起動しても同じ。

**原因**

**v2.0.28 以前** の `ensureClaudeAutomationReady` (Phase B 投入時の認証
チェック) が、PTY が走っている最中に `claude auth status --json` を別
spawn する設計になっていた。これが `credentials.json` のロック競合 /
`HOME` env 切替 / spawn タイミングと衝突して頻繁に false
「未ログイン」を返していた。

**解決策**

**v2.0.29 以降にアップデート**してください。
`src/dashboard-managed-provider-home.ts` の修正で「managed PTY が同じ
provider で既に走っている場合は『ログイン済』として扱う」よう短絡されました。

---

### 1.3 `claude mcp list` が空 / MCP Playwright が未登録

**症状**

AI 起動ログに `mcp_playwright_stale_entry` /
`mcp_playwright_registration_loop` が頻発し、別の端末で `claude mcp list`
を叩くと何も表示されない。Phase B のフォーム探索が `browser_*` ツールが
ない理由で無音失敗する。

**原因**

考えられる主因 2 つ:

1. ユーザーの `claude` CLI が、Sales Claw が `HOME` / `USERPROFILE` で
   注入した home ディレクトリと別の場所にインストールされている。Sales Claw が
   登録した MCP レジストリは Sales Claw 専用 home の中にあり、ユーザーの
   shell からは見えない。
2. インストール版 (`Sales Claw.exe`) と dev mode (`electron.exe`) を行き来
   すると stale-entry detector が混乱して remove + re-add ループに入る
   (v2.0.31 で修正済み)。

**解決策**

まず **v2.0.31 以降にアップデート**して stale-entry 判定を緩和します。

それでも自分の shell から `claude` を使いたい場合は、手動で MCP Playwright
を登録:

```bash
claude mcp add --scope user playwright \
  -- npx --yes @playwright/mcp@latest
```

確認:

```bash
claude mcp list
# 期待: playwright    ✓ Connected
```

`✗ Failed` の場合は `claude mcp remove playwright` してから再 add。
Node.js 新規インストール後は PATH 反映のため再起動が必要な場合あり。

---

### 1.4 Windows で `'\"...\\.bin\\claude.cmd\"' is not recognized`

**症状**

Windows で起動時に上記メッセージが出て即失敗 (cmd.exe quoting バグ)。

**原因**

Sales Claw < 1.2.27 (CJS 版) の cmd.exe quoting バグ。

**解決策**

アップデート。TypeScript 版 (≥ 2.0.0) は影響なし。

---

## カテゴリ 2 — フォーム入力・Phase B 関連

### 2.1 「対象が見つかりません」が永久に出る

**症状**

フォーム入力バッチを投入するとダッシュボードが即座に
**「対象が見つかりません」/ "Target list file not found"** を表示。
リスト再インポートしても変わらず、次のバッチでも同じエラー。

**原因**

`settings.targetList.filePath` が削除済み・移動済みの古いファイルを
指したままで、`readWorkbookBundle` が投入のたびに throw
(v2.0.31 で複数ユーザーから報告)。

**解決策**

**v2.0.32 で auto-recovery 実装済み**。起動時に workbook reader が
`imports/` の中で最新の `*-target-list.xlsx` を mtime 降順で探して
`settings.json` を自動更新します。

v2.0.32+ でもエラーが出る場合:

1. **設定 → ターゲットリスト** を開く
2. **ファイルを再選択** をクリックして有効な `.xlsx` / `.csv` を指定
3. または `%APPDATA%\sales-claw\runtime\data\imports\` (Windows) に
   ファイルを直接置いて Sales Claw を再起動

---

### 2.2 Phase B が完走したのに `error` になる

**症状**

Phase B を見ていると Claude が確実にフォームを開き、全項目入力し、
スクリーンショットも撮り、確認画面まで到達しているのに、ダッシュボード
には **`awaiting_approval` ではなく `error`** が記録される。
エラーメッセージに:

> site_analysis 不足 (739 字 / 必要 800 字)

…と出ている。

**原因**

`src/routes/simple-api.ts` の防御的ガードが
`siteTextLength < minSiteTextLength` (default 800) で action を拒否して
いた。公開コピーが少ないサイトで、せっかく完了した作業を全部 error 化
していた。

**解決策**

**v2.0.32 以降にアップデート**してください。`form_fill + confirm_reached`
両方ある = Claude が全フェーズ完了の証拠とみなし、サイトテキスト短文でも
`awaiting_approval` を通過させます。最終的な sentMessage 品質は別途
`validateSentMessageQuality` でチェック。

---

### 2.3 CAPTCHA で止まる

**症状**

フォーム入力ログに「CAPTCHA detected」と出て `awaiting_approval` で止まる。
それ以上自動進行しない。

**原因**

これは **設計通り** の動作です。Sales Claw は CAPTCHA (reCAPTCHA, hCaptcha,
Cloudflare Turnstile 等) を自動で解きません — 利用規約違反 / Bot 扱いの
リスクがあるためです。

**解決策**

これが human-in-the-loop の出番です:

1. ダッシュボードの **確認待ち / Awaiting Approval** タブを開く
2. 行をクリックしてスクリーンショットを表示
3. **フォームを開く** をクリックして、エージェントが残しておいた MCP
   Playwright タブにフォーカス
4. 表示されているブラウザで CAPTCHA を解いて送信、その後ダッシュボードで
   **送信済みにマーク** をクリック

Cloudflare 風のページゲートでフォームに到達できなかった場合は
(`awaiting_approval` ではなく) `error` として記録されるので、action log
の details を見て手動調査してください。

---

### 2.4 「営業お断り」サイトが自動 skip される

**症状**

ターゲット企業がダッシュボードに `skipped` と表示され、理由が
「営業目的のお問い合わせはご遠慮ください」のようになっている。

**原因**

これは **sendability gate** が設計通り動いている結果です。
明示的に対象外と書いてあるフォーム (営業 NG / 既存顧客専用 / 採用専用 /
IR 専用 / 報道専用) は、コンプライアンス維持のため自動 skip されます。

**解決策**

修正は不要です — これは仕様 (バグではない) です。
本当に既存の関係でアプローチが正当な場合は Sales Claw 外の経路
(メール / 電話 / LinkedIn) を使ってください。

検出パターンは
`src/locale-pack/{ja,en}/sendability-exclusions.ts` にあります。

---

## カテゴリ 3 — 設定・ダッシュボード UI 関連

### 3.1 「全選択して削除」が 1 回目で動かない

**症状**

「企業一覧」または「確認待ち」タブで全選択 → **選択を削除** をクリックしても
何も起きない。ブラウザコンソールに
`TypeError: bulkDeleteCompanies is undefined` のようなエラー。

**原因**

v2.0.35 のリグレッション: `bulkDeleteCompanies()` で `await fetch(...)` を
使っているのに `function` 宣言に `async` 修飾子が抜けていて、関数式全体が
パース失敗 → ブラウザが silently に関数をグローバルから削除していた。

**解決策**

**v2.0.36 以降にアップデート**してください。`async` 修飾子が復元され、
Playwright で `bulkDeleteCompanies.constructor.name === 'AsyncFunction'` が
verify されています。

---

### 3.2 「APIエンドポイントが見つかりません」誤メッセージ

**症状**

ダッシュボード起動時の「前回中断バッチを続きから」バナーで、
**[続きから] を 2 回連打** または **[続きから] と [破棄] を同時に押す** と:

> APIエンドポイントが見つかりません。Sales Claw のバージョンが古い可能性があります

…と表示される (実際は最新版を使っていても)。

**原因**

v2.0.29 以前では snapshot が既に空のときに `POST /api/recovery/resume` が
**404** を返していた。クライアントは「404 = endpoint 不在 = バージョン古い」
と一律変換するロジックだったため、ユーザーに誤誘導していた。

**解決策**

**v2.0.30 以降にアップデート**してください。サーバが空 snapshot で
**409 + `code: 'no_snapshot'`** を返すようになり、クライアントも
「対象が見つかりません (既に処理済 / 破棄済の可能性)」に表示変更されました。

---

### 3.3 言語切替が反映されない

**症状**

ヘッダーの 🌐 EN / 日本語 トグルをクリックすると、ボタン自体は変わるが
一部のラベルがリロードまで旧言語のまま。

**原因**

ヘッダートグルは `PUT /api/settings/preferences` を呼んでから自動リロード
を発火します。ブラウザ拡張やリクエスト中断でリロードが抑制されると、
ダッシュボードが半分翻訳された状態で残ります。

**解決策**

1. **Ctrl+R** (Windows / Linux) または **Cmd+R** (macOS) で強制リロード
2. 直らない場合は `data/settings.json::preferences.language` を直接確認。
   `'ja'` または `'en'` のはず。`'auto'` の場合は OS ロケールに追従

bilingual 対応は **v2.0.37** で Settings / Awaiting / Sent / List Builder /
Stats / Pagination / CLI Activity の全タブが完了しています。それ以前の
バージョンでは一部画面に日本語が残ります。

---

### 3.4 設定画面に効かないフィールドがある

**症状**

設定画面で `maxRetries`, `formFillTimeout`, `dateFormat`,
`listSourceMetadata`, `requireApprovalBeforeSend` を変更して保存しても
動作が変わらない。

**原因**

v2.0.24 の changelog で **未参照フィールド** として明記済みの 5 つです。
旧 Playwright worker 用の遺物、または他設定との重複
(`requireApprovalBeforeSend` は `autoSendEligibleForms` と意味が重複)。

**解決策**

これらは無視して問題ありません。次のメジャー版で削除 or 実装の判断が
行われます。詳細は [ROADMAP.md](../../ROADMAP.md) を参照。

---

## カテゴリ 4 — アップデート・インストール関連

### 4.1 「アップデートを確認」ボタンが disabled

**症状**

dev mode (`npm run dashboard:preview`) でヘッダーの **アップデートを確認**
ボタンが無効になっている。

**原因**

意図的な仕様です。dev mode では `app.isPackaged === false` のため、
electron-updater がリポジトリを上書きする危険があります。
パッケージ版 (GitHub Releases のインストーラ) のみが自動更新を受けます。

**解決策**

自動更新フローを試したい場合は、
[GitHub Releases](https://github.com/joseikininsight-hue/sales-claw-ts/releases)
からインストーラを入れて起動してください。`npm run dashboard:preview`
ではテストできません。

---

### 4.2 インストール版なのにアップデートが届かない

**症状**

インストール版 Sales Claw を使っていて、GitHub Releases ページには新版
があるのに、アプリ内の updater が落としてこない。

**原因**

インストール版は `latest.yml` を
`https://github.com/joseikininsight-hue/sales-claw-ts/releases/latest/`
から **起動 5 秒後** および **以後 6 時間ごと** にチェックします。
公開直後ならまだチェック窓が来てないだけかもしれません。

**解決策**

1. ダッシュボードヘッダーの **ヘルプ → アップデートを確認** をクリック
   (パッケージ版のみ有効、4.1 参照)
2. `latest.yml` の到達性を直接確認:
   ```bash
   curl -I https://github.com/joseikininsight-hue/sales-claw-ts/releases/latest/download/latest.yml
   # 期待: HTTP/2 200 または 302
   ```
3. ネットワークが GitHub Releases をブロックしている場合は
   [ROADMAP.md](../../ROADMAP.md#known-limitations) 参照 — プライベート
   ホスティング対応は未予定です

自動更新が失敗した場合でも、GitHub Releases から新インストーラを落として
既存インストールに上書き実行できます。設定は
`%APPDATA%\sales-claw\runtime\data\` に保存されているので再インストールで
失われません。

---

### 4.3 旧 CJS 版 (`bp-outreach`) から v2.0.x へ移行する

**症状**

旧 CJS 版を使っていて、TypeScript 版 v2.0.x stable line に移行したい。

**原因**

CJS 版 (`bp-outreach`, v1.2.x) と TypeScript 版 (`sales-claw-ts`, v2.0.x)
は技術的には別アプリで、別フォルダにインストールされます。

**解決策**

完全な手順は [MIGRATION.md](../../MIGRATION.md) を参照。要点:

1. 旧アプリを正常終了 (`File → Quit`)
2. `%APPDATA%\sales-claw\runtime\data\` をバックアップ
3. v2.0.x release を
   [GitHub Releases](https://github.com/joseikininsight-hue/sales-claw-ts/releases)
   からインストール
4. 新アプリを起動 — 同じ `data/` を引き継ぎ、必要に応じて
   `settings.json` を migrate します

---

### 4.4 Windows SmartScreen でインストーラがブロックされる

**症状**

`Sales-Claw-Setup-x.x.x.exe` を実行すると
**「WindowsによってPCが保護されました / Microsoft Defender SmartScreen が
認識されないアプリの起動を停止しました」** と出る。

**原因**

Sales Claw は **Windows EV 証明書でのコード署名がまだ未対応** です
(費用 $200-500/年 + 法人格が必要)。
[ROADMAP.md](../../ROADMAP.md#known-limitations) で追跡されている既知の
制約です。

**解決策**

1. **詳細情報** をクリック
2. **実行** をクリック

念のため GitHub Releases ページに公開されている SHA-256 とインストーラの
ハッシュを照合できます。

---

## カテゴリ 5 — エラー・パフォーマンス関連

### 5.1 Phase B が 7-20 分で auto-error する

**症状**

Claude が処理中だった会社が突然 `error` に変わり、次のバッチが始まる
(エラー詳細は乏しい)。

**原因**

**stall watchdog** が発火しました。その会社の action ログが閾値より長く
更新されていなかったためです:

| 状態 | 閾値 |
|---|---|
| ログあり、最終更新が古い | `stallMs` (default 20 分) |
| ログ皆無 (CLI が初動でハング) | `emptyActionStallMs` (default `stallMs / 3` ≈ 7 分) |

通常は Claude PTY のハング、または MCP Playwright がナビゲーション完了
しないページでスタックしたケースです。

**解決策**

1. **CLI Activity / ログ** タブで該当の会社番号を探す
2. 最後に記録された action を見る — エージェントが詰まったフォーム URL が
   分かることが多い
3. もっと待ちたい場合は `data/settings.json` の `preferences.stallMs` を
   引き上げる (注: 閾値を伸ばすと CLI が本当にクラッシュした時にキューが
   長く塞がる)
4. 手動リトライは「企業一覧」タブで該当社を選んで **キュー再投入**

stall watchdog 自体は v2.0.23 で「ログ皆無」ケースも捕捉するよう強化
されています。

---

### 5.2 5 社並列が遅く感じる

**症状**

5 社並列なら直列の 5 倍速くなると思ったが、実測 ~1.5-2.5 倍しか
出ない。

**原因**

これは想定通りです。MCP Playwright は **1 ブラウザインスタンスのみ** という
設計のため、オーバーラップできるのは **ナビゲーション / submit の I/O 待ち**
だけ (cooperative tab pipeline)。Claude エージェント自体の thinking は
直列のままです。

ダミーフォームサーバでの実測値 (v2.0.28):

| 社数 | 直列 (tabs=1) | 並列 (tabs=2/3) | スピードアップ |
|---|---|---|---|
| 2 社 | 7,371 ms | 3,867 ms | **1.91×** |
| 3 社 | 11,030 ms | 3,988 ms | **2.77×** |

**解決策**

1. **設定 → 動作設定** で `preferences.parallelTabs` を `2` (推奨) または
   `3` (アグレッシブ) に変更、または env で
   `SALES_CLAW_PHASE_B_PARALLEL_TABS=2`
2. `3` を超えないこと — エージェントがどのタブがどの会社か追えなくなります
3. `data/ai-run-metrics.jsonl` を
   `node scripts/watch-phase-b-perf.cjs` でテーリングして実時間を観測

---

### 5.3 「site_analysis が 800 字未満」エラー

**症状**

上記 2.2 と同じ — 公開コピーが少ない会社で、レガシーガードが
`awaiting_approval` ログを拒否。

**解決策**

**v2.0.32+ にアップデート**してください。`form_fill` と `confirm_reached`
両方ログがあれば 800 字ガードはスキップされます。

---

### 5.4 100 / 200 社バッチが 7 社で止まる

**症状**

200 社投入して最初の ~7 社は正常処理、その後キューが永久ハング、
次の dispatch が走らない。

**原因**

v2.0.23 以前の 2 つのバグの組合せ:

1. stall watchdog が `action` フィールド空 (CLI が初動でクラッシュ) の
   会社を無視していた
2. 「AI 未ログイン」誤検知 (上記 1.2、v2.0.29 で修正) が後続バッチを弾いて
   いた

**解決策**

**v2.0.29 以降 (できれば最新の 2.0.x)** にアップデートしてください。両バグ
ともリグレッションテスト
(`tests/stop-clears-queue.test.cjs`, `tests/bulk-delete.test.cjs`) が
追加されています。

---

## 診断情報の集め方

バグ報告時は以下のファイルを添付してください:

| ファイル | パス | 何が分かるか |
|---|---|---|
| Action log | `%APPDATA%\sales-claw\runtime\data\action-log.json` | 会社別 action 履歴 (form_fill, awaiting_approval 等) |
| Diagnostics | `%APPDATA%\sales-claw\runtime\data\dashboard-diagnostics.jsonl` | サーバ側イベント (起動試行 / stall 検知 / recovery バナー) |
| Managed session | `%APPDATA%\sales-claw\runtime\data\ai-runs\managed-claude-session.log` | 直近 Claude セッションの PTY ログ |
| AI metrics | `%APPDATA%\sales-claw\runtime\data\ai-run-metrics.jsonl` | トークン数 / バッチ所要時間 / parallelTabs |
| Settings | `%APPDATA%\sales-claw\runtime\data\settings.json` (API キーは伏字に!) | 現在の設定 |
| Screenshots | `%APPDATA%\sales-claw\runtime\data\screenshots\ss-{No}-*.png` | フォーム入力エビデンス |

macOS / Linux では親パスがそれぞれ
`~/Library/Application Support/sales-claw/runtime/data/` /
`~/.config/sales-claw/runtime/data/` です。

**`settings.json::apiKeys.*` および
`provider-homes/<provider>/.claude/credentials.json` は必ず伏字にしてから
共有してください。**

---

## 関連ドキュメント

- [README.md](../../README.md) — プロジェクト概要・インストール・クイックスタート
- [CHANGELOG.md](../../CHANGELOG.md) — バージョン別の変更履歴 (全件)
- [ROADMAP.md](../../ROADMAP.md) — 既知の制約・今後の作業
- [PRIVACY.md](../../PRIVACY.md) — どのデータがどこに保存されるか
- [SECURITY.md](../../SECURITY.md) — 脆弱性開示ポリシー
- [CLAUDE.md](../../CLAUDE.md) — Claude Code エージェント向けプロジェクト内ルール
- [FAQ.md](../../FAQ.md) — Q&A ショートフォーム ([日本語版](./FAQ.md))
- [MIGRATION.md](../../MIGRATION.md) — CJS 版から v2.0.x への移行手順

ここに該当する症状がない場合は
[GitHub Issues](https://github.com/joseikininsight-hue/sales-claw-ts/issues)
に報告してください。

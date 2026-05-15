# Changelog

## 2.0.11 - 2026-05-15 — クライアント側 destructure ガード (hotfix)

v2.0.10 はサーバー側の `buildDashboardDataFromSources` で `Array.isArray()`
フォールバックを入れたが、**現在インストール済みのクライアントが古い
バージョン (≤ v2.0.9) のまま、新しいサーバーが配るデータを destructure
する**過渡期に `render(data)` の以下が直撃していた:

```js
const {companies, stats, recentLogs, liveMonitor} = data;
// data.companies が undefined → companies = undefined
// 直後の companies.filter(...) で TypeError
```

これがダッシュボードの「読込失敗: Cannot read properties of undefined
(reading 'length')」トーストの直接の原因。

### 修正
`src/ui/client-scripts/dashboard.ts` の destructuring を defensive に置換:
```js
const companies = Array.isArray(data && data.companies) ? data.companies : [];
const stats = (data && data.stats) || {};
const recentLogs = Array.isArray(data && data.recentLogs) ? data.recentLogs : [];
const liveMonitor = (data && data.liveMonitor) || {};
```

サーバ側 (v2.0.10) との二重防御。古い API を呼ぶ環境 (デモモード /
ダウングレード後の起動) でも UI が壊れない。

---

## 2.0.10 - 2026-05-15 — pending キュー誤判定・undefined.length・リスト管理改善

v2.0.9 直後にユーザーから 3 系統の同時報告:
1. 「以下の企業は既に処理中です: 第一生命情報システム, コベルコシステム, …」
   → 再キュー不可
2. 「Cannot read properties of undefined (reading 'length')」
3. 「リスト削除できない」

### 1. pending キューが永久滞留する問題

156 社の Phase A が完了し pending に enqueue されたが、Phase B が失敗
(v2.0.9 以前の MCP "already exists" バグ等) で 1 件も dispatch 完了して
おらず、`controller.pending` に会社番号が残り続けた。`POST /api/ai-form-fill`
の重複チェックは `getManagedAiReservedCompanyNos()` で activeBatch +
pending を見るので「処理中」と判定。PTY は死亡しているのに永久に解放
されないデッドロック状態。

**修正**:
- `ai-form-fill-api.ts`: PTY 死亡 + recovery タイマーなしの時に
  `setManagedAiBatchActive(null)` だけでなく **pending も一緒にドレイン**
  (`clearManagedAiBatchPending`)。
- 新規 API `POST /api/managed-ai-batch/reset`: 非常脱出弁。PTY 停止中なら
  activeBatch + pending を全部クリア → 診断イベント
  `managed_ai_batch_force_reset` を記録。
- 診断イベント `managed_ai_pending_drained` (清掃した件数を残す)。

### 2. Cannot read properties of undefined (reading 'length')

`/api/data` レスポンスの一部フィールド (`recentLogs` / `companies` /
`trendData.*`) が条件付きで undefined になりうる → client `dashboard.ts`
の SCRIPT 文字列内で `recentLogs.length` / `el.children.length` が
unguarded で投げていた。

**修正**:
- `buildDashboardDataFromSources()` で全フィールドを `Array.isArray()`
  チェックして必ず空配列にフォールバック (companies / recentLogs /
  trendData.{labels,actionNeeded,sent,error} / issues / stats / liveMonitor)。
- `dispatchNextManagedAiFormFillBatch()` と `queueAiFormFill()` で
  `controller.pending` を `Array.isArray()` 確認 → 不一致なら `[]` に再初期化。

### 3. リスト管理の正しい方針 — 会社単位ステータス API

「どの会社が今どの状態にいるか」を 1 つの窓口で見るために新規 API:

**`GET /api/companies/:no/status`** → action-log から組み立てて返す:
```json
{
  "ok": true,
  "companyNo": 70,
  "totalLogs": 7,
  "actionsByType": { "site_analysis": 1, "message_draft": 1, "form_fill": 1, "confirm_reached": 1, "submitted": 1 },
  "currentStatus": "submitted",
  "lastUpdated": "2026-05-15T00:00:00Z",
  "terminalReached": true,
  "terminalAction": "submitted",
  "terminalAt": "2026-05-15T00:00:00Z",
  "timeline": [ { "timestamp": "...", "action": "site_analysis", "detailsPreview": "..." }, ... ]
}
```
これでダッシュボード UI / CLI のどちらからも「この会社で何をしたか」を
時系列で取り出せる。

### 4. Export は既に 5 シート構成 (確認)

`GET /api/export` は v1.2.102 から:
1. **企業一覧** (companies)
2. **行動履歴** (action-log)
3. **連絡履歴** (contact-history)
4. **スクリーンショット** (screenshot ファイル一覧)
5. **集計** (summary)

import 時は **企業一覧シートのみ** 読み取り (action-log/contact-history は
ローカル DB 側に既に存在するので二重インポートしない設計)。

### ユーザー対応 (No.70 サイバネットシステム手動復旧の続き)

- ダッシュボードを再起動すれば「送信済み」タブに No.70 が表示される
- ssa の 4 社 (第一生命情報システム / コベルコシステム / 旭情報サービス /
  コムチュアネットワーク) は v2.0.10 への更新後、自動的に再キュー可能になる
  - もしすぐ動かしたい場合: `POST /api/managed-ai-batch/reset` で強制解放

---

## 2.0.9 - 2026-05-15 — ログ消失バグ修正 (ダッシュボード URL の env 注入)

v2.0.8 で Phase B 自体は走るようになった。しかし**実送信したのにダッシュ
ボードに submitted ログが残らない**事故が発生。原因はもっと根が深かった。

### 発覚事象 (ユーザー報告 2026-05-15 09:00)
- 「No.70 サイバネットシステム — STEP3 送信完了確認」と CLI が報告
- でもダッシュボードの「送信済み」タブに No.70 が無い
- CLI 出力:「ログAPI（ポート3765）は全社で接続拒否（Connection refused）」

### 原因
- ダッシュボード実ポート: **3456** (preferredPort で起動)
- CLI が curl で叩いていたのは **127.0.0.1:3765** (CLAUDE.md と prompt にハードコード)
- 結果、`/api/log-action` が全て connection refused → ログ消失
- 実送信は確かに完了 (`ss-70-sent.png` STEP3 画面で確証)
- スクショは `.cli-workspace/ss-70-input.png` `.cli-workspace/ss-70-sent.png`
  に保存されたが、ダッシュボードが見る `screenshots/` ディレクトリには存在せず、
  プレビュー画像も表示できなかった

### 修正

1. **`buildManagedProviderEnv` で `SALES_CLAW_DASHBOARD_URL` を必ず注入**
   (`src/dashboard-server.ts`):
   - `dashboardRuntime` または `server.address()` から実 URL を取得
   - managed PTY の env に `SALES_CLAW_DASHBOARD_URL=http://127.0.0.1:<実ポート>`
   - 既存の `SALES_CLAW_SESSION` と同じ仕組みで provider 横断 (claude/codex/gemini)

2. **prompt 内の curl 例を env ベースに**
   (`buildClaudeFormFillPrompt` の messageLines):
   - 旧: `http://127.0.0.1:3765/api/log-action`
   - 新: `"${SALES_CLAW_DASHBOARD_URL:-http://127.0.0.1:3765}/api/log-action"`
   - fallback の 3765 は env 未設定時のみ使われる
   - 注意書きを追記: 「ハードコードの 3765 は使わない、env が必ず注入される」

3. **CLAUDE.md の例を全部 env 化**:
   - log-action curl 全パターン (awaiting_approval / submitted / skipped / error)
   - 「ダッシュボード URL」表記を `$SALES_CLAW_DASHBOARD_URL` に変更
   - 過去事故の説明を残して再発防止 (なぜハードコードしてはいけないかを言語化)

4. **スクショ自動回収** (`src/approval-artifacts.ts::getScreenshotSearchDirs`):
   - 検索パスに `.cli-workspace/` と `.cli-workspace/screenshots/` を追加
   - CLI が cwd 直下に保存した `ss-{No}-{input,sent,confirm}.png` を
     ダッシュボードが自動的に見つけられるようになる
   - 既存の `screenshots/` 配下も従来通り検索

### ユーザー影響

- v2.0.9 で起動した CLI セッションは、ダッシュボードがどのポートで動いていても
  自動的に正しい URL に curl する。ログ消失は再発しない。
- 過去に CLI が `.cli-workspace/` に残したスクショも、再起動後はダッシュボード
  から閲覧可能になる (ファイルを動かさなくてもよい)。
- **既に発生した No.70 サイバネットシステムは手動で submitted 復旧済み**
  (action-log.json に form_fill / confirm_reached / submitted を直接挿入、
  スクショを `screenshots/` にコピー、contact-history.json に記録)。

---

## 2.0.8 - 2026-05-15 — Phase B 停止バグ二度と起こさないための恒久対策

v2.0.7 で「already exists」エラーは握り潰すようにした。本リリースはその一点修正
だけでは塞ぎきれない、**周辺の単一障害点を全部潰す**ためのハードニング。

### 1. MCP 冪等性ヘルパー切り出し (`src/mcp-idempotency.ts`)

v2.0.7 はインラインの regex で `already\s+exists|duplicate|...` を判定していた。
これを `isAlreadyExistsError()` / `isNotFoundError()` の独立モジュールに昇格。
Claude / Codex / Gemini 共通で使え、ユニットテストで全パターンを保証する
(`tests/mcp-idempotency.test.cjs`)。今後 add/remove 以外の冪等操作にも横展開できる。

### 2. Managed AI session 自動起動の retry + back-off (`src/retry-helper.ts`)

Phase B が始まる直前の `startManagedAiSession()` が 1 回失敗しただけで「409 +
ダッシュボードで再操作してください」を返していた。CLI の認証ハンドシェイク
タイムアウト・spawn race など、もう 1 回試せば通る一過性失敗が多い。

汎用 `withRetry()` を追加し、Phase B autostart を **3 回 / exp back-off (800ms →
1600ms → 3200ms + jitter)** で再試行。`CLI_NOT_INSTALLED` / `CLI_TOO_OLD` /
`LAUNCH_CANCELLED` のような retry しても無駄なエラーは `shouldRetry` で弾く。
試行ごとに `managed_ai_form_fill_autostart_retry` diagnostic event + CLI ログを
出すので、何が起きているか UI から見える。

### 3. dispatch 失敗時の rollback (`dispatchNextManagedAiFormFillBatch`)

v2.0.7 のバグは「`activeBatch` がセット済み・PTY 死亡で `queueClaudeForm...`
が throw → `activeBatch` が中途半端な状態で残る → poller は active 扱いで
何もしない」が根本原因。dispatch 内を try/catch で囲み、throw 時は:
- batch を `controller.pending.unshift()` で先頭に戻す (元順序を維持)
- `activeBatch = null` に戻す
- `tryRecoverManagedAiSession('dispatch-failed')` で managed AI 復旧キック
- `managed_ai_batch_dispatch_failed` 診断イベント

これで「PTY が一瞬死んだだけで永久滞留」が物理的に発生しなくなる。

### 4. キュー stuck watchdog (`startManagedAiBatchPoller`)

「pending あり / activeBatch なし」が **5 分** 以上続いたら stuck と判定:
- `managed_ai_queue_stuck` 診断イベント
- CLI 自動化ログにオレンジ警告 (UI から見える)
- `tryRecoverManagedAiSession('queue-stuck')` で復旧キック
- claudePty が生き返っていれば自動 dispatch をリトライ

`MANAGED_AI_QUEUE_STUCK_MS = 5 * 60 * 1000` で閾値を一元管理。

### 5. UI 投入前の health check (`GET /api/phase-b-health`)

バッチ投入前に UI から呼べる軽量 probe (auth 画面を出さない):
```json
{
  "ok": true,
  "healthy": true,
  "provider": "claude",
  "managedSessionAlive": true,
  "pendingBatchCount": 0,
  "activeBatch": null,
  "queueStuck": false,
  "warnings": []
}
```
`healthy: false` のとき warnings に「再起動してください」「stall watchdog 発火中」等の
人間向けメッセージが入る。次回 UI 改善で「実行」ボタン押下前にこれを呼ぶ。

### 6. ユニットテスト追加 (regression 防止)

- `tests/mcp-idempotency.test.cjs` — claude / codex / gemini の実エラー文言
  すべてに対する判定、未関連エラーで false 判定、空文字・null・undefined 安全性
- `tests/retry-helper.test.cjs` — 1 発成功 / N 回目成功 / 全失敗 / shouldRetry / onAttempt

`npm run test:unit` に組み込み済み。

### 7. 診断ログ拡充

新規 diagnostic event:
- `mcp_playwright_already_exists_accepted` (v2.0.7 から、再掲)
- `managed_ai_form_fill_autostart_retry` (試行回数 + error)
- `managed_ai_form_fill_autostart_failed` (3 回失敗時の最終)
- `managed_ai_batch_dispatch_failed` (PTY 死亡時の throw)
- `managed_ai_queue_stuck` (5 分以上滞留)

これで `dashboard-diagnostics.jsonl` から Phase B 状態遷移が完全に追跡可能になる。

---

## 2.0.7 - 2026-05-15 — Phase B 停止バグ修正 (MCP Playwright 「already exists」)

**150 社まとめて投入したら Phase A (分析) は完了するが Phase B (フォーム入力) が永久に動かない致命バグの修正。**

### 症状 (ユーザー報告)
- 企業リストに 150 社追加
- ダッシュボードで実行 → 「企業分析」「メッセージ作成」だけ延々と続く
- フォーム入力が一向に始まらない

### 診断ログ (`%APPDATA%\sales-claw-ts\runtime\data\dashboard-diagnostics.jsonl`)
```
22:54:12 managed_ai_form_fill_autostart
22:55:11 ai_form_fill_not_ready
         error: "Claude で MCP Playwright の設定に失敗しました。
                 MCP server playwright already exists in user config"
22:55:39 phase_a_batch_started (153 社)
23:02:08 phase_a_batch_completed (139 社成功, 47 バッチ enqueue)
23:02:08 managed_ai_batch_dispatch (最初のバッチ)
23:02:08 ai_form_fill_internal_error: "Managed AI session is not running."
       ← 以降ログ更新停止、47 バッチがキューに滞留
```

### 根本原因 (`src/dashboard-server.ts::ensureProviderPlaywrightMcp`)

ユーザーが過去に手動で `claude mcp add playwright ...` を user scope に登録済みだった場合:
1. Sales Claw は `mcp list` で playwright を検出
2. 「実行パスが期待値と違う」と判定 (`registeredButValid = false`)
3. **remove → re-add** を試みる
4. 旧コードの remove は scope を指定していなかったため user scope の登録が消えず残存
5. add が `"MCP server playwright already exists in user config"` で失敗
6. `ensureProviderPlaywrightMcp` が `ok: false` を返す
7. Phase B の autostart が「Playwright MCP 未準備」と判定して中止
8. **Phase B は永久に走らず、47 バッチがキューで滞留**

### 修正 (`src/dashboard-server.ts`)

1. **`removeArgs` に scope 明示** (claude のみ):
   - 旧: `['mcp', 'remove', 'playwright']`
   - 新: `['mcp', 'remove', '--scope', 'user', 'playwright']`
2. **add が "already exists" を返したら success として扱う** (idempotent):
   - stderr が `already\s+exists` / `duplicate` / `MCP server X already` にマッチ
   - その場合 `mcp list` で playwright の実在を再確認 → ok:true で返す
   - 診断イベント `mcp_playwright_already_exists_accepted` を記録 (後追い用)

これで:
- 既存登録が valid → そのまま使う (従来通り)
- 既存登録が stale → remove (scope 指定で確実) → 再 add
- 再 add が「already exists」と言ったら → 既存を活かして success にする (新規動作、Phase B が止まらない)

### ユーザーへの影響

- v2.0.7 が auto-update で配信されると次回起動から自動修正
- 起動後、stuck していた 47 バッチが「Recovery snapshot detected」として復活する場合あり (UI 上部のオレンジバナー「続きから / 破棄」で選択)
- 「破棄」を選んで再度「実行」を押せば、150 社が正しく流れる
- 1 バッチ (3社) あたり 5-10 分の form fill が走るため、150 社の完走には **5-8 時間程度**かかる想定

## 2.0.6 - 2026-05-14 — 個人情報・固有名の徹底匿名化 + メアド連絡先撤去

**git tracked 全ファイルの 1 ファイル単位レビューで残っていた固有名・個人連絡先を完全撤去。**

### 個人連絡先メアドの撤去

OSS 公開リポジトリから個人 Gmail (`abckeishi@gmail.com`) を完全撤去。
GitHub の Private Security Advisory に窓口を統一:

- **`SECURITY.md`**: 「Email (preferred)」を削除、Security Advisory のみに統一
- **`CODE_OF_CONDUCT.md`**: 違反報告窓口を Security Advisory (`[CoC]` プレフィックス) に変更
- **`PRIVACY.md`**: プライバシー問い合わせも Security Advisory (`[Privacy]` プレフィックス) に
- **`SUPPORT.md`**: CoC 違反窓口を Security Advisory に
- **`CHANGELOG.md`**: 過去エントリの自己参照的メアド言及を撤去

### 過去取引先・テスト企業の固有名 → 汎用例に置換

- **`src/settings-manager.ts`** DEFAULT_SETTINGS::valuePropositions.protected_groups コメント例:
  - 旧: `'SCSK', match_patterns: ['SCSK', 'ベリサーブ']`
  - 新: `'親会社A', match_patterns: ['親会社A', 'グループ会社X']`
- **`src/sendability-gate.ts`** コメント:
  - 旧: 「例: SCSK傘下のベリサーブ、日立グループの日立IIE など」
  - 新: 「例: 親会社グループ傘下の子会社 (Inc. / Subsidiary 等)」
- **`src/parallel-analysis.ts`** コメント:
  - 旧: 「anti-bot 対応 (sint/dentsu/hakuhodo/adk 等)」
  - 新: 「大手企業サイト (Akamai/Cloudflare で UA 検証あり) への anti-bot 対応」
- **`tests/sendability-gate.test.cjs`** テストデータ:
  - 旧: `'株式会社NTTデータNJK'` / `protectedGroups: [{name:'NTTデータ'}]`
  - 新: `'株式会社サンプル親会社サブ'` / `protectedGroups: [{name:'サンプル親会社'}]`
- **`CHANGELOG.md`** 過去 v1.2.111 エントリのテスト企業名 2 件を「テスト企業 A / B」に匿名化

### 検証
git ls-files で取得した tracked ファイルのみを対象に以下のパターンを再 grep:
- 本人氏名 / 漢字読み (中澤・圭志・Keishi・Nakazawa)
- 社名 (LYZON・lyzon・ライゾン)
- 私用メアド (nakazawa@・abckeishi)
- 私用電話 (070-1424)
- SNS handle (@keishi_nakazawa)

すべて **0 件** を確認。コミット作者 (`joseikininsight-hue`) は事業 handle で本名と紐づかないため維持。

## 2.0.5 - 2026-05-14 — Update banner stale state 修正 + dismiss ボタン

**「v2.0.X の準備完了 — 今すぐ再起動してインストール」が最新版でも消えない問題の修正。**

### 問題
ユーザーが v2.0.X へ自動更新後、起動した本人がもう v2.0.X を実行中なのに、
ダッシュボード上部の緑バナーが「v2.0.X の準備完了 — 今すぐ再起動してインストール」を
表示し続ける。`update-status.json` に古い `state: "downloaded"` が残っていたため。
さらに**閉じることができない**ため、画面領域を圧迫していた。

### 修正
3 段階のフェールセーフで対処:

1. **Electron 起動時の reconcile** (`electron-main.ts`):
   - 起動時 `update-status.json` を読み、`state` が `downloaded`/`downloading`/`available` で
     かつ `version === APP_VERSION` なら `state: "up-to-date"` に書き換える
   - 1 度の起動でファイルそのものが正しい状態になる

2. **API 側の自動補正** (`src/routes/simple-api.ts::/api/update-status`):
   - レスポンス組み立て時に同じ条件チェック
   - `update-status.json` を物理的に変更せず、レスポンスだけ補正
   - 二重防御 (1) と (2) で確実にバナーが消える

3. **UI 側のフォールバック + dismiss ボタン** (`src/ui/client-scripts/dashboard.ts`):
   - クライアント側でも `appVersion === version` を比較してバナー抑止
   - **`×` 閉じるボタン**追加: クリックで `window.__updateBannerDismissedAt = Date.now()` を記録、
     1 時間は banner を再表示しない (タイムラグや別経路で stale state が来ても再表示されない)

### 動作確認
- 起動: update-status.json 物理書き換え → API/UI ともに最新表示
- 同 version で API レスポンス: `state: "up-to-date"` + `autoCorrectedFrom: "downloaded-stale"`
- バナーの × クリック → 即時消滅 + 1 時間 suppress

## 2.0.4 - 2026-05-14 — CLI / Playwright 検出ロジック修正

**「AI CLI / Playwright の準備が必要です」誤表示の修正。**

### 問題
ユーザーがシステムグローバルに `npm install -g @anthropic-ai/claude-code` でインストール済みでも、
あるいは Playwright を `npx playwright install chromium` で既に持っていても、
ダッシュボードのトップに「AI CLI / Playwright の準備が必要です」バナーが表示され続けていた。
「AI CLI を準備」ボタンを押すと Claude を再インストールしようとしてしまう。

### 根本原因 (`src/local-toolchain.ts`)
- `getProviderExecutableCandidates()` が **Sales Claw 内蔵 toolchain (`<runtime>/tools/bin/`) のみ** を検索
- `findChromiumExecutable()` も **Sales Claw 内蔵 `<runtime>/tools/browsers/` のみ** を検索
- 結果: システムグローバル / npm-global / Playwright 標準パスにある実体を見落としていた

### 修正
- **`getProviderExecutableCandidates()`**: 3 段階の検索に拡張
  1. 既存: Sales Claw 内蔵 `<runtime>/tools/bin/`
  2. 追加: グローバル npm の標準パス (`%APPDATA%\npm` / `/usr/local/bin` / `~/.npm-global/bin` 等)
  3. 追加: `where` (Windows) / `which` (Unix) で PATH 解決 (nvm 等にも対応)
- **`findChromiumExecutable()`**: 検索ルートを多重化
  1. 既存: Sales Claw 内蔵 `<runtime>/tools/browsers/`
  2. 追加: `PLAYWRIGHT_BROWSERS_PATH` env var
  3. 追加: Playwright 標準パス
     - Windows: `%LOCALAPPDATA%\ms-playwright`
     - macOS: `~/Library/Caches/ms-playwright`
     - Linux: `~/.cache/ms-playwright`
- **`probeAiToolchainStatus()` の返り値**に `cli.bundled` / `browser.bundled` を追加
  - true = Sales Claw 内蔵 toolchain から検出、false = システムグローバル経由

### 動作確認
内蔵 toolchain を退避した状態でも、システムグローバルの `claude.cmd` と Playwright 標準パスの
Chromium を正しく検出 → `ok: true` で「準備が必要」バナーが表示されなくなることを実機検証済み。

```text
Without bundled toolchain:
  cli.installed:  true (bundled: false, path: %APPDATA%\npm\claude)
  browser.installed: true (bundled: false, path: %LOCALAPPDATA%\ms-playwright\chromium-1217\...)
  ok: true
```

## 2.0.3 - 2026-05-14 — 個人情報・内部資料の漏洩防止 (二重防御)

**ローカル開発ノート (gitignore 済) を installer に紛れさせない多層防御。**

### 背景
ローカル開発環境に `.gitignore` で除外された内部資料 (`docs/message-quality-improvement-requirements.md` と
`docs/blog-evaluation-2026-05-12-v2.md`) が存在していた。これらには開発者の連絡先や
過去事例の固有名詞が含まれており、git にも GitHub Releases にも一切含まれていなかったが、
将来 `.gitignore` の設定が変わるリスクや、ローカルでパッケージングする際の事故を防ぐため、
多層防御を追加。

### 変更
- ローカルの該当 2 ファイルを物理削除
- `electron-builder.yml::files` に **内部 .md と `docs/**` を明示除外** (二重防御):
  - `!docs/**`
  - `!AGENTS.md` `!CLAUDE.md` `!DESIGN.md` `!MIGRATION.md`
  - `!SUPPORT.md` `!ROADMAP.md` `!CODE_OF_CONDUCT.md` `!CONTRIBUTING.md` `!CHANGELOG.md`
- `CHANGELOG.md` の `/authors/keishi_nakazawa` を `/authors/[handle]` に汎用化 (LP 個別 handle の露出を防止)

### 検証
- 全 git tracked ファイルから個人情報パターン (本人氏名・社名・私用メアド・私用電話番号・個人 SNS ハンドル) を grep → **0 件**
- v2.0.0/2.0.1/2.0.2 リリースは元々個人情報を含まなかったことを `git log --all` で確認

## 2.0.2 - 2026-05-14 — Onboarding wizard 刷新

**初回セットアップウィザードの UI / UX / 内容を全面刷新。**

### Onboarding Wizard 完全リデザイン (`src/onboarding-wizard.ts`)

UI:
- **水平 stepper (円 + 接続線)** に変更 (旧: pill 型)、active=primary 色 / done=fill
- ようこそページを写真の通りに刷新: 👋 / ⚠️ / 📁 アイコン + 詳細リストレイアウト
- **AI 連携ステップに公式 SVG アイコン**を導入 (`assets/vendor/ai-icons/claude-code.svg` /
  `codex-openai.svg` / `gemini-cli.svg`) — ダッシュボード Launch Modal と同一アイコン
- カスタムカラーチップで provider 別に背景色 (Claude オレンジ系 / Codex 黒系 / Gemini 青系)
- 認証状態を 4 状態のカラードット付き badge で表示 (接続済 / 未ログイン / 未インストール / 確認中)
- 各 step に絵文字 + タイトルのヘッダ統一 (🏢 / 💪 / 📋 / 🤖)
- footer の cancel / 次へ ボタンを写真通り両端配置

利用規約 (TERMS_BULLETS):
- 5 項目 → **12 項目に拡張**、法的にガチガチな表現に強化
  - AI 生成文面の責任 (誤情報・名誉毀損・著作権侵害含む)
  - スパム / 大量連投 / なりすまし禁止
  - リスト取得経路の合法性
  - 送信先からの返信・クレーム対応はユーザー責任
  - 紛争処理: 日本法準拠 / 東京地方裁判所合意管轄
  - 「現状有姿 (AS IS)」明記
  等を追加

強み プリセット (PRESET_STRENGTHS):
- 8 → **18 項目に拡張**、SI/Web 偏重を解消し汎用化
- 4 セクションに分類して表示:
  - **IT / テクノロジー** (Web 開発 / クラウド / AI / データ分析 / モバイル / セキュリティ / CMS / UI&UX) — 8 種
  - **営業 / マーケティング** (デジマ / 営業代行 / PR / 市場調査) — 4 種
  - **コンサルティング / 専門** (経営コンサル / 人事 / 会計税務 / 法務) — 4 種
  - **BPO / 物流** (BPO / SCM) — 2 種

AI 連携機能の強化:
- 認証状態を **provider ごとに保存** (旧: state.aiAuthStatus 1 つだけ)
- provider 切替時に自動で auth check 実行
- インストール / ログイン状態に応じた次アクション説明文を動的表示
  - 未インストール → `npm install -g @anthropic-ai/claude-code` 等のコマンドを表示
  - 未ログイン → `/login` 手順を案内、Claude は claude.ai/login へリンク
  - 接続済 → ✓ OK 表示で完了可能と提示
- spinner 表示で「確認中」を可視化

### 検証
- 全 10 項目の UI チェック PASS (welcome / stepper / AI icons×3 / 12 terms / generic presets×2 / status dot / cancel)
- HTTP 200, 42KB の HTML 配信確認

## 2.0.1 - 2026-05-14 — 公開準備 Phase 2

**OSS 公開・配布のための深掘り監査と修正パス。**

### セキュリティ
- **依存脆弱性ゼロ達成**: `npm audit` で 5 件 (xlsx high×2 含む) → **0 件**
  - `xlsx` を SheetJS CDN の patched 版に切替 (Prototype Pollution + ReDoS 解消)
  - `npm` 依存を最新化 (picomatch high / ip-address moderate 等を解消)
  - `esbuild` を最新化 (dev-only 脆弱性解消)

### `package.json` メタデータ強化
- `engines.node: ">=20"` を追加 (実行環境の明示)
- `repository.url` を `git+https://github.com/joseikininsight-hue/sales-claw-ts.git` に設定
- `bugs.url` を Issue tracker に設定
- `homepage` を GitHub README に設定
- `author` を空文字 → `"Sales Claw contributors"` に修正

### 法的書類整備
- **`PRIVACY.md` 新規** (5KB): プライバシー・データ取扱の包括的説明
  - Sales Claw は完全ローカル動作 (運営側でデータ収集なし) を明示
  - 外部 API 利用時の各 provider プライバシーポリシーへの導線
  - ローカル保存データの場所一覧 (Win/macOS/Linux)
  - 日本法 (特定電子メール法・個人情報保護法) ガイダンス
  - GDPR / CAN-SPAM Act の参考言及
  - DISCLAIMER (AS IS 提供、ユーザー責任)

### LICENSE 更新
- 著作権年: `2025` → `2025-2026` (2026 年版に対応)

### ドキュメント整合性
- `docs/release-parity-and-autoupdate.md` の stale 参照を修正:
  - `joseikininsight-hue/sales-claw` → `joseikininsight-hue/sales-claw-ts`
  - `verify-release-readiness.cjs` → `.ts (via tsx)`
  - `dashboard-server.cjs` → `dashboard-server (now dist-ts/src/dashboard-server)`

### 公開可能性検査結果
- 実シークレット (API key / token) の漏洩: **0 件** (テスト用の placeholder のみ)
- 個人情報 / ハードコードパス: **0 件** (連絡窓口は GitHub Private Security Advisory に統一)
- TODO/FIXME/HACK/XXX 残骸: **0 件** (src/ 内)
- 依存ライセンス互換性: 全て MIT / Apache-2.0 / Artistic-2.0 (MIT 互換)
- ビルド検証: `verify:release` **41/41 checks**
- typecheck: 0 errors / lint: 0 errors

**TS化完成度を最大化 + OSS hygiene 整備の一括 PR。**

### OSS hygiene 整備
- **`SECURITY.md`** 新規: 脆弱性報告ポリシー (報告先・タイムライン・スコープ)
- **`CODE_OF_CONDUCT.md`** 新規: Contributor Covenant 2.1 採用
- **`.editorconfig`** 新規: エディタ間で改行・インデント・末尾改行を統一
- **`.gitattributes`** 新規: LF/CRLF・バイナリ判定・linguist 設定
- **`.github/ISSUE_TEMPLATE/bug_report.md`** + **`feature_request.md`** 新規
- **`.github/PULL_REQUEST_TEMPLATE.md`** 新規: PR チェックリスト

### ドキュメント更新
- **`README.md`**: 2.0.0 リリースバッジ + ステータス追記
- **`MIGRATION.md`**: TS化完了状況を一覧化 (src/ 100% TS など)
- **`CONTRIBUTING.md`**: 63行 → 215行に充実 (開発フロー / コーディング規約 / プロジェクト構造 / リリース手順)
- **`src/ai-runtime/pty-log.ts`**: 古い `@ts-nocheck` を示唆するコメント整理

### scripts/*.cjs を *.ts に変換 (18 ファイル)
- **`tsx`** を devDep 追加 (TypeScript ランタイム、chicken-egg なしで .ts 直接実行)
- `scripts/*.cjs` 17 件 + `scripts/lib/png-mock.cjs` 1 件 → `*.ts`
- `package.json::build` / `clean` / `dashboard:preview` / `dashboard:restart` /
  `verify:*` を `tsx scripts/xxx.ts` 経由に書き換え
- `.github/workflows/release.yml` の post-release verify も `npx tsx` に
- 内部 `require('./lib/png-mock.cjs')` / `require('./seed-demo-data.cjs')` →
  拡張子なしに更新 (tsx が .ts を自動解決)
- `scripts/restart-dashboard.ts` の dashboard-server プロセス grep を
  `dashboard-server\.(js|cjs)` に拡張 (新旧両対応)

### Stage 2: as any 段階削減 (83 件)
- `Record<string, any>` → `Record<string, unknown>` を 85件 → 60件 (−25)
- `: any[]` → `: unknown[]` を 99件 → 54件 (−45)
- `Promise<any>` → `Promise<unknown>` を 22件 → 9件 (−13)
- 型エラーが出るファイル (dashboard-server / approval-artifacts / form-session-manager
  / list-builder/extractor / local-toolchain / message-quality-gate /
  official-site-resolver / routes/simple-api / settings-excel など) は revert し、
  個別 PR で正しい narrow に置換予定

### Stage 3: tsconfig 厳格化 (3 オプション追加)
- `noFallthroughCasesInSwitch: true` — switch case fall-through バグ防止
- `noImplicitReturns: true` — 関数の return 漏れ検出
- `noImplicitOverride: true` — メソッド override 明示 強制
- `useUnknownInCatchVariables: true` は 164 errors のため見送り (次回 PR)

### Stage 4: dashboard-server.ts 分割 (proof-of-concept)
- **`src/dashboard-lock.ts`** 新規 (約 100 行): lock ファイル I/O を切り出し
  - `getDashboardLockFile` / `readDashboardLock` / `writeDashboardLock` /
    `removeDashboardLock` (新規 helper) / `isProcessAlive`
- `dashboard-server.ts` は 30 行削減、`require('./dashboard-lock')` で連携
- `claimStandaloneDashboardLock` 等の状態管理はサーバー状態に密結合のため
  dashboard-server.ts に残置 (proof-of-concept、残りは個別 PR で順次)

### Stage 4.5: ブラウザコード型化の土台
- **`tsconfig.browser.json`** 新規: `lib: ["DOM", "DOM.Iterable"]` + `isolatedModules` +
  `noEmit` で型チェック専用
- **`src/ui/client-scripts/browser/`** ディレクトリ + README 新規:
  ブラウザ TS の本格切り出し作業の置き場所、今後の段階作業を明文化

### 検証
- `npm run typecheck`: **0 errors**
- `npm run lint`: **0 errors** / 1059 warnings (前: 1129、Stage 2 で −70)
- `npm run test:unit`: 全件パス
- `npm run verify:release`: **41/41 checks**
- 実機 Electron 起動 → port 3456 で正常応答確認済み

## 2.0.0 - 2026-05-14 (First Stable Public Release)

**TypeScript 移植版の最初の安定リリース。autoUpdater が本番運用可能な状態。**

### リリース成果物
- Windows: `Sales-Claw-Setup-2.0.0.exe`
- macOS: `Sales-Claw-2.0.0-arm64.dmg` / `Sales-Claw-2.0.0-x64.dmg`
- Linux: `Sales-Claw-2.0.0-x86_64.AppImage`
- update metadata: `latest.yml` / `latest-mac.yml` / `latest-linux.yml`

### 仕組み
- main へ push すると `.github/workflows/release.yml` が `package.json::version`
  を読み取り、tag `v{version}` を自動作成
- Windows / macOS / Linux 3 OS で electron-builder がインストーラをビルド
- `--publish always` で GitHub Releases に上記アセットをアップロード
- インストール済みアプリは起動 5 秒後 + 6 時間ごとに `latest.yml` を polling し、
  新版があれば自動 DL → 「再起動で更新」ダイアログを表示

### 関連リポジトリ
- 公式リポジトリ: https://github.com/joseikininsight-hue/sales-claw-ts
- electron-builder.yml::publish.repo = `sales-claw-ts`

### Browser client-scripts を TypeScript 化 (esbuild 統合)
- **`src/ui/client-scripts/*.cjs` (11 ファイル, 4006 行) を全て `.ts` に変換**:
  - `provider-icon-fix.ts` / `column-resizer.ts` / `update-check-controls.ts` /
    `launch-crash-guard.ts` / `pagination.ts` / `sent-card-redesign.ts` /
    `settings-redesign.ts` / `dashboard-analytics.ts` / `awaiting-card-redesign.ts` /
    `cli-terminal.ts` / `dashboard.ts` (100K トークンの巨大ファイル含む)
- **esbuild を devDep に追加 + `scripts/bundle-client-scripts.cjs` 新規**:
  - `tsc` が `.ts` を `dist-ts/src/ui/client-scripts/*.js` にコンパイル
  - その後 `esbuild` が `platform: node / format: cjs / target: node20` で整形
  - sourcemap 付き、minify 無し (template literal 内の改行維持)
  - 11 ファイル / 400ms 未満でビルド
- **`scripts/postbuild-copy.cjs` 整理**: 旧 `.cjs` ミラーリング処理を廃止、
  代わりに `dist-ts/` 配下の stale `.cjs` を自動削除する処理に置換
- **`src/dashboard-server.ts` の require パス更新**: `./ui/client-scripts/xxx.cjs` →
  `./ui/client-scripts/xxx` (拡張子なし、tsc 出力 `.js` を Node が自動解決)
- 検証: `npm run build` 成功 / `npm run test:unit` 152件 全パス / Electron 起動して
  http://127.0.0.1:3456 から 681KB の HTML が返り、`__providerIconFixInit` /
  `pgn-bar` / `mt:colWidths:v1` 等の inline 注入 keyword を全部確認

### TypeScript Migration Roadmap: Stage 4.5 を追加
- `src/ui/client-scripts/*.ts` 内の template literal に閉じ込められた**ブラウザ JS
  自体を真の TypeScript に切り出す**ロードマップを `docs/typescript-migration-roadmap.md`
  に追加 (Stage 4.5 として記載)
- 完了すれば DOM globals の型補完 / `tsconfig.browser.json` での `lib: ["DOM"]` 制約 /
  esbuild の `bundle: true / platform: browser` でツリーシェイクが効くようになる

## 2.0.0-rc.1 - 2026-05-14 (OSS / Public Release 準備完了)

**最初のパブリックリリース候補。TypeScript 移植 + 公開可能化パッチ。**

### Dashboard Port Lifecycle 修正 (「ネットワークに接続できません」の再発防止)

過去に Sales Claw が `kill -9` 等で異常終了すると `dashboard-runtime.json` /
`dashboard-server.lock` がゴミとして残置され、次回起動時に Electron renderer が
**死亡 PID の古い port を読んで「ネットワークに接続できません」エラー**を
出していた。これを根本的に解消する:

- **`src/dashboard-runtime.ts`** 拡張:
  - `DashboardRuntime` に `pid: number` フィールドを必須化
  - `writeRuntime()` がデフォルトで `process.pid` を自動付与
  - `isPidAlive(pid)` を export (`process.kill(pid, 0)` で生存確認)
  - `isRuntimeStale(runtime)` を export (死亡 PID / 24h 経過 / 壊れた JSON を判定)
  - `readRuntime()` で stale な runtime は自動的に除外 (port は live PID のものだけ返す)
  - **`clearStaleRuntimes()`** 新規: primary + alternates の runtime.json を走査し、stale なものを実体削除
- **`src/dashboard-server.ts`** 起動シーケンス改善:
  - `claimStandaloneDashboardLock` の中で「死亡 PID lock」を検出したら **lock ファイルを実体削除**してから自分の lock を書く (旧: 上書きのみ)
  - 削除イベントを diagnostics に `stale_dashboard_lock_cleaned` として記録
  - lock 取得直後に `clearStaleRuntimes()` を呼び、stale runtime ファイルを一掃
  - 削除イベントを diagnostics に `stale_dashboard_runtime_cleaned` として記録
- **`tests/dashboard-runtime.test.cjs`** 拡張: PID 検証 / staleness 判定 / clearStaleRuntimes / readRuntime stale 除外を 21 件のテストでカバー
- **`docs/dashboard-port-lifecycle.md`** 新規: 起動シーケンス・障害シナリオ・データディレクトリの違いを完全文書化

実機検証 (`.electron-userdata/runtime/data/`):
```jsonc
// dashboard-runtime.json (NEW format)
{
  "bindHost": "127.0.0.1",
  "host": "127.0.0.1",
  "port": 3456,
  "preferredPort": 3456,
  "startedAt": "2026-05-14T06:49:17.439Z",
  "url": "http://127.0.0.1:3456",
  "pid": 38864   ← NEW
}
```

起動ログ例:
```
[startup] removed stale dashboard-server.lock (dead pid=22032, startedAt=2026-05-14T06:33:04.712Z)
[startup] cleaned 2 stale dashboard-runtime file(s): data/dashboard-runtime.json, data/dashboard-runtime.json
```

### Programmatic Credit 対応 (2026-06-15 ポリシー)
- **`src/spawn-env-sanitizer.ts`** (新規): `claude -p` ヘッドレス起動時に `ANTHROPIC_API_KEY` / `AWS_*` / `GOOGLE_*` / `OPENAI_API_KEY` 等 **22 種の課金リーク env を spawn options.env から削除**するサニタイザを導入。subscription credit 枠 (= 月額プラン) で課金される経路に切替
- **`buildManagedProviderEnv` 中央サニタイズ**: `src/dashboard-server.ts` の中央 env builder に組込み、parallel-dispatcher / cli-agent / form-fill / list-builder など全 spawn 経路を一括カバー
- **HOME / USERPROFILE を provider-home へ向ける**: subscription token が `<runtime data dir>/provider-homes/claude/.claude/credentials.json` から読まれるよう経路整備
- **Phase A を Haiku 化**: `settings-manager.getAiModelForPhase('site-analysis')` で `claude-haiku-4-5` を既定に (token 単価 1/10)
- **Phase B は Sonnet 維持**: メッセージ文章品質を落とさない
- **企業分析キャッシュ** (`src/analysis-cache.ts` 新規): 30 日 TTL ディスクキャッシュ、同じ会社の再分析を 0 token に。`%APPDATA%/sales-claw/runtime/data/cache/analysis/` に sha256(url+name) 単位で保存、5000 件超過で mtime 古い順 evict、PII 漏洩防止のため value のみ保存 (meta フィールド廃止)
- **Prompt cache 再利用率向上**: `--exclude-dynamic-system-prompt-sections` を全 `claude -p` 起動に追加
- **docs/programmatic-credit-migration.md** 新規: 認証切替手順 + トラブルシュート

### OSS 公開準備
- **LICENSE (MIT)** を root に追加 (electron-builder.yml の "MIT License" 宣言と一致)
- **`.github/workflows/ci.yml`** 新規: PR / main push で typecheck + lint + unit test を Ubuntu / Windows × Node 20 / 22 のマトリクスで実行
- **`.github/workflows/release.yml`** 新規: main push で `v{version}` タグ自動作成 → Win / Mac / Linux クロスビルド → GitHub Releases 自動 publish (electron-builder の `--publish always`)
- **package version**: `2.0.0-ts.0` → **`2.0.0-rc.1`** (リリース候補化)

### TypeScript 移行基盤
- **ESLint 10 + @typescript-eslint 8 を完全に動作する状態に**: 不足していた `eslint-plugin-n` / `eslint-plugin-promise` を devDeps に追加
- **`.ts` ファイルの lint 有効化**: `@typescript-eslint/no-explicit-any` を warn でルール化 (新規 any の混入をガード、既存 949 件は可視化)
- **`src/types/helpers.ts`** 新規: `parseJsonSafe` / `parseJsonAs` / `Result` / `ok` / `err` / `errorMessage` / `isPlainObject` / `isString` / `isNonEmptyString` / `getString` / `getNumber` / `getBoolean` / `getArray` / `getObject` / `requireSafe` / `clampNumber` / `truncate` — 既存 `: any` を unknown + ガード関数で narrow するためのプリミティブ集
- **`docs/typescript-migration-roadmap.md`** 新規: Stage 1 (現在) / Stage 2 (any 段階削減) / Stage 3 (strict 化) / Stage 4 (構造整理) の長期ロードマップ
- **lint**: 0 errors / 1129 warnings の状態に到達 (warnings は段階移行用の可視化)

### Test
- **`tests/spawn-env-sanitizer.test.cjs`** 新規 (16 件)
- **`tests/analysis-cache.test.cjs`** 新規 (13 件)
- `npm run test:unit` で計 130 件全パス

---

## Web v1.0 - 2026-05-13 (Landing / Blog / Docs 公開準備)

**Vercel デプロイ向け Next.js サイトの完成版**

### Sites / Pages
- **新規ページ**: `/about` `/pricing` `/contact` `/authors/[handle]` `/not-found.tsx` を追加
- **Blog**: カテゴリフィルタ + 記事検索 (`?category=` `?q=`) を実装
- **OG Images**: about / pricing / contact / download / blog / docs に Edge runtime の `ImageResponse` ベース OGP 画像を追加 (1200x630)
- **Sitemap**: LP アンカーのみだった `app/sitemap.ts` を全ページ + ブログ記事に拡張
- **Robots**: `/api/` `/_next/` `/admin/` を Disallow + GPTBot / ClaudeBot / PerplexityBot 等 AI クローラ 8 種を明示 Allow

### SEO / Analytics
- **GA4 (Consent Mode v2)**: `NEXT_PUBLIC_GA_MEASUREMENT_ID` 設定時に `default denied` で初期化、Cookie 同意バナーで `granted` 切替
- **Cookie バナー** (`components/consent/cookie-banner.tsx`): `localStorage` で同意状態保持、`gtag('consent','update')` で反映
- **Privacy Policy**: GA4 利用について明記、Consent Mode 動作を記載
- **Security headers**: `next.config.mjs` で production CSP / HSTS / X-Frame-Options / Permissions-Policy

### Refactor
- **GithubIcon 重複削除**: 6 ファイルに散在していた inline `GithubIcon` 関数を `components/icons/github-icon.tsx` に統合
- **Footer**: 導入事例 / 採用情報 / RSS / ニュースレターのリンクを撤去、About / Pricing / Contact 動線を追加
- **Site Nav**: 「料金」リンクを `/#料金` → `/pricing` に差し替え

### Docs
- `docs/vercel-deployment.md` を新規追加 (環境変数 / CSP / Consent Mode / デプロイ後チェックリスト)

---

## v1.2.111 - 2026-05-13

**Phase A LLM解析の安定化 + Claude CLI起動証拠ログ**

### Bug Fix
- **Phase A 並列度を 2 に制限**: CPU コア数で決めていた並列度 (最大 8) が原因で、内部 spawn される `claude -p` プロセスが同時 12-16 個になり、Claude Pro レート制限に抵触して 90 秒タイムアウトしていた。`PHASE_A_CONCURRENCY` を 2 に固定 (環境変数 `SALES_CLAW_PHASE_A_CONCURRENCY` で上書き可)
- **LLM 解析タイムアウト 90秒 → 120秒**: 並列実行時の Claude API レート競合を考慮
- **失敗時ヒント追加**: タイムアウトログに「Claude Pro レート上限の可能性」案内を追加

### Observability
- **Claude CLI spawn 証拠ログ**: `[llm-cli] claude spawned pid=... at ISO時刻` を stderr に出力。ハングなのかレート待ちなのかが特定できる
- **進捗ログ強化**: `thinking('claude CLI 起動中... (claude.cmd)')` で起動フェーズを可視化
- **経過秒数表示**: 失敗時に「LLM 解析失敗 (タイムアウト / Xx秒)」と実時間を出す

### Test Results (並列2社同時実行)
- テスト企業 A: 90秒で LLM 解析完了 (verdict=skip)
- テスト企業 B: 88秒で LLM 解析完了 (verdict=skip)
- v1.2.110では両社とも 90秒タイムアウトで失敗 → v1.2.111 で復旧

## v1.2.110 - 2026-05-12

**URLなし企業のPhase B委譲 + LLM解析タイムアウト延長**

### Bug Fix
- **URLなし企業がキューエラーになる問題を修正**: `urlMissing=true` (会社名からの公式サイト探索に失敗) の企業が Phase A でスキップされていた問題を修正。Phase B (CLI) に `urlMissing=true` マーカーを渡し、CLIが WebSearch で公式サイトを特定してからフォーム入力するフローに変更

### Performance
- **LLM解析タイムアウトを延長**: `llm-site-analyzer` の `timeoutMs` を 45秒 → **90秒** に延長。並列処理時のCLI起動遅延でタイムアウトが多発していた問題を解消
- **サイト分析タイムアウトも延長**: `analyzeCompanyLite` の Promise.race タイムアウトを 45秒 → **60秒** に延長

### UX
- **URLなし企業のPhase Bプロンプト修正**: `batch_rules` と `messageLines` から「urlMissing=true はエラー」という矛盾した指示を削除し、「WebSearch で公式サイト探索 → フォーム入力」という正しい指示に変更
- **log-action ガード緩和**: `form_fill` 済みの `urlMissing=true` 企業は `site_analysis` の不十分チェックをバイパスし `awaiting_approval` を許可

## v1.2.91 - 2026-05-10

**重要セキュリティ + 安定性 + UX 強化リリース**

### Security (Critical)
- **logAction を専用 API endpoint に切替**: 旧 `node -e shell` 経由 (会社名のシェル/プロンプトインジェクションで RCE 可能) を廃止し、`/api/log-action` POST + サーバー側サニタイズ (制御文字除去 / アクション whitelist / 最大長 truncate) に変更
- **`/api/settings` レスポンスで API キーマスク**: `apiKeys.*` `secrets.*` `password` `token` 系を `***` に置換 (空文字はそのまま)
- **`upload-document` パス検証**: PROJECT_ROOT または USER_DATA_DIR 配下のみ許可、拡張子ホワイトリスト (.pdf .md .txt .docx .xlsx .csv .pptx .xls .doc)、`..` トラバーサル拒否

### Stability / Performance
- **Phase A 並列度 semaphore**: 100 社一気に投入で 100 個の Node subprocess → 8-12 GB RSS スパイクの問題を解消。`max(2, min(8, cpus.length+1))` で上限
- **settings.json file-lock**: concurrent write の競合 (ICP 設定保存 + 他保存) でデータ消失するレースを排除
- **MCP Playwright slot プロファイル分離** (1.2.89→90): 並列モードで chromium User Data Dir 競合 → 2 社失敗を解消

### UX
- **ICP (理想顧客) UI**: 「提供価値」セクションに 8 入力欄 (descriptionFreetext / mustHave / dealBreakers / exemplars.positive,negative / minSiteTextLength / useLLMAnalyzer / useLLMMessageGenerator)
- **空状態メッセージ強化**: 確認待ち / 送信済タブで「次に何をすべきか」案内追加
- **進捗バッジ刷新**: `message_draft` → 「文面生成済 / フォーム入力待ち」
- **Pagination カウンタ修正**: 空リストで「全 1 件」誤表示を解消

### Phase A / Phase B
- **URL 空企業の CLI 委譲復活** (1.2.84→90): companyUrl 空 → CLI が WebSearch → 公式サイト発見 → フォーム入力。watchdog 10 → 20 分に拡張
- **HTTP fetch 大手対応**: 完全な Chrome 131 UA + 8 ヘッダ (Sec-Fetch / Sec-Ch-Ua) + gzip/br 自動解凍 で大手サイト (Akamai/Cloudflare 保護) 0 字 → 1900-2300 字に
- **Playwright fallback**: HTTP fetch で siteText < 200 字なら chromium 起動して取得 (BUG dmgmori-digital 0→1914字)
- **CAPTCHA → awaiting_approval 仕様**: 旧「CAPTCHA = error」を撤回。フォーム入力 + ss-{No}-input.png + awaiting_approval (人間が CAPTCHA 解いて送信)
- **メッセージ品質改善**: `truncateSoft` で "…" 混入の解消、`businessAreas` 機械選択を `companyType` 優先に変更 (「貴社のセキュリティ案件」決めつけ防止)

### UI
- **managed PTY 単一ブラウザ + タブ方式**: 1.2.85 で「2 社以上 → 並列ルート (3 Chromium)」にした判断ミスを撤回。CLAUDE.md タブ管理契約通り 1 Chromium で 1社目 navigate / 2社目以降 window.open に統一

### 内部
- Phase A skipped propagate (no field) で「全件失敗」誤表示解消
- runParallelAnalysisWorker が `parsed.skipped===true` を正しく failures から分離
- `recommendFormSessionStatus` に `proceed_then_await` 追加 (CAPTCHA + フィールドあり)

## v1.2.23 - 2026-04-27

- 内蔵ターミナルの3つの不具合を修正
  - **ログイン成功後も認証バナーが再表示される問題**: `Login successful` / `Logged in as` を検知したらバッファをクリアしてバナーを永続的に閉じる。エラーは新しい chunk のみで判定し、古い「Please run /login」テキストの誤再検知を防止
  - **入力時の表示崩れ**: CLI Activity タブが表示状態に切り替わるたび `fitAddon.fit()` を 40/200/600ms で再実行し、PTY に resize を送信。隠れタブで初期化された xterm のサイズ 0 問題を解消
  - **ヘッダの「AI を起動」で立ち上げた CLI が内蔵ターミナルに映らない問題**: WebSocket の `connected` イベントで `running:true` を受信したら、自動的に terminal host を表示し xterm を初期化して既存セッションにアタッチする

## v1.2.22 - 2026-04-26

- **dev source override + hot reload を導入** — UI 修正のたびの再インストール (159MB / UAC) が原則不要に
  - `electron-main.js` に `SALES_CLAW_DEV_DASHBOARD_SRC` env を追加: 絶対パスで指定すると、bundled `resources/app/src/dashboard-server.cjs` ではなくその path 配下を `require` する
  - `dashboard-server.cjs` に `SALES_CLAW_DEV_HOT_RELOAD=1` env を追加: `buildPage()` の冒頭で `./ui/**` の require cache を捨てて、ブラウザ再読み込みごとに client-scripts をディスクから再読込
  - `renderX(...)` を関数ラッパに変更し、cache 再構築が即時反映されるように (production では通常の cache lookup で性能影響なし)
  - 起動ヘルパー: `scripts/run-dev-mode.bat` をダブルクリックすれば dev mode で立ち上がる
  - 通常の起動 (env 無設定) では bundled UI / production runtime のまま

## v1.2.21 - 2026-04-26

- AI 起動モーダルのプロバイダーアイコン視認性を改善
  - 既定でアイコン枠に微弱なブランドカラー背景 + 1px ボーダー
  - **ダークモードでは Codex (黒系ロゴ) のアイコン枠を白パネルに切替** — 同化問題解消
  - Claude / Gemini もブランドティント背景で視認性向上
  - hover / selected 時はさらにコントラスト強調

## v1.2.20 - 2026-04-25

- 設定タブ サイドバーを写真リファレンスに忠実に
  - メニュー項目間の余白を 4px → 8px、項目内 padding を 14px に拡張で読みやすく
  - 「設定のヒント」をメニューと視覚的に分離 (24px の spacer)
  - ヒントカードを縦レイアウトに刷新: 電球アイコン + 太字タイトル / 説明文 (2行) / 全幅の「詳細ガイドを見る」ボタン
  - 電球アイコンを `font-variation-settings:"FILL" 1` で塗りつぶし表現に

## v1.2.19 - 2026-04-25

- **インストーラサイズを 159MB → ~80MB に半減 (約50%減)**
  - `next` (145MB) / `react-dom` (7MB) / `lucide-react` (6.5MB) / `react` を `dependencies` から `devDependencies` に移動
  - これらは `lp:dev` (ランディングページ用 Next.js) でのみ使用され、デスクトップアプリは一切 import していなかった
  - 結果: `resources/app/node_modules/` から ~160MB のデッドウェイトを削除
  - 自動アップデートで毎回ダウンロードする量も同じく半減

## v1.2.18 - 2026-04-25

- 自動アップデート後の "Cannot find module" 系起動失敗を根治
  - `nsis.runAfterFinish: false` を追加し、NSIS インストール直後の auto-launch を停止
  - 旧アプリの uninstall → 新ファイル書き込みが完了する前にアプリが起動して、まだコピーされていない依存モジュール (universalify / node-pty / ws / xlsx 等) を `require` しに行って失敗する競合状態を解消
  - インストール後はトレイ / スタートメニューから手動で起動する運用に変更

## v1.2.17 - 2026-04-25

- 設定タブ刷新の不具合修正 (v1.2.16 のフィードバック対応)
  - `Cannot set properties of null` エラーとフォーム空白問題を修正: rebuild が二重実行で1回目に moveした子を2回目に見失っていた → 完全に idempotent 化 (placeholder で原位置を保持し、wrap先を `unwrapPreviousShell` で戻してから再構築)
  - Excel取込ボタン (`入力テンプレート` / `Excelから読み込む`) もフォームと一緒に保持されるように
  - サイドバー / ヘッダ / ステッパー / フォームを **独立した白カード** として配置し、`--bg-base` の親背景でカード間に隙間を表現
  - 「設定のヒント」をフッタからサイドバー下部に移動 (写真リファレンス通り)
  - フォームカードを min-height 520px に拡張し、下部の白い無駄な余白を解消
  - サイドバーを sticky にしてスクロール時もメニューが追従

## v1.2.16 - 2026-04-25

- 設定タブを大幅刷新 (写真リファレンスに準拠)
  - サイドバー: アイコン + 名前 + 説明の2行レイアウト、アクティブ時はブルー強調
  - 上部に **進捗付きヘッダ** (「設定の完了率 X%」+ プログレスバー)
  - **5ステップのインジケータ** を追加 (会社プロフィール / 提供価値 / ターゲットリスト / メッセージテンプレート / 環境設定)
  - 会社プロフィールに **リアルタイム更新の右側プレビューパネル** を追加 (会社名・連絡先・会社概要)
  - フッタに「設定のヒント」+ **「保存して次へ」ボタン** を配置 (保存後に次のステップへ自動遷移)
  - 既存のフォーム ID / 保存ロジックは温存 (non-invasive な装飾オーバーレイ)

## v1.2.15 - 2026-04-25

- **MCP Playwright チェックを launch 時の必須から外す**
  - `/api/launch-ai` の前段で MCP 設定確認に失敗してもエラーにせず警告ログだけにする
  - Gemini / Codex の `mcp` サブコマンド未対応や偽陰性で起動できなかった問題を解消
  - バッチ送信パスでは引き続き MCP 必須 (`requireMcp: true` 経路は据え置き)
- **ターミナル高さをドラッグでリサイズ可能に**
  - `cli-term-host` 下端にドラッグハンドル(8px / `cursor: ns-resize`)
  - 200px〜画面の85% の範囲で自由調整、`localStorage('cli-term:height')` に永続化
  - リサイズ中は `fitAddon.fit()` を毎フレーム呼んで PTY サイズも追従

## v1.2.14 - 2026-04-25

- 内蔵ターミナルで「文字入力できない」「プロンプトが見切れる」問題を修正
  - 高さ 380px → 460px に拡張
  - クリックでターミナルを強制フォーカス、`cursor: text` で操作可能性を視覚化
  - フォーカス時に `outline: 1px solid` のリングを表示
  - `xterm-helper-textarea` の z-index を `-5` → `5` に上げて入力捕捉を確実化
  - 受信データのたび `scrollToBottom()` でプロンプトを常に視野内に保持
  - launch 後 40 / 120 / 360 / 800ms の 4 回 `fitAddon.fit()` を呼んで再レイアウトに耐える
  - `window.resize` 監視で再フィット

## v1.2.13 - 2026-04-25

- ページネーションバーの「表示件数」セレクトを画面右端から外し、ページ番号のすぐ右に寄せた左寄せレイアウトに変更
  - `justify-content: space-between` → `flex-start` / pages の `flex` を grow しない設定に
  - サマリ → ページ番号 → 表示件数セレクト の順で 18px gap でクラスタリング

## v1.2.12 - 2026-04-25

- 企業一覧 / 確認待ち / 送信済み / Action Log 全リストに **ページネーション** を追加
  - "Minimal SaaS" スタイル: 全件表示+ページ番号 (省略付き) + 表示件数セレクト
  - 表示件数は localStorage に永続化 (リスト単位)
  - フィルタで非表示の行は自動除外してページ計算
  - **10,000 件**まで耐えるパフォーマンス検証済み (注入 + ページング合計 1秒程度)
  - レスポンシブ対応 (760px 未満で縦並び)

## v1.2.11 - 2026-04-25

- CLI Activity タブに「**Claude を起動 / Codex を起動 / Gemini を起動**」ボタンと内蔵対話ターミナル (xterm.js) を追加
  - 既存 WebSocket (`/terminal`) + `/api/launch-ai` / `/api/stop-ai` / `/api/ai-input` と接続
  - PTY 出力をブラウザ内で表示、キーストロークも双方向
- 認証エラー(`Please run /login` / `API Error: 401` / `authentication_error` / `Invalid API key` / `token expired`) をリアルタイム検出すると、**手順入りの黄色アシストバナー** を自動表示
  - 「**/login を実行**」ボタンでターミナルに自動入力
  - 公式ドキュメントへのリンク併記
- 非エンジニアでもログイン作業ができるよう、空状態のヘルプ文言・ステータス LED・閉じるボタンを整備

## v1.2.10 - 2026-04-25

- `verify-release-readiness.cjs` を `nsis.differentialPackage: false` 時に blockmap 不存在を許容するよう修正 (v1.2.9 の Windows ビルド失敗対応)
- v1.2.9 は Windows 配布なし(Mac / Linux のみ)。実質的な内容は v1.2.10 と同じ

## v1.2.9 - 2026-04-25

- 自動更新の差分配信 (`differentialPackage`) を無効化し、毎回フルインストーラ転送に切り替え
  - 既存インストールが CI ビルドと完全一致していない場合に node_modules の transitive 依存 (universalify ほか) が脱落して `Cannot find module 'universalify'` で起動失敗する事故が v1.2.5→1.2.6 / 1.2.6→1.2.7 / 1.2.7→1.2.8 の 3 連続で発生したため、信頼性を優先
  - ダウンロード量は毎回 ~200MB に増えるが、自動更新の確実性が大きく改善

## v1.2.8 - 2026-04-25

- 「編集して再送」を実装 (送信済みカードのボタン → モーダル表示 → 編集 → POST /api/resend-prepare → 確認待ちタブへ復帰)
  - バックエンド `/api/resend-prepare` を追加 (action-log と contact-history を更新)
  - 検証: 空文 / 32KB 超 / 企業番号不正 を 400 で弾く
  - キーボード: Esc で閉じる / Ctrl+Enter で送信
- 確認待ちカードから「AI 実行ログ」セクションを削除し、全体パディング・余白・フォントを縮小して 1 画面で多くの情報が見られるようコンパクト化
- 企業一覧テーブルの送信日付セルを刷新 (緑モノ強調 → check_circle アイコン + 通常書体、複数回連絡時のみ「N回目」chip)
- ヘッダ (.app-header) の sticky 上書き (`position:relative`) を削除し、`#mainTabNav` がスクロール時に画面上部へ正しく固定されるように修正

## v1.2.7 - 2026-04-25

- 確認待ち (awaiting) カードを「送信内容の確認」パネルに刷新 (ヘッダ + 2カラム + フッタ)
- 送信済み (sent) カードを同じデザイン言語に統一し、連絡履歴をタイムライン表示
- スクリーンショットの拡大/縮小コントロールを追加 (50%–400% / 25%刻み / リセット)
- 「編集して修正」「返信を記録」「編集して再送」など将来機能のUIプレースホルダを配置
- 企業一覧テーブル (#mt) の列幅をドラッグで調整可能に (localStorage で永続化、ダブルクリックでリセット)

## v1.2.6 - 2026-04-25

- 自動アップデート経路の E2E 検証用リリース
- `verify:dist` ゲートを再確認

## v1.2.5 - 2026-04-25

- ダッシュボード正本を `src/dashboard-server.cjs` + `src/ui/**` + `src/routes/**` に分割
- プレビュー (3480) / 開発 Electron / パッケージ済み Electron が同一ソースから起動するように統一
- `scripts/verify-release-readiness.cjs` / `scripts/verify-surface-parity.cjs` を `predist` / `postdist` ゲートとして配線
- `scripts/preview-dashboard.cjs` を追加 (3480 でルートのダッシュボードを起動)
- `scripts/install-latest-win.ps1` を追加 (Sales Claw 起動中なら停止検知して安全にインストール)
- オフライン用 vendor 資産を `assets/vendor/` に同梱 (Inter / JetBrains Mono / Noto Sans JP / Material Symbols / Phosphor / Tailwind / Chart.js / xterm)
- `electron-builder` 設定を `joseikininsight-hue/sales-claw` / channel:latest / publishAutoUpdate:true に固定
- `local-test` / `${env.GH_OWNER}` / `${env.GH_REPO}` のプレースホルダフィードを禁止
- `docs/release-parity-and-autoupdate.md` / `.claude/commands/release-parity.md` を追加
- `AGENTS.md` / `CLAUDE.md` に Desktop Release / Auto Update Gate ルールを追加
- バッチ復旧用の `src/batch-watchdog` / `src/recovery-store` / `src/startup-cleanup` / `src/ai-runtime` を追加

## v1.0.9 - 2026-04-05

- Windows デスクトップ版を最新 UI / UX に更新
- Claude / Codex / Gemini の AI Provider 切り替えに対応
- 確認待ち・送信済み・企業一覧まわりの操作性と監査表示を改善
- 設定の Excel import / export とセットアップ補助を追加
- ダッシュボード API / ランタイム保護を強化
- `/api/data` のキャッシュ化、不要な多重起動抑止、ポーリングと描画負荷の見直しでパフォーマンス改善
- `Blocked cross-origin dashboard request.` の誤判定を修正
- テスト用の一時ファイル、検証用スクリプト、不要な残骸を整理

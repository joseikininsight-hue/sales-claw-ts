# Sales Claw (bp-outreach-ts) 段階的リファクタリング計画【確定版】

**版**: 2.0（レビュー反映済み・最終） / 対象コミット: `2860a60` (v2.1.4) / 前提: 10 並列監査の findings（god-module / dead-code / duplication / type-safety / architecture / tests / cruft / build-deps / data-layer / consistency）+ 計画レビューの是正事項（A-1〜A-7 / B-1〜B-7 / C-1〜C-5）を全件取込

## 進捗再監査（2026-06-13 / `refactor/phase-0`）

**厳格判定**: 本計画全体は未完了。P0 は実装ゲートをほぼ満たしたが、E2E の 2 週間安定観測と blocking 昇格は日数経過が必要なため「条件付き完了」。P1/P2 は一部完了、P3〜P6 は未完了。

| フェーズ | 判定 | 2026-06-13 時点の事実 |
|---|---|---|
| P0 | **条件付き完了** | unit 51 手書き列挙 → glob 自動発見 **74 files / quarantine 0**。c8 lines **69.24%** を CI artifact 化しラチェット追加。Playwright **17/17** と実 Electron/WebContentsView E2E をローカル通過。Windows non-blocking E2E job、scripts 型検査、knip/ts-prune/depcheck/madge/jscpd、dist-ts build stamp、プロンプト 8 分岐 + HTML + message-builder golden、approve/ai-submit-final unit を追加。残件は non-blocking E2E の 2 週間観測後の blocking 昇格のみ |
| P1 | **一部完了** | 確定 dead code / dead settings / stale path を削除、CLAUDE.md 同期、`target-list.ts` の到達不能 auto-repair ブロックを追加削除。歴史コメント整理、依存判断キュー全件、タブ契約後続は未完了 |
| P2 | **一部完了** | `atomicWriteJson` 統一、pierce-resolve 単一化、server-side `escapeHtml` 集約の一部は完了。`net-guard.ts`、`llm-cli-runner.ts`、locale-pack/http-fetch 統合などは未完了 |
| P3 | **未完了** | `dashboard-server.ts` は **12,509 行**で、目標 3,000 行以下に未到達 |
| P4 | **未完了** | JSONL dual-write、store 層、lost-update/retention/schema migration は未実施 |
| P5 | **未完了** | 明示的 any **948**。scripts 用型検査と helper 配線は開始したが、noImplicitAny flip / zod shadow→enforce は未実施 |
| P6 | **未完了** | 空 catch **225**。ESLint `no-empty` は warn 可視化済みだが 0 件化、error envelope/i18n/定数/配布物軽量化は未実施 |

### 今回の厳格監査で修正した見せかけの完了

- 5 本の陳腐化テストを quarantine して green に見せていた状態を廃止し、全件を現行契約へ修正。
- `sentMessage` 下限が正本の 30 文字から実装だけ 10 文字へ緩和されていたため、**30 文字 422 ガードへ復元**し複合違反順序を固定。
- `removeCompanyLogs()` がロック保持中に `flushNow()` で同じロックを再取得する自己デッドロックを修正。
- `CLAUDE.md` の「同一 sessionId 再利用」は現行 v2.0.96+ 実装と不一致だったため、`formUrl` から新規 session を作り承認済み `sentMessage` を再入力する契約へ訂正。
- scripts/*.ts を ESLint が JS parser で解析していた設定不備と、`target-list.ts` の到達不能コードを修正。lint error は **8 → 0**（warning は段階負債として残存）。

---

## エグゼクティブサマリ

本計画は、12,531 行の god module（`src/dashboard-server.ts`、直近 6 ヶ月で 70 回変更の churn #1）、明示的 `any` 946 個、SSRF ガード 5 実装の強度ドリフト、torn-write フォールバック 4 残存、CI から漏れた孤児テスト 20 本、そして**今この瞬間に壊れている実行時バグ**（存在しない `scripts/managed-pty-viewer.cjs` の spawn、可変 CDN tarball 依存の `xlsx`）を抱える本リポジトリを、**7 フェーズ・総工数 60〜95 人日**で段階的に健全化する。原則は 4 つ — ①安全網（characterization テスト・カバレッジ計測・負債メトリクスのラチェット）を**実際に先に**張り、正規化済み golden（セッショントークン・バージョン・electron 分岐を除去した HTML ハッシュ、autoSendSafe×タブ数×モードの全分岐を覆うプロンプト snapshot、approve→submit 経路のユニットテスト）が green になるまで god module に触れない、② push = 自動リリースの運用に合わせ**全フェーズ・全項目を独立リリース可能な粒度**に保つ（データフォーマット変更は dual-write + 逆変換スクリプトで revert 耐性を確保）、③ god module 分割は既に成功している 2 つの社内パターン（routes DI ファクトリ 11 本 / ui/client-scripts renderer 12 本）の延長としてのみ行い、最大リスクの ManagedAiBatchEngine 抽出は「状態集約 → ファイル内クラス化 → 移動」の 3 段 + リリース間挟み込みで進める、④挙動変更（バグ修正・検証強制・レイテンシ変更）は `fix:`/`feat:` コミットとして behavior-preserving な `refactor:` コミットから完全分離し、zod 検証導入のような「以前は通っていたリクエストが拒否される」変更は shadow モード 1 リリースを必ず経由する。ABSOLUTE RULE 経路（/api/log-action の 422 ガード、awaiting_approval フロー、form-session/MCP 経路）は全フェーズを通じて最大保護下に置く。

## フェーズ全体像

| フェーズ | 目的 | 主要成果物 | 工数 | リスク |
|---|---|---|---|---|
| **P0** 安全網 + 実行時破損修正 | リファクタを開始できる状態を作る | グロブテストランナー（51→64 本以上）/ c8 / ツール CI 常設 + debt-metrics / **正規化付き** characterization 一式（プロンプト 8 パターン・HTML ハッシュ・422 複合違反順序・approve/submit・SSE）/ spawn 破損と xlsx 依存の修正 | 5–8 人日 | 低 |
| **P1** 低リスク掃除 | 読解コストとレビューノイズの削減 | 確定デッドコード約 350 行削除 / 歴史コメント整理（**dashboard-server 以外**）/ 依存・ビルド掃除 / CLAUDE.md 同期 / タブ契約の**意思決定** | 4–6 人日 | 低 |
| **P2** 重複排除 / DRY | セキュリティドリフトの収束 | `net-guard.ts`（SSRF 単一実装 + shadow モード）/ atomicWriteJson 統一 / `llm-cli-runner.ts` / pierce-resolve 単一化 / locale-pack ロジック統合 / `http-fetch.ts` | 6–10 人日 | 中 |
| **P3** god module 分割 | dashboard-server.ts 12,531 行 → 3,000 行以下 | プロンプトビルダー抽出（テンプレート PR）/ createServer 純化（≤80 行）/ buildPage 解体 / ManagedAiBatchEngine 3 段抽出 / 周辺 oversized 分割 / require→import コードモッド（並行トラック） | 16–27 人日 | 高（3d）〜低 |
| **P4** データ層是正 | 2,000 社バッチ耐性 + レイヤリング修復 | `json-store.ts` / action-log JSONL 化（dual-write + 逆変換同梱）/ lost-update 修正 / 保持・ローテポリシー / スキーマバージョン / 依存方向反転 / form-session-manager 空 catch 可視化 | 11–16 人日 | 中 |
| **P5** 型安全 | noImplicitAny 点灯への段階導入 | useUnknownInCatchVariables / typed RouteContext / zod 境界検証（**shadow→enforce 2 段**）/ settings・xlsx・MCP pipe の型付け / any ラチェット | 12–20 人日（分割消化） | 中 |
| **P6** 仕上げ | 一貫性・運用品質の固定 | 空 catch 0 / エラー envelope 正規化 / i18n 貫通 / 定数化 / インストーラ −65MB / 規約の CLAUDE.md 固定 | 8–12 人日 | 低〜中 |

合計目安 **62〜99 人日**。P4/P5/P6 は P3 完了を待たず「P3 が触らないファイル」から並行着手可。require→import コードモッドは P0 完了直後から並行トラックとして開始可。

---

## 0. 現状の負債スナップショット（測定値・全フェーズの根拠）

| 領域 | 測定値 | 根拠 |
|---|---|---|
| God module | `src/dashboard-server.ts` **12,531 行**、トップレベル宣言 391、直近 6 ヶ月の変更 70 回（churn #1）、初公開コミットから **+30%** 成長（9,618→12,531） | god-module / architecture 監査 |
| うち inline HTML/JS | `buildPage()` **4,127 行**（L7500-11626、内ブラウザ JS 約 2,400 行） | god-module 監査 |
| managed-AI クラスタ | **約 2,000 行**が**約 35 個のモジュールグローバル可変状態**（`claudePty`, `managedAiBatchController` 等 L171-194）と絡み合い | god-module / architecture 監査 |
| 型安全 | 明示的 `any` **946**（うち dashboard-server.ts に 307）、`--noImplicitAny` ドライランで**追加エラー 1,175**、スキーマ検証ライブラリ **0**、`parseJsonBody` 61 箇所が未検証 | type-safety 監査 |
| 歴史コメント | バージョンタグ付きコメント **325**（src 319 + electron-main 6、dashboard-server 単体で 166 = 52%）。TODO/FIXME は **0** | cruft 監査 |
| 重複 | jscpd 厳密一致 861 行（1.53%）、near-miss 込み実態**約 1,300-1,500 行**。SSRF ガード **5 実装**（強度不一致）、`writeJsonAtomic` **4 コピー**（全てが file-lock.ts が「torn write の元凶」として撤廃した `copyFileSync` フォールバックを保持） | duplication 監査 |
| テスト | tests/ に 71 本の `.test.cjs` があるのに `test:unit` は手書き列挙の **51 本のみ実行**。**孤児 20 本**（13 本は今日も合格、5 本は陳腐化して失敗）。E2E（Playwright 17 spec + 実 Electron ランナー）は **CI 実行 0**。src 135 モジュール中 **59 が無テスト**（約 12,025 行）。**approve / ai-submit-final を名前に含むテストは 0 本**（実機確認済み） | test-health 監査 + レビュー A-3 |
| デッドコード | 確定デッド本番コード**約 567 行**、ゼロ参照 export **30**、knip/ts-prune/depcheck/madge/jscpd は **CI 未常設**（生出力は誤検知 ~70%） | dead-code 監査 |
| データ層 | ストアモジュール **11 個**が read-cache/quarantine/atomic-write を各自再実装（atomic write **5 実装**）。action-log.json は read-all/write-all + **10,000 件トリム** → 2,000 社バッチ（10-14k entries）で**承認待ち証跡が黙って消える**。スクリーンショット保持ポリシーなし（実測 251 files / 67MB）。スキーマバージョン/マイグレーション基盤なし | data-layer 監査 |
| ビルド/依存 | **実行時破損あり**: `dashboard-server.ts:6792` が存在しない `scripts/managed-pty-viewer.cjs` を spawn（.ts 化で常時 throw、実機確認済み）。`xlsx` が可変 CDN tarball（`package.json:80` の `xlsx-latest.tgz`）依存 = `npm ci` 時限爆弾。インストーラに回避可能な **~65MB** | build-deps 監査 |
| 一貫性 | 空 catch **225/753 (30%)**、`require()` 313 行 vs ES `import` 96 行（混在ファイル 15、**二重 export 60**）、i18n をルートで使うのは 12 ファイル中 1、ポート 3765 直書き 7 ファイル、ボディ上限値 6 系統 | consistency 監査 |
| 循環依存 | madge 検出 **0**（ただし require() 主体のため**未確定の主張**。import 移行完了時に再測定しブロッキング化） | architecture 監査 + レビュー A-5 |
| 非決定出力（golden 阻害要因） | `buildPage()` は L10610/L10641 でセッショントークン、L7565/L11672 で `APP_VERSION`、L10643 等で `process.versions.electron` 分岐を出力に直接埋込（実機確認済み）。プロンプトは `SALES_CLAW_DASHBOARD_URL`・絶対パス・ポートを含み得る | レビュー A-1 |
| auto-send 分岐 | `autoSendSafe` は locale-pack `ja/cli-prompts.ts:15,51,95` と dashboard-server.ts:468（`getManagedAiAutoSendSafe`）/946/1141（`createManagedAiBatchController(providerId, autoSendSafe)`）/3717-3751/5929 に実在し、P2-5・P3a・P3d 全てが通過する（実機確認済み） | レビュー A-2 |

## 基本方針（全フェーズ共通）

1. **Behavior-preserving が原則**。動作変更（バグ修正・検証強制・レイテンシ変更・機能削除）は `fix:`/`feat:`/`perf:` ラベル付き独立コミットに隔離し、`refactor:` コミットと混ぜない。**本計画内で挙動変更に当たる項目**: 0-1、2-1、2-2（強度統一）、4-3、4-4、4-8、5-3（enforce 段階）、1-9 の実装（3a 後続）。
2. **各フェーズ・各項目は独立して main にマージ・リリース可能**。push = 自動リリース（`.github/workflows/release.yml`）のため、常にリリース可能な状態を維持。`npm run verify:release` → `verify:dist` → `verify:github` のゲートを省略しない。
3. **安全網を張ってから動かす**。P0 の characterization（正規化込み）が green になるまで dashboard-server.ts に手を入れない。
4. **Strangler-fig**。先行成功パターン 2 つ（routes DI ファクトリ 11 本 / `src/ui/client-scripts/*` renderer 12 本）の延長のみ。新パターンを発明しない。
5. **抽出モジュールはテスト同梱必須**（レビュー C-1）。P3/P4 で新設するモジュールは「移動元 characterization の移送 or 新規ユニットテスト」を**同一 PR に含める**。c8 カバレッジは debt-metrics ラチェットで**単調非減少**を強制。これが無いと god module 分割は「テストされない小さいファイル 20 個」を生むだけになる。
6. **ABSOLUTE RULE 経路は最後まで最大保護下**。422 ガードの順序・文言・閾値を変えるリファクタは禁止。`sentMessage` プレースホルダ照合文言は 3 箇所重複（message-builder.ts:405 / locale-pack ja:106 / 422 ガード）— 統一前に characterization で固定（2-7）。

---

## Phase 0: 安全網の構築 + 実行時破損の即時修正

### 目的
「テストが自動で見つかり、カバレッジが数字で見え、ツールが CI に常設され、最重要シームに**再現可能な** characterization テストがある」を達成する。あわせて今壊れている実行時バグ（機能復旧 = behavior-preserving の例外、`fix:` ラベル）を直す。

### 完了の定義（測定可能）
- `tests/**/*.test.cjs` がグロブ自動発見で実行され、CI 実行テスト数 51 → **64 本以上**。
- c8 カバレッジが CI アーティファクト出力される（ベースライン記録目的。閾値強制なし。**以降は単調非減少ラチェット対象**）。
- knip/ts-prune/depcheck/madge/jscpd が non-blocking CI ステップとして毎 PR 実行され、`knip.json` 整備後の **unused-files 残存 ≤ 30 件かつ全件に理由アノテーション**（「読める量」の数値化、レビュー B-4）。
- 0-9 の characterization 一式（下記 ①〜⑧）が CI で green、かつ**ローカル 2 回連続実行でバイト一致**（正規化の再現性証明）。
- Playwright E2E（17 spec）が CI の 1 OS で **non-blocking** 実行されている（blocking 昇格は実績 2 週間後、レビュー B-6）。
- `typecheck:tests` の `continue-on-error: true` が外れている（現在 exit 0 確認済み）。
- 負債メトリクス（any / 行数 / バージョンコメント / 空 catch / 重複率 / カバレッジ）が `scripts/debt-metrics.ts` 1 本で再計測できる。

### タスク

| # | タスク | effort | risk |
|---|---|---|---|
| 0-1 | **【fix】managed-pty-viewer spawn 破損の復旧**。`dashboard-server.ts:6792` が `scripts/managed-pty-viewer.cjs` を spawn するが commit 8cc882d の `.ts` 化でディスクに存在しない（2 エンドポイント L6871/L6888 から到達、常時 throw）。`.cjs` に戻すか dist-ts へコンパイルしてパスを向け直す。あわせて「spawn 対象スクリプトパスを全列挙して存在検証するスモークテスト」を tests/ に追加 | S | 低 |
| 0-2 | **【fix】xlsx を版固定 tarball に**。`package.json:80` の `https://cdn.sheetjs.com/xlsx-latest/xlsx-latest.tgz` を `xlsx-0.20.x` 系版固定 URL へ。latest 回転時に全マシン + CI 4-job matrix の `npm ci` が EINTEGRITY で死ぬ時限爆弾。**版固定でも cdn.sheetjs.com はレジストリ外配布で CDN 可用性リスクが残るため、tarball の `vendor/` コミット or 社内ミラー化を意思決定キューに追加**（レビュー C-4） | S | 低 |
| 0-3 | **test:unit のグロブランナー化**。51 エントリの `&&` チェーンを `tests/run-all.cjs`（fs-walk + 明示 denylist: electron-real-form, benchmark-n-companies 等の手動ランナー）に置換。**commit cceae75 (2026-05-28) が孤児 31 本を救済した 2 週間後に孤児 20 本が再蓄積した実績**があり、手書きリストは構造的に維持不能。合格中の孤児 13 本（form-session-manager / cdp-bridge / internal-mcp-integration / list-builder 8 本等、計 5,208 行）を即時回収 | S | 低 |
| 0-4 | **陳腐化した孤児テスト 5 本のトリアージ**: `action-logger.test.cjs:110`（getAll 形状変更で TypeError）、`approval-artifacts.test.cjs`・`awaiting-approval-guard.test.cjs`（**ABSOLUTE RULE を守る唯一のテスト群 — 現挙動に合わせて修正必須**）、`performance-guards.test.cjs`（TS 移行で死んだ require パスの機械修正）、`simple-api-p2.test.cjs`（ガード順序変更反映）。修正後ランナーに組込み | M | 低 |
| 0-5 | **c8 導入**: `c8 node tests/run-all.cjs`。59/135 モジュール無テストの穴を見える数字にし、ベースラインを debt-metrics に登録（以降単調非減少） | S | 低 |
| 0-6 | **E2E を CI へ（段階導入、レビュー B-6）**: ① `playwright test`（17 spec）+ `node tests/electron-real-form.test.cjs` を windows-latest の **non-blocking** job として追加 → ② 2 週間の安定実績を観測し flaky spec を隔離タグ付け → ③ blocking 昇格。初回から blocking にすると「赤いまま無視される CI」化し Phase 3 の安全網にならない。`@playwright/test` を devDependency として明示（現在 runtime `playwright` からのフォールバック require）。あわせて **approve → ai-submit-final → submitted のジャーニー spec 1 本新設**（収益クリティカル経路に E2E ゼロ）。**dashboard.spec.js が SSE `/events` を踏むか確認し、踏まないなら「接続 → イベント 1 件受信」のミニテストを追加**（3b の移設前提、レビュー B-7） | M | 低 |
| 0-7 | **typecheck:tests をブロッキング化** + `tsconfig.scripts.json`（noEmit）新設で scripts/*.ts **2,658 行**（リリースゲート自身の verify-release-readiness.ts 498 行を含む）に型検査。0-1 の破損はまさにこの空白が生んだクラス | S | 低 |
| 0-8 | **ツール常設**: `knip.json`（entry: bin/sales-claw-form-mcp.cjs, src/mcp-servers/**/server.cjs, playwright.config.js, package.json 起動 scripts, runtime-spawn される parallel-analysis.ts / company-analyzer.ts / managed-pty-viewer; ignore: assets/vendor）を整備し、knip / ts-prune / depcheck / madge / jscpd を non-blocking CI 化。`scripts/debt-metrics.ts`（any 数 / 暗黙エラー数 / 行数 / バージョンコメント数 / 空 catch 数 / 重複率 / c8 カバレッジ）を追加しベースライン記録 | M | 低 |
| 0-9 | **characterization テスト敷設（Phase 3 の生命線、レビュー A-1/A-2/A-3/A-4/B-7 反映）** — 下記詳細 | L | 低 |
| 0-10 | **dist-ts 連動の強化**: ビルドスタンプを出力し、ランナーが「dist-ts が src より古ければ拒否」。`process.exit(0)` のサイレントスキップ 5 箇所を明示的 `SKIPPED` 集計に変換 | S | 低 |
| 0-11 | **ESLint ラチェット下準備**: `no-empty (allowEmptyCatch:false)` と `no-explicit-any` を warn で常設し、警告数を debt-metrics に含める（修正自体は P4/P5/P6） | S | 低 |

### 0-9 詳細: characterization テスト仕様

**共通原則: golden は「正規化してから固定」する。正規化関数自体にユニットテストを付ける**（レビュー A-1。これが無いと 3c の差分検知器は初回リリースの version bump で red になり形骸化する）。

| 対象 | 仕様 |
|---|---|
| ① プロンプト snapshot | `buildClaudeFormFillPrompt`（L5926-6112）と `buildManagedAiSessionContract`（L3715-3758）。**マトリクス: `autoSendSafe × {true,false}` × `tabs × {1,3}` × `mode × {internal,playwright}` = 最低 8 パターン**（レビュー A-2。auto-send 分岐は ja/cli-prompts.ts:15,51,95 と dashboard-server.ts:468/946/1141/3717-3751/5929 に実在し、2-5・3a・3d の全てが通過する。「代表 3-4 パターン」では既定 OFF の auto-send 側が固定されない）。**固定 env（`SALES_CLAW_DASHBOARD_URL` 等）を注入し、スクリーンショット絶対パス・ポートを正規化してからハッシュ**。dashboard.spec.js の既存アサーションは旧 `SALES_CLAW_TAB_CONTRACT` 文言固定のため「現状出力をそのまま固定」する形で取り直す |
| ② loadData | 既存 3 テストを起点に拡充 |
| ③ buildPage HTML ハッシュ | lang=ja/en × 代表設定。**ハッシュ前正規化を仕様として実装**: セッショントークン（L10610 / L10641 `ensureDashboardSessionToken()`）、`APP_VERSION`（L7565 / L11672 — 各リリースで version bump する方針のため必須）、`process.versions.electron` 分岐（L10643 等）、絶対パスをプレースホルダ置換。**正規化関数自体のユニットテスト**（token を変えてもハッシュ不変 / 実コンテンツを変えるとハッシュ変化、の双方向検証）を同梱 |
| ④ message-builder snapshot | `message-builder.ts`（795 行・純関数・テスト 0） |
| ⑤ /api/log-action 422 ガード | 単独違反 4 ケース（sentMessage 欠落 / 30 字未満 / プレースホルダ / screenshot 不在）**+ 複合違反時にどのガードが先に発火するかの順序ケース**（レビュー A-4。これが無いと 5-3 の zod 化で順序保存を証明できない） |
| ⑥ approve / ai-submit-final | **新規（レビュー A-3。tests/ に approve / submit を名前に含むテストは 0 本 — 実機確認済み）**: `/api/approve` の判定ロジック、`/api/ai-submit-final` のプロンプト enqueue と「破棄済み session の `formUrl` から新規 session を作り、承認済み `sentMessage` を再入力する」契約（v2.0.96+）をユニットレベル固定。E2E ジャーニー（0-6）だけでは flaky 化した瞬間に 3b/3d/4-11 がこの収益クリティカル経路を無防備で触ることになる |
| ⑦ SSE /events | 「接続 → イベント 1 件受信」ミニテスト（0-6 と分担。3b の移設前提、レビュー B-7） |
| ⑧ recovery スナップショット形状 | `snapshotManagedAiBatchesForRecovery`（L1159）の **JSON 形状 golden**（レビュー B-1。クラッシュ復旧互換の差分検知器が現状存在しない。3d の前提テスト） |

### リリース単位
**独立リリース可**。0-1 / 0-2 はユーザー影響があるため即リリース推奨（patch bump）。CI/テスト整備は main 直行で可。

---

## Phase 1: 低リスク掃除（デッドコード・歴史コメント・依存・ドキュメント）

### 目的
ランタイム挙動に影響しない確定デッドコード・歴史的ナレーション・未使用依存・嘘ドキュメントを除去する。**dashboard-server.ts のコメント整理は対象外**（P3 の各抽出 PR に繰延、レビュー B-3）。

### 完了の定義
- 確定デッド本番コード約 350 行削除（EDINET 217 行は意思決定キュー送りのため除く）。
- **`tmp/export-xref.tsv` の検証済みリスト消化 100%**（レビュー A-5。旧基準「knip 残存が意思決定キュー項目のみ」は import 移行後にしか knip が信頼できない＝Phase 1 時点で達成不能のため差替）。
- バージョンタグ付きコメント: **dashboard-server 以外の 159 件 → 40 以下**（dashboard-server の 166 件は P3 各抽出 PR で処理。全体最終目標 ≤80 は P3 完了時に判定）。
- CLAUDE.md の stale 記述（.cjs パス 25 箇所、`C:\bp-outreach`、v2.0.92 ヘッダ）が 0。

### タスク

| # | タスク | effort | risk |
|---|---|---|---|
| 1-1 | **確定デッドコード削除**: `src/config.ts`（30 行、参照ゼロ、MIGRATION.md:207 の表行も削除）/ `src/types/index.ts`（バレル 6 行）+ `src/types/runtime.ts`（44 行）— **`types/helpers.ts`（270 行）は削除しない**（P5 で採用予定）/ `form-session-manager.ts:1295` の `_positionView` no-op + L1289-1294 の tombstone コメント / dashboard-server.ts **L12093-12113 の到達不能な重複 `/screenshots/` ブロック**（L12046 の先行ブロックが全分岐 return。`findScreenshotPath` の多ディレクトリ探索が意図仕様なら live ブロックへフォールバック統合 — どちらかを 1 コミットで決める）。**`/screenshots/` のユニットテストは「パストラバーサル payload（`..%2f`、絶対パス、UNC パス）」を明示的にケース列挙**して同梱（セキュリティガードの 3b 移設前固定、レビュー B-7） | S | 低 |
| 1-2 | **`onWindowResize` no-op チェーン削除**: メソッド単体削除は**ビルドを壊す**（electron-main.ts:323 のリスナー + :40 のインターフェース宣言が生存）。no-op 本体 + リスナー + インターフェース宣言を **3 点セット 1 コミット**で削除（HTML 側 resize リスナーが正規機構、v2.0.91 確立済み） | S | 低 |
| 1-3 | **ゼロ参照 export 30 + dead default export 7 の整理**（検証済みリスト `tmp/export-xref.tsv` のみ対象）: ファイル内使用は `export` キーワードのみ除去、真の孤児（outreach-targets.ts:89-92 の trio、port-utils.ts:4 `isPortAvailable`、dashboard-lock.ts:64 等）は本体削除。**knip 生 133 件のうち残り ~103 は誤検知なので触らない** | M | 低 |
| 1-4 | **依存整理（安全分のみ）**: `npm uninstall -D @types/fs-extra`（メジャー不一致 v11 vs fs-extra v10、import ゼロ）。`scripts/dummy-form-server.cjs` 削除。`"demo:start": "tsx scripts/start-demo-dashboard.ts"` 追加。`bin/sales-claw-form-mcp.cjs` の dist-ts フォールバック候補 #2（どのビルドも生成しないパス）削除 | S | 低 |
| 1-5 | **ビルドステップ掃除**: `bundle-client-scripts.ts`（自己申告 no-op、esbuild の唯一の消費者）を `build` から外し esbuild devDep 削除。`postbuild-copy.ts` の v2.0.0 移行残滓を畳む。`eslint.config.mjs` の 3 重複 globals ブロックを `globals` パッケージで統合、誤記ラベルブロック修正、何にもマッチしない `src/list-builder/**/*.cjs` 等の glob 削除 | S | 低 |
| 1-6 | **歴史コメント整理（dashboard-server.ts を除く）**: 対象は form-session-manager.ts → routes/simple-api.ts（L165-176 の 12 行旧仕様ナレーション）→ form-mcp-dispatcher.ts ほか 159 件。**dashboard-server.ts の 166 件は churn #1 ファイルで機能開発・P3 移動 PR と三つ巴 conflict になるため、各抽出 PR の直前に対象領域のみ・同 PR 系列内の独立コミットで処理**（レビュー B-3）。規則: 「現在の不変条件と理由 (WHY)」は残す / 「旧挙動・実機 No.XXX・バージョン番号・真因修正チェーン」は削除（CHANGELOG.md 4,042 行に全記録あり）。**コメントのみの diff** に限定し `npm run build` + `test:unit` で検証 | M | 低 |
| 1-7 | **デッド設定キー `apiKeys.capSolver` 削除**: settings-manager.ts:244 / types/settings.ts:238 / sample-settings.json / JSDoc(:1127)。CAPTCHA 回避をしない明文ポリシーとも矛盾。deep-merge が未知キーを無視することを `settings-cache.test.cjs` で確認 | S | 低 |
| 1-8 | **CLAUDE.md 同期**: `.cjs`→`.ts`（25 箇所）、`C:\bp-outreach`→`C:\bp-outreach-ts`、`src/dashboard-server.cjs` 記述（L220）、アーキテクチャヘッダ v2.0.92→現行。バージョンピンは機能名表記へ。docs/ja/CLAUDE.md も同期。タブ管理契約の矛盾記述は 1-9 の**判断結果のみ**反映 | S | 低 |
| 1-9 | **【意思決定のみ — 実装は 3a 後続】タブ管理契約の矛盾解消**（レビュー A-6）: CLAUDE.md は「legacy tab contract は不要」と宣言する一方、`buildTabManagementContractLines()`（dashboard-server.ts:3701-3713）は internal モード含む全 Phase B プロンプトに無条件注入され、locale-pack ja:90 / en:79 は `finalFormTab` を必須要求し続けている（毎プロンプトのトークン課金）。**Phase 1 で行うのは選択肢の決定まで**: (a) `getFormFillMode()==='playwright'` でゲートし internal は 1 行のセッションルールに置換 / (b) CLAUDE.md 側を訂正。判断材料として「ダッシュボードが `details.finalFormTab` を読むか」（types/action-log.ts:23 にスキーマ存在）を確認。**実装は 3a のバイト一致抽出が完了した後、抽出済み純関数への独立 fix/feat コミット + ライブ Phase B 実走 1 回をゲートに実施**（Phase 1 で god module 内を変更すると golden 更新 → 3a 移動 → 再確認の二度手間と golden 二重再基準化が発生する）。盲目削除禁止 | S（判断のみ） | 低 |

### リリース単位
**独立リリース可**（patch bump 1 回にまとめる）。build + 全テスト green で足りる。

---

## Phase 2: 重複排除 / DRY — セキュリティドリフトの収束

### 目的
「同じロジックの複数コピーが別々に進化する」状態を止める。**SSRF ガード 5 実装の強度不一致**と **torn-write フォールバック 4 残存**は重複であると同時に実バグ/脆弱性クラスなので最優先。

### 完了の定義
- SSRF/private-IP 判定が `src/net-guard.ts` の 1 実装に収束し、バイパスペイロードのテストマトリクスが全呼出元をカバー。shadow モード 1 リリースで不一致 0 を確認済み。
- `copyFileSync` フォールバック付きローカル `writeJsonAtomic` が 0 件（grep で検証）。
- jscpd 重複率 1.53% → **1.0% 未満**。
- `runCliHeadless` / pierce-resolve 注入 JS が単一ソース化。

### タスク

| # | タスク | effort | risk |
|---|---|---|---|
| 2-1 | **【fix 兼デデュープ】atomicWriteJson 統一**: `recovery-store.ts:84-97` / `list-builder/run-manager.ts:72-89` / `list-builder/suppression.ts:171-186` / `target-list.ts:213-228` のローカル実装（fsync なし + EPERM 時 `copyFileSync` = file-lock.ts:153 が「torn write の元凶」と明記して撤廃したパターン）を `file-lock.atomicWriteJson` 呼出に置換。**recovery-store はクラッシュ復旧スナップショットそのもの**なので効果最大 | S | 低 |
| 2-2 | **`src/net-guard.ts` 新設（SSRF 単一ソース化）**: Family A（regex 一行判定: form-url-resolver.ts:6-33, parallel-analysis.ts:177-190/264-274, official-site-resolver.ts:135-146）/ Family B（http-client.ts:69-99 と target-list-validator.ts:30-64 の逐語コピー）/ Family C（最強実装: form-session-manager.ts:40-152 — 10 進/16 進リテラル、`::ffff:` hextet マップ、dns.lookup all:true 対応）を、**C の IP パース + B の net.isIP 検査**を採用した `isPrivateHost / isPrivateAddress / isSafeUrl / safeLookup` に統合。regex 系は `::ffff:` 16 進形等を現に取りこぼしている。バイパスペイロードのユニットテストマトリクス同梱。**移行期間は shadow モード 1 リリース**（旧判定と新判定の双方を評価し不一致を diagnostics に記録。SSRF は false-negative が致命的） | M | 中 |
| 2-3 | **`src/llm-cli-runner.ts` 抽出**: `llm-message-generator.ts:143-252` と `llm-site-analyzer.ts:225-352` に重複する runCliHeadless + hardKill + appendBuffer（~110 行×2、jscpd 実測 ~129 行一致）。既にドリフト発生（analyzer 側のみ `promptViaStdin` + pid ログ）。**env サニタイズと `--dangerously-skip-permissions` を含む spawn コード = 監査対象を 1 箇所に** | M | 中 |
| 2-4 | **`src/injected/pierce-resolve.ts` 抽出**: `form-mcp-dispatcher.ts:24-38` の `PIERCE_RESOLVE_SRC` と `form-session-manager.ts:948-962` のインライン resolve() はバイト一致。dispatcher 自身のコメント（:18-22）が「fillForm にだけ pierce があり click/type/select に無かった非対称」= **v2.1.0 の『入力できたが送信を押せない』回帰の真因**と記録している重複クラス。form-session-manager 内の 2 つの scan() 変種（L700-810 / L1085-1130）の shadow/iframe walker 共通化も可能なら同時に | M | 中 |
| 2-5 | **locale-pack 構造の単一化**: ① 逐語三重化したインターフェース群（ja/message-templates.ts:8-59 = en:7-58 = index.ts:46-93、計 ~190 行）を `src/locale-pack/types.ts` に集約。② `en/cli-prompts.ts:27-98` が ja の buildFormSelectionRule / buildBatchRules の分岐ロジック（tabs<=1 / isInternal / **autoSendSafe**）を再実装している状態を「ロジック 1 実装 + 言語別文字列テーブル」に変換。**0-9 ① の 8 パターン snapshot がこの統合の差分検知器**（autoSendSafe 分岐を必ず通過する）。文字列内容自体は正当なローカライズなので per-locale のまま | M | 低 |
| 2-6 | **`src/http-fetch.ts`（5 つの手書き GET ループ統合、~250 行）**: form-url-resolver.ts:35-70（300KB 上限）/ parallel-analysis.ts:326-371（500KB + gzip/br + 429/503 センチネル）/ official-site-resolver.ts:161+ / target-list-validator.ts:66-150 / extractor.ts:45-130。オプション `{timeoutMs, maxBytes, maxRedirects, headers, lookup, rateLimitSentinel}` で net-guard (2-2) の上に構築。**呼出元ごとの挙動差を保存しながら 1 つずつ移行** — ほぼ同一の extractor / target-list-validator から着手 | L | 中 |
| 2-7 | **message-builder footer 統合 + 422 文言の単一定数化**: `message-builder.ts:326-349` と `:454-477` の同一フッタ組立を `appendStandardFooter()` に。**:405 の urlMissing プレースホルダ直書きは locale-pack ja:106 `cliPlaceholder` と /api/log-action の 422 ガードが照合する文言の 3 箇所目** — 定数 import に置換し「プレースホルダ拒否の静かな破綻」を構造的に防ぐ。0-9 ④⑤ が照合文言を固定済みであることが前提 | S | 低 |
| 2-8 | **`src/html-utils.ts`**（escapeHtml ×4 / decodeHtml ×3 / stripTags ×2 のサーバ側統合。**HTML 文字列内に出荷される埋込クライアント側コピー（list-builder-page.ts:540, settings-redesign.ts:258）は対象外**）+ list-builder-api.ts の `isValidRunId+getRun` 404 前置き 4 重複を `withValidRun()` ラッパ化 | S | 低 |
| 2-9 | **MCP ツール validateArgs 共通化（CJS 維持）**: tools/ 配下 15 ツールの sessionId/selector ボイラープレート（click.cjs:21-32 等）に `requireSession/requireSelector` 共有ヘルパ。**CLAUDE.md の制約により CJS のまま** | S | 低 |

> 注: `action-logger.ts:221-241` の `notifyCliLog`（cli-logger.ts:42-58 の POST 再実装）は P4-9 で依存反転ごと処理するため**ここでは触らない**。dashboard-server.ts 内部の自己クローン ~120 行は P3 抽出時に機会的に畳む。

### 安全網
2-1: file-lock.test.cjs + 各ストア既存テスト（P0 で回収済みの list-builder テスト群）。2-2: 新設バイパスマトリクス + shadow モード + form-session-manager.test.cjs。2-3: llm 系の入出力固定テストを先に敷設。2-4: internal-mcp-integration.test.cjs + electron-real-form ランナー。2-5: 0-9 ① の 8 パターン snapshot。2-7: 0-9 ④⑤。

### リリース単位
**独立リリース可**。2-1 と 2-2 は fix/security としてそれぞれ単独早期リリース推奨。

---

## Phase 3: god module 分割（strangler-fig）

### 目的
`dashboard-server.ts` 12,531 行を責務別に解体し、「HTTP 配線 + 構成」シェルに縮小する。目標レイヤリング: `electron-main（構成ルート）→ dashboard-server（http+配線のみ）→ routes → services → data`。

### 完了の定義（数値化、レビュー B-4 反映）
- dashboard-server.ts **3,000 行以下**（最終目標 1,500、Phase 3 内ゲートは 3,000）。
- `buildPage()` 300 行以下、新規ファイルはすべて 600 行以下。
- managed-AI 状態のモジュールグローバルが **0**。
- **createServer コールバック ≤ 80 行 / インラインルートハンドラ 0 件**。
- characterization 一式（0-9 ①〜⑧）が全段階で green 維持。
- **新設モジュール全てにテスト同梱**（基本方針 5 / レビュー C-1）。c8 カバレッジ単調非減少。
- dashboard-server.ts のバージョンコメント 166 件が各抽出 PR で処理され、src 全体 ≤ 80 件。

### 抽出 PR テンプレート（3a で確立し以降全 PR に適用、レビュー C-5）

1. （前置き独立コミット）移動対象領域の歴史コメント整理（1-6 規則を適用）。
2. （move-only コミット）コードを移動。**移動前後で 0-9 の snapshot がバイト一致 + `git diff --color-moved` で 100% 移動判定**であることを PR チェックリストに明記。
3. （テストコミット）移動元 characterization の移送 or 新規ユニットテストを同 PR に同梱。
4. 挙動変更が必要な場合は**抽出完了後の別コミット（fix:/feat:）**として積む。抽出と変更の混在禁止。

### 段階（それぞれ独立 PR / 独立リリース）

#### 3a. プロンプトビルダー抽出 — 最初の PR（最低リスク・高価値・テンプレート確立）

| タスク | effort | risk |
|---|---|---|
| `buildClaudeFormFillPrompt`(L5926-6112, 186 行) / `buildManagedAiSessionContract`(L3715-3758) / `buildTabManagementContractLines`(L3701) / `buildCompactSenderPayload`(L3671) / `buildCompactApproachPayload`(L3694) / `compactMessageForPrompt`(L3621) / `summarizePhaseAAnalysisForPrompt`(L3775) / `extractPromptJsonLine`(L3760) を `src/ai-runtime/prompt-builder.ts` へ純関数（settings/provider/**autoSendSafe** を引数）として移動。**完了基準: 0-9 ① の 8 パターン snapshot がバイト一致 + `git diff --color-moved` 100% 移動判定**（レビュー C-5） | M | 低 |
| **3a-後続（独立 fix/feat コミット、レビュー A-6）**: 1-9 で決定したタブ契約変更を抽出済み純関数に対して実施。ゲート: snapshot の意図的更新を独立コミットで行い、**ライブ Phase B 実走 1 回**で検証 | S–M | 中 |

#### 3b. createServer シェルの純化

| タスク | effort | risk |
|---|---|---|
| L11994-12354 のコールバックから、静的配信（/screenshots/ パストラバーサルガード L12046-、/assets/ L12072、SSE /events L12029）を `src/routes/static-api.ts` へ、インライン ad-hoc 3 ルート（/api/managed-ai-batch/reset L12120、/api/companies/:no/status L12163、/api/phase-b-health L12206）を既存 dispatcher へ移設。**auth ゲート（L12003-12026 `isAuthorizedDashboardRequest`）はシェルに残し全ハンドラ前の実行順序を不変に**。前提: 1-1 のトラバーサル payload テスト + 0-9 ⑦ の SSE ミニテストが green（死んだ重複 /screenshots/ は P1-1 で削除済み）。完了基準: コールバック ≤ 80 行 / インラインハンドラ 0 | M | 中 |

#### 3c. buildPage() 解体（4,127 行 → ~150 行のシェル）

| タスク | effort | risk |
|---|---|---|
| 既存パターンの延長: 残存インライン `<script>` ブロック（L8382-9164 ≈782 行、L10746-11622 ≈876 行、L10606-10744、L10179-10203、L10482-10533 — 計 ~2,400 行）を `src/ui/client-scripts/*.ts` の `renderX()` へ（12 本の先行 renderer L71-85 と同形式）。サーバ注入値（`${_lang}`, `${_t[...]}`, セッショントークン）は明示的 ctx 引数化。タブ別マークアップ（L7909-7947 起点）を `src/ui/panels/*.ts` の `renderXPanel(ctx)` へ。**0-9 ③ の正規化済み HTML ハッシュが「出力不変」を保証**（正規化によりトークン・バージョンの実行毎差分では壊れない。意図的差分はハッシュ更新を独立コミットに）。script ブロック移設ごとにフルスイート実行 | L | 中 |

#### 3d. ManagedAiBatchEngine 抽出（最大リスク項目 — **3 段階**、レビュー B-1/B-2 反映）

| タスク | effort | risk |
|---|---|---|
| **前提テスト（Step 0 の前に green に）**: ① queueManagedAiPrompt / poller の state-machine テスト（現在 batch-utils 以外無テスト）、② 既存 recovery API テスト（/api/recovery/status・resume・discard）、③ **0-9 ⑧ の `snapshotManagedAiBatchesForRecovery` JSON 形状 golden**（クラッシュ復旧互換の差分検知器）。クラッシュ復旧の手動シナリオ 1 回（snapshot → 再起動 → Resume）をリリースチェックリスト化 | M | 低 |
| **Step 0（新設・完全挙動不変）**: モジュールグローバル ~35 個（state L171-194、定数 L359-405）を**単一 `const managedAiState = {...}` に機械的集約**。grep で「旧グローバル名の残存 0」を検証可能。diff は参照の付替えのみ | M | 低 |
| **Step 1（ファイル内クラス化）**: 関数クラスタ（createManagedAiBatchController L1141 / snapshotManagedAiBatchesForRecovery L1159 / scheduleManagedAiReadyTimer L1429 / flushManagedAiPromptQueue L1627 / queueManagedAiPrompt L1749 / startManagedAiBatchPoller L1774 / runPollerTickBody L1813 / dispatchNextManagedAiFormFillBatch L2074 / tryRecoverManagedAiSession L2155 + get/set/reset ヘルパ ~30）を**ファイル内で** `class ManagedAiBatchEngine` のメソッドへ畳む。**シングルトン生成はモジュールトップレベルの同位置で行い、モジュールロード時初期化のタイミング（poller `setInterval` / readyTimer / 5 分 watchdog / recovery コールバックの登録順）を不変に保つ**ことを明記。Step 0 により diff は概ね `this.` 付与とインデントに収まる | L | 中 |
| **Step 2（ファイル移動）**: クラスを `src/ai-runtime/managed-ai-batch-controller.ts` へ、PTY spawn/IO を `src/ai-runtime/managed-pty.ts`、定数を `managed-ai-config.ts` へ。dashboard-server はインスタンス 1 個を保持し thin getter を route dispatcher へ提供。**ctx のキー名・シグネチャは完全不変、中身だけ engine インスタンス委譲**（ctx の形状変更 = サービスオブジェクト化は 4-11 + 5-2 で一度だけ行う。同じ配線を二度触らない、レビュー B-2） | L | 高 |

リリース順序: Step 0 → Step 1 をリリース → **1 リリース実運用で寝かせる** → Step 2。各 Step は単独 revert 可能。

#### 3e. 周辺の oversized ファイル

| タスク | effort | risk |
|---|---|---|
| `routes/simple-api.ts`(1,310 行) 分割: `handleLogAction`(L348-692, 344 行) + ガード群を `src/routes/log-action-api.ts` へ（**ガード順序・文言は不変。0-4 で直した simple-api-p2 + 0-9 ⑤ の複合違反順序テストを移送**）、export 系(L846-1041, 195 行 + L908-1004 の 4 シート xlsx 組立) を `src/routes/export-api.ts` + サービスへ | M | 低 |
| `onboarding-wizard.ts`(1,403 行): インライン `<script>` L635-1393（758 行）→ `src/ui/client-scripts/onboarding-wizard.ts`、PRESET_STRENGTHS(L29)/TERMS_BULLETS(L61/L76) → `src/onboarding-constants.ts` | M | 低 |
| `i18n.ts`(1,941 行): translations(L4-1925) をドメイン別 `src/i18n/{dashboard,settings,onboarding,list-builder,common}.{ja,en}.ts` へ。公開面（`getTranslations`/`t`）不変。**ja/en キー集合一致のワンタイムテスト**をゲートに | M | 低 |
| `parallel-analysis.ts`(1,294 行): main(L627-1293, 667 行) を `parallel-analysis-cli.ts` へ、analyzeCompanyLite(L200-626, 427 行) のサブステップを `src/analysis/` へ。**`node dist-ts/src/parallel-analysis.js '{...}'` の JSON 引数形状は厳守**（Phase A の runtime 契約） | M | 低 |
| `electron-main.ts`(924 行): auto-update クラスタ（readAppUpdateConfig L145 / checkForUpdates L685-826 / scheduleTransientUpdateRetry L835 / writeUpdateStatus L672 等）を `src/electron/auto-updater.ts` へ。ステータス JSON 契約不変。最低優先 | S | 低 |
| `target-list.ts`(1,287 行/53 関数): companion record I/O（L242/L296）→ `src/target-list/companion-records.ts`、workbook cache（L111/L129）→ `workbook-cache.ts`。`settings-manager.ts`(1,253 行/37 getter) は**単一責務として現状維持** | L | 中 |

#### 3-前提（並行トラック — P0 完了直後から開始可）: require → import コードモッド

| タスク | effort | risk |
|---|---|---|
| .ts ファイル内 require() **313 行**を ES import へ（tsc 出力は CJS のままなので emit 不変）。**スコープに「`module.exports` + ESM export の二重公開 60 件の一本化」を含める**（レビュー C-2）。葉のサービスから bottom-up、dashboard-server.ts 本体は各抽出 PR 内で変換。`src/mcp-servers/` と `bin/` の .cjs は CLAUDE.md 制約で対象外。意図的 lazy require は `// lazy:` コメントで明示して残す。**完了時タスク: madge 循環チェックを CI でブロッキング化**（レビュー A-5。現在の「循環 0」は require 主体のため未確定の主張であり、P3 の抽出は循環を新規に作り得る）。完了後 knip/ts-prune の出力が初めて信頼可能になる（現状 129 中 ~107 ファイルが偽 orphan 判定） | L | 低 |

### 安全網
0-9 一式（①プロンプト 8 パターン / ③正規化 HTML ハッシュ / ⑤複合順序込み 422 / ⑥approve・submit / ⑦SSE / ⑧recovery 形状）+ P0 回収テスト群 + E2E + 3d 前提テスト。

### リリース単位 / 想定工数
3a〜3e はそれぞれ独立リリース可。3d のみ Step 1 → 1 リリース → Step 2 の構成必須。
3a: 2-3 / 3b: 2-3 / 3c: 4-6 / 3d: 9-13（Step 0 追加分込み）/ 3e: 5-8 / コードモッド: 2-3 人日。

---

## Phase 4: データ層・アーキテクチャ是正

### 目的
11 個の自前ストアを共通 store 層に載せ、2,000 社バッチで露呈する action-log の性能・正確性の壁、保持/ローテーションの欠落、レイヤリング違反を解消する。

### 完了の定義
- read-cache/quarantine/.bak/atomic-write のコピペブロック 0（`src/json-store.ts` 経由のみ）。
- 2,000 社シミュレーション（10-14k entries）で awaiting_approval 企業の証跡（form_fill / screenshot 参照 / sentMessage）が**消えない**ことをテストで証明。
- スクリーンショット / ai-prompts / metrics に保持・ローテポリシーが存在し設定可能。
- データ層からの上方依存（action-logger → HTTP）0。
- settings.json に `_schemaVersion` とマイグレーション配列。
- **form-session-manager の空 catch 22 箇所が可視化済み**（6-1 から前倒し、レビュー C-3）。

### タスク

| # | タスク | effort | risk |
|---|---|---|---|
| 4-1 | **`src/json-store.ts` 抽出**: mtime+size signature cache + corrupt quarantine(.corrupt.<ts>) + .bak 復元 + atomicWriteJson の 4 コピペ（action-logger.ts:128-197 / contact-history.ts:88-164 / live-monitor.ts:154-238 / settings-manager.ts:294-366、ドリフト例: settings のみ `.backup`）を `readCached/writeAtomic/withLock/quarantineCorrupt` に統合。**1 モジュールずつ移行**（各々既存テストあり）。`routes/simple-api.ts:867` の contact-history.json 生 fs 読み（キャッシュ・ロック迂回）をモジュール経由に修正。action-logger.ts:21 の休眠 `getSqliteAdapter()` スタブがこの層の差込点 | M | 低 |
| 4-2 | **action-log の JSONL 化 + 企業単位保持**: 現状 saveLog(action-logger.ts:212-219) は全量 stringify + 10,000 件トリム → 2,000 社×5-7 actions で **(a) フラッシュ毎に 10-25MB をメインスレッドで直列化、(b) 先行企業の form_fill/awaiting_approval が黙って消え、approval-artifacts.ts:355 / simple-api.ts:874-880 のスクリーンショット・sentMessage 解決が壊れる**。対策: ① logAction を log-writer.ts 経由の 1 行 append（action-log.jsonl）② 起動時インメモリ index 構築 ③ 起動/終了時スナップショット compaction ④ 件数トリムを「awaiting_approval 中の企業は全保持、確定済みのみ経過日数 aging」に置換。**ロールバック面（レビュー A-7）: 切替後 1 リリースは dual-write（json + jsonl）を維持し、かつ jsonl→json 逆変換スクリプトをリリースに同梱**。本計画のロールバック原則は「revert を含む前進リリース」— 前方互換（新コードが旧 json を読む）だけでは revert 後の旧コードが .jsonl を読めず承認待ち証跡が空に見えるため、両方必須。SQLite(better-sqlite3) は store 層安定 + 500 社超バッチ常態化後のオプションとして温存 | L | 中 |
| 4-3 | **【fix】クロスプロセス lost-update 修正**: `flushNow`(action-logger.ts:62-93) はロック下で再読込せずメモリ配列を全書き（:268-270 に誤った前提コメント）。Phase A サブプロセス（parallel-analysis.ts:696/764/914/961/995/1158/1247 が直接 logAction）と本体が相互上書きし得る。**最安修正**: Phase A ワーカーのログを既存 `POST /api/log-action` 経由（単一ライタープロセス）に切替 — CLI に 1.2.91 から課している規則と同型。**実施前提の検証 2 点（レビュー B-5）**: ① ワーカープロセス env に `SALES_CLAW_SESSION` / `SALES_CLAW_DASHBOARD_URL` が伝播していることの確認、② failure mode 変更（直接書込ならサーバ停止時も残る → HTTP なら失われる）への対処として**ローカル fallback append（送達失敗時にワーカー側 spool ファイルへ退避 → 本体起動時に回収）**を同時実装。fix ラベル + 専用テスト（合成 2 プロセス並走）。直接書込が残る場合は flushNow でロック下再読込 + (timestamp, companyNo, action) マージ | M | 中 |
| 4-4 | **【fix】contact-history のロックタイムアウト時サイレントドロップ修正**: recordContact(:180-183)/recordResponse(:271-274)/removeHistory(:300-303) が 0 を返して書込を恒久喪失（並列バッチ＝ロック競合時こそ発生）。action-logger 同様の dirty-flag + 遅延リトライ、または approve-api へ失敗を表面化。contact-history.test.cjs 拡張 | S | 低 |
| 4-5 | **保持ポリシー**: ① スクリーンショット GC — 起動時クリーンアップ（dashboard-server.ts:12424 の cleanupOldRuns(30) 隣）に「最新アクションが submitted/skipped/error かつ N 日超の `ss-{No}-*.png` を削除（既定 30 日、設定公開）。**awaiting_approval 企業は絶対に削除しない**」（現状 251 files/67MB、2,000 社で 1.5-2.2GB 見込み）。② startup-cleanup.ts に `ai-prompts/*.md`（7 日超）追加 | S | 低 |
| 4-6 | **ai-run-metrics ローテーションとコスト集計の整合**: log-writer.ts:110-114 は旧 .1 を unlink（最大 2 世代）、cost-estimator.summarize(:103-119) は現行ファイルしか読まない → 月中ローテで「今月コスト」が黙ってリセット。日付サフィックス回転（ai-run-metrics-YYYY-MM.jsonl）or 世代数設定化 + summarize の回転ファイル走査 | S | 低 |
| 4-7 | **スキーマバージョン + マイグレーション基盤**: settings.json に `_schemaVersion` と load() 内の順序付き純関数マイグレーション配列（analysis-cache.ts:58/156 が唯一の先行例）。4 ファイルフォールバックチェーン（:461-464）と二重書込（:510-513）の勝敗規則を文書化。**「バージョンフィールド導入」と「フォーマット変更(4-2)」は別リリース必須**（先にバージョン、次にフォーマット） | M | 中 |
| 4-8 | **【perf/fix】キャッシュ無効化を fs.watch(mtime) から直接呼出へ**: logAction / recordContact / updateLiveMonitor が `invalidateDashboardDataCache()`（settings-api.ts:76 に export 済み）を直接呼ぶ。現状フラッシュ 500ms + watch + 250ms debounce ≈ 750ms+ のドリフト窓（Windows の fs.watch はベストエフォート）。fs.watch は外部編集専用に格下げ。**レイテンシ窓を変える挙動改善なので refactor ではなく perf/fix としてコミット分離**（レビュー B-5） | M | 中 |
| 4-9 | **action-logger の上方依存反転**: action-logger.ts:6,221-241 が http + dashboard-runtime を import し /api/cli-log へ POST（cli-logger.ts:42-58 の重複でもある）。注入コールバック/EventEmitter に置換（dashboard-server 内は in-process、CLI サブプロセスのみ HTTP poster）。データ層唯一の上向きエッジが消え、action-logger が無サーバでテスト可能に | S | 低 |
| 4-10 | **form-mcp-dispatcher の契約を公開 API に**: form-mcp-dispatcher.ts:40-60 の `FormSessionManagerLike` が `_sessions` / `_activeSessionId` / `_waitForLoad` という**アンダースコア私有内部を構造的契約**にしている（ABSOLUTE RULE 経路で、内部リファクタがコンパイル green のままランタイム破壊し得る）。FormSessionManager に `listSessions()/getSession(id)/setActiveSession(id)/waitForLoad(id)` を公開し、typed import（コードモッド到達後）でコンパイラに境界を守らせる | M | 中 |
| 4-11 | **route ctx をサービスオブジェクト化（3d Step 2 完了後・5-2 と同時実施）**: ctx の 10-25 個の状態覗き見クロージャ（getAiFormFillApiDispatch L11768 の ~20 エントリ、インライン 14 行ミューテータ L11794-11808 等）を `{ managedAiService, formSessionManager, settings }` のサービス渡しに置換。simple-api.ts:29-33 / settings-api.ts:29-45 の「ctx と直接 require の二重チャネル」を一本化。**ctx の形状変更はここで一度だけ**（3d Step 2 はキー名不変の委譲のみ、レビュー B-2）。typed `RouteContext`（5-2）と同一 PR 系列で | L | 中 |
| 4-12 | **【前倒し】form-session-manager の空 catch 22 箇所の可視化**（レビュー C-3。6-1 から移動）: 計画自身が「2,000 社バッチの CDP detach 失敗が現在不可視」と認めており、4-2/4-5 の 2,000 社対応と同時に観測可能性を確保しないと矛盾。`bestEffort(label, fn)` ヘルパを先行導入し form-session-manager 分のみ適用。**bestEffort はレート制限 or debug レベル**（CDP ループでのログ洪水防止）を仕様に含める。残り 203 箇所は 6-1 | S | 低 |

### 安全網
各ストア既存テスト + 4-2 用「2,000 社合成ログでの証跡保全テスト」新設 + 0-9 ⑧ の recovery 形状 golden。4-3 は合成 2 プロセス並走テスト。リリース前に実機 1 バッチ（3 社）の手動チェックリスト。

### リリース単位
項目単位で独立リリース可。**4-7（バージョンフィールド）→ 4-2（フォーマット変更、dual-write 付き）→ dual-write 解除、の 3 リリース構成必須**。

---

## Phase 5: 型安全の段階導入

### 目的
`any` 946 / noImplicitAny 潜在エラー 1,175 を、境界（HTTP body / settings.json / xlsx / MCP pipe）からの検証導入と既存型資産の配線で段階的に削減し、最終的に `noImplicitAny: true` を点灯する。dashboard-server.ts（any 307 / 暗黙 253）が長い棒なので P3 の解体と歩調を合わせる。

### 完了の定義
- `useUnknownInCatchVariables: true` 点灯。
- zod（または ajv）が境界 4 種に導入され、**各エンドポイントが shadow → enforce の 2 段階を経由済み**（レビュー A-4）。/api/log-action は **422 セマンティクス（文言・順序・閾値）の完全保持を 0-9 ⑤ の複合違反順序テストで証明**。
- settings-manager.load() の戻り型が `Settings`（types/settings.ts 302 行を検証付きで採用）。
- `types/helpers.ts` の importer 0 → 実使用、`ActionLogEntry` importer 1 → log-action/recovery 経路で採用。
- CI の any カウントラチェット（debt-metrics）が単調減少を強制し、dashboard-server 残骸の暗黙エラー < 50 で `noImplicitAny: true` を flip。

### タスク

| # | タスク | effort | risk |
|---|---|---|---|
| 5-1 | **`useUnknownInCatchVariables: true`** + `types/helpers.ts` に `getErrorMessage(e: unknown)/getErrorCode(e: unknown)` を追加し、catch 内プロパティ参照 ~25-40 箇所（例: dashboard-server.ts:5546-5547 `(error as any)?.code`、`catch (e: any)` 23 箇所）を修正。最安の strictness。今週でも着地可 | S | 低 |
| 5-2 | **`RouteHandler` / typed `RouteContext` 定義**: `(req, res, requestUrl?) => Promise<void>` + JSDoc のみだった ctx（form-session-api.ts:36-40）の interface 化。9/12 route ファイルの bare `(req, res)` を撃ち、**TS7006 約 300 件が一括消滅**。**4-11 のサービス ctx と同一 PR 系列で一度だけ**実施 | M | 低 |
| 5-3 | **【feat — behavior-preserving ではない】zod 導入 + `parseValidatedBody<T>(req, schema)`**（レビュー A-4）: 現状の `parseJsonBody` 61 箇所は未検証＝不正形ボディでも通るため、strict スキーマは「以前 200/500 だったリクエストが 400 になる」**挙動変更**。各エンドポイントで **(a) warn-only shadow validation（不一致を diagnostics に記録、1 リリース）→ (b) enforce** の 2 段階を必須化（2-2 net-guard の shadow と同じ規律）。優先順: ① /api/log-action — 手書きガード（simple-api.ts:348-430、P3e 後は log-action-api.ts）を置換する際、**422 の文言・順序・閾値（30 字、プレースホルダ照合、screenshot 存在）を 0-9 ⑤（複合違反の発火順序ケース込み）でバイト一致保証** ② /api/settings ③ /api/form-session/* ④ /api/ai-form-fill。61 箇所 ≈ 3-5 日 | L | 中 |
| 5-4 | **settings.json 検証**: types/settings.ts から zod スキーマを節単位で起こし、load() 内で `Result<Settings, string[]>` 検証 → 戻り型を `Settings` に。37 getter が実型を継承し、ファイル内 18 any + 下流の数十 any が連鎖的に消える。4-7 のマイグレーション基盤と同じ load() フックを共用。導入時は warn-only から | M | 中 |
| 5-5 | **xlsx 取込パイプラインの型付け**: target-list.ts（any 44 / 暗黙 74）。`sheet_to_json`(L458) の戻りを `RawSheetRow`、normalize の戻りを `TargetCompany[]`（types/target.ts は既存、importer 1）、ユーザー投入 Excel/CSV（オンボーディング Step4 = 真の untrusted input）に zod RowSchema。L1213/L1224 の `any[]` merge/upsert が無償で型チェックに | M | 中 |
| 5-6 | **MCP dispatcher の 15 個の `as unknown as XParams` を実検証に**: form-mcp-dispatcher.ts:102-476。.cjs ツール群が既に宣言している JSON Schema `inputSchema`（navigate.cjs:11 等）を ajv でコンパイルする `validateParams(schema, req.params)` 1 個で置換 → **Named Pipe 越しの信頼ギャップも同時に閉じる**。.cjs 側の手書き validateArgs は重複として削除可（2-9 と整合）。半日 | S | 低 |
| 5-7 | **既存型資産の配線**: helpers.ts(270 行, importer 0) のガードを触ったファイルから採用 / ActionLogEntry を log-action-api + recovery-api(:144-149 `(log as any).companyNo`) に / LiveMonitorEntry を live-monitor に / form-session-manager のクラスフィールド（:390-396 `_getMainWindow: any` 等）に deps interface（**SSRF ガード保持ファイルなので誤型のコストが高い**）。dashboard-server の 12 renderer shim は `(...a: Parameters<typeof renderX>) => string` で即日修正可 | M | 低 |
| 5-8 | **noImplicitAny ラチェット → flip**: tsc に per-dir override が無いため、CI で debt-metrics の any/暗黙エラー数の単調減少をゲート化（roadmap のベースライン 949(2026-05-14) → 現在 946 と停滞中＝ラチェット無しでは減らない実証済み）。leaf から修正（electron-main.ts / cdp-bridge.ts は any 0）。dashboard-server 残骸 < 50 エラーで flip。`strictPropertyInitialization` は 5-7 の form-session-manager 型付け後に | XL（分割消化） | 低 |

### 安全網
tsc 自体が安全網（型のみの変更は emit 不変）。5-3/5-4 はランタイム挙動（拒否レスポンス）に触れる feat であり、shadow 段階の diagnostics 観測 + 0-9 ⑤⑥ + 各 API のレスポンス characterization（正常系/異常系を先に固定）を必須ゲートに。

### リリース単位
項目単位で独立リリース可。5-3 は各エンドポイント × (shadow / enforce) の単位で個別リリース。

---

## Phase 6: 仕上げ — 一貫性・運用品質

### 目的
envelope/エラー処理/ロギング/i18n/定数/命名/配布物の一貫性を整え、リファクタ後の規約を CLAUDE.md に固定して再発を防ぐ。

### 完了の定義
- 空 catch 0（ESLint `no-empty` allowEmptyCatch:false が error 化、`bestEffort(label, fn)` 経由 or 理由コメント必須）。
- 非 2xx レスポンスが全て `{ ok:false, error, code? }`（bare `{error}` 14 箇所 = approve-api.ts:92,109,126,151,254 / simple-api 3 / settings-api 5 が解消）。
- route のユーザー向け日本語直書き 28 箇所が i18n キー化、クライアント翻訳ヘルパ 5 系統（t/aw2T/pgnT/sent2T/set2T）が 1 つに。
- ポート 3765 直書き 0（7 ファイル → `DEFAULT_DASHBOARD_PORT`）、無名ボディ上限 0。
- `npm run verify:dist` 通過 + インストーラサイズ削減が計測されている。

### タスク

| # | タスク | effort | risk |
|---|---|---|---|
| 6-1 | **空 catch の残り 203 箇所の段階解消**（form-session-manager の 22 箇所は 4-12 で前倒し済み）: `bestEffort(label, fn)`（log-writer 経由 debug ログ、**レート制限 or debug レベル必須** — レビュー C-3）をホットスポット順（dashboard-server 68 → cli-terminal.ts 28 → parallel-dispatcher 10）に機械置換。真の fire-and-forget は `catch { /* best-effort: view may already be destroyed */ }` 形式の理由コメント必須。最後に lint を error 化 | L | 低 |
| 6-2 | **エラー envelope 正規化**（エラー側のみ。成功側の `{ok, summary}` 等は CLAUDE.md 記載の準契約なので**変えない**。「ok + 名前付きペイロードキー、data ラッパなし」を規約として CLAUDE.md に明文化）。`jsonResponse` が status>=400 で ok:false 自動注入。**着手前にクライアント consumer 棚卸し**（ui/client-scripts/* が `err.error` を ok なしで読む箇所） | M | 中 |
| 6-3 | **i18n 貫通**: ctx 経由 `i18nT` + `getUiLang`（approve-api が実証済みパターン）を残り 11 route へ、直書き 28 箇所（ai-form-fill-api.ts:185、ai-submit-final-api.ts:131-257、form-session-api.ts:61/276/366、onboarding-api.ts:145-155 等）を `api.*` キーへ。クライアントは共有 `t(key, fallback, params)` 1 本に統合、cli-terminal.ts:547/993-997・dashboard-analytics.ts:431-522 の直書き DOM 文字列をキー化 | L | 低 |
| 6-4 | **ロギングファサード**: console.* 106 箇所（dashboard-server 46）を log-writer ラッパ（レベル + dev 時 console ミラー）へ。チャネルポリシー 1 ページ（diagnostics → appendDiagnosticEvent / CLI 活動 → cli-logger / 運用警告 → logger.warn）。approve-api.ts:107/123/149 の structured イベントとの二重ログ削除。起動バナー（dashboard-server:685/802/12452-12457）は意図的 CLI 出力として最後に | M | 低 |
| 6-5 | **`src/config-limits.ts`**: `DEFAULT_DASHBOARD_PORT`（3765 直書き 7 ファイル: cli-logger.ts:25, port-utils.ts:22, settings-manager.ts:179/897, dashboard-runtime, dashboard-server ×3, ai-submit-final-api, ui/client-scripts/dashboard）、ボディ上限ファミリ（**値の相違は用途別に正当 — 無名なのが問題**: simple-api.ts:356 の `16*1024`、:1289 の `256*1024` を最優先で命名）、タイムアウト階層、dashboard-server.ts:2011 にロジック埋没した `15*60*1000` ストール窓 | M | 低 |
| 6-6 | **アクション定数**: `src/types/action-log.ts` に `ACTIONS` as const + `ALLOWED_ACTIONS` を export（ActionType は typeof 導出）、log-action-api の Set(:349 由来) を import に。'awaiting_approval' リテラル 52 箇所は機会的移行で可 | S | 低 |
| 6-7 | **命名是正**: `recovery-api.ts` → `crash-recovery-api.ts`（error-recovery-api.ts とのニアコリジョン解消、require 元は dashboard-server のみ＝2-3 行変更、docs/CLAUDE.md grep 先行）。MCP tools/ の snake_case ファイル名は**ワイヤプロトコル名ミラーとして維持** + README 1 行 | S | 中 |
| 6-8 | **インストーラ軽量化（~65MB）**: per-platform excludes（node-pty の win32-arm64 28MB / darwin-* — win target は x64 のみ）、`!**/*.js.map`・`!src/**/*.ts`（**`src/**/*.cjs` は bin shim が server.cjs を解決するため除外しない**）、playwright-core 二重（top 1.59.1 + @playwright/mcp nested 1.60.0-alpha、12MB×2）のバージョン整合 dedupe。**ゲート: `npm run dist:win -- --publish never` → `verify:dist` → `install:win` スモーク（フォーム入力 1 件実走）**。意思決定キューの fs-extra/universalify 削除検証と同じパッケージング検証に相乗り | M | 中 |
| 6-9 | **legacy 互換面に除去ポリシー付与**: ai-runtime-api.ts:12-16 の `/api/*-claude*` エイリアス、compliance.ts:130-159 の legacy boolean API、settings-manager.ts:394 の readLegacyClaudeModel に「remove after vX」コメント。恒久化防止 | S | 低 |

### リリース単位
項目単位で独立リリース可。6-8 はリリースパイプライン検証込みで単独リリース必須。

---

## 横断テーマ

### Behavior-preservation の担保

1. **Characterization / golden テスト**（P0-9 で敷設、**正規化付き**）: プロンプト 8 パターン snapshot・正規化済み buildPage HTML ハッシュ・loadData・複合順序込み 422 ガード・message-builder snapshot・approve/submit ユニット・SSE・recovery 形状。golden が変わったら「意図的差分の独立コミット + 理由」を必須化。**正規化関数自体もテストされていること**（壊れた正規化は偽の green を出す）。
2. **Strangler-fig + 抽出 PR テンプレート**: 既成功 2 パターン（routes DI 11 本 / renderer 12 本）の延長のみ。3a で確立する「snapshot バイト一致 + `git diff --color-moved` 100% 移動判定 + テスト同梱」を全抽出 PR の完了基準に。
3. **抽出モジュールはテスト同梱必須**（レビュー C-1）: 移動元 characterization の移送 or 新規ユニットテストを同 PR に。c8 カバレッジは debt-metrics ラチェットで単調非減少。
4. **機械的変換の分離**: 「移動だけ」「リネームだけ」「`this.` 付与だけ」のコミットとロジック変更コミットを絶対に混ぜない（3d Step 0/1/2 が典型）。
5. **Shadow モードの一貫適用**: 判定・検証ロジックを差し替える変更（2-2 net-guard、5-3/5-4 zod）は「旧新並走 + 不一致を diagnostics 記録 + 1 リリース観測 → enforce」を必須とする（レビュー A-4 により 5-3 にも非対称なく適用）。
6. **Feature flag**: 既存の `formFill.mode` が前例。4-2 は `preferences.actionLogFormat` + dual-write で運用。
7. **CI ラチェット**: debt-metrics（any / 暗黙エラー / 空 catch / 重複率 / 行数 / **カバレッジ**）の単調非増加（カバレッジは非減少）チェック。any 数が 1 ヶ月で 949→946 しか動かなかった事実が、ラチェット無しでは戻ることの証明。

### ロールバック戦略

- **push = 自動リリース**のため、ロールバック = `git revert` を main へ push（新バージョンとして配布）が一次手段。electron-updater はダウングレード配布が不安定なため「revert を含む前進リリース」を原則とする。
- 各 PR は **1 PR = 1 関心事 = revert 可能単位**。3d は Step 分割で revert 面を最小化。
- **データフォーマット変更（4-2/4-7）は 3 点セット**: ①前方互換 1 リリース（新コードが旧形式を読める）、②**dual-write 1 リリース（revert 後の旧コードも最新データを読める）**、③**逆変換スクリプト（jsonl→json）をリリース同梱**（レビュー A-7。前方互換だけではアップグレードしか守れず、revert 後に承認待ち証跡が空に見える事故を防げない）。
- リリースごとに `verify:release` → `dist:win -- --publish never` → `verify:dist` → push → `verify:github` の既存ゲートを省略しない。

---

## クイックウィン表（最初の 1-2 日）

| # | 項目 | 効果 | 工数 | リスク |
|---|---|---|---|---|
| 1 | managed-pty-viewer spawn 修正（dashboard-server.ts:6792 → 存在しない .cjs） | **壊れている機能の復旧**（2 エンドポイント常時 throw） | S | 低 |
| 2 | xlsx を版固定 tarball に（`xlsx-latest.tgz` 廃止、`package.json:80`） | `npm ci` 全停止の時限爆弾解除（vendor/ミラー化は意思決定キューへ） | S | 低 |
| 3 | test:unit グロブ化 + 合格孤児 13 本回収 | **+5,200 行の無料カバレッジ**（form-session-manager / cdp-bridge / MCP 統合 / list-builder 8 本）。孤児再蓄積の構造問題を根治 | S | 低 |
| 4 | atomicWriteJson 4 ファイル置換（recovery-store / run-manager / suppression / target-list） | **torn-write バグ修正**。クラッシュ復旧スナップショットの信頼性回復 | S | 低 |
| 5 | typecheck:tests ブロッキング化 + tsconfig.scripts.json | リリースゲート自身（verify-release-readiness.ts 498 行）に型検査。#1 と同クラスの再発防止 | S | 低 |
| 6 | 死んだ重複 /screenshots/ ブロック削除（L12093-12113）+ トラバーサル payload テスト（`..%2f` / 絶対パス / UNC） | 「直したつもりが死にコード」事故の予防 + セキュリティガードの移設前固定 | S | 低 |
| 7 | `_positionView` + tombstone コメント削除、`onWindowResize` チェーン 3 点セット削除 | 死蔵コード除去（後者は単体削除するとビルド破壊、の罠を文書化込みで解消） | S | 低 |
| 8 | `npm uninstall -D @types/fs-extra`、src/config.ts・types/index.ts・types/runtime.ts 削除 | 確定デッド ~110 行 + 依存 1 件 | S | 低 |
| 9 | knip.json + ツール CI 常設 + debt-metrics ベースライン | 以降の全フェーズの進捗が数字で見える（unused-files ≤ 30 件 + 理由アノテーション） | S-M | 低 |
| 10 | useUnknownInCatchVariables: true + getErrorMessage ヘルパ | 最安の strictness 向上（~25-40 箇所修正） | S | 低 |

---

## リスクと非ゴール

### やらないこと（非ゴール）

- **Big-bang 書き換え禁止**。dashboard-server.ts の一括リライト、フレームワーク（Express/Fastify 等）導入、フロントエンドフレームワーク化はしない。テンプレートリテラル + renderer 関数の現行方式を維持。
- **`src/mcp-servers/**` と `bin/sales-claw-form-mcp.cjs` の CJS は維持**（Claude CLI の MCP ランタイム要件、CLAUDE.md 明記）。ESM 化対象から恒久除外。tools/ の snake_case ファイル名もワイヤプロトコル準拠として維持。
- **`formFill.mode='playwright'/'both'` 分岐は削除しない**（文書化された rollback フラグ）。削除対象になり得るのは parallel-dispatcher 経路のみで、それも意思決定キュー通過後。
- **dist-ts コンパイル出力をテストする方式は維持**（出荷物をテストする利点）。改善はスタンプ検証と indirection まで。
- **SQLite への移行は本計画のスコープ外**。4-2 の JSONL + store 層で 2,000 社まで持たせ、`getSqliteAdapter()` シームだけ温存。
- **成功レスポンスのペイロードキー形状は変えない**（CLAUDE.md 記載の準契約。変えるのはエラー側の正規化のみ）。
- **settings-manager.ts の公開面（37 getter）は分割しない**（blast radius が大きく、単一責務として凝集）。
- **422 ガードの順序・閾値・照合文言の変更禁止**。zod 化(5-3) も「同一セマンティクスの再表現」であることを複合違反順序テスト（0-9 ⑤）で証明する。

### 主要リスクと緩和

| リスク | 緩和 |
|---|---|
| 3d（ManagedAiBatchEngine）が最高リスク: 35 グローバルがリクエストハンドラ・poller タイマ・recovery コールバックから読み書きされる | **Step 0（状態の単一オブジェクト集約、grep 検証可能）→ Step 1（ファイル内クラス化、シングルトン初期化位置・タイミング不変）→ 1 リリース実運用 → Step 2（移動、ctx キー名不変）**の 3 段。前提テスト（state-machine + recovery API + **recovery スナップショット JSON 形状 golden**）を事前に green。クラッシュ復旧の手動シナリオをリリースチェックリスト化 |
| golden の形骸化（トークン・バージョン・electron 分岐による非決定出力で初回リリースから red） | **ハッシュ前正規化を 0-9 の仕様として実装し、正規化関数自体をテスト**（L10610/L10641 token、L7565/L11672 APP_VERSION、L10643 electron 分岐、絶対パス）。プロンプトは固定 env + パス正規化 |
| auto-send フローの無防備（autoSendSafe 分岐を 2-5/3a/3d 全てが通過するのに既定 OFF 側が固定されない） | 0-9 ① のマトリクスを **autoSendSafe×{true,false} × tabs×{1,3} × mode×{internal,playwright} = 8 パターン**と明示 |
| approve→submit 経路が E2E 1 本のみで、flaky 化した瞬間に 3b/3d/4-11 が無防備で触る | 0-9 ⑥ で `/api/approve` 判定 + `/api/ai-submit-final` enqueue + 新規 session での承認済み本文再入力契約を**ユニットレベル**でも固定 |
| E2E CI が「赤いまま無視される CI」になる | non-blocking 2 週間 → flaky 隔離 → blocking 昇格の段階導入（0-6） |
| churn 衝突: dashboard-server.ts は 6 ヶ月で 70 回変更される現役機能開発の主戦場 | 各抽出 PR を 1-3 日で閉じる粒度に分割。長期ブランチ禁止。**dashboard-server の歴史コメント整理 166 件は各抽出 PR に同乗**させ三つ巴 conflict を回避（Phase 1 では触らない）。機能開発と同週に同領域を触らないよう着手前に調整 |
| ツールの誤検知に基づく誤削除（knip 生出力の ~70% が偽陽性、runtime require / spawn 契約が静的に見えない） | 削除は「監査で検証済みのリスト（tmp/export-xref.tsv 等）」のみ。runtime 契約（`require('./dist-ts/src/company-analyzer')` 等 CLAUDE.md 指示の動的経路）を knip.json entry に明示してから判断。**Phase 1 の完了基準は knip ではなく検証済みリスト消化 100%** |
| 循環依存の見落とし（madge「循環 0」は require 主体のため未確定の主張） | コードモッド完了時に madge 循環チェックを**ブロッキング化**。P3 の抽出が循環を新規に作らないことを CI が保証 |
| プロンプト契約の破壊（タブ契約 / 422 文言 / Phase A JSON 引数形状） | characterization + プロンプト変更はライブ Phase B 実走 1 回を必須ゲートに。**タブ契約変更は 3a 抽出完了後の独立 fix/feat コミットに限定**（Phase 1 では意思決定のみ — golden 二重再基準化の防止） |
| zod 化による意図しない拒否（以前 200/500 だったリクエストが 400 に） | **5-3 は behavior-preserving ではないと明記**し、各エンドポイントで warn-only shadow 1 リリース → enforce の 2 段階を必須化 |
| Phase A ワーカーの HTTP ログ切替（4-3）による failure mode 悪化 | 実施前に env 伝播（`SALES_CLAW_SESSION`/`SALES_CLAW_DASHBOARD_URL`）を検証。サーバ停止時のローカル fallback append（spool → 起動時回収）を同時実装。fix ラベル + 専用テスト |
| パッケージング回帰（6-8、fs-extra ピン削除） | `verify:dist` + `install:win` 実機スモーク（フォーム入力 1 件）を必須。electron-builder.yml に `local-test`/`${env.GH_*}` を戻さない（CLAUDE.md ゲート 10） |
| データ移行の片道事故（4-2/4-7） | バージョンフィールド先行 → フォーマット変更 → dual-write 解除の 3 リリース構成。**dual-write 1 リリース + jsonl→json 逆変換スクリプト同梱**で revert 耐性を確保。旧形式読込テスト維持 |
| 「修正」に見せかけた挙動変更の混入 | 挙動変更項目（0-1, 2-1, 2-2 強度統一, 3a-後続, 4-3, 4-4, 4-8, 5-3 enforce）は **fix:/feat:/perf: コミットとして分離**し、refactor: コミットには golden 不変を要求（conventional commits 規約に整合） |

### 意思決定が必要な項目（オーナー判断待ち・Phase 1 で起票）

1. **EDINET client（217 行）** — orchestrator.ts に配線ゼロ、`edinetData` を生産するコードが存在しないのに enrichers は消費を待ち、settings/docs はユーザーに API キーを宣伝中。「完成させて配線」or「client + settings 面 + doc 主張を一括削除」。
2. **legacy Phase B 並列経路（~600 行）** — parallel-dispatcher.ts + parallel-form-fill-api.ts。UI は意図的に呼ばない（ui/client-scripts/dashboard.ts:18）。v2.0.71 以降の rollback 需要有無。`formFill.mode` 分岐は残す。
3. **fs-extra / universalify 直接ピン** — 削除には verify-release-readiness.ts:19-25 の同時編集 + フルパッケージング検証（`dist:win -- --publish never` + `verify:dist`）が必須。検証コスト次第で「意図的ピンであるコメント追加」で済ませてよい。
4. **xterm 系 devDeps 5 個** — 唯一の消費者 build-assets.ts はどの npm script からも呼ばれない。`"assets:build"` 配線 / @xterm/* 移行 / 削除 + 文書化。
5. **タブ管理契約** — internal モードでのゲート化（トークン削減）か CLAUDE.md 側の訂正か（判断は Phase 1、実装は 3a 後続）。
6. **デモチェーン（start-demo-dashboard.ts）** — 公開デモ運用で使用中か。
7. **xlsx tarball の vendor/ コミット or 社内ミラー化**（レビュー C-4）— 版固定 URL でも cdn.sheetjs.com（レジストリ外配布）の可用性リスクが残るため。

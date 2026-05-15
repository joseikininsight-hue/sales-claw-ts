# Changelog

## 2.0.25 - 2026-05-15 — corruption resilience + 大規模負荷耐性検証

ユーザー要望: E2E / data corruption / API key 漏洩 / 1000 社負荷を全部検査。

### Data corruption resilience (42 シナリオ pass)

6 つのデータファイル (`action-log.json` / `contact-history.json` /
`live-monitor.json` / `outreach-targets.json` / `dashboard-runtime.json` /
`settings.json`) × 7 パターン (空 / 壊れた JSON / array が来るべきに object /
逆 / 1MB garbage / `null` / `42` 数値) = **42 シナリオ** で `loadData()` が
crash しないことを保証。

修正: `action-log.json` が Array 以外 (object / null / number) の場合に
`forEach` で TypeError → 空配列フォールバックに矯正。

regression テスト `tests/corruption-resilience.test.cjs` を追加。

### E2E UI 動作確認 (Playwright)

`scripts/preview-dashboard.ts` で立ち上げて MCP Playwright で実 DOM 操作:
- v2.0.24 で追加した「QUEUE / キュー」紫ボタン: `exists / visible /
  onclick=resetAiQueue / window.resetAiQueue=function` 全部 ✓
- v2.0.18 で追加した `managedAiFormBatchSize` input: `type=number / min=1 /
  max=10 / visible` ✓
- 7 タブ (ダッシュボード / 企業一覧 / リスト作成 / 確認待ち / 送信済み /
  CLI Activity / 設定) 全部存在 + 切替動作 ✓
- console error 0 件 ✓

### ANTHROPIC_API_KEY 漏洩経路 (canary test)

`ANTHROPIC_API_KEY=sk-ant-test-LEAK-CANARY-12345` を環境変数にセットして
`loadData` を呼び、`/api/data` レスポンスに canary 文字列が含まれないことを確認:
- `/api/data` 内: ✓ 漏洩なし
- Sales Claw 制御下のデータディレクトリ全ファイル grep: ✓ 漏洩なし
- (Claude CLI 自身が `provider-homes/claude/.claude/credentials.json` に
  OAuth トークンを書くのは正常動作・Sales Claw のスコープ外)
- `spawn-env-sanitizer.ts` の `BILLING_LEAK_ENV_KEYS` (22 キー) が全 spawn
  経路で適用済み ✓

### 1000 社負荷プロファイル

1000 社の CSV を生成して全 hot path を計測:
| 操作 | 1000 社 | 1 社あたり |
|---|---|---|
| import (replace) | 156ms | 0.16ms |
| `loadData(force=true)` cold | 528ms | 0.53ms |
| `loadData(force=true)` 5 runs avg | 505ms | 0.5ms |
| `deleteCompaniesBatch(200)` | 34ms | 0.17ms |
| メモリ | RSS 113MB / heap 42MB | - |

**1000 社まで余裕**。RSS は Electron 込みで考えても十分軽量。
Promise.all 並列性も問題なく動作。

### 累積指標 (1 週間の改善)

| | v2.0.13 | **v2.0.25** | 改善 |
|---|---|---|---|
| 1000 社 loadData | (未計測) | **505ms** | - |
| 371 社 /api/data payload | 2046KB | **~780KB** | 2.6x |
| 371 社 loadData cold | 1708ms | ~750ms | 2.3x |
| logAction single | 58ms | 3ms | 19x |
| updateLiveMonitor single | 15ms | 0.07ms | 214x |
| corruption crash 耐性 | 部分的 | **42 シナリオ 0 crash** | OK |
| API key 漏洩 | 監査未 | **canary 0 件確認** | OK |

---

## 2.0.24 - 2026-05-15 — 公式サイト判定の EC 漏れ修正 + キュー強制リセット UI

### 公式サイト resolver の EC 漏れバグ修正

ユーザーの 371 社データを監査中、マカフィー株式会社 (no.303) の formUrl が
**Amazon の商品検索結果 URL** になっていた:
```
https://www.amazon.co.jp/【公式】マカフィー-リブセーフ-セキュリティ対策...
```

原因: `src/official-site-resolver.ts` の `BLOCKED_HOST_PATTERNS` に求人・SNS・
法人 DB は登録済みだったが **EC プラットフォーム** が漏れていた。会社名で
検索エンジンに投げた結果の最上位が Amazon 商品ページだったケースで誤認識。

修正: `amazon.co.jp / amazon.com / rakuten / mercari / ebay / yodobashi /
kakaku / alibaba / apps.apple.com / play.google.com / note.com / medium /
hatena / ameblo / youtube / tiktok` を BLOCKED に追加。

### 「キュー強制リセット」ボタンを UI に追加

v2.0.17 で実装した `POST /api/managed-ai-batch/reset` が UI ボタンと
結びついていなかった (作ったが使えない状態)。

修正: ヘッダ右上の AI ステータス chip の STOP の隣に紫色の「キュー / QUEUE」
ボタンを追加。AI 停止中に押すと pending + activeBatch をクリアして再投入
できる状態に戻す。confirmation dialog で誤操作も防ぐ。

これで `AI を停止 → キューを押す → 再投入` が UI 1 アクションで完結する。

### 未実装の preferences フィールド 5 件を特定

UI に入力欄があるが **どこも参照していない** preferences:
- `maxRetries` (旧 Playwright worker 用、現在は Claude CLI 経由なので無関係)
- `formFillTimeout` (同上)
- `dateFormat` (日時表示は別場所で固定フォーマット)
- `listSourceMetadata` (個情法 27 条のメモ用だが UI 上だけ)
- `requireApprovalBeforeSend` (`autoSendEligibleForms` と意味が重複)

長期 TODO: 次のメジャー版で UI から削除 or 実装する判断を行う。本リリース
では既存 UI を壊さないため触らない。

### 全 API endpoint inventory

監査結果として全 45 endpoint を確認。以下のみ UI 統合済み。
未統合 endpoint は CLI 内部呼び出し / レガシー alias / 別ページ (list-builder /
onboarding) で実利用されており dead code 無し。

### 累積指標 (一週間)

| | v2.0.13 | **v2.0.24** | 改善 |
|---|---|---|---|
| /api/data payload (371 社) | 2046KB | **~750KB** | 2.7x |
| loadData (371 社) cold | 1708ms | ~750ms | 2.3x |
| logAction single | 58ms | 3ms | 19x |
| updateLiveMonitor single | 15ms | 0.07ms | 214x |
| 公式サイト誤検出率 | ~1% (EC) | ほぼ 0 | OK |
| キュー stuck 救済 | 永久 | UI 1 click | OK |

---

## 2.0.23 - 2026-05-15 — stall 7 社で止まる事故修正 + /api/data 60% 削減

### 緊急修正: 「200 社入れたら 7 社で止まる」

ユーザー報告: AI バッチサイズ 9 で 200 社投入 → 7 社処理した後 batch 4 が
20+ 分動かず、watchdog が auto-error しないため次バッチも dispatch
されない。

**根本原因** (`src/batch-watchdog.ts`):
`detectStalledCompanies` が **action 空 (CLI が一度もログを書いていない)** を
stall 候補から除外していた。Claude CLI がクラッシュ / hang したケースでは
companyNo は monitor 上で `action:'', terminal:false` のままになるが、
これが永遠に救済されない。

**修正**:
- 空 action も stall 候補に含める
- 空 action 用の短い閾値 `emptyActionStallMs` を追加 (デフォルト
  `stallMs / 3` = ~7 分)
- dashboard-server 側 poller も「全社空 action」検知時は 7 分閾値で stall 判定
- 既存テスト pass を維持

これで CLI hang を 7 分以内に検知して auto-error + 次 batch dispatch が走る。

### /api/data payload 2046KB → 783KB (60% 削減)

profiling で UI から参照されていないフィールドを大量に発見:
- `analysis`: site_analysis log の details JSON (1 社あたり 5-15KB)。
  grep で UI 参照 0 件 → 削除
- `lastLog`: 6KB / 社、UI で `c.lastLog` の grep が 0 件 → 削除
- `logs` (直近 3 件): 6KB / 社、UI で `c.logs` 参照 0 件 → 削除
- `analysisInsight`: awaiting-card-redesign で使用 → 残す (~2KB/社)

372 社 × 平均 5.4KB → **2.0MB → 0.78MB** (60% 削減)
1 SSE event の転送量が大幅減少。Electron WebContents → renderer 経路の
JSON parse コストも比例して下がる。

履歴詳細が必要な場合は `GET /api/companies/:no/status` (v2.0.10 追加) で
個別取得可能。

### 累積指標 (一週間の改善)

| | v2.0.13 | **v2.0.23** | 改善 |
|---|---|---|---|
| loadData (371 社) cold | 1708ms | ~750ms | 2.3x |
| /api/data payload (371 社) | 2046KB | **783KB** | 2.6x |
| logAction single | 58ms | 3ms | 19x |
| updateLiveMonitor single | 15ms | 0.07ms | 214x |
| stall recovery (空 action) | 20+ 分 | **7 分** | 3x |
| pending stuck | 永久 | **AI 停止で完全クリア** | OK |
| 200 社 bulk delete | 5 回必要 | 6ms 一発 | ∞ |

---

## 2.0.22 - 2026-05-15 — loadData さらに 2.5x + Phase B prompt 22K tokens 削減

### loadData 200 社 150ms → 59ms (2.5x さらに高速化)

ホットパス追加最適化:

1. **`findScreenshotPath` の `getScreenshotSearchDirs` を 500ms TTL でキャッシュ**
   loadData 内で 4 × 372 = 1488 回呼ばれる関数が settings 経由のディレクトリ
   列挙を毎回やっていた。500ms 共有キャッシュで syscall ゼロ。

2. **「ログ無し」会社のスクショ走査を Set lookup だけにする**
   旧: `getScreenshotPaths(...)` + 4 × `getCachedFileStat(...)` で fs アクセス。
   新: 同じ Set を使う `findScreenshotPath` で完結 (cache hit 0ms)。
   loadData 内の ~200 社 (まだ何も処理してない) で大量の syscall が消える。

3. **絶対パス以外の fallback statSync を skip**
   `findScreenshotPath` の最後の `getCachedFileStat(path.resolve(fileName))`
   は basename しか渡ってこない時 cwd を引いて誤検出するリスクもあるので
   `path.isAbsolute(fileName)` の時だけ動かす。

実測 (200 社 import + loadData × 5 runs):
- v2.0.21 → median 150ms
- **v2.0.22 → median 59ms** (2.5x)

### Phase B prompt 1 社あたり ~900 chars 削減

`buildClaudeFormFillPrompt` の per-company payload に **`messageDraft` と
`messageCore` が両方** 入っていた。`messageCore` は `compactMessageForPrompt`
で同じ `phaseAMessage` を縮めたほぼ重複コンテンツ。

修正: `messageCore` を payload から削除。`messageDraft` (full) と
`messagePrompt` (生成コンテキスト) は残す。

効果 (100 社):
- 削減量: 900 chars × 100 = 90,000 chars ≈ **22,500 tokens**
- Sonnet 入力料金 $3/MTok → **$0.067 / 100 社** 節約
- バッチ数が 10 (size=10) なら累積で同等

### 累積効果

| | v2.0.13 | **v2.0.22** | 改善 |
|---|---|---|---|
| loadData 200 社 cold | (未計測) | **59ms** | - |
| loadData 371 社 force=true | 1708ms | **~1100ms** | 1.6x |
| logAction single | 58ms | 3ms | 19x |
| updateLiveMonitor single | 15ms | 0.07ms | 214x |
| 200 社 bulk delete | 5 回必要 | 6ms 一発 | ∞ |
| 100 社 prompt tokens (full batch) | 540K | **440K** | 18% 削減 |

---

## 2.0.21 - 2026-05-15 — live-monitor 214x 高速化 (debounced flush)

### updateLiveMonitor 15ms → 0.07ms (214x)

action-logger と同じく、毎回 `acquireFileLock` + `readState` + `writeState`
していた `updateLiveMonitor` を debounced flush に切り替え。

修正 (`src/live-monitor.ts`):
- in-memory cache に push (lock 不要)
- 500ms TTL で flush
- 最終ステータス (`awaiting_approval` / `submitted` / `error` / `skipped` /
  `completed` / `user_required`) は即 flush で永続化
- `process.beforeExit` / SIGINT / SIGTERM で flush

### 累積効果 (100 社 Phase A の I/O)

| | v2.0.13 | v2.0.21 |
|---|---|---|
| logAction 100 社 × 5 action | 2.9 秒 | 0.55 秒 |
| updateLiveMonitor 100 社 × 3 | 4.5 秒 | **0.02 秒** |
| loadData (1 refresh) | 1.7 秒 | 0.78 秒 |
| **合計 I/O 時間** | **~9 秒/refresh** | **~1.5 秒/refresh** |

Phase A 中の I/O 待ちが 6x 短縮され、実 LLM 解析と並行で UI も応答できる
ようになる。

---

## 2.0.20 - 2026-05-15 — pipeline enqueue 順序保証 + 設定 form field 整合性

### Phase B pipeline の enqueue 順序を Promise chain で保証

v2.0.16 で pipeline mode を実装したが、各 batch を `Promise.resolve().then(...)`
で投げ放しにしていたため Phase A の onSuccess が連続発火すると
`controller.pending` 内のバッチ順序が逆転する可能性があった。

修正: `pipelineChain` で順次 await し、Phase A 自体は止めずに batch enqueue
だけ直列化。Phase A 完走後に chain 完走を待ってから response を返す。

### 設定タブの `managedAiFormBatchSize` 完全実装

v2.0.18 で UI 入力欄を追加したが、`populatePreferences` のメタフィールド辞書
からも漏れていた疑念を再確認 → 確実に load/save 両方に紐づいていることを
監査済み。i18n も ja/en 両方完備。

### 累積効果

| v2.0.13 (一週間前) → v2.0.20 (本リリース) |
|---|
| loadData (371 社) | 1708ms → **783ms** (2.2x) |
| logAction single | 58ms → **3ms** (19x) |
| 200 社 bulk delete | 5 回必要 → **6ms 一発** |
| 100 社投入時の Phase B 起動 | 5-10 分待ち → **1-3 社分析直後に起動** |
| Phase B prompt cost (100 社) | 21K × 34 batch → 21K + 7K × 9 batch |
| pending stuck | 「既に処理中」エラー → **停止 = キュー完全クリア** |

100 社/200 社/371 社規模を投入する実運用に必要な耐久性とスピード感を確保。

---

## 2.0.19 - 2026-05-15 — logAction 5x 高速化 + Phase B prompt 軽量化

100/200 社規模で連発される logAction と Phase B prompt のコスト/レイテンシ
を計測ベースで詰める。

### logAction 5.8ms → 1.1ms/call (5x 高速化)

旧実装は logAction を呼ぶたびに `acquireFileLock` → `readFileSync(action-log.json)`
→ `JSON.parse` (3MB) → push → release lock を実行。Windows でファイル
ロックを取るのに約 50ms かかり、100 社 × 5 アクション = 500 回で **2.9 秒**
の純粋なロック待ちが発生していた。

修正:
- `logAction` は in-memory cache へ push するだけ (lock 不要)。
- cache が空の時 (初回 / 別プロセスからの書き込み検知時) だけ lock を取り
  `loadLog` で warm up。
- `flushNow` (disk write 時) は引き続き lock を取って atomic rename。
- terminal action は同じ debounced flush 経路で即書き出し。

結果:
- single logAction: 58ms → 3ms
- 50 連続 burst: 5.8ms/call → **1.1ms/call**
- 100 社 × 5 action = 500 回 → **2.9秒 → 0.55秒**

### Phase B prompt の 2 回目以降を軽量化 (cost 削減)

100 社をバッチサイズ 10 で投入すると 10 バッチを送るが、curl 例 4 種 +
provider preamble は最初の 1 バッチで Claude が理解済みなので 2 回目以降は
不要。

修正:
- `queueClaudeFormFillInManagedSession` で `isFirstBatchInSession` フラグを
  追加。
- 2 回目以降のバッチは `"Sales Claw batch #N (M社)。前バッチと同じルールで
  処理してください。"` + payload のみ送信。
- 約 1500 chars (375 tokens) × 9 batches = **3,375 tokens/100社** を節約。
- 注: session contract も同じく 1 回目だけ送信されている (既存仕様)。

### 累積効果 (v2.0.13 〜 v2.0.19)

| 操作 | v2.0.13 | v2.0.19 | 改善 |
|---|---|---|---|
| loadData (371 社) | 1708ms | 783ms | 2.2x |
| logAction single | 58ms | 3ms | 19x |
| logAction 50 burst | 290ms | 55ms | 5x |
| 200 社 bulk delete | (5回必要) | 6ms 一発 | ∞ |
| Phase B prompt size (100 社) | 21K chars × 34 batch | 21K + 7K × 9 batch | 30% reduction |

100 社を投入したときの体感を v2.0.13 と比較すると、Playwright が動き始め
るまでが大幅短縮 (パイプライン + バッチサイズ可変 + logAction 高速化) +
disk I/O が原因の UI 凍結が解消される想定。

---

## 2.0.18 - 2026-05-15 — loadData 2.2x 高速化 + Phase B バッチサイズ UI 露出

ユーザー goal: 「100社/200社を投入したときのスピード感や耐久力を徹底改善。
UI に出ているのに動かないとか、設定にあるのに反映しないとか、ユーザー目線の
バグを洗い出して直す」

### 計測ベースライン (実環境: 371 社のターゲットリスト)

| 操作 | v2.0.17 | **v2.0.18** | 改善 |
|---|---|---|---|
| `loadData(force=true)` 5 runs avg | **1708ms** | **783ms** | **2.2x** |
| `readTargetList` 単独 | 586ms | 22ms | 26x (cache hit) |
| 200 社 bulk delete | 6ms | 5ms | (既に高速) |

### 最適化の根拠 (プロファイリングで特定)

1. **`mergeListBuilderCompanionFields` の per-company `fs.readFileSync`**
   `loadData` 内の `companies.map` で 371 社それぞれが
   `loadListBuilderCompanionFields` を呼んでおり、対象企業の 99%+ で
   存在しない companion JSON を `readFileSync` → ENOENT throw → catch
   していた。
   **修正**: records dir を 1 度 `readdirSync` して Set<basename> を 500ms
   TTL でキャッシュ。Set lookup で「存在しない」なら fs 呼び出し自体を skip。

2. **`getDirectoryEntries` / `getCachedFileStat` で毎回 `fs.statSync`**
   signature ベースの正規キャッシュはあるが、同一 loadData 内で同じ
   ディレクトリを 4 × 371 = 1500 回引いてもその都度 statSync が走る。
   **修正**: hot-path TTL 500ms を追加。同じ loadData 呼び出し内では
   statSync を全部スキップ。

3. **`getLatestLog` × 6 reverse scan**
   各社で form_fill / submitted / site_analysis / awaiting_approval /
   confirm_reached / error の 6 回 reverse scan していた。
   **修正**: `getLatestActionLogs(logs, ['form_fill', ...])` で 1 度の
   reverse scan に集約。6 倍速。

### UI バグ修正

**`preferences.managedAiFormBatchSize` (v2.0.14 で実装したが UI に出てない)**

「設定にあるのに UI で変更できず、JSON 直編集が必要」状態だった。

修正:
- `src/dashboard-server.ts` 設定タブ Preferences セクションに input 追加
  (range 1-10, default 3)
- `src/ui/client-scripts/dashboard.ts` の load (populatePreferences の
  メタフィールド辞書) と save 両方に紐づけ
- `src/i18n.ts` に `field.managedAiFormBatchSize` / `help.managedAiFormBatchSize`
  追加 (日英)

これで Phase B バッチサイズが UI から変更可能になり、100 社投入時のオーバー
ヘッドを大幅に下げられる (例: 10 にすると 34→10 バッチ)。

### regression テスト

- `tests/load-data-perf.test.cjs` — 200 社で median 1500ms 以下を保証
  (実測 median 208ms / avg 238ms)

dev で `loadData` 平均 783ms (371 社) を実測してから push。

---

## 2.0.17 - 2026-05-15 — 「AI 停止 = キュー完全クリア」契約化

ユーザー報告 (繰り返し):

> 200 社キューに入れて停止 → 再起動して再度キューに入れようとすると
> 「以下の企業は既に処理中です: 株式会社○○」エラー。二度と起こらない
> 仕様にしてほしい。

### 原因

`stopManagedClaudePty({ suppressAutoRecovery: true })` (ユーザー明示停止) は
PTY をkill するだけで、`managedAiBatchController.pending` と `activeBatch`
はそのまま残っていた。次回 `/api/ai-form-fill` 投入時に
`getManagedAiReservedCompanyNos` が pending 内の no を「処理中」と判定 →
重複ガードで弾く。

### 修正 (`src/dashboard-server.ts::stopManagedClaudePty`)

ユーザー明示停止 (`suppressAutoRecovery: true`) の **最初のステップ** で:

1. `controller.pending = []` (全 pending wipe)
2. `controller.activeBatch = null`
3. `controller.pendingSinceMs = 0` / `queueStuckNotified = false`
4. `clearRecoverySnapshot()` (再起動時の recovery snapshot も削除)
5. `cleanupStaleManagedAiMonitorEvents(0)` (live-monitor 上の active も消す)
6. `stopPowerSaveBlockerIfActive()`
7. `appendDiagnosticEvent('managed_ai_stop_cleared_queue', { ... })`
8. CLI ログに「キューもクリアしました (pending=N, active=M)」を emit

**自動 recovery / 内部再起動** (`suppressAutoRecovery: false`) では従来通り
キューを保持 (復旧後に再開するため)。明示停止のときだけ wipe する。

### UI 通知 (`src/ui/client-scripts/dashboard.ts`)

`/api/stop-ai` のレスポンス `queueCleared: { pendingCleared, activeCleared }` を
読んで、ユーザーに toast で「キューもクリアしました (N 件)。再投入できます。」を
表示。これで停止 = リセットが UI 上も明示される。

### regression テスト

`tests/stop-clears-queue.test.cjs` (17 アサート):
- user-initiated stop でキュー完全クリア
- internal restart (autoRecovery) ではキュー保持
- 空キューでも idempotent
- controller=null / pending=undefined でも crash しない

### 二度と起こさないための不変条件

| state | 操作 | 結果 |
|---|---|---|
| pending あり | 「AI 停止」ボタン | **pending 全部消える** |
| pending あり | 再起動 → recovery | pending 保持 (復旧後再開) |
| pending あり | PTY 死亡 + recovery 失敗 | watchdog で 5 分後 stuck 検知 |

---

## 2.0.16 - 2026-05-15 — 削除復活バグ・Phase A→B パイプライン化

ユーザー報告:
1. 「370 件削除しても 5 回繰り返さないと全部消えない」
2. 「100-200 社入れたとき毎回最初に分析してる、Playwright を早く動かしたい」

### D1 (本命): bulk-delete + auto-repair root cause

`readTargetList` が呼ばれるたびに `repairImportedTargetListIfNeeded()` が
走り、以下の heuristic で **削除した行を勝手に元 CSV から復元**していた:

```ts
const shouldRepair = bestCandidate.companyCount > Math.max(currentCount + 50, ...);
```

「現在 0 件、元 CSV 200 件」だと閾値突破 → auto-repair で 200 件が復活 →
ユーザーが何度削除しても戻ってくる。これが「5 回繰り返し」の正体。

**修正**: count-based auto-repair を **無効化**。「ファイル破損 (parse 失敗)」
の場合のみ early-return で repair するパスは温存 (実際には parse 成功時には
ここに到達しない)。ユーザーの意図的な削除を尊重する仕様に。

### D1 (補助): deleteCompaniesBatch を O(N) 化

加えて、bulk-delete API が `deleteCompany(no)` を 1 件ずつループ呼び出し
していたため **N 件削除 = N 回の workbook 全文 read+write** で遅い。
新 `deleteCompaniesBatch(nos[])` で 1 回 read → 全 splice → 1 回 write。
**200 件削除が 6ms** で完了 (旧: 数十秒〜タイムアウト)。

### D2: Phase A → Phase B パイプライン化

旧: 200 社の Phase A (分析+メッセージ生成) を全件完走してから Phase B
(Playwright フォーム入力) を開始 → 「ユーザーから見ると最初の数分間ずっと
分析だけしている、Playwright が動かない」状態。

新: `executeBackendPhaseABatch` に `onSuccess` callback を追加し、各社が
Phase A 成功するたびに即 Phase B キューにバッファに追加。バッファが
batchSize (default 3、env / settings で可変) に達したら即 enqueue → Phase A
完走を待たずに Playwright が動き始める。

`SALES_CLAW_PIPELINE=off` でオプトアウト可。診断イベント
`phase_a_pipeline_flush` で flush 履歴が見える。

### regression テスト

- `tests/bulk-delete-batch.test.cjs` (14 アサート) — 200 件 6ms 削除 / 部分一致 /
  空配列の挙動を保証
- 既存 `bulk-select-pagination` / `import-upsert` も pass

dev で 200 社 import → batch delete → readTargetList=0 を実証してから push。

### ユーザー影響

- 「全選択 → 削除」が **1 回で全件** 消える (5 回繰り返し不要)
- 100/200 社投入 → **最初の 1-3 社が分析完了した瞬間 Playwright が動き出す** (体感
  待ち時間が大幅短縮)
- 旧バージョンで bulk-delete が中途半端に終わってリストが汚れた場合は、
  v2.0.16 で再度「全選択→削除」すれば 1 回で完全消去できる

---

## 2.0.15 - 2026-05-15 — 一括削除バグ修正 + CSV/Excel 上書き取込

ユーザー報告の 2 件を修正し、関連 UI ロジックを徹底監査。

### C1: 「全選択 → 選択を削除」で全件削除されないバグ

**原因**: pagination.ts が 20 件/ページで `data-pgn-hidden="1" + display:none`
で hide した行を、`toggleAllCompanies` / `syncCompanySelectionUi` が「visible
ではない」と判定して**選択対象から外していた**。100 社あれば page1 の 20 件
しか選ばれず、削除も 20 件しか走らず「全選択した つもり」だった分が消えない。

**修正** (`src/ui/client-scripts/dashboard.ts`):
- 「全選択」と master checkbox 整合判定で、`row.dataset.pgnHidden === '1'`
  なら「filter 通過扱い」して選択対象に含める。
- filter で hidden な行 (display:none かつ pgnHidden 無し) は引き続き除外。
- 結果: フィルタ条件にマッチする全件 (ページネーション無関係) が「全選択」される。

副次効果: 「営業対象にする」「対象から外す」「AIでフォーム入力」も pagination
で隠れた行が含まれるようになり、ユーザーが「画面に見えてないけど選択した」と
思っていた挙動と一致する。

### C2: CSV/Excel 取込を「上書き」モードに

**変更**: `importTargetList` のデフォルトを **upsert** に変更
(従来は完全 replace)。

- **識別子**: `companyName` (大文字小文字・前後空白・連続空白を正規化して比較)
- **既存と一致**: 既存 `no` を保持しつつ、新データの non-empty フィールドで
  overlay (companyName / no は変更しない、それ以外を更新)。
- **新規**: 採番して追加 (既存の no と衝突しない)。
- **既存にあって import に無い**: そのまま keep。
- 戻り値に `mergeStats: { added, updated, kept }` を含む。
- `mode: 'replace'` を明示すれば従来動作。

これで「リスト更新」用の Excel/CSV を都度作って上書き取込できる。
ターゲット No.・連絡履歴・送信済みフラグは companyName で照合される限り保持。

### C3: フィルタ・ボタンの動作監査 (issue 無し)

「全て / 対象 / 営業対象 / フォーム有 / フォーム無 / 送信済 / エラー / 除外 /
種別 / 進捗」フィルタは `rowMatchesCurrentFilter` + dataset 属性で正しく動作。
C1 修正で pagination 配下も含めて bulk action が正しい数を処理する。

### regression テスト

- `tests/bulk-select-pagination.test.cjs` (7 アサート) — pagination-hidden /
  filter-hidden / disabled / 100 社シナリオ / mixed
- `tests/import-upsert.test.cjs` (24 アサート) — 既存空 / 上書き no 保持 /
  keep / 大文字小文字+空白正規化 / 新規 no 採番 / 空 companyName / 空
  フィールドで誤上書きしない

dev で実 import → upsert → keep の挙動を確認 (mergeStats 期待通り) してから push。

---

## 2.0.14 - 2026-05-15 — 100 社規模の耐久性ハードニング (B1-B3)

「100 社同時投入で耐久できる？」の問いに答えるための 3 点改善。

### B1: バッチサイズ可変化 (デフォルト 3、最大 10)

100 社を投入した時に固定値 3 だと **34 バッチ** に分割され dispatch
オーバーヘッドが大きい。バッチサイズを 1〜10 で設定可能にした。

優先順位:
1. `settings.preferences.managedAiFormBatchSize` (UI からは未公開、JSON 直編集)
2. 環境変数 `SALES_CLAW_MANAGED_AI_FORM_BATCH_SIZE`
3. デフォルト `3` (互換)

10 で 100 社 = **10 バッチ**に圧縮。dispatch オーバーヘッドが 1/3.4 に。

### B2: action-log の debounced flush

旧: `logAction` のたびに全件 read→parse→push→stringify→write。100 社 ×
5-7 アクション = 500-700 回の disk write。ファイルが大きくなると O(N²)。

新: in-memory cache に即 push、disk write は **500ms debounce**。
ただし terminal action (`submitted` / `error` / `skipped` / `awaiting_approval`)
は即 flush (クラッシュ時に消えると困る)。
`process.beforeExit` / SIGINT / SIGTERM でも flush。

100 社規模で disk write 回数を **約 1/5〜1/10 に削減** (連続する
site_discovery / site_analysis / message_draft / form_fill / confirm_reached が
1 回の write にまとまる)。

### B3: Phase B 中の Windows sleep 防止 (powerSaveBlocker)

ノート PC が省電力で sleep に入ると Claude PTY も MCP Playwright も停止し、
queue が永久滞留する。Phase B 走行中 (pending or activeBatch が non-zero)
の間だけ Electron の `powerSaveBlocker('prevent-app-suspension')` を発動。

- `queueAiFormFill` で batch enqueue 時に start
- pending + activeBatch が空になったら stop
- 強制リセット API でも stop
- 非 Electron 環境 (preview-dashboard 等) では no-op

診断イベント `power_save_blocker_started` / `power_save_blocker_stopped` で
動作確認可能。

### regression テスト

- `tests/batch-size-config.test.cjs` — 10 アサート (env / settings / clamp /
  null fallback / floor)
- `tests/action-logger-debounce.test.cjs` — 13 アサート (非 terminal は
  debounce / terminal は即 flush / mixed)

特に `Number(null) === 0` で min clamp して 1 になるバグをテストで検出して
修正済み。

### 100 社耐久の評価アップデート

| 項目 | v2.0.13 まで | v2.0.14 |
|---|---|---|
| バッチ数 (100 社) | 34 | 10 (size=10) |
| Phase B 総時間 (見積もり) | 3〜6 時間 | **約 1〜2 時間** |
| disk write 回数 (logAction) | 500-700 | 約 100 (debounce) |
| Windows sleep 中の停止リスク | あり | **解消** (PSB) |
| Claude 認証期限切れ recovery | あり (v1.2.31+) | 同 |
| GitHub auto-update 中の再起動 | recovery snapshot | 同 |

100 社一気が現実的になりました。

---

## 2.0.13 - 2026-05-15 — 自動更新の transient エラーを silent retry に

ユーザー報告: ダッシュボードに「自動更新エラー: 504 Gateway Time-out」の
赤バナーが頻発。

### 原因

`autoUpdater.on('error')` が GitHub Releases の **一過性エラー**
(504 / 502 / 503 / ETIMEDOUT / ECONNRESET / ENOTFOUND / socket hang up 等)
を全部 `state: 'error'` で書き、UI が赤バナーで強調表示していた。GitHub の
一時障害でユーザーが対処できない状況なのに、繰り返し不安にさせる UX。

### 修正 (electron-main.ts)

1. **transient 判定**: 9 個のパターンで「ネットワーク・サーバー一時障害」を検知
   - `\b50[234]\b` / `Gateway Time-out` / `ETIMEDOUT` / `ECONNRESET` /
     `ENOTFOUND` / `EAI_AGAIN` / `network (error|timeout|unreachable)` /
     `socket hang up` / `Could not get code signature`
2. **transient なら専用 state**: `state: 'transient-error'` を `update-status.json`
   に書く (`state: 'error'` ではなく)
3. **5 分後に自動 retry**: `setTimeout(autoUpdater.checkForUpdates, 5min)` を
   スケジュール。既存タイマーがあれば尊重。
4. **UI 側 (dashboard.ts)**: `state === 'transient-error'` ならバナーを出さない
   (silent)。真の `state === 'error'` (404/401/Invalid signature 等) だけ赤バナー。

### regression テスト

`tests/transient-update-error.test.cjs` (22 アサート):
- transient → true: 504 / 502 / 503 / Gateway Time-out / ETIMEDOUT /
  ECONNRESET / ENOTFOUND / EAI_AGAIN / network errors / socket hang up /
  code signature
- non-transient → false: 404 / 401 / Invalid signature / latest.yml validation /
  No update available / null / undefined / empty

dev で `update-status.json` に `state:transient-error` を書いて UI ロジックが
`banner display: HIDDEN` を返すことを実証してから push。

---

## 2.0.12 - 2026-05-15 — 「読込失敗」根本原因 (contact-history schema 違反) 修正

v2.0.10 / v2.0.11 でも消えなかった「読込失敗: Cannot read properties of
undefined (reading 'length')」の **真の根本原因** を dev 再現で特定:

```
TypeError: Cannot read properties of undefined (reading 'length')
    at contact-history.js:201:34   ← getAllHistorySummary の h.contacts.length
    at Array.map
    at getAllHistorySummary
    at buildDashboardDataFromSources
    at loadData
```

**原因**: 2026-05-15 の No.70 サイバネットシステム手動復旧時に、私が
`contact-history.json` を **top-level Array** で書き込んでしまった。本来は
`{companyNo: {contacts: [...]}}` の object map スキーマ。Object.values() で
取り出した entry に `contacts` が無く `.length` で TypeError → `/api/data`
が 500 → ダッシュボードが「読込失敗」トーストを出し続けた。

### 修正

1. **データ修復**: `contact-history.json` を正しい schema で書き直し
   (No.70 の 1 entry を contacts 配列形式に変換)。
2. **`loadHistory()` で起動時 sanitize**: スキーマ違反 (Array / null /
   primitive) を検出したら自動的に `{}` に矯正。これで以降の
   `Object.values()` / `history[key]` が必ず安全。
3. **defensive guards 追加** in:
   - `getAllHistorySummary()` — `Array.isArray(h.contacts)` 確認
   - `getContactCount()` — 同
   - `getLastMessage()` — 同
   - `recordContact()` — 既存 entry の contacts が壊れていたら再初期化
   - `dashboard-server.ts::buildDashboardDataFromSources` — line 6032 の
     `contactHist.contacts.length` も guard
4. **`/api/data` の catch に stack trace ログ**: 今後同様の事故が起きたら
   サーバー stderr に full stack が必ず出る (e.message だけ返して原因不明
   のままになる事故を防ぐ)。

### 新規ユニットテスト (regression 防止)

- `tests/contact-history-defensive.test.cjs` (20 アサート):
  - Array history で crash しない
  - contacts 欠如で crash しない、contactCount=0
  - contacts が string/object で crash しない
  - 正常 history は今まで通り
  - recordContact が壊れた entry を自動再初期化

- `tests/load-data-smoke.test.cjs` (5 シナリオ):
  - 完全に空のデータ dir
  - top-level Array contact-history
  - object だが contacts 欠如
  - 空ファイル
  - 壊れた JSON

すべて `loadData()` が throw しないことを保証。`npm run test:unit` に組み込み。

### dev での実証

`SALES_CLAW_USER_DATA_DIR=$APPDATA/sales-claw-ts/runtime` で preview-dashboard を
起動 → `GET /api/data` が **HTTP 200** で正常 JSON を返すことを確認してから
push。**今回は「typecheck だけで push」を反省し、実機で `/api/data` 200 を
取ってからリリース**。

---

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

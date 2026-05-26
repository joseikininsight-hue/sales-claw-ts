# In-App Form Fill — 詳細設計書

**Status**: Draft v1.0 (Week 1 着手前提)
**Date**: 2026-05-26
**Related**: `src/form-session-manager.ts`, `src/routes/form-session-api.ts`, `src/dashboard-server.ts:2854 ensureProviderPlaywrightMcp`, `src/local-toolchain.ts:604 getPlaywrightMcpCommandSpec`, `src/mcp-config-helpers.ts`

---

## 0. ゴール / 非ゴール

### Goal
- フォーム入力を Electron 内蔵 WebContentsView で完結させ、**外部 Chromium プロセスを起動しない**。
- 既存 Playwright MCP モードとの **feature flag による共存** と、1ステップ rollback。
- reCAPTCHA v2 / v3 / hCaptcha / Turnstile の **人間解決ワークフロー** (`awaiting_approval`) を MCP Playwright モードと同等以上に保つ。
- Week 1 で Phase 1 (skeleton + 3 ツール) を着地、Week 2 で全 15 ツール + Playwright デフォルト無効化。

### Non-Goal
- メールフォーム以外 (チャットボット / Salesforce API / Microsoft Forms 等)
- Phase A (site 分析) のロジック変更
- macOS / Linux サポート (Windows のみ運用継続)
- Phase B 以外で利用される MCP (computer-use 等) との衝突解消

---

## 1. アーキテクチャ全体像

### 1.1 フロー図

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Claude Code CLI (managed PTY, child of Electron main)                  │
│                                                                          │
│   mcp__sales-claw-form__browser_navigate({ url })                        │
│        │                                                                 │
│        ▼  (stdio JSON-RPC 2.0 / MCP)                                     │
└────────┼────────────────────────────────────────────────────────────────┘
         │
┌────────▼────────────────────────────────────────────────────────────────┐
│  sales-claw-form-mcp-server.cjs (separate Node process, spawned by CLI) │
│                                                                          │
│  - stdio: stdin/stdout で MCP プロトコル                                  │
│  - upstream: Electron main へ Named Pipe (\\.\pipe\sales-claw-form-mcp)  │
│  - 役割: tool schema 提示 / 引数 validate / IPC 委譲 / 結果整形            │
└────────┬────────────────────────────────────────────────────────────────┘
         │  (Named Pipe / length-prefixed JSON frame)
┌────────▼────────────────────────────────────────────────────────────────┐
│  Electron main process                                                   │
│                                                                          │
│  FormSessionManager (existing, src/form-session-manager.ts)              │
│   - createSession / fillForm / captureScreenshot は既存利用               │
│   + CdpBridge (new): webContents.debugger.attach('1.3')                  │
│     - sendCommand(method, params) → CDP                                  │
│     - on(event) → tool への push                                          │
│                                                                          │
│  WebContentsView (Chromium, in-process, partition per session)           │
│   ↑ DevTools Protocol (Electron 内蔵 chrome-devtools-protocol を直接叩く)│
└─────────────────────────────────────────────────────────────────────────┘
```

### 1.2 既存 Playwright MCP モードとの共存

`data/settings.json` に **`formFill.mode`** を追加。3 値:

| 値 | 動作 | デフォルト |
|---|---|---|
| `"playwright"` | 既存 Playwright MCP のみ登録。internal MCP は **spawn しない** | v2.0.65 まで |
| `"internal"` | sales-claw-form MCP のみ登録。Playwright MCP は登録解除 | v2.1.0 〜 |
| `"both"` | 両方登録 (A/B テスト用、Claude CLI が両方見える) | Week 2 のみ |

切替時の動作:
- `ensureProviderPlaywrightMcp` の隣に **`ensureProviderInternalFormMcp`** を新設 (同じ pattern)。
- `startManagedAiSession` で `formFill.mode` を読み、必要な MCP のみ ensure。
- mode 切替 = managed PTY 強制再起動 (既存の `restartManagedAiSessionForAuthRefresh` を流用)。

### 1.3 セキュリティ境界

| 境界 | 信頼レベル | 対策 |
|---|---|---|
| MCP server プロセス → Electron main | trusted (同一マシン、同一ユーザー) | Named Pipe ACL を current user only に。pipe 名にランダム suffix |
| WebContentsView 内 Web ページ → Electron main | **untrusted** | `nodeIntegration:false`, `contextIsolation:true`, `sandbox:true` (既存維持) |
| Claude CLI → MCP server | semi-trusted (LLM の出力) | tool 引数 schema を Zod で厳格 validate、URL は既存 `validateFormUrlSafety` 経由必須 |
| CDP `Runtime.evaluate` の expression | **untrusted** (LLM 生成) | `awaitPromise:true`, `returnByValue:true`, `userGesture:false`, isolated world で実行。expression を allowlist 化 |

**CDP は admin 権限ではない**: `webContents.debugger.attach` は Electron renderer に対する権限であり、OS admin は不要。ただし attach 中は DevTools (F12) 不可。

---

## 2. 内製 MCP server 仕様 (`mcp__sales-claw-form__*`)

### 2.1 移植ツール一覧 (15 ツール)

| # | ツール名 | 引数 (Zod schema) | 戻り値 | CDP マッピング |
|---|---|---|---|---|
| 1 | `browser_navigate` | `{ url, sessionId?, waitUntil? }` | `{ sessionId, url, status, title }` | `Page.navigate` + `Page.loadEventFired` 待ち |
| 2 | `browser_snapshot` | `{ sessionId, mode? }` | `{ tree, fields, captcha, iframes }` | `Accessibility.getFullAXTree` + 既存 `getFormStructure` |
| 3 | `browser_fill_form` | `{ sessionId, mappings: [{selector, value, type?}] }` | `{ results }` | 既存 `fillForm` (Runtime.evaluate isolated world) |
| 4 | `browser_type` | `{ sessionId, selector, text, delay? }` | `{ ok }` | `DOM.querySelector` → `DOM.focus` → `Input.dispatchKeyEvent` |
| 5 | `browser_click` | `{ sessionId, selector, button?, clickCount? }` | `{ ok }` | `DOM.getBoxModel` → `Input.dispatchMouseEvent` (press+release) |
| 6 | `browser_select_option` | `{ sessionId, selector, values }` | `{ ok, selected }` | `Runtime.evaluate`: `el.value=v; el.dispatchEvent(change)` |
| 7 | `browser_take_screenshot` | `{ sessionId, suffix, fullPage? }` | `{ path }` | 既存 `captureScreenshot` / `Page.captureScreenshot` |
| 8 | `browser_tabs` | `{ sessionId?, action?, target? }` | `{ tabs }` | FormSessionManager の sessions map を 1:1 で tab に見立てる |
| 9 | `browser_evaluate` | `{ sessionId, expression, awaitPromise? }` | `{ result, type }` | `Runtime.evaluate` (isolated world) |
| 10 | `browser_wait_for` | `{ sessionId, selector?, text?, timeout? }` | `{ ok, foundAt }` | polling loop 200ms ごと |
| 11 | `browser_press_key` | `{ sessionId, key, modifiers? }` | `{ ok }` | `Input.dispatchKeyEvent` (rawKeyDown + char + keyUp) |
| 12 | `browser_handle_dialog` | `{ sessionId, accept, promptText? }` | `{ ok }` | `Page.handleJavaScriptDialog` |
| 13 | `browser_file_upload` | `{ sessionId, selector, paths }` | `{ ok }` | `DOM.setFileInputFiles` |
| 14 | `browser_drag` | `{ sessionId, sourceSelector, targetSelector }` | `{ ok }` | `Input.dispatchMouseEvent` press → move → release |
| 15 | `browser_hover` | `{ sessionId, selector }` | `{ ok }` | `DOM.getBoxModel` → `Input.dispatchMouseEvent` moved |

### 2.2 a11y tree (browser_snapshot) の取得

```
1. Page.getFrameTree で main frame + OOPIF を列挙
2. Accessibility.enable
3. Accessibility.getFullAXTree({ frameId, depth: -1 }) を frame ごとに
4. 既存 getFormStructure() の Runtime.evaluate も並行実行し、a11y tree と field metadata を merge
5. 返却 shape:
   {
     tree: [{ role, name, value, focusable, children: [...] }],
     fields: [{ selector, purpose, label, required }],
     captcha: { hasRecaptchaV2, hasRecaptchaV3, hasHCaptcha, hasTurnstile },
     iframes: [{ frameId, url, isCrossOrigin }],
   }
```

### 2.3 isolated world の使い方

```
1. Page.createIsolatedWorld({ frameId, worldName: 'sales-claw' }) → contextId 取得
2. Runtime.evaluate({ contextId, expression, ... }) で実行
3. contextId は frame navigate のたびに失効するため、Page.frameNavigated で invalidate
4. FormSessionManager に _isolatedContextIds: Map<frameId, contextId>
```

---

## 3. プロセス間通信

### 3.1 トポロジ

```
Claude CLI ──(spawn)──► sales-claw-form-mcp-server.cjs ──(named pipe)──► Electron main (listen)
                              │                                                │
                          stdio MCP                                      FormSessionManager
```

- Electron が起動時に named pipe を listen
- env `SALES_CLAW_FORM_IPC_PIPE` を `buildManagedProviderEnv` 経由で Claude CLI に注入
- MCP server (CLI が spawn する) が env を読んで Electron に connect

### 3.2 ワイヤフォーマット

Length-prefixed JSON:
```
[4 bytes uint32 BE: payload length] [N bytes UTF-8 JSON]
```

JSON shape:
```jsonc
// Request (MCP server → Electron)
{ "id": "req-uuid", "op": "createSession"|"fillForm"|"cdpCommand"|..., "params": {...} }
// Response
{ "id": "req-uuid", "ok": true, "result": {...} }
// or { "id": "req-uuid", "ok": false, "error": { "code": "...", "message": "..." } }
// Event (no id)
{ "event": "page.dialog"|"cdp.<method>", "sessionId": "...", "params": {...} }
```

### 3.3 フェイルセーフ

| シナリオ | 検知 | 復旧 |
|---|---|---|
| Electron が先に死ぬ | MCP server: pipe `end`/`error` | in-flight req を error reject、以降の tool 呼び出しは即 error |
| MCP server が先に死ぬ | Electron: server socket `close` | session 保持。CLI 再起動時に `browser_tabs` で query して再 attach |
| pipe 切断後 reconnect | MCP server が 3秒間隔で再接続、最大 5 回 | 5 回失敗で `process.exit(1)` |
| Electron 起動前に CLI が MCP server を起動 | env 未定義 or pipe 接続失敗 | `tools/list` 時に「Sales Claw が起動していません」error |

---

## 4. WebContentsView の UI 統合

### 4.1 既存 dock 機構

`src/form-session-manager.ts` の `_positionView` (HEADER_HEIGHT=56, PANEL_LEFT_RATIO=0.45) を **そのまま流用**。

### 4.2 awaiting_approval タブの会社ごと WebContentsView (UX 中核)

**Phase B は CLI 視点ではシーケンシャル**だが、**ユーザー視点では「awaiting_approval に積まれた N 社を、好きな順でクリックして個別に対処」できる UX**。

```
┌─ Awaiting Approval タブ ────────────────────────────────┐
│ ┌─ 左 35%: 確認待ち会社カードリスト ──┐                  │
│ │ □ [No.2]  株式会社NDPマーケ          │                  │
│ │   reCAPTCHA 解決待ち  🔴            │                  │
│ │ □ [No.7]  株式会社オプティマイザー    │                  │
│ │   送信前確認  🟡                    │                  │
│ │ □ [No.15] 株式会社XYZ                │                  │
│ │   フォーム入力済 🟢                  │                  │
│ └────────────────────────────────────┘                  │
│ ┌─ 右 65%: 選択中の会社のWebContentsView ──────────────┐  │
│ │ [選択中: No.2 NDPマーケ]                             │  │
│ │ ┌──────────────────────────────────────────────┐   │  │
│ │ │   WebContentsView (実フォーム表示)              │   │  │
│ │ │   [reCAPTCHA] ☐ I'm not a robot               │   │  │
│ │ │   ← ユーザーがここを直接クリックして解決         │   │  │
│ │ └──────────────────────────────────────────────┘   │  │
│ │  [📷 ss-2-input.png] [✅ 送信完了] [❌ スキップ]    │  │
│ └──────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

**実装ポイント**:

- CLI が `awaiting_approval` を log した段階で、**WebContentsView session は破棄せず保持** (MAX_SESSIONS=30、LRU evict で古いものから消す)
- session ID と companyNo の双方向 map を `FormSessionManager._sessionByCompany: Map<companyNo, sessionId>` で持つ
- 左ペイン カードリストは `/api/awaiting-approval` ポーリング (既存) + 各社の `sessionId` 有無を `/api/form-session/list` から merge
- カードクリック → `FormSessionManager.activate(sessionId)` で右ペインに dock 切替 (既存 `_setActiveSession` を流用)
- 「送信完了」ボタン → そのセッションの現在 URL / fresh screenshot (`captureScreenshot('sent')`) を `submitted` log に記録 → session destroy
- 「スキップ」ボタン → session destroy + `skipped` log
- 「再入力 (retry)」ボタン → session を navigate 戻して再フォーム入力 (任意拡張)

**Phase B 中の振る舞い**:

CLI が次の社 (No.3) の form_fill を開始する時、No.2 の WebContentsView は**裏で生き続ける** (visible=false で hide)。ユーザーが No.2 カードをクリックすれば即座に右ペインに復帰。No.3 が終わって awaiting_approval を log すれば No.3 カードもリストに追加 → ユーザーが好きな順で処理可能。

**MAX_SESSIONS=30 を超えた場合**:

LRU で最も古い `awaiting_approval` 状態の session が destroy される。destroy 時に **session ID は消えるが action-log の awaiting_approval entry は残る**ため、ユーザーが古いカードをクリックすると「セッションが破棄されました。再ロード」ボタンが表示 → クリックで `formUrl` を再 navigate して新セッション生成 (既存 fill 状態は失われるので fresh フォーム)。

### 4.3 CAPTCHA 検出時の UI (§4.2 の特殊ケース)

CAPTCHA 検出は §4.2 の特殊ケースで、左ペインのバッジが 🔴 になり、ユーザーが直接 WebContentsView 内をクリックして解決:

1. `getFormStructure` の `meta.hasCaptcha === true` で検出
2. `browser_fill_form` で入力可能フィールドを埋める
3. `browser_take_screenshot('input')` → `ss-{No}-input.png` 保存
4. CLI 側で `awaiting_approval` log を記録 (details に `captchaType: 'recaptcha_v2_image' | 'hcaptcha' | ...`)
5. dashboard の awaiting_approval タブで該当社のカードが 🔴 表示
6. ユーザーがカードクリック → 右ペインに WebContentsView dock → CAPTCHA を解く
7. 「送信完了」ボタン押下 → `/api/log-action` で `submitted` 記録 → session destroy

reCAPTCHA v2 checkbox は **CLI 側で 1 回だけ `browser_click`** を試行可能 (CLAUDE.md 既存ルール準拠)。失敗 (image challenge) なら `awaiting_approval`。

---

## 5. reCAPTCHA / bot-detection への対応

### 5.1 WebContentsView の fingerprint 優位性

Electron の Chromium は **`navigator.webdriver === undefined`** (Playwright headless と異なる)。本物ブラウザに見える:
- `window.chrome` 存在
- WebGL renderer は実 GPU を反映
- Audio fingerprint 一致

注意: `webContents.debugger.attach` 中は `chrome://inspect` 表示 (サイト側 JS からは見えない)。`Runtime.evaluate` は isolated world で実行。

### 5.2 各種 CAPTCHA への対応マトリクス

| 種別 | 自動化可否 | 動作 |
|---|---|---|
| reCAPTCHA v2 checkbox | クリック 1 回 OK | `browser_click` で checkbox。image challenge 出たら諦め |
| reCAPTCHA v2 image challenge | NG | `awaiting_approval` |
| reCAPTCHA v3 invisible | 入力は可能 | フォーム入力 → 送信は人間 |
| hCaptcha | NG | `awaiting_approval` |
| Turnstile | 入力は可能 | フォーム入力 → 送信は人間 |
| Cloudflare bot gate (form 到達前) | NG | `error` ログ |

### 5.3 iframe-isolated reCAPTCHA への CDP アクセス

`Target.setAutoAttach({ autoAttach: true, waitForDebuggerOnStart: false, flatten: true })` で OOPIF を自動 attach、`Target.attachedToTarget` で sessionId 取得。flat mode で `sessionId` field を付けて送信。

**注意**: reCAPTCHA iframe 内に `Input.dispatchMouseEvent` を送ってもサイト側で reject (Google が `isTrusted:false` で fail させる)。**reCAPTCHA は引き続き「人間が解く」前提**。

---

## 6. 移行戦略

### Phase 1 (Week 1 前半 — 3 日)

**目標**: MCP server skeleton + 3 ツール (`browser_navigate` / `browser_snapshot` / `browser_take_screenshot`)。

成果物:
- `src/mcp-servers/sales-claw-form/server.cjs` (entry, stdio MCP loop)
- `src/mcp-servers/sales-claw-form/ipc-client.cjs` (named pipe client)
- `src/mcp-servers/sales-claw-form/tools/` (3 ファイル)
- `src/cdp-bridge.ts` (Electron 内、`webContents.debugger` ラッパ)
- `src/ipc-server.ts` (Electron 内、named pipe server)
- `bin/sales-claw-form-mcp.cjs` (薄いシム)

`data/settings.json::formFill.mode` は `"playwright"` 維持 (既存挙動)。

### Phase 2 (Week 1 後半 — 4 日)

**目標**: 残り 12 ツール実装 + form-session-manager UI 復活。

- 15 ツール完成、各々 mock 単体テスト
- `src/routes/form-session-api.ts` の 501 ガード解除 (mode が `internal`/`both` の時のみ)
- WebContentsView dock の hook を `electron-main.ts` で再有効化

### Phase 3 (Week 2 前半 — 3 日)

**目標**: A/B テスト + 既存回帰確認。

`formFill.mode=both` で同一 10 社に対して playwright/internal を交互に試行。

成功基準:
- フォーム検出成功率: internal >= playwright × 0.95
- フィールド mapping 一致率: >= 90%
- 平均所要時間: internal < playwright

### Phase 4 (Week 2 後半 — 3 日)

**目標**: default 切替 + 旧モード deprecate。

- `data/sample-settings.json` の `formFill.mode` を `"internal"` に
- migration: 未設定なら `"internal"` を書き込む
- CLAUDE.md 改訂
- リリース v2.1.0

### 6.5 Rollback

`data/settings.json::formFill.mode = "playwright"` に書き換えて managed AI session 再起動するだけ。**1 step**。

---

## 7. リスクと未解決事項

| # | リスク | 影響 | 緩和策 |
|---|---|---|---|
| R1 | `webContents.debugger.attach` 中は DevTools 不可 | デバッグ困難 | `?devtools=1` query で attach をスキップする escape hatch |
| R2 | MAX_SESSIONS=30 で頭打ち | 並列拡張時に課題 | LRU 既存。30 → 100 に上げる余地あり |
| R3 | Claude CLI が MCP を見つけられない | フォーム入力不可 | `ensureProviderInternalFormMcp` 自動 `claude mcp add` |
| R4 | Shadow DOM / nested iframe | 一部サイト fail | `DOM.getDocument({pierce:true, depth:-1})` で shadow root 貫通。OOPIF は §5.3 |
| R5 | `browser_evaluate` で任意 JS 実行 (LLM 出力) | XSS 的 / 機密漏洩 | isolated world、expression 4KB 上限、`document.cookie` allowlist 禁止 |
| R6 | `webContents.debugger` は同一 webContents に 1 attach のみ | 複数 MCP から不可 | CdpBridge をシングルトンに |
| R7 | `Input.dispatchKeyEvent` が `isTrusted:false` | reCAPTCHA / Cloudflare で reject | 送信ボタンは「人間が押す」原則維持 |
| R8 | OOPIF target が detach で消える | 状態管理複雑 | frame tree を 5 秒ごとに re-poll |
| R9 | MCP 仕様準拠度 | tool 発見不可 | 公式 `@modelcontextprotocol/sdk` (Node) を使う |
| R10 | Phase 4 後にユーザーが旧 CLAUDE.md 参照 | tool 名 mismatch | CLAUDE.md 改訂時に明示 |

---

## 8. 削減できる依存

| 依存 | 現状サイズ | 削除可否 (v2.1.0 GA 後) |
|---|---|---|
| `@playwright/mcp` パッケージ | ~5MB | **OK** (Phase 4 完了後) |
| Playwright Chromium bundle | ~200MB (cross-platform で 600MB) | **OK** (Electron 内蔵 Chromium で代替) |
| `playwright-mcp-wrapper.cjs` | 数 KB | **OK** |
| `PLAYWRIGHT_BROWSERS_PATH` 環境変数管理 | コード数百行 | **OK** |

**Phase 4 完了直後の v2.1.1 で削減**: インストーラーサイズ推定 200MB 減 (Win)。

MVP (v2.1.0) では Playwright を残し rollback 保証。**v2.2.0 で物理削除**。

---

## 9. テスト戦略

### 9.1 単体
- `tests/cdp-bridge.test.cjs`: `webContents.debugger` mock
- `tests/mcp-server-tools.test.cjs`: 各 tool の Zod validate + IPC signature
- `tests/ipc-protocol.test.cjs`: length-prefixed JSON frame encode/decode

### 9.2 統合
- `tests/e2e/internal-mcp-spawn.test.cjs`: `claude mcp list` 出力確認
- `tests/e2e/form-fill-roundtrip.test.cjs`: ローカル fixture form の往復

### 9.3 実機回帰
- 過去 3 ヶ月の `form_fill` 成功 entry を抽出 (50件以上)
- internal mode で再実行、screenshot 寸法 / フィールド数 / purpose 分類を比較
- **失敗率 5% 以下** が Phase 4 進行条件

---

## 10. スコープ外

- メールフォーム以外
- Phase A ロジック変更
- macOS / Linux
- 「人間が解いた CAPTCHA」の自動検出 (送信完了は人間が dashboard でクリック)
- `browser_console` / `browser_network` 等の補助 tool
- Playwright MCP 物理削除 (v2.2.0 で別 work item)

---

## Week 1 で最初に書くファイル

優先順:

1. **`src/cdp-bridge.ts`** — `webContents.debugger.attach('1.3')` ラッパ。OOPIF auto-attach。
2. **`src/ipc-server.ts`** — named pipe server。length-prefixed JSON frame、req/res mux。
3. **`src/mcp-servers/sales-claw-form/server.cjs`** — MCP server entry。`@modelcontextprotocol/sdk` の `Server` を stdio transport で起動。
4. **`src/mcp-servers/sales-claw-form/ipc-client.cjs`** — named pipe client。reconnect (3秒 × 5回)。
5. **`src/mcp-servers/sales-claw-form/tools/navigate.cjs`** — Phase 1 ツール 1/3。
6. **`src/mcp-servers/sales-claw-form/tools/snapshot.cjs`** — Phase 1 ツール 2/3。
7. **`src/mcp-servers/sales-claw-form/tools/screenshot.cjs`** — Phase 1 ツール 3/3。
8. **`bin/sales-claw-form-mcp.cjs`** — Claude CLI から spawn される薄いシム。`electron-builder.yml::extraResources` と `package.json::bin` に登録。
9. **`src/mcp-config-helpers.ts` への追加関数** — `shouldOverrideInternalFormMcpConfig(existing, platform)`。
10. **`tests/cdp-bridge.test.cjs`** — `webContents.debugger` mock テスト。

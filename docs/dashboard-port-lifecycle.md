# Dashboard Port / Runtime / Lock Lifecycle

このドキュメントは、Sales Claw のダッシュボードサーバ起動時の
**port / `dashboard-runtime.json` / `dashboard-server.lock` のライフサイクル**
を完全に説明し、stale (死亡 PID のゴミファイル) が原因の不具合を
再発させないためのリファレンスとして書かれています。

---

## TL;DR

1. **ダッシュボードのデフォルトポートは `3765`** (sample-settings.json / CLAUDE.md / port-utils 全て一致)
2. ユーザーは `data/settings.json::preferences.dashboardPort` で上書き可
3. サーバー起動時に `claimStandaloneDashboardLock` と `clearStaleRuntimes` が走り、
   **死亡 PID の lock / runtime.json を自動削除**
4. listen 完了直後に `writeRuntime` が新しい `runtime.json` を書く (PID も含む)
5. Electron renderer / cli-logger / action-logger は `readRuntime()` で port を引く。
   stale なファイルは `isRuntimeStale` で除外されるので、古い port を引いて
   「ネットワークに接続できません」エラーが出ることはない

---

## ファイルパス

| ファイル | 役割 |
|---|---|
| `data/settings.json::preferences.dashboardPort` | 希望ポート (preferredPort)。ユーザー設定 |
| `<dataDir>/dashboard-server.lock` | サーバープロセスの排他制御。`pid + startedAt + cwd` |
| `<dataDir>/dashboard-runtime.json` | listen 結果の公開ファイル。**`pid` 必須** (2.0.0-rc.1 以降) |
| `<dataDir>/dashboard-diagnostics.jsonl` | 起動時の cleanup / 異常イベントを追記する診断ログ |

`<dataDir>` の解決は実行モードで異なる:

| モード | dataDir |
|---|---|
| dev (`npx electron .`) | `C:\bp-outreach-ts\.electron-userdata\runtime\data\` (Electron userData) |
| インストール版 (`Sales Claw.exe`) | `%APPDATA%\sales-claw\runtime\data\` |
| standalone (`node dist-ts/src/dashboard-server.js`) | `C:\bp-outreach-ts\data\` |

> **dataDir 違いは「正しい設計」です**。同一マシン上で dev とインストール版を共存させて
> も lock / runtime / settings がぶつからない。
> `readRuntime()` は alternate path も走査するため、互いを発見できる仕組みになっている。

---

## 起動シーケンス (2.0.0-rc.1 以降)

```
1. ensureStandaloneDashboardLockHooks()
     SIGINT / SIGTERM / uncaughtException / 'exit' に releaseStandaloneDashboardLock を仕掛ける
     (= 異常終了時にも lock を消す)

2. claimStandaloneDashboardLock()
     a. lock ファイルを読む
     b. 既存 PID != self:
          - alive: URL に届けば「他インスタンス起動中」として ok:false で諦める
          - dead:  lock ファイルを実体削除 + 診断イベント
                  → "stale_dashboard_lock_cleaned" diagnostics
     c. 自分の lock を書く { pid: process.pid, startedAt, cwd }

3. clearStaleRuntimes()                              ★ NEW in 2.0.0-rc.1
     primary + alternates の dashboard-runtime.json を全部走査:
       - PID が書かれていて、死亡   → 削除
       - PID が無く、24h より古い    → 削除
       - JSON 壊れている / port 無し  → 削除
       - 生きてる + 新しい            → 触らない
     診断イベント: "stale_dashboard_runtime_cleaned" + removedCount + removedFiles

4. findAvailablePort(preferredPort, host)
     preferredPort から +20 試行。空いてるものを返す。
     全部塞がっていたら 0 を返し、起動失敗 → graceful shutdown

5. server.listen(port, host)
     成功すれば dashboardRuntime に書く準備

6. writeRuntime({ bindHost, host, port, preferredPort, pid: process.pid })
     listen が確定した address.port (= 実際のポート) を含めて runtime.json を書く
     ★ NEW in 2.0.0-rc.1: pid フィールドが必須化

7. refreshWatchTargets / startHeartbeat / その他 (省略)

8. (例外時) gracefulShutdown → releaseStandaloneDashboardLock → process.exit
     'exit' フックでも releaseStandaloneDashboardLock を呼ぶので
     SIGKILL でない限り lock ファイルは綺麗に消える
```

---

## stale 検出ロジック (`isRuntimeStale`)

```ts
function isRuntimeStale(runtime, now = Date.now()): boolean {
  // PID が書かれている場合は alive チェックを最優先
  if (runtime.pid > 0) {
    return !isPidAlive(runtime.pid);
  }
  // 旧形式 (PID 無し): startedAt が 24h 古ければ stale
  const startedAt = Date.parse(runtime.startedAt || '');
  if (!Number.isFinite(startedAt) || startedAt <= 0) return true;
  return (now - startedAt) > 24 * 60 * 60 * 1000;
}
```

`isPidAlive(pid)` は `process.kill(pid, 0)` を使う:
- 成功 → alive
- `EPERM` → alive (権限不足、生存だけは確定)
- `ESRCH` → dead
- pid が 0 / 負数 / NaN → dead

---

## 障害シナリオと挙動

### A. インストール版が `kill -9` でクラッシュ (lock 残置)

| 時刻 | 状態 |
|---|---|
| T1 | Sales Claw.exe (PID=100) 起動。lock = {pid:100, startedAt:T1}, runtime = {pid:100, port:3765} |
| T2 | クラッシュ。lock / runtime が残ったまま |
| T3 | ユーザーが再起動。Sales Claw.exe (PID=200) スタート |
| T3+ε | `claimStandaloneDashboardLock` が PID=100 を死亡判定 → lock 削除 → 自分のロック書き込み |
| T3+ε | `clearStaleRuntimes` が PID=100 の runtime を死亡判定 → 削除 |
| T3+δ | listen 成功 → `writeRuntime({pid:200, port:3765})` |

→ Electron renderer は `readRuntime()` で正しく PID=200, port:3765 を引く。再現したい問題は起こらない。

### B. ユーザーが `data/settings.json::dashboardPort` を 3456 に変更してから再起動

| 時刻 | 状態 |
|---|---|
| T1 | サーバー稼働中 (port:3765, PID=100) |
| T2 | サーバー停止。lock / runtime はクリア (graceful shutdown) |
| T3 | ユーザーが settings.json::dashboardPort を 3456 に変更 |
| T4 | 再起動。lock = {pid:200}, runtime = {pid:200, port:3456} |

→ 古い runtime.json (port:3765) は graceful shutdown 時に消えているので、3456 を正しく引く。

### C. preferred port が他プロセスで使われている

| 時刻 | 状態 |
|---|---|
| T1 | 他プロセスが port 3456 を使っている |
| T2 | Sales Claw 起動。`findAvailablePort(3456)` で 3457 が空いてれば 3457 を返す |
| T3 | listen 成功 → `writeRuntime({preferredPort:3456, port:3457})` |
| T3+ | UI に「設定ポート 3456 は使用中のため、現在は 3457 番で起動しています」と表示 |

→ ユーザーは「指定通りでないが代替で動いている」ことを認識できる。

### D. dev electron とインストール版を同時起動

dataDir が異なるので lock も runtime も衝突しない。それぞれが独立した
port / runtime を持つ。ただし port 番号がぶつかると後発が `findAvailablePort`
で別のポートに逃げる。

---

## デフォルト値の整合

| 場所 | デフォルト | 役割 |
|---|---|---|
| `src/settings-manager.ts::DEFAULT_SETTINGS` | `3765` | 設定ファイルが無い時の値 |
| `src/port-utils.ts::findAvailablePort` | `3765` | preferredPort が不正な時の fallback |
| `data/sample-settings.json` | `3765` | サンプル設定ファイル |
| `CLAUDE.md` | `3765` | ドキュメント |
| ユーザーの `data/settings.json` | (任意) | 個別設定。尊重する |

→ コード/サンプル/ドキュメント間で**完全に統一**されている。

---

## 改訂履歴

| 日付 | 内容 |
|---|---|
| 2026-05-14 | 初版。stale cleanup + PID 検証 (2.0.0-rc.1) |

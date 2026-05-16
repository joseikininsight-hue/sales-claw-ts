English version: [release-parity-and-autoupdate.md](../release-parity-and-autoupdate.md)

# リリースパリティと自動アップデートのガードレール

Sales Claw には 4 つの異なる実行サーフェスがあります:

- プレビューダッシュボード: `npm run dashboard:preview` (`http://127.0.0.1:3480`)
- 開発用 Electron: `npm start`
- ランディング / Web 開発: `npm run lp:dev`
- インストール済みデスクトップアプリ: `dist/` 配下のパッケージファイル or Windows インストールディレクトリ

運用ダッシュボードの真実の源 (source of truth) は
`src/dashboard-server.cjs` + `src/ui/**` + `src/routes/**` です。
プレビューダッシュボードと Electron はこの同じソースから起動する必要があります。
`.claude/worktrees/*` のプレビュー (port 3480) は、コードがリポジトリ root に
マージされ `npm run verify:release` が通るまでは、リリース済み・デスクトップ準備完了とは見なしません。

インストール済みデスクトップアプリは作業ツリーを直接読みません。
デスクトップユーザーに届けるべき UI / バックエンド / 設定変更には、
**version bump + パッケージ Electron ビルド + GitHub Releases 更新メタデータ**が必要です。

インストール済みビルドは起動後すぐに、その後アプリが開いている間定期的に
GitHub Releases をチェックします。ダッシュボードヘッダーには手動アップデート
チェックボタンも提供されています。アップデートが既にダウンロード済みの場合、
このコントロールは `electron-main.js` が監視するアップデータフラグ経由で
restart-and-install を要求できます。

## 必須チェック

デスクトップアプリが最新であると言う前に必ず実行してください:

```bash
# 1. リリース準備チェック (41 項目)
npm run verify:release

# 2. パッケージビルド (Windows)
npm run dist:win -- --publish never

# 3. ビルド成果物の検証
npm run verify:dist

# 4. push → GitHub Actions auto-release
git push origin main

# 5. 公開後の検証
npm run verify:github
```

## 自動リリースパイプライン (v1.2.110+)

`main` への push が以下を自動実行:

1. `.github/workflows/release.yml` が `v{package.json version}` タグを作成
2. Windows / macOS / Linux でビルド
3. GitHub Releases に publish
4. `latest.yml` の 0KB regression と CDN 疎通の自動チェック

## ユーザーへの到達経路

インストール済みアプリは:
- 起動 5 秒後 + 6 時間ごとに `latest.yml` をチェック
- 新版があれば自動ダウンロード → 「再起動してアップデート」を表示
- ダッシュボードヘッダの「Check for updates」ボタンは packaged Electron でのみ動作 (dev mode の `app.isPackaged=false` では disabled)

## トラブルシューティング

| 症状 | 原因 | 対処 |
|---|---|---|
| `latest.yml` が 404 | リリース未公開 | GitHub Actions ログを確認 |
| `latest.yml` 0KB | publish 失敗 | `verify:dist` を再実行 |
| アップデート通知が出ない | API レート制限 / Firewall | 手動チェックボタンで再試行 |

詳細は英語版 [release-parity-and-autoupdate.md](../release-parity-and-autoupdate.md) を参照。

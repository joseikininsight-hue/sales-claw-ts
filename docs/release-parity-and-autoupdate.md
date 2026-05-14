# Release Parity and Auto Update Guardrails

Sales Claw has four different runtime surfaces:

- preview dashboard: `npm run dashboard:preview` on `http://127.0.0.1:3480`
- development Electron: `npm start`
- landing/web development: `npm run lp:dev`
- installed desktop app: packaged files under `dist/` or the Windows install directory

The operational dashboard source of truth is `src/dashboard-server.cjs` plus `src/ui/**` and `src/routes/**`. The preview dashboard and Electron must start that same source. Do not treat a `.claude/worktrees/*` preview on port 3480 as released or desktop-ready until the code has been merged back to the repository root and `npm run verify:release` passes.

The installed desktop app never reads the working tree directly. Any UI, backend, or setting change that must reach desktop users needs a version bump, a packaged Electron build, and GitHub Releases update metadata.

Installed builds check GitHub Releases shortly after startup and then periodically while the app remains open. The dashboard header also exposes a manual update check button. If an update has already been downloaded, that same control can request restart-and-install via the updater flag watched by `electron-main.js`.

## Mandatory Checks

Run these before saying the desktop app is latest:

```bash
npm run verify:release
npm run dist:win -- --publish never
npm run verify:dist
```

For local installation on Windows:

```powershell
npm run install:win
npm run verify:installed
```

`verify:installed` is strict. It checks both the current-user install and the all-users install. If an old all-users install remains under `C:\Program Files\Sales Claw`, clean it from an elevated PowerShell or reinstall with `scripts/install-latest-win.ps1 -AllUsers`.

For all-users installation, open an elevated PowerShell and run:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/install-latest-win.ps1 -AllUsers
```

## What The Gate Enforces

`scripts/verify-release-readiness.ts` (via `tsx`) fails the build if:

- `package.json` and `package-lock.json` versions diverge
- `electron-builder.yml` does not point to `joseikininsight-hue/sales-claw-ts`
- `publishAutoUpdate: true` or `channel: latest` is missing
- `local-test`, `${env.GH_OWNER}`, or `${env.GH_REPO}` remains in the update feed
- Release workflow does not upload the installer, `.blockmap`, and `latest*.yml`
- packaged `app-update.yml` does not point to the real GitHub Releases feed
- packaged `latest.yml` does not match the current package version
- dev-only directories such as `.claude`, `.electron-userdata`, `.aidesigner`, `.code-review-graph`, or `dist` are packaged into the desktop app

`scripts/verify-surface-parity.ts` (via `tsx`) fails the build if:

- the operational dashboard no longer imports the shared UI bundles
- the dashboard theme toggle or dark theme tokens disappear
- preview stops loading `../dist-ts/src/dashboard-server`
- Electron stops using the root dashboard server
- local vendor assets are missing from the package filters

## Release Flow

### Automatic (推奨) — main push → 自動タグ → GitHub Releases

v1.2.110 以降は **main ブランチに push するだけ** で自動リリースが走る。

1. `package.json` の `version` を上げる（`npm version X.Y.Z --no-git-tag-version`）
2. `npm run verify:release` が通ることを確認
3. `git commit` して `git push origin main`
4. GitHub Actions が自動的に:
   - `v{version}` タグを作成・push (タグが未存在の場合のみ)
   - Windows / macOS / Linux を並列ビルド
   - `latest.yml` が正常サイズであることをチェック（0KB なら fail）
   - GitHub Releases に公開（`latest.yml`, `latest-*.yml` を含む）
   - CDN 伝播後に `latest.yml` の疎通確認

5. リリース後の確認: `npm run verify:github` で GitHub Releases の状態を検証

### Manual (タグを手動で push する場合)

1. Finish code changes.
2. Bump `package.json` with `npm version X.Y.Z --no-git-tag-version`.
3. Run `npm run verify:release`.
4. Run `npm run dist:win -- --publish never`.
5. Run `npm run verify:dist`.
6. Install locally with `npm run install:win` or elevated `scripts/install-latest-win.ps1 -AllUsers`.
7. Commit and tag `vX.Y.Z`.
8. Push the tag: `git push origin vX.Y.Z`

### リリース後の確認

```bash
# GitHub Releases に latest.yml が正しく存在するか確認
npm run verify:github
```

エラー例:
- `FAIL github: release v1.2.110 not found` → タグが push されていない
- `FAIL github: latest.yml is 0 bytes` → ビルドの artifact upload に失敗
- `FAIL github: latest release is v1.2.65 but package.json version is v1.2.110` → 古いリリースが Latest になっている

## Auto-Update Flow (ユーザー側)

```
[インストール済み Sales Claw が起動]
  ↓ 5秒後
[electron-updater が GitHub Releases/latest.yml を fetch]
  ├─ owner: joseikininsight-hue
  ├─ repo: sales-claw-ts
  ├─ channel: latest
  └─ キャッシュなし (Cache-Control: no-cache)
  ↓
新バージョンあり → ダイアログ + バックグラウンド DL (6時間ごとに自動再チェック)
  ↓
DL 完了 → 「再起動で更新」ダイアログ
  ↓
ダッシュボードヘッダーの「アップデート確認」ボタン:
  POST /api/check-update → flag ファイル → electron-main が checkForUpdates('manual')
  GET  /api/update-status → update-status.json → ボタン表示を更新
```

**注意**: ダッシュボードの「アップデート確認」は **Electron インストール版のみ** 動作する。
`npm run dashboard:preview` の開発サーバーでは `app.isPackaged=false` のため `AUTO_UPDATE_ENABLED=false` になる。

## Claude Code / Codex Rules

- Do not treat `npm start`, `dashboard:preview`, or `lp:dev` as proof that the installed desktop app is updated.
- Do not leave the latest operational dashboard in `.claude/worktrees/*`; merge it into the root `src/dashboard-server.cjs`, `src/ui/**`, and `src/routes/**`.
- Do not edit installed files under `C:\Program Files` or `%LOCALAPPDATA%\Programs\Sales Claw` by hand.
- Do not use `local-test` or env-substituted owner/repo values in `electron-builder.yml`.
- Do not tell the user auto-update is ready until `npm run verify:dist` passes.
- If the installed app is old, install the latest generated setup with `scripts/install-latest-win.ps1`; do not rely on an old `local-test` build to self-update.

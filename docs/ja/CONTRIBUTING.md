# Contributing to Sales Claw

Sales Claw への貢献に興味を持っていただきありがとうございます。
バグ報告・機能要望・PR・ドキュメント改善・翻訳など、あらゆる貢献を歓迎します。

## 行動規範

このプロジェクトは [Code of Conduct](./CODE_OF_CONDUCT.md) を採用しています。
PR や Issue を出す前に必ず一読してください。

## セキュリティ

セキュリティ上の問題は **公開 Issue を立てずに**、
[SECURITY.md](./SECURITY.md) の手順に従って報告してください。

---

## クイックスタート (開発環境構築)

### 必要なもの

- Node.js 22 以上 ([nodejs.org](https://nodejs.org/))
- Git
- AI CLI のいずれか (`claude` / `codex` / `gemini`) — テスト時に使用

### セットアップ

```bash
git clone https://github.com/joseikininsight-hue/sales-claw-ts.git
cd sales-claw-ts
npm install
# 初回のみ: サンプル設定をコピー
npm run setup
# Playwright ブラウザバイナリを入れる
npx playwright install chromium
# 起動
npm start
```

`npm start` で Electron デスクトップアプリが立ち上がります。
ダッシュボード単体を確認したいときは:

```bash
npm run dashboard:preview  # http://127.0.0.1:3480
```

### 開発フロー

```bash
# 監視ビルド (別ターミナルで)
npm run build:watch

# 型チェック
npm run typecheck

# Lint (warnings 1100+ あるが errors は 0 が要求される)
npm run lint

# Unit テスト
npm run test:unit

# 公開準備チェック
npm run verify:release
```

---

## PR を出す前に

1. **`npm run typecheck`** で 0 errors
2. **`npm run lint`** で 0 errors (warnings は許容)
3. **`npm run test:unit`** で全件パス
4. **CHANGELOG.md** に変更を 1-2 行追記
5. **関連 docs/** を更新 (該当する場合)
6. 機能追加の場合: 関連テストを追加
7. バグ修正の場合: 再現するテストを先に追加して、fix で通ることを保証

## コミットメッセージ

[Conventional Commits](https://www.conventionalcommits.org/) に準拠してください。

例:
- `feat: List Builder にカテゴリモードを追加`
- `fix: dashboard-server の stale lock を起動時に削除`
- `refactor: dashboard-runtime.ts の型を厳格化`
- `docs: README に 2.0.0 リリース情報を追記`
- `test: spawn-env-sanitizer のテストカバレッジ拡充`
- `chore: deps - eslint 10.4 へ更新`
- `ci: release.yml の matrix に macos-13 を追加`

破壊的変更がある場合は `feat!:` や `fix!:` のように `!` を付けるか、
本文に `BREAKING CHANGE: <内容>` を含めてください。

---

## コーディング規約

### TypeScript

- `src/` 配下は **TypeScript で書く**（`.cjs` の新規追加は原則禁止）
- 新規コードでは `any` を**使わない** (既存 949 件は段階移行中)
- `unknown` + 型ガードで narrow する。`src/types/helpers.ts` のヘルパーを活用
- `parseJsonAs<T>` / `Result<T, E>` / `isPlainObject` / `getString` 等
- `null` / `undefined` は厳密に扱う (`strictNullChecks: true`)
- 関数の引数・返り値は明示的な型注釈を推奨

### ファイル分割

- 200-400 行を目安、最大 800 行
- 1 ファイル 1 責務
- `src/types/` 配下で共有型を定義し、循環依存を避ける

### コメント

- WHY を書く (WHAT はコードが語る)
- ハック・回避策・暫定対応には理由を明記
- TODO は `TODO(issue #123)` のように issue 番号を付けて追跡可能に

---

## プロジェクト構造

```
src/
├── *.ts                     コアロジック (47 ファイル, 100% TS)
├── ai-runtime/             Claude / Codex / Gemini プロセス管理
├── list-builder/           企業リスト発見 (URL / NLQ / カテゴリモード)
├── routes/                 ダッシュボード API ハンドラ
├── types/                  共有型定義 + 型ヘルパー (helpers.ts)
└── ui/client-scripts/      ブラウザ側スクリプト (TS / esbuild bundle)

dist-ts/                    tsc + esbuild ビルド成果物 (.gitignore 済み)
docs/                       設計・運用ドキュメント
scripts/                    ビルド・検証スクリプト
tests/                      Node 直接実行ユニットテスト (.test.cjs)
.github/workflows/          CI (ci.yml) + Release (release.yml)
```

詳細な設計判断:
- [docs/typescript-migration-roadmap.md](./docs/typescript-migration-roadmap.md) — TS化のステージプラン
- [docs/dashboard-port-lifecycle.md](./docs/dashboard-port-lifecycle.md) — ポート / runtime.json / lock の動き
- [docs/programmatic-credit-migration.md](./docs/programmatic-credit-migration.md) — Anthropic 2026-06-15 ポリシー対応
- [docs/release-parity-and-autoupdate.md](./docs/release-parity-and-autoupdate.md) — リリース・自動更新
- [docs/list-builder-requirements.md](./docs/list-builder-requirements.md) — List Builder 仕様

---

## テスト

ユニットテストは `tests/*.test.cjs` に配置し、Node が直接実行します。

```bash
node tests/spawn-env-sanitizer.test.cjs
node tests/analysis-cache.test.cjs
# あるいは全部
npm run test:unit
```

新規テストを追加したら **`package.json::test:unit`** にも追加してください。

E2E テストは Playwright を使います:

```bash
npm test  # test:unit + playwright test
```

### テスト方針

- **境界条件を必ず網羅**: 空文字 / null / undefined / 0 / 負数 / 巨大数
- **失敗パスも書く**: 「成功」だけでなく「失敗時に正しく失敗するか」
- **副作用を最小化**: ファイル I/O は tmpdir に隔離
- **deterministic に**: タイマー・乱数は固定値を使う

---

## リリース手順

リリースは自動化されています:

1. `package.json::version` を更新 (semver, 例: `2.0.0` → `2.0.1`)
2. `CHANGELOG.md` の Unreleased を新バージョン見出しに移動
3. `main` ブランチに push
4. `.github/workflows/release.yml` が自動的に:
   - `v{version}` タグを作成
   - Win / Mac / Linux でビルド
   - GitHub Releases に publish
5. 数時間以内にインストール済みアプリへ自動更新が届きます

詳細: [docs/release-parity-and-autoupdate.md](./docs/release-parity-and-autoupdate.md)

---

## レビュアー向け補足

PR レビュー時のチェックポイント:

- **Programmatic Credit** に関わる変更 (`claude -p` / `spawn` env) は
  `spawn-env-sanitizer` を通っているか
- **dashboard-server** の起動シーケンスを変える場合は
  `clearStaleRuntimes` / `claimStandaloneDashboardLock` の整合性確認
- **ブラウザ inline スクリプト** の追加は `src/ui/client-scripts/` 配下、
  esbuild が拾えるエントリ
- **新規 secret / API key** は `data/settings.json::apiKeys` 経由のみ、
  ログには露出しない (`redact.ts` のテストでカバー)
- **lint warning が増える場合**: 増加件数の根拠を PR 説明に書く

## ライセンス

PR を提出することで、あなたの貢献は MIT License の下でライセンスされることに同意したものとみなされます。

ご協力ありがとうございます。

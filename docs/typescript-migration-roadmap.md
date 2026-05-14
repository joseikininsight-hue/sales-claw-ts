# TypeScript Migration Roadmap

このドキュメントは Sales Claw を「動く CJS プロジェクト」から「型安全な
TypeScript プロジェクト」に育てるための**長期計画**を記載します。
個別の修正は PR 単位で進め、完了したらこのドキュメントを更新してください。

---

## 現状 (2.0.0-rc.1, 2026-05-14)

| 指標 | 数値 |
|---|---|
| `.ts` ファイル | 89 |
| `@ts-nocheck` | 1 (`src/ai-runtime/pty-log.ts`) |
| `: any` 使用 | **747** |
| `: any[]` 使用 | 89 |
| `Record<string, any>` 使用 | 85 |
| `Promise<any>` 使用 | 22 |
| `as any` 使用 | 6 |
| **合計 any 関連** | **949** |
| Unit test | 130 件 / 全パス |
| Typecheck | 0 errors |
| Lint | 0 errors / 1129 warnings (主に any 由来) |

## 目標

1. **新規 any の混入を止める** — CI でガード、PR でレビュー
2. **既存 any を段階削減** — 高頻度ファイルから順に対処
3. **outDir 設計の整理** — `src/**/*.js` (build artifact) と hand-written CJS を分離

---

## Stage 1: 防御線の構築 (✅ 2.0.0-rc.1 で完了)

新規 `any` を防ぐ仕組みを整える。**既存 any は触らない。**

- [x] `@typescript-eslint/no-explicit-any` を warn でルール化 (CI で可視化)
- [x] `src/types/helpers.ts` に型ヘルパー (`parseJsonAs` / `Result` / `getString` / `isPlainObject` 等) を整備
- [x] CI workflow (`.github/workflows/ci.yml`) で typecheck / lint / unit test を全プラットフォームで回す
- [x] このロードマップを docs/ に配置

---

## Stage 2: 既存 any の段階削減 (進行中)

Top 15 ファイル (any 件数の 70% を占める) から順に修正する。1 PR = 1 ファイル単位
の小粒コミットで進めて、機能リグレッションのリスクを下げる。

### 優先順位 (件数の多い順)

| 順位 | ファイル | any 件数 | 状況 |
|---|---|---|---|
| 1 | `src/dashboard-server.ts` | 262 | ⏳ pending (要 9540 行 → 分割と並行) |
| 2 | `src/parallel-analysis.ts` | 37 | ⏳ pending |
| 3 | `src/local-toolchain.ts` | 37 | ⏳ pending |
| 4 | `src/routes/simple-api.ts` | 34 | ⏳ pending |
| 5 | `src/settings-excel.ts` | 28 | ⏳ pending |
| 6 | `src/form-session-manager.ts` | 25 | ⏳ pending |
| 7 | `src/target-list.ts` | 24 | ⏳ pending |
| 8 | `src/approval-artifacts.ts` | 24 | ⏳ pending |
| 9 | `src/ai-runtime/parallel-dispatcher.ts` | 22 | ⏳ pending |
| 10 | `src/sendability-gate.ts` | 20 | ⏳ pending |
| 11 | `src/routes/list-builder-api.ts` | 20 | ⏳ pending |
| 12 | `src/official-site-resolver.ts` | 20 | ⏳ pending |
| 13 | `src/message-quality-gate.ts` | 20 | ⏳ pending |
| 14 | `src/routes/settings-api.ts` | 18 | ⏳ pending |
| 15 | `src/routes/ai-runtime-api.ts` | 17 | ⏳ pending |

これだけで any 約 600 件を消化できる。

### 各 PR の標準フォーム

```
タイトル: [ts-migration] <ファイル名>: any → 具体型

差分:
- as any / : any を src/types/helpers.ts のガード関数で narrow
- JSON.parse 系は parseJsonAs を使う
- catch (e) は catch (e: unknown) + errorMessage(e)
- 関数の引数は最低限 unknown → ガード で narrow
- イベントハンドラの引数は具体的な型 (Buffer / string) に

確認:
- npm run typecheck (errors 0)
- npm run test:unit (failures 0)
- npm run lint (errors 0, warnings 件数が事前比で減少)
- 機能のリグレッションテスト (手動 or playwright)
```

### Stage 2 完了の判定基準

- `: any` を **300 件以下** (62% 削減)
- `Record<string, any>` を `Record<string, unknown>` に置換 (型ガードで narrow)
- `Promise<any>` を `Promise<unknown>` か具体型に置換 (0 件目標)

---

## Stage 3: 厳格化 (中長期)

- [ ] `@typescript-eslint/no-explicit-any` を **error** に昇格
- [ ] `tsconfig.json` に `noImplicitAny: true` を追加
- [ ] `tsconfig.json` に `noUncheckedIndexedAccess: true` を追加 (配列アクセスの undefined を強制チェック)
- [ ] `src/ai-runtime/pty-log.ts` の `@ts-nocheck` を解除

---

## Stage 4: 構造の整理

### outDir の分離

現状 `tsconfig.json` は `rootDir: "."` / `outDir: "."` で、`.ts` と `.js` が
同じディレクトリに出力される。これは以下の問題がある:

- hand-written `.cjs` ファイルと TS 出力 `.js` が見分けにくい
- `git status` が build 後に汚れる
- `.gitignore` ルールが複雑になる

**修正案**: `outDir: "dist-ts"` に変更し、参照を一括置換。

影響範囲:
- `package.json` の `main`, `start`, `dashboard` script
- `electron-main.ts` 内の require パス (相対のまま動くが要確認)
- `tsconfig.json` の `rootDir` / `outDir`
- `.gitignore` に `dist-ts/` を追加
- `electron-builder.yml` の `files` パターン
- すべての `require('./xxx')` パス (現状 `src/xxx.js` 想定 → `dist-ts/src/xxx.js`)

これは独立 PR で実施する。実施前にバックアップ + 全テスト通過を保証すること。

### dashboard-server.ts の分割 (9540 行)

dashboard-server.ts が単一ファイルで肥大化している。
ガイドライン (200-400 行 / 最大 800 行) を大きく超える。

**分割案**:
- `dashboard-server/index.ts` — エントリポイント + Express セットアップ
- `dashboard-server/middleware.ts` — auth / cors / logging
- `dashboard-server/managed-provider-home.ts` — provider-home 管理
- `dashboard-server/batch-orchestrator.ts` — runParallelAnalysisWorker 周辺
- `dashboard-server/ai-runtime-manager.ts` — Claude/Codex/Gemini プロセス管理
- `dashboard-server/recovery.ts` — クラッシュリカバリ

この分割は **Stage 2 と並行して進めない方が良い** (リファクタの衝突を避ける)。

---

## メトリクス取得スクリプト

進捗確認用に以下を Bash で実行:

```bash
# any 関連の総数
grep -rcE ": any\b|Promise<any>|Record<string, any>|<any>|as any" src --include="*.ts" \
  | awk -F: '{sum += $2} END {print sum}'

# ファイル別 Top 15
grep -rcE ": any\b|Promise<any>|Record<string, any>|<any>|as any" src --include="*.ts" \
  | sort -t: -k2 -rn | head -15

# @ts-nocheck の残数
grep -rE "@ts-nocheck" src --include="*.ts" | wc -l

# Stage 完了判定
npm run typecheck && npm run lint && npm run test:unit
```

---

## 改訂履歴

| 日付 | 内容 |
|---|---|
| 2026-05-14 | 初版 (Stage 1 完了、Stage 2 計画) |

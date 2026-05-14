# Browser Client Scripts (Stage 4.5)

このディレクトリは **ブラウザで実行される TypeScript コード**の置き場所です。
Stage 4.5 (`docs/typescript-migration-roadmap.md` 参照) で確立しました。

## 目的

`src/ui/client-scripts/*.ts` の中の `const SCRIPT = \`...\`` テンプレートリテラル
内に閉じ込められたブラウザ JS を、ここに**真の TypeScript ファイル**として
段階的に切り出していく。

切り出されたファイルは:
- `tsconfig.browser.json` で型チェック (`lib: ["DOM"]` 付き)
- esbuild が `bundle: true / platform: 'browser' / format: 'iife'` でバンドル
- 出力 JS を 親の `xxx.ts` が読み込んで `<script>` 注入

## ステータス

**Stage 4.5 は土台のみ完了**:
- ✅ `tsconfig.browser.json` 新規 (DOM types 有効、isolatedModules)
- ✅ このディレクトリ作成
- ⏳ 各 client-script の本格切り出しは個別 PR で実施

## 今後の作業 (個別 PR で実施)

1. `src/ui/client-scripts/provider-icon-fix/` を proof-of-concept で完全分離
   - `style.ts` — CSS 文字列定数
   - `browser.ts` — 実際の browser TS (`document.createElement` 等が型補完される)
2. 親の `provider-icon-fix.ts` を loader 化 (style + 出力 bundle を返すだけ)
3. `scripts/bundle-client-scripts.ts` を browser 用バンドルに対応
4. 動作確認後、他の client-script も順次同パターンに置換

## なぜ Stage 4.5 を急がないか

- 現状でも `.ts` ファイル化 (Stage 4 まで) は完了している
- ブラウザコードの型補完が無いだけで、機能には影響しない
- 一気にやると 100K トークン超の `dashboard.ts` 解体で巨大 PR になる
- Stage 2 (`as any` 削減) と並行不可 (リファクタの衝突)

詳細: [docs/typescript-migration-roadmap.md](../../../../docs/typescript-migration-roadmap.md)

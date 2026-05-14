'use strict';

/**
 * bundle-client-scripts.cjs
 * ─────────────────────────
 *
 * `src/ui/client-scripts/*.ts` を esbuild でトランスパイルして
 * `dist-ts/src/ui/client-scripts/*.js` に出力する。
 *
 * これらのファイルは Node CJS モジュールとして dashboard-server.ts から
 * `require()` され、`module.exports = function(): string` で
 * 「ブラウザに inline 注入するための文字列」を返す。
 *
 * 役割分担:
 *   - tsc (npm run build の前段) は src/ 配下の .ts を dist-ts/ に
 *     コンパイルする。
 *   - tsc は src/ui/client-scripts/*.ts も拾うが、テンプレートリテラル内の
 *     ブラウザ JS は単なる string なので追加処理は不要。
 *   - 本スクリプトは esbuild で「ブラウザ JS をテンプレートから外に
 *     出した時」(将来の Stage 4.5) にバンドルする土台として用意する。
 *     現状は冪等 no-op に近いが、esbuild の存在で次のステップへの
 *     ジャンプ台が完成する。
 *
 * 設計:
 *   - bundle: false  → tsc 出力を尊重。esbuild は CJS→CJS transform で
 *                       Node 用に確認のみ。
 *   - platform: 'node' / format: 'cjs' / target: 'node20'
 *   - sourcemap: true
 *   - 出力先は dist-ts/ なので tsc 出力を上書きする
 *
 * 将来 (Stage 4.5): ブラウザコードを別 .ts ファイルに切り出して
 *   esbuild の bundle: true / platform: 'browser' で正規バンドル化する。
 *   その時は loader を adjust するだけ。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'src', 'ui', 'client-scripts');
const OUT_DIR = path.join(ROOT, 'dist-ts', 'src', 'ui', 'client-scripts');

async function main() {
  if (!fs.existsSync(SRC_DIR)) {
    console.warn('[bundle-client-scripts] src dir missing, skip:', SRC_DIR);
    return;
  }

  const entries = fs.readdirSync(SRC_DIR)
    .filter((f) => f.endsWith('.ts'));

  if (entries.length === 0) {
    console.log('[bundle-client-scripts] no .ts files in', SRC_DIR);
    return;
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  let esbuild;
  try {
    esbuild = require('esbuild');
  } catch (e) {
    console.error('[bundle-client-scripts] esbuild not installed. Run `npm install`.');
    process.exit(1);
    return;
  }

  const t0 = Date.now();
  let built = 0;

  for (const file of entries) {
    const inFile = path.join(SRC_DIR, file);
    const outFile = path.join(OUT_DIR, file.replace(/\.ts$/, '.js'));

    await esbuild.build({
      entryPoints: [inFile],
      outfile: outFile,
      // Node 側で dashboard-server.ts が require() する CJS モジュールとして出力
      bundle: false,        // tsc が依存を解決するため不要
      platform: 'node',
      format: 'cjs',
      target: 'node20',
      sourcemap: true,
      // template literal 内の改行を保ったままにする (ブラウザ JS の整形維持)
      minify: false,
      keepNames: true,
      // 'use strict' が複数発生するのを抑止
      banner: { js: '"use strict";' },
      logLevel: 'warning',
    });
    built += 1;
  }

  const elapsed = Date.now() - t0;
  console.log(`[bundle-client-scripts] built ${built} file(s) in ${elapsed}ms → ${path.relative(ROOT, OUT_DIR)}`);
}

main().catch((err) => {
  console.error('[bundle-client-scripts] FAILED:', err && err.message || err);
  process.exit(1);
});

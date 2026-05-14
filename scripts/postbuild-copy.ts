'use strict';

/**
 * tsc は .ts のみコンパイルし、.json / その他リソースは出力先にコピーしない。
 * outDir: ./dist-ts への分離に伴い、以下を dist-ts 配下にミラーする postbuild step。
 *   - package.json (simple-api.ts が require する)
 *
 * 2.0.0 で client-scripts は .cjs → .ts 化された。
 *   - tsc が src/ui/client-scripts/*.ts を dist-ts/src/ui/client-scripts/*.js に
 *     コンパイルし、bundle-client-scripts.cjs (esbuild) がさらに整形する。
 *   - 残置された古い .cjs を起動時に拾わないよう、dist-ts 側の stale .cjs は
 *     本スクリプトが削除する。
 *
 * 冪等。何度実行しても safe。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIST_TS = path.join(ROOT, 'dist-ts');

let copied = 0;
let skipped = 0;

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function copyFileIfNewer(src, dst) {
  if (!fs.existsSync(src)) return;
  ensureDir(path.dirname(dst));
  try {
    const srcStat = fs.statSync(src);
    if (fs.existsSync(dst)) {
      const dstStat = fs.statSync(dst);
      if (dstStat.mtimeMs >= srcStat.mtimeMs && dstStat.size === srcStat.size) {
        skipped += 1;
        return;
      }
    }
    fs.copyFileSync(src, dst);
    copied += 1;
  } catch (e) {
    console.error(`[postbuild-copy] failed to copy ${src} -> ${dst}: ${e.message}`);
  }
}

function mirrorDir(srcDir, dstDir, filter) {
  if (!fs.existsSync(srcDir)) return;
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = path.join(srcDir, entry.name);
    const dstPath = path.join(dstDir, entry.name);
    if (entry.isDirectory()) {
      mirrorDir(srcPath, dstPath, filter);
      continue;
    }
    if (entry.isFile() && (!filter || filter(entry.name))) {
      copyFileIfNewer(srcPath, dstPath);
    }
  }
}

// 1) dist-ts/src/ui/client-scripts/ の stale .cjs を削除 (2.0.0 で .cjs → .ts 化済み)
const CLIENT_SCRIPTS_DST = path.join(DIST_TS, 'src', 'ui', 'client-scripts');
let removed = 0;
if (fs.existsSync(CLIENT_SCRIPTS_DST)) {
  for (const entry of fs.readdirSync(CLIENT_SCRIPTS_DST)) {
    if (entry.endsWith('.cjs')) {
      try {
        fs.unlinkSync(path.join(CLIENT_SCRIPTS_DST, entry));
        removed += 1;
      } catch (e) {
        console.warn(`[postbuild-copy] failed to remove stale ${entry}: ${e.message}`);
      }
    }
  }
}

// 2) package.json を dist-ts/ にコピー (simple-api.ts が require する)
copyFileIfNewer(path.join(ROOT, 'package.json'), path.join(DIST_TS, 'package.json'));

console.log(`[postbuild-copy] copied=${copied} skipped=${skipped} removed_stale_cjs=${removed}`);

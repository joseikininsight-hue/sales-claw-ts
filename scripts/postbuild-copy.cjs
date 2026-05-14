'use strict';

/**
 * tsc は .ts のみコンパイルし、.cjs / .json / その他リソースは出力先にコピーしない。
 * outDir: ./dist-ts への分離に伴い、dashboard-server.js が require する
 *   - src/ui/client-scripts/*.cjs  (手書きのブラウザスクリプト)
 *   - package.json                  (バージョン参照用)
 * を dist-ts 配下にミラーする postbuild step。
 *
 * 冪等。何度実行しても safe (mtime ベースで copy をスキップ)。
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

// 1) src/ui/client-scripts/**/*.cjs を dist-ts/src/ui/client-scripts/ にミラー
const CLIENT_SCRIPTS_SRC = path.join(ROOT, 'src', 'ui', 'client-scripts');
const CLIENT_SCRIPTS_DST = path.join(DIST_TS, 'src', 'ui', 'client-scripts');
mirrorDir(CLIENT_SCRIPTS_SRC, CLIENT_SCRIPTS_DST, (name) => name.endsWith('.cjs') || name.endsWith('.js'));

// 2) package.json を dist-ts/ にコピー (simple-api.ts が require する)
copyFileIfNewer(path.join(ROOT, 'package.json'), path.join(DIST_TS, 'package.json'));

console.log(`[postbuild-copy] copied=${copied} skipped=${skipped}`);

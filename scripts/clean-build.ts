'use strict';

/**
 * tsc が src/ と repo root に出力する .js / .js.map / .tsbuildinfo を削除する。
 *
 * 削除対象:
 *   - src/**\/*.js, src/**\/*.js.map  (ただし sibling の .ts が存在するもののみ)
 *   - electron-main.js, electron-main.js.map
 *   - .tsbuildinfo
 *
 * 削除しないもの:
 *   - src/ui/client-scripts/*.cjs, *.js  (手書きのブラウザスクリプト)
 *   - dist/, dist-released/, node_modules/  (本スクリプトの管轄外)
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const CLIENT_SCRIPTS = path.join(SRC, 'ui', 'client-scripts');

let deleted = 0;

function isInClientScripts(filePath) {
  const norm = path.normalize(filePath);
  const clientNorm = path.normalize(CLIENT_SCRIPTS);
  return norm.startsWith(clientNorm + path.sep) || norm === clientNorm;
}

function walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
      continue;
    }
    if (!entry.isFile()) continue;
    if (isInClientScripts(full)) continue;
    const isJs = full.endsWith('.js');
    const isJsMap = full.endsWith('.js.map');
    if (!isJs && !isJsMap) continue;
    const tsSibling = isJsMap
      ? full.replace(/\.js\.map$/, '.ts')
      : full.replace(/\.js$/, '.ts');
    if (fs.existsSync(tsSibling)) {
      try {
        fs.unlinkSync(full);
        deleted += 1;
      } catch (e) {
        // ignore — file may be locked by editor / running process
      }
    }
  }
}

function removeIfExists(absPath) {
  try {
    if (fs.existsSync(absPath)) {
      fs.unlinkSync(absPath);
      deleted += 1;
    }
  } catch (e) {
    // ignore
  }
}

walk(SRC);
removeIfExists(path.join(ROOT, 'electron-main.js'));
removeIfExists(path.join(ROOT, 'electron-main.js.map'));
removeIfExists(path.join(ROOT, '.tsbuildinfo'));

console.log(`[clean-build] deleted ${deleted} build artifact(s)`);

'use strict';

/**
 * outDir: ./dist-ts への分離に伴い、tests/**\/*.cjs が require している
 * `../src/...` を `../dist-ts/src/...` に書き換える。
 *
 * 冪等: 既に書き換え済みのファイルはスキップ。
 */

const fs = require('fs');
const path = require('path');

const TESTS_DIR = path.resolve(__dirname, '..', 'tests');

let changed = 0;
let scanned = 0;

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!/\.(cjs|js|ts)$/.test(entry.name)) continue;
    scanned += 1;
    const before = fs.readFileSync(full, 'utf8');
    // require('../src/...') | require('../../src/...') etc.
    // ただし既に dist-ts/src を含むものはスキップ。
    const after = before
      .replace(/require\((['"])((?:\.\.\/)+)src\//g, (m, q, dots) => `require(${q}${dots}dist-ts/src/`);
    if (after !== before) {
      fs.writeFileSync(full, after, 'utf8');
      changed += 1;
    }
  }
}

walk(TESTS_DIR);
console.log(`[rewrite-test-imports] scanned=${scanned} changed=${changed}`);

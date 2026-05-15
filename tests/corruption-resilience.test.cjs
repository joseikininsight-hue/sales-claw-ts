'use strict';

/**
 * 全データファイル corruption 耐性テスト (v2.0.25)
 *
 * 各 JSON ファイルを 5 パターンで破損させて loadData / 各 API が crash
 * しないことを保証する:
 *   1. 完全に空 (空文字)
 *   2. 壊れた JSON ({invalid json)
 *   3. Array が来るべき所に Object
 *   4. Object が来るべき所に Array
 *   5. 巨大ファイル (10MB の garbage)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'corrupt-resilience-'));
process.env.SALES_CLAW_USER_DATA_DIR = tmpRoot;
const dataDir = path.join(tmpRoot, 'data');
fs.mkdirSync(dataDir, { recursive: true });

function freshLoadData() {
  Object.keys(require.cache).forEach((p) => {
    if (p.includes('dist-ts')) delete require.cache[p];
  });
  return require('../dist-ts/src/dashboard-server').loadData;
}

let passed = 0;
let failed = 0;
const failures = [];
function assertNoThrow(name, fn) {
  try { fn(); passed += 1; }
  catch (e) { failed += 1; failures.push({ name, error: (e.stack || e.message || String(e)).split('\n').slice(0,3).join('\n') }); }
}

// Targets to corrupt and call loadData against
const FILES = ['action-log.json', 'contact-history.json', 'live-monitor.json', 'outreach-targets.json', 'dashboard-runtime.json', 'settings.json'];
const PAYLOADS = [
  ['empty', ''],
  ['broken', '{invalid json'],
  ['array-when-object', '[1,2,3]'],
  ['object-when-array', '{"key":"value"}'],
  ['huge-garbage', 'x'.repeat(1024 * 1024)],  // 1MB garbage
  ['null', 'null'],
  ['number', '42'],
];

for (const file of FILES) {
  for (const [label, payload] of PAYLOADS) {
    const fp = path.join(dataDir, file);
    fs.writeFileSync(fp, payload, 'utf-8');
    assertNoThrow(`${file} corrupted as ${label} → loadData survives`, () => {
      const loadData = freshLoadData();
      const r = loadData({ force: true });
      if (!Array.isArray(r.companies)) throw new Error('companies not array');
    });
  }
  try { fs.unlinkSync(path.join(dataDir, file)); } catch (_) {}
}

try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}

console.log('');
console.log(`PASSED: ${passed}`);
console.log(`FAILED: ${failed}`);
if (failed > 0) {
  for (const f of failures) {
    console.log('  FAIL:', f.name);
    console.log('   ', f.error);
  }
  process.exitCode = 1;
} else {
  console.log('all corruption-resilience tests passed.');
}

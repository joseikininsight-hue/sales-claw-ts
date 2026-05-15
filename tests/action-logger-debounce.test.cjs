'use strict';

/**
 * Regression test for action-logger debounced flush (v2.0.14).
 *
 * 100 社規模で logAction が連打される時、disk write が線形に増えると
 * I/O コストが O(N²) に近づく。debounce で disk write を間引き、
 * terminal action だけ即 flush するロジックを保証する。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'action-logger-test-'));
process.env.SALES_CLAW_USER_DATA_DIR = tmpRoot;
const dataDir = path.join(tmpRoot, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const logFile = path.join(dataDir, 'action-log.json');

function freshRequire() {
  Object.keys(require.cache).forEach((p) => {
    if (p.includes('dist-ts') && (
      p.includes('action-logger') ||
      p.includes('data-paths') ||
      p.includes('settings-manager')
    )) {
      delete require.cache[p];
    }
  });
  return require('../dist-ts/src/action-logger');
}

let passed = 0;
let failed = 0;
const failures = [];

function assertEq(name, actual, expected) {
  if (actual === expected) { passed += 1; return; }
  failed += 1;
  failures.push({ name, actual, expected });
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

(async () => {
  // ─────────────────────────────────────────────────────────────
  // 1. 非 terminal action は debounce: 連続 5 件 logAction しても
  //    すぐには disk が更新されない
  // ─────────────────────────────────────────────────────────────
  {
    if (fs.existsSync(logFile)) fs.unlinkSync(logFile);
    const al = freshRequire();
    for (let i = 0; i < 5; i++) {
      al.logAction(100 + i, 'TestCo' + i, 'site_analysis', JSON.stringify({ i }));
    }
    // 即読むと disk はまだ古い (debounce 中)
    const onDiskJustAfter = fs.existsSync(logFile)
      ? JSON.parse(fs.readFileSync(logFile, 'utf-8'))
      : [];
    // disk write は 500ms 後なので、即時の disk count は 0 のはず
    // (logCache.data はすでに 5 件入っている)
    assertEq('debounce: disk has 0 entries immediately after burst', onDiskJustAfter.length, 0);
    assertEq('debounce: in-memory has 5 entries via getAllLogs', al.getAllLogs().length, 5);

    // 500ms 待ってから disk を確認
    await sleep(700);
    const onDiskAfterFlush = JSON.parse(fs.readFileSync(logFile, 'utf-8'));
    assertEq('debounce: disk has 5 entries after 700ms', onDiskAfterFlush.length, 5);
  }

  // ─────────────────────────────────────────────────────────────
  // 2. Terminal action は即 flush
  // ─────────────────────────────────────────────────────────────
  for (const terminalAction of ['submitted', 'error', 'skipped', 'awaiting_approval']) {
    if (fs.existsSync(logFile)) fs.unlinkSync(logFile);
    const al = freshRequire();
    al.logAction(200, 'TerminalCo', terminalAction, 'terminal');
    // 即 flush なので disk に 1 件入っているはず
    const onDisk = JSON.parse(fs.readFileSync(logFile, 'utf-8'));
    assertEq(`terminal action ${terminalAction} flushes immediately`, onDisk.length, 1);
    assertEq(`terminal action ${terminalAction} disk action`, onDisk[0].action, terminalAction);
  }

  // ─────────────────────────────────────────────────────────────
  // 3. Mixed: 4 件 site_analysis (debounce) → 1 件 submitted (即 flush)
  //    で全 5 件が disk に出る
  // ─────────────────────────────────────────────────────────────
  {
    if (fs.existsSync(logFile)) fs.unlinkSync(logFile);
    const al = freshRequire();
    for (let i = 0; i < 4; i++) {
      al.logAction(300 + i, 'MixCo' + i, 'site_analysis', String(i));
    }
    al.logAction(305, 'MixCoFinal', 'submitted', 'final');
    const onDisk = JSON.parse(fs.readFileSync(logFile, 'utf-8'));
    assertEq('mixed: terminal triggers flush of pending non-terminal entries', onDisk.length, 5);
    assertEq('mixed: last entry is submitted', onDisk[4].action, 'submitted');
  }

  // ─────────────────────────────────────────────────────────────
  // Cleanup
  // ─────────────────────────────────────────────────────────────
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}

  console.log('');
  console.log(`PASSED: ${passed}`);
  console.log(`FAILED: ${failed}`);
  if (failed > 0) {
    for (const f of failures) {
      console.log('  FAIL:', f.name);
      console.log('    expected:', JSON.stringify(f.expected), 'actual:', JSON.stringify(f.actual));
    }
    process.exitCode = 1;
  } else {
    console.log('all action-logger debounce tests passed.');
  }
})();

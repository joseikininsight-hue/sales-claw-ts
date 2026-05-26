'use strict';

// Parent harness for tests/electron-real-form-runner.cjs.
// Spawns real Electron, captures stdout, asserts every step passed.

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const runner = path.resolve(__dirname, 'electron-real-form-runner.cjs');

// resolve electron binary (require('electron') returns path to electron.exe in dev)
let electronBin;
try {
  electronBin = require('electron');
} catch (e) {
  console.error('[electron-real-form.test] electron module not found:', e.message);
  process.exit(0); // skip
}
if (typeof electronBin !== 'string') {
  console.error('[electron-real-form.test] electron require did not return a string path');
  process.exit(0);
}
if (!fs.existsSync(electronBin)) {
  console.error(`[electron-real-form.test] electron binary missing: ${electronBin}`);
  process.exit(0);
}

console.log(`[real-electron-e2e] spawning ${electronBin} ${runner}`);
const child = spawn(electronBin, [runner], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, ELECTRON_DISABLE_SANDBOX: '1' },
});

let stdout = '';
let stderr = '';
child.stdout.on('data', (chunk) => {
  const s = chunk.toString('utf8');
  stdout += s;
  // Stream realtime to parent stdout for visibility
  process.stdout.write(`[runner.stdout] ${s}`);
});
child.stderr.on('data', (chunk) => {
  const s = chunk.toString('utf8');
  stderr += s;
  process.stderr.write(`[runner.stderr] ${s}`);
});

const timeout = setTimeout(() => {
  console.error('[electron-real-form.test] TIMEOUT after 60s, killing child');
  try { child.kill('SIGKILL'); } catch (_) {}
}, 60000);

child.on('close', (code) => {
  clearTimeout(timeout);
  // 結果 JSON line を抽出
  const marker = '---RESULTS---';
  const idx = stdout.lastIndexOf(marker);
  if (idx < 0) {
    console.error(`\n❌ FAIL: results marker not found. Electron exit code: ${code}`);
    console.error('STDERR tail:', stderr.slice(-1000));
    process.exit(1);
  }
  const jsonStr = stdout.slice(idx + marker.length).split('\n')[0].trim();
  let result;
  try { result = JSON.parse(jsonStr); }
  catch (e) {
    console.error(`\n❌ FAIL: cannot parse results JSON: ${e.message}`);
    console.error('payload:', jsonStr);
    process.exit(1);
  }

  if (!result.ok) {
    console.error(`\n❌ FAIL: ${result.error}`);
    if (result.stack) console.error(result.stack);
    console.error('Steps reached:');
    for (const r of (result.results || [])) console.error('  ', JSON.stringify(r));
    process.exit(1);
  }

  console.log('\n✅ Real Electron + Real WebContentsView E2E passed all steps:');
  for (const r of result.results) console.log(`  ✓ ${r.step}`, JSON.stringify(r).slice(0, 200));
  process.exit(0);
});

child.on('error', (e) => {
  clearTimeout(timeout);
  console.error(`[electron-real-form.test] spawn error: ${e.message}`);
  process.exit(1);
});

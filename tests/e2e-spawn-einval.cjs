'use strict';

// E2E reproduction + verification for the EINVAL spawn bug
// (parallel-analysis worker fails to start under Electron because
// resolveNodeExecutable() returns a .cmd shim path).
//
// Run via: node tests/e2e-spawn-einval.cjs
//
// Demonstrates two scenarios:
//   1. spawn(.cmd, args, { shell: false })  → should fail with EINVAL on Win32
//   2. spawn(salesClawExe, args, { env: { ELECTRON_RUN_AS_NODE: '1' } })
//                                         → should succeed
//
// We don't run scenario 1 by default (it would EINVAL even on the fixed
// code path). Scenario 2 is the real fix verification.

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const SALES_CLAW_EXE = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Sales Claw', 'Sales Claw.exe');
const TOOLCHAIN_NODE_CMD = path.join(
  process.env.APPDATA || '',
  'sales-claw',
  'runtime',
  'tools',
  'bin',
  'node.cmd'
);

function runOne(label, exe, args, env, stdinPayload) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let stdout = '';
    let stderr = '';
    let spawnError = null;

    let child;
    try {
      child = spawn(exe, args, {
        cwd: PROJECT_ROOT,
        env: { ...process.env, ...env },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({
        label,
        exe,
        ok: false,
        error: 'sync-throw: ' + (err.code || err.message),
        elapsedMs: Date.now() - startedAt,
        stdout,
        stderr,
      });
      return;
    }

    child.on('error', (err) => {
      spawnError = err;
    });
    child.stdout.on('data', (chunk) => { stdout += String(chunk || ''); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk || ''); });
    child.on('close', (code) => {
      resolve({
        label,
        exe,
        ok: !spawnError && code === 0 && /\bok"\s*:\s*true\b/.test(stdout),
        exitCode: code,
        error: spawnError ? `${spawnError.code || ''} ${spawnError.message}`.trim() : null,
        elapsedMs: Date.now() - startedAt,
        stdoutTail: stdout.length > 400 ? '…' + stdout.slice(-400) : stdout,
        stderrTail: stderr.length > 400 ? '…' + stderr.slice(-400) : stderr,
      });
    });

    setTimeout(() => {
      try { child.kill(); } catch (_) {}
    }, 25000);
  });
}

async function main() {
  console.log('PROJECT_ROOT       :', PROJECT_ROOT);
  console.log('SALES_CLAW_EXE     :', SALES_CLAW_EXE, fs.existsSync(SALES_CLAW_EXE) ? '(exists)' : '(missing)');
  console.log('TOOLCHAIN_NODE_CMD :', TOOLCHAIN_NODE_CMD, fs.existsSync(TOOLCHAIN_NODE_CMD) ? '(exists)' : '(missing)');
  console.log('process.execPath   :', process.execPath);
  console.log('');

  const samplePayload = JSON.stringify({
    no: 'TEST',
    companyName: 'E2E Test',
    url: 'https://example.com',
    type: 'test',
    formUrl: '',
  });

  // Scenario A: spawn the toolchain .cmd shim directly with shell:false.
  // This is what the BUGGY code did. Expect EINVAL on Windows when present.
  if (process.platform === 'win32' && fs.existsSync(TOOLCHAIN_NODE_CMD)) {
    console.log('[A] BUG REPRODUCTION: spawn(node.cmd, ..., {shell:false})');
    const a = await runOne(
      'A: spawn .cmd shell:false',
      TOOLCHAIN_NODE_CMD,
      ['-e', 'console.log(JSON.stringify({ok:true,from:"node-cmd"}))'],
      {},
    );
    console.log('   result:', JSON.stringify({ ok: a.ok, exit: a.exitCode, error: a.error }));
    console.log('');
  }

  // Scenario B: the FIXED behavior. spawn process.execPath
  // (Sales Claw.exe in Electron context) with ELECTRON_RUN_AS_NODE=1.
  if (fs.existsSync(SALES_CLAW_EXE)) {
    console.log('[B] FIX VERIFICATION: spawn(Sales Claw.exe, parallel-analysis.cjs)');
    const b = await runOne(
      'B: Sales Claw.exe + ELECTRON_RUN_AS_NODE',
      SALES_CLAW_EXE,
      ['src/parallel-analysis', samplePayload],
      { ELECTRON_RUN_AS_NODE: '1', SALES_CLAW_CLI_TOKEN: 'e2e-test' },
    );
    console.log('   ok        :', b.ok);
    console.log('   exit code :', b.exitCode);
    console.log('   elapsed   :', b.elapsedMs, 'ms');
    console.log('   error     :', b.error);
    console.log('   stdout    :', b.stdoutTail.substring(0, 300));
    if (b.stderrTail) console.log('   stderr    :', b.stderrTail.substring(0, 300));
    console.log('');
    process.exitCode = b.ok ? 0 : 1;
    return;
  }

  // Fallback: use plain node.exe (system node)
  console.log('[B-fallback] system node spawn');
  const b = await runOne(
    'B-fallback: node.exe',
    process.execPath,
    ['src/parallel-analysis', samplePayload],
    { SALES_CLAW_CLI_TOKEN: 'e2e-test' },
  );
  console.log('   ok        :', b.ok);
  console.log('   exit code :', b.exitCode);
  console.log('   elapsed   :', b.elapsedMs, 'ms');
  console.log('   error     :', b.error);
  console.log('   stdout    :', b.stdoutTail.substring(0, 300));
  if (b.stderrTail) console.log('   stderr    :', b.stderrTail.substring(0, 300));
  process.exitCode = b.ok ? 0 : 1;
}

main().catch((err) => {
  console.error('test crashed:', err);
  process.exitCode = 2;
});

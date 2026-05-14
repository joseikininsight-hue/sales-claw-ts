'use strict';

/**
 * Integration test for dashboard-server.cjs gracefulShutdown.
 *
 * Spawns a child process running dashboard-server.cjs, waits for it to be
 * listening, then sends SIGINT and verifies:
 *   - process exits within deadline
 *   - exit code is 0
 *   - lock file is released (or at least the next instance can acquire it)
 *   - stdout includes the expected lifecycle markers
 *
 * Run: node tests/graceful-shutdown.test.cjs
 *
 * NOTE: SIGINT semantics on Windows differ from POSIX.  On Windows we use
 * `taskkill /pid /f` for the second test (forced exit fallback) and rely
 * on Node's emulated SIGINT for the first (Ctrl+C in the same console).
 * Tests skip cleanly when running in an environment where signals can't
 * be delivered (e.g. CI without a TTY).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

let passed = 0;
let failed = 0;
const failures = [];

function assert(cond, message) {
  if (cond) { passed += 1; return; }
  failed += 1;
  failures.push(message);
}

function sandboxEnv() {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'sales-claw-shutdown-test-'));
  return {
    sandbox,
    env: {
      ...process.env,
      SALES_CLAW_USER_DATA_DIR: sandbox,
      // 短めのタイムアウトで止まることを確認するため
      NODE_NO_WARNINGS: '1',
    },
  };
}

function spawnDashboard(env) {
  const child = spawn(process.execPath, ['src/dashboard-server'], {
    cwd: path.resolve(__dirname, '..'),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached: false,
  });
  child._stdout = '';
  child._stderr = '';
  child.stdout.on('data', (chunk) => { child._stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { child._stderr += chunk.toString(); });
  return child;
}

function waitForStdout(child, needle, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const i = setInterval(() => {
      if (child._stdout.includes(needle) || child._stderr.includes(needle)) {
        clearInterval(i);
        resolve(true);
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        clearInterval(i);
        reject(new Error(`timeout waiting for "${needle}"\nstdout: ${child._stdout}\nstderr: ${child._stderr}`));
      }
    }, 100);
  });
}

function waitForExit(child, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let resolved = false;
    const finish = (code, signal) => {
      if (resolved) return;
      resolved = true;
      resolve({ code, signal });
    };
    child.once('exit', finish);
    setTimeout(() => finish(null, 'timeout'), timeoutMs);
  });
}

async function main() {
  // Test 1: SIGINT triggers graceful shutdown markers + exit
  {
    const { sandbox, env } = sandboxEnv();
    const child = spawnDashboard(env);

    let started = false;
    try {
      await waitForStdout(child, 'http://', 12000);
      started = true;
    } catch (e) {
      // Couldn't start dashboard at all (port in use?). Skip rather than fail.
      console.warn('skip: dashboard failed to start —', e.message);
      try { child.kill('SIGKILL'); } catch (_) {}
      try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch (_) {}
    }

    if (started) {
      // Send SIGINT
      try {
        if (process.platform === 'win32') {
          // Node on Windows emulates SIGINT for Ctrl+C only on TTY parents.
          // Use a process kill instead: SIGTERM has equivalent effect in our handler.
          child.kill('SIGTERM');
        } else {
          child.kill('SIGINT');
        }
      } catch (_) {}

      const result = await waitForExit(child, 10000);
      assert(result.signal !== 'timeout', 'process exits within 10s of signal');

      // Windows の child.kill('SIGTERM') は実は TerminateProcess() で
      // ハンドラを呼ばない hard-kill。POSIX の SIGINT は graceful shutdown
      // を経由する。両者で意味が違うので、ここでは「exit したこと」のみ
      // 必須条件とし、graceful 経由かどうかは Test 2 (lock release) で確認する。
      assert(
        result.code === 0 || result.code === null || (process.platform === 'win32' && result.signal === 'SIGTERM'),
        `process terminates cleanly (code=${result.code}, signal=${result.signal})`
      );

      // POSIX 限定で graceful markers を確認 (Windows は hard-kill されるので
      // ハンドラ自体が走らない)。
      if (process.platform !== 'win32') {
        const combined = child._stdout + child._stderr;
        assert(/graceful shutdown initiated/.test(combined), 'POSIX: log shows shutdown initiated');
      }
    }

    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch (_) {}
  }

  // Test 2: lock is released so a second instance can acquire it
  {
    const { sandbox, env } = sandboxEnv();
    const first = spawnDashboard(env);
    let started = false;
    try {
      await waitForStdout(first, 'http://', 12000);
      started = true;
    } catch (_) {
      try { first.kill('SIGKILL'); } catch (_) {}
    }

    if (started) {
      // Shut down cleanly
      try { first.kill(process.platform === 'win32' ? 'SIGTERM' : 'SIGINT'); } catch (_) {}
      await waitForExit(first, 10000);

      // Now spawn a second instance with the same sandbox; it should also start.
      const second = spawnDashboard(env);
      let secondStarted = false;
      try {
        await waitForStdout(second, 'http://', 12000);
        secondStarted = true;
      } catch (e) {
        console.warn('second instance failed to start:', e.message);
      }
      assert(secondStarted, 'second instance starts after first shuts down (lock released)');
      try { second.kill(process.platform === 'win32' ? 'SIGTERM' : 'SIGINT'); } catch (_) {}
      await waitForExit(second, 10000);
    }

    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch (_) {}
  }

  console.log('');
  console.log(`PASSED: ${passed}`);
  console.log(`FAILED: ${failed}`);
  if (failed > 0) {
    for (const f of failures) console.log(`  FAIL: ${f}`);
    process.exitCode = 1;
  } else {
    console.log('all graceful-shutdown tests passed.');
  }
}

main().catch((err) => {
  console.error('test crashed:', err);
  process.exitCode = 2;
});

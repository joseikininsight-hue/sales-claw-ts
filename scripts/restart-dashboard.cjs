'use strict';

const http = require('http');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const settings = require('../dist-ts/src/settings-manager');
const { readRuntime, toClientHost } = require('../dist-ts/src/dashboard-runtime');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const isWindows = process.platform === 'win32';

function getFallbackUrl() {
  const host = toClientHost(settings.getHost());
  const port = settings.getPort();
  return `http://${host}:${port}`;
}

function getOpenTarget() {
  return readRuntime()?.url || getFallbackUrl();
}

function stopDashboardProcesses() {
  if (isWindows) {
    execFileSync('powershell.exe', [
      '-NoProfile',
      '-Command',
      "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'dashboard-server\\.cjs' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
    ], { stdio: 'ignore' });
    return;
  }
  execFileSync('pkill', ['-f', 'dashboard-server\\.cjs'], { stdio: 'ignore' });
}

function startDashboardProcess() {
  const child = spawn(process.execPath, ['src/dashboard-server'], {
    cwd: PROJECT_ROOT,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
}

function waitForServer(timeoutMs = 30000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      const targetUrl = getOpenTarget();
      const req = http.get(targetUrl, (res) => {
        res.resume();
        resolve(targetUrl);
      });
      req.on('error', () => {
        if (Date.now() - started > timeoutMs) {
          reject(new Error(`Dashboard did not start in time: ${targetUrl}`));
          return;
        }
        setTimeout(check, 500);
      });
      req.end();
    };
    check();
  });
}

function openUrl(url) {
  if (isWindows) {
    const child = spawn('cmd.exe', ['/c', 'start', '', url], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    return;
  }
  const openCommand = process.platform === 'darwin' ? 'open' : 'xdg-open';
  const child = spawn(openCommand, [url], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

async function main() {
  console.log('Stopping existing dashboard server...');
  try {
    stopDashboardProcesses();
  } catch (_) {
    // Nothing to stop.
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));

  console.log('Starting dashboard server...');
  startDashboardProcess();

  const url = await waitForServer();
  console.log(`Opening ${url}`);
  openUrl(url);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});

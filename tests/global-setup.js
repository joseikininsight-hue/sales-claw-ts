// @ts-check
/**
 * Global setup: starts the dashboard server once for all tests.
 * Port and session token are written to process.env so all workers can access them.
 */

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PROJECT_ROOT = path.join(__dirname, '..');

function getDashboardServerEntry() {
  const built = path.join(PROJECT_ROOT, 'dist-ts', 'src', 'dashboard-server.js');
  if (fs.existsSync(built)) return built;
  return path.join(PROJECT_ROOT, 'src', 'dashboard-server.cjs');
}

function getRuntimeRoot() {
  const configured = typeof process.env.SALES_CLAW_USER_DATA_DIR === 'string'
    ? process.env.SALES_CLAW_USER_DATA_DIR.trim()
    : '';
  return path.resolve(configured || path.join(os.homedir(), '.sales-claw'));
}

function readSessionToken() {
  const sessionFile = path.join(getRuntimeRoot(), 'data', 'dashboard-session.json');
  try {
    const raw = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    const token = typeof raw.token === 'string' ? raw.token.trim() : '';
    return /^[a-f0-9]{48,}$/i.test(token) ? token : '';
  } catch (_) {
    return '';
  }
}

function warmDashboard(port) {
  return new Promise((resolve) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: '/' }, (res) => {
      res.resume();
      res.on('end', resolve);
    });
    req.on('error', resolve);
    req.setTimeout(5000, () => {
      req.destroy();
      resolve();
    });
  });
}

/** @type {import('child_process').ChildProcess | null} */
let serverProc = null;

module.exports = async function globalSetup() {
  return new Promise((resolve, reject) => {
    const fixtureDir = path.join(PROJECT_ROOT, 'tmp');
    if (!fs.existsSync(fixtureDir)) fs.mkdirSync(fixtureDir, { recursive: true });
    const runtimeRoot = fs.mkdtempSync(path.join(fixtureDir, 'dashboard-e2e-user-data-'));
    process.env.SALES_CLAW_USER_DATA_DIR = runtimeRoot;
    const env = {
      ...process.env,
      FORCE_COLOR: '0',
      SALES_CLAW_USER_DATA_DIR: runtimeRoot,
    };

    serverProc = spawn(
      process.execPath,
      [getDashboardServerEntry()],
      {
        cwd: PROJECT_ROOT,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
      }
    );

    let resolved = false;
    let output = '';
    const timeout = 25_000;

    const timer = setTimeout(() => {
      if (!resolved) {
        if (serverProc) serverProc.kill();
        reject(new Error(`Dashboard server did not start within ${timeout}ms.\nOutput:\n${output}`));
      }
    }, timeout);

    function tryResolve(data) {
      output += data;
      const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (match && !resolved) {
        resolved = true;
        clearTimeout(timer);
        const port = Number(match[1]);
        setTimeout(async () => {
          await warmDashboard(port);
          const token = readSessionToken();
          // Export to env so all test files can read them
          process.env.DASHBOARD_TEST_PORT = String(port);
          process.env.DASHBOARD_TEST_TOKEN = token;

          // Write a JSON fixture that workers can read (env vars aren't inherited by workers in some PW versions)
          fs.writeFileSync(
            path.join(fixtureDir, 'dashboard-test-server.json'),
            JSON.stringify({ port, token, runtimeRoot }, null, 2),
            'utf8'
          );

          // Store proc reference in global so teardown can kill it
          global.__dashboardServerProc = serverProc;
          global.__dashboardRuntimeRoot = runtimeRoot;
          resolve();
        }, 600);
      }
    }

    serverProc.stdout.on('data', (d) => tryResolve(d.toString()));
    serverProc.stderr.on('data', (d) => tryResolve(d.toString()));

    serverProc.on('error', (err) => {
      if (!resolved) { clearTimeout(timer); reject(err); }
    });
    serverProc.on('exit', (code) => {
      if (!resolved) {
        clearTimeout(timer);
        reject(new Error(`Dashboard server exited with code ${code}.\nOutput:\n${output}`));
      }
    });
  });
};

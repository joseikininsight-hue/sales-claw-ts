// @ts-check
/**
 * Global teardown: kills the dashboard server started in global-setup.
 */

const path = require('path');
const fs = require('fs');

module.exports = async function globalTeardown() {
  // Kill the server process
  const proc = global.__dashboardServerProc;
  if (proc) {
    try { proc.kill(); } catch (_) {}
  }

  // Clean up fixture file
  const fixture = path.join(__dirname, '..', 'tmp', 'dashboard-test-server.json');
  let runtimeRoot = global.__dashboardRuntimeRoot || '';
  if (!runtimeRoot) {
    try {
      const parsed = JSON.parse(fs.readFileSync(fixture, 'utf8'));
      runtimeRoot = parsed && typeof parsed.runtimeRoot === 'string' ? parsed.runtimeRoot : '';
    } catch (_) {}
  }
  try { fs.unlinkSync(fixture); } catch (_) {}
  if (runtimeRoot && runtimeRoot.includes('dashboard-e2e-user-data-')) {
    try { fs.rmSync(runtimeRoot, { recursive: true, force: true }); } catch (_) {}
  }
};

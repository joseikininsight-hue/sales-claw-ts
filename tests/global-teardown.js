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
  try { fs.unlinkSync(fixture); } catch (_) {}
};

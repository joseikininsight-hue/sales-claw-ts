'use strict';

/**
 * Preview-only dashboard launcher.
 *
 * This intentionally starts the exact same dashboard source that Electron
 * packages: ../src/dashboard-server.cjs. Keep this launcher in the repository
 * root, not in a Claude worktree, so preview / web / desktop never drift.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

function choosePreviewUserDataDir() {
  if (process.env.SALES_CLAW_USER_DATA_DIR) return;
  if (process.platform === 'win32' && process.env.APPDATA) {
    const candidates = [
      path.join(process.env.APPDATA, 'sales-claw', 'runtime'),
      path.join(process.env.APPDATA, 'Sales Claw', 'runtime'),
    ];
    const existing = candidates.find((candidate) => fs.existsSync(candidate));
    process.env.SALES_CLAW_USER_DATA_DIR = existing || candidates[0];
    return;
  }
  process.env.SALES_CLAW_USER_DATA_DIR = path.join(os.homedir(), '.sales-claw');
}

choosePreviewUserDataDir();

const m = require('../dist-ts/src/dashboard-server');
const PORT = Number(process.env.PREVIEW_DASHBOARD_PORT) || 3480;
m.server.listen(PORT, '127.0.0.1', () => {
  console.log('[preview-dashboard] ready on http://127.0.0.1:' + PORT);
  console.log('[preview-dashboard] source: ' + path.join(__dirname, '..', 'dist-ts', 'src', 'dashboard-server.js'));
  console.log('[preview-dashboard] data: ' + process.env.SALES_CLAW_USER_DATA_DIR);
});

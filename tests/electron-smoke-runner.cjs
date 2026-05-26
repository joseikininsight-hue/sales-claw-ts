'use strict';
// Minimal smoke test: does electron run a .cjs file at all?
const { app } = require('electron');
process.stdout.write('SMOKE-1: before whenReady\n');
process.stderr.write('SMOKE-1: also stderr\n');
app.whenReady().then(() => {
  process.stdout.write('SMOKE-2: whenReady fired\n');
  setTimeout(() => {
    process.stdout.write('SMOKE-3: exiting cleanly\n');
    app.exit(0);
  }, 200);
}).catch((e) => {
  process.stderr.write(`SMOKE-FAIL: ${e.message}\n`);
  app.exit(2);
});
app.on('window-all-closed', (e) => { e.preventDefault(); });

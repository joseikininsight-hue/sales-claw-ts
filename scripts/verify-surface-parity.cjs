'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const failures = [];
const passes = [];

function rel(filePath) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function pass(message) {
  passes.push(message);
}

function fail(message) {
  failures.push(message);
}

function requireFile(relativePath) {
  const filePath = path.join(ROOT, relativePath);
  if (fs.existsSync(filePath)) {
    pass(`${relativePath}: exists`);
    return true;
  }
  fail(`${relativePath}: missing`);
  return false;
}

function requireContains(relativePath, needle, message) {
  if (!requireFile(relativePath)) return;
  const text = read(relativePath);
  if (text.includes(needle)) {
    pass(`${relativePath}: ${message}`);
  } else {
    fail(`${relativePath}: ${message}`);
  }
}

function checkDashboardSource() {
  requireContains('src/dashboard-server.ts', "require('./ui/styles')", 'uses shared dashboard styles bundle');
  requireContains('src/dashboard-server.ts', "require('./ui/client-scripts/dashboard.cjs')", 'uses shared dashboard client bundle');
  requireContains('src/dashboard-server.ts', 'class="theme-toggle"', 'renders theme toggle in the operational dashboard');
  requireContains('src/dashboard-server.ts', 'setAttribute(\'data-theme\'', 'initializes theme before body paint');
  requireContains('src/dashboard-server.ts', 'id="tab-dashboard"', 'includes the current dashboard tab');
  requireContains('src/ui/styles-theme.ts', '[data-theme="dark"]', 'contains dark theme token overrides');
  requireContains('src/ui/client-scripts/dashboard.cjs', 'function toggleTheme()', 'contains theme toggle behavior');

  for (const relativePath of [
    'src/routes/simple-api.ts',
    'src/routes/settings-api.ts',
    'src/routes/ai-runtime-api.ts',
    'src/routes/form-session-api.ts',
    'src/routes/approve-api.ts',
    'src/routes/ai-form-fill-api.ts',
    'src/ui/client-scripts/dashboard-analytics.cjs',
    'src/ui/styles.ts',
  ]) {
    requireFile(relativePath);
  }
}

function checkEntrypoints() {
  requireContains('scripts/preview-dashboard.cjs', "require('../dist-ts/src/dashboard-server')", 'preview launcher uses the compiled dashboard source');
  requireContains('scripts/preview-dashboard.cjs', 'SALES_CLAW_USER_DATA_DIR', 'preview launcher points at the same runtime data family as desktop');
  requireContains('electron-main.ts', "require('./src/dashboard-server')", 'desktop launcher uses the root dashboard source');
  requireContains('electron-builder.yml', 'vendor/**', 'packages local dashboard vendor assets');
}

function checkAssets() {
  for (const relativePath of [
    'assets/vendor/fonts.css',
    'assets/vendor/material-symbols.css',
    'assets/vendor/phosphor.css',
    'assets/vendor/tailwind.css',
    'assets/vendor/js/chart.umd.js',
    'assets/vendor/js/xterm.js',
    'assets/vendor/ai-icons/claude-code.svg',
    'assets/vendor/ai-icons/codex-openai.svg',
    'assets/vendor/ai-icons/gemini-cli.svg',
  ]) {
    requireFile(relativePath);
  }
}

function checkPackagedInstall(installRoot) {
  const appDir = path.join(installRoot, 'resources', 'app');
  if (!fs.existsSync(appDir)) return false;
  const installedDashboard = path.join(appDir, 'src', 'dashboard-server.js');
  if (!fs.existsSync(installedDashboard)) {
    fail(`${installedDashboard}: installed dashboard source missing`);
    return true;
  }
  const installedText = fs.readFileSync(installedDashboard, 'utf8');
  for (const marker of ['class="theme-toggle"', 'id="tab-dashboard"', "require('./ui/styles')"]) {
    if (installedText.includes(marker)) {
      pass(`${installedDashboard}: contains ${marker}`);
    } else {
      fail(`${installedDashboard}: missing ${marker}; rebuild and reinstall the desktop app`);
    }
  }
  const installedVendor = path.join(installRoot, 'resources', 'assets', 'vendor', 'tailwind.css');
  if (fs.existsSync(installedVendor)) {
    pass(`${installedVendor}: installed vendor assets present`);
  } else {
    fail(`${installedVendor}: installed vendor assets missing; rebuild installer after asset sync`);
  }
  return true;
}

function checkInstalledIfPresent() {
  const roots = [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Sales Claw'),
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Sales Claw') : null,
  ].filter(Boolean);
  const found = roots.some(checkPackagedInstall);
  if (!found) pass('installed app: not present, source-only parity checked');
}

checkDashboardSource();
checkEntrypoints();
checkAssets();
if (process.argv.includes('--installed')) checkInstalledIfPresent();

for (const message of passes) console.log(`OK   ${message}`);
for (const message of failures) console.error(`FAIL ${message}`);

if (failures.length) {
  console.error(`\nSurface parity failed: ${failures.length} issue(s).`);
  process.exit(1);
}

console.log(`\nSurface parity passed (${passes.length} checks).`);

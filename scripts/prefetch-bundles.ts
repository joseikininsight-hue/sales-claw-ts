'use strict';

/**
 * Prefetch bundles for Sales Claw installer.
 *
 * Purpose
 *   Download Playwright Chromium + Claude Code CLI at build time so the
 *   installer ships with them. This avoids the "first-run downloads from
 *   the internet" path, which:
 *     (a) trips antivirus / EDR products (the app spawns node and pulls
 *         executable files from the web), and
 *     (b) requires the user's machine to have network access during the
 *         initial setup.
 *
 * Output
 *   prebuilt-bundles
 *     browsers
 *       chromium-XXXX                 (Playwright-managed Chromium snapshot)
 *         chrome-win64/chrome.exe     (or chrome-mac-... or chrome-linux64)
 *     npm-project
 *       node_modules
 *         @anthropic-ai/claude-code/bin/claude(.exe)
 *         ...
 *       package.json / package-lock.json
 *
 * Wiring
 *   - electron-builder.yml `extraResources` copies prebuilt-bundles/
 *     into <install-dir>/resources/prebuilt-bundles/.
 *   - src/local-toolchain.ts adds that path to its search roots so the
 *     CLI / Chromium are detected without any network access.
 *
 * Re-run policy
 *   Idempotent. Re-running with existing artifacts is fast (npm uses its
 *   cache and Playwright skips already-installed browsers).
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BUNDLE_DIR = path.join(ROOT, 'prebuilt-bundles');
const BROWSERS_DIR = path.join(BUNDLE_DIR, 'browsers');
const NPM_PROJECT_DIR = path.join(BUNDLE_DIR, 'npm-project');
const NPM_CACHE_DIR = path.join(BUNDLE_DIR, '.npm-cache');

const NPM_CLI = path.join(ROOT, 'node_modules', 'npm', 'bin', 'npm-cli.js');
const PLAYWRIGHT_MCP_CLI = path.join(ROOT, 'node_modules', '@playwright', 'mcp', 'cli.js');

const CLAUDE_PACKAGE = '@anthropic-ai/claude-code';

function ensureDir(p: string) {
  fs.mkdirSync(p, { recursive: true });
}

function logStep(title: string) {
  console.log(`\n=== ${title} ===`);
}

function runNode(args: string[], env: Record<string, string> = {}, timeoutMs = 10 * 60 * 1000): void {
  const merged = { ...process.env, ...env };
  const result = spawnSync(process.execPath, args, {
    cwd: ROOT,
    env: merged,
    stdio: 'inherit',
    timeout: timeoutMs,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Subprocess exited with code ${result.status}: ${process.execPath} ${args.join(' ')}`);
  }
}

function preflight() {
  for (const p of [NPM_CLI, PLAYWRIGHT_MCP_CLI]) {
    if (!fs.existsSync(p)) {
      throw new Error(
        `Required dependency not found: ${path.relative(ROOT, p)}\n` +
        `Run "npm install" first so node_modules/npm and node_modules/@playwright/mcp are present.`
      );
    }
  }
}

function writeBundleManifest() {
  const manifestPath = path.join(BUNDLE_DIR, 'manifest.json');
  const pkgJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const manifest = {
    generatedAt: new Date().toISOString(),
    salesClawVersion: pkgJson.version,
    bundles: {
      browsers: {
        path: 'browsers',
        provider: '@playwright/mcp install-browser chromium',
      },
      claudeCli: {
        path: 'npm-project/node_modules/@anthropic-ai/claude-code',
        package: CLAUDE_PACKAGE,
      },
    },
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  console.log(`Wrote ${path.relative(ROOT, manifestPath)}`);
}

function ensureNpmProjectPackageJson() {
  const pkgPath = path.join(NPM_PROJECT_DIR, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    fs.writeFileSync(pkgPath, JSON.stringify({
      private: true,
      name: 'sales-claw-prebuilt-cli',
      description: 'Sales Claw prebuilt CLI bundle. Do not edit manually.',
      version: '1.0.0',
      dependencies: {},
    }, null, 2) + '\n', 'utf8');
  }
}

function installClaudeCli() {
  logStep(`Installing ${CLAUDE_PACKAGE} into ${path.relative(ROOT, NPM_PROJECT_DIR)}`);
  ensureDir(NPM_PROJECT_DIR);
  ensureDir(NPM_CACHE_DIR);
  ensureNpmProjectPackageJson();

  runNode(
    [
      NPM_CLI,
      'install',
      '--prefix', NPM_PROJECT_DIR,
      '--cache', NPM_CACHE_DIR,
      '--no-audit',
      '--no-fund',
      '--save-exact',
      CLAUDE_PACKAGE,
    ],
    {},
    15 * 60 * 1000
  );

  const exeName = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const exePath = path.join(NPM_PROJECT_DIR, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', exeName);
  if (!fs.existsSync(exePath)) {
    throw new Error(`Claude CLI install completed but executable not found at ${path.relative(ROOT, exePath)}`);
  }
  console.log(`✔ Claude CLI ready: ${path.relative(ROOT, exePath)}`);
}

function installChromium() {
  logStep(`Installing Playwright Chromium into ${path.relative(ROOT, BROWSERS_DIR)}`);
  ensureDir(BROWSERS_DIR);

  runNode(
    [PLAYWRIGHT_MCP_CLI, 'install-browser', 'chromium'],
    {
      PLAYWRIGHT_BROWSERS_PATH: BROWSERS_DIR,
    },
    15 * 60 * 1000
  );

  const exe = findChromiumExecutable(BROWSERS_DIR);
  if (!exe) {
    throw new Error(`Chromium install completed but executable not found under ${path.relative(ROOT, BROWSERS_DIR)}`);
  }
  console.log(`✔ Chromium ready: ${path.relative(ROOT, exe)}`);
}

function findChromiumExecutable(root: string): string | null {
  const subpaths = process.platform === 'win32'
    ? [['chrome-win64', 'chrome.exe'], ['chrome-win', 'chrome.exe']]
    : process.platform === 'darwin'
      ? [
          ['chrome-mac-arm64', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'],
          ['chrome-mac-x64', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'],
          ['chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'],
        ]
      : [['chrome-linux64', 'chrome'], ['chrome-linux', 'chrome']];

  let entries: string[] = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
      .filter((entry: any) => entry.isDirectory())
      .map((entry: any) => path.join(root, entry.name))
      .filter((entryPath: string) => /(?:^|[\\/])chromium-|(?:^|[\\/])chrome-for-testing-/.test(entryPath));
  } catch (_) {
    entries = [];
  }
  entries.sort().reverse();
  for (const entry of entries) {
    for (const parts of subpaths) {
      const candidate = path.join(entry, ...parts);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function main() {
  preflight();
  ensureDir(BUNDLE_DIR);
  installClaudeCli();
  installChromium();
  writeBundleManifest();
  console.log('\nPrefetch complete.');
  console.log(`Bundle root: ${BUNDLE_DIR}`);
}

main();

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const settings = require('./settings-manager');
const { getProvider, normalizeProviderId } = require('./ai-providers');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const PROCESS_TIMEOUT_MS = 10 * 60 * 1000;

function getRuntimeRoot() {
  return typeof settings.getRuntimeRoot === 'function'
    ? settings.getRuntimeRoot()
    : path.join(os.homedir(), '.sales-claw');
}

function getToolchainRoot() {
  return path.join(getRuntimeRoot(), 'tools');
}

function getBinDir() {
  return path.join(getToolchainRoot(), 'bin');
}

function getNpmProjectDir() {
  return path.join(getToolchainRoot(), 'npm-project');
}

function getNpmBinDir() {
  return path.join(getNpmProjectDir(), 'node_modules', '.bin');
}

function getNpmCacheDir() {
  return path.join(getToolchainRoot(), 'npm-cache');
}

function getPlaywrightBrowsersDir() {
  return path.join(getToolchainRoot(), 'browsers');
}

function packageRoot(packageName) {
  return path.dirname(require.resolve(`${packageName}/package.json`));
}

function getNpmCliPath() {
  return path.join(packageRoot('npm'), 'bin', 'npm-cli.js');
}

function getNpxCliPath() {
  return path.join(packageRoot('npm'), 'bin', 'npx-cli.js');
}

function getPlaywrightMcpCliPath() {
  return path.join(packageRoot('@playwright/mcp'), 'cli.js');
}

function quoteCmdPath(value) {
  return String(value || '').replace(/"/g, '""');
}

function writeFileIfChanged(filePath: string, content: string, mode?: number) {
  let current: any = null;
  try { current = fs.readFileSync(filePath, 'utf8'); } catch (_) {}
  if (current !== content) {
    fs.writeFileSync(filePath, content, 'utf8');
  }
  if (mode && process.platform !== 'win32') {
    try { fs.chmodSync(filePath, mode); } catch (_) {}
  }
}

function getNodeShimPath() {
  return path.join(getBinDir(), process.platform === 'win32' ? 'node.cmd' : 'node');
}

function getNpmShimPath() {
  return path.join(getBinDir(), process.platform === 'win32' ? 'npm.cmd' : 'npm');
}

function getNpxShimPath() {
  return path.join(getBinDir(), process.platform === 'win32' ? 'npx.cmd' : 'npx');
}

function getPlaywrightMcpWrapperPath() {
  return path.join(getBinDir(), 'playwright-mcp-wrapper.cjs');
}

function getPlaywrightMcpCommandPath() {
  return path.join(getBinDir(), process.platform === 'win32' ? 'playwright-mcp.cmd' : 'playwright-mcp');
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function ensureNpmProject() {
  const projectDir = getNpmProjectDir();
  ensureDir(projectDir);
  const packageJsonPath = path.join(projectDir, 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    fs.writeFileSync(packageJsonPath, JSON.stringify({
      private: true,
      name: 'sales-claw-local-tools',
      description: 'Sales Claw managed CLI toolchain. Do not edit manually.',
      version: '1.0.0',
      dependencies: {},
    }, null, 2), 'utf8');
  }
}

function buildPlaywrightWrapperScript() {
  return `'use strict';

const fs = require('fs');
const path = require('path');

const browsersPath = ${JSON.stringify(getPlaywrightBrowsersDir())};
const mcpCliPath = ${JSON.stringify(getPlaywrightMcpCliPath())};

function findChromiumExecutable(root) {
  const subpaths = process.platform === 'win32'
    ? [['chrome-win64', 'chrome.exe'], ['chrome-win', 'chrome.exe']]
    : process.platform === 'darwin'
      ? [['chrome-mac-arm64', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'], ['chrome-mac-x64', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'], ['chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium']]
      : [['chrome-linux64', 'chrome'], ['chrome-linux', 'chrome']];
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, entry.name))
      .filter((entryPath) => /(?:^|[\\\\/])chromium-|(?:^|[\\\\/])chrome-for-testing-/.test(entryPath));
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

process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || browsersPath;
process.env.PLAYWRIGHT_MCP_BROWSER = process.env.PLAYWRIGHT_MCP_BROWSER || 'chromium';
process.env.PWMCP_PROFILES_DIR_FOR_TEST = process.env.PWMCP_PROFILES_DIR_FOR_TEST || path.join(browsersPath, '..', 'mcp-profiles');

if (!process.env.PLAYWRIGHT_MCP_EXECUTABLE_PATH) {
  const executable = findChromiumExecutable(process.env.PLAYWRIGHT_BROWSERS_PATH);
  if (executable) process.env.PLAYWRIGHT_MCP_EXECUTABLE_PATH = executable;
}

process.argv = [process.execPath, mcpCliPath, ...process.argv.slice(2)];
require(mcpCliPath);
`;
}

function ensureToolchainFiles() {
  const binDir = getBinDir();
  ensureDir(binDir);
  ensureDir(getNpmCacheDir());
  ensureDir(getPlaywrightBrowsersDir());
  ensureNpmProject();

  const electronNode = quoteCmdPath(process.execPath);
  const npmCli = quoteCmdPath(getNpmCliPath());
  const npxCli = quoteCmdPath(getNpxCliPath());
  const wrapperPath = quoteCmdPath(getPlaywrightMcpWrapperPath());

  if (process.platform === 'win32') {
    writeFileIfChanged(getNodeShimPath(), [
      '@echo off',
      'setlocal',
      `set "SALES_CLAW_ELECTRON_NODE=${electronNode}"`,
      'set "ELECTRON_RUN_AS_NODE=1"',
      '"%SALES_CLAW_ELECTRON_NODE%" %*',
      'endlocal',
      '',
    ].join('\r\n'));
    writeFileIfChanged(getNpmShimPath(), [
      '@echo off',
      'setlocal',
      `set "SALES_CLAW_NPM_CLI=${npmCli}"`,
      `call "%~dp0node.cmd" "%SALES_CLAW_NPM_CLI%" %*`,
      'endlocal',
      '',
    ].join('\r\n'));
    writeFileIfChanged(getNpxShimPath(), [
      '@echo off',
      'setlocal',
      `set "SALES_CLAW_NPX_CLI=${npxCli}"`,
      `call "%~dp0node.cmd" "%SALES_CLAW_NPX_CLI%" %*`,
      'endlocal',
      '',
    ].join('\r\n'));
    writeFileIfChanged(getPlaywrightMcpCommandPath(), [
      '@echo off',
      'setlocal',
      `set "PLAYWRIGHT_BROWSERS_PATH=${quoteCmdPath(getPlaywrightBrowsersDir())}"`,
      'set "PLAYWRIGHT_MCP_BROWSER=chromium"',
      `call "%~dp0node.cmd" "${wrapperPath}" %*`,
      'endlocal',
      '',
    ].join('\r\n'));
  } else {
    const escapedExecPath = String(process.execPath).replace(/'/g, `'\\''`);
    writeFileIfChanged(getNodeShimPath(), [
      '#!/bin/sh',
      'export ELECTRON_RUN_AS_NODE=1',
      `exec '${escapedExecPath}' "$@"`,
      '',
    ].join('\n'), 0o755);
    writeFileIfChanged(getNpmShimPath(), [
      '#!/bin/sh',
      `exec "${getNodeShimPath()}" '${getNpmCliPath().replace(/'/g, `'\\''`)}' "$@"`,
      '',
    ].join('\n'), 0o755);
    writeFileIfChanged(getNpxShimPath(), [
      '#!/bin/sh',
      `exec "${getNodeShimPath()}" '${getNpxCliPath().replace(/'/g, `'\\''`)}' "$@"`,
      '',
    ].join('\n'), 0o755);
    writeFileIfChanged(getPlaywrightMcpCommandPath(), [
      '#!/bin/sh',
      `export PLAYWRIGHT_BROWSERS_PATH='${getPlaywrightBrowsersDir().replace(/'/g, `'\\''`)}'`,
      'export PLAYWRIGHT_MCP_BROWSER="${PLAYWRIGHT_MCP_BROWSER:-chromium}"',
      `exec "${getNodeShimPath()}" '${getPlaywrightMcpWrapperPath().replace(/'/g, `'\\''`)}' "$@"`,
      '',
    ].join('\n'), 0o755);
  }

  writeFileIfChanged(getPlaywrightMcpWrapperPath(), buildPlaywrightWrapperScript());

  return {
    root: getToolchainRoot(),
    binDir,
    npmProjectDir: getNpmProjectDir(),
    npmBinDir: getNpmBinDir(),
    npmCacheDir: getNpmCacheDir(),
    browsersDir: getPlaywrightBrowsersDir(),
    nodeShim: getNodeShimPath(),
    npmShim: getNpmShimPath(),
    npxShim: getNpxShimPath(),
    playwrightMcpCommand: getPlaywrightMcpCommandPath(),
  };
}

function pathKeyForEnv(env) {
  return Object.keys(env || {}).find((key: any) => key.toLowerCase() === 'path') || 'PATH';
}

function prependPath(env, entries) {
  const key = pathKeyForEnv(env);
  const delimiter = path.delimiter;
  const current = String(env[key] || '');
  const cleanEntries = entries.filter(Boolean);
  env[key] = [...cleanEntries, current].filter(Boolean).join(delimiter);
  if (process.platform === 'win32' && key !== 'Path') {
    env.Path = env[key];
  }
  return env;
}

function buildToolEnv(baseEnv = process.env) {
  const files = ensureToolchainFiles();
  const env = { ...(baseEnv || {}) };
  env.SALES_CLAW_TOOLCHAIN_ROOT = files.root;
  env.SALES_CLAW_ELECTRON_NODE = process.execPath;
  env.PLAYWRIGHT_BROWSERS_PATH = files.browsersDir;
  env.NPM_CONFIG_CACHE = files.npmCacheDir;
  env.NPM_CONFIG_PREFIX = files.npmProjectDir;
  env.npm_config_cache = files.npmCacheDir;
  env.npm_config_prefix = files.npmProjectDir;
  prependPath(env, [files.binDir, files.npmBinDir]);
  return env;
}

function runProcess(command, args: unknown[] = [], options: Record<string, any> = {}) {
  const timeoutMs = options.timeout || PROCESS_TIMEOUT_MS;
  const maxBuffer = options.maxBuffer || 4 * 1024 * 1024;
  return new Promise<unknown>((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd || PROJECT_ROOT,
      env: options.env || process.env,
      shell: false,
      windowsHide: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const append = (current, chunk) => {
      const next = current + chunk.toString();
      return next.length > maxBuffer ? next.slice(next.length - maxBuffer) : next;
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch (_) {}
    }, timeoutMs);

    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, code: null, stdout, stderr, error, timedOut: false });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        ok: !timedOut && code === 0,
        code,
        stdout,
        stderr,
        error: timedOut ? new Error(`Process timed out after ${timeoutMs}ms`) : null,
        timedOut,
      });
    });
  });
}

function buildEmbeddedNodeEnv(extraEnv: Record<string, any> = {}) {
  const env = buildToolEnv({ ...process.env, ...(extraEnv || {}) });
  env.ELECTRON_RUN_AS_NODE = '1';
  return env;
}

async function runEmbeddedNode(args: unknown[] = [], options: Record<string, any> = {}) {
  return runProcess(process.execPath, args, {
    ...options,
    env: buildEmbeddedNodeEnv(options.env),
  });
}

async function runEmbeddedNpm(args: unknown[] = [], options: Record<string, any> = {}) {
  ensureToolchainFiles();
  return runEmbeddedNode([getNpmCliPath(), ...args], options);
}

async function probeEmbeddedNpmStatus() {
  try {
    ensureToolchainFiles();
    if (!fs.existsSync(getNpmCliPath())) {
      return {
        available: false,
        source: 'embedded',
        version: null,
        error: 'Bundled npm package is missing from the application.',
        command: getNpmShimPath(),
      };
    }
    const result: any = await runEmbeddedNpm(['--version'], { timeout: 15000 });
    const version = String(result.stdout || result.stderr || '').trim().split(/\r?\n/)[0].trim();
    // npm --version が semver を返したら、たとえ exit code が非0でも npm 自体は稼働中とみなす。
    // (npm 10.x の deprecation 警告等で nonzero exit を返すケースを救済)
    const semverLike = /^\d+\.\d+\.\d+$/.test(version);
    const isAvailable = (result.ok && !!version) || semverLike;
    return {
      available: isAvailable,
      source: 'embedded',
      version: version || null,
      error: isAvailable ? null : String(result.stderr || result.stdout || result.error?.message || 'Bundled npm did not respond.').trim(),
      command: getNpmShimPath(),
    };
  } catch (error) {
    return {
      available: false,
      source: 'embedded',
      version: null,
      error: error.message,
      command: getNpmShimPath(),
    };
  }
}

function findChromiumExecutable(root = getPlaywrightBrowsersDir()) {
  const subpaths = process.platform === 'win32'
    ? [['chrome-win64', 'chrome.exe'], ['chrome-win', 'chrome.exe']]
    : process.platform === 'darwin'
      ? [['chrome-mac-arm64', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'], ['chrome-mac-x64', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'], ['chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium']]
      : [['chrome-linux64', 'chrome'], ['chrome-linux', 'chrome']];
  let entries: unknown[] = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
      .filter((entry: any) => entry.isDirectory())
      .map((entry: any) => path.join(root, entry.name))
      .filter((entryPath: any) => /(?:^|[\\/])chromium-|(?:^|[\\/])chrome-for-testing-/.test(entryPath));
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

async function installPlaywrightChromium(options: Record<string, any> = {}) {
  ensureToolchainFiles();
  const existing = findChromiumExecutable();
  if (existing && !options.force) {
    return {
      ok: true,
      reused: true,
      browser: 'chromium',
      executablePath: existing,
      browsersDir: getPlaywrightBrowsersDir(),
      command: 'bundled @playwright/mcp install-browser chromium',
    };
  }

  const result: any = await runEmbeddedNode([getPlaywrightMcpCliPath(), 'install-browser', 'chromium'], {
    timeout: options.timeout || PROCESS_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
  });
  const executablePath = findChromiumExecutable();
  return {
    ok: result.ok && !!executablePath,
    reused: false,
    browser: 'chromium',
    executablePath,
    browsersDir: getPlaywrightBrowsersDir(),
    code: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.ok && executablePath ? null : String(result.stderr || result.stdout || result.error?.message || 'Chromium installation did not complete.').trim(),
    command: 'bundled @playwright/mcp install-browser chromium',
  };
}

async function probePlaywrightMcpStatus() {
  // 1.2.111+: 起動シム (playwright-mcp-wrapper.cjs) が壊れていた場合に備え、
  // 1度だけ「ラッパ削除→ensureToolchainFiles で再生成→再試行」の自己回復を行う。
  // 過去ケース: TS 型注釈が .cjs テンプレ文字列に混入し SyntaxError → 永続「未準備」化。
  const runProbe = async () => {
    const result: any = await runEmbeddedNode([getPlaywrightMcpWrapperPath(), '--help'], {
      timeout: 15000,
      maxBuffer: 1024 * 1024,
    });
    const output = String(result.stdout || result.stderr || '').trim();
    const available = result.ok && /Usage: Playwright MCP/i.test(output);
    return { result, output, available };
  };
  try {
    ensureToolchainFiles();
    let probe = await runProbe();
    if (!probe.available) {
      try {
        const wrapper = getPlaywrightMcpWrapperPath();
        if (fs.existsSync(wrapper)) fs.unlinkSync(wrapper);
      } catch (_) { /* ignore */ }
      ensureToolchainFiles();
      probe = await runProbe();
    }
    const { result, output, available } = probe;
    const executablePath = findChromiumExecutable();
    return {
      available,
      browserInstalled: !!executablePath,
      executablePath,
      browsersDir: getPlaywrightBrowsersDir(),
      command: getPlaywrightMcpCommandPath(),
      source: 'bundled',
      error: available ? null : (output || String(result.error?.message || 'Playwright MCP bootstrap check failed.').trim()),
    };
  } catch (error) {
    return {
      available: false,
      browserInstalled: false,
      executablePath: null,
      browsersDir: getPlaywrightBrowsersDir(),
      command: getPlaywrightMcpCommandPath(),
      source: 'bundled',
      error: error.message,
    };
  }
}

function getPlaywrightMcpCommandSpec() {
  ensureToolchainFiles();
  // Spawn the Electron exe directly as Node (ELECTRON_RUN_AS_NODE=1) instead
  // of pointing at a .cmd shim. On Windows, spawning a .cmd file forces a
  // cmd.exe console window to appear (the parent has no way to pass
  // windowsHide:true through Claude Code's MCP spawn). Electron exe is a
  // proper exe, so no console window is created.
  return {
    command: process.execPath,
    args: [getPlaywrightMcpWrapperPath()],
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      PLAYWRIGHT_BROWSERS_PATH: getPlaywrightBrowsersDir(),
      PLAYWRIGHT_MCP_BROWSER: 'chromium',
    },
  };
}

function getProviderExecutableCandidates(providerId) {
  const provider = getProvider(normalizeProviderId(providerId));
  ensureToolchainFiles();
  const binDir = getNpmBinDir();
  const names = new Set<any>();
  for (const executableName of provider.executableNames || []) {
    names.add(executableName);
    names.add(path.parse(executableName).name);
  }
  names.add(provider.id);

  const candidates: unknown[] = [];
  for (const name of names) {
    if (!name) continue;
    candidates.push(path.join(binDir, name));
    if (process.platform === 'win32' && !/\.(cmd|exe|ps1)$/i.test(name)) {
      candidates.push(path.join(binDir, `${name}.cmd`));
      candidates.push(path.join(binDir, `${name}.exe`));
      candidates.push(path.join(binDir, `${name}.ps1`));
    }
  }
  return Array.from(new Set(candidates.map((entry: any) => path.resolve(entry))));
}

async function installProviderCli(providerId, options: Record<string, any> = {}) {
  const provider = getProvider(normalizeProviderId(providerId));
  ensureToolchainFiles();
  const npmStatus: any = await probeEmbeddedNpmStatus();
  if (!npmStatus.available) {
    return {
      ok: false,
      provider: provider.id,
      providerLabel: provider.displayName,
      error: npmStatus.error || 'Bundled npm is unavailable.',
      command: getProviderInstallCommand(provider.id),
    };
  }

  const args = [
    'install',
    '--prefix', getNpmProjectDir(),
    '--cache', getNpmCacheDir(),
    '--no-audit',
    '--no-fund',
    '--save-exact',
    provider.installPackage,
  ];
  const result: any = await runEmbeddedNpm(args, {
    timeout: options.timeout || PROCESS_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
  });
  const candidates = getProviderExecutableCandidates(provider.id).filter((entry: any) => fs.existsSync(entry));
  // エラーメッセージの組み立て:
  // - npm が exit 0 で返したのに binary が見つからない場合は、npm の stdout/stderr ではなく
  //   「インストール後に CLI が検出できませんでした」と明示する。npm の version banner
  //   ("10.9.8" 等) や fund メッセージが UI に "インストール失敗: 10.9.8" として
  //   表示されると、ユーザーには何が起きたのか伝わらないため。
  // - npm が exit 非 0 の場合のみ、stderr/stdout を error として表示する。
  let errorMessage: any = null;
  if (!result.ok || candidates.length === 0) {
    if (!result.ok) {
      const raw = String(result.stderr || result.stdout || result.error?.message || '').trim();
      const semverOnly = /^v?\d+\.\d+\.\d+$/.test(raw);
      errorMessage = semverOnly || !raw
        ? `${provider.cliLabel} のインストールに失敗しました (npm exit code: ${result.code ?? '不明'})`
        : raw;
    } else {
      errorMessage = `${provider.cliLabel} のインストール完了後、実行ファイルが見つかりませんでした。Sales Claw の管理者権限・ウイルス対策ソフトの除外設定をご確認ください。`;
    }
  }
  return {
    ok: result.ok && candidates.length > 0,
    provider: provider.id,
    providerLabel: provider.displayName,
    packageName: provider.installPackage,
    executablePath: candidates[0] || null,
    code: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
    error: errorMessage,
    command: getProviderInstallCommand(provider.id),
  };
}

function getProviderInstallCommand(providerId) {
  const provider = getProvider(normalizeProviderId(providerId));
  return `Sales Claw embedded npm install ${provider.installPackage}`;
}

async function installAiRuntime(providerId, options: Record<string, any> = {}) {
  const provider = getProvider(normalizeProviderId(providerId));
  const cli: any = await installProviderCli(provider.id, options);
  if (!cli.ok) return { ok: false, provider: provider.id, providerLabel: provider.displayName, cli };

  const playwright: any = await installPlaywrightChromium(options);
  if (!playwright.ok) return { ok: false, provider: provider.id, providerLabel: provider.displayName, cli, playwright };

  return {
    ok: true,
    provider: provider.id,
    providerLabel: provider.displayName,
    cli,
    playwright,
  };
}

/**
 * AI ツールチェーンの「準備済みか」を非破壊的に確認する。
 * インストールは行わず、現在の検出可能な状態のみ返す。
 *
 * 用途: UI の初回ロード時に呼んで、未準備なら最初から準備バナーを表示する。
 */
async function probeAiToolchainStatus(providerId) {
  const provider = getProvider(normalizeProviderId(providerId));
  ensureToolchainFiles();

  // CLI 検出
  const cliCandidates = getProviderExecutableCandidates(provider.id).filter((p: any) => fs.existsSync(p));
  const cliInstalled = cliCandidates.length > 0;

  // Chromium 検出
  const chromium = findChromiumExecutable();

  // npm 内蔵モジュール検出 (新規インストール時に必要)
  let npmReady = false;
  try {
    npmReady = fs.existsSync(getNpmCliPath());
  } catch (_) { npmReady = false; }

  const overall = cliInstalled && !!chromium;

  return {
    ok: overall,
    provider: provider.id,
    providerLabel: provider.displayName,
    cli: {
      installed: cliInstalled,
      executablePath: cliCandidates[0] || null,
      packageName: provider.installPackage,
    },
    browser: {
      installed: !!chromium,
      executablePath: chromium,
      browsersDir: getPlaywrightBrowsersDir(),
    },
    npm: {
      available: npmReady,
      command: getNpmShimPath(),
    },
  };
}

/**
 * 進捗コールバック付きで AI ツールチェーン全体を準備する。
 *
 * onProgress({ stage, progress, message, detail }) を介して各段階の状態を通知する。
 *   stage: 'probe' | 'cli_install' | 'browser_install' | 'verify' | 'done' | 'error'
 *   progress: 0-100 (stage 内の概算)
 *
 * 既に準備済みの場合は CLI/Browser それぞれの reused=true で即時返す。
 */
async function installAiRuntimeWithProgress(providerId, onProgress = (_e: any) => {}, options: Record<string, any> = {}) {
  const provider = getProvider(normalizeProviderId(providerId));
  const emit = (stage: string, progress: number, message: string, detail: any = null) => {
    try { onProgress({ stage, progress, message, detail }); } catch (_) {}
  };

  // === Stage 1: probe ===
  emit('probe', 0, '準備状態を確認しています...');
  const status: any = await probeAiToolchainStatus(provider.id);
  if (status.ok) {
    emit('done', 100, `${provider.displayName} と Chromium は既に準備済みです`, { reused: true, status });
    return {
      ok: true,
      provider: provider.id,
      providerLabel: provider.displayName,
      reused: true,
      cli: { ok: true, reused: true, executablePath: status.cli.executablePath },
      playwright: { ok: true, reused: true, executablePath: status.browser.executablePath, browsersDir: status.browser.browsersDir },
    };
  }
  if (!status.npm.available) {
    const err = `内蔵 npm が利用できないため自動インストールを開始できません。アプリの再インストールが必要かもしれません。`;
    emit('error', 0, err, { stage: 'probe' });
    return { ok: false, provider: provider.id, providerLabel: provider.displayName, error: err };
  }
  emit('probe', 100, '準備状態の確認完了');

  // === Stage 2: CLI install ===
  let cliResult: any;
  if (!status.cli.installed) {
    emit('cli_install', 0, `${provider.cliLabel} をダウンロード中... (~30 秒)`);
    cliResult = await installProviderCli(provider.id, options);
    if (!cliResult.ok) {
      const err = cliResult.error || `${provider.cliLabel} のインストールに失敗しました`;
      const hint = diagnoseInstallError(err);
      emit('error', 0, err + (hint ? `\n${hint}` : ''), { stage: 'cli_install', raw: cliResult });
      return { ok: false, provider: provider.id, providerLabel: provider.displayName, cli: cliResult, error: err, hint };
    }
    emit('cli_install', 100, `${provider.cliLabel} のインストール完了`);
  } else {
    cliResult = { ok: true, reused: true, executablePath: status.cli.executablePath };
    emit('cli_install', 100, `${provider.cliLabel} は既にインストール済み (スキップ)`);
  }

  // === Stage 3: Browser install ===
  let pwResult: any;
  if (!status.browser.installed) {
    emit('browser_install', 0, 'Chromium ブラウザをダウンロード中... (~90 秒)');
    pwResult = await installPlaywrightChromium(options);
    if (!pwResult.ok) {
      const err = pwResult.error || 'Chromium のダウンロードに失敗しました';
      const hint = diagnoseInstallError(err);
      emit('error', 0, err + (hint ? `\n${hint}` : ''), { stage: 'browser_install', raw: pwResult });
      return { ok: false, provider: provider.id, providerLabel: provider.displayName, cli: cliResult, playwright: pwResult, error: err, hint };
    }
    emit('browser_install', 100, 'Chromium のダウンロード完了');
  } else {
    pwResult = { ok: true, reused: true, executablePath: status.browser.executablePath, browsersDir: status.browser.browsersDir };
    emit('browser_install', 100, 'Chromium は既に準備済み (スキップ)');
  }

  // === Stage 4: Verify ===
  emit('verify', 0, '動作確認中...');
  const finalStatus: any = await probeAiToolchainStatus(provider.id);
  if (!finalStatus.ok) {
    const err = `インストール完了後の検証に失敗しました: ${
      !finalStatus.cli.installed ? `${provider.cliLabel} 実行ファイルが見つかりません` : 'Chromium が見つかりません'
    }`;
    emit('error', 0, err, { stage: 'verify' });
    return { ok: false, provider: provider.id, providerLabel: provider.displayName, cli: cliResult, playwright: pwResult, error: err };
  }
  emit('verify', 100, '動作確認完了');

  emit('done', 100, `${provider.displayName} の準備が完了しました`, { reused: false, status: finalStatus });
  return {
    ok: true,
    provider: provider.id,
    providerLabel: provider.displayName,
    reused: false,
    cli: cliResult,
    playwright: pwResult,
  };
}

/**
 * 典型的なインストールエラーメッセージから対処ヒントを返す。
 */
function diagnoseInstallError(errorText: string): string {
  if (typeof errorText !== 'string' || !errorText) return '';
  const t = errorText.toLowerCase();
  if (/econnrefused|enotfound|etimedout|getaddrinfo|network|dns/i.test(t)) {
    return 'ヒント: インターネット接続またはプロキシ設定をご確認ください。社内プロキシ経由の場合は HTTP_PROXY / HTTPS_PROXY 環境変数の設定が必要です。';
  }
  if (/enospc|no space left|out of space|disk full/i.test(t)) {
    return 'ヒント: ディスク空き容量が不足しています。Chromium には約 500MB 必要です。';
  }
  if (/eacces|permission denied|access denied/i.test(t)) {
    return 'ヒント: ファイルアクセス権限の問題です。管理者権限で実行するか、ウイルス対策ソフトの除外設定をご確認ください。';
  }
  if (/cert(ificate)?|self.signed|ssl/i.test(t)) {
    return 'ヒント: 証明書エラーです。社内ネットワークの中間 SSL 証明書設定をご確認ください。';
  }
  if (/proxy|407/i.test(t)) {
    return 'ヒント: プロキシ認証が必要です。HTTP_PROXY 環境変数に user:pass@host:port 形式で設定してください。';
  }
  if (/404|not found/i.test(t) && /registry|npmjs/i.test(t)) {
    return 'ヒント: npm レジストリへの接続を確認してください。社内レジストリを使用している場合は .npmrc を確認してください。';
  }
  return '';
}

module.exports = {
  buildToolEnv,
  ensureToolchainFiles,
  findChromiumExecutable,
  getBinDir,
  getNpmBinDir,
  getNpmCacheDir,
  getNpmProjectDir,
  getPlaywrightBrowsersDir,
  getPlaywrightMcpCommandSpec,
  getPlaywrightMcpCommandPath,
  getProviderExecutableCandidates,
  getProviderInstallCommand,
  getToolchainRoot,
  installAiRuntime,
  installAiRuntimeWithProgress,
  installPlaywrightChromium,
  installProviderCli,
  probeAiToolchainStatus,
  probeEmbeddedNpmStatus,
  probePlaywrightMcpStatus,
  diagnoseInstallError,
  runEmbeddedNode,
  runEmbeddedNpm,
};

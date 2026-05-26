// Sales Claw — Electron メインプロセス (TypeScript port)
import { app, BrowserWindow, Tray, Menu, nativeImage, dialog, shell, powerSaveBlocker, type NativeImage } from 'electron';
import { autoUpdater } from 'electron-updater';
import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';

// ─── Internal modules ────────────────────────────────────────────────
// These modules are CommonJS today (legacy .cjs renamed to .ts with @ts-nocheck during migration).
// We use require() with explicit type casts so electron-main.ts stays strictly typed
// while the source modules are migrated incrementally.

interface SettingsManagerModule {
  SETTINGS_FILE: string;
  SAMPLE_SETTINGS_FILE: string;
  [key: string]: unknown;
}

interface DataPathsModule {
  resolveDataPath: (...segments: string[]) => string;
  [key: string]: unknown;
}

export interface DashboardRuntime {
  url: string;
  port: number | string;
  host?: string;
  pid?: number;
  startedAt?: number;
  [key: string]: unknown;
}

interface DashboardRuntimeModule {
  readRuntime: () => DashboardRuntime | null;
  [key: string]: unknown;
}

interface FormSessionManagerCtor {
  new (windowGetter: () => BrowserWindow | null): {
    onWindowResize(): void;
    [key: string]: unknown;
  };
}

interface FormSessionManagerModule {
  FormSessionManager: FormSessionManagerCtor;
  [key: string]: unknown;
}

interface StartupCleanupModule {
  cleanupStaleFiles: () => { removed: string[]; errors: unknown[] };
  [key: string]: unknown;
}

interface LocalToolchainModule {
  installPlaywrightChromium: () => Promise<InstallerOutcome & { reused?: boolean; bundled?: boolean } | void>;
  installProviderCli: (provider: string) => Promise<InstallerOutcome & { reused?: boolean; bundled?: boolean } | void>;
  [key: string]: unknown;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const settingsManager = require('./src/settings-manager') as SettingsManagerModule;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { resolveDataPath } = require('./src/data-paths') as DataPathsModule;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { readRuntime } = require('./src/dashboard-runtime') as DashboardRuntimeModule;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { FormSessionManager } = require('./src/form-session-manager') as FormSessionManagerModule;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { cleanupStaleFiles } = require('./src/startup-cleanup') as StartupCleanupModule;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const localToolchain = require('./src/local-toolchain') as LocalToolchainModule;
type FormSessionManagerInstance = InstanceType<FormSessionManagerCtor>;

interface AutoUpdateState {
  enabled: boolean;
  reason: string | null;
}

interface UpdateStatusPayload {
  state: string;
  version?: string;
  remoteVersion?: string | null;
  percent?: number;
  message?: string;
  transient?: boolean;
  checkReason?: string;
  lastCheckStartedAt?: number | null;
  lastCheckedAt?: number;
}

interface InstallerOutcome {
  ok?: boolean;
  error?: string;
  cli?: { error?: string };
  playwright?: { error?: string };
}

// app の型に isQuiting を追加 (Electron 公式 API 外のカスタムフラグ)
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Electron {
    interface App {
      isQuiting?: boolean;
    }
  }
}

// 1.2.95: GitHub Releases の latest.yml/blockmap fetch 時に Varnish (Fastly CDN) が
// 古い 302 redirect 先 (release-assets.githubusercontent.com の事前署名 URL) を
// キャッシュ返却すると、内包 JWT が expire 済 (TTL 1h) になり "618 jwt:expired" で
// チェック失敗する。Cache-Control: no-cache をリクエストヘッダに付け、毎回
// オリジンから fresh redirect を取り直すことで回避する。
autoUpdater.requestHeaders = {
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
};

// 開発モードでは専用ディレクトリを使う（%APPDATA%\Electron を他アプリと共有しない）
if (!app.isPackaged) {
  app.setPath('userData', path.join(__dirname, '..', '.electron-userdata'));
}

const runtimeUserDataDir = path.join(app.getPath('userData'), 'runtime');
if (!process.env.SALES_CLAW_USER_DATA_DIR) {
  process.env.SALES_CLAW_USER_DATA_DIR = runtimeUserDataDir;
}
if (process.platform === 'win32') {
  app.disableHardwareAcceleration();
}

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let serverStarted = false;
let dashboardRuntime: DashboardRuntime | null = null;

const formSessionManager: FormSessionManagerInstance = new FormSessionManager(() => mainWindow);

const APP_VERSION = app.getVersion();
const BUILD_SOURCE: 'installed' | 'development' = app.isPackaged ? 'installed' : 'development';
const PLACEHOLDER_UPDATE_OWNERS = new Set(['', 'local', 'local-test', 'your-org', 'your-username', 'example']);
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

function readAppUpdateConfig(): Record<string, string> | null {
  try {
    const configPath = path.join(process.resourcesPath, 'app-update.yml');
    if (!fs.existsSync(configPath)) return null;
    const parsed: Record<string, string> = {};
    for (const line of fs.readFileSync(configPath, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^([A-Za-z0-9_]+):\s*(.+)\s*$/);
      if (!match) continue;
      parsed[match[1]] = match[2].trim();
    }
    return parsed;
  } catch (_err) {
    return null;
  }
}

function resolveAutoUpdateState(): AutoUpdateState {
  if (!app.isPackaged) {
    return { enabled: false, reason: 'Development build: auto-update is disabled.' };
  }
  if (process.env.SALES_CLAW_DISABLE_AUTO_UPDATE === '1') {
    return { enabled: false, reason: 'Auto-update is disabled by environment configuration.' };
  }
  const config = readAppUpdateConfig();
  const owner = String(config?.owner ?? '').trim();
  const repo = String(config?.repo ?? '').trim();
  if (!config || !owner || !repo) {
    return { enabled: false, reason: 'Auto-update feed is not configured for this build.' };
  }
  if (PLACEHOLDER_UPDATE_OWNERS.has(owner) || (owner === 'local-test' && repo === 'sales-claw')) {
    return { enabled: false, reason: 'Auto-update is disabled for local verification builds.' };
  }
  return { enabled: true, reason: null };
}

const AUTO_UPDATE_STATE = resolveAutoUpdateState();
const AUTO_UPDATE_ENABLED = AUTO_UPDATE_STATE.enabled;

process.env.SALES_CLAW_APP_VERSION = APP_VERSION;
process.env.SALES_CLAW_BUILD_SOURCE = BUILD_SOURCE;
process.env.SALES_CLAW_AUTO_UPDATE_ENABLED = AUTO_UPDATE_ENABLED ? '1' : '0';

const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  app.quit();
}

// ─── アイコン ────────────────────────────────────────────────
function getIcon(size: 'icon' | 'tray' = 'icon'): NativeImage {
  const candidates: string[] = [
    path.join(__dirname, '..', 'assets', `${size}.png`),
    path.join(__dirname, '..', 'assets', 'icon.png'),
  ];
  if (process.resourcesPath && app.isPackaged) {
    candidates.push(
      path.join(process.resourcesPath, 'assets', `${size}.png`),
      path.join(process.resourcesPath, 'assets', 'icon.png')
    );
  }
  for (const p of candidates) {
    if (fs.existsSync(p)) return nativeImage.createFromPath(p);
  }
  return nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAMAAAAoLQ9TAAAAB3RJTUUH6AQRAyshSX0KUQAAAB' +
    'JJREFUGNNjYBgFgx8wEAIAAQABAAH/dswAAAAASUVORK5CYII='
  );
}

function getDashboardUrl(): string {
  return (dashboardRuntime ?? readRuntime())?.url ?? 'http://127.0.0.1:3765';
}

function isSafeDashboardUrl(rawUrl: string): boolean {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) return false;
  let parsed: URL;
  try { parsed = new URL(rawUrl); } catch { return false; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') return false;
  return true;
}

function getSafeDashboardUrl(): string {
  const url = getDashboardUrl();
  if (isSafeDashboardUrl(url)) return url;
  console.warn('[Electron] runtime.json から得た URL が安全でないため fallback:', url);
  return 'http://127.0.0.1:3765';
}

function getDashboardPortLabel(): number | string {
  return (dashboardRuntime ?? readRuntime())?.port ?? 3765;
}

// ─── ダッシュボードサーバー起動 ──────────────────────────────
interface DashboardModule {
  startDashboardServer: (opts: { formSessionManager: FormSessionManagerInstance }) => Promise<DashboardRuntime>;
  gracefulShutdown?: (reason: string, code: number) => Promise<void> | void;
}

function resolveDashboardModule(): DashboardModule {
  const devSrc = process.env.SALES_CLAW_DEV_DASHBOARD_SRC;
  if (devSrc) {
    try {
      for (const ext of ['.js', '.cjs']) {
        const candidate = path.join(devSrc, `dashboard-server${ext}`);
        if (fs.existsSync(candidate)) {
          console.log('[Electron] dev override: loading dashboard from', candidate);
          delete require.cache[require.resolve(candidate)];
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          return require(candidate) as DashboardModule;
        }
      }
      console.warn('[Electron] SALES_CLAW_DEV_DASHBOARD_SRC set but no dashboard-server.{js,cjs} at:', devSrc);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('[Electron] dev override failed, falling back to bundled:', msg);
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('./src/dashboard-server') as DashboardModule;
}

async function startServer(): Promise<DashboardRuntime> {
  if (serverStarted && dashboardRuntime) return dashboardRuntime;
  try {
    const { startDashboardServer } = resolveDashboardModule();
    dashboardRuntime = await startDashboardServer({ formSessionManager });
    serverStarted = true;
    return dashboardRuntime;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[Electron] サーバー起動失敗:', msg);
    throw err;
  }
}

function waitForServer(timeout = 20000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = (): void => {
      const req = http.get(getDashboardUrl(), () => resolve());
      req.on('error', () => {
        if (Date.now() - start > timeout) reject(new Error('サーバー起動タイムアウト'));
        else setTimeout(check, 500);
      });
      req.end();
    };
    check();
  });
}

// ─── メインウィンドウ ─────────────────────────────────────────
function createWindow(): void {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return;
  }

  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: 'Sales Claw',
    icon: getIcon(),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: true,
      spellcheck: false,
    },
  });

  void mainWindow.loadURL(getSafeDashboardUrl());
  mainWindow.setMenuBarVisibility(false);

  mainWindow.on('resize', () => formSessionManager.onWindowResize());

  mainWindow.on('close', (event) => {
    if (!app.isQuiting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ─── システムトレイ ───────────────────────────────────────────
function createTray(): void {
  if (tray) return;
  tray = new Tray(getIcon('tray'));
  tray.setToolTip('Sales Claw');

  const openOnboardingFresh = (): void => {
    const base = getSafeDashboardUrl().replace(/\/+$/, '');
    const url = `${base}/onboarding?fresh=1`;
    createWindow();
    if (mainWindow) {
      void mainWindow.loadURL(url);
      mainWindow.focus();
    }
  };

  const buildMenu = (): Electron.Menu => Menu.buildFromTemplate([
    {
      label: 'ダッシュボードを開く',
      click: () => { createWindow(); mainWindow?.focus(); },
    },
    {
      label: 'ブラウザで開く',
      click: () => { void shell.openExternal(getSafeDashboardUrl()); },
    },
    { type: 'separator' },
    {
      label: '初期設定をやり直す…',
      click: openOnboardingFresh,
    },
    { type: 'separator' },
    { label: `ポート: ${getDashboardPortLabel()}`, enabled: false },
    { type: 'separator' },
    { label: '終了', click: () => app.quit() },
  ]);

  tray.setContextMenu(buildMenu());
  tray.on('click', () => { createWindow(); mainWindow?.focus(); });
  tray.on('double-click', () => { createWindow(); mainWindow?.focus(); });
}

// ─── 初回セットアップ ─────────────────────────────────────────
async function firstRunSetup(): Promise<void> {
  const settingsPath = settingsManager.SETTINGS_FILE;
  const samplePath = settingsManager.SAMPLE_SETTINGS_FILE;

  if (!fs.existsSync(settingsPath) && fs.existsSync(samplePath)) {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.copyFileSync(samplePath, settingsPath);

    // 同梱バンドル (prebuilt-bundles/) で Playwright Chromium と Claude CLI が
    // 既に揃っているなら、ネットワーク DL ダイアログを出さずに静かにスキップする。
    // installer に同梱した分だけで初回起動可能 = AV ブロックも DL 待ちも無し。
    //
    // 重要: ユーザーが事前に `npm install -g @anthropic-ai/claude-code` などで
    // システムグローバルに CLI を入れているケースでは status.ok=true になるが、
    // それは「installer 同梱で揃っている」とは別物。同梱バンドル経由 (bundled=true)
    // のみをダイアログ skip の根拠にする。
    const installer = localToolchain as unknown as {
      probeAiToolchainStatus?: (providerId: string) => Promise<{
        ok?: boolean;
        cli?: { installed?: boolean; bundled?: boolean };
        browser?: { installed?: boolean; bundled?: boolean };
      }>;
    };
    let bundledReady = false;
    try {
      if (typeof installer.probeAiToolchainStatus === 'function') {
        const status = await installer.probeAiToolchainStatus('claude');
        bundledReady = !!(
          status?.cli?.installed && status.cli.bundled &&
          status?.browser?.installed && status.browser.bundled
        );
      }
    } catch (_err) { /* 失敗時は従来パスへフォールバック */ }

    if (bundledReady) return;

    const choice = await dialog.showMessageBox({
      type: 'info',
      title: 'Sales Claw — 初回セットアップ',
      message: '初回起動を検出しました',
      detail:
        '設定ファイルを作成しました。\n\n' +
        'Sales Claw 内蔵セットアップで Playwright (Chromium) と Claude Code CLI の準備を試行できます。\n' +
        'PC 側に Node.js / npm / Playwright が入っていなくても、アプリ管理下に順番に配置します。\n\n' +
        '後からダッシュボードの「AI CLI を準備」ボタンでも実行できます。',
      buttons: ['インストール', 'スキップ（後で）'],
      defaultId: 0,
    });

    if (choice.response === 0) {
      await installPlaywright();
      await installClaudeCli();
    }
  }
}

function runInstaller(
  task: () => Promise<InstallerOutcome | void> | InstallerOutcome | void,
  title: string,
  message: string,
  failureTitle: string,
  failureDetail: string
): Promise<boolean> {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 560,
      height: 220,
      title,
      resizable: false,
      webPreferences: { nodeIntegration: false },
    });
    win.setMenuBarVisibility(false);
    void win.loadURL('about:blank');
    void win.webContents.executeJavaScript(`
      document.body.style.cssText = 'font-family:sans-serif;padding:30px;background:#1e1e2e;color:#cdd6f4';
      document.body.innerHTML = '<h3 style="margin:0 0 12px">${message}</h3><p style="color:#a6adc8;margin:0">しばらくお待ちください。</p>';
    `);

    Promise.resolve()
      .then(task)
      .then((result) => {
        if (result && result.ok === false) {
          throw new Error(result.error ?? result.cli?.error ?? result.playwright?.error ?? 'セットアップに失敗しました。');
        }
        win.close();
        resolve(true);
      })
      .catch((err: unknown) => {
        win.close();
        const msg = err instanceof Error ? err.message : String(err ?? '');
        void dialog.showMessageBox({
          type: 'warning',
          title: failureTitle,
          message: `${title} に失敗しました`,
          detail: `${failureDetail}\n\n${msg}`.trim(),
        });
        resolve(false);
      });
  });
}

function installPlaywright(): Promise<boolean> {
  return runInstaller(
    () => localToolchain.installPlaywrightChromium(),
    'Playwright インストール中...',
    'Playwright (Chromium) をインストール中...',
    'インストール警告',
    '後でダッシュボードの「AI CLI を準備」ボタンから再試行してください。'
  );
}

function installClaudeCli(): Promise<boolean> {
  return runInstaller(
    () => localToolchain.installProviderCli('claude'),
    'Claude CLI インストール中...',
    'Claude Code CLI をインストール中...',
    'インストール警告',
    '後でダッシュボードの「AI CLI を準備」ボタンから再試行してください。'
  );
}

// ─── アプリ起動 ───────────────────────────────────────────────
if (singleInstanceLock) {
  app.on('second-instance', () => {
    createWindow();
  });
}

void app.whenReady().then(async () => {
  try {
    const cleanup = cleanupStaleFiles();
    if (cleanup.removed.length > 0) {
      console.log(`[startup-cleanup] removed ${cleanup.removed.length} stale files`);
    }
    if (cleanup.errors.length > 0) {
      console.warn(`[startup-cleanup] ${cleanup.errors.length} errors during cleanup`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[startup-cleanup] unexpected error:', msg);
  }

  if (process.platform === 'darwin' && app.dock) app.dock.hide();

  try {
    await startServer();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    dialog.showErrorBox(
      'サーバー起動エラー',
      `ダッシュボードサーバーの起動に失敗しました。\n${msg}`
    );
    app.quit();
    return;
  }

  try {
    await waitForServer();
  } catch (_err) {
    dialog.showErrorBox(
      'サーバー起動エラー',
      'ダッシュボードサーバーの起動に失敗しました。\nNode.js がインストールされているか確認してください。'
    );
    app.quit();
    return;
  }

  await firstRunSetup();
  createTray();
  createWindow();

  // v2.1.0 Phase 2e: internal form MCP の IPC server を起動して
  // sales-claw-form MCP server (子プロセス) からの接続を受ける。
  // formFill.mode が 'internal' or 'both' でなければ起動しない (リソース節約)。
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const dashboardServer = require('./src/dashboard-server') as {
      setInternalFormMcpIpcPipePath?: (p: string | null) => void;
      getFormFillMode?: () => 'playwright' | 'internal' | 'both';
    };
    const mode = dashboardServer.getFormFillMode ? dashboardServer.getFormFillMode() : 'playwright';
    if (mode !== 'playwright') {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { createIpcServer } = require('./src/ipc-server') as typeof import('./src/ipc-server');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const dispatcher = require('./src/form-mcp-dispatcher') as typeof import('./src/form-mcp-dispatcher');

      const ipcServer = createIpcServer();
      // settings.getScreenshotDir() と同じ値を返すコールバックを渡す。
      // FormSessionManager.captureScreenshot 内の SSRF / path traversal guard と
      // 必ず一致させる必要があるため (Bug 4 修正、v2.1.0)。
      const sm = settingsManager as unknown as { getScreenshotDir?: () => string };
      dispatcher.registerHandlers(ipcServer, {
        formSessionManager: formSessionManager as unknown as Parameters<typeof dispatcher.registerHandlers>[1]['formSessionManager'],
        getScreenshotDir: () => (sm.getScreenshotDir ? sm.getScreenshotDir() : resolveDataPath('..', 'screenshots')),
      });
      await ipcServer.start();
      if (dashboardServer.setInternalFormMcpIpcPipePath) {
        dashboardServer.setInternalFormMcpIpcPipePath(ipcServer.pipePath);
      }
      console.log(`[ipc-server] sales-claw-form MCP IPC ready at ${ipcServer.pipePath}`);
      app.on('before-quit', () => { void ipcServer.stop(); });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[ipc-server] failed to start internal form MCP IPC:', msg);
    // 起動失敗しても dashboard 自体は使えるので app.quit は避ける
  }

  if (AUTO_UPDATE_ENABLED) {
    // Stale な update-status.json をクリア:
    // 前回起動時に v{X} を download → 再起動でインストール → 今この v{X} を実行中、
    // という流れの場合、update-status.json には "downloaded" + version=X が残っており、
    // ダッシュボードが「v{X} の準備完了 — 今すぐ再起動してインストール」を出し続ける。
    // 既に当該バージョンを実行中なので "up-to-date" に補正してから動かす。
    try {
      if (fs.existsSync(UPDATE_STATUS_FILE)) {
        const existing = JSON.parse(fs.readFileSync(UPDATE_STATUS_FILE, 'utf8'));
        const staleStates = ['downloaded', 'downloading', 'available'];
        if (existing && staleStates.includes(existing.state) &&
            existing.version && String(existing.version) === String(APP_VERSION)) {
          writeUpdateStatus({
            state: 'up-to-date',
            version: APP_VERSION,
            remoteVersion: APP_VERSION,
            checkReason: 'startup-reconciled',
            lastCheckedAt: Date.now(),
            message: `Already running v${APP_VERSION}; cleared stale "${existing.state}" banner from prior run.`,
          });
        }
      }
    } catch (_err) { /* best-effort, ignore parse errors */ }

    setTimeout(() => checkForUpdates('startup'), 5000);
    setInterval(() => checkForUpdates('periodic'), UPDATE_CHECK_INTERVAL_MS);

    const checkFlagFile = resolveDataPath('check-update.flag');
    const installFlagFile = resolveDataPath('install-update.flag');
    setInterval(() => {
      try {
        if (fs.existsSync(checkFlagFile)) {
          fs.unlinkSync(checkFlagFile);
          checkForUpdates('manual');
        }
        if (fs.existsSync(installFlagFile)) {
          fs.unlinkSync(installFlagFile);
          autoUpdater.quitAndInstall();
        }
      } catch (_err) { /* ignore */ }
    }, 2000);
  } else {
    writeUpdateStatus({
      state: BUILD_SOURCE === 'development' ? 'disabled-dev' : 'disabled',
      version: APP_VERSION,
      message: AUTO_UPDATE_STATE.reason ?? (BUILD_SOURCE === 'development'
        ? 'Development build: auto-update is disabled.'
        : 'Auto-update is disabled.'),
    });
  }
});

// ─── 自動更新 ─────────────────────────────────────────────────
const UPDATE_STATUS_FILE = resolveDataPath('update-status.json');
let updateCheckInFlight = false;
let currentUpdateCheckReason: string | null = null;
let lastUpdateCheckStartedAt: number | null = null;

function ensureUpdateDir(): void {
  const dir = path.dirname(UPDATE_STATUS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function writeUpdateStatus(status: UpdateStatusPayload): void {
  try {
    ensureUpdateDir();
    fs.writeFileSync(UPDATE_STATUS_FILE, JSON.stringify({
      appVersion: APP_VERSION,
      buildSource: BUILD_SOURCE,
      autoUpdateEnabled: AUTO_UPDATE_ENABLED,
      ...status,
      ts: Date.now(),
    }));
  } catch (_err) { /* ignore */ }
}

function checkForUpdates(reason: string = 'auto'): void {
  if (!AUTO_UPDATE_ENABLED) {
    writeUpdateStatus({
      state: BUILD_SOURCE === 'development' ? 'disabled-dev' : 'disabled',
      version: APP_VERSION,
      message: AUTO_UPDATE_STATE.reason ?? (BUILD_SOURCE === 'development'
        ? 'Development build: auto-update is disabled.'
        : 'Auto-update is disabled.'),
    });
    return;
  }
  if (updateCheckInFlight) {
    writeUpdateStatus({
      state: 'checking',
      checkReason: currentUpdateCheckReason ?? reason,
      lastCheckStartedAt: lastUpdateCheckStartedAt,
      message: 'Update check is already running.',
    });
    return;
  }
  updateCheckInFlight = true;
  currentUpdateCheckReason = reason;
  lastUpdateCheckStartedAt = Date.now();
  writeUpdateStatus({ state: 'checking', checkReason: reason, lastCheckStartedAt: lastUpdateCheckStartedAt });
  autoUpdater.checkForUpdates().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[AutoUpdater] checkForUpdates error:', msg);
    writeUpdateStatus({
      state: 'error',
      message: msg,
      checkReason: currentUpdateCheckReason ?? reason,
      lastCheckedAt: Date.now(),
    });
  }).finally(() => {
    updateCheckInFlight = false;
  });
}

autoUpdater.on('checking-for-update', () => {
  console.log('[AutoUpdater] checking for update...');
  writeUpdateStatus({
    state: 'checking',
    checkReason: currentUpdateCheckReason ?? 'auto',
    lastCheckStartedAt: lastUpdateCheckStartedAt ?? Date.now(),
  });
});

autoUpdater.on('update-not-available', (info) => {
  console.log('[AutoUpdater] already up to date:', info?.version);
  writeUpdateStatus({
    state: 'up-to-date',
    version: info?.version,
    remoteVersion: info?.version ?? null,
    checkReason: currentUpdateCheckReason ?? 'auto',
    lastCheckedAt: Date.now(),
  });
});

autoUpdater.on('update-available', (info) => {
  console.log('[AutoUpdater] update available:', info.version);
  writeUpdateStatus({
    state: 'available',
    version: info.version,
    remoteVersion: info.version ?? null,
    checkReason: currentUpdateCheckReason ?? 'auto',
    lastCheckedAt: Date.now(),
  });
  const showDialog = (parent: BrowserWindow | null): Promise<Electron.MessageBoxReturnValue> =>
    parent
      ? dialog.showMessageBox(parent, {
          type: 'info',
          title: 'Sales Claw アップデート',
          message: `新しいバージョン ${info.version} が見つかりました`,
          detail: 'バックグラウンドでダウンロードします。完了後に通知します。',
          buttons: ['OK'],
        })
      : dialog.showMessageBox({
          type: 'info',
          title: 'Sales Claw アップデート',
          message: `新しいバージョン ${info.version} が見つかりました`,
          detail: 'バックグラウンドでダウンロードします。',
          buttons: ['OK'],
        });
  showDialog(mainWindow).catch(() => showDialog(null).catch(() => undefined));
});

autoUpdater.on('download-progress', (progress) => {
  writeUpdateStatus({
    state: 'downloading',
    percent: Math.round(progress.percent),
    version: (progress as { version?: string }).version ?? '',
    checkReason: currentUpdateCheckReason ?? 'auto',
    lastCheckedAt: Date.now(),
  });
});

autoUpdater.on('update-downloaded', (info) => {
  console.log('[AutoUpdater] update downloaded:', info.version);
  writeUpdateStatus({
    state: 'downloaded',
    version: info.version,
    remoteVersion: info.version ?? null,
    checkReason: currentUpdateCheckReason ?? 'auto',
    lastCheckedAt: Date.now(),
  });
  const opts: Electron.MessageBoxOptions = {
    type: 'info',
    title: 'アップデート準備完了',
    message: `Sales Claw ${info.version} の準備ができました`,
    detail: '今すぐ再起動してインストールしますか？',
    buttons: ['今すぐ再起動', '後で'],
    defaultId: 0,
  };
  const showFinal = (parent: BrowserWindow | null): Promise<Electron.MessageBoxReturnValue> =>
    parent ? dialog.showMessageBox(parent, opts) : dialog.showMessageBox(opts);
  showFinal(mainWindow)
    .then((result) => { if (result.response === 0) autoUpdater.quitAndInstall(); })
    .catch(() => {
      showFinal(null)
        .then((result) => { if (result.response === 0) autoUpdater.quitAndInstall(); })
        .catch(() => undefined);
    });
});

// v2.0.13: 自動更新の transient エラー (GitHub 一時障害・ネットワーク瞬断 等) は
// 「自動更新エラー: 504」と赤バナーで表示するのは UX として過剰。
//   - 504 / 502 / 503 / Gateway Time-out / ECONNRESET / ENOTFOUND / timeout
//   - 「GitHub Releases didn't get a response in time」のような文言
// これらは silent retry に切り替え、UI バナーは出さない。
// 真に対処が必要な error (404 / 401 / Invalid signature 等) だけ state='error'。
const TRANSIENT_UPDATE_PATTERNS: RegExp[] = [
  /\b50[234]\b/,                     // 502/503/504
  /Gateway\s+Time-?out/i,
  /ETIMEDOUT/i,
  /ECONNRESET/i,
  /ENOTFOUND/i,
  /EAI_AGAIN/i,
  /network\s+(error|timeout|unreachable)/i,
  /socket hang up/i,
  /Could\s+not\s+get\s+code\s+signature/i, // ローカル開発時の transient
];

function isTransientUpdateError(message: string): boolean {
  if (!message) return false;
  return TRANSIENT_UPDATE_PATTERNS.some((re) => re.test(message));
}

const UPDATE_RETRY_DELAY_MS = 5 * 60 * 1000; // 5 分後に再試行
let _updateRetryTimer: NodeJS.Timeout | null = null;

function scheduleTransientUpdateRetry(reason: string): void {
  if (_updateRetryTimer) return; // 既存タイマーを尊重
  _updateRetryTimer = setTimeout(() => {
    _updateRetryTimer = null;
    console.log('[AutoUpdater] retrying after transient error:', reason);
    try {
      autoUpdater.checkForUpdates().catch((err: unknown) => {
        console.error('[AutoUpdater] retry checkForUpdates rejected:', err);
      });
    } catch (err) {
      console.error('[AutoUpdater] retry threw synchronously:', err);
    }
  }, UPDATE_RETRY_DELAY_MS);
  if (typeof _updateRetryTimer.unref === 'function') _updateRetryTimer.unref();
}

autoUpdater.on('error', (err: Error | null) => {
  const msg = err?.message ?? String(err);
  console.error('[AutoUpdater] error:', msg);
  const transient = isTransientUpdateError(msg);
  writeUpdateStatus({
    // transient なら UI が「エラー」バナーを出さないよう専用 state にする。
    // sleep state からの復帰時に自動 retry が再評価する。
    state: transient ? 'transient-error' : 'error',
    message: msg,
    transient,
    checkReason: currentUpdateCheckReason ?? 'auto',
    lastCheckedAt: Date.now(),
  });
  if (transient) {
    scheduleTransientUpdateRetry(msg.slice(0, 120));
  }
});

app.on('window-all-closed', () => { /* tray に常駐 */ });
app.on('activate', () => { createWindow(); });

let _gracefulQuitInProgress = false;
const _gracefulQuitDeadlineMs = 8000;

app.on('before-quit', (event) => {
  app.isQuiting = true;
  serverStarted = false;

  if (_gracefulQuitInProgress) {
    return;
  }
  _gracefulQuitInProgress = true;

  let dashboard: DashboardModule | null;
  try { dashboard = resolveDashboardModule(); } catch (_err) { dashboard = null; }
  if (!dashboard || typeof dashboard.gracefulShutdown !== 'function') {
    return;
  }

  event.preventDefault();
  console.log('[Electron] before-quit: invoking dashboard gracefulShutdown');

  const fallback = setTimeout(() => {
    console.error('[Electron] graceful shutdown deadline exceeded, forcing exit');
    try { app.exit(0); } catch (_err) { process.exit(0); }
  }, _gracefulQuitDeadlineMs);
  fallback.unref();

  try {
    Promise.resolve(dashboard.gracefulShutdown('app-before-quit', 0)).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[Electron] gracefulShutdown rejected:', msg);
      try { app.exit(0); } catch (_e) { process.exit(0); }
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[Electron] gracefulShutdown threw synchronously:', msg);
    clearTimeout(fallback);
    try { app.exit(0); } catch (_e) { process.exit(0); }
  }
});

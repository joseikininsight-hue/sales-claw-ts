// Sales Claw Dashboard Server
// fs.watch でファイル変更をイベント検知 → SSE → フロントで差分DOM更新

let _formSessionManager: any = null; // injected by electron-main via startDashboardServer({ formSessionManager })

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const XLSX = require('xlsx');
const { getAllLogs, logAction, removeCompanyLogs } = require('./action-logger');
const { getAllHistorySummary, getHistory, recordContact, removeHistory } = require('./contact-history');
const { readRuntime, toClientHost, writeRuntime, clearRuntime } = require('./dashboard-runtime');
const settings = require('./settings-manager');
const { getTranslations, t: i18nT } = require('./i18n');
const { ensureDataDir, resolveDataPath } = require('./data-paths');
const {
  getExpectedApprovalArtifacts,
  assertApprovalArtifacts,
  buildApprovalLogDetails,
  findScreenshotPath,
  getScreenshotSearchDirs,
} = require('./approval-artifacts');
const { findAvailablePort } = require('./port-utils');
const { appendCompany, deleteCompany, findCompaniesByNos, getTargetPreview, importTargetList, readTargetList, repairImportedTargetListIfNeeded, updateCompany } = require('./target-list');
const { getTargetMap, setTargets } = require('./outreach-targets');
const { finishLiveMonitor, getLiveMonitorFile, getLiveMonitorSummary, readMonitorState, removeCompanyMonitor, updateLiveMonitor } = require('./live-monitor');
const { buildWorkbookBuffer: buildSettingsWorkbookBuffer, parseWorkbookBuffer: parseSettingsWorkbookBuffer } = require('./settings-excel');
const {
  buildLaunchArgs,
  buildHeadlessArgs,
  buildManagedSpawnSpec,
  getAuthFiles,
  getExecutableFallbackCandidates,
  getInstallCommand,
  getInstallSpawnArgs,
  getProvider,
  hasAnyAuthFile,
  listProviders,
  normalizeProviderId,
} = require('./ai-providers');
const localToolchain = require('./local-toolchain');
const { shouldOverridePlaywrightMcpConfig } = require('./mcp-config-helpers');
const { classifyCliText } = require('./cli-issue-classifier');
const logWriter = require('./log-writer');
const { detectStalledCompanies, formatStallReason } = require('./batch-watchdog');
const { saveRecoverySnapshot, loadRecoverySnapshot, clearRecoverySnapshot } = require('./recovery-store');
const demoMode = require('./demo-mode');
// AI runtime 分離モジュール (Phase 3 の分割先)
const batchUtils = require('./ai-runtime/batch-utils');
const ptyLog = require('./ai-runtime/pty-log');
// UI テンプレート分離 (Phase 1)
//
// Hot reload:
//   SALES_CLAW_DEV_HOT_RELOAD=1 のときは buildPage() の冒頭で
//   ./ui/** の require cache を捨てる → 各 renderX(...) 呼び出しは
//   ディスクから最新の cjs を再読込。これによりブラウザ再読み込み
//   だけで UI 修正が反映され、再インストール不要になる。
const _HOT_RELOAD = process.env.SALES_CLAW_DEV_HOT_RELOAD === '1';
const _UI_DIR = path.resolve(__dirname, 'ui');
function hotInvalidateUi() {
  if (!_HOT_RELOAD) return;
  Object.keys(require.cache).forEach((k: any) => {
    try { if (k.startsWith(_UI_DIR)) delete require.cache[k]; } catch (_) {}
  });
}
// Each render is a thin wrapper so HOT mode picks up the latest module.
// In production (HOT off) this is just one cached require lookup per call.
const renderStyles = (...a) => require('./ui/styles')(...a);
// client-scripts は src/ui/client-scripts/*.ts (2.0.0 で .cjs から TS 化)。
// tsc が dist-ts/src/ui/client-scripts/*.js にコンパイルし、esbuild が同所を
// 整形する。require は拡張子なしで Node が .js を解決する。
const renderDashboardScript = (...a: any[]) => require('./ui/client-scripts/dashboard')(...a);
const renderAnalyticsScript = (...a: any[]) => require('./ui/client-scripts/dashboard-analytics')(...a);
const renderColumnResizerScript = (...a: any[]) => require('./ui/client-scripts/column-resizer')(...a);
const renderAwaitingCardRedesignScript = (...a: any[]) => require('./ui/client-scripts/awaiting-card-redesign')(...a);
const renderSentCardRedesignScript = (...a: any[]) => require('./ui/client-scripts/sent-card-redesign')(...a);
const renderCliTerminalScript = (...a: any[]) => require('./ui/client-scripts/cli-terminal')(...a);
const renderLaunchCrashGuardScript = (...a: any[]) => require('./ui/client-scripts/launch-crash-guard')(...a);
const renderUpdateCheckControlsScript = (...a: any[]) => require('./ui/client-scripts/update-check-controls')(...a);
const renderPaginationScript = (...a: any[]) => require('./ui/client-scripts/pagination')(...a);
const renderSettingsRedesignScript = (...a: any[]) => require('./ui/client-scripts/settings-redesign')(...a);
const renderProviderIconFixScript = (...a: any[]) => require('./ui/client-scripts/provider-icon-fix')(...a);

const PROJECT_ROOT = path.join(__dirname, '..', '..');

/**
 * CLI (Claude/Codex/Gemini) の managed PTY 用の作業ディレクトリ。
 *
 * 問題: PROJECT_ROOT は packaged Electron では `C:\Program Files\Sales Claw\
 * resources\app\` となり read-only。CLI が cwd 配下にスクラッチファイルを
 * 書こうとして EPERM になる (ユーザー観測 2026-05-08 16:34: Claude が
 * 「⏵⏵ bypass permissions on (shift+tab to cycle)」を ProgramFiles に
 * 書こうとして失敗)。
 *
 * 解決: %APPDATA%/sales-claw/runtime/.cli-workspace/ を CLI の cwd にする。
 * 開発時は PROJECT_ROOT が書き込み可能なのでそのまま使う (env で override 可)。
 */
function getCliWorkspaceDir() {
  // dev (npm run dashboard:preview) では PROJECT_ROOT 自体が書き込み可。
  // packaged Electron では PROJECT_ROOT が C:\Program Files\... → 別 dir 必須。
  const isPackaged = (() => {
    try {
      // resources/app パスにいる = packaged Electron
      return /[\\/]resources[\\/]app[\\/]?$/i.test(PROJECT_ROOT);
    } catch (_) { return false; }
  })();
  const envOverride = process.env.SALES_CLAW_CLI_WORKSPACE;
  let dir;
  if (envOverride && typeof envOverride === 'string') {
    dir = envOverride;
  } else if (isPackaged) {
    dir = resolveDataPath('.cli-workspace');
  } else {
    dir = PROJECT_ROOT;
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (_) { /* best-effort, 失敗しても spawn 側で表面化 */ }
  return dir;
}

const AI_STATUS_CACHE_TTL_MS = 15000;
const AI_DIAGNOSTICS_CACHE_TTL_MS = 30000;
// MCP playwright add は最大 30s + version probe 5s + その他で 50s 近く
// かかる場合がある (CLI 側の git fetch / npm 解決待ちで遅延)。
// さらに stale entry 検知時は remove(20s) + add(30s) + verify(20s) = 70s
// が ensureProviderPlaywrightMcp 内で連続する。
// v2.0.64: 自動 Chromium 準備 (+30s) を追加したため、LAUNCH_TIMEOUT_MS を
//   120s → 180s に拡張。それに合わせて stale lock も 130s → 200s。
// stale lock 判定 (200s) > server LAUNCH_TIMEOUT_MS (180s) > mcp setup + chromium prep 最大 120s
// の順で大小を維持し、「client がタイムアウトする前に stale 判定が走る」
// 状態を避ける。
const MANAGED_AI_LAUNCH_LOCK_STALE_MS = 200000;
const PTY_MAX_COLS = 300;
const PTY_MAX_ROWS = 120;

// SSE クライアント管理
const sseClients = new Set<any>();
const activeWatchers = new Map<any, any>();
let heartbeatTimer: any = null;
let dashboardRuntime: any = null;
let serverStartPromise: any = null;
let _aiStatusCache: any = null;
let _aiStatusCacheTime = 0;
let _aiStatusCacheProvider: any = null;
const _aiStatusInFlight = new Map<any, any>();
const _aiDiagnosticsCache = new Map<any, any>();
const _aiDiagnosticsInFlight = new Map<any, any>();
let _aiCacheGeneration = 0;
let _launchInFlight: any = null;
let _launchInFlightStartedAt = 0;
let _launchGeneration = 0;
// cancelManagedAiLaunch から kill するための、launch の途中で起動した
// 子プロセス (mcp list / mcp add / version probe など) の register。
// stop-ai が叩かれた瞬間に走っている CLI を kill しないと、orphan として
// 30s 超かかる mcp add などが完走してしまう。
const _launchSpawnedChildren = new Set<any>();
let _aiExecutablePath: Record<string, any> = {};
let dashboardSessionToken: any = null;
const CLI_LOG_SECRET = require('crypto').randomBytes(24).toString('hex');
let dashboardDataCacheKey: any = null;
let dashboardDataCacheValue: any = null;
let dashboardDataCacheBuiltAt = 0;
let standaloneDashboardLockHeld = false;
let standaloneDashboardLockHooksInstalled = false;

// Managed AI PTY process
let claudePty: any = null;
let claudeProcessMode = 'default';
let claudeProcess: any = null;
let headlessAiRun: any = null;
let activeAiProvider = normalizeProviderId(typeof settings.getAiProvider === 'function' ? settings.getAiProvider() : 'claude');
let managedAiAutoSendSafe = !!(typeof settings.getAutoSendEligibleForms === 'function' ? settings.getAutoSendEligibleForms() : false);
const aiInstallState = Object.fromEntries(listProviders().map((provider: any) => [provider.id, 'idle']));
const aiInstallError = Object.fromEntries(listProviders().map((provider: any) => [provider.id, null]));
let managedAiSessionState: any = null;
let managedAiBatchController: any = null;
let managedAiRecoveryState: any = null;
let managedAiRecoveryTimer: any = null;
let managedAiSuppressAutoRecovery = false;

// v2.0.49: Phase A subprocess (parallel-analysis.js) は managed PTY とは別経路で
//   Claude を spawn するため、PTY 側で auth 失効 (401) を検知して auto-recovery を
//   止めても Phase A workers は走り続けて社ごとに同じ 401 を踏み続けるバグがあった
//   (実機ログで複数社の site_analysis / site_discovery が「自動再起動を停止」後も
//   続行することを観測)。グローバル flag で「Claude が現在 auth 失敗状態」を共有し:
//     - 走行中の Phase A workers は次の社に進む前にこの flag を確認して early exit
//     - 進行中の subprocess は SIGTERM で即時 kill (401 は時間で回復しないので待っても無駄)
//     - 失効解除 (ユーザーが /login → 「AI を起動」) は startManagedAiSession の
//       allowReuse=false 経路で flag をクリアする
let globalClaudeAuthFailureAt = 0;
const activePhaseAChildProcesses = new Set<any>();
function isClaudeAuthCurrentlyFailed(): boolean {
  return globalClaudeAuthFailureAt > 0;
}
function markClaudeAuthFailed(reason: string): void {
  if (globalClaudeAuthFailureAt > 0) return; // 既に立っていれば二重発火を防ぐ
  globalClaudeAuthFailureAt = Date.now();
  try { appendDiagnosticEvent('claude_auth_failed_global', { reason, at: globalClaudeAuthFailureAt }); } catch (_) { /* swallow */ }
  let killed = 0;
  for (const child of Array.from(activePhaseAChildProcesses)) {
    try {
      if (child && !child.killed && typeof child.kill === 'function') {
        child.kill('SIGTERM');
        killed++;
      }
    } catch (_) { /* swallow */ }
  }
  if (killed > 0) {
    try { appendDiagnosticEvent('phase_a_workers_killed_on_auth_fail', { killed }); } catch (_) { /* swallow */ }
  }
}
function clearClaudeAuthFailedFlag(): void {
  if (globalClaudeAuthFailureAt === 0) return;
  const wasAt = globalClaudeAuthFailureAt;
  globalClaudeAuthFailureAt = 0;
  try { appendDiagnosticEvent('claude_auth_failed_cleared', { wasAt, at: Date.now() }); } catch (_) { /* swallow */ }
}
// auth-failure を示す文字列か判定する。Phase A subprocess の stdout/stderr/error
// テキストから検出する用。cli-issue-classifier.ts の 'Claude認証失効/レート上限'
// パターンと同等。
function isClaudeAuthFailureText(text: string): boolean {
  if (typeof text !== 'string' || text.length < 5) return false;
  return /(?:Please\s+run\s+\/login|API\s+Error:\s*401|Invalid\s+authentication\s+credentials)/i.test(text);
}

// v2.0.14: Phase B が走っている間 Windows を sleep させない。
// 100 社規模で 3-6 時間連続実行が必要なので、ノート PC が省電力で
// sleep に入ると Claude PTY も MCP Playwright も停止し、queue が
// 永久滞留する。
//   - Electron の powerSaveBlocker('prevent-app-suspension') で抑止
//   - dashboard-server プロセスが Electron なしで動く場合 (preview-dashboard
//     等) は no-op
//   - controller.pending + activeBatch が空になったら stop
let _powerSaveBlockerId: number | null = null;
function startPowerSaveBlockerIfPossible(): void {
  if (_powerSaveBlockerId !== null) return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron');
    if (!electron || !electron.powerSaveBlocker) return;
    _powerSaveBlockerId = electron.powerSaveBlocker.start('prevent-app-suspension');
    appendDiagnosticEvent('power_save_blocker_started', { id: _powerSaveBlockerId });
  } catch (_) { /* not running under Electron, no-op */ }
}
function stopPowerSaveBlockerIfActive(): void {
  if (_powerSaveBlockerId === null) return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron');
    if (electron && electron.powerSaveBlocker && electron.powerSaveBlocker.isStarted(_powerSaveBlockerId)) {
      electron.powerSaveBlocker.stop(_powerSaveBlockerId);
      appendDiagnosticEvent('power_save_blocker_stopped', { id: _powerSaveBlockerId });
    }
  } catch (_) { /* swallow */ }
  _powerSaveBlockerId = null;
}

// v2.0.14: バッチサイズを可変化。100 社規模を投入する時に 3 のままだと
// 34 バッチに分割されてオーバーヘッドが大きい。10 まで拡張可能。
//   優先順位: settings.preferences.managedAiFormBatchSize
//             > env SALES_CLAW_MANAGED_AI_FORM_BATCH_SIZE
//             > デフォルト 3
const DEFAULT_MANAGED_AI_FORM_BATCH_SIZE = 3;
const MIN_MANAGED_AI_FORM_BATCH_SIZE = 1;
const MAX_MANAGED_AI_FORM_BATCH_SIZE = 10;
function getManagedAiFormBatchSize(): number {
  let raw: any = null;
  try {
    const prefs = settings.getSection('preferences') || {};
    if (prefs.managedAiFormBatchSize !== undefined && prefs.managedAiFormBatchSize !== null) {
      raw = prefs.managedAiFormBatchSize;
    }
  } catch (_) { /* settings 未初期化 */ }
  if (raw === null && process.env.SALES_CLAW_MANAGED_AI_FORM_BATCH_SIZE) {
    raw = process.env.SALES_CLAW_MANAGED_AI_FORM_BATCH_SIZE;
  }
  // raw が null のまま (env も settings も未設定) ならデフォルトに直行。
  // Number(null) === 0 → min clamp で 1 になる事故を回避。
  if (raw === null || raw === undefined || raw === '') return DEFAULT_MANAGED_AI_FORM_BATCH_SIZE;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_MANAGED_AI_FORM_BATCH_SIZE;
  return Math.max(MIN_MANAGED_AI_FORM_BATCH_SIZE, Math.min(MAX_MANAGED_AI_FORM_BATCH_SIZE, Math.floor(n)));
}

// v2.0.26: Phase B 内のタブ並列度 (1 Playwright + 1 Claude PTY が pipeline で
// 進めるタブ数)。1 = 直列、2-3 でナビゲーション待ちオーバーラップ。
//
// v2.0.51: デフォルトを「auto」に変更。
//   旧仕様 (=1): 3 社バッチでも逐次処理 → 1社 2-3 分 × 3 = 6-9 分。
//     実測 (ai-run-metrics.jsonl) で中央値 160 秒/社 × 3 = 480 秒 (8 分)。
//   新仕様 (=auto): ユーザー明示設定なしなら batchSize に応じて
//     Math.min(batchSize, MAX_PHASE_B_PARALLEL_TABS) に自動拡張。
//     3 社バッチなら 3 並列 → 理論上 1/3 の時間 (≈ 2-3 分) で完走。
//   3 並列のリソース競合リスクはあるが、batch_rules で
//     「同時に 4 社以上のタブを開いてはいけない」と CLI 側に明示しており、
//     実機運用 (parallelTabs=3 を手動設定したユーザー) でも安定動作している。
const DEFAULT_PHASE_B_PARALLEL_TABS = 1;
const MIN_PHASE_B_PARALLEL_TABS = 1;
const MAX_PHASE_B_PARALLEL_TABS = 3;

/**
 * ユーザー明示設定がある場合は数値で、未設定なら 'auto' を返す。
 * 後段で batchSize を加味して resolve する。
 */
function readPhaseBParallelTabsRaw(): number | 'auto' {
  let raw: any = null;
  try {
    const prefs = settings.getSection('preferences') || {};
    if (prefs.parallelTabs !== undefined && prefs.parallelTabs !== null && prefs.parallelTabs !== '') {
      raw = prefs.parallelTabs;
    }
  } catch (_) { /* swallow */ }
  if (raw === null && process.env.SALES_CLAW_PHASE_B_PARALLEL_TABS) {
    raw = process.env.SALES_CLAW_PHASE_B_PARALLEL_TABS;
  }
  if (raw === null || raw === undefined || raw === '') return 'auto';
  if (typeof raw === 'string' && /^auto$/i.test(raw.trim())) return 'auto';
  const n = Number(raw);
  if (!Number.isFinite(n)) return 'auto';
  return Math.max(MIN_PHASE_B_PARALLEL_TABS, Math.min(MAX_PHASE_B_PARALLEL_TABS, Math.floor(n)));
}

/**
 * バッチサイズに応じて最終的な parallel tab 数を決定する。
 * - 'auto' (default): min(batchSize, MAX) — 3 社バッチなら 3 並列
 * - 明示数値: そのまま (1〜3 にクランプ済み)
 * - batchSize を渡せない呼び出し (UI 表示用など) は legacy 動作で 1 を返す
 */
function resolvePhaseBParallelTabs(batchSize?: number): number {
  const raw = readPhaseBParallelTabsRaw();
  if (raw === 'auto') {
    if (!Number.isFinite(batchSize) || (batchSize as number) <= 0) {
      return DEFAULT_PHASE_B_PARALLEL_TABS;
    }
    return Math.max(MIN_PHASE_B_PARALLEL_TABS, Math.min(MAX_PHASE_B_PARALLEL_TABS, Math.floor(batchSize as number)));
  }
  return raw;
}

// 旧 API: batchSize 不明な呼び出し向け (UI 表示・診断ログ用)。
function getPhaseBParallelTabs(): number {
  return resolvePhaseBParallelTabs(undefined);
}

const MANAGED_AI_BATCH_POLL_MS = 5000;
// Claude が大きなペースト (5000+ chars / 49+ lines) を受け取ると、UI 側で
// "[Pasted text] paste again to expand" バナーを出して 2nd Enter 待ちになる。
// 1st Enter から 2nd Enter までの dispatcher 待機 (30 秒) + Claude が処理を
// 開始してから MCP Playwright 経由でフォーム探索→入力→確認画面到達までで
// 短くて 60 秒、長いサイトだと 3〜5 分かかる。5 分の watchdog は短すぎたので
// 10 分に伸ばす。
// 1.2.90: 10分 → 20分。URL 不在企業は CLI が WebSearch で公式サイトを探索し、
// その後フォーム入力するため処理時間が長い。stale watchdog で auto-fail されないよう
// 余裕を持たせる。CLI には 2 分以内に進捗 logAction を残すよう prompt で指示。
const MANAGED_AI_BATCH_STALL_MS = 20 * 60 * 1000;
// A4: pending キューが activeBatch なしで放置されている時間の閾値。
// 過去バグ (47 バッチ滞留) の検知用。
// v2.0.38: 5 分 → 90 秒。200 社一括 (67+ バッチ) を投入した際に 5 分待ちは長すぎ、
//   ユーザーが「止まった」と判断するまでに 5 分待たされる事故が起きていた。
//   90 秒で stuck 判定 → 自動 dispatch 再試行 + ユーザー通知 を発火させる。
const MANAGED_AI_QUEUE_STUCK_MS = 90 * 1000;
// v2.0.41: per-company stall 監視。
//   - PER_COMPANY_EMPTY_LOG_MS: dispatch 後この時間 1 件もログがない社 → auto-fail
//   - PER_COMPANY_PARTIAL_STALL_MS: site_analysis / message_draft / form_fill で
//     この時間更新がない社 → auto-fail
// 旧仕様 (v2.0.23): batch.lastProgressAt が 20 分 (もしくは空 action なら 6.7 分)
//   経過してから「初めて」 stallNotified を立てて detectStalledCompanies を回す。
//   バッチ内 1 社でも進捗があると lastProgressAt が更新され続けるため、
//   進捗あり社 + stall 社 が混在するバッチでは stall 社が永遠に error 化されず、
//   batch_completed イベントも発火せず、後続バッチが dispatch されない事故 (No.152
//   アビーム のケース)。
//   新仕様: per-company の latestTimestamp ベースで毎 poll 判定する。
// v2.0.43: PER_COMPANY_EMPTY_LOG_MS を 3分 → 6分に緩和。
//   実機で確認した誤発火 (2026-05-18 23:58 [59,61,62] バッチ):
//   - knownFormUrlCount=0 / missingFormUrlCount=3 → 全社 WebSearch 必要
//   - sessionContractInjected=true → 新規セッション首回り
//   - parallelTabs=3 → リソース競合
//   この組み合わせで首回り含めて初回 logAction まで 3-5 分かかるのは正常。
//   3 分で打ち切ると正常処理中の社まで error 化していた。6 分に伸ばしても No.152
//   case (20+ 分 stall) は十分早く検知できる。
const MANAGED_AI_PER_COMPANY_EMPTY_LOG_MS = 6 * 60 * 1000;
const MANAGED_AI_PER_COMPANY_PARTIAL_STALL_MS = 10 * 60 * 1000;
// v2.0.43: 新規 session の最初のバッチでは contract injection + WebSearch 首回り
//   コストで +90 秒の猶予を持たせる。dispatchNextManagedAiFormFillBatch で
//   activeBatch.sessionContractInjected を見て threshold を加算する。
const MANAGED_AI_FRESH_SESSION_GRACE_MS = 90 * 1000;
const MANAGED_AI_PTY_LOG_MAX_BYTES = 1024 * 1024;
const MANAGED_AI_RECOVERY_RETRY_MS = 15000;
const MANAGED_AI_RECOVERY_MAX_RETRIES = 20;
// v2.0.48 F2: recovery retry を exponential backoff にする。固定 15s × 20 回
//   (5 分 hammering) は auth サーバ / Anthropic ログインプロセスへの負荷が高く、
//   一時的なネットワーク揺らぎでも 5 分間の連続失敗で停止になる。15→30→60→120→180s
//   cap でジワっと増やし、合計時間も短縮する (15s*20=5分 → backoff 20回 ≒ 1 時間
//   弱だが実質 5 回程度で復旧する想定なので体感は早くなる)。
const MANAGED_AI_RECOVERY_BACKOFF_CAP_MS = 180 * 1000;
// v2.1.0: pty-exit recovery のサーキットブレーカ。CLI が短時間に繰り返しクラッシュ
//   (auth fingerprint stale / 設定不備 等) する状況では「落ちる→2.5s後復旧→また落ちる」
//   のループでコスト/待ちが嵩む。直近 RECOVERY_BREAKER_WINDOW_MS 内の pty-exit recovery が
//   RECOVERY_BREAKER_MAX 回を超えたら自動復旧を止め、ユーザーに原因確認を促す。
const RECOVERY_BREAKER_WINDOW_MS = 5 * 60 * 1000;
const RECOVERY_BREAKER_MAX = 3;
let managedAiRecentPtyExits: number[] = [];
function recordPtyExitAndCheckBreaker(): boolean {
  const now = Date.now();
  managedAiRecentPtyExits = managedAiRecentPtyExits.filter((t) => now - t < RECOVERY_BREAKER_WINDOW_MS);
  managedAiRecentPtyExits.push(now);
  return managedAiRecentPtyExits.length > RECOVERY_BREAKER_MAX;
}
function getManagedAiRecoveryDelayMs(retryCount: number): number {
  const r = Math.max(0, Number(retryCount) || 0);
  // 0→15s, 1→30s, 2→60s, 3→120s, 4+→180s
  const ramp = [15000, 30000, 60000, 120000, MANAGED_AI_RECOVERY_BACKOFF_CAP_MS];
  return ramp[Math.min(r, ramp.length - 1)];
}
// v2.0.48 F1: error-rate-restart の Promise chain が hang した場合に
//   restartingForErrors フラグが永久 true で固まり、poller が永遠に dispatch を
//   抑止し続ける事故を防ぐ。chain 全体に Promise.race で hard timeout を被せ、
//   時間内に完了しなくてもフラグを必ずクリアする。
const MANAGED_AI_RESTART_FOR_ERRORS_TIMEOUT_MS = 90 * 1000;
// v2.0.48 F3: poll 間隔を adaptive にする。
//   - activeBatch あり = ACTIVE (進捗監視中) → 短くして batch 切替の遅延を縮める
//   - activeBatch なし = IDLE (キュー待ち or 完走) → 5s のまま CPU を浪費しない
const MANAGED_AI_BATCH_POLL_ACTIVE_MS = 2000;
// v2.0.48 F4: バッチ完了→次 dispatch の遅延を 350ms から 100ms に短縮。
//   PTY の write 競合は 50ms 程度で十分安全、過剰な保守的 wait を削る。
const MANAGED_AI_BATCH_DISPATCH_GAP_MS = 100;
// v2.0.48 F5: Claude paste banner 検出失敗時のフォールバック wait を短縮。
//   detectPasteBannerAndAdvance が PTY 出力から banner を検出した瞬間に即発火
//   する仕組み (state.pasteBannerWatcher) があるため、30s はあくまで「検出を
//   完全に取りこぼした場合の safety net」。banner 検出は実機で 99% 動作するため
//   8s に短縮しても誤発火リスクは小さい。最悪 8s で 2nd Enter を送って次バッチ
//   が進む方が、30s 待ってから進むより全体時間が短い。
const MANAGED_AI_CLAUDE_PASTE_FALLBACK_MS = 8000;

const MANAGED_AI_READY_DELAY_MS = {
  claude: 1500,
  codex: 12000,
  gemini: 25000,
};

const MANAGED_AI_MIN_READY_AGE_MS = {
  claude: 0,
  codex: 24000,
  gemini: 25000,
};

const MANAGED_AI_ENTER_DELAY_MS = {
  claude: 250,
  codex: 900,
  gemini: 1000,
};

// WebSocket server for PTY I/O
const wss = new WebSocket.Server({ noServer: true });
const ptyWsClients = new Set<any>();

wss.on('connection', (ws) => {
  ptyWsClients.add(ws);
  ws.send(JSON.stringify({
    type: 'connected',
    running: !!claudePty,
    mode: claudeProcessMode,
    provider: activeAiProvider,
    autoSendSafe: getManagedAiAutoSendSafe(),
  }));
  ws.on('message', (msg) => {
    // ★ JSON 以外の生バイト列は受け付けない。
    //   旧版は parse 失敗時に msg.toString() を claudePty.write していたが、
    //   不正クライアント (origin チェックを通過した攻撃者・compromised 子プロ
    //   セスなど) が AI セッションに任意入力できてしまうため削除。
    //   厳密に { type: 'input' | 'resize', ... } の形式のみ許容。
    let data;
    try {
      data = JSON.parse(msg.toString());
    } catch (_) {
      return; // 不正フォーマットは黙って捨てる
    }
    if (!data || typeof data !== 'object') return;
    // node-pty は対象 PTY が exit 済みだと write/resize を同期 throw する
    // (例: "Cannot resize a pty that has already exited")。
    // ここで catch しないと process.on('uncaughtException') が発火し
    // gracefulShutdown(1) でダッシュボードサーバ = Electron main プロセス
    // が即死する。AI 起動直後に CLI が落ちた瞬間、クライアント側がまだ
    // resize メッセージを送っているケースで頻発するので必ず握り潰す。
    if (data.type === 'input' && claudePty && typeof data.data === 'string') {
      if (!isPtyAlive(claudePty)) return;
      try { claudePty.write(data.data); }
      catch (e) { console.warn('[pty-ws] write on exited pty:', e && e.message || e); }
    } else if (data.type === 'resize' && claudePty
        && Number.isFinite(data.cols) && Number.isFinite(data.rows)) {
      if (!isPtyAlive(claudePty)) return;
      const cols = Math.max(2, Math.min(PTY_MAX_COLS, Math.floor(data.cols)));
      const rows = Math.max(1, Math.min(PTY_MAX_ROWS, Math.floor(data.rows)));
      // node-pty (Windows) は resize() を _deferNoArgs 経由で呼ぶため、
      // PTY exit 直後にキューが drain される瞬間に async throw が起こりうる。
      // ここの try/catch では捕捉できないので、事前に isPtyAlive() で同期
      // チェックし、生きていなければ何もしない。万一 throw した場合も
      // process.on('uncaughtException') 側で claude-resize-async 経路として
      // 握り潰す。
      try { claudePty.resize(cols, rows); }
      catch (e) { console.warn('[pty-ws] resize on exited pty:', e && e.message || e); }
    }
  });
  ws.on('close', () => ptyWsClients.delete(ws));
  ws.on('error', () => ptyWsClients.delete(ws));
});

/**
 * node-pty (特に Windows) はバックグラウンドの I/O socket / agent が
 * 既に exit していると write/resize/kill が throw する。さらに
 * `_deferNoArgs` を経由する resize/clear/kill では throw が
 * uncaughtException として観測されることがある。
 *
 * 安全側で「明らかに死んでいる」と分かる場合は呼ばないように、
 * pty オブジェクトの内部フラグを覗いて存命チェックを行う。
 * node-pty の internal API なので存在しないバージョンに備えて
 * 全て optional chain で読む。判定不能なら true を返し、
 * 呼び出し側の try/catch に任せる。
 */
function isPtyAlive(pty) {
  if (!pty) return false;
  try {
    // unix側: pty._writable === false なら exit 済み
    if (typeof pty._writable === 'boolean' && pty._writable === false) return false;
    // windows側: _agent.exitCode が undefined ならまだ動作中、数値 = 終了済
    const agent = pty._agent;
    if (agent && typeof agent.exitCode === 'number') return false;
    // socket が destroyed なら ready/write 不可
    if (pty._socket && pty._socket.destroyed) return false;
    if (agent && agent.outSocket && agent.outSocket.destroyed) return false;
  } catch (_) { /* internal フィールドが無いバージョン → 判定不能 */ }
  return true;
}

function broadcastPty(payload) {
  // ws.send は readyState === OPEN でも race で throw しうる
  // (peer が直前で close した直後など)。1 client の例外で全体を巻き込まないよう
  // 個別 try/catch で隔離する。さらに stale な client は集合から除去する。
  let msg;
  try { msg = JSON.stringify(payload); } catch (_) { return; }
  for (const ws of ptyWsClients) {
    try {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
      else if (ws.readyState === WebSocket.CLOSED) ptyWsClients.delete(ws);
    } catch (e) {
      try { ptyWsClients.delete(ws); } catch (_) {}
    }
  }
}

const APP_VERSION = process.env.SALES_CLAW_APP_VERSION || (() => {
  try { return JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8')).version; }
  catch (e) { return '?'; }
})();
const APP_BUILD_SOURCE = process.env.SALES_CLAW_BUILD_SOURCE
  || (process.versions.electron ? 'installed' : 'dashboard-only');
const AUTO_UPDATE_ENABLED = process.env.SALES_CLAW_AUTO_UPDATE_ENABLED === '1';

function getSettingsFiles() {
  const bootstrap = settings.SETTINGS_FILE;
  const active = typeof settings.getActiveSettingsFile === 'function'
    ? settings.getActiveSettingsFile()
    : bootstrap;
  return Array.from(new Set([bootstrap, active].filter(Boolean).map((entry: any) => path.resolve(entry))));
}

// Lock I/O は Stage 4 分割で src/dashboard-lock.ts に切り出した。
// 排他制御の状態管理 (standaloneDashboardLockHeld / hooks) は依然ここに残置する。
// eslint-disable-next-line @typescript-eslint/no-require-imports
const dashboardLock = require('./dashboard-lock');
const getDashboardLockFile = dashboardLock.getDashboardLockFile;
const readDashboardLock = dashboardLock.readDashboardLock;
const writeDashboardLock = dashboardLock.writeDashboardLock;
const isProcessAlive = dashboardLock.isProcessAlive;

function readJsonFileSafe(filePath: string, fallback: any = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function releaseStandaloneDashboardLock() {
  if (!standaloneDashboardLockHeld) return;
  try {
    const current = readDashboardLock();
    if (current && Number(current.pid) !== process.pid) {
      standaloneDashboardLockHeld = false;
      return;
    }
    const lockFile = getDashboardLockFile();
    if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);
  } catch (_) {
    // noop
  }
  standaloneDashboardLockHeld = false;
}

function ensureStandaloneDashboardLockHooks() {
  if (standaloneDashboardLockHooksInstalled) return;
  standaloneDashboardLockHooksInstalled = true;
  // exit hook は最後の保険として残す: gracefulShutdown が走らずに死んだ場合
  // でも lock ファイルを掃除する。
  process.on('exit', releaseStandaloneDashboardLock);
  // SIGINT / SIGTERM / 例外系は graceful shutdown 経由で全 resource を畳む。
  // 二重シグナル対策は gracefulShutdown 側の guard で行う。
  process.on('SIGINT', () => { gracefulShutdown('SIGINT', 0); });
  process.on('SIGTERM', () => { gracefulShutdown('SIGTERM', 0); });
  process.on('uncaughtException', (err) => {
    console.error('[dashboard-server] uncaughtException:', err && err.stack || err);
    try {
      appendDiagnosticEvent('uncaught_exception', {
        message: err && err.message,
        stack: err && err.stack ? String(err.stack).slice(0, 4000) : null,
      });
    } catch (_) {}
    // PTY 由来の既知の race (resize/write on exited pty, ConPTY console list 失敗)
    // は致命傷ではない。Electron main = ダッシュボードサーバを巻き込んで落ちると
    // 「AI 起動するとアプリごとクラッシュ」というユーザー体験になるため、
    // これらはログのみで継続する。
    const message = String(err && err.message || err || '');
    const stack = String(err && err.stack || '');
    const isRecoverablePtyError =
      /Cannot (resize|write to|kill) a pty that has already exited/i.test(message) ||
      /AttachConsole failed/i.test(message) ||
      /getConsoleProcessList/i.test(message) ||
      // PTY exit 直後に _agent.outSocket.write が EBADF/EIO で投げる
      /node-pty[\\\/].*windowsTerminal\.js/i.test(stack) ||
      /windowsPtyAgent\.js/i.test(stack);
    if (isRecoverablePtyError) {
      console.warn('[dashboard-server] uncaughtException recovered (pty race):', message);
      return;
    }
    gracefulShutdown('uncaughtException', 1);
  });
  process.on('unhandledRejection', (reason: any) => {
    console.error('[dashboard-server] unhandledRejection:', reason);
    try {
      appendDiagnosticEvent('unhandled_rejection', {
        reason: reason && reason.stack ? String(reason.stack).slice(0, 4000)
              : reason && reason.message ? String(reason.message)
              : String(reason),
      });
    } catch (_) {}
    // unhandled rejection は今すぐ落とすほどではないが、ログには残す。
    // Node 15+ のデフォルト挙動 (process exit) を尊重したいので
    // ここでは終了せず、後段のシステム動作に任せる。
  });
}

// ─── Graceful Shutdown ─────────────────────────────────────────────────
// SIGINT / SIGTERM / uncaughtException を受けたら、孤児 PTY / open WebSocket /
// 未保存の recovery snapshot / fs.watch / form-session WebContentsView を
// 順序立てて畳んでから process.exit する。
//
// 順序:
//   1. shutdown フラグで新しい仕事の受付停止
//   2. recovery snapshot を保存 (PTY を殺す前)
//   3. 全 timer (heartbeat, batch poll, recovery, session ready) を停止
//   4. SSE クライアントに shutdown を通知し close
//   5. WebSocket クライアントに close フレーム + wss.close
//   6. PTY child を SIGTERM → 1 秒後に SIGKILL
//   7. form-session manager を dispose (Electron のみ)
//   8. HTTP server.close (in-flight 完了待ち、最大 5s)
//   9. process.exit(code)
//
// 二重呼び出しガード: 同じ shutdown 中に 2 度目のシグナルが来たら強制 exit。
let _shutdownInProgress = false;
let _shutdownDeadlineMs = 8000;

async function gracefulShutdown(signal, exitCode = 0) {
  if (_shutdownInProgress) {
    // 二度目のシグナルは強制 exit
    console.error(`[dashboard-server] forced exit on second ${signal}`);
    try { releaseStandaloneDashboardLock(); } catch (_) {}
    process.exit(exitCode || 130);
    return;
  }
  _shutdownInProgress = true;
  console.log(`[dashboard-server] graceful shutdown initiated by ${signal}`);

  // 全プロセスが上限内に終わるよう、deadline を設定。
  // この時間を超えたら強制 exit。
  const forceExitTimer = setTimeout(() => {
    console.error(`[dashboard-server] shutdown deadline ${_shutdownDeadlineMs}ms exceeded, forcing exit`);
    try { releaseStandaloneDashboardLock(); } catch (_) {}
    process.exit(exitCode || 1);
  }, _shutdownDeadlineMs);
  forceExitTimer.unref();

  try {
    // (1) 新規受付停止: server.close は in-flight 完了まで待つ。新接続は拒否。
    if (server && typeof server.close === 'function' && server.listening) {
      server.close(); // 非 await: in-flight 完了を後段で待つ
    }

    // (2) recovery snapshot を保存 (PTY を殺す前にやる)
    try {
      snapshotManagedAiBatchesForRecovery();
    } catch (e) {
      console.error('[dashboard-server] snapshot save failed:', e && e.message || e);
    }

    // (3) 全 timer を停止
    try { clearManagedAiBatchControllerTimer(); } catch (_) {}
    try { clearManagedAiRecoveryTimer(); } catch (_) {}
    try { clearManagedAiSessionStateTimers(); } catch (_) {}
    if (heartbeatTimer) {
      try { clearInterval(heartbeatTimer); } catch (_) {}
      heartbeatTimer = null;
    }

    // (4) SSE クライアントに shutdown 通知 → close
    try {
      const shutdownMsg = 'data: ' + JSON.stringify({
        type: 'server-shutdown',
        signal,
        time: new Date().toISOString(),
      }) + '\n\n';
      for (const r of sseClients) {
        try { r.write(shutdownMsg); } catch (_) {}
        try { r.end(); } catch (_) {}
      }
      sseClients.clear();
    } catch (_) {}

    // (5) WebSocket クライアントを close
    try {
      for (const ws of ptyWsClients) {
        try { ws.close(1001, 'server shutting down'); } catch (_) {}
      }
      ptyWsClients.clear();
      if (wss && typeof wss.close === 'function') {
        await new Promise<void>((resolve) => {
          try { wss.close(() => resolve()); } catch (_) { resolve(); }
          setTimeout(resolve, 1000); // タイムアウト保険
        });
      }
    } catch (_) {}

    // (6) PTY child を kill (SIGTERM → 1s 待ってから SIGKILL)
    try {
      if (claudePty) {
        const pty = claudePty;
        claudePty = null;
        try { pty.kill(); } catch (_) {}
        // node-pty の kill() は SIGHUP 相当。確実に落とすため pid に直接 SIGKILL も送る。
        setTimeout(() => {
          try {
            if (pty && pty.pid) process.kill(pty.pid, 'SIGKILL');
          } catch (_) {}
        }, 1000);
      }
      if (claudeProcess && typeof claudeProcess.kill === 'function' && !claudeProcess.killed) {
        try { claudeProcess.kill('SIGTERM'); } catch (_) {}
        setTimeout(() => {
          try { if (!claudeProcess.killed) claudeProcess.kill('SIGKILL'); } catch (_) {}
        }, 1000);
      }
    } catch (_) {}

    // (7) form-session manager (Electron WebContentsView) を畳む
    try {
      if (_formSessionManager && typeof _formSessionManager.disposeAll === 'function') {
        await Promise.race([
          Promise.resolve(_formSessionManager.disposeAll()),
          new Promise<any>((resolve) => setTimeout(resolve, 1500)),
        ]);
      }
    } catch (e) {
      console.error('[dashboard-server] form-session dispose failed:', e && e.message || e);
    }

    // (8) HTTP in-flight が捌けるのを待つ (最大 3 秒)
    if (server && server.listening) {
      await new Promise<void>((resolve) => {
        let resolved = false;
        const done = () => { if (!resolved) { resolved = true; resolve(); } };
        try { server.once('close', done); } catch (_) { done(); }
        setTimeout(done, 3000);
      });
    }

    // (8.5) ログライター queued buffer を最大 1.5s 待ってから sync flush
    // (H2: PTY ログが async キューに残っていると shutdown で失われる可能性)
    try {
      await Promise.race([
        logWriter.flushAll(1500),
        new Promise<any>((resolve) => setTimeout(resolve, 1800)),
      ]);
    } catch (_) {}
    try { logWriter.flushAllSync(); } catch (_) {}

    // (9) lock 解放 + exit
    try { releaseStandaloneDashboardLock(); } catch (_) {}
    clearTimeout(forceExitTimer);
    console.log('[dashboard-server] graceful shutdown complete');
    process.exit(exitCode);
  } catch (e) {
    console.error('[dashboard-server] error during graceful shutdown:', e && e.stack || e);
    try { logWriter.flushAllSync(); } catch (_) {}
    try { releaseStandaloneDashboardLock(); } catch (_) {}
    clearTimeout(forceExitTimer);
    process.exit(exitCode || 1);
  }
}

function canReachRuntimeUrl(runtimeUrl, timeoutMs = 1200) {
  return new Promise<any>((resolve) => {
    if (!runtimeUrl) {
      resolve(false);
      return;
    }
    const req = http.get(runtimeUrl, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 500);
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
    req.end();
  });
}

async function claimStandaloneDashboardLock() {
  const existing = readDashboardLock();
  if (existing && Number(existing.pid) !== process.pid) {
    if (isProcessAlive(existing.pid)) {
      // 生きてるプロセスが lock を握っている → URL も生きてれば「他インスタンス
      // 起動中」として現プロセスは起動を諦める (= ok:false)。
      const runtime = readRuntime();
      if (runtime && await canReachRuntimeUrl(runtime.url)) {
        return { ok: false, runtime, pid: existing.pid };
      }
      // 生きてるが URL に届かない (= 起動中 / クラッシュ寸前) は奪取する
    } else {
      // 死亡 PID の lock ファイルが残っている → 古いものとして実体削除する。
      // 上書き writeDashboardLock でも動くが、削除しておくと「現在 lock 中なのか
      // stale なのか」が外から見て判別しやすい (失敗時のフォレンジック用)。
      try {
        const lockFile = getDashboardLockFile();
        if (fs.existsSync(lockFile)) {
          fs.unlinkSync(lockFile);
          console.log(`[startup] removed stale dashboard-server.lock (dead pid=${existing.pid}, startedAt=${existing.startedAt || 'unknown'})`);
          try {
            appendDiagnosticEvent('stale_dashboard_lock_cleaned', {
              deadPid: Number(existing.pid),
              startedAt: existing.startedAt || null,
            });
          } catch (_) { /* best-effort */ }
        }
      } catch (_) {
        // best-effort: writeDashboardLock が上書きするので致命ではない
      }
    }
  }
  writeDashboardLock({
    pid: process.pid,
    startedAt: new Date().toISOString(),
    cwd: PROJECT_ROOT,
  });
  standaloneDashboardLockHeld = true;
  return { ok: true };
}

function getPathFingerprint(targetPath) {
  try {
    if (!targetPath || !fs.existsSync(targetPath)) return `${targetPath || ''}:missing`;
    const stat = fs.statSync(targetPath);
    return `${path.resolve(targetPath)}:${stat.size}:${Math.floor(stat.mtimeMs)}`;
  } catch (_) {
    return `${targetPath || ''}:error`;
  }
}

function getDashboardDataCacheKey() {
  const targetPath = settings.getTargetListPath();
  const settingsFingerprints = getSettingsFiles().map(getPathFingerprint).join('|');
  const sourceFingerprints = [
    getPathFingerprint(getLogFile()),
    getPathFingerprint(getContactHistoryFile()),
    getPathFingerprint(getOutreachTargetsFile()),
    getPathFingerprint(getLiveMonitorFile()),
    getPathFingerprint(targetPath),
    getPathFingerprint(settings.getScreenshotDir()),
  ].join('|');
  const preferenceFingerprint = JSON.stringify({
    excludes: settings.getExcludeStatuses(),
    host: settings.getHost(),
    port: settings.getPort(),
    targetPath,
    screenshotDir: settings.getScreenshotDir(),
  });
  return `${settingsFingerprints}||${sourceFingerprints}||${preferenceFingerprint}`;
}

function invalidateDashboardDataCache() {
  dashboardDataCacheKey = null;
  dashboardDataCacheValue = null;
  dashboardDataCacheBuiltAt = 0;
}

function getLogFile() {
  return resolveDataPath('action-log.json');
}

function getContactHistoryFile() {
  return resolveDataPath('contact-history.json');
}

function getOutreachTargetsFile() {
  return resolveDataPath('outreach-targets.json');
}

function getSelectedAiProvider() {
  try {
    return normalizeProviderId(typeof settings.getAiProvider === 'function' ? settings.getAiProvider() : 'claude');
  } catch (_) {
    return normalizeProviderId(activeAiProvider || 'claude');
  }
}

function getManagedAiProvider() {
  return normalizeProviderId(activeAiProvider || getSelectedAiProvider());
}

function getProviderDisplayName(providerId) {
  return getProvider(providerId).displayName;
}

function getConfiguredAiAutoSendSafe() {
  try {
    return !!(typeof settings.getAutoSendEligibleForms === 'function' ? settings.getAutoSendEligibleForms() : false);
  } catch (_) {
    return false;
  }
}

function getManagedAiAutoSendSafe() {
  return !!managedAiAutoSendSafe;
}

function getAutoSendPolicyLabel(autoSendSafe, lang = 'ja') {
  if (autoSendSafe) {
    return lang === 'ja' ? '安全なフォームは自動送信' : 'Auto-send safe forms';
  }
  return lang === 'ja' ? '確認待ちで停止' : 'Stop for approval';
}

function getProviderModeLabel(providerId, mode, lang = 'ja') {
  const provider = normalizeProviderId(providerId);
  const currentMode = String(mode || '').trim();
  const isJa = lang === 'ja';
  const byProvider = {
    claude: {
      default: isJa ? '標準モード' : 'Default',
      acceptEdits: isJa ? '編集支援' : 'Assist edits',
      auto: isJa ? '完全自動' : 'Auto',
      bypassPermissions: isJa ? '権限スキップ' : 'Bypass permissions',
    },
    codex: {
      default: isJa ? 'on-request' : 'On-request',
      acceptEdits: isJa ? 'on-request（手動監視）' : 'On-request (manual)',
      auto: isJa ? 'no-prompt auto' : 'No-prompt auto',
      bypassPermissions: isJa ? 'danger bypass' : 'Danger bypass',
      'danger-full-access': isJa ? 'danger bypass' : 'Danger bypass',
    },
    gemini: {
      default: isJa ? 'default approvals' : 'Default approvals',
      acceptEdits: isJa ? 'auto_edit（手動監視）' : 'auto_edit (manual)',
      auto: 'auto_edit',
      auto_edit: 'auto_edit',
      bypassPermissions: 'yolo',
      yolo: 'yolo',
      'headless-yolo': 'yolo',
    },
  };
  const labels = byProvider[provider] || byProvider.claude;
  return labels[currentMode] || currentMode || (isJa ? '未設定' : 'Unknown');
}

function getProviderRecommendedModesText(providerId, lang = 'ja') {
  const provider = normalizeProviderId(providerId);
  if (provider === 'codex') {
    return lang === 'ja'
      ? 'no-prompt auto（auto）または danger bypass（bypassPermissions）'
      : 'no-prompt auto (auto) or danger bypass (bypassPermissions)';
  }
  if (provider === 'gemini') {
    return lang === 'ja'
      ? 'auto_edit（auto）または yolo（bypassPermissions）'
      : 'auto_edit (auto) or yolo (bypassPermissions)';
  }
  return lang === 'ja'
    ? 'auto または bypassPermissions'
    : 'auto or bypassPermissions';
}

function getProviderApprovalCaveat(providerId, lang = 'ja') {
  const provider = normalizeProviderId(providerId);
  const isJa = lang === 'ja';
  if (provider === 'codex') {
    return {
      tone: 'warn',
      message: isJa
        ? "Codex は bypassPermissions でも起動フラグ自体は正しく付きますが、Playwright MCP の操作種別ごとに Codex 本体の許可ダイアログが一度だけ出る場合があります。これは Sales Claw 側の起動ミスではなく Codex 側の権限ルールです。表示されたら「Yes, and don't ask again」を選ぶと次回から抑制できます。"
        : 'Codex still receives the bypass flags correctly, but Codex itself may show a one-time permission dialog for Playwright MCP action types. This is a Codex-side permission rule, not a Sales Claw launch failure. Choose "Yes, and don\'t ask again" to suppress it next time.',
    };
  }
  if (provider === 'gemini') {
    return {
      tone: 'warn',
      message: isJa
        ? 'Gemini は yolo でも browser / MCP 系の確認が残る場合があります。Sales Claw 側では最強の approval-mode を渡していますが、Gemini 側の安全確認は完全には消せないことがあります。'
        : 'Gemini may still pause for browser / MCP confirmations even in yolo mode. Sales Claw passes the strongest approval mode available, but Gemini can still keep its own safety checks.',
    };
  }
  return {
    tone: 'ok',
    message: isJa
      ? 'Claude の bypassPermissions は通常、CLI 側の権限確認を大きく減らします。残る場合はログインや初期セットアップ由来の停止を疑ってください。'
      : 'Claude bypassPermissions usually removes most CLI-side permission prompts. If it still pauses, it is more likely a login or bootstrap issue.',
  };
}

function getProviderLaunchExamples(providerId) {
  return {
    auto: buildLaunchArgs(providerId, 'auto', {}).join(' '),
    bypassPermissions: buildLaunchArgs(providerId, 'bypassPermissions', {}).join(' '),
    default: buildLaunchArgs(providerId, 'default', {}).join(' '),
  };
}

// "codex-cli 0.118.0" / "1.2.3-beta" / "v0.4" 等から [major, minor, patch] を抽出する。
// 取れない場合は null を返す。
function parseSemverLike(value) {
  const match = String(value || '').match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) return null;
  return [Number(match[1]) || 0, Number(match[2]) || 0, Number(match[3]) || 0];
}

function compareSemver(a, b) {
  for (let i = 0; i < 3; i++) {
    const av = a[i] || 0;
    const bv = b[i] || 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

function getProviderVersionWarning(providerId, versionLine) {
  const provider = getProvider(providerId);
  if (!provider.minRecommendedCliVersion) return null;
  const installed = parseSemverLike(versionLine);
  const min = parseSemverLike(provider.minRecommendedCliVersion);
  if (!installed || !min || compareSemver(installed, min) >= 0) return null;
  return {
    cliTooOld: true,
    installedVersion: String(versionLine || '').trim() || null,
    minVersion: provider.minRecommendedCliVersion,
    updateCommand: `npm install -g ${provider.installPackage}@latest`,
    message:
      `${provider.cliLabel} のバージョンが古いため最新モデルが使えません ` +
      `(検出: ${String(versionLine || '').trim() || '不明'} / 推奨: ${provider.minRecommendedCliVersion}+)。`,
  };
}

function getManagedAiReadyDelay(providerId) {
  return MANAGED_AI_READY_DELAY_MS[normalizeProviderId(providerId)] || 2500;
}

function getManagedAiEnterDelay(providerId) {
  return MANAGED_AI_ENTER_DELAY_MS[normalizeProviderId(providerId)] || 300;
}

function getManagedAiMinReadyAge(providerId) {
  return MANAGED_AI_MIN_READY_AGE_MS[normalizeProviderId(providerId)] || 0;
}

function getManagedAiSubmitSequence(providerId) {
  switch (normalizeProviderId(providerId)) {
    case 'codex':
      return ['\t', '\r'];
    case 'claude':
      // Claude の UI は >49 行のペーストに対して "[Pasted text #1 +49 lines]
      // paste again to expand" バナーを出して 2 回目の Enter を待つ。
      // 1 回目の \r で paste 確定 → バナー表示 → 2 回目の \r で expand+実行。
      // 250 ms 後に 1 つ目、後続 220 ms 後に 2 つ目を送る (下記 dispatcher で
      // クロード時は inter-key 遅延を長くする)。
      return ['\r', '\r'];
    default:
      return ['\r'];
  }
}

// stripAnsiCodes は ./ai-runtime/batch-utils.cjs に分離済み。既存呼び出しのため wrap を残す
function stripAnsiCodes(value) {
  return batchUtils.stripAnsiCodes(value);
}

function clearManagedAiSessionStateTimers(state = managedAiSessionState) {
  if (!state) return;
  if (state.readyTimer) {
    clearTimeout(state.readyTimer);
    state.readyTimer = null;
  }
  if (state.enterTimer) {
    clearTimeout(state.enterTimer);
    state.enterTimer = null;
  }
}

function clearManagedAiBatchControllerTimer(controller = managedAiBatchController) {
  if (!controller || !controller.pollTimer) return;
  // v2.0.48 F3: poller が setInterval から再帰 setTimeout に変わったため、
  //   clearTimeout / clearInterval の両方を呼んでも安全 (Node.js Timeout は
  //   どちらでも cleanup できる)。互換性のため両方呼ぶ。
  try { clearTimeout(controller.pollTimer); } catch (_) { /* swallow */ }
  try { clearInterval(controller.pollTimer); } catch (_) { /* swallow */ }
  controller.pollTimer = null;
}

function clearManagedAiRecoveryTimer() {
  if (!managedAiRecoveryTimer) return;
  clearTimeout(managedAiRecoveryTimer);
  managedAiRecoveryTimer = null;
}

function resetManagedAiBatchController() {
  clearManagedAiBatchControllerTimer();
  managedAiBatchController = null;
}

function createManagedAiBatchController(providerId, autoSendSafe) {
  // 実体は ./ai-runtime/batch-utils.cjs。providerId 正規化だけ wrap。
  return batchUtils.createManagedAiBatchController(normalizeProviderId(providerId), autoSendSafe);
}

function ensureManagedAiBatchController(providerId, autoSendSafe) {
  const normalizedProviderId = normalizeProviderId(providerId);
  if (!managedAiBatchController) {
    managedAiBatchController = createManagedAiBatchController(normalizedProviderId, autoSendSafe);
    return managedAiBatchController;
  }
  if (managedAiBatchController.providerId !== normalizedProviderId) {
    throw new Error(`現在の managed batch controller は ${getProviderDisplayName(managedAiBatchController.providerId)} 用です。${getProviderDisplayName(normalizedProviderId)} に切り替える前に現在のバッチを完了または停止してください。`);
  }
  managedAiBatchController.autoSendSafe = !!autoSendSafe;
  return managedAiBatchController;
}

function snapshotManagedAiBatchesForRecovery() {
  const controller = managedAiBatchController;
  if (!controller) return null;
  const snapshot: any = {
    providerId: controller.providerId,
    autoSendSafe: !!controller.autoSendSafe,
    mode: claudeProcessMode || getProvider(controller.providerId).defaultMode || 'auto',
    batches: [] as any[],
  };
  if (controller.activeBatch && Array.isArray(controller.activeBatch.companies) && controller.activeBatch.companies.length > 0) {
    const progress = getManagedAiBatchProgressSnapshot(controller.activeBatch.companyNos || []);
    const terminalNos = new Set((progress.statuses || [])
      .filter((status: any) => status && status.terminal)
      .map((status: any) => Number(status.companyNo)));
    const remainingCompanies = controller.activeBatch.companies
      .filter((company: any) => !terminalNos.has(Number(company.no)));
    if (remainingCompanies.length > 0) {
      snapshot.batches.push({
        id: controller.activeBatch.id,
        companies: remainingCompanies,
        options: { ...(controller.activeBatch.options || {}) },
      });
    }
  }
  (controller.pending || []).forEach((batch: any) => {
    if (!batch || !Array.isArray(batch.companies) || batch.companies.length === 0) return;
    snapshot.batches.push({
      id: batch.id,
      companies: batch.companies.slice(),
      options: { ...(batch.options || {}) },
    });
  });
  if (snapshot.batches.length > 0) {
    try { saveRecoverySnapshot(snapshot); } catch (_) {}
    return snapshot;
  }
  return null;
}

function restoreManagedAiBatchesFromRecovery(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.batches) || snapshot.batches.length === 0) return null;
  const controller = ensureManagedAiBatchController(snapshot.providerId, snapshot.autoSendSafe);
  controller.pending = snapshot.batches.map((batch: any) => ({
    id: batch.id || `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    companies: Array.isArray(batch.companies) ? batch.companies.slice() : [],
    options: { ...(batch.options || {}) },
  })).filter((batch: any) => batch.companies.length > 0);
  controller.activeBatch = null;
  controller.batchCounter = Math.max(controller.batchCounter || 0, controller.pending.length);
  startManagedAiBatchPoller();
  if (!controller.activeBatch && controller.pending.length > 0) {
    setTimeout(() => {
      dispatchNextManagedAiFormFillBatch();
    }, 350);
  }
  try { clearRecoverySnapshot(); } catch (_) {}
  return controller;
}

// chunkManagedAiCompanies / buildManagedAiBatchOptionsSubset / parseEventTimestampMs は
// ./ai-runtime/batch-utils.cjs に分離済み (batchUtils.* として参照)
// getManagedAiPtyLogFile / appendManagedAiPtyLog は ./ai-runtime/pty-log.cjs に分離済み
function chunkManagedAiCompanies(companies, chunkSize = getManagedAiFormBatchSize()) {
  return batchUtils.chunkManagedAiCompanies(companies, chunkSize);
}
function buildManagedAiBatchOptionsSubset(baseOptions, companies) {
  return batchUtils.buildManagedAiBatchOptionsSubset(baseOptions, companies);
}
function parseEventTimestampMs(value) {
  return batchUtils.parseEventTimestampMs(value);
}
function getManagedAiPtyLogFile(providerId = getManagedAiProvider()) {
  return ptyLog.getManagedAiPtyLogFile(normalizeProviderId(providerId));
}
function appendManagedAiPtyLog(providerId, chunk, kind = 'output') {
  ptyLog.appendManagedAiPtyLog(providerId, chunk, kind, { maxBytes: MANAGED_AI_PTY_LOG_MAX_BYTES });
}

function getManagedAiBatchProgressSnapshot(companyNos: any[] = []) {
  const keySet = new Set((companyNos || []).map((value: any) => String(value)));
  const latestLogByCompany = new Map<any, any>();
  const latestMonitorByCompany = new Map<any, any>();
  const logs = getAllLogs();
  logs.forEach((entry: any) => {
    const key = String(entry.companyNo || entry.no || '');
    if (!keySet.has(key)) return;
    latestLogByCompany.set(key, entry);
  });
  const monitorState = readMonitorState();
  const monitorEvents = monitorState && Array.isArray(monitorState.events) ? monitorState.events : [];
  monitorEvents.forEach((entry: any) => {
    const key = String(entry.companyNo || '');
    if (!keySet.has(key)) return;
    latestMonitorByCompany.set(key, entry);
  });

  // v2.0.65: confirm_reached も terminal 扱いに追加。
  //   旧バグ: CLI がフォーム入力 + 確認画面到達まで進めた (confirm_reached を log) のに、
  //     後続の awaiting_approval を log し損ねたケースで、batch が永久に未完了状態に
  //     なり、watchdog の 20分タイムアウトを発火 → 同じ batch の別社まで巻き添えで
  //     error 化される事故 (実機 2026-05-21 [182, 187, 189] 件)。
  //   方針: confirm_reached = フォーム入力 + スクショ完了済み (ユーザーが
  //     ダッシュボードで確認 / 手動承認できる状態)。terminal として扱って batch を
  //     進ませ、UI 側で「確認画面到達 - 手動レビュー推奨」を出す。
  //   注: 1319 行目の terminalStates (live-monitor cleanup 用) はこちらには
  //     入れない。confirm_reached の active event は 20 分以上残しておきたい。
  const terminalStates = new Set(['awaiting_approval', 'submitted', 'completed', 'skipped', 'error', 'confirm_reached']);
  let terminalCount = 0;
  let latestActivityAt = 0;
  const statuses: any[] = [];

  keySet.forEach((key: any) => {
    const latestLog = latestLogByCompany.get(key) || null;
    const latestMonitor = latestMonitorByCompany.get(key) || null;
    const action = latestLog && latestLog.action ? String(latestLog.action) : '';
    const monitorStatus = latestMonitor && latestMonitor.status ? String(latestMonitor.status) : '';
    const terminal = terminalStates.has(action) || terminalStates.has(monitorStatus);
    if (terminal) terminalCount += 1;
    latestActivityAt = Math.max(
      latestActivityAt,
      parseEventTimestampMs(latestLog && (latestLog.timestamp || latestLog.date || latestLog.time)),
      parseEventTimestampMs(latestMonitor && (latestMonitor.updatedAt || latestMonitor.timestamp || latestMonitor.time)),
    );
    // latestTimestamp: watchdog の per-company 判定に使う。
    // action-log の timestamp を優先し、無ければ monitor の updatedAt をフォールバック
    const latestTimestamp = (latestLog && (latestLog.timestamp || latestLog.date || latestLog.time))
      || (latestMonitor && (latestMonitor.updatedAt || latestMonitor.timestamp || latestMonitor.time))
      || null;
    statuses.push({
      companyNo: Number(key),
      action,
      monitorStatus,
      terminal,
      latestTimestamp,
    });
  });

  return {
    terminalCount,
    totalCount: keySet.size,
    latestActivityAt,
    statuses,
  };
}

function getManagedAiReservedCompanyNos() {
  const reserved = new Set<any>();
  const controller = managedAiBatchController;
  if (!controller) return reserved;
  if (controller.activeBatch && Array.isArray(controller.activeBatch.companyNos)) {
    controller.activeBatch.companyNos.forEach((companyNo: any) => {
      if (companyNo !== undefined && companyNo !== null) reserved.add(Number(companyNo));
    });
  }
  (controller.pending || []).forEach((batch: any) => {
    (batch && batch.companies || []).forEach((company: any) => {
      if (company && company.no !== undefined && company.no !== null) reserved.add(Number(company.no));
    });
  });
  return reserved;
}

function isAiRuntimeActivelyProcessing() {
  if (getActiveHeadlessRun()) return true;
  if (claudePty) return true;
  const controller = managedAiBatchController;
  return !!(controller && (controller.activeBatch || (controller.pending && controller.pending.length > 0)));
}

function touchManagedAiBatchActivity(reason = 'unknown') {
  const controller = managedAiBatchController;
  if (!controller || !controller.activeBatch) return;
  controller.activeBatch.lastProgressAt = Date.now();
  controller.activeBatch.lastProgressReason = reason;
}

function cleanupStaleManagedAiMonitorEvents(maxAgeMs = MANAGED_AI_BATCH_STALL_MS, options: { force?: boolean } = {}) {
  // v2.0.42: force=true (ユーザー明示停止 / 強制リセット時) は PTY 死活を問わず実行する。
  //   旧: PTY 生存中だと無条件 return 0 → stopManagedClaudePty が cleanup を呼んでも
  //     no-op になり、live-monitor の analyzing/active=true な古い event が残留 →
  //     再キュー時に「以下の企業は既に処理中です」エラーで弾かれる事故。
  if (!options.force && (claudePty || getActiveHeadlessRun())) return 0;
  const summary = getLiveMonitorSummary();
  const terminalStates = new Set(['awaiting_approval', 'submitted', 'completed', 'skipped', 'error']);
  const now = Date.now();
  let cleaned = 0;
  (summary.events || []).forEach((event: any) => {
    if (!event || event.active === false) return;
    if (terminalStates.has(String(event.status || ''))) return;
    const updatedAtMs = parseEventTimestampMs(event.updatedAt || event.timestamp || event.time);
    if (!updatedAtMs || (now - updatedAtMs) < maxAgeMs) return;
    finishLiveMonitor(event.companyNo, {
      companyNo: event.companyNo,
      companyName: event.companyName || '',
      status: 'error',
      step: `前回セッションが停止したため自動終了 (${Math.round((now - updatedAtMs) / 60000)}分更新なし)`,
      latestScreenshot: event.latestScreenshot || null,
    });
    cleaned += 1;
  });
  if (cleaned > 0) {
    appendDiagnosticEvent('stale_managed_ai_sessions_cleaned', {
      cleanedCount: cleaned,
      maxAgeMs,
    });
  }
  return cleaned;
}

function createManagedAiSessionState(providerId) {
  const normalizedProviderId = normalizeProviderId(providerId);
  return {
    providerId: normalizedProviderId,
    launchedAt: Date.now(),
    recentOutput: '',
    ready: false,
    readyAt: 0,
    readyReason: null,
    queue: [],
    dispatching: false,
    readyTimer: null,
    enterTimer: null,
    contractVersionSent: 0,
    authFingerprint: getProviderAuthFingerprint(normalizedProviderId),
  };
}

function getProviderAuthFingerprint(providerId) {
  const normalizedProviderId = normalizeProviderId(providerId);
  const authFiles = Array.from(new Set([
    ...(getAuthFiles(normalizedProviderId) || []),
    normalizedProviderId === 'claude' ? path.join(os.homedir(), '.claude.json') : null,
  ].filter(Boolean)));
  return authFiles.map((filePath: any) => {
    try {
      const stat = fs.statSync(filePath);
      return `${String(filePath || '').toLowerCase()}:${stat.size}:${Math.floor(stat.mtimeMs)}`;
    } catch (_) {
      return `${String(filePath || '').toLowerCase()}:missing`;
    }
  }).join('|');
}

function isManagedAiAuthFingerprintStale(providerId = getManagedAiProvider()) {
  const state = managedAiSessionState;
  const normalizedProviderId = normalizeProviderId(providerId);
  if (!state || state.providerId !== normalizedProviderId) return false;
  return String(state.authFingerprint || '') !== String(getProviderAuthFingerprint(normalizedProviderId) || '');
}

function hasManagedAiStartupBlocker(providerId, outputText) {
  const normalizedProviderId = normalizeProviderId(providerId);
  const tail = String(outputText || '').slice(-6000);
  const hasVisiblePrompt = hasManagedAiReadyMarker(normalizedProviderId, tail);
  if (/Do you trust the following folders/i.test(tail)) return true;
  if (/Action Required/i.test(tail) && !hasVisiblePrompt) return true;
  if (normalizedProviderId === 'codex'
    && /Starting MCP servers/i.test(tail)
    && !/MCP startup incomplete/i.test(tail)
    && !hasVisiblePrompt) {
    return true;
  }
  if (normalizedProviderId === 'gemini'
    && /Applying trust settings/i.test(tail)
    && !hasVisiblePrompt) {
    return true;
  }
  return false;
}

function scheduleManagedAiReadyTimer(providerId, delayMs = getManagedAiReadyDelay(providerId)) {
  const state = managedAiSessionState;
  if (!state) return;
  if (state.readyTimer) {
    clearTimeout(state.readyTimer);
  }
  state.readyTimer = setTimeout(() => {
    const currentState = managedAiSessionState;
    if (!currentState || currentState !== state) return;
    const stateAge = Date.now() - currentState.launchedAt;
    const minReadyAge = getManagedAiMinReadyAge(providerId);
    if (stateAge < minReadyAge) {
      scheduleManagedAiReadyTimer(providerId, Math.max(1000, minReadyAge - stateAge));
      return;
    }
    if (hasManagedAiReadyMarker(providerId, currentState.recentOutput)) {
      markManagedAiSessionReady('startup-timer-prompt-visible');
      return;
    }
    if (hasManagedAiStartupBlocker(providerId, currentState.recentOutput)) {
      scheduleManagedAiReadyTimer(providerId, 3000);
      return;
    }
    markManagedAiSessionReady('startup-delay');
  }, delayMs);
  if (typeof state.readyTimer.unref === 'function') {
    state.readyTimer.unref();
  }
}

function resetManagedAiSessionState(providerId) {
  clearManagedAiSessionStateTimers();
  managedAiSessionState = createManagedAiSessionState(providerId);
  scheduleManagedAiReadyTimer(providerId);
  appendDiagnosticEvent('managed_ai_state_reset', {
    provider: normalizeProviderId(providerId),
    readyDelayMs: getManagedAiReadyDelay(providerId),
    minReadyAgeMs: getManagedAiMinReadyAge(providerId),
  });
  return managedAiSessionState;
}

function getManagedAiSessionState() {
  if (!managedAiSessionState || managedAiSessionState.providerId !== getManagedAiProvider()) {
    managedAiSessionState = createManagedAiSessionState(getManagedAiProvider());
  }
  return managedAiSessionState;
}

function getManagedAiReadyMarkers(providerId) {
  switch (normalizeProviderId(providerId)) {
    case 'codex':
      return [
        /›\s+/,
        /Type instructions and press Enter/i,
        /Write tests for @filename/i,
        /Explain this codebase/i,
        /Implement \{feature\}/i,
        /gpt-5\.[0-9]/i,
      ];
    case 'gemini':
      return [
        /Type your message or @path\/to\/file/i,
        /Type your message/i,
      ];
    case 'claude':
    default:
      return [
        /\? for shortcuts/i,
        />\s*$/m,
      ];
  }
}

function hasManagedAiReadyMarker(providerId, outputText) {
  const markers = getManagedAiReadyMarkers(providerId);
  return markers.some((pattern: any) => pattern.test(String(outputText || '')));
}

function markManagedAiSessionReady(reason = 'unknown') {
  const state = managedAiSessionState;
  if (!state || state.ready) return;
  state.ready = true;
  state.readyAt = Date.now();
  state.readyReason = reason;
  if (state.readyTimer) {
    clearTimeout(state.readyTimer);
    state.readyTimer = null;
  }
  appendDiagnosticEvent('managed_ai_ready', {
    provider: state.providerId,
    reason,
    ageMs: state.readyAt - state.launchedAt,
    queueLength: state.queue.length,
  });
  flushManagedAiPromptQueue();
}

function updateManagedAiReadyFromOutput(providerId, chunk) {
  const state = managedAiSessionState;
  if (!state || state.providerId !== normalizeProviderId(providerId)) return;
  const normalized = stripAnsiCodes(`${state.recentOutput}${String(chunk || '')}`);
  state.recentOutput = normalized.slice(-16000);
  if (state.ready) return;
  if ((Date.now() - state.launchedAt) < getManagedAiMinReadyAge(providerId)) return;
  if (hasManagedAiReadyMarker(providerId, state.recentOutput)) {
    markManagedAiSessionReady('cli-prompt-visible');
    return;
  }
  if (hasManagedAiStartupBlocker(providerId, state.recentOutput)) return;
}

// CLI出力からエラー・承認要求・トークン制限等を検知して進行状況ログに転送
// パターン定義と分類ロジックは src/cli-issue-classifier.cjs に切り出した。
// 副作用なしの pure 関数なのでテストカバレッジを取れる。
let _lastCliIssueTime = 0;

function detectCliIssuesFromOutput(rawData, providerId) {
  const now = Date.now();
  if (now - _lastCliIssueTime < 2000) return; // 2秒デバウンス（同じエラーの連打防止）
  const text = stripAnsiCodes(String(rawData || ''));
  const classified = classifyCliText(text);
  if (!classified) return;
  _lastCliIssueTime = now;
  const provider = getProvider(normalizeProviderId(providerId));
  const message = '[' + provider.displayName + '] ' + classified.rule.label + ': ' + classified.line;
  // SSE で全クライアントに通知
  sseClients.forEach(function(r) {
    r.write('data: ' + JSON.stringify({
      type: 'cli-log',
      message,
      logType: classified.rule.type,
      time: new Date().toISOString(),
    }) + '\n\n');
  });

  // v2.0.45: Claude 認証失効 / レート上限を検出したら recovery 無限再起動を停止する。
  //   Claude CLI が "Please run /login" / "API Error: 401" を出してから exit すると
  //   旧仕様では recovery が新しい PTY を起動し、同じ 401 で死ぬループに陥る。
  //   検出時:
  //     1. recovery state をクリア (これ以上 PTY を立ち上げない)
  //     2. pending バッチは保持 (ユーザーが /login 後に再開できる)
  //     3. UI / SSE に明示メッセージを出す
  // v2.0.65: スパム抑制ガードを追加。
  //   旧バグ: Claude CLI が認証切れ後 "Please run /login · API Error: 401" を
  //     30 秒間隔で繰り返し出力する → 1 日 106 件の claude_auth_failure_detected が
  //     log に溜まる + SSE/emitClaudeAutomationLog がスパムされる。
  //   markClaudeAuthFailed() 自体は二重発火ガード済みだが、その他の処理
  //     (diagnostic / SSE / emit) は毎回走っていた。
  //   修正: isClaudeAuthCurrentlyFailed() で早期 return。次の managed_ai_ready
  //     等で clearClaudeAuthFailedFlag() されてから再度ハンドリング可能。
  if (classified.rule.label === 'Claude認証失効/レート上限' && !isClaudeAuthCurrentlyFailed()) {
    try {
      // v2.0.49: PTY 側だけでなく Phase A subprocess workers にも止まるよう通知。
      //   activePhaseAChildProcesses を SIGTERM して runOne ループに早期 exit
      //   させる。これがないと 100 社 Phase A が走ってる場合に全 100 社が個別に
      //   401 を踏むまで止まらない。
      markClaudeAuthFailed('managed-pty-401');
      // 既存の recovery 予定をキャンセル
      if (typeof clearManagedAiRecoveryTimer === 'function') clearManagedAiRecoveryTimer();
      managedAiRecoveryState = null;
      // 次の PTY exit で recovery が再キューされないよう suppress を立てる
      managedAiSuppressAutoRecovery = true;
      // active batch は pending に戻して保持 (停止扱いではなく一時凍結)
      const controller: any = managedAiBatchController;
      if (controller && controller.activeBatch && Array.isArray(controller.pending)) {
        const frozen = {
          id: controller.activeBatch.id,
          companies: controller.activeBatch.companies || [],
          options: controller.activeBatch.options || {},
        };
        controller.pending.unshift(frozen);
        controller.activeBatch = null;
      }
      appendDiagnosticEvent('claude_auth_failure_detected', {
        provider: normalizeProviderId(providerId),
        line: classified.line,
        pendingBatchCount: controller && Array.isArray(controller.pending) ? controller.pending.length : 0,
      });
      emitClaudeAutomationLog(
        `[認証/レート停止] Claude が API 401 (認証失効 または Pro 5時間使用上限) を返しました。\n→ 自動再起動を停止しました。pending バッチは保持しています。\n→ 対処: 1) Claude が表示する画面で /login を実行 / 2) Pro/Max の 5時間枠リセット待ち\n→ 解決したら「AI を起動」ボタンを押すと残りバッチが再開されます。\n`,
        'warn',
        normalizeProviderId(providerId),
      );
      sseClients.forEach(function(r) {
        r.write('data: ' + JSON.stringify({
          type: 'cli-log',
          message: '[Sales Claw] Claude 認証失効を検出 → 自動再起動を停止しました。/login またはレート枠リセット後に「AI を起動」してください。',
          logType: 'warn',
          time: new Date().toISOString(),
        }) + '\n\n');
      });
    } catch (e) {
      console.warn('[auth-failure-handler] error:', e && e.message || e);
    }
  }
}

function flushManagedAiPromptQueue() {
  const state = managedAiSessionState;
  if (!state || !claudePty || state.dispatching || !state.ready || state.queue.length === 0) return;
  const next = state.queue.shift();
  state.dispatching = true;
  appendDiagnosticEvent('managed_ai_prompt_dispatch', {
    provider: state.providerId,
    queuedAt: next.queuedAt,
    ageMs: Date.now() - next.queuedAt,
    remainingQueueLength: state.queue.length,
  });
  const promptPayload = typeof next.promptText === 'string' && next.promptText.includes('\n')
    ? `\u001b[200~${next.promptText}\u001b[201~`
    : next.promptText;
  try {
    appendManagedAiPtyLog(state.providerId, `[dispatch] prompt queued (${String(next.promptText || '').length} chars)`, 'system');
    touchManagedAiBatchActivity('prompt-dispatch');
    claudePty.write(promptPayload);
  } catch (error) {
    // PTY exited 中の write は同期 throw する。setTimeout 経由で呼ばれた場合
    // uncaughtException → gracefulShutdown(1) で Electron main が即死するので
    // ここで握り潰す。dispatcher state はリセットして次の queue 投入に備える。
    state.dispatching = false;
    console.warn('[pty-dispatch] prompt write failed (pty exited?):', error && error.message || error);
    appendManagedAiPtyLog(state.providerId, `[dispatch] write failed: ${error && error.message || error}`, 'system');
    return;
  }
  const submitSequence = getManagedAiSubmitSequence(state.providerId);
  const isClaude = normalizeProviderId(state.providerId) === 'claude';
  // P1-5: detectPasteBannerAndAdvance がトリガーするための共有 state
  state.pasteBannerWatcher = null;
  const sendSubmitKey = (index = 0) => {
    const submitKey = submitSequence[index];
    if (!submitKey) {
      state.dispatching = false;
      state.enterTimer = null;
      state.pasteBannerWatcher = null;
      setTimeout(() => flushManagedAiPromptQueue(), 250);
      return;
    }
    // 通常の遅延ロジック
    let delay;
    if (index === 0) {
      delay = getManagedAiEnterDelay(state.providerId);
    } else if (isClaude) {
      // v2.0.48 F5: 30s → 8s に短縮。detectPasteBannerAndAdvance が PTY 出力から
      //   banner を見つけた瞬間に pasteBannerWatcher を呼んで即発火する仕組み
      //   が primary path で、これは 99% のケースで 1-3s 以内に発火する。30s は
      //   検出を完全に取りこぼした際の safety net だが、実機実績から 8s で十分。
      //   100 batch 規模で fallback が連続発動した場合の累積待ちが 50min → 13min
      //   に減る (safety net が 1 回も発動しないケースなら効果はゼロ)。
      delay = MANAGED_AI_CLAUDE_PASTE_FALLBACK_MS;
    } else {
      delay = 220;
    }
    const fire = () => {
      // pasteBannerWatcher が clear されていなければ以降も不要 → 解除しておく
      state.pasteBannerWatcher = null;
      try {
        if (claudePty) {
          claudePty.write(submitKey);
          appendManagedAiPtyLog(state.providerId, `[dispatch] submit key sent (${JSON.stringify(submitKey)})`, 'system');
          touchManagedAiBatchActivity('submit-key');
        }
      } catch (e) {
        // PTY が exit 済みだと write が同期 throw する。timer callback で
        // 漏らすと uncaughtException → gracefulShutdown(1) で死ぬので
        // ここで握り潰し、ログだけ残す。
        console.warn('[pty-dispatch] submit key write failed:', e && e.message || e);
      } finally {
        sendSubmitKey(index + 1);
      }
    };
    state.enterTimer = setTimeout(fire, delay);
    if (typeof state.enterTimer.unref === 'function') {
      state.enterTimer.unref();
    }
    // 2 回目の Enter (Claude のみ): paste banner を待ってから即発火。
    // 30 秒待つより 1〜3 秒で済むので体感が劇的に良くなる。
    if (isClaude && index === 1) {
      state.pasteBannerWatcher = () => {
        if (state.enterTimer) {
          clearTimeout(state.enterTimer);
          state.enterTimer = null;
        }
        fire();
      };
    }
  };
  sendSubmitKey(0);
}

/**
 * PTY 出力に paste banner が現れたら、待機中の 2nd Enter を即発火する。
 * dispatchManagedAiPrompt の sendSubmitKey が登録した
 * state.pasteBannerWatcher を呼ぶことで実現。
 *
 * 検出パターン: Claude UI 仕様の "[Pasted text" もしくは "paste again to expand"。
 * ANSI escape 等が混じる可能性があるので緩めに正規表現マッチする。
 *
 * @param {string} data - PTY 1 chunk
 * @param {string} providerId
 */
function detectPasteBannerAndAdvance(data, providerId) {
  try {
    if (normalizeProviderId(providerId) !== 'claude') return;
    const state = managedAiSessionState;
    const haystack = stripAnsiCodes(`${state && state.recentOutput ? state.recentOutput : ''}${String(data || '')}`).slice(-16000);
    if (!haystack || !batchUtils.hasClaudePasteBanner(haystack)) return;
    if (!state || typeof state.pasteBannerWatcher !== 'function') return;
    const watcher = state.pasteBannerWatcher;
    state.pasteBannerWatcher = null;
    // PTY UI がバナー出力直後に input フォーカス完了するまで一拍置く
    setTimeout(() => {
      try { watcher(); } catch (e) {
        console.warn('[paste-banner] watcher failed:', e && e.message || e);
      }
    }, 400);
    appendManagedAiPtyLog(providerId, '[dispatch] paste banner detected → advancing', 'system');
  } catch (_) { /* silent */ }
}

function queueManagedAiPrompt(promptText, providerId) {
  const state = getManagedAiSessionState();
  const normalizedProviderId = normalizeProviderId(providerId);
  if (state.providerId !== normalizedProviderId) {
    throw new Error(`${getProviderDisplayName(normalizedProviderId)} の管理セッションが一致していません。`);
  }
  state.queue.push({
    promptText: String(promptText || ''),
    queuedAt: Date.now(),
  });
  appendDiagnosticEvent('managed_ai_prompt_queued', {
    provider: normalizedProviderId,
    ready: state.ready,
    queueLength: state.queue.length,
    promptChars: String(promptText || '').length,
    estimatedTokens: estimateTextTokens(promptText),
  });
  flushManagedAiPromptQueue();
  return {
    queued: true,
    ready: state.ready,
    queueLength: state.queue.length,
  };
}

function startManagedAiBatchPoller() {
  const controller = managedAiBatchController;
  if (!controller || controller.pollTimer) return;
  // v2.0.48 F3: poll を adaptive にするため setInterval ではなく
  //   再帰 setTimeout を使う。activeBatch が走っている時は 2s、idle (待機 or
  //   batch 完走間際の dispatch ギャップ) は従来通り 5s。Tick の最後に次回の
  //   遅延を batch 状態から決めて再スケジュールする。clearManagedAiBatchControllerTimer
  //   は setTimeout の handle も clearTimeout で安全に処理できる。
  const tick = () => {
    const activeController = managedAiBatchController;
    if (!activeController) {
      clearManagedAiBatchControllerTimer(controller);
      return;
    }
    try {
      runPollerTickBody(activeController);
    } finally {
      const stillController = managedAiBatchController;
      if (stillController && stillController.pollTimer) {
        // clearManagedAiBatchControllerTimer が呼ばれていなければ次回をスケジュール。
        // activeBatch があれば短い間隔、なければ通常間隔。
        const delay = stillController.activeBatch
          ? MANAGED_AI_BATCH_POLL_ACTIVE_MS
          : MANAGED_AI_BATCH_POLL_MS;
        stillController.pollTimer = setTimeout(tick, delay);
        if (typeof stillController.pollTimer.unref === 'function') {
          stillController.pollTimer.unref();
        }
      }
    }
  };
  controller.pollTimer = setTimeout(tick, MANAGED_AI_BATCH_POLL_MS);
  if (typeof controller.pollTimer.unref === 'function') {
    controller.pollTimer.unref();
  }
}

// v2.0.48 F3: tick 本体を関数化。setInterval から再帰 setTimeout に切り替えた際、
//   tick の returns / early exits を素直に書けるよう本体を関数として切り出す。
function runPollerTickBody(activeController: any) {
    if (!activeController.activeBatch) {
      if (activeController.pending.length === 0) {
        clearManagedAiBatchControllerTimer(activeController);
        // v2.0.14: pending + activeBatch がともに空 → 全バッチ完走 → sleep 抑止解除
        stopPowerSaveBlockerIfActive();
        return;
      }
      // A4 watchdog: pending があるのに activeBatch が無い状態が長く続くと
      // キュー stuck (claudePty が死んでいる / 復旧失敗 / 自動 dispatch が走らない)。
      // 5 分以上続いたら診断イベント + UI 通知 + 自動 dispatch を再試行。
      if (!activeController.pendingSinceMs) {
        activeController.pendingSinceMs = Date.now();
      }
      const pendingIdleMs = Date.now() - activeController.pendingSinceMs;
      if (pendingIdleMs > MANAGED_AI_QUEUE_STUCK_MS && !activeController.queueStuckNotified) {
        activeController.queueStuckNotified = true;
        appendDiagnosticEvent('managed_ai_queue_stuck', {
          provider: activeController.providerId,
          pendingBatchCount: activeController.pending.length,
          idleMs: pendingIdleMs,
          claudePtyAlive: !!claudePty,
        });
        emitClaudeAutomationLog(
          `[キュー停滞検知] フォーム入力キューに ${activeController.pending.length} バッチ残っていますが ${Math.round(pendingIdleMs / 1000)} 秒間 dispatch されていません。AI セッションを再起動するか、ダッシュボードから一括停止→再投入してください。\n`,
          'warn',
          activeController.providerId,
        );
        // 自動復旧を試みる (失敗しても明示的な error は出さない — watchdog ログで十分)
        try { tryRecoverManagedAiSession('queue-stuck'); } catch (_) { /* swallow */ }
      }
      // claudePty が生きていれば dispatch を試す (auto-recovery が PTY を蘇生させた直後など)
      // v2.0.41: restartingForErrors 中は chain 側が dispatch を担当するためスキップ
      if (claudePty && !activeController.restartingForErrors) {
        dispatchNextManagedAiFormFillBatch();
      }
      return;
    }
    // activeBatch が走り始めたら pendingSinceMs をリセット
    activeController.pendingSinceMs = 0;
    activeController.queueStuckNotified = false;

    const snapshot = getManagedAiBatchProgressSnapshot(activeController.activeBatch.companyNos);
    if (snapshot.latestActivityAt && snapshot.latestActivityAt > activeController.activeBatch.lastProgressAt) {
      activeController.activeBatch.lastProgressAt = snapshot.latestActivityAt;
      activeController.activeBatch.lastProgressReason = 'action-log';
    }

    if (snapshot.terminalCount >= snapshot.totalCount && snapshot.totalCount > 0) {
      // v2.0.41: バッチ完了時の error 率を判定する。半数以上が error の場合は
      //   Claude レート制限 / CLI ハング の可能性が高いので、次 dispatch 前に
      //   CLI セッションを再起動して連鎖 error を断つ。
      const errorCount = (snapshot.statuses || [])
        .filter((s: any) => {
          const a = String((s && (s.latestAction || s.action)) || '').trim();
          return a === 'error';
        }).length;
      const errorRate = snapshot.totalCount > 0 ? errorCount / snapshot.totalCount : 0;
      const shouldRestartCli = errorCount >= 2 && errorRate >= 0.5;
      appendDiagnosticEvent('managed_ai_batch_completed', {
        provider: activeController.providerId,
        batchId: activeController.activeBatch.id,
        companyCount: snapshot.totalCount,
        errorCount,
        errorRate,
        shouldRestartCli,
        durationMs: Date.now() - activeController.activeBatch.startedAt,
        statuses: snapshot.statuses,
        parallelTabs: getPhaseBParallelTabs(),
      });
      appendAiRunMetric('managed_ai_batch_completed', {
        provider: activeController.providerId,
        batchId: activeController.activeBatch.id,
        companyCount: snapshot.totalCount,
        errorCount,
        errorRate,
        shouldRestartCli,
        durationMs: Date.now() - activeController.activeBatch.startedAt,
        statuses: snapshot.statuses,
        parallelTabs: getPhaseBParallelTabs(),
      });
      activeController.activeBatch = null;
      if (shouldRestartCli && activeController.pending.length > 0) {
        emitClaudeAutomationLog(
          `[CLI再起動] 直前バッチで ${errorCount}/${snapshot.totalCount}社が error。Claude レート制限 / セッション劣化の可能性が高いため、次バッチ投入前に AI セッションを再起動します。\n`,
          'warn',
          activeController.providerId,
        );
        const providerForRestart = activeController.providerId;
        const autoSendSafeForRestart = activeController.autoSendSafe !== false;
        // v2.0.41: restartingForErrors フラグで poll loop の auto-dispatch を抑止する。
        //   旧: chain 中に poll が !activeBatch && claudePty 経路に入って dispatch
        //     を呼び、停止直前の古い PTY に新バッチを投入する競合があった。
        activeController.restartingForErrors = true;
        // v2.0.48 F1: chain 全体に hard timeout を被せる。
        //   stopManagedClaudePty / startManagedAiSession のどちらかが hang する
        //   (PTY exit イベントが来ない / 起動の while(_launchInFlight) で詰まる等)
        //   と、.then チェーンは永久に進まず .catch も発火しない → flag が永久に
        //   true のまま固定化される。timeout fired 側で必ず flag をクリアし、
        //   poller の auto-recovery / 次サイクルに委ねる。
        const restartChain = Promise.resolve()
          .then(() => stopManagedClaudePty({ suppressAutoRecovery: false }))
          .then(() => startManagedAiSession('default', providerForRestart, {
            allowReuse: false,
            autoSendSafe: autoSendSafeForRestart,
          }))
          .then(() => {
            const c = managedAiBatchController;
            if (c) {
              c.restartingForErrors = false;
              if (!c.activeBatch && c.pending.length > 0) {
                dispatchNextManagedAiFormFillBatch();
              }
            }
          })
          .catch((e: any) => {
            const c = managedAiBatchController;
            if (c) c.restartingForErrors = false;
            try {
              emitClaudeAutomationLog(
                `[CLI再起動失敗] ${(e && e.message) || e}。auto-recovery に委ねます。\n`,
                'warn',
                providerForRestart,
              );
            } catch (_) { /* swallow */ }
            // 失敗しても poller は走り続ける → そのうち auto-recovery が拾う
          });
        const restartTimeoutGuard = new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            const c = managedAiBatchController;
            if (c && c.restartingForErrors) {
              c.restartingForErrors = false;
              try {
                appendDiagnosticEvent('managed_ai_restart_for_errors_timeout', {
                  provider: providerForRestart,
                  timeoutMs: MANAGED_AI_RESTART_FOR_ERRORS_TIMEOUT_MS,
                });
                emitClaudeAutomationLog(
                  `[CLI再起動タイムアウト] ${Math.round(MANAGED_AI_RESTART_FOR_ERRORS_TIMEOUT_MS / 1000)}秒以内に完了しなかったため、auto-recovery に委ねます。\n`,
                  'warn',
                  providerForRestart,
                );
              } catch (_) { /* swallow */ }
            }
            resolve();
          }, MANAGED_AI_RESTART_FOR_ERRORS_TIMEOUT_MS);
          if (typeof timer.unref === 'function') timer.unref();
        });
        Promise.race([restartChain, restartTimeoutGuard]).catch(() => { /* swallow — both branches already handle their own errors */ });
        return;
      }
      if (activeController.pending.length === 0) {
        clearManagedAiBatchControllerTimer(activeController);
        try { clearRecoverySnapshot(); } catch (_) {}
      } else {
        // v2.0.48 F4: 350ms → 100ms。PTY write 競合は 50ms 程度で十分安全だが
        //   保守的に 100ms 残す。33 batches で約 8s 短縮。
        setTimeout(() => {
          dispatchNextManagedAiFormFillBatch();
        }, MANAGED_AI_BATCH_DISPATCH_GAP_MS);
      }
      return;
    }

    // v2.0.44: v2.0.41 で導入した per-company-watchdog auto-fail を撤去。
    //   実機ログで以下の誤発火を観測:
    //     - 2026-05-18 23:58 [59,61,62]: missingFormUrl=3 + 新規セッション
    //       → 3 分閾値で auto-fail (v2.0.41 設定)
    //     - 2026-05-19 00:43 [64,66,68]: 同上 → 旧 batch-watchdog (6.7分) で auto-fail
    //   原因: WebSearch + 新規セッション首回り + parallelTabs 競合で初回 logAction まで
    //         6-7 分かかるのは正常動作。短い閾値で打ち切ると正常社まで error 化する。
    //   方針転換: 個別 auto-fail は完全停止。CLI に充分な時間を与え、本当に長期 stall
    //         した場合のみ legacy batch-watchdog (20分) が拾う。No.152 case (永久stall)
    //         は 20分待ちのほうがマシで、誤検出で社を焼くより全社失う方が損害が小さい。

    // v2.1.0: 早期ソフト警告 (表示のみ・auto-fail しない)。20 分の強制 error を待たずに
    //   「N 社が M 分応答していません」をユーザーに見せ、操作中タブの確認を促す。誤検出で
    //   社を焼くリスクが無い (ログ通知のみ) ため閾値を短く (7 分) 取れる。
    const SOFT_STALL_WARN_MS = 7 * 60 * 1000;
    if (!activeController.activeBatch.softWarnNotified
      && (Date.now() - activeController.activeBatch.lastProgressAt) > SOFT_STALL_WARN_MS) {
      activeController.activeBatch.softWarnNotified = true;
      const mins = Math.round((Date.now() - activeController.activeBatch.lastProgressAt) / 60000);
      emitClaudeAutomationLog(
        `[応答待ち] ${snapshot.totalCount}社の処理が約${mins}分更新されていません。多くは確認画面の操作待ちです。操作中タブで状況を確認できます（このまま自動継続します）。\n`,
        'info',
        activeController.providerId,
      );
    }

    // v2.0.23: バッチ stall の早期判定 (バッチ全体の safety-net)。
    // per-company が拾えなかった場合の保険として残す。
    const allEmptyAction = Array.isArray(snapshot.statuses) && snapshot.statuses.length > 0 &&
      snapshot.statuses.every((s: any) => !s || (!s.action && !s.latestAction && !s.terminal));
    // v2.0.44: emptyActionStallMs を 20/3=6.7分 → 15分 に緩和。
    //   実機で確認: missingFormUrl のみのバッチ + 新規セッション首回りで
    //   初回 logAction まで 6:40+ かかるのが正常。6.7分閾値で発火 → 全社誤 error 化。
    //   15分なら正常動作の余裕がある一方、本当の stall (No.152 case) も 15分で拾える。
    const effectiveStallMs = allEmptyAction ? 15 * 60 * 1000 : MANAGED_AI_BATCH_STALL_MS;
    if (!activeController.activeBatch.stallNotified
      && (Date.now() - activeController.activeBatch.lastProgressAt) > effectiveStallMs) {
      activeController.activeBatch.stallNotified = true;
      appendDiagnosticEvent('managed_ai_batch_stalled', {
        provider: activeController.providerId,
        batchId: activeController.activeBatch.id,
        idleMs: Date.now() - activeController.activeBatch.lastProgressAt,
        durationMs: Date.now() - activeController.activeBatch.startedAt,
        companyNos: activeController.activeBatch.companyNos,
        statuses: snapshot.statuses,
      });
      emitClaudeAutomationLog(
        `[バッチ停滞検知] ${snapshot.totalCount}社の処理が ${Math.round((Date.now() - activeController.activeBatch.lastProgressAt) / 1000)} 秒更新されていません。CLIログとフォームタブを確認してください。\n`,
        'warn',
        activeController.providerId,
      );

      // stallNotified が立った直後、message_draft/site_analysis/form_fill で停滞中の企業を自動 error 化
      // v2.0.23: emptyActionStallMs を渡して action 空の社も救う
      const stalledNos = detectStalledCompanies(
        activeController.activeBatch,
        snapshot.statuses,
        {
          stallMs: MANAGED_AI_BATCH_STALL_MS,
          emptyActionStallMs: Math.floor(MANAGED_AI_BATCH_STALL_MS / 3),
        }
      );
      if (stalledNos.length > 0) {
        stalledNos.forEach((companyNo: any) => {
          const status = snapshot.statuses.find((s: any) => Number(s.companyNo) === Number(companyNo));
          const company = activeController.activeBatch.companies.find((c: any) => Number(c.no) === Number(companyNo));
          const tsRaw = status && (status.latestTimestamp || status.updatedAt || status.timestamp);
          const idleMs = tsRaw ? Date.now() - Date.parse(tsRaw) : Date.now() - activeController.activeBatch.lastProgressAt;
          const stalledAt = status ? (status.latestAction || status.action || 'unknown') : 'unknown';
          const reason = formatStallReason(stalledAt, idleMs);
          logAction(Number(companyNo), company ? company.companyName : '', 'error', {
            source: 'batch-watchdog',
            reason,
            idleMs,
            stalledAt,
          });
          finishLiveMonitor(Number(companyNo), {
            companyNo: Number(companyNo),
            companyName: company ? company.companyName : '',
            status: 'error',
            step: reason,
          });
        });
        appendDiagnosticEvent('managed_ai_batch_auto_failed', {
          provider: activeController.providerId,
          batchId: activeController.activeBatch.id,
          stalledCompanyNos: stalledNos,
        });
        emitClaudeAutomationLog(
          `[自動タイムアウト] ${stalledNos.length}社を error として記録しバッチを進めます: ${stalledNos.join(',')}\n`,
          'warn',
          activeController.providerId,
        );
      }
    }
}

function dispatchNextManagedAiFormFillBatch() {
  const controller = managedAiBatchController;
  if (!controller) return null;
  // v2.0.10: controller.pending が undefined に書き換わる経路は塞いだはずだが
  // 念のため Array.isArray ガード。length アクセスで TypeError を出さない。
  if (!Array.isArray(controller.pending)) controller.pending = [];
  if (controller.activeBatch || controller.pending.length === 0) return null;
  // v2.0.41: error-rate restart の chain 実行中は dispatch を抑止する。
  //   poll loop からの auto-dispatch と chain の最終 dispatch が同時に走ると、
  //   停止直前の PTY に古いバッチを投入してしまう競合が起きるため。
  if (controller.restartingForErrors) return null;
  const next = controller.pending.shift();
  // v2.0.43: 新規セッション (contract 未注入) の最初のバッチかを記録する。
  //   per-company watchdog で +90秒 の grace 期間を持たせるため。
  const sessionState: any = (typeof getManagedAiSessionState === 'function') ? getManagedAiSessionState() : null;
  const isFreshSession = !sessionState || sessionState.contractVersionSent !== MANAGED_AI_CONTRACT_VERSION;
  controller.activeBatch = {
    id: next.id,
    companyNos: next.companies.map((company: any) => Number(company.no)),
    companyNames: next.companies.map((company: any) => company.companyName || company.name || ''),
    companies: next.companies.slice(),
    options: { ...(next.options || {}) },
    startedAt: Date.now(),
    lastProgressAt: Date.now(),
    lastProgressReason: 'queued',
    stallNotified: false,
    isFreshSession,  // v2.0.43: watchdog がこの値を見て grace を加算する
  };
  appendDiagnosticEvent('managed_ai_batch_dispatch', {
    provider: controller.providerId,
    batchId: next.id,
    companyCount: next.companies.length,
    remainingBatchCount: controller.pending.length,
    companyNos: controller.activeBatch.companyNos,
  });
  appendAiRunMetric('managed_ai_batch_dispatch', {
    provider: controller.providerId,
    batchId: next.id,
    companyCount: next.companies.length,
    remainingBatchCount: controller.pending.length,
    companyNos: controller.activeBatch.companyNos,
  });
  emitClaudeAutomationLog(
    `[分割バッチ開始] ${next.companies.length}社を ${getProviderDisplayName(controller.providerId)} CLI に投入します（残り ${controller.pending.length} バッチ）。\n`,
    'system',
    controller.providerId,
  );
  // queueClaudeFormFillInManagedSession は claudePty が null だと throw する。
  // 過去バグ: dispatch 直前に PTY が死んでいた / 自動起動失敗状態だと、
  // activeBatch だけセット → throw → 永久停止 → 47 バッチ滞留。
  // try/catch で activeBatch を巻き戻し、pending の先頭に戻して watchdog に
  // 救済させる (auto-recovery が走るか、ユーザーが手動再起動するまで pending)。
  let result: any = null;
  try {
    result = queueClaudeFormFillInManagedSession(next.companies, controller.providerId, next.options);
  } catch (dispatchError: any) {
    const errMessage = String(dispatchError && dispatchError.message || dispatchError);
    appendDiagnosticEvent('managed_ai_batch_dispatch_failed', {
      provider: controller.providerId,
      batchId: next.id,
      companyCount: next.companies.length,
      error: errMessage.slice(0, 400),
      claudePtyAlive: !!claudePty,
    });
    emitClaudeAutomationLog(
      `[分割バッチ失敗] ${next.companies.length}社の投入に失敗しました: ${errMessage}\n→ pending に戻し、managed AI session の自動復旧を待ちます。\n`,
      'error',
      controller.providerId,
    );
    // pending の先頭に戻す (元の順序を維持)
    controller.pending.unshift(next);
    controller.activeBatch = null;
    // 自動復旧を試みる
    try { tryRecoverManagedAiSession('dispatch-failed'); } catch (_) { /* swallow */ }
    startManagedAiBatchPoller();
    return null;
  }
  startManagedAiBatchPoller();
  return result;
}

async function tryRecoverManagedAiSession(reason = 'unknown') {
  const recovery = managedAiRecoveryState;
  if (!recovery || recovery.inFlight) return false;
  recovery.inFlight = true;
  clearManagedAiRecoveryTimer();
  try {
    const auth: any = await probeClaudeAuthStatus(recovery.providerId);
    if (!auth.installed || !auth.loggedIn) {
      recovery.retries = (recovery.retries || 0) + 1;
      appendDiagnosticEvent('managed_ai_recovery_waiting_auth', {
        provider: recovery.providerId,
        reason,
        retries: recovery.retries,
        installed: !!auth.installed,
        loggedIn: !!auth.loggedIn,
        error: auth.error || null,
      });
      if (recovery.retries >= MANAGED_AI_RECOVERY_MAX_RETRIES) {
        emitClaudeAutomationLog(
          `[AI自動復旧停止] ${getProviderDisplayName(recovery.providerId)} の再ログイン待ちが長引いたため、自動復旧を停止しました。再度「AIを起動」してください。\n`,
          'warn',
          recovery.providerId,
        );
        managedAiRecoveryState = null;
        return false;
      }
      // v2.0.48 F2: 固定 15s × 20 回 (5 分 hammering) を exponential backoff に変更。
      //   一時的なネットワーク揺らぎでも 5 分待たされていたが、初回 15s で復旧する
      //   ケースは早期に拾い、長引いた場合は auth サーバの負荷を減らすため間隔を広げる。
      const retryDelayMs = getManagedAiRecoveryDelayMs(recovery.retries);
      managedAiRecoveryTimer = setTimeout(() => {
        Promise.resolve(tryRecoverManagedAiSession('retry-auth')).catch((e) => {
          console.warn('[recovery] retry-auth rejected:', e && e.message || e);
        });
      }, retryDelayMs);
      if (typeof managedAiRecoveryTimer.unref === 'function') managedAiRecoveryTimer.unref();
      return false;
    }

    appendDiagnosticEvent('managed_ai_recovery_restart', {
      provider: recovery.providerId,
      reason,
      batchCount: recovery.batches.length,
      mode: recovery.mode,
      autoSendSafe: recovery.autoSendSafe,
    });
    await startManagedAiSession(recovery.mode, recovery.providerId, {
      allowReuse: false,
      autoSendSafe: recovery.autoSendSafe,
    });
    restoreManagedAiBatchesFromRecovery(recovery);
    emitClaudeAutomationLog(
      `[AI自動復旧] ${getProviderDisplayName(recovery.providerId)} の再ログイン後に managed セッションを復旧し、残り ${recovery.batches.length} バッチを再開しました。\n`,
      'system',
      recovery.providerId,
    );
    managedAiRecoveryState = null;
    return true;
  } catch (error) {
    recovery.retries = (recovery.retries || 0) + 1;
    appendDiagnosticEvent('managed_ai_recovery_failed', {
      provider: recovery.providerId,
      reason,
      retries: recovery.retries,
      error: String(error && error.message || error),
    });
    if (recovery.retries < MANAGED_AI_RECOVERY_MAX_RETRIES) {
      // v2.0.48 F2: error 経路でも exponential backoff を適用。
      const retryDelayMs = getManagedAiRecoveryDelayMs(recovery.retries);
      managedAiRecoveryTimer = setTimeout(() => {
        tryRecoverManagedAiSession('retry-error');
      }, retryDelayMs);
      if (typeof managedAiRecoveryTimer.unref === 'function') managedAiRecoveryTimer.unref();
    } else {
      managedAiRecoveryState = null;
    }
    return false;
  } finally {
    if (managedAiRecoveryState) managedAiRecoveryState.inFlight = false;
  }
}

async function restartManagedAiSessionForAuthRefresh(providerId = getManagedAiProvider()) {
  const normalizedProviderId = normalizeProviderId(providerId);
  if (!claudePty || getManagedAiProvider() !== normalizedProviderId || !isManagedAiAuthFingerprintStale(normalizedProviderId)) {
    return { restarted: false };
  }
  const recovery = snapshotManagedAiBatchesForRecovery();
  appendDiagnosticEvent('managed_ai_auth_refresh_detected', {
    provider: normalizedProviderId,
    mode: claudeProcessMode,
    autoSendSafe: managedAiAutoSendSafe,
    hasRecoveryBatches: !!(recovery && recovery.batches && recovery.batches.length),
  });
  emitClaudeAutomationLog(
    `[認証状態更新検知] ${getProviderDisplayName(normalizedProviderId)} のログイン状態が変わったため、managed セッションを自動で張り直します。\n`,
    'system',
    normalizedProviderId,
  );
  managedAiRecoveryState = recovery
    ? {
      ...recovery,
      retries: 0,
      inFlight: false,
    }
    : null;
  await stopManagedClaudePty({ suppressAutoRecovery: true });
  if (managedAiRecoveryState) {
    await tryRecoverManagedAiSession('auth-refresh');
  } else {
    await startManagedAiSession(claudeProcessMode || getProvider(normalizedProviderId).defaultMode || 'auto', normalizedProviderId, {
      allowReuse: false,
      autoSendSafe: managedAiAutoSendSafe,
    });
  }
  return { restarted: true };
}

function isHeadlessAutomationProvider(providerId) {
  return ['codex', 'gemini'].includes(normalizeProviderId(providerId));
}

// P1-4: parallel-dispatcher が許可する provider。Claude も含む。
// 既存の単発 headless 経路 (codex/gemini 用 startHeadlessAiAutomationRun) と
// 並列経路 (parallel-dispatcher の runParallelBatch) を別概念として扱う。
function isParallelDispatchProvider(providerId) {
  return ['claude', 'codex', 'gemini'].includes(normalizeProviderId(providerId));
}

function requiresManagedAiSessionForFormFill(providerId) {
  return ['claude', 'codex', 'gemini'].includes(normalizeProviderId(providerId));
}

function getAutomationModeForProvider(providerId) {
  if (claudePty && getManagedAiProvider() === normalizeProviderId(providerId) && claudeProcessMode) {
    return claudeProcessMode;
  }
  return getProvider(providerId).defaultMode || 'auto';
}

function getActiveHeadlessRun(providerId: any = null) {
  if (!headlessAiRun) return null;
  if (!providerId) return headlessAiRun;
  return normalizeProviderId(providerId) === headlessAiRun.provider ? headlessAiRun : null;
}

function getConfiguredAiModel(providerId = getSelectedAiProvider()) {
  try {
    if (typeof settings.getAiModel === 'function') {
      return settings.getAiModel(providerId) || '';
    }
    const prefs = settings.getSection('preferences') || {};
    const models = prefs.aiModels && typeof prefs.aiModels === 'object' ? prefs.aiModels : {};
    const configured = typeof models[providerId] === 'string' ? models[providerId].trim() : '';
    if (configured) return configured;
    if (providerId === 'claude') {
      return typeof prefs.claudeModel === 'string' ? prefs.claudeModel.trim() : '';
    }
    return '';
  } catch (_) {
    return '';
  }
}

function getProviderInstallState(providerId) {
  const key = normalizeProviderId(providerId);
  return aiInstallState[key] || 'idle';
}

function getProviderInstallError(providerId) {
  const key = normalizeProviderId(providerId);
  return aiInstallError[key] || null;
}

function setProviderInstallState(providerId, state, error: any = null) {
  const key = normalizeProviderId(providerId);
  aiInstallState[key] = state;
  aiInstallError[key] = error;
}

function invalidateAiStatusCache(providerId: any = null) {
  _aiCacheGeneration += 1;
  if (!providerId) {
    _aiStatusInFlight.clear();
    _aiDiagnosticsInFlight.clear();
  } else {
    const key = normalizeProviderId(providerId);
    _aiStatusInFlight.delete(key);
    _aiDiagnosticsInFlight.delete(key);
  }
  if (!providerId || _aiStatusCacheProvider === normalizeProviderId(providerId)) {
    _aiStatusCache = null;
    _aiStatusCacheTime = 0;
    _aiStatusCacheProvider = null;
  }
  if (!providerId) {
    _aiDiagnosticsCache.clear();
    return;
  }
  _aiDiagnosticsCache.delete(normalizeProviderId(providerId));
}

function getCodexConfigPath() {
  return path.join(os.homedir(), '.codex', 'config.toml');
}

function getCodexTrustProjectKeys(projectRoot = PROJECT_ROOT) {
  const resolved = path.resolve(projectRoot);
  const keys = [resolved];
  if (process.platform === 'win32' && !resolved.startsWith('\\\\?\\')) {
    keys.unshift(`\\\\?\\${resolved}`);
  }
  return Array.from(new Set(keys));
}

function ensureCodexWorkspaceTrusted(projectRoot = PROJECT_ROOT) {
  const configPath = getCodexConfigPath();
  const trustKeys = getCodexTrustProjectKeys(projectRoot);
  let content = '';
  try {
    if (fs.existsSync(configPath)) {
      content = fs.readFileSync(configPath, 'utf8');
    } else {
      ensureParentDir(configPath);
    }
  } catch (_) {
    return false;
  }

  if (trustKeys.some((key: any) => content.includes(`[projects.'${key.replace(/'/g, "''")}']`))) {
    return false;
  }

  const preferredKey = trustKeys[0];
  const section = [
    '',
    `[projects.'${preferredKey.replace(/'/g, "''")}']`,
    'trust_level = "trusted"',
    '',
  ].join('\n');

  fs.writeFileSync(configPath, `${content.replace(/\s*$/, '')}${section}`, 'utf8');
  return true;
}

function getGeminiTrustedFoldersPath() {
  return path.join(os.homedir(), '.gemini', 'trustedFolders.json');
}

function getGeminiProjectsPath() {
  return path.join(os.homedir(), '.gemini', 'projects.json');
}

function ensureGeminiWorkspaceTrusted(projectRoot = PROJECT_ROOT) {
  const resolvedProjectRoot = path.resolve(projectRoot);
  const trustedFoldersPath = getGeminiTrustedFoldersPath();
  const projectsPath = getGeminiProjectsPath();
  let changed = false;

  try {
    ensureParentDir(trustedFoldersPath);
    const trustedFolders = readJsonFileSafe(trustedFoldersPath, {}) || {};
    if (trustedFolders[resolvedProjectRoot] !== 'TRUST_FOLDER') {
      trustedFolders[resolvedProjectRoot] = 'TRUST_FOLDER';
      fs.writeFileSync(trustedFoldersPath, JSON.stringify(trustedFolders, null, 2), 'utf8');
      changed = true;
    }
  } catch (_) {
    return false;
  }

  try {
    ensureParentDir(projectsPath);
    const projectName = path.basename(resolvedProjectRoot) || 'project';
    const projectsState = readJsonFileSafe(projectsPath, { projects: {} }) || { projects: {} };
    projectsState.projects = projectsState.projects || {};
    const lowerKey = resolvedProjectRoot.toLowerCase();
    if (!projectsState.projects[lowerKey]) {
      projectsState.projects[lowerKey] = projectName;
      fs.writeFileSync(projectsPath, JSON.stringify(projectsState, null, 2), 'utf8');
      changed = true;
    }
  } catch (_) {
    return changed;
  }

  return changed;
}

function isCodexWorkspaceTrusted(projectRoot = PROJECT_ROOT) {
  const configPath = getCodexConfigPath();
  if (!fs.existsSync(configPath)) return false;
  try {
    const content = fs.readFileSync(configPath, 'utf8');
    return getCodexTrustProjectKeys(projectRoot).some((key: any) => content.includes(`[projects.'${key.replace(/'/g, "''")}']`));
  } catch (_) {
    return false;
  }
}

function isGeminiWorkspaceTrusted(projectRoot = PROJECT_ROOT) {
  const resolvedProjectRoot = path.resolve(projectRoot);
  try {
    const trustedFolders = readJsonFileSafe(getGeminiTrustedFoldersPath(), {}) || {};
    const projectsState = readJsonFileSafe(getGeminiProjectsPath(), { projects: {} }) || { projects: {} };
    const projectKeys = Object.keys(projectsState.projects || {});
    return trustedFolders[resolvedProjectRoot] === 'TRUST_FOLDER'
      && projectKeys.includes(resolvedProjectRoot.toLowerCase());
  } catch (_) {
    return false;
  }
}

function copyFileIfExists(sourcePath, targetPath) {
  if (!sourcePath || !targetPath || !fs.existsSync(sourcePath)) return false;
  ensureParentDir(targetPath);
  fs.copyFileSync(sourcePath, targetPath);
  return true;
}

function getManagedProviderHome(providerId) {
  return resolveDataPath(path.join('provider-homes', normalizeProviderId(providerId)));
}

function normalizeProjectConfigKey(projectRoot = PROJECT_ROOT) {
  return path.resolve(projectRoot).replace(/\\/g, '/');
}

function buildManagedClaudeMcpServers(realState: Record<string, any> = {}) {
  // v2.0.75 真因修正: 旧コードは mode 無視で常に playwright を seed していた。
  //   → Sales Claw 起動の度に prepareClaudeManagedHome から呼ばれ、
  //     v2.0.74 の ensureProviderPlaywrightMcp が消した playwright を再 add していた。
  //   → ユーザー実機 2026-05-27 19:30:50 の `.claude.json` で再現確認済。
  //   formFillMode === 'internal' なら playwright を seed せず空 mcpServers を返す
  //   (sales-claw-form は ensureProviderInternalFormMcp が動的登録するため)。
  const mode = getFormFillMode();
  if (mode === 'internal') {
    // v2.0.76 真因修正: 既存 prompt は `mcp__playwright__browser_navigate` 等で
    // tool 名をハードコードしている (dashboard-server.ts:6136, locale-pack/*/cli-prompts.ts)。
    // internal モードでも MCP server 名を 'playwright' で登録すれば prompt 改修不要。
    // 実体は sales-claw-form-mcp.cjs (Electron 内蔵 WebContentsView 経由)。
    const shimPath = findInternalFormMcpShimPath();
    if (!shimPath) return {};
    const ipcPipe = _internalFormMcpIpcPipePath || '';
    return {
      playwright: {
        type: 'stdio',
        command: process.execPath, // Sales Claw.exe (ELECTRON_RUN_AS_NODE で Node 起動)
        args: [shimPath],
        env: {
          ELECTRON_RUN_AS_NODE: '1',
          SALES_CLAW_FORM_IPC_PIPE: ipcPipe,
        },
      },
    };
  }

  const globalMcpServers = (realState && typeof realState === 'object' && realState.mcpServers) || {};
  const existingPlaywright = globalMcpServers.playwright;
  if (!shouldOverridePlaywrightMcpConfig(existingPlaywright)) {
    return { playwright: globalMcpServers.playwright };
  }
  const playwrightMcp = localToolchain.getPlaywrightMcpCommandSpec();
  return {
    playwright: {
      type: 'stdio',
      command: playwrightMcp.command,
      args: playwrightMcp.args,
      env: playwrightMcp.env,
    },
  };
}

function buildManagedClaudeProjectState() {
  return {
    allowedTools: [],
    mcpContextUris: [],
    mcpServers: {},
    enabledMcpjsonServers: [],
    disabledMcpjsonServers: [],
    hasTrustDialogAccepted: true,
    projectOnboardingSeenCount: 1,
    hasClaudeMdExternalIncludesApproved: false,
    hasClaudeMdExternalIncludesWarningShown: false,
  };
}

function extractManagedClaudeProjectState(realState: Record<string, any> = {}, projectKey) {
  const projects = (realState && typeof realState === 'object' && realState.projects) || {};
  const current = (projectKey && projects[projectKey]) || {};
  return {
    ...current,
    ...buildManagedClaudeProjectState(),
  };
}

function prepareClaudeManagedHome(projectRoot = PROJECT_ROOT) {
  const realHome = os.homedir();
  const managedHome = getManagedProviderHome('claude');
  const managedClaudeDir = path.join(managedHome, '.claude');
  const managedAppDataRoaming = path.join(managedHome, 'AppData', 'Roaming');
  const managedAppDataLocal = path.join(managedHome, 'AppData', 'Local');
  const managedTempDir = path.join(managedHome, 'tmp');
  fs.mkdirSync(managedClaudeDir, { recursive: true });
  fs.mkdirSync(managedAppDataRoaming, { recursive: true });
  fs.mkdirSync(managedAppDataLocal, { recursive: true });
  fs.mkdirSync(managedTempDir, { recursive: true });

  // v2.0.50: 認証保持。Sales Claw 内で /login した結果 (managed home 側に保存)
  // を次回起動時に realHome 由来の値で上書きしてしまうバグを修正。
  //   旧仕様: .credentials.json / settings.json / .claude.json を毎回 realHome
  //          から copy/再構築 → managed 内で /login しても次回起動で消える
  //          → ユーザー体験: 「毎回 Please run /login が出る」
  //   新仕様: managed 側に既存 auth/state があれば **それを優先**。
  //          realHome は「初回 seed」のみで使う (managed が空のとき)。
  //          managed 制御項目 (mcpServers / projects / hooks / autoUpdates /
  //          plugins) はこちらが上書きする。
  const managedCredsPath = path.join(managedClaudeDir, '.credentials.json');
  if (!fs.existsSync(managedCredsPath)) {
    copyFileIfExists(path.join(realHome, '.claude', '.credentials.json'), managedCredsPath);
  }
  const managedOmcConfig = path.join(managedClaudeDir, '.omc-config.json');
  if (!fs.existsSync(managedOmcConfig)) {
    copyFileIfExists(path.join(realHome, '.claude', '.omc-config.json'), managedOmcConfig);
  }

  // settings.json: managed 側に書き込まれた hooks/mcpServers 以外の項目 (theme,
  // preferences, model 等) を温存しつつ、Sales Claw が管理する 2 項目だけ上書き。
  const managedSettingsPath = path.join(managedClaudeDir, 'settings.json');
  const managedSettingsExisting = readJsonFileSafe(managedSettingsPath, null);
  const realSettings = readJsonFileSafe(path.join(realHome, '.claude', 'settings.json'), {}) || {};
  const settingsBase = (managedSettingsExisting && typeof managedSettingsExisting === 'object')
    ? managedSettingsExisting
    : realSettings;
  const managedSettings = {
    ...(settingsBase || {}),
    hooks: {},
    mcpServers: {},
  };
  fs.writeFileSync(managedSettingsPath, JSON.stringify(managedSettings, null, 2), 'utf8');

  // .claude.json: oauthAccount / userID / firstStartTime / projects 等が含まれる。
  // managed 側に既存があれば優先 (= /login 後の状態を保持)、なければ realHome から seed。
  const managedStatePath = path.join(managedHome, '.claude.json');
  const managedStateExisting = readJsonFileSafe(managedStatePath, null);
  const realState = readJsonFileSafe(path.join(realHome, '.claude.json'), {}) || {};
  const stateBase = (managedStateExisting && typeof managedStateExisting === 'object')
    ? managedStateExisting
    : realState;
  const projectKey = normalizeProjectConfigKey(projectRoot);
  const baseProjects = (stateBase && typeof stateBase === 'object' && stateBase.projects && typeof stateBase.projects === 'object')
    ? stateBase.projects
    : {};
  const managedState = {
    ...(stateBase || {}),
    autoUpdates: false,
    mcpServers: buildManagedClaudeMcpServers(stateBase),
    projects: {
      ...baseProjects,
      [projectKey]: extractManagedClaudeProjectState(stateBase, projectKey),
    },
    plugins: [],
  };
  delete managedState.prompt;
  fs.writeFileSync(managedStatePath, JSON.stringify(managedState, null, 2), 'utf8');

  // v2.0.78 真因修正: Claude CLI v2.x の user-scope MCP storage は
  //   **inner** `<HOME>/.claude/.claude.json` (= managedClaudeDir/.claude.json)
  //   実機検証 (2026-05-27): `claude mcp add --scope user playwright ...` が
  //   "File modified: ...\.claude\.claude.json" と inner を書く。
  //   root `.claude.json` だけ書いていた v2.0.77 までは Claude が MCP 認識せず
  //   "MCP Playwright tools not available" エラーで停止していた。
  //   inner にも同じ mcpServers を sync 書込する。
  try {
    const innerClaudeJsonPath = path.join(managedClaudeDir, '.claude.json');
    const innerExisting = readJsonFileSafe(innerClaudeJsonPath, {}) || {};
    const innerNext = {
      ...(innerExisting as Record<string, unknown>),
      mcpServers: buildManagedClaudeMcpServers(stateBase),
    };
    fs.writeFileSync(innerClaudeJsonPath, JSON.stringify(innerNext, null, 2), 'utf8');
  } catch (e) {
    // best-effort; ログを残す
    try {
      appendDiagnosticEvent('managed_inner_claude_json_write_failed', {
        error: e instanceof Error ? e.message : String(e),
      });
    } catch (_) { /* swallow */ }
  }

  return managedHome;
}

function prepareGeminiManagedHome(projectRoot = PROJECT_ROOT) {
  const realHome = os.homedir();
  const managedHome = getManagedProviderHome('gemini');
  const managedGeminiDir = path.join(managedHome, '.gemini');
  const managedAppDataRoaming = path.join(managedHome, 'AppData', 'Roaming');
  const managedAppDataLocal = path.join(managedHome, 'AppData', 'Local');
  const managedTempDir = path.join(managedHome, 'tmp');
  fs.mkdirSync(managedGeminiDir, { recursive: true });
  fs.mkdirSync(managedAppDataRoaming, { recursive: true });
  fs.mkdirSync(managedAppDataLocal, { recursive: true });
  fs.mkdirSync(managedTempDir, { recursive: true });

  copyFileIfExists(path.join(realHome, '.gemini', 'oauth_creds.json'), path.join(managedGeminiDir, 'oauth_creds.json'));
  copyFileIfExists(path.join(realHome, '.gemini', 'google_accounts.json'), path.join(managedGeminiDir, 'google_accounts.json'));
  copyFileIfExists(path.join(realHome, '.gemini', 'GEMINI.md'), path.join(managedGeminiDir, 'GEMINI.md'));
  const realSettings = readJsonFileSafe(path.join(realHome, '.gemini', 'settings.json'), {}) || {};
  const playwrightMcp = localToolchain.getPlaywrightMcpCommandSpec();
  const managedSettings = {
    ...realSettings,
    mcpServers: {
      ...((realSettings && realSettings.mcpServers) || {}),
      playwright: {
        command: playwrightMcp.command,
        args: playwrightMcp.args,
        env: playwrightMcp.env,
      },
    },
    security: {
      ...(realSettings.security || {}),
      folderTrust: {
        ...((realSettings.security && realSettings.security.folderTrust) || {}),
        enabled: false,
      },
    },
    general: {
      ...(realSettings.general || {}),
      sessionRetention: {
        ...((realSettings.general && realSettings.general.sessionRetention) || {}),
        enabled: false,
      },
    },
  };
  fs.writeFileSync(path.join(managedGeminiDir, 'settings.json'), JSON.stringify(managedSettings, null, 2), 'utf8');

  const resolvedProjectRoot = path.resolve(projectRoot);
  const projectName = path.basename(resolvedProjectRoot) || 'project';
  fs.writeFileSync(path.join(managedGeminiDir, 'projects.json'), JSON.stringify({
    projects: {
      [resolvedProjectRoot.toLowerCase()]: projectName,
    },
  }, null, 2), 'utf8');
  fs.writeFileSync(path.join(managedGeminiDir, 'trustedFolders.json'), JSON.stringify({
    [resolvedProjectRoot]: 'TRUST_FOLDER',
  }, null, 2), 'utf8');

  return managedHome;
}

function buildManagedProviderEnv(providerId) {
  const normalizedProviderId = normalizeProviderId(providerId);
  // 1.2.91: SALES_CLAW_SESSION env を必ず注入。Phase B prompt 内の curl コマンドが
  // x-sales-claw-session ヘッダで dashboard API を呼び出すため必須。
  let sessionToken = '';
  try { sessionToken = ensureDashboardSessionToken() || dashboardSessionToken || ''; }
  catch (_) { sessionToken = dashboardSessionToken || process.env.SALES_CLAW_SESSION || ''; }

  // 2026-06-15 Programmatic Credit 対応: ANTHROPIC_API_KEY 等の課金リーク env を
  // ベース env から削除する。これにより buildManagedProviderEnv を経由する
  // すべての spawn 経路 (parallel-dispatcher / cli-agent / form-fill / その他)
  // で自動的にサニタイズが効く。
  // localToolchain.buildToolEnv が PATH 等を整える前にリーク env だけ消す。
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { BILLING_LEAK_ENV_KEYS } = require('./spawn-env-sanitizer');
  const sanitizedProcessEnv = { ...process.env };
  for (const k of BILLING_LEAK_ENV_KEYS) {
    delete sanitizedProcessEnv[k];
  }

  // v2.0.9: ダッシュボードの実ポートを env で CLI に渡す。
  // 過去バグ (2026-05-15): ユーザーが「No.70 を送信したのにダッシュボードに残らない」
  // と報告 → 実ポートは 3456 だったが CLAUDE.md と prompt 例は 3765 をハードコード →
  // 全 curl /api/log-action が "Connection refused" でログ消失。
  let dashboardBaseUrl = '';
  try {
    const runtime = dashboardRuntime || readRuntime();
    if (runtime && runtime.url) dashboardBaseUrl = runtime.url;
    else if (server && server.listening) {
      const address: any = server.address();
      if (address && typeof address === 'object') {
        const host = !address.address || address.address === '::' || address.address === '0.0.0.0' ? '127.0.0.1' : address.address;
        dashboardBaseUrl = `http://${host}:${address.port}`;
      }
    }
  } catch (_) { /* swallow — env injection is best-effort */ }

  // v2.1.0 Phase 2d: internal form MCP の IPC pipe path を CLI に渡す。
  // electron-main 側で IPC server を起動した時に setInternalFormMcpIpcPipePath
  // 経由でセットされる。未起動 (= dashboard 単体実行 or formFill.mode='playwright')
  // なら空文字で、MCP server 側が起動時に "未接続" として警告するだけで害なし。
  const ipcPipePath = _internalFormMcpIpcPipePath || '';
  const baseEnv = localToolchain.buildToolEnv({
    ...sanitizedProcessEnv,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    SALES_CLAW_SESSION: sessionToken,
    SALES_CLAW_DASHBOARD_URL: dashboardBaseUrl,
    SALES_CLAW_FORM_IPC_PIPE: ipcPipePath,
  });
  if (normalizedProviderId === 'claude') {
    const managedHome = prepareClaudeManagedHome(PROJECT_ROOT);
    const parsed = path.parse(managedHome);
    const appDataRoaming = path.join(managedHome, 'AppData', 'Roaming');
    const appDataLocal = path.join(managedHome, 'AppData', 'Local');
    const managedTempDir = path.join(managedHome, 'tmp');
    return {
      ...baseEnv,
      HOME: managedHome,
      USERPROFILE: managedHome,
      HOMEDRIVE: parsed.root.replace(/\\$/, ''),
      HOMEPATH: managedHome.slice(parsed.root.length - 1),
      APPDATA: appDataRoaming,
      LOCALAPPDATA: appDataLocal,
      TEMP: managedTempDir,
      TMP: managedTempDir,
      XDG_CONFIG_HOME: managedHome,
      XDG_CACHE_HOME: path.join(managedHome, '.cache'),
      XDG_STATE_HOME: path.join(managedHome, '.state'),
      CLAUDE_CONFIG_DIR: path.join(managedHome, '.claude'),
    };
  }
  if (normalizedProviderId !== 'gemini') {
    return baseEnv;
  }

  const managedHome = prepareGeminiManagedHome(PROJECT_ROOT);
  const parsed = path.parse(managedHome);
  const appDataRoaming = path.join(managedHome, 'AppData', 'Roaming');
  const appDataLocal = path.join(managedHome, 'AppData', 'Local');
  const managedTempDir = path.join(managedHome, 'tmp');
  return {
    ...baseEnv,
    HOME: managedHome,
    USERPROFILE: managedHome,
    HOMEDRIVE: parsed.root.replace(/\\$/, ''),
    HOMEPATH: managedHome.slice(parsed.root.length - 1),
    APPDATA: appDataRoaming,
    LOCALAPPDATA: appDataLocal,
    TEMP: managedTempDir,
    TMP: managedTempDir,
    XDG_CONFIG_HOME: managedHome,
    XDG_CACHE_HOME: path.join(managedHome, '.cache'),
    XDG_STATE_HOME: path.join(managedHome, '.state'),
    GEMINI_CLI_TRUSTED_FOLDERS_PATH: path.join(managedHome, '.gemini', 'trustedFolders.json'),
  };
}

function buildCliCommandSpec(executable, args: any[] = []) {
  const exePath = String(executable || '').trim();
  const extension = path.extname(exePath).toLowerCase();
  if (process.platform === 'win32' && (extension === '.cmd' || extension === '.bat')) {
    // Windows の .cmd/.bat 起動は cmd.exe 経由が必須。引用符の取り扱いが特殊で:
    //  - Node child_process は spaces を含む arg を `"\"…\""` のように \-escape する
    //  - cmd.exe /s は「最初と最後の " を剥がす」ので Node escape と相性最悪
    // Microsoft 推奨パターン: 内側を per-arg 引用、外側をもう一段 " で包み、
    // /s で外側だけ剥がさせる。Node 側は windowsVerbatimArguments で自動 escape を抑止する。
    const quoteCmdArg = (value) => `"${String(value == null ? '' : value).replace(/(["^&|<>()%])/g, '^$1')}"`;
    const inner = [quoteCmdArg(exePath), ...(args || []).map(quoteCmdArg)].join(' ');
    return {
      // child_process.spawn でも 'cmd.exe' が PATH 解決失敗で ENOENT に
      // なるケースを避けるため、SystemRoot 経由で絶対パスを組み立てる。
      command: getWindowsSystemBinary('cmd.exe'),
      args: ['/d', '/s', '/c', `"${inner}"`],
      windowsVerbatimArguments: true,
    };
  }
  if (process.platform === 'win32' && extension === '.ps1') {
    const escapedArgs = (args || []).map((arg: any) => {
      const text = String(arg || '');
      return `'${text.replace(/'/g, "''")}'`;
    });
    return {
      command: getWindowsSystemBinary('WindowsPowerShell\\v1.0\\powershell.exe'),
      args: ['-NoLogo', '-NoProfile', '-Command', ['&', `'${exePath.replace(/'/g, "''")}'`, ...escapedArgs].join(' ')],
    };
  }
  return { command: exePath, args: args || [] };
}

// `cmd.exe` / `powershell.exe` を絶対パスで返す。Electron Sales Claw の
// process.env.Path から System32 が抜け落ちている場合 (起動コンテキストの
// 異常 env / 一部のサービス経由起動など) でも動くように。
// SystemRoot は Windows が常にセットする env なので欠落することはほぼ無い
// が、最後のフォールバックとして C:\\Windows を使う。
function getWindowsSystemBinary(name) {
  if (process.platform !== 'win32') return name;
  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || process.env.windir || 'C:\\Windows';
  return path.join(systemRoot, 'System32', name);
}

async function runProviderCliCommand(providerId, args: any[] = [], options: Record<string, any> = {}) {
  const provider = getProvider(providerId);
  const executable: any = await resolveClaudeExecutable(provider.id);
  if (process.platform === 'win32' && executable === provider.id) {
    return {
      ok: false,
      code: 1,
      stdout: '',
      stderr: `${provider.cliLabel} executable was not found.`,
    };
  }

  const { spawn } = require('child_process');
  const spec = buildCliCommandSpec(executable, args);
  const timeoutMs = Math.max(1000, Number(options.timeout) || 15000);
  const maxBuffer = Math.max(64 * 1024, Number(options.maxBuffer) || 1024 * 1024);

  return await new Promise<any>((resolve) => {
    let child: any = null;
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;

    const append = (current, chunk) => {
      const next = current + String(chunk || '');
      return next.length > maxBuffer ? next.slice(next.length - maxBuffer) : next;
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try { if (child) child.kill(); } catch (_) {}
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    try {
      child = spawn(spec.command, spec.args, {
        cwd: PROJECT_ROOT,
        env: options.env || buildManagedProviderEnv(provider.id),
        windowsHide: true,
        windowsVerbatimArguments: spec.windowsVerbatimArguments === true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      finish({
        ok: false,
        code: null,
        stdout,
        stderr,
        error,
        timedOut: false,
      });
      return;
    }
    // launch の cancel から kill できるよう register。
    // launch 文脈以外 (status probe など) でも register するが、追加コストは
    // Set への 1 entry のみで実害はない。close で必ず remove する。
    if (child) _launchSpawnedChildren.add(child);

    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    child.on('error', (error) => {
      _launchSpawnedChildren.delete(child);
      finish({
        ok: false,
        code: null,
        stdout,
        stderr: stderr || String(error && error.message || error),
        error,
        timedOut,
      });
    });
    child.on('close', (code) => {
      _launchSpawnedChildren.delete(child);
      finish({
        ok: !timedOut && code === 0,
        code,
        stdout,
        stderr: timedOut
          ? (stderr || `Process timed out after ${timeoutMs}ms`)
          : stderr,
        error: timedOut ? new Error(`Process timed out after ${timeoutMs}ms`) : null,
        timedOut,
      });
    });
  });
}

async function ensureProviderPlaywrightMcp(providerId, options: Record<string, any> = {}) {
  const normalized = normalizeProviderId(providerId);
  if (!['claude', 'codex', 'gemini'].includes(normalized)) {
    return { ok: true, required: false };
  }

  const cliOptions = { timeout: 20000, env: options.env || buildManagedProviderEnv(normalized) };
  const playwrightMcp = localToolchain.getPlaywrightMcpCommandSpec();
  const listArgs = normalized === 'gemini' ? ['--debug', 'mcp', 'list'] : ['mcp', 'list'];
  // claude の remove は scope を明示しないと「user scope」の登録が残ったまま、
  // 直後の add が "already exists in user config" で失敗する。
  const removeArgs = normalized === 'gemini'
    ? ['--debug', 'mcp', 'remove', 'playwright']
    : normalized === 'claude'
      ? ['mcp', 'remove', '--scope', 'user', 'playwright']
      : ['mcp', 'remove', 'playwright'];

  // v2.1.0 Bug fix (2026-05-26): formFill.mode === 'internal' なら
  // Playwright MCP は登録しない (登録済なら remove)。
  // 旧コードは mode に関係なく常に Playwright を ensure 登録していたため、
  // ユーザーが internal モードに切替えても Claude が Playwright を見つけて
  // 外部 Chrome を起動し続けていた (実機で確認: 12:08 mcp_playwright_already_exists_accepted)。
  const formFillMode = getFormFillMode();
  if (formFillMode === 'internal') {
    // v2.0.76: buildManagedClaudeMcpServers が internal mode で 'playwright' 名に
    // sales-claw-form-mcp.cjs を seed するため、ここで playwright を remove/add すると
    // その seed を壊してしまう。internal モードでは何もせず早期 return。
    appendDiagnosticEvent('mcp_playwright_skipped_internal_mode', { provider: normalized });
    return { ok: true, required: false, configured: false, skippedReason: 'formFill.mode=internal' };
  }

  const check: any = await runProviderCliCommand(normalized, listArgs, cliOptions);
  const combined = `${check.stdout}\n${check.stderr}`;

  // 旧版は `mcp list` 出力に "playwright" 文字列があれば設定済みと判定して
  // いた。だが過去のインストールが残した壊れたエントリ (例: 旧パスを指す
  // Sales Claw.exe や `npx @playwright/mcp@latest` のような自動 download 系)
  // でも文字列マッチで "OK" になり、PTY 内で "MCP servers failed" が出る。
  // mcp list の表示行から実コマンドパスを抽出して fs.existsSync で実在確認し、
  // 一致しない or 存在しないなら一旦 remove → 再 add で正しい spec に揃える。
  const expectedExe = String(playwrightMcp.command || '').toLowerCase();
  const playwrightLine = combined.split(/\r?\n/).find(l => /^\s*playwright\s*[:=]/i.test(l)) || '';
  let registeredButValid = false;
  if (check.ok && /playwright/i.test(combined)) {
    if (!playwrightLine) {
      // 行構造を読めない CLI バージョンでは present だけで OK とする (互換)
      registeredButValid = true;
    } else {
      const lower = playwrightLine.toLowerCase();
      const exeOk = Boolean(expectedExe) && lower.includes(expectedExe);
      // v2.0.31: dev mode (electron.exe) と installed Sales Claw.exe を
      // 切り替えるたびに registration が stale 判定されて remove+add ループに
      // 入り、launch が 75-90s タイムアウトしていた。
      // playwrightLine 内に有効な electron/sales-claw 実行体パスが含まれ、
      // 引数として渡されている playwright-mcp-wrapper.cjs が実在するなら
      // 動作するので「許容 stale」と判定して再登録しない。
      const looksLikeValidElectron = /sales[\s_-]*claw\.exe|electron\.exe/i.test(playwrightLine);
      const argPaths = (playwrightMcp.args || [])
        .filter((entry: any) => {
          try { return path.isAbsolute(String(entry || '')); } catch (_) { return false; }
        });
      const argsExist = argPaths.length > 0 && argPaths.every((entry: any) => {
        try { return fs.existsSync(entry); } catch (_) { return false; }
      });
      const specPaths = [playwrightMcp.command, ...(playwrightMcp.args || [])]
        .filter((entry: any) => {
          try { return path.isAbsolute(String(entry || '')); } catch (_) { return false; }
        });
      const allPathsExist = specPaths.every((entry: any) => {
        try { return fs.existsSync(entry); } catch (_) { return false; }
      });
      // exe が完全一致 → 確実に OK。
      // exe 不一致でも、registered line が electron/sales-claw を指していて
      // wrapper args が実在するなら "別経路だが動く" として OK 判定。
      registeredButValid = (exeOk && allPathsExist) || (looksLikeValidElectron && argsExist);
      if (!registeredButValid) {
        appendDiagnosticEvent('mcp_playwright_stale_entry', {
          provider: normalized,
          playwrightLine: playwrightLine.trim().slice(0, 400),
          expectedExe,
          allPathsExist,
        });
        try {
          await runProviderCliCommand(normalized, removeArgs, cliOptions);
        } catch (_) { /* ignore — re-add will overwrite anyway */ }
      }
    }
  }
  if (registeredButValid) {
    return { ok: true, required: true, configured: true };
  }
  // 各 CLI で `mcp add` の引数形式が違う:
  //   codex  : `codex mcp add playwright -- <command> <args...>`
  //   gemini : `gemini mcp add playwright <command> <args...>`
  //   claude : `claude mcp add --scope user [-e KEY=val ...] playwright -- <command> <args...>`
  //            (--scope user で全プロジェクトで使える user-scope 登録にする。
  //             local-scope = この cwd のみで有効、を回避)
  let addArgs;
  if (normalized === 'codex') {
    addArgs = ['mcp', 'add', 'playwright', '--', playwrightMcp.command, ...playwrightMcp.args];
  } else if (normalized === 'claude') {
    // claude mcp add の引数順:
    //   `mcp add --scope user <name> [-e KEY=VAL ...] -- <command> <args>`
    // ★ 重要: -e は variadic option なので、name の前に置くと name 文字列を
    //   env として吸い込んでしまう (claude が "Invalid environment variable
    //   format: playwright" と返す)。name を先に配置することで variadic を
    //   安全に確定させる。
    const envFlags: any[] = [];
    if (playwrightMcp.env) {
      for (const [k, v] of Object.entries(playwrightMcp.env)) {
        envFlags.push('-e', `${k}=${v}`);
      }
    }
    addArgs = [
      'mcp', 'add',
      '--scope', 'user',
      'playwright',
      ...envFlags,
      '--',
      playwrightMcp.command,
      ...playwrightMcp.args,
    ];
  } else {
    addArgs = ['--debug', 'mcp', 'add', 'playwright', playwrightMcp.command, ...playwrightMcp.args];
  }

  const { isAlreadyExistsError } = require('./mcp-idempotency');

  const add: any = await runProviderCliCommand(normalized, addArgs, { timeout: 30000, env: cliOptions.env });
  if (!add.ok) {
    // "already exists" / "duplicate" 等の冪等性エラーは success として扱う。
    // 過去にユーザーが手動 registration した、または前回の Sales Claw 起動が
    // 不完全に終了して登録だけ残った、というケースで Phase B が完全停止していた。
    const stderrOut = String(add.stderr || add.stdout || '').trim();
    if (isAlreadyExistsError(stderrOut)) {
      // 念のため list で実在確認 → playwright があれば configured 扱い
      const verifyExisting: any = await runProviderCliCommand(normalized, listArgs, cliOptions);
      const verifyExistingOutput = `${verifyExisting.stdout}\n${verifyExisting.stderr}`;
      if (verifyExisting.ok && /playwright/i.test(verifyExistingOutput)) {
        appendDiagnosticEvent('mcp_playwright_already_exists_accepted', {
          provider: normalized,
          stderr: stderrOut.slice(0, 400),
        });
        return { ok: true, required: true, configured: true, alreadyExists: true };
      }
    }
    const message = `${getProviderDisplayName(normalized)} で MCP Playwright の設定に失敗しました。${stderrOut}`;
    return { ok: false, required: true, configured: false, error: message };
  }

  const verify: any = await runProviderCliCommand(normalized, listArgs, cliOptions);
  const verifyOutput = `${verify.stdout}\n${verify.stderr}`;
  if (verify.ok && /playwright/i.test(verifyOutput)) {
    return { ok: true, required: true, configured: true, added: true };
  }

  return {
    ok: false,
    required: true,
    configured: false,
    error: `${getProviderDisplayName(normalized)} で MCP Playwright の設定確認に失敗しました。`,
  };
}

// v2.1.0 Phase 2d: Internal sales-claw-form MCP server 登録ロジック。
// 設計: docs/architecture/in-app-form-fill.md §1.2, §6.
//
// formFill.mode により以下のように動作:
//   - 'playwright': 既存の sales-claw-form 登録を remove (cleanup) して return
//   - 'internal':   sales-claw-form を ensure register (playwright は別関数で remove する想定)
//   - 'both':       sales-claw-form を ensure register (playwright もそのまま)

/**
 * 内製 sales-claw-form MCP server (Electron 内 WebContentsView を CDP 制御)
 * の Claude/Codex/Gemini への登録を ensure する。
 *
 * IPC pipe path は `_internalFormMcpIpcPipePath` グローバル変数経由で参照
 * (electron-main 側で IPC server start 後にセットする)。
 */
async function ensureProviderInternalFormMcp(providerId, options: Record<string, any> = {}) {
  const normalized = normalizeProviderId(providerId);
  if (!['claude', 'codex', 'gemini'].includes(normalized)) {
    return { ok: true, required: false };
  }
  const mode = getFormFillMode();
  const cliOptions = { timeout: 20000, env: options.env || buildManagedProviderEnv(normalized) };
  const listArgs = normalized === 'gemini' ? ['--debug', 'mcp', 'list'] : ['mcp', 'list'];
  const removeArgs = normalized === 'gemini'
    ? ['--debug', 'mcp', 'remove', 'sales-claw-form']
    : normalized === 'claude'
      ? ['mcp', 'remove', '--scope', 'user', 'sales-claw-form']
      : ['mcp', 'remove', 'sales-claw-form'];

  // playwright モードなら 内製は登録しない (古い登録があれば cleanup)
  // v2.0.76: internal モードも buildManagedClaudeMcpServers が 'playwright' 名で
  // 既に seed しているので、ここでの sales-claw-form 名での add は不要 (重複防止)。
  // 旧 sales-claw-form 名の登録があれば cleanup する。
  if (mode === 'playwright' || mode === 'internal') {
    try {
      const check: any = await runProviderCliCommand(normalized, listArgs, cliOptions);
      const combined = `${check.stdout}\n${check.stderr}`;
      if (check.ok && /sales-claw-form/i.test(combined)) {
        await runProviderCliCommand(normalized, removeArgs, cliOptions);
      }
    } catch (_) { /* cleanup best-effort */ }
    return { ok: true, required: false, configured: false, mode };
  }

  // both モード: ensure register (sales-claw-form 名で別途登録、playwright と並存)
  const shimPath = findInternalFormMcpShimPath();
  if (!shimPath) {
    return {
      ok: false,
      required: true,
      configured: false,
      error: 'sales-claw-form MCP shim (bin/sales-claw-form-mcp.cjs) が見つかりません。',
    };
  }
  const nodeBin = process.execPath; // Electron 同梱の Node でも、system Node でも可

  // 既存登録を確認 → 不正なら remove + add
  const check: any = await runProviderCliCommand(normalized, listArgs, cliOptions);
  const combined = `${check.stdout}\n${check.stderr}`;
  const line = combined.split(/\r?\n/).find(l => /^\s*sales-claw-form\s*[:=]/i.test(l)) || '';
  const { shouldOverrideInternalFormMcpConfig } = require('./mcp-config-helpers');

  let needRegister = true;
  if (check.ok && /sales-claw-form/i.test(combined) && line) {
    const existingFromLine = parseExistingMcpLine(line);
    needRegister = shouldOverrideInternalFormMcpConfig(existingFromLine, process.platform);
    if (!needRegister) {
      return { ok: true, required: true, configured: true, alreadyExists: true, mode };
    }
    try { await runProviderCliCommand(normalized, removeArgs, cliOptions); }
    catch (_) { /* ignore — re-add will overwrite */ }
  }

  // mcp add の引数
  let addArgs;
  const envFlags: string[] = [];
  // IPC pipe path を env として渡す (env が無いと MCP server は connection 失敗で起動)
  if (_internalFormMcpIpcPipePath) {
    envFlags.push('-e', `SALES_CLAW_FORM_IPC_PIPE=${_internalFormMcpIpcPipePath}`);
  }
  if (normalized === 'codex') {
    addArgs = ['mcp', 'add', 'sales-claw-form', '--', nodeBin, shimPath];
  } else if (normalized === 'claude') {
    addArgs = ['mcp', 'add', '--scope', 'user', 'sales-claw-form', ...envFlags, '--', nodeBin, shimPath];
  } else {
    addArgs = ['--debug', 'mcp', 'add', 'sales-claw-form', nodeBin, shimPath];
  }

  const { isAlreadyExistsError } = require('./mcp-idempotency');
  const add: any = await runProviderCliCommand(normalized, addArgs, { timeout: 30000, env: cliOptions.env });
  if (!add.ok) {
    const stderrOut = String(add.stderr || add.stdout || '').trim();
    if (isAlreadyExistsError(stderrOut)) {
      return { ok: true, required: true, configured: true, alreadyExists: true, mode };
    }
    return {
      ok: false,
      required: true,
      configured: false,
      error: `${getProviderDisplayName(normalized)} で MCP sales-claw-form 設定に失敗: ${stderrOut}`,
    };
  }
  return { ok: true, required: true, configured: true, added: true, mode };
}

/** formFill.mode を settings から読む。
 *  v2.1.0 (2026-05-26): フォールバック default を 'internal' に変更。
 *  既存 settings.json に formFill section が無いケースでも Electron 内蔵
 *  WebContentsView モードで動作させる (外部 Chrome を開かない)。
 *  rollback したいユーザーは settings.json::formFill.mode を明示的に
 *  "playwright" にセットすることで旧挙動に戻せる。
 */
function getFormFillMode(): 'playwright' | 'internal' | 'both' {
  try {
    const ff = settings.getSection ? settings.getSection('formFill') : null;
    const m = ff && typeof ff === 'object' ? String((ff as { mode?: string }).mode || '').toLowerCase() : '';
    if (m === 'playwright' || m === 'internal' || m === 'both') return m;
  } catch (_) { /* fall through */ }
  return 'internal';
}

/** bin/sales-claw-form-mcp.cjs の場所を探す */
function findInternalFormMcpShimPath(): string | null {
  const candidates = [
    // dev / source
    path.resolve(__dirname, '..', '..', 'bin', 'sales-claw-form-mcp.cjs'),
    path.resolve(__dirname, '..', 'bin', 'sales-claw-form-mcp.cjs'),
    // packaged Electron (extraResources, Phase 3 で正式対応)
    process.resourcesPath ? path.join(process.resourcesPath, 'bin', 'sales-claw-form-mcp.cjs') : '',
  ].filter(Boolean);
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; }
    catch (_) { /* ignore */ }
  }
  return null;
}

/** `mcp list` 1行から { command, args } を粗く抽出する (best-effort) */
function parseExistingMcpLine(line: string): { command: string; args: string[] } {
  // 例: "sales-claw-form: C:\path\to\node.exe C:\path\to\sales-claw-form-mcp.cjs - ✓ Connected"
  const m = line.match(/^\s*sales-claw-form\s*[:=]\s*(.+?)\s+-\s+/);
  const body = m ? m[1] : line;
  const tokens = body.split(/\s+/).filter(Boolean);
  return { command: tokens[0] || '', args: tokens.slice(1) };
}

/** electron-main 側で IPC server 起動後に setInternalFormMcpIpcPipePath を呼んでセット */
let _internalFormMcpIpcPipePath: string | null = null;
function setInternalFormMcpIpcPipePath(pipePath: string | null): void {
  _internalFormMcpIpcPipePath = pipePath || null;
}

// レガシー: basename のみ (e.g. favicon.png)
// 新規: subpath 対応 (e.g. vendor/fonts/inter.woff2)
function getAssetCandidates(relativePath) {
  // パストラバーサル防止: `..` を含むパスは拒否
  const safe = String(relativePath || '').replace(/\\/g, '/');
  if (safe.includes('..') || safe.startsWith('/') || safe.includes('\0')) return [];
  const normalized = path.posix.normalize(safe);
  if (normalized.startsWith('..') || path.isAbsolute(normalized)) return [];
  const candidates = [
    // dev モード: worktree/assets 配下
    path.join(__dirname, '..', '..', 'assets', normalized),
  ];
  if (process.resourcesPath) {
    // packaged モード: extraResources の resources/assets 配下
    candidates.push(path.join(process.resourcesPath, 'assets', normalized));
  }
  return Array.from(new Set(candidates.map((entry: any) => path.resolve(entry))));
}

const ASSET_MIME_TYPES = {
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};
function assetMimeFor(ext) {
  return ASSET_MIME_TYPES[ext] || 'application/octet-stream';
}

function ensureDashboardSessionToken() {
  if (!dashboardSessionToken) {
    dashboardSessionToken = readPersistedDashboardSessionToken();
    if (!dashboardSessionToken) {
      dashboardSessionToken = crypto.randomBytes(24).toString('hex');
      persistDashboardSessionToken(dashboardSessionToken);
    }
  }
  return dashboardSessionToken;
}

const DASHBOARD_SESSION_COOKIE = 'sales_claw_session';
const DASHBOARD_SESSION_FILE = resolveDataPath('dashboard-session.json');

function readPersistedDashboardSessionToken() {
  try {
    if (!fs.existsSync(DASHBOARD_SESSION_FILE)) return '';
    const raw = JSON.parse(fs.readFileSync(DASHBOARD_SESSION_FILE, 'utf8'));
    const token = typeof raw.token === 'string' ? raw.token.trim() : '';
    return /^[a-f0-9]{48,}$/i.test(token) ? token : '';
  } catch (_) {
    return '';
  }
}

function persistDashboardSessionToken(token) {
  try {
    const dir = path.dirname(DASHBOARD_SESSION_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DASHBOARD_SESSION_FILE, JSON.stringify({
      token,
      updatedAt: new Date().toISOString(),
    }, null, 2), 'utf8');
  } catch (_) {
    // noop
  }
}

function getDashboardSessionCookieName() {
  const runtimePort = dashboardRuntime && dashboardRuntime.port ? dashboardRuntime.port : null;
  const serverAddress = server && typeof server.address === 'function' ? server.address() : null;
  const port = runtimePort
    || (serverAddress && serverAddress.port ? serverAddress.port : null)
    || settings.getPort()
    || 'default';
  const scope = String(port).replace(/[^0-9A-Za-z_-]/g, '') || 'default';
  return `${DASHBOARD_SESSION_COOKIE}_p${scope}`;
}

function buildExpiredDashboardSessionCookie(cookieName) {
  return `${cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

function buildDashboardSessionCookieHeaders() {
  const currentCookieName = getDashboardSessionCookieName();
  const headers = [buildDashboardSessionCookie()];
  if (currentCookieName !== DASHBOARD_SESSION_COOKIE) {
    headers.push(buildExpiredDashboardSessionCookie(DASHBOARD_SESSION_COOKIE));
  }
  return headers;
}

function serializeForInlineScript(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function getDashboardOrigin() {
  const runtime = dashboardRuntime || readRuntime();
  if (runtime && runtime.url) return runtime.url;
  return `http://${settings.getHost()}:${settings.getPort()}`;
}

function normalizeOriginForComparison(originValue) {
  if (!originValue) return null;
  try {
    const parsed = new URL(originValue);
    let hostname = String(parsed.hostname || '').toLowerCase();
    if (hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]') {
      hostname = 'localhost';
    }
    const protocol = String(parsed.protocol || 'http:').toLowerCase();
    const port = parsed.port || (protocol === 'https:' ? '443' : '80');
    return `${protocol}//${hostname}:${port}`;
  } catch (_) {
    return null;
  }
}

function getRequestHostOrigin(req) {
  const hostHeader = Array.isArray(req.headers.host) ? (req.headers.host[0] || '') : (req.headers.host || '');
  if (!hostHeader) return null;
  const protoHeader = Array.isArray(req.headers['x-forwarded-proto'])
    ? (req.headers['x-forwarded-proto'][0] || '')
    : (req.headers['x-forwarded-proto'] || '');
  const protocol = String(protoHeader || 'http').toLowerCase() === 'https' ? 'https' : 'http';
  return normalizeOriginForComparison(`${protocol}://${hostHeader}`);
}

function getAllowedOriginsForRequest(req) {
  const origins = new Set<any>();
  const runtimeOrigin = normalizeOriginForComparison(getDashboardOrigin());
  const requestOrigin = getRequestHostOrigin(req);
  if (runtimeOrigin) origins.add(runtimeOrigin);
  if (requestOrigin) origins.add(requestOrigin);
  return origins;
}

function parseRequestCookies(req) {
  const raw = Array.isArray(req.headers.cookie) ? req.headers.cookie.join(';') : (req.headers.cookie || '');
  return raw.split(';').reduce((acc: any, part: any) => {
    const index = part.indexOf('=');
    if (index <= 0) return acc;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) acc[key] = decodeURIComponent(value || '');
    return acc;
  }, {});
}

function buildDashboardSessionCookie() {
  return `${getDashboardSessionCookieName()}=${encodeURIComponent(ensureDashboardSessionToken())}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${8 * 60 * 60}`;
}

function isAllowedOrigin(req) {
  const allowedOrigins = getAllowedOriginsForRequest(req);
  const originHeader = req.headers.origin;
  if (originHeader) {
    const normalizedOrigin = normalizeOriginForComparison(Array.isArray(originHeader) ? originHeader[0] : originHeader);
    return !!(normalizedOrigin && allowedOrigins.has(normalizedOrigin));
  }

  const refererHeader = Array.isArray(req.headers.referer) ? (req.headers.referer[0] || '') : (req.headers.referer || '');
  if (refererHeader) {
    const normalizedRefererOrigin = normalizeOriginForComparison(refererHeader);
    if (normalizedRefererOrigin && allowedOrigins.has(normalizedRefererOrigin)) {
      return true;
    }
  }

  const secFetchSite = Array.isArray(req.headers['sec-fetch-site'])
    ? (req.headers['sec-fetch-site'][0] || '')
    : (req.headers['sec-fetch-site'] || '');
  if (secFetchSite) {
    const normalized = String(secFetchSite).toLowerCase();
    return normalized === 'same-origin' || normalized === 'same-site' || normalized === 'none';
  }

  return false;
}

function getRequestSessionToken(req) {
  try {
    const requestUrl = new URL(req.url || '/', 'http://127.0.0.1');
    const queryToken = requestUrl.searchParams.get('session');
    if (queryToken) return queryToken;
  } catch (_) {
  }

  const headerToken = req.headers['x-sales-claw-session'];
  if (Array.isArray(headerToken) ? (headerToken[0] || '') : (headerToken || '')) {
    return Array.isArray(headerToken) ? (headerToken[0] || '') : (headerToken || '');
  }

  const cookies = parseRequestCookies(req);
  return cookies[getDashboardSessionCookieName()] || '';
}

function isAuthorizedDashboardRequest(req, options: Record<string, any> = {}) {
  if (demoMode.isDemoMode()) {
    return { ok: true };
  }
  const expectedToken = ensureDashboardSessionToken();
  const providedToken = getRequestSessionToken(req);
  const tokenMatches = !!providedToken && providedToken === expectedToken;
  const allowTokenWithoutOrigin = !!options.allowTokenWithoutOrigin;
  const hasExplicitBrowserOrigin = !!(req && (req.headers.origin || req.headers.referer));

  if (!isAllowedOrigin(req)) {
    if (!(allowTokenWithoutOrigin && tokenMatches && !hasExplicitBrowserOrigin)) {
      return { ok: false, statusCode: 403, error: 'Blocked cross-origin dashboard request.' };
    }
  }

  if (!tokenMatches) {
    return { ok: false, statusCode: 401, error: 'Missing or invalid dashboard session token.' };
  }

  return { ok: true };
}

function rejectUpgradeRequest(socket, statusCode, message) {
  if (!socket || socket.destroyed) return;
  const statusText = statusCode === 403 ? 'Forbidden' : 'Unauthorized';
  socket.write(`HTTP/1.1 ${statusCode} ${statusText}\r\nConnection: close\r\n\r\n${message}`);
  socket.destroy();
}

function getBuildSourceMeta(lang) {
  const isJa = lang === 'ja';
  const map = {
    installed: {
      label: 'INSTALLED',
      title: isJa ? 'インストール済みアプリ' : 'Installed app',
      bg: 'var(--success-container)',
      fg: 'var(--success)',
    },
    development: {
      label: 'DEV',
      title: isJa ? '開発版（自動更新は無効）' : 'Development build (auto-update disabled)',
      bg: 'var(--warning-container)',
      fg: 'var(--warning)',
    },
    'dashboard-only': {
      label: 'DASHBOARD',
      title: isJa ? 'ダッシュボード単体起動（自動更新なし）' : 'Dashboard-only mode (no auto-update)',
      bg: 'var(--surface-high)',
      fg: 'var(--on-surface-variant)',
    },
  };
  return map[APP_BUILD_SOURCE] || {
    label: 'UNKNOWN',
    title: isJa ? '実行元不明' : 'Unknown build source',
    bg: 'var(--surface-high)',
    fg: 'var(--on-surface-variant)',
  };
}

function notifyClients(payload) {
  const body = payload || { type: 'update', time: Date.now() };
  let serialized;
  try { serialized = `data: ${JSON.stringify(body)}\n\n`; } catch (_) { return; }
  for (const res of sseClients) {
    try {
      if (!res.writableEnded) res.write(serialized);
      else sseClients.delete(res);
    } catch (e) {
      try { sseClients.delete(res); } catch (_) {}
    }
  }
}

let debounceTimer: any = null;
function queueClientRefresh(reason, filePath) {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    invalidateDashboardDataCache();
    refreshWatchTargets();
    if (filePath) {
      console.log(`[${new Date().toLocaleTimeString('ja-JP')}] 変更検知: ${path.basename(filePath)}`);
    }
    notifyClients({ type: 'update', reason, time: Date.now() });
  }, 250);
}

function closeWatchers() {
  activeWatchers.forEach(({ watcher }) => watcher.close());
  activeWatchers.clear();
}

// H8 対応: 旧版は appendFileSync で 5 MiB 上限なしに書き込みっぱなしだった。
// 数日のバッチ運用で GB 級まで成長して SSD 圧迫 + appendFileSync 自体が低速化
// していた。log-writer 経由で 5 MiB → .1 に 1 段ローテートする。
const DIAGNOSTIC_LOG_MAX_BYTES = 5 * 1024 * 1024;
const AI_RUN_METRICS_MAX_BYTES = 5 * 1024 * 1024;

function appendDiagnosticEvent(type, payload: Record<string, any> = {}) {
  try {
    ensureDataDir();
    const filePath = resolveDataPath('dashboard-diagnostics.jsonl');
    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      type,
      ...payload,
    });
    logWriter.appendLine(filePath, entry + '\n', { maxBytes: DIAGNOSTIC_LOG_MAX_BYTES });
  } catch (_) {}
}

function getAiRunMetricsFile() {
  return resolveDataPath('ai-run-metrics.jsonl');
}

function appendAiRunMetric(type, payload: Record<string, any> = {}) {
  try {
    ensureDataDir();
    const filePath = getAiRunMetricsFile();
    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      type,
      ...payload,
    });
    logWriter.appendLine(filePath, entry + '\n', { maxBytes: AI_RUN_METRICS_MAX_BYTES });
  } catch (_) {}
}

function estimateTextTokens(text) {
  return Math.max(1, Math.ceil(String(text || '').length / 4));
}

const MANAGED_AI_CONTRACT_VERSION = 1;

function trimOneLineText(value, maxLength = 160) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1)).trim()}…`;
}

function trimMultilineText(value, maxLength = 1200) {
  const text = String(value || '')
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!text) return '';
  if (Number(maxLength) <= 0) return '';
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1)).trim()}…`;
}

function compactMessageForPrompt(message, sender: Record<string, any> = {}, maxLength = 900) {
  const lines = String(message || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line: any) => line.trimEnd());
  while (lines.length > 0 && !lines[0].trim()) lines.shift();
  while (lines.length > 0 && !lines[lines.length - 1].trim()) lines.pop();

  if (lines.length > 0 && /^お世話になります/.test(lines[0].trim())) {
    lines.shift();
  }
  if (lines.length > 0) {
    const introLine = lines[0].trim();
    const senderName = String(sender.name || '').trim();
    const senderCompany = String(sender.companyName || '').trim();
    if (
      (senderName && introLine.includes(senderName))
      || (senderCompany && introLine.includes(senderCompany))
      || /と申します。?$/.test(introLine)
    ) {
      lines.shift();
    }
  }
  while (lines.length > 0 && !lines[0].trim()) lines.shift();

  let signatureIndex = lines.length;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    if (
      /^何卒よろしくお願いいたします/.test(line)
      || /^よろしくお願いいたします/.test(line)
      || /^TEL[:：]/i.test(line)
      || /^MAIL[:：]/i.test(line)
      || (sender.companyName && line.includes(String(sender.companyName).trim()))
      || (sender.name && line.includes(String(sender.name).trim()))
    ) {
      signatureIndex = i;
      break;
    }
  }

  const core = lines.slice(0, signatureIndex).join('\n');
  return trimMultilineText(core, maxLength);
}

function compactMessagePromptForPrompt(promptText, maxLength = 2600) {
  return trimMultilineText(promptText, maxLength);
}

function buildCompactSenderPayload(sender: Record<string, any> = {}) {
  const payload: Record<string, any> = {};
  [
    ['companyName', sender.companyName],
    ['name', sender.name],
    ['nameKana', sender.nameKana],
    ['email', sender.email],
    ['phone', sender.phone],
    ['mobile', sender.mobile],
    ['fax', sender.fax],
    ['title', sender.title],
    ['department', sender.department],
    ['postalCode', sender.postalCode],
    ['address', sender.address],
    ['website', sender.website],
    ['partnerPage', sender.partnerPage],
  ].forEach(([key, value]) => {
    const normalized = String(value || '').trim();
    if (normalized) payload[key] = normalized;
  });
  return payload;
}

function buildCompactApproachPayload(objective = '', guardrails = '') {
  const payload: Record<string, any> = {};
  if (objective) payload.objective = trimOneLineText(objective, 220);
  if (guardrails) payload.guardrails = trimOneLineText(guardrails, 220);
  return payload;
}

function buildTabManagementContractLines() {
  return [
    'SALES_CLAW_TAB_CONTRACT',
    '- 開始時に browser_tabs で既存タブを記録し baselineTabs とする',
    '- 探索で開いた検索結果・候補ページ・会社サイト・周辺ページは workingTabs として追跡する',
    '- 入力済みフォーム / 確認画面 / CAPTCHA / エラー証跡のうち、最後に人間確認へ残す 1 タブだけを finalFormTab とする',
    '- awaiting_approval / error / skipped 直前に browser_tabs を再確認し、baselineTabs と finalFormTab 以外の workingTabs を閉じる',
    '- submitted 後は ss-{No}-sent.png を保存して、その会社の workingTabs を閉じる',
    '- 既存の他社タブ、ユーザーが元から開いていたタブ、baselineTabs は閉じない',
    '- logAction details には finalFormTab URL、閉じたタブ数、残した理由、sentMessage を含める',
    '{"tabContract":"finalFormTabOnly"}',
  ];
}

function buildManagedAiSessionContract(providerId = getManagedAiProvider(), options: Record<string, any> = {}) {
  const provider = getProvider(providerId);
  const autoSendSafe = typeof options.autoSendSafe === 'boolean'
    ? options.autoSendSafe
    : getManagedAiAutoSendSafe();
  return [
    `SALES_CLAW_SESSION_CONTRACT v${MANAGED_AI_CONTRACT_VERSION}`,
    `provider=${provider.id}`,
    `cli=${provider.cliLabel}`,
    `sendPolicy=${autoSendSafe ? 'safe-auto-send' : 'approval-stop'}`,
    'rules:',
    ...buildTabManagementContractLines(),
    '- direct worker / 独自 JS automation は使わない',
    // v2.1.0: internal モード (内蔵 WebContentsView + sales-claw-form MCP) では
    //   Playwright を名指しせず、各社タブは browser_tabs new で開く。window.open は
    //   内蔵タブマネージャに追従しないため 2 社目以降が沈黙する原因になっていた。
    ...(getFormFillMode() === 'playwright'
      ? [
          '- MCP は Playwright のみ使用。別の Web 取得 MCP は使わない',
          '- 1社目のみ browser_navigate 可。2社目以降は browser_evaluate(window.open) + browser_tabs',
        ]
      : [
          '- ブラウザ操作は内蔵ブラウザ MCP (browser_* ツール) のみ使用。別の Web 取得 MCP は使わない',
          '- 各社のタブは browser_tabs({action:"new", url, companyNo}) で開く。window.open は使わない (内蔵ブラウザでは追従しない)',
        ]),
    '- 既存タブを navigate で上書きしない',
    '- CAPTCHA / reCAPTCHA / hCaptcha / Turnstile / ロボチェッカーの画像チャレンジは解かない',
    '- CAPTCHA を見つけたら停止せず、まず可能な限り全フィールドを入力 → ss-{No}-input.png 撮影 → awaiting_approval (人間が CAPTCHA 解いて送信)',
    '- visible な checkbox 型 reCAPTCHA v2 (「私はロボットではありません」) は browser_click で 1 回だけ試行可。画像チャレンジが出たら諦めて awaiting_approval',
    '- CAPTCHA を理由に error にするのは「フォーム自体が表示されない」「CAPTCHA より前に進めない (Cloudflare 等のページゲート)」場合だけ',
    '- 営業NG / 対象外は skipped',
    '- site_analysis が不十分 (サイト本文不足 / URL未設定 / 取得失敗) の会社はフォーム入力せず error/skipped',
    '- awaiting_approval はフォーム入力済み + ss-{No}-input.png 作成済み + sentMessage 付きの場合だけ許可',
    '- form_fill → confirm_reached → awaiting_approval / submitted の順で記録',
    '- 入力項目と本文の社員数・設立年・資本金などは設定にある値だけ使う。推測しない',
    '- ★ 一発入力: browser_fill_form の戻り値 validation.problems (必須未入力/未チェック/ラジオ未選択/形式エラー) が空になってから送信ボタンを押す。送信/確認ボタンは browser_snapshot の buttons 配列 (selector+text, 最有力が先頭) から選んで browser_click する',
    autoSendSafe
      ? '- ★ sendPolicy=safe-auto-send: 全項目の入力に成功し、必須の同意チェックボックスも入れ、確認画面に到達できたら、ためらわず送信ボタン (「送信」「確認」「送信する」「Submit」「同意して送信」等) を browser_click して submitted まで完了させる。送信を止めて awaiting_approval にしてよいのは次の4つだけ: (1) 操作が必要な画像/チェック型 CAPTCHA が残る、(2) 設定に無い値を要求する必須項目があり埋められない、(3) 営業NG/対象外フォーム → skipped、(4) 送信ボタンを押しても確認画面/完了画面に進めない。これ以外の「念のため」「不確実だから」を理由に止めてはいけない'
      : '- 送信は行わず awaiting_approval で止める',
    '- submitted まで進めたら必ず ss-{No}-sent.png を残し、その会社のタブ (セッション) は閉じる',
    '- awaiting_approval / error / skipped は入力済みタブを残す。送れなかったタブは残す',
    '- 同じセッションではこの契約を再説明しない。以後の batch payload だけ実行する',
  ].join('\n');
}

function extractPromptJsonLine(outputText) {
  const lines = String(outputText || '')
    .split(/\r?\n/)
    .map((line: any) => line.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line.startsWith('{') || !line.endsWith('}')) continue;
    try {
      return JSON.parse(line);
    } catch (_) {}
  }
  return null;
}

function summarizePhaseAAnalysisForPrompt(analysis) {
  if (!analysis || typeof analysis !== 'object') return [];
  const lines: any[] = [];
  const businessAreas = Array.isArray(analysis.businessAreas)
    ? analysis.businessAreas.map((entry: any) => trimOneLineText(entry && entry.label)).filter(Boolean).slice(0, 2)
    : [];
  const focusAreas = Array.isArray(analysis.focusAreas)
    ? analysis.focusAreas.map((entry: any) => trimOneLineText(entry)).filter(Boolean).slice(0, 2)
    : [];
  const gaps = Array.isArray(analysis.gaps)
    ? analysis.gaps.map((entry: any) => trimOneLineText(entry && entry.strength && entry.strength.label)).filter(Boolean).slice(0, 2)
    : [];
  const patterns = Array.isArray(analysis.relevantPatterns)
    ? analysis.relevantPatterns.map((entry: any) => trimOneLineText(entry && (entry.partner || entry.type || entry.proof))).filter(Boolean).slice(0, 1)
    : [];

  if (businessAreas.length > 0) lines.push(`- 事業領域: ${businessAreas.join(' / ')}`);
  if (focusAreas.length > 0) lines.push(`- 注力/状況: ${focusAreas.join(' / ')}`);
  if (gaps.length > 0) lines.push(`- 提案軸: ${gaps.join(' / ')}`);
  if (patterns.length > 0) lines.push(`- 近い支援実績: ${patterns.join(' / ')}`);
  if (analysis.analysisMode) lines.push(`- 分析モード: ${trimOneLineText(analysis.analysisMode, 40)}`);
  return lines;
}

function watchTarget(targetPath, mode) {
  if (!targetPath) return;

  const resolvedPath = path.resolve(targetPath);
  const effectiveMode = mode || (fs.existsSync(resolvedPath) && fs.lstatSync(resolvedPath).isDirectory() ? 'dir' : 'file');
  const watchedPath = effectiveMode === 'dir'
    ? resolvedPath
    : (fs.existsSync(resolvedPath) ? resolvedPath : path.dirname(resolvedPath));
  const key = `${effectiveMode}:${resolvedPath}`;
  if (activeWatchers.has(key)) return;

  try {
    if (effectiveMode === 'dir' && !fs.existsSync(watchedPath)) {
      fs.mkdirSync(watchedPath, { recursive: true });
    }

    const watcher = fs.watch(watchedPath, (_, changedName) => {
      if (effectiveMode === 'file' && watchedPath !== resolvedPath && changedName) {
        if (String(changedName) !== path.basename(resolvedPath)) return;
      }
      queueClientRefresh(effectiveMode === 'dir' ? 'directory-change' : 'file-change', resolvedPath);
    });

    activeWatchers.set(key, { watcher, watchedPath });
    const __sl = settings.getSection('preferences').language || 'ja';
    console.log(`  ${i18nT(__sl, 'startup.watching')}: ${path.basename(resolvedPath)}`);
  } catch (e) {
    const __sl = settings.getSection('preferences').language || 'ja';
    console.log(`  ${i18nT(__sl, 'startup.watchFailed')}: ${path.basename(resolvedPath)} (${e.message})`);
  }
}

function refreshWatchTargets() {
  const desired = new Map<any, any>();
  const screenshotDir = settings.getScreenshotDir();
  const targetPath = settings.getTargetListPath();
  const settingsPaths = getSettingsFiles();

  [
    { path: getLogFile(), mode: 'file' },
    { path: getContactHistoryFile(), mode: 'file' },
    { path: getOutreachTargetsFile(), mode: 'file' },
    { path: getLiveMonitorFile(), mode: 'file' },
    { path: screenshotDir, mode: 'dir' },
    ...settingsPaths.map((settingsPath: any) => ({ path: settingsPath, mode: 'file' })),
    ...(targetPath ? [{ path: targetPath, mode: 'file' }] : []),
  ].forEach((entry: any) => {
    if (!entry.path) return;
    desired.set(`${entry.mode}:${path.resolve(entry.path)}`, entry);
  });

  activeWatchers.forEach((value, key) => {
    if (!desired.has(key)) {
      value.watcher.close();
      activeWatchers.delete(key);
    }
  });

  desired.forEach((entry: any) => watchTarget(entry.path, entry.mode));
}

function startHeartbeat() {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    // notifyClients と同じ防御: 切断済みクライアントへの write 例外で
    //   setInterval ごと落ちる (uncaughtException) のを防ぎ、dead client を回収する
    for (const res of sseClients) {
      try {
        if (!(res as any).writableEnded) (res as any).write(': heartbeat\n\n');
        else sseClients.delete(res);
      } catch (_) {
        try { sseClients.delete(res); } catch (_) { /* no-op */ }
      }
    }
  }, 15000);
  if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();
}

function getLatestLog(logs, action) {
  for (let i = logs.length - 1; i >= 0; i -= 1) {
    if (logs[i].action === action) return logs[i];
  }
  return null;
}

/**
 * v2.0.18: 1 度の reverse scan で複数 action の latest を一括取得する。
 * 旧コード: getLatestLog を 6 回呼ぶ → 6 × logs.length 回スキャン。
 * 新: 1 × logs.length で全部揃う (6 倍速)。
 * 100-371 社規模で loadData のホットパスを大幅短縮する。
 */
function getLatestActionLogs(logs: any[], actions: string[]): Record<string, any> {
  const result: Record<string, any> = {};
  const wanted = new Set(actions);
  let remaining = actions.length;
  for (let i = logs.length - 1; i >= 0 && remaining > 0; i -= 1) {
    const a = logs[i].action;
    if (wanted.has(a) && !result[a]) {
      result[a] = logs[i];
      remaining -= 1;
    }
  }
  return result;
}

function stringifyLogDetails(details) {
  if (details === undefined || details === null) return '';
  if (typeof details === 'string') return details.trim();
  if (typeof details === 'object') {
    const candidates = ['message', 'body', 'detail', 'text', 'content'];
    for (const key of candidates) {
      const value = typeof details[key] === 'string' ? details[key].trim() : '';
      if (value) return value;
    }
    try {
      return JSON.stringify(details);
    } catch (_) {
      return String(details);
    }
  }
  return String(details).trim();
}

function isUsefulDraftMessage(text) {
  const normalized = stringifyLogDetails(text);
  if (!normalized) return false;
  if (normalized.length < 40) return false;
  if (/^メッセージ生成完了$/i.test(normalized)) return false;
  if (/^message draft ready$/i.test(normalized)) return false;
  if (/^(入力完了|全フィールド入力完了)/.test(normalized)) return false;
  return true;
}

function getDisplayDraftMessage(logs, contactHist) {
  const r = getDisplayDraftMessageWithSource(logs, contactHist);
  return r ? r.message : null;
}

/**
 * 1.2.100 P0: 「ダッシュボード表示 ≠ 実送信内容」の乖離を解消する。
 * 旧: message_draft (Phase A の templateDraft) を最優先 → CLI が WebSearch 後に
 *     縮退本文を入力したケースで「templateDraft 表示 ≠ 実送信」事故が発生。
 * 新: awaiting_approval / submitted の details.sentMessage が存在すれば最優先。
 *     CLI が実フォームに入力した本文をそのまま表示する。
 *     無ければ contactHistory → message_draft の順でフォールバック。
 *     source を返して UI 側で警告バッジを出せるようにする。
 * @returns {null | { message: string, source: 'logged_actual'|'history'|'template_draft_fallback' }}
 */
function getDisplayDraftMessageWithSource(logs, contactHist) {
  for (let i = (logs || []).length - 1; i >= 0; i -= 1) {
    const log = logs[i];
    if (log.action !== 'awaiting_approval' && log.action !== 'submitted' && log.action !== 'form_fill') continue;
    let details = log.details;
    if (typeof details === 'string') {
      try { details = JSON.parse(details); } catch (_) { details = null; }
    }
    if (details && typeof details === 'object') {
      const candidates = [details.sentMessage, details.actualBody, details.body, details.message];
      for (const cand of candidates) {
        if (typeof cand === 'string' && cand.trim().length >= 30) {
          return { message: cand.trim(), source: 'logged_actual' };
        }
      }
    }
  }

  if (contactHist && Array.isArray(contactHist.contacts) && contactHist.contacts.length > 0) {
    const latest = contactHist.contacts[contactHist.contacts.length - 1];
    const historyMessage = latest && typeof latest.message === 'string' ? latest.message.trim() : '';
    if (historyMessage) return { message: historyMessage, source: 'history' };
  }

  const draftLogs = (logs || []).filter((log: any) => log.action === 'message_draft');
  for (let i = draftLogs.length - 1; i >= 0; i -= 1) {
    const draftText = stringifyLogDetails(draftLogs[i].details);
    if (isUsefulDraftMessage(draftText)) return { message: draftText, source: 'template_draft_fallback' };
  }

  return null;
}

function truncateUiText(value, maxLength = 120) {
  const text = stringifyLogDetails(value);
  if (!text) return '';
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function getLatestLogDetail(logs, action) {
  const entry = getLatestLog(logs || [], action);
  return entry ? stringifyLogDetails(entry.details) : '';
}

function getCompanyProgressSearchTokens(company) {
  const tokens = [
    company.lastAction || '',
    company.progress || '',
    company.type || '',
    company.name || '',
    company.formUrl || '',
    company.url || '',
    company.sentMessage || '',
    company.manualReviewReason || '',
    company.lastErrorDetail || '',
    company.lastActionDetail || '',
  ];
  return tokens
    .map((value: any) => String(value || '').trim().toLowerCase())
    .filter(Boolean)
    .join(' ');
}

function buildOperationalIssues(targetData, runtime) {
  const lang = settings.getSection('preferences').language || 'ja';
  const issues: any[] = [];
  const sender = settings.getSender();

  if (!settings.isConfigured()) {
    issues.push(lang === 'ja'
      ? '自社情報が未設定です。Settings で会社情報を入力してください。'
      : 'Company profile is incomplete. Open Settings and fill in your sender information.');
  }

  if (sender.email && /example\.com|demo/i.test(sender.email)) {
    issues.push(lang === 'ja'
      ? 'サンプル設定が読み込まれています。公開利用前に Settings で自社情報へ置き換えてください。'
      : 'Sample settings are active. Replace them with your real company information before production use.');
  }

  if (!targetData.ok) {
    issues.push(lang === 'ja'
      ? `ターゲットリスト未準備: ${targetData.error}`
      : `Target list is not ready: ${targetData.error}`);
  }

  if (runtime && runtime.preferredPort && runtime.port !== runtime.preferredPort) {
    issues.push(lang === 'ja'
      ? `設定ポート ${runtime.preferredPort} は使用中のため、現在は ${runtime.port} 番で起動しています。`
      : `Preferred port ${runtime.preferredPort} was busy, so the dashboard is currently running on port ${runtime.port}.`);
  }

  return issues;
}

function getUiLang() {
  try {
    return settings.getSection('preferences').language || 'ja';
  } catch (_) {
    return 'ja';
  }
}

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function waitForManagedPtyExit(targetPty, timeoutMs = 7000) {
  return new Promise<any>((resolve) => {
    if (!targetPty || claudePty !== targetPty) {
      resolve(true);
      return;
    }

    const start = Date.now();
    const timer = setInterval(() => {
      if (claudePty !== targetPty) {
        clearInterval(timer);
        resolve(true);
        return;
      }
      if (Date.now() - start >= timeoutMs) {
        clearInterval(timer);
        resolve(false);
      }
    }, 100);

    if (typeof timer.unref === 'function') timer.unref();
  });
}

async function forceKillManagedPty(targetPty) {
  if (!targetPty) return false;

  if (process.platform === 'win32' && Number.isFinite(targetPty.pid) && targetPty.pid > 0) {
    const result: any = await execCommand(`taskkill /PID ${targetPty.pid} /T /F`, { timeout: 5000 });
    return !result.error;
  }

  try {
    targetPty.kill();
    return true;
  } catch (_) {
    return false;
  }
}

async function stopManagedClaudePty(options: Record<string, any> = {}) {
  const targetPty = claudePty;
  const userInitiated = !!options.suppressAutoRecovery;
  // v2.0.17: ユーザー明示停止 = キュー完全クリア を契約として固定。
  // 過去事故 (繰り返し報告): 200 社キュー投入 → AI 停止 → 再起動 → 「既に処理中
  // です: 株式会社○○」エラーで再キュー不可。原因は controller.pending が
  // 停止後も残っていたこと。停止 = リセット に統一して二度と起こさない。
  //
  // 注意: suppressAutoRecovery=false (内部的な再起動 / 自動 recovery) では
  // キューを保持する (復旧後に再開するため)。明示停止のときだけ wipe する。
  let queueClearStats: { activeCleared: boolean; pendingCleared: number } | null = null;
  if (userInitiated) {
    const controller: any = managedAiBatchController;
    const pendingCount = controller && Array.isArray(controller.pending) ? controller.pending.length : 0;
    const hadActive = !!(controller && controller.activeBatch);
    if (controller) {
      controller.pending = [];
      controller.activeBatch = null;
      controller.pendingSinceMs = 0;
      controller.queueStuckNotified = false;
    }
    try { clearRecoverySnapshot(); } catch (_) { /* swallow */ }
    // v2.0.42: force=true で PTY 生存中でも live-monitor の非terminal event を
    //   強制 finish する。これをやらないと再キュー時に「既に処理中」エラーで弾かれる。
    cleanupStaleManagedAiMonitorEvents(0, { force: true });
    stopPowerSaveBlockerIfActive();
    // v2.0.64: ユーザー明示停止時のみ AI ステータスキャッシュを無効化する。
    //   (自動 recovery / 内部 restart では cache を保持して再 probe surge を避ける)
    // 旧バグ: stop 直後の状態が _aiStatusCache / _aiDiagnosticsCache に
    //   "loggedIn:true, mcpReady:true" のまま 15-30s 残り、その間に再起動
    //   しようとすると stale なキャッシュを根拠に「準備済」と判定し、しかし
    //   実際の PTY は死んでいるため Playwright MCP 確認で「未準備」エラーを
    //   出す不安定状態に陥っていた。明示停止 = キャッシュ全 wipe で統一する。
    try { invalidateAiStatusCache(getManagedAiProvider() || null); } catch (_) { /* swallow */ }
    queueClearStats = { activeCleared: hadActive, pendingCleared: pendingCount };
    if (pendingCount > 0 || hadActive) {
      appendDiagnosticEvent('managed_ai_stop_cleared_queue', {
        pendingCleared: pendingCount,
        activeCleared: hadActive,
      });
      emitClaudeAutomationLog(
        `[AI停止] キューもクリアしました (pending=${pendingCount}, active=${hadActive ? 1 : 0})。新しい実行は通常通り投入できます。\n`,
        'system',
        getManagedAiProvider() || 'claude',
      );
    }
  }
  if (!targetPty) {
    return {
      ok: true,
      stopped: false,
      method: 'noop',
      ...(queueClearStats ? { queueCleared: queueClearStats } : {}),
    };
  }
  managedAiSuppressAutoRecovery = userInitiated;

  const providerId = getManagedAiProvider();
  const gracefulInput = providerId === 'claude' ? 'exit\r' : '\u0003';
  const gracefulTimeoutMs = providerId === 'claude' ? 7000 : 2000;
  const forcedTimeoutMs = providerId === 'claude' ? 4000 : 2000;

  try {
    targetPty.write(gracefulInput);
  } catch (_) {}

  if (await waitForManagedPtyExit(targetPty, gracefulTimeoutMs)) {
    return {
      ok: true,
      stopped: true,
      method: providerId === 'claude' ? 'exit' : 'interrupt',
      ...(queueClearStats ? { queueCleared: queueClearStats } : {}),
    };
  }

  const forced: any = await forceKillManagedPty(targetPty);
  if (await waitForManagedPtyExit(targetPty, forcedTimeoutMs)) {
    return {
      ok: true,
      stopped: true,
      method: process.platform === 'win32' ? 'taskkill' : 'kill',
      forced,
      ...(queueClearStats ? { queueCleared: queueClearStats } : {}),
    };
  }

  return {
    ok: false,
    stopped: false,
    method: process.platform === 'win32' ? 'taskkill' : 'kill',
    forced,
    error: 'Managed AI process did not exit in time.',
    ...(queueClearStats ? { queueCleared: queueClearStats } : {}),
  };
}

function getHeadlessRunStatus(providerId = getSelectedAiProvider()) {
  const run = getActiveHeadlessRun(providerId);
  if (!run) return null;
  return {
    provider: run.provider,
    providerLabel: getProviderDisplayName(run.provider),
    running: true,
    managed: false,
    headless: true,
    mode: run.mode,
    promptFile: run.promptFile,
    runLogFile: run.logFile,
    startedAt: run.startedAt,
  };
}

function createHeadlessAiLogFile(providerId: string, slotIdx?: number) {
  ensureDataDir();
  // Slot 単位で別ファイルにする (P1-4 並列実行で 3 本同時起動するため
  // タイムスタンプ衝突を避ける)。slotIdx 未指定時は従来互換。
  const slotSuffix = (slotIdx !== undefined && slotIdx !== null && (slotIdx as any) !== '')
    ? `-slot${slotIdx}`
    : '';
  const filePath = resolveDataPath(path.join('ai-runs',
    `${normalizeProviderId(providerId)}-${Date.now()}${slotSuffix}.log`));
  ensureParentDir(filePath);
  fs.writeFileSync(filePath, '', 'utf8');
  return filePath;
}

// H8 対応: headless AI run ログも上限なしで書き込まれていた。
// 1 run あたり数百 MB に届くケースがあるので 10 MiB → .1 ローテート。
const HEADLESS_AI_LOG_MAX_BYTES = 10 * 1024 * 1024;

function appendHeadlessAiLog(filePath, stream, text) {
  if (!filePath || !text) return;
  try {
    ensureParentDir(filePath);
    const line = `[${new Date().toISOString()}] [${stream}] ${String(text)}`;
    logWriter.appendLine(filePath, line, { maxBytes: HEADLESS_AI_LOG_MAX_BYTES });
  } catch (_) {}
}

async function stopHeadlessAiRun(providerId: any = null) {
  const run = getActiveHeadlessRun(providerId);
  if (!run) {
    return { ok: true, stopped: false, method: 'noop' };
  }

  const child = run.child;
  const pid = child && Number.isFinite(child.pid) ? child.pid : null;
  let stopped = false;

  if (pid && process.platform === 'win32') {
    const result: any = await execCommand(`taskkill /PID ${pid} /T /F`, { timeout: 5000 });
    stopped = !result.error;
  } else if (child && typeof child.kill === 'function') {
    try {
      stopped = child.kill('SIGTERM');
    } catch (_) {
      stopped = false;
    }
  }

  await new Promise<any>((resolve) => setTimeout(resolve, 500));
  if (headlessAiRun === run) {
    headlessAiRun = null;
    invalidateAiStatusCache(run.provider);
  }

  return {
    ok: true,
    stopped: !!stopped,
    method: process.platform === 'win32' ? 'taskkill' : 'kill',
    provider: run.provider,
  };
}

function companyHasLogSince(companyNo, startedAtMs) {
  return getAllLogs().some((entry: any) => {
    if (String(entry.companyNo) !== String(companyNo)) return false;
    const timestampMs = Date.parse(entry.timestamp || '');
    return Number.isFinite(timestampMs) && timestampMs >= startedAtMs;
  });
}

function companyHasTerminalLogSince(companyNo, startedAtMs) {
  const terminalActions = new Set(['awaiting_approval', 'submitted', 'skipped', 'error']);
  return getAllLogs().some((entry: any) => {
    if (String(entry.companyNo) !== String(companyNo)) return false;
    if (!terminalActions.has(String(entry.action || '').trim())) return false;
    const timestampMs = Date.parse(entry.timestamp || '');
    return Number.isFinite(timestampMs) && timestampMs >= startedAtMs;
  });
}

function markParallelCompaniesFailed(companies, reason, meta: Record<string, any> = {}) {
  const safeReason = trimOneLineText(reason || 'parallel headless automation failed', 220);
  const providerId = normalizeProviderId(meta.providerId || getSelectedAiProvider());
  (Array.isArray(companies) ? companies : []).forEach((company: any) => {
    if (!company || company.no == null) return;
    if (companyHasTerminalLogSince(company.no, Number(meta.startedAtMs) || 0)) return;
    const companyName = company.companyName || company.name || '';
    logAction(company.no, companyName, 'error', {
      source: `${providerId}-parallel-headless`,
      action: 'error',
      detail: safeReason,
      slotIdx: Number.isFinite(Number(meta.slotIdx)) ? Number(meta.slotIdx) : null,
      promptFile: meta.promptFile || null,
      runLogFile: meta.logFile || null,
      provider: providerId,
      exitCode: meta.exitCode == null ? null : meta.exitCode,
      signal: meta.signal || null,
    });
    finishLiveMonitor(company.no, {
      source: `${providerId}-parallel-headless`,
      companyNo: company.no,
      companyName,
      status: 'error',
      step: safeReason,
      currentUrl: company.formUrl || company.url || '',
    });
  });
}

function deriveHeadlessFailureReason(run, exitCode, signal) {
  const providerLabel = getProviderDisplayName(run.provider);
  const text = String(run.recentOutput || '');
  if (/usage limit/i.test(text)) {
    return `${providerLabel} の利用上限に達しており、今回の自動実行を開始できませんでした。`;
  }
  if (/CreateProcessAsUserW failed: 5/i.test(text) || /windows sandbox/i.test(text)) {
    return `${providerLabel} の Windows sandbox 実行で shell が失敗しました。headless no-approval 実行でもローカルコマンドを開始できていません。`;
  }
  if (/user cancelled MCP tool call/i.test(text)) {
    return `${providerLabel} が MCP Playwright の操作をキャンセルしました。権限・実行モード・provider 側の自動実行設定を確認してください。`;
  }
  if (/Not enough arguments following: p/i.test(text)) {
    return `${providerLabel} の headless prompt 引数が不正でした。`;
  }
  return exitCode === 0
    ? `${providerLabel} headless automation finished without processing the queued company.`
    : `${providerLabel} headless automation exited early (code=${exitCode}, signal=${signal || 'none'}).`;
}

function markHeadlessAutomationFailure(run, exitCode, signal) {
  const providerLabel = getProviderDisplayName(run.provider);
  const reason = deriveHeadlessFailureReason(run, exitCode, signal);

  (run.companies || []).forEach((company: any) => {
    if (companyHasLogSince(company.no, run.startedAtMs)) return;
    logAction(company.no, company.companyName || company.name || '', 'error', {
      source: `${run.provider}-headless`,
      action: 'error',
      detail: reason,
      promptFile: run.promptFile,
      runLogFile: run.logFile,
      provider: run.provider,
      exitCode,
      signal: signal || null,
    });
    finishLiveMonitor(company.no, {
      source: `${run.provider}-headless`,
      companyNo: company.no,
      companyName: company.companyName || company.name || '',
      status: 'error',
      step: providerLabel + ' headless automation failed',
      currentUrl: company.formUrl || company.url || '',
    });
  });
}

async function startHeadlessAiAutomationRun(companies, providerId = getSelectedAiProvider()) {
  const normalizedProviderId = normalizeProviderId(providerId);
  if (!isHeadlessAutomationProvider(normalizedProviderId)) {
    throw new Error(`${getProviderDisplayName(normalizedProviderId)} does not support headless automation routing.`);
  }
  if (headlessAiRun) {
    throw new Error(`${getProviderDisplayName(headlessAiRun.provider)} の headless automation がまだ実行中です。完了を待つか停止してください。`);
  }

  const provider = getProvider(normalizedProviderId);
  const sender = settings.getSender();
  const promptText = buildClaudeFormFillPrompt(companies, sender, normalizedProviderId);
  const promptFile = writeWorkspaceClaudeFormFillPromptFile(companies, promptText, normalizedProviderId);
  const model = getClaudeAutomationModel(normalizedProviderId);
  // v2.1.0: ブラウザ自動化 MCP はモードで異なる (internal=内蔵 / playwright=外部)。
  //   tool 名 (browser_*) は両モードでミラーされるため特定 MCP を名指ししない。
  const kickoffPrompt = [
    `次の指示ファイルを読んで、その内容を実行してください: ${promptFile}`,
    `必ず ${provider.cliLabel} と利用可能なブラウザ自動化 MCP (browser_* ツール) を使って進めてください。`,
    'リポジトリ内の direct worker / 独自 JS automation は使わないでください。',
    '送信は行わず、確認待ちまでで止め、フォームタブは閉じないでください。',
  ].join('\n');
  const invocationPrompt = normalizedProviderId === 'gemini'
    ? '以下に stdin で渡す Sales Claw automation instructions を、その場で実行してください。要約だけで終わらず、実際にツールを呼び出して処理してください。'
    : '';
  const stdinPrompt = normalizedProviderId === 'gemini' ? promptText : promptText;
  const automationMode = getAutomationModeForProvider(normalizedProviderId);
  const headlessSpec = buildHeadlessArgs(normalizedProviderId, automationMode, {
    model,
    cwd: PROJECT_ROOT,
    prompt: invocationPrompt,
  });
  const executable: any = await resolveClaudeExecutable(normalizedProviderId);
  if (process.platform === 'win32' && executable === provider.id) {
    throw new Error(`${provider.cliLabel} が未インストールです。ダッシュボードの「AI CLI を準備」ボタンでセットアップしてください。`);
  }
  const spawnSpec = buildCliCommandSpec(executable, headlessSpec.args);
  const logFile = createHeadlessAiLogFile(normalizedProviderId);
  const { spawn } = require('child_process');
  const child = spawn(spawnSpec.command, spawnSpec.args, {
    cwd: PROJECT_ROOT,
    env: buildManagedProviderEnv(normalizedProviderId),
    windowsHide: true,
    windowsVerbatimArguments: spawnSpec.windowsVerbatimArguments === true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const run = {
    provider: normalizedProviderId,
    mode: `headless-${headlessSpec.effectiveMode}`,
    child,
    promptFile,
    logFile,
    companies: companies.map((company: any) => ({ ...company })),
    startedAt: new Date().toISOString(),
    startedAtMs: Date.now(),
    recentOutput: '',
  };
  headlessAiRun = run;
  invalidateAiStatusCache(normalizedProviderId);

  const targets = companies.map((company: any) => ({
    companyNo: company.no,
    companyName: company.companyName || company.name || '',
  }));
  setTargets(targets, true);

  companies.forEach((company: any) => {
    updateLiveMonitor(company.no, {
      source: `${provider.id}-headless`,
      companyNo: company.no,
      companyName: company.companyName || company.name || '',
      status: 'queued',
      step: `${provider.displayName} headless CLI に作業指示を送信`,
      currentUrl: company.formUrl || company.url || '',
    });
  });

  emitClaudeAutomationLog(`[AIフォーム入力開始] ${companies.length}社の処理を ${provider.displayName} headless CLI に依頼しました。\n`, 'system', normalizedProviderId);
  emitClaudeAutomationLog(`[Prompt file] ${promptFile}\n`, 'system', normalizedProviderId);
  emitClaudeAutomationLog(`[Run log] ${logFile}\n`, 'system', normalizedProviderId);
  appendHeadlessAiLog(logFile, 'system', `[start] provider=${normalizedProviderId} mode=${run.mode} promptFile=${promptFile}\n`);

  child.stdout.on('data', (chunk) => {
    run.recentOutput = `${run.recentOutput || ''}${String(chunk)}`.slice(-12000);
    appendHeadlessAiLog(logFile, 'stdout', chunk);
    emitClaudeAutomationLog(String(chunk), 'stdout', normalizedProviderId);
  });
  child.stderr.on('data', (chunk) => {
    run.recentOutput = `${run.recentOutput || ''}${String(chunk)}`.slice(-12000);
    appendHeadlessAiLog(logFile, 'stderr', chunk);
    emitClaudeAutomationLog(String(chunk), 'stderr', normalizedProviderId);
  });
  child.on('error', (error) => {
    appendHeadlessAiLog(logFile, 'error', `${error.message}\n`);
    appendDiagnosticEvent('headless_ai_spawn_error', {
      provider: normalizedProviderId,
      error: error.message,
      promptFile,
      runLogFile: logFile,
    });
  });
  child.on('exit', (exitCode, signal) => {
    appendHeadlessAiLog(logFile, 'system', `[exit] code=${exitCode} signal=${signal || 'none'}\n`);
    emitClaudeAutomationLog(`\n[${provider.displayName} headless exit code=${exitCode} signal=${signal || 'none'}]\n`, 'system', normalizedProviderId);
    if (headlessAiRun === run) {
      headlessAiRun = null;
    }
    if (exitCode !== 0 || (run.companies || []).some((company: any) => !companyHasLogSince(company.no, run.startedAtMs))) {
      markHeadlessAutomationFailure(run, exitCode, signal);
    }
    appendDiagnosticEvent('headless_ai_exit', {
      provider: normalizedProviderId,
      exitCode,
      signal: signal || null,
      promptFile,
      runLogFile: logFile,
    });
    invalidateAiStatusCache(normalizedProviderId);
    notifyClients({ type: 'claude-exit', code: exitCode, provider: normalizedProviderId, time: Date.now() });
  });

  if (headlessSpec.promptViaStdin && child.stdin) {
    child.stdin.write(stdinPrompt);
    child.stdin.end();
  }

  return {
    ok: true,
    count: companies.length,
    provider: normalizedProviderId,
    providerLabel: provider.displayName,
    mode: run.mode,
    promptFile,
    runLogFile: logFile,
  };
}

function getScreenshotArtifacts(companyNo, options: Record<string, any> = {}) {
  const status = getExpectedApprovalArtifacts(companyNo, options);
  const actual = status.actual || status.screenshots || {};
  return {
    dir: settings.getScreenshotDir(),
    input: status.exists.input ? (actual.input || status.screenshots.input) : null,
    confirm: status.exists.confirm ? (actual.confirm || status.screenshots.confirm) : null,
    sent: status.exists.sent ? (actual.sent || status.screenshots.sent) : null,
    hasInput: status.exists.input,
    hasConfirm: status.exists.confirm,
    hasSent: status.exists.sent,
    hasAny: status.exists.input || status.exists.confirm || status.exists.sent,
    readyForApproval: status.readyForApproval,
    readyForManualApproval: !!status.readyForManualApproval,
    manualReviewReason: status.manualActionReason || '',
    manualReviewDetail: status.manualActionDetail || '',
    captchaDetected: !!status.captchaDetected,
    directSubmitDetected: !!status.directSubmitDetected,
    auditState: status.auditState || (status.exists.confirm ? 'confirm' : (status.exists.input ? 'input-only' : 'missing')),
    artifacts: status,
  };
}

/**
 * Phase Obs: site_analysis ログ + skipped/error ログの details から、
 * UI に表示する構造化分析結果を抽出する。
 *
 * 戻り値 (見つからなかったフィールドは null):
 * {
 *   llm: { industry: { primary, sub_category }, mainOfferings, evidenceQuotes,
 *          fitVerdict, fitReason, confidence, providerUsed, elapsedMs } | null,
 *   skipReason: string | null,    // skipped/error の lastLog.details (人間可読)
 *   gateFailures: Array<{name, severity, reason}> | null,  // sendability gate
 *   qualityCheck: { failures, action } | null,             // message quality gate
 * }
 */
function extractAnalysisInsight(siteAnalysisLog: any, errorLog: any, lastLog: any) {
  const insight: any = { llm: null, skipReason: null, gateFailures: null, qualityCheck: null };

  // 1. site_analysis.details に LLM 解析結果が JSON で埋め込まれている
  if (siteAnalysisLog && typeof siteAnalysisLog.details === 'string') {
    try {
      const parsed = JSON.parse(siteAnalysisLog.details);
      if (parsed && typeof parsed === 'object' && parsed.llm) {
        insight.llm = {
          industry: parsed.llm.industry || null,
          mainOfferings: Array.isArray(parsed.llm.mainOfferings) ? parsed.llm.mainOfferings.slice(0, 5) : [],
          evidenceQuotes: Array.isArray(parsed.llm.evidenceQuotes) ? parsed.llm.evidenceQuotes.slice(0, 5) : [],
          fitVerdict: parsed.llm.fitVerdict || null,
          fitReason: parsed.llm.fitReason || null,
          confidence: typeof parsed.llm.confidence === 'number' ? parsed.llm.confidence : null,
          providerUsed: parsed.llm.providerUsed || null,
          elapsedMs: typeof parsed.llm.elapsedMs === 'number' ? parsed.llm.elapsedMs : null,
        };
      }
    } catch (_) { /* not JSON or no llm field */ }
  }

  // 2. skipped / error の reason text から gate failures を逆引き (簡易)
  // 形式: "[fatal] siteText_sufficient: ... / [skip] no_deal_breaker_match: ..."
  const lastDetails = lastLog && typeof lastLog.details === 'string'
    ? lastLog.details
    : (errorLog && typeof errorLog.details === 'string' ? errorLog.details : '');
  if (lastDetails && /\[(fatal|skip|warn|info)\]/.test(lastDetails)) {
    const failures: any[] = [];
    // 注意: name には camelCase (siteText_sufficient) もあるので [A-Za-z_]+
    // reason は次の `/ [severity]` か文末まで。`/` は reason 内にも出る (例:
    // "HTTP取得失敗 / JS描画") ので、純粋な `/` ではなく `/\s*\[severity\]`
    // までを終端とする。
    const re = /\[(fatal|skip|warn|info)\]\s+([A-Za-z_]+):\s*([\s\S]+?)(?=\s*\/\s*\[(?:fatal|skip|warn|info)\]|$)/g;
    let m;
    while ((m = re.exec(lastDetails)) !== null) {
      failures.push({ severity: m[1], name: m[2], reason: m[3].trim().replace(/\s*\/\s*$/, '') });
    }
    if (failures.length > 0) insight.gateFailures = failures;
  }

  if (lastLog && lastLog.action === 'skipped' && typeof lastLog.details === 'string') {
    insight.skipReason = lastLog.details.slice(0, 500);
  }
  return insight;
}

function getCompanyLogContext(companyNo) {
  const allLogs = getAllLogs();
  const logs = allLogs.filter((log: any) => String(log.companyNo) === String(companyNo));
  const lastLog = logs.length > 0 ? logs[logs.length - 1] : null;
  const formFillLog = getLatestLog(logs, 'form_fill');
  const submittedLog = getLatestLog(logs, 'submitted');
  const awaitingLog = getLatestLog(logs, 'awaiting_approval');
  const confirmLog = getLatestLog(logs, 'confirm_reached');
  const errorLog = getLatestLog(logs, 'error');
  return {
    allLogs,
    logs,
    lastLog,
    lastAction: lastLog ? lastLog.action : null,
    formFillLog,
    submittedLog,
    awaitingLog,
    confirmLog,
    errorLog,
    screenshot: getScreenshotArtifacts(companyNo, {
      logs,
      formFillLog,
      submittedLog,
      awaitingLog,
      confirmLog,
    }),
  };
}

function deleteCompanyScreenshots(companyNo) {
  const prefix = `ss-${companyNo}-`;
  const removed = new Set<any>();
  for (const dirPath of getScreenshotSearchDirs()) {
    try {
      if (!fs.existsSync(dirPath)) continue;
      const fileNames = fs.readdirSync(dirPath);
      for (const fileName of fileNames) {
        if (!fileName.startsWith(prefix) || !fileName.endsWith('.png')) continue;
        const filePath = path.join(dirPath, fileName);
        try {
          fs.unlinkSync(filePath);
          removed.add(path.resolve(filePath));
        } catch (_) {}
      }
    } catch (_) {}
  }
  return Array.from(removed);
}

function removeSkipFeedback(companyNo) {
  const filePath = resolveDataPath('skip-feedback.json');
  if (!fs.existsSync(filePath)) return 0;
  try {
    const current = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (!Array.isArray(current)) return 0;
    const next = current.filter((entry: any) => String(entry && entry.companyNo) !== String(companyNo));
    const removedCount = current.length - next.length;
    if (removedCount > 0) {
      fs.writeFileSync(filePath, JSON.stringify(next, null, 2), 'utf-8');
    }
    return removedCount;
  } catch (_) {
    return 0;
  }
}

function findRuntimeCompanyRecord(companyNo) {
  const wanted = String(companyNo);
  return loadData().companies.find((company: any) => String(company.no) === wanted) || null;
}

function purgeHistoryOnlyCompany(companyNo) {
  const company = findRuntimeCompanyRecord(companyNo);
  const logsRemoved = removeCompanyLogs(companyNo);
  const historyRemoved = removeHistory(companyNo);
  const monitorRemoved = removeCompanyMonitor(companyNo);
  const screenshotsRemoved = deleteCompanyScreenshots(companyNo);
  const skipFeedbackRemoved = removeSkipFeedback(companyNo);
  const removed =
    logsRemoved > 0 ||
    historyRemoved ||
    monitorRemoved ||
    screenshotsRemoved.length > 0 ||
    skipFeedbackRemoved > 0;

  return {
    ok: removed,
    company: {
      no: company ? company.no : companyNo,
      companyName: company ? company.name : String(companyNo),
    },
    removed: {
      logs: logsRemoved,
      history: historyRemoved ? 1 : 0,
      monitor: monitorRemoved ? 1 : 0,
      screenshots: screenshotsRemoved.length,
      skipFeedback: skipFeedbackRemoved,
    },
  };
}

function getMonitorScreenshotFile(monitor) {
  const candidates: any[] = [];
  if (monitor && monitor.latestScreenshot) candidates.push(monitor.latestScreenshot);
  if (monitor && monitor.screenshot) candidates.push(monitor.screenshot);
  if (monitor && monitor.latestScreenshotName) candidates.push(monitor.latestScreenshotName);
  for (const candidate of candidates) {
    const existing = findScreenshotPath(candidate);
    if (existing) return path.basename(existing);
  }
  return null;
}

function mapLogToMonitorStatus(action) {
  switch (String(action || '').trim()) {
    case 'site_analysis': return 'site_analysis';
    case 'message_draft': return 'draft_ready';
    case 'form_fill': return 'form_filling';
    case 'confirm_reached': return 'confirm_reached';
    case 'awaiting_approval': return 'awaiting_approval';
    case 'submitted': return 'submitted';
    case 'skipped': return 'skipped';
    case 'error': return 'error';
    default: return String(action || '').trim() || 'update';
  }
}

function mapLogToMonitorStep(log) {
  const action = String(log && log.action || '').trim();
  switch (action) {
    case 'site_analysis': return '企業サイト分析';
    case 'message_draft': return '文面作成';
    case 'form_fill': return 'フォーム入力中';
    case 'confirm_reached': return '確認画面到達';
    case 'awaiting_approval': return '確認待ち';
    case 'submitted': return '送信済み';
    case 'skipped': return '対象外/スキップ';
    case 'error': return 'エラー';
    default: return action || '';
  }
}

function buildFallbackMonitorEventsFromLogs(sourceLogs: any[] = []) {
  const relevantActions = new Set(['site_analysis', 'message_draft', 'form_fill', 'confirm_reached', 'awaiting_approval', 'submitted', 'skipped', 'error']);
  const seen = new Set<any>();
  const events: any[] = [];
  sourceLogs
    .filter((log: any) => log && log.companyNo != null && relevantActions.has(String(log.action || '').trim()))
    .slice()
    .sort((a: any, b: any) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime())
    .forEach((log: any) => {
      const key = `${log.companyNo}:${log.action}:${log.timestamp}`;
      if (seen.has(key)) return;
      seen.add(key);
      events.push({
        companyNo: Number(log.companyNo),
        companyName: log.companyName || '',
        // v2.0.89: UI の STEP_WEIGHTS / 進捗バーは action フィールドを使う。
        //   旧来は status/step だけ含めていたので 0% のまま動かなかった。
        action: log.action || '',
        status: mapLogToMonitorStatus(log.action),
        step: mapLogToMonitorStep(log),
        currentUrl: extractFormUrlFromLog(log),
        updatedAt: log.timestamp || null,
        timestamp: log.timestamp || null,
        active: false,
        source: 'action-log',
      });
    });
  return events;
}

function buildMonitorPayload(sourceLogs: any[] = []) {
  const summary = getLiveMonitorSummary();
  const monitor = summary && summary.primary ? summary.primary : readMonitorState();
  const liveEvents = summary && Array.isArray(summary.events)
    ? summary.events.map((entry: any) => ({
        ...entry,
        currentUrl: entry && (entry.currentUrl || entry.formUrl) ? (entry.currentUrl || entry.formUrl) : '',
        latestScreenshotName: getMonitorScreenshotFile(entry),
      }))
    : [];
  const fallbackEvents = buildFallbackMonitorEventsFromLogs(sourceLogs);
  const eventMap = new Map<any, any>();
  [...liveEvents, ...fallbackEvents].forEach((entry: any) => {
    if (!entry) return;
    const key = `${entry.companyNo || ''}:${entry.status || ''}:${entry.updatedAt || ''}:${entry.step || ''}`;
    if (!eventMap.has(key)) eventMap.set(key, entry);
  });
  const events = [...eventMap.values()]
    .sort((a: any, b: any) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime())
    .slice(0, 200);
  if (!monitor) {
    return {
      status: 'idle',
      companyNo: null,
      companyName: '',
      currentUrl: '',
      step: '',
      latestScreenshotName: null,
      updatedAt: summary ? summary.updatedAt : null,
      activeCount: 0,
      events,
    };
  }
  return {
    ...monitor,
    currentUrl: monitor.currentUrl || monitor.formUrl || '',
    latestScreenshotName: getMonitorScreenshotFile(monitor),
    activeCount: summary ? summary.activeCount || 0 : 0,
    events,
  };
}

function getLatestMonitorUrl(companyNo) {
  const wanted = String(companyNo);
  const summary = getLiveMonitorSummary();
  const candidates: any[] = [];
  if (summary && summary.primary && String(summary.primary.companyNo) === wanted) candidates.push(summary.primary);
  if (summary && Array.isArray(summary.events)) {
    summary.events.forEach((entry: any) => {
      if (entry && String(entry.companyNo) === wanted) candidates.push(entry);
    });
  }
  const latest = candidates.find((entry: any) => entry && (entry.currentUrl || entry.formUrl));
  return latest ? (latest.currentUrl || latest.formUrl || '') : '';
}

function extractUrlFromText(value = '') {
  const match = String(value || '').match(/https?:\/\/[^\s"'<>]+/i);
  if (!match) return '';
  return match[0].replace(/[),.;]+$/g, '');
}

function extractFormUrlFromLog(log) {
  if (!log) return '';
  const details = log.details;
  if (details && typeof details === 'object') {
    const directCandidates = [details.formUrl, details.currentUrl, details.url, details.targetUrl];
    for (const candidate of directCandidates) {
      const normalized = String(candidate || '').trim();
      if (/^https?:\/\//i.test(normalized)) return normalized;
    }
  }
  return extractUrlFromText(stringifyLogDetails(details || ''));
}

function ensureSubmittedContactHistory(companyNo, companyName, submittedLog, formUrl, message, existingHistory: any = null, options: Record<string, any> = {}) {
  if (!submittedLog) return existingHistory;
  const normalizedMessage = String(message || '').trim();
  const normalizedFormUrl = String(formUrl || '').trim();
  const submittedAt = submittedLog && submittedLog.timestamp ? new Date(submittedLog.timestamp).toISOString() : '';
  const history = existingHistory || getHistory(companyNo);
  const contacts = history && Array.isArray(history.contacts) ? history.contacts : [];
  const alreadyRecorded = contacts.some((contact: any) => {
    const sameDate = submittedAt && (
      String(contact && contact.date || '') === submittedAt
      || String(contact && contact.sourceActionAt || '') === submittedAt
    );
    const sameMessage = normalizedMessage && String(contact && contact.message || '').trim() === normalizedMessage;
    const sameUrl = normalizedFormUrl && String(contact && contact.formUrl || '').trim() === normalizedFormUrl;
    return sameDate || (sameMessage && (!normalizedFormUrl || sameUrl));
  });
  if (alreadyRecorded || (!normalizedMessage && !normalizedFormUrl)) return history;
  recordContact(companyNo, companyName, {
    message: normalizedMessage,
    formUrl: normalizedFormUrl,
    method: 'web_form',
    sentAt: submittedAt,
    screenshot: options.screenshot || '',
    sourceAction: options.sourceAction || 'submitted',
    sourceActionAt: options.sourceActionAt || submittedAt,
    status: options.status || 'submitted',
    notes: options.notes || 'submitted log sync',
  });
  return getHistory(companyNo);
}

function getKnownFormUrl(companyNo, preferredUrl = '', logs: any[] = []) {
  const direct = String(preferredUrl || '').trim();
  if (direct) return direct;

  const monitorUrl = getLatestMonitorUrl(companyNo);
  if (monitorUrl) return monitorUrl;

  for (let i = logs.length - 1; i >= 0; i -= 1) {
    const logUrl = extractFormUrlFromLog(logs[i]);
    if (logUrl) return logUrl;
  }

  const history = getHistory(companyNo);
  if (history && Array.isArray(history.contacts)) {
    for (let i = history.contacts.length - 1; i >= 0; i -= 1) {
      const formUrl = String((history.contacts[i] && history.contacts[i].formUrl) || '').trim();
      if (formUrl) return formUrl;
    }
  }

  return '';
}

function buildCompanyAutomationHints(company) {
  const hints: any[] = [];
  const knownFormUrl = getKnownFormUrl(company.no, company.formUrl || '');
  if (knownFormUrl) {
    hints.push(`   優先フォームURL: ${knownFormUrl}`);
  } else if (company.url) {
    hints.push(`   探索ルール: まず ${company.url} のヘッダー/フッター/サイト内の「お問い合わせ」「Contact」を確認すること`);
    hints.push(`   探索ルール: サイト内で見つからない場合のみ「${company.companyName || company.name || ''} 問い合わせ」で1回だけ検索し、公式ドメインの最上位候補だけを開くこと`);
    hints.push('   探索ルール: 関連ページをだらだら巡回したり、非公式ドメインを複数たどらないこと');
  } else {
    hints.push(`   探索ルール: 「${company.companyName || company.name || ''} 問い合わせ」で1回だけ検索し、公式ドメインの最上位候補だけを確認すること`);
  }

  const history = getHistory(company.no);
  if (history && Array.isArray(history.contacts) && history.contacts.length > 0) {
    const latest = history.contacts[history.contacts.length - 1];
    hints.push(`   学習メモ: 過去に ${history.contacts.length} 回送信履歴あり`);
    if (latest && latest.formUrl) hints.push(`   学習メモ: 前回利用フォームURL: ${latest.formUrl}`);
  }

  const logContext = getCompanyLogContext(company.no);
  if (logContext.screenshot && logContext.screenshot.captchaDetected) {
    hints.push('   学習メモ: 過去に CAPTCHA があり、最終送信は手動対応になった');
  }
  if (logContext.errorLog) {
    const errorDetail = truncateUiText(logContext.errorLog.details, 140);
    if (errorDetail) hints.push(`   学習メモ: 前回エラー: ${errorDetail}`);
  }

  return hints;
}

function isAwaitingTransitionAllowed(lastAction, decision) {
  if (decision === 'sent') {
    return ['awaiting_approval', 'confirm_reached'].includes(lastAction);
  }
  if (decision === 'skip') {
    // 送信済み・スキップ済み以外はどの中間状態からでもスキップ可（バッチ中断時の救済含む）
    const alreadyFinal = new Set(['submitted', 'skipped']);
    return !alreadyFinal.has(lastAction);
  }
  return false;
}

function execCommand(command, options: Record<string, any> = {}) {
  return new Promise<any>((resolve) => {
    const { exec } = require('child_process');
    exec(command, {
      windowsHide: process.platform === 'win32',
      ...options,
    }, (error, stdout, stderr) => {
      resolve({ error, stdout, stderr });
    });
  });
}

function escapePowerShellArg(value) {
  return `'${String(value || '').replace(/'/g, "''")}'`;
}

function toPowerShellEncodedCommand(script) {
  return Buffer.from(String(script || ''), 'utf16le').toString('base64');
}

function normalizeProjectPath(inputPath, fallbackPath = PROJECT_ROOT) {
  const value = typeof inputPath === 'string' ? inputPath.trim() : '';
  if (!value) return fallbackPath;
  return path.isAbsolute(value) ? value : path.resolve(PROJECT_ROOT, value);
}

function toStoredProjectPath(targetPath) {
  const value = typeof targetPath === 'string' ? targetPath.trim() : '';
  if (!value) return '';
  const relativePath = path.relative(PROJECT_ROOT, value);
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return value;
  }
  return relativePath;
}

async function openDirectoryPicker(initialPath = '') {
  const runtimeRoot = typeof settings.getRuntimeRoot === 'function' ? settings.getRuntimeRoot() : PROJECT_ROOT;
  const resolvedInitial = normalizeProjectPath(initialPath, runtimeRoot);

  if (process.versions.electron) {
    const { dialog, BrowserWindow } = require('electron');
    const parentWindow = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;
    const result: any = await dialog.showOpenDialog(parentWindow, {
      title: 'Select folder',
      defaultPath: fs.existsSync(resolvedInitial) ? resolvedInitial : runtimeRoot,
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : (result.filePaths && result.filePaths[0]) || null;
  }

  throw new Error('Folder selection is available in the desktop app. In browser-only mode, enter the path manually.');
}

async function resolveClaudeExecutable(providerId = getSelectedAiProvider()) {
  const provider = getProvider(providerId);
  const cacheKey = provider.id;
  const cached = _aiExecutablePath[cacheKey];
  if (cached && fs.existsSync(cached)) return cached;
  if (process.platform !== 'win32') return provider.id;

  // v2.0.47: Claude binary が "アップデート中断で .old のまま" の状態を自己修復する。
  //   実機事例: 2026-05-19 03:31 - bin/claude.exe が消えて .old.1779156283983 だけ残り
  //   「'...claude.exe' is not recognized」で AI 起動不可になった。
  //   recoverClaudeBinaryIfOrphaned が成功すれば diagnostic を残しユーザーに知らせる。
  try {
    const recovery = localToolchain.recoverClaudeBinaryIfOrphaned(provider.id);
    if (recovery && recovery.recovered) {
      appendDiagnosticEvent('claude_binary_self_healed', {
        provider: provider.id,
        restoredFrom: recovery.restoredFrom,
      });
      emitClaudeAutomationLog(
        `[自己修復] Claude CLI バイナリ (${recovery.restoredFrom}) を claude.exe に復元しました。アップデート中断による不整合を解消しました。\n`,
        'system',
        provider.id,
      );
    }
  } catch (e: any) {
    console.warn('[resolveClaude] self-heal failed:', e && e.message || e);
  }

  const whereNames = Array.from(new Set([
    ...provider.executableNames,
    ...provider.executableNames.map((entry: any) => path.parse(entry).name),
    provider.id,
  ])).filter(Boolean);

  const discoveredCandidates: any[] = [];
  for (const name of whereNames) {
    const result: any = await execCommand(`where ${name}`, { timeout: 3000 });
    if (result.error) continue;
    discoveredCandidates.push(...String(result.stdout || '')
      .split(/\r?\n/)
      .map((line: any) => line.trim())
      .filter((line: any) => line && fs.existsSync(line)));
  }

  const localNpmBin = `${localToolchain.getNpmBinDir()}${path.sep}`.toLowerCase();
  const bundledNpmBin = (() => {
    try {
      const dir = localToolchain.getBundledNpmProjectDir && localToolchain.getBundledNpmProjectDir();
      return dir ? `${path.join(dir, 'node_modules', '.bin')}${path.sep}`.toLowerCase() : null;
    } catch (_) { return null; }
  })();
  const candidates = Array.from(new Set([
    ...localToolchain.getProviderExecutableCandidates(provider.id).filter((entry: any) => fs.existsSync(entry)),
    ...discoveredCandidates,
    ...getExecutableFallbackCandidates(provider.id).filter((entry: any) => fs.existsSync(entry)),
  ])).sort((left: any, right: any) => {
    function score(entry) {
      const normalized = String(entry || '').toLowerCase();
      let value = 0;
      // v2.0.63: installer 同梱の prebuilt-bundles を最優先する。
      //   旧版 (v2.0.59 以前) で <runtime>/tools/ に DL された claude.exe が
      //   壊れていた事例 (Windows: "not compatible with the version of Windows
      //   you're running") があり、新規 install / アップグレード後でも legacy
      //   runtime/tools/ の方が高スコアで選ばれ、壊れた exe が使われ続けてしまった。
      //   同梱バンドルは CI で常にクリーンビルドするので確実に動作する。
      if (bundledNpmBin && normalized.startsWith(bundledNpmBin)) value += 300;
      if (normalized.includes('\\prebuilt-bundles\\')) value += 280;
      if (normalized.includes('/prebuilt-bundles/')) value += 280;
      if (normalized.startsWith(localNpmBin)) value += 100;
      if (normalized.includes('\\.sales-claw\\tools\\npm-project\\node_modules\\.bin\\')) value += 90;
      if (normalized.includes('/.sales-claw/tools/npm-project/node_modules/.bin/')) value += 90;
      if (normalized.includes('\\appdata\\roaming\\npm\\')) value += 40;
      // .local/bin は claude self-update がインストールする場所 — npm .cmd ラッパーより優先
      if (normalized.includes('\\.local\\bin\\')) value += 50;
      if (normalized.includes('\\windowsapps\\')) value -= 40;
      // node_modules 内の直接バイナリは npm ラッパーが壊れたとき不安定なため低く評価
      // ただし prebuilt-bundles の場合は上で +280 を入れているので最終的に高評価のまま
      if (normalized.includes('\\node_modules\\')) value -= 10;
      if (normalized.endsWith('.cmd')) value += 20;
      else if (normalized.endsWith('.exe')) value += 15;
      else if (normalized.endsWith('.ps1')) value += 5;
      return value;
    }
    return score(right) - score(left);
  });

  if (candidates[0]) {
    let chosen = candidates[0];
    // Codex 専用: node.js wrapper チェーン (cmd → codex.cmd → node → codex.js → spawn(rust, stdio:'inherit'))
    // を経由すると Electron + node-pty の ConPTY 状態が最深 spawn 'inherit' で TTY を失い
    // Rust 側 isatty(stdin) が false → "stdin is not a terminal" で即終了する。
    // wrapper を 1 段にするため、可能なら Rust .exe (codex.exe) を直接起動する。
    if (provider.id === 'codex') {
      const rustExe = resolveCodexRustExecutable(chosen);
      if (rustExe) chosen = rustExe;
    }
    _aiExecutablePath[cacheKey] = chosen;
    return chosen;
  }

  return provider.id;
}

function resolveCodexRustExecutable(wrapperPath) {
  if (!wrapperPath || process.platform !== 'win32') return null;
  try {
    const wrapperDir = path.dirname(wrapperPath);
    // Codex の Rust バイナリは codex CLI のバージョン/インストール経路で複数の場所に存在しうる:
    //   A. npm global flat (codex 0.118 nested):
    //      <npmDir>/codex.cmd → <npmDir>/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/.../codex.exe
    //   B. npm global flat (codex 0.128+ flat):
    //      <npmDir>/codex.cmd → <npmDir>/node_modules/@openai/codex-win32-x64/vendor/.../codex.exe
    //   C. Sales Claw managed toolchain:
    //      <toolchain>/node_modules/.bin/codex.cmd → <toolchain>/node_modules/@openai/codex-win32-x64/vendor/.../codex.exe
    //   D. Codex 0.118 toolchain (nested):
    //      <toolchain>/node_modules/.bin/codex.cmd → <toolchain>/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/...
    const triple = 'x86_64-pc-windows-msvc';
    const tail = path.join('@openai', 'codex-win32-x64', 'vendor', triple, 'codex', 'codex.exe');
    const searchRoots = [
      // (A) npm global, nested codex 0.118
      path.join(wrapperDir, 'node_modules', '@openai', 'codex', 'node_modules'),
      // (B) npm global, flat 0.128+
      path.join(wrapperDir, 'node_modules'),
      // (C) toolchain .bin → 1 つ上の node_modules
      path.join(wrapperDir, '..'),
      // (D) toolchain .bin → 0.118 の入れ子構造
      path.join(wrapperDir, '..', '@openai', 'codex', 'node_modules'),
    ];
    for (const root of searchRoots) {
      const candidate = path.join(root, tail);
      if (fs.existsSync(candidate)) return path.resolve(candidate);
    }
  } catch (_) { /* fall through */ }
  return null;
}

async function resolveNodeExecutable() {
  if (/node(?:\.exe)?$/i.test(path.basename(process.execPath || ''))) {
    return process.execPath;
  }
  const toolchain = localToolchain.ensureToolchainFiles();
  if (toolchain.nodeShim && fs.existsSync(toolchain.nodeShim)) {
    return toolchain.nodeShim;
  }
  if (process.platform === 'win32') {
    const result: any = await execCommand('where node', { timeout: 3000 });
    const candidates = String(result.stdout || '')
      .split(/\r?\n/)
      .map((line: any) => line.trim())
      .filter((line: any) => line && fs.existsSync(line));
    return candidates[0] || null;
  }
  const result: any = await execCommand('which node', { timeout: 3000 });
  const candidate = String(result.stdout || '').trim();
  return candidate && fs.existsSync(candidate) ? candidate : null;
}

async function probeClaudeAuthStatus(providerId = getSelectedAiProvider()) {
  const provider = getProvider(providerId);
  const executable: any = await resolveClaudeExecutable(provider.id);
  const installed = process.platform !== 'win32' || executable !== provider.id;
  if (!installed) {
    return {
      provider: provider.id,
      installed: false,
      loggedIn: false,
      error: `${provider.cliLabel} is not installed.`,
    };
  }

  if (provider.id === 'claude') {
    const result: any = await runProviderCliCommand(provider.id, ['auth', 'status', '--json'], {
      timeout: 8000,
      env: buildManagedProviderEnv(provider.id),
    });
    if (!result.ok) {
      return {
        provider: provider.id,
        installed: true,
        loggedIn: false,
        error: String(result.stderr || result.stdout || result.error?.message || 'Claude auth status failed.').trim(),
      };
    }

    try {
      const parsed = JSON.parse(String(result.stdout || '{}'));
      return {
        provider: provider.id,
        installed: true,
        loggedIn: !!parsed.loggedIn,
        authMethod: parsed.authMethod || null,
        email: parsed.email || null,
        orgName: parsed.orgName || null,
        subscriptionType: parsed.subscriptionType || null,
        error: parsed.loggedIn ? null : 'Claude CLI is not authenticated.',
      };
    } catch (error) {
      return {
        provider: provider.id,
        installed: true,
        loggedIn: false,
        error: String(result.stdout || result.stderr || error.message || 'Could not parse Claude auth status.').trim(),
      };
    }
  }

  if (provider.id === 'codex') {
    const result: any = await runProviderCliCommand(provider.id, ['login', 'status'], {
      timeout: 8000,
      env: buildManagedProviderEnv(provider.id),
    });
    const output = String(result.stdout || result.stderr || '').trim();
    const loggedIn = /logged in/i.test(output) || /chatgpt/i.test(output);
    return {
      provider: provider.id,
      installed: true,
      loggedIn,
      authMethod: loggedIn ? 'chatgpt' : null,
      summary: output.split(/\r?\n/)[0] || null,
      error: loggedIn ? null : (output || 'Codex CLI is not authenticated.'),
    };
  }

  const loggedIn = hasAnyAuthFile(provider.id)
    || !!process.env.GEMINI_API_KEY
    || !!process.env.GOOGLE_API_KEY;
  return {
    provider: provider.id,
    installed: true,
    loggedIn,
    authMethod: loggedIn ? 'cached_credentials' : null,
    probeReliability: 'heuristic',
    error: loggedIn ? null : 'Gemini CLI cached credentials were not found.',
  };
}

async function probeNpmStatus() {
  return localToolchain.probeEmbeddedNpmStatus();
}

async function probePlaywrightPackageStatus(npmStatus: any = null) {
  void npmStatus;
  return localToolchain.probePlaywrightMcpStatus();
}

async function probeProviderPlaywrightSetup(providerId = getSelectedAiProvider()) {
  const normalizedProviderId = normalizeProviderId(providerId);
  if (!['codex', 'gemini'].includes(normalizedProviderId)) {
    return {
      configured: null,
      error: null,
      note: 'Claude validates Playwright access at launch/runtime. Codex and Gemini additionally require MCP registration.',
    };
  }
  const listArgs = normalizedProviderId === 'gemini' ? ['--debug', 'mcp', 'list'] : ['mcp', 'list'];
  const result: any = await runProviderCliCommand(normalizedProviderId, listArgs, { timeout: 20000 });
  const output = `${String(result.stdout || '')}\n${String(result.stderr || '')}`.trim();
  const configured = !!(result.ok && /playwright/i.test(output));
  return {
    configured,
    error: configured ? null : (output || `${getProviderDisplayName(normalizedProviderId)} MCP list did not report Playwright.`),
    note: configured ? 'Playwright MCP is registered.' : 'Playwright MCP is not registered yet.',
  };
}

async function probeAiSetupDiagnostics(providerId = getSelectedAiProvider()) {
  const normalizedProviderId = normalizeProviderId(providerId);
  const provider = getProvider(normalizedProviderId);
  const cached = _aiDiagnosticsCache.get(normalizedProviderId);
  const now = Date.now();
  if (cached && now - cached.time < AI_DIAGNOSTICS_CACHE_TTL_MS) {
    return { ...cached.value, cache: 'hit' };
  }

  const existing = _aiDiagnosticsInFlight.get(normalizedProviderId);
  if (existing) {
    const value: any = await existing;
    return { ...value, cache: 'coalesced' };
  }

  const cacheGeneration = _aiCacheGeneration;
  const promise = (async () => {
    const [auth, npm, playwrightPackage, providerPlaywright, cliStatus] = await Promise.all([
      probeClaudeAuthStatus(normalizedProviderId),
      probeNpmStatus(),
      probePlaywrightPackageStatus(),
      probeProviderPlaywrightSetup(normalizedProviderId),
      probeClaudeStatus(normalizedProviderId),
    ]);
  const workspaceTrusted = normalizedProviderId === 'codex'
    ? {
      configured: isCodexWorkspaceTrusted(PROJECT_ROOT),
      note: 'Codex では trusted workspace 設定が必要です。',
    }
    : normalizedProviderId === 'gemini'
      ? {
        configured: isGeminiWorkspaceTrusted(PROJECT_ROOT),
        note: 'Gemini では trustedFolders / projects 登録が必要です。',
      }
      : {
        configured: true,
        note: 'Claude は workspace trust の事前設定を必要としません。',
      };
  return {
    provider: normalizedProviderId,
    providerLabel: provider.displayName,
    cliInstalled: !!auth.installed,
    cliLoggedIn: !!auth.loggedIn,
    cliAuthError: auth.error || null,
    npm,
    playwrightPackage,
    providerPlaywright,
    workspaceTrusted,
    cliVersion: cliStatus.version || null,
    cliTooOld: !!cliStatus.cliTooOld,
    minVersion: cliStatus.minVersion || null,
    updateCommand: cliStatus.updateCommand || null,
    versionWarning: cliStatus.versionWarning || null,
    installCommand: localToolchain.getProviderInstallCommand(normalizedProviderId),
    autoInstallSupported: !!(npm.available && playwrightPackage.available),
    embeddedToolchain: {
      root: localToolchain.getToolchainRoot(),
      npmProjectDir: localToolchain.getNpmProjectDir(),
      browsersDir: localToolchain.getPlaywrightBrowsersDir(),
    },
    managedSessionRequired: requiresManagedAiSessionForFormFill(normalizedProviderId),
    tabRetentionNote: `${provider.displayName} の確認待ちでフォームタブを残すには、ダッシュボードの「AI を起動」で ${provider.displayName} を managed セッションとして起動してから実行する必要があります。`,
    launchExamples: getProviderLaunchExamples(normalizedProviderId),
    approvalCaveat: {
      ...getProviderApprovalCaveat(normalizedProviderId, 'ja'),
      en: getProviderApprovalCaveat(normalizedProviderId, 'en').message,
      ja: getProviderApprovalCaveat(normalizedProviderId, 'ja').message,
    },
  };
  })();

  _aiDiagnosticsInFlight.set(normalizedProviderId, promise);
  try {
    const value: any = await promise;
    if (_aiCacheGeneration === cacheGeneration) {
      _aiDiagnosticsCache.set(normalizedProviderId, { time: Date.now(), value });
    }
    return value;
  } finally {
    if (_aiDiagnosticsInFlight.get(normalizedProviderId) === promise) {
      _aiDiagnosticsInFlight.delete(normalizedProviderId);
    }
  }
}

async function ensureClaudeAutomationReady(providerId = getSelectedAiProvider()) {
  const selectedProviderId = normalizeProviderId(providerId);
  let managedProviderId = getManagedAiProvider();
  const provider = getProvider(selectedProviderId);
  // v2.0.29: managed PTY が既に走っている = ログイン済 として扱う。
  // 旧バグ: AI 起動済の状態で /api/ai-form-fill を呼ぶと
  // probeClaudeAuthStatus が別 spawn で `claude auth status --json` を実行 →
  // 既存 PTY が credentials.json を握っているケース等で失敗 → 「未ログイン」エラー。
  // managed AI が動いてる時点で claude.ai 認証は成立してるので probe スキップ。
  const managedAlreadyRunning = !!claudePty && managedProviderId === selectedProviderId;
  const auth: any = managedAlreadyRunning
    ? { provider: selectedProviderId, installed: true, loggedIn: true, authMethod: 'managed-session' }
    : await probeClaudeAuthStatus(selectedProviderId);
  if (!auth.installed) {
    return {
      ok: false,
      statusCode: 409,
      error: `${provider.cliLabel} が未インストールです。${provider.displayName} を起動してインストールしてください。`,
    };
  }
  if (!auth.loggedIn) {
    return {
      ok: false,
      statusCode: 409,
      error: `${provider.cliLabel} が未ログインです。先に ${provider.displayName} を起動してログインを完了してください。`,
    };
  }
  // v2.0.82: internal mode では Playwright Chromium 不要 (Electron 内蔵 WebContentsView を使う)
  // installPlaywrightChromium を呼ぶ必要なし。skip して return ok。
  if (getFormFillMode() === 'internal') {
    appendDiagnosticEvent('ai_form_fill_skip_playwright_prep_internal_mode', {
      provider: selectedProviderId,
    });
    // playwrightPackage check 全体を bypass して下に進む
    // (Electron WebContentsView は常に available なので bundle / install check 不要)
  } else {
  let playwrightPackage: any = await probePlaywrightPackageStatus();
  if (!playwrightPackage.available || !playwrightPackage.browserInstalled) {
    // v2.0.64: 旧仕様は「未準備です」エラーを返してユーザーに再度ボタン押下を強いていた。
    // 実機ログ: 1 回目「未準備」→ ユーザー操作 → 2 回目「未準備」→ 数分後にやっと成功、
    // という「2 回押し」UX バグの根本原因。
    // 新仕様: ここで自動で installPlaywrightChromium を呼び、その結果を含めて再 probe する。
    // installer 同梱 bundle (v2.0.60+) があれば即座に成功するし、無くても 1 度の API 呼び出し
    // で済む。
    appendDiagnosticEvent('ai_form_fill_auto_install_playwright', {
      provider: selectedProviderId,
      reason: !playwrightPackage.available ? 'mcp-unavailable' : 'chromium-missing',
    });
    emitClaudeAutomationLog(
      `[自動準備] Playwright MCP / Chromium が未準備のため自動セットアップを開始します...\n`,
      'system',
      selectedProviderId,
    );
    try {
      const installResult: any = await localToolchain.installPlaywrightChromium();
      if (installResult && installResult.ok) {
        emitClaudeAutomationLog(
          installResult.bundled
            ? `[自動準備] 同梱 Chromium を検出しました (再 DL 不要)。\n`
            : `[自動準備] Chromium の準備が完了しました。\n`,
          'system',
          selectedProviderId,
        );
      }
    } catch (autoInstallErr: any) {
      appendDiagnosticEvent('ai_form_fill_auto_install_failed', {
        provider: selectedProviderId,
        error: autoInstallErr && autoInstallErr.message ? autoInstallErr.message : String(autoInstallErr),
      });
    } finally {
      // v2.0.64: 成功/失敗どちらでもキャッシュを必ず invalidate して再 probe する。
      // install 中に部分的にファイルシステムが変わっている可能性があるので、
      // stale な playwrightPackage snapshot を握ったまま 409 を返すと UX 誤判定。
      invalidateAiStatusCache(selectedProviderId);
      playwrightPackage = await probePlaywrightPackageStatus();
    }
    if (!playwrightPackage.available || !playwrightPackage.browserInstalled) {
      return {
        ok: false,
        statusCode: 409,
        error: `Playwright MCP / Chromium の自動準備に失敗しました。ダッシュボードの「AI CLI を準備」ボタンで ${provider.displayName} と Playwright を手動セットアップしてください。`,
      };
    }
  }
  } // v2.0.82: end of `if (getFormFillMode() !== 'internal')` (playwright Chromium prep block)
  if (selectedProviderId === 'codex') {
    ensureCodexWorkspaceTrusted(PROJECT_ROOT);
  }
  if (selectedProviderId === 'gemini') {
    ensureGeminiWorkspaceTrusted(PROJECT_ROOT);
  }
  if (requiresManagedAiSessionForFormFill(selectedProviderId) && claudePty && managedProviderId === selectedProviderId) {
    await restartManagedAiSessionForAuthRefresh(selectedProviderId);
  }
  // v2.0.53: Claude も MCP 事前チェックに含める。
  //   旧仕様: Claude は startManagedAiSession 内でしか ensureProviderPlaywrightMcp
  //          を呼ばない → claudePty が既に起動済みだと MCP 登録確認を完全に
  //          スキップしてしまう → managed_home/.claude/settings.json が mcpServers={}
  //          のままだとフォーム入力時に Claude が「MCP Playwright サーバーが
  //          接続されていません」と error response を返し、curl /api/log-action
  //          も叩かれず、ダッシュボードに一切ログが残らない事故が発生していた。
  //          (実機 managed_home の settings.json を確認したところ mcpServers:{} だった)
  //   新仕様: ai-form-fill 投入直前に claude も含めて必ず MCP 登録状態を verify。
  //          未登録なら claude mcp add で再登録 → settings.json に書き込まれる。
  //          さらに「新規 add した」かつ「Claude PTY が既に動作中」なら、新しい
  //          MCP 設定を反映するため PTY を自動で張り直す。
  const playwrightSetup: any = await ensureProviderPlaywrightMcp(selectedProviderId, {
    env: buildManagedProviderEnv(selectedProviderId),
  });
  if (!playwrightSetup.ok) {
    return {
      ok: false,
      statusCode: 409,
      error: playwrightSetup.error || `${provider.displayName} の MCP Playwright 設定に失敗しました。`,
    };
  }
  // v2.1.0 Phase 2d: internal form MCP の登録 (mode に依存して挙動分岐)
  const internalFormSetup: any = await ensureProviderInternalFormMcp(selectedProviderId, {
    env: buildManagedProviderEnv(selectedProviderId),
  });
  if (!internalFormSetup.ok) {
    appendDiagnosticEvent('mcp_internal_form_setup_failed', {
      provider: selectedProviderId, error: String(internalFormSetup.error || ''),
    });
    // internal MCP 登録失敗は Phase 2 では fatal 扱いしない (playwright モードで動作可)。
    // formFill.mode='internal' の場合のみ fatal にすべきだが、Phase 3 で評価する。
  }
  if (playwrightSetup.added && claudePty && getManagedAiProvider() === selectedProviderId) {
    appendDiagnosticEvent('managed_ai_mcp_registered_restart', {
      provider: selectedProviderId,
      reason: 'mcp_playwright_added_after_pty_started',
    });
    emitClaudeAutomationLog(
      `[MCP 設定更新検知] ${provider.displayName} の Playwright MCP を新規登録したため、managed セッションを張り直します。\n`,
      'system',
      selectedProviderId,
    );
    const recovery = snapshotManagedAiBatchesForRecovery();
    managedAiRecoveryState = recovery ? { ...recovery, retries: 0, inFlight: false } : null;
    await stopManagedClaudePty({ suppressAutoRecovery: true });
    if (managedAiRecoveryState) {
      await tryRecoverManagedAiSession('mcp-refresh');
    } else {
      await startManagedAiSession(claudeProcessMode || provider.defaultMode || 'auto', selectedProviderId, {
        allowReuse: false,
        autoSendSafe: managedAiAutoSendSafe,
      });
    }
  }
  const activeRun = getActiveHeadlessRun();
  if (activeRun) {
    return {
      ok: false,
      statusCode: 409,
      error: `現在は ${getProviderDisplayName(activeRun.provider)} の headless automation が実行中です。確認待ちタブを残すため、完了を待つか停止してから managed セッションで実行してください。`,
    };
  }
  if (requiresManagedAiSessionForFormFill(selectedProviderId) && !claudePty) {
    const { withRetry } = require('./retry-helper');
    try {
      appendDiagnosticEvent('managed_ai_form_fill_autostart', {
        provider: selectedProviderId,
        mode: provider.defaultMode || 'auto',
      });
      emitClaudeAutomationLog(
        `[AIフォーム入力] ${provider.displayName} の managed セッションが未起動だったため、${getProviderModeLabel(provider.id, provider.defaultMode || 'auto', 'ja')} で自動起動します。\n`,
        'system',
        selectedProviderId,
      );
      // A2: 起動失敗時の自動 retry + exponential back-off。
      // 過去の致命バグ (47 バッチ滞留) は最初の 1 回だけ失敗するパターンが多く、
      // ユーザーに「もう一度押し直してください」を強いるのは UX として不適切。
      // CLI_NOT_INSTALLED / CLI_TOO_OLD / 設定不足 のような retry しても無駄な
      // エラーは shouldRetry で弾く。
      await withRetry(
        async () => {
          await startManagedAiSession(provider.defaultMode || 'auto', selectedProviderId, {
            allowReuse: false,
            requireMcp: true,
            autoSendSafe: getConfiguredAiAutoSendSafe(),
          });
        },
        {
          attempts: 3,
          initialDelayMs: 800,
          maxDelayMs: 4000,
          shouldRetry: (err: any) => {
            const code = err && err.code;
            // ユーザー対応必須のエラーは即座に諦める
            if (code === 'CLI_NOT_INSTALLED') return false;
            if (code === 'CLI_TOO_OLD') return false;
            if (code === 'LAUNCH_CANCELLED') return false;
            return true;
          },
          onAttempt: (attempt: number, error: any) => {
            if (error) {
              appendDiagnosticEvent('managed_ai_form_fill_autostart_retry', {
                provider: selectedProviderId,
                attempt,
                error: String(error && error.message || error).slice(0, 400),
              });
              emitClaudeAutomationLog(
                `[AIフォーム入力] ${provider.displayName} 起動失敗 (試行 ${attempt}): ${error && error.message || error}。再試行します。\n`,
                'system',
                selectedProviderId,
              );
            }
          },
        },
      );
      managedProviderId = getManagedAiProvider();
    } catch (error) {
      appendDiagnosticEvent('managed_ai_form_fill_autostart_failed', {
        provider: selectedProviderId,
        error: String(error && (error as any).message || error).slice(0, 400),
        errorCode: (error as any)?.code || null,
      });
      return {
        ok: false,
        statusCode: 409,
        error: `${provider.displayName} の managed セッションを自動起動できませんでした (3 回試行): ${(error as any).message || error}`,
      };
    }
  }
  if (requiresManagedAiSessionForFormFill(selectedProviderId) && managedProviderId !== selectedProviderId) {
    return {
      ok: false,
      statusCode: 409,
      error: `現在の管理セッションは ${getProviderDisplayName(managedProviderId)} です。${provider.displayName} でタブ保持したい場合は、${provider.displayName} を選んで起動し直してください。`,
    };
  }
  if (requiresManagedAiSessionForFormFill(selectedProviderId) && !['auto', 'bypassPermissions'].includes(claudeProcessMode)) {
    const previousMode = claudeProcessMode || 'default';
    const nextMode = provider.defaultMode || 'auto';
    try {
      appendDiagnosticEvent('managed_ai_form_fill_mode_autorestart', {
        provider: selectedProviderId,
        previousMode,
        nextMode,
      });
      emitClaudeAutomationLog(
        `[起動モード自動切替] 現在の ${provider.displayName} は ${getProviderModeLabel(provider.id, previousMode, 'ja')}（${previousMode}）です。AIフォーム入力用に ${getProviderModeLabel(provider.id, nextMode, 'ja')}（${nextMode}）で起動し直します。\n`,
        'system',
        selectedProviderId,
      );
      await startManagedAiSession(nextMode, selectedProviderId, {
        allowReuse: false,
        requireMcp: true,
        autoSendSafe: getManagedAiAutoSendSafe(),
      });
    } catch (error) {
      return {
        ok: false,
        statusCode: 409,
        error: `現在の ${provider.displayName} 起動モードは ${getProviderModeLabel(provider.id, previousMode, 'ja')}（${previousMode}）です。AIフォーム入力用の ${getProviderRecommendedModesText(provider.id, 'ja')} への自動切替に失敗しました: ${error.message || error}`,
      };
    }
  }
  const sender = settings.getSender();
  const missingSenderFields: any[] = [];
  if (!sender.companyName) missingSenderFields.push('会社名');
  if (!sender.name) missingSenderFields.push('担当者名');
  if (!sender.email) missingSenderFields.push('メールアドレス');
  if (!sender.phone) missingSenderFields.push('電話番号');
  if (missingSenderFields.length > 0) {
    return {
      ok: false,
      statusCode: 409,
      error: `送信者設定が不足しています: ${missingSenderFields.join(' / ')}。Settings で必須項目を入力してください。`,
    };
  }
  return {
    ok: true,
    auth,
    providerId: selectedProviderId,
    provider,
    execution: 'managed',
  };
}

async function runParallelAnalysisWorker(company, nodeExecutable) {
  const { spawn } = require('child_process');
  const startedAtMs = Date.now();
  const payload = JSON.stringify({
    no: company.no,
    companyName: company.companyName || company.name || '',
    url: company.url || '',
    type: company.type || '',
    formUrl: company.formUrl || '',
  });

  // 常に process.execPath を使う:
  // - Electron 配下: process.execPath = "Sales Claw.exe" (本物の .exe)。
  //   ELECTRON_RUN_AS_NODE=1 で Node モードで起動し .cjs を実行できる。
  // - 素の Node 配下: process.execPath = "node.exe"。ELECTRON_RUN_AS_NODE=1
  //   は Node 側で無視されるので安全。
  // 過去の実装は nodeExecutable 引数を最優先していたが、resolveNodeExecutable()
  // が Windows で `<toolchain>/bin/node.cmd` (=.cmd shim) を返すため、
  // `spawn(.cmd, args, { shell: false })` が EINVAL になっていた。
  // process.execPath は必ず .exe なので EINVAL は起きない。
  // nodeExecutable パラメータは互換性のため残すが未使用扱い。
  const exe = process.execPath;
  // env のサニタイズは intermediate な Node 子プロセス起動でも実施する。
  // parallel-analysis.cjs は内部で llm-site-analyzer / llm-message-generator を
  // require して claude -p を spawn するため、その子プロセスに ANTHROPIC_API_KEY
  // が漏れると 2026-06-15 以降の Programmatic Credit 枠ではなく API 従量制で
  // 課金される。leaf 側でもサニタイズしているが、二重防御で intermediate でも
  // 削っておく (parallel-analysis.cjs から別経路で AI を呼ばれた場合の保険)。
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { buildSanitizedSpawnEnv, stripSanitizerMeta } = require('./spawn-env-sanitizer');
  // provider-home: parallel-analysis.cjs から呼ばれる CLI は 'claude' を想定
  // (settings.aiProvider が codex/gemini でも、その provider の HOME を解決する
  // ロジックは leaf 側で持つので、ここでは claude の provider-home のみ仕込む)
  const providerHomeDir = getManagedProviderHome('claude');
  const sanitizedEnv = buildSanitizedSpawnEnv({
    providerId: 'claude',
    providerHomeDir,
    extraEnv: {
      ELECTRON_RUN_AS_NODE: '1',
      SALES_CLAW_CLI_TOKEN: process.env.SALES_CLAW_CLI_TOKEN || CLI_LOG_SECRET,
    },
  });
  const spawnEnv = stripSanitizerMeta(sanitizedEnv);

  return await new Promise<any>((resolve) => {
    // 1.2.111+: TS port 後の実行ファイルは dist-ts/src/parallel-analysis.js。
    // 旧 src/parallel-analysis.cjs は存在しないため Cannot find module で
    // Phase A が必ず失敗していた。
    const child = spawn(exe, ['dist-ts/src/parallel-analysis.js', payload], {
      cwd: PROJECT_ROOT,
      env: spawnEnv,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // v2.0.49: auth-failure 検知時に Set 経由で SIGTERM できるよう追跡。
    //   markClaudeAuthFailed() が呼ばれると全 child を kill して Phase A workers を
    //   即座に止める。close で必ず remove (kill 経由でも close は発火する)。
    activePhaseAChildProcesses.add(child);
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk || '');
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk || '');
    });
    child.on('error', (error) => {
      activePhaseAChildProcesses.delete(child);
      resolve({
        ok: false,
        companyNo: company.no,
        companyName: company.companyName || company.name || '',
        elapsedMs: Date.now() - startedAtMs,
        error: error.message || 'parallel-analysis spawn failed',
        stdout,
        stderr,
      });
    });
    child.on('close', (exitCode) => {
      activePhaseAChildProcesses.delete(child);
      const parsed = extractPromptJsonLine(stdout);
      if (parsed && parsed.ok) {
        resolve({
          ok: true,
          companyNo: company.no,
          companyName: company.companyName || company.name || '',
          elapsedMs: Date.now() - startedAtMs,
          analysis: parsed.analysis || null,
          message: typeof parsed.message === 'string' ? parsed.message : '',
          messagePrompt: typeof parsed.messagePrompt === 'string' ? parsed.messagePrompt : '',
          formUrl: parsed.formUrl || company.formUrl || '',
          formResolutionMethod: parsed.formResolutionMethod || null,
          stdout,
          stderr,
        });
        return;
      }
      // 1.2.86 fix: subprocess が { ok:false, skipped:true, skipKind, reason } を返した場合、
      // 親プロセスでも skipped を propagate する。これがないと URL未設定 / 営業お断り 等の
      // 正常 skip が「failures.push(result)」されて「Phase A 全件失敗」と誤表示される。
      // 1.2.87: no フィールドも propagate (parallel-form-fill-api.cjs が s.no を参照する)。
      if (parsed && parsed.skipped === true) {
        resolve({
          ok: false,
          skipped: true,
          skipKind: parsed.skipKind || null,
          reason: parsed.reason || '',
          no: company.no,
          companyNo: company.no,
          companyName: company.companyName || company.name || '',
          elapsedMs: Date.now() - startedAtMs,
          error: parsed.reason || 'skipped',
          stdout,
          stderr,
        });
        return;
      }
      const parsedError = parsed && typeof parsed.error === 'string' ? parsed.error : '';
      const errorText = parsedError
        || trimOneLineText(stderr || stdout || `parallel-analysis exited with code ${exitCode || 0}`, 240)
        || 'parallel-analysis failed';
      // v2.0.49: Phase A subprocess の出力に 401 が混じっていたら global flag を立てる。
      //   これを見て executeBackendPhaseABatch の runOne が次の社に進む前に early exit
      //   する。1 社目で踏んだ 401 で残り 99 社の 401 ログを抑止する。
      if (isClaudeAuthFailureText(errorText) || isClaudeAuthFailureText(stderr) || isClaudeAuthFailureText(stdout)) {
        markClaudeAuthFailed('phase-a-subprocess-401');
      }
      resolve({
        ok: false,
        companyNo: company.no,
        companyName: company.companyName || company.name || '',
        elapsedMs: Date.now() - startedAtMs,
        error: errorText,
        stdout,
        stderr,
      });
    });
  });
}

async function executeBackendPhaseABatch(companies, providerId = getSelectedAiProvider(), options: Record<string, any> = {}) {
  const normalizedProviderId = normalizeProviderId(providerId);
  // v2.0.16: pipeline mode — per-company onSuccess callback で Phase B に
  // 即時 enqueue できるようにする。callback throw は Phase A を巻き込まない。
  const onSuccess: ((result: any, original: any) => void) | null =
    typeof options.onSuccess === 'function' ? options.onSuccess : null;
  // resolveNodeExecutable may return null on machines without system Node.
  // runParallelAnalysisWorker now falls back to Electron's embedded Node
  // via ELECTRON_RUN_AS_NODE, so we no longer hard-fail here.
  const nodeExecutable: any = await resolveNodeExecutable();

  const batchStartedAtMs = Date.now();
  appendDiagnosticEvent('phase_a_batch_started', {
    provider: normalizedProviderId,
    companyCount: companies.length,
  });
  appendAiRunMetric('phase_a_batch_started', {
    provider: normalizedProviderId,
    companyCount: companies.length,
  });

  // 1.2.91 H1 fix: 並列度を semaphore で制限。
  // 元々 Promise.all で無制限並列だったため、100 社で 100 個の Node subprocess →
  // 8-12 GB RSS スパイク → クラッシュ可能性。
  //
  // 1.2.111 (2026-05-13): CPU コア数で並列度を決めると 6-8 並列になり、
  // 各 parallel-analysis.cjs サブプロセスが claude -p を内部 spawn するため
  // 同時に 12-16 個の Claude CLI が走り、Claude Pro レート制限に抵触して
  // LLM 解析が 90 秒タイムアウトしていた。Claude CLI の同時起動を抑えるため
  // Phase A の並列度を 2 に固定する (LLM 解析 + メッセージ生成で実質 4 並列)。
  //
  // v2.0.48 F6: provider-aware に拡張。Claude は Pro 個人プランの厳しいレート
  //   制限のため 2 を維持。Codex (OpenAI) と Gemini はアカウントレートが高く、
  //   実測で 4 並列でも 429 を踏まない (codex は org tier、gemini は AI Studio
  //   実績ベース)。env で override 可能、env 指定がなければ provider 別の既定値を使う。
  //   100 社・Codex/Gemini で Phase A 時間が概ね半減する。
  const phaseAEnvOverride = Number(process.env.SALES_CLAW_PHASE_A_CONCURRENCY);
  const phaseADefaultByProvider: Record<string, number> = {
    claude: 2,
    codex: 4,
    gemini: 4,
  };
  const phaseAMaxByProvider: Record<string, number> = {
    claude: 2,
    codex: 6,
    gemini: 6,
  };
  const phaseAProviderDefault = phaseADefaultByProvider[normalizedProviderId] ?? 2;
  const phaseAProviderMax = phaseAMaxByProvider[normalizedProviderId] ?? 2;
  const phaseAEffective = Number.isFinite(phaseAEnvOverride) && phaseAEnvOverride > 0
    ? phaseAEnvOverride
    : phaseAProviderDefault;
  const PHASE_A_CONCURRENCY = Math.max(1, Math.min(phaseAProviderMax, phaseAEffective));
  const results = new Array(companies.length);
  let nextIdx = 0;
  let phaseAAuthAbortedCount = 0;
  async function runOne() {
    while (true) {
      // v2.0.49: Claude auth 失効 (global flag) を検知したら以降の社をスキップする。
      //   1 社目で 401 を踏んだ時点で markClaudeAuthFailed() が立ち、走行中の
      //   全 worker は次の iteration でここに到達して break する。残り社は
      //   results[idx] = undefined のままになるが、後段の forEach で
      //   failures に分類されて UI に明示メッセージが出る。
      if (isClaudeAuthCurrentlyFailed()) {
        // remaining 社を skipped 扱いで埋めて、UI 側に「auth 失効で中断」を伝える
        while (nextIdx < companies.length) {
          const remIdx = nextIdx++;
          results[remIdx] = {
            ok: false,
            skipped: true,
            skipKind: 'claude_auth_failed',
            reason: 'Claude 認証失効 / レート上限のため Phase A を中断しました',
            no: companies[remIdx].no,
            companyNo: companies[remIdx].no,
            companyName: companies[remIdx].companyName || companies[remIdx].name || '',
            elapsedMs: 0,
            error: 'claude_auth_failed',
          };
          phaseAAuthAbortedCount++;
        }
        break;
      }
      const idx = nextIdx++;
      if (idx >= companies.length) break;
      const result = await runParallelAnalysisWorker(companies[idx], nodeExecutable);
      results[idx] = result;
      // v2.0.16: per-company 成功で即 onSuccess を呼ぶ。Phase B が pipeline で
      // 早期に走り出せる (Phase A 完走を待たない)。callback throw は無視。
      if (onSuccess && result && result.ok) {
        try { onSuccess(result, companies[idx]); } catch (_) { /* swallow */ }
      }
    }
  }
  const workers: any[] = [];
  const workerCount = Math.min(PHASE_A_CONCURRENCY, companies.length);
  for (let i = 0; i < workerCount; i++) workers.push(runOne());
  await Promise.all(workers);
  // v2.0.49: auth 失効で Phase A を中断した社数を診断 + UI に通知。
  if (phaseAAuthAbortedCount > 0) {
    try {
      appendDiagnosticEvent('phase_a_auth_aborted', {
        provider: normalizedProviderId,
        abortedCount: phaseAAuthAbortedCount,
        totalCount: companies.length,
      });
      emitClaudeAutomationLog(
        `[Phase A 中断] Claude 認証失効/レート上限を検知したため、残り ${phaseAAuthAbortedCount}社の分析をスキップしました。/login またはレート枠リセット後に「AI を起動」してください。\n`,
        'warn',
        normalizedProviderId,
      );
    } catch (_) { /* swallow */ }
  }
  const successes: any[] = [];
  const failures: any[] = [];
  const skipped: any[] = [];

  // Phase 0.5 / 0.6 で gate により正常に skipped 判定された企業 (URL 未設定 /
  // 営業お断り / dealBreakers マッチ等) は **failure ではなく skipped** として
  // 別カテゴリに分類する。failure は「subprocess crash / HTTP エラー / 想定外」のみ。
  // この区別がないと「全件 URL 未設定」のケースで「Phase A 全件失敗」と誤表示される。
  results.forEach((result: any) => {
    if (!result) {
      failures.push(result);
    } else if (result.ok) {
      successes.push(result);
    } else if (result.skipped === true) {
      skipped.push(result);
    } else {
      failures.push(result);
    }
  });

  const elapsedMs = Date.now() - batchStartedAtMs;
  appendDiagnosticEvent('phase_a_batch_completed', {
    provider: normalizedProviderId,
    companyCount: companies.length,
    successCount: successes.length,
    skippedCount: skipped.length,
    failureCount: failures.length,
    elapsedMs,
  });
  appendAiRunMetric('phase_a_batch_completed', {
    provider: normalizedProviderId,
    companyCount: companies.length,
    successCount: successes.length,
    skippedCount: skipped.length,
    failureCount: failures.length,
    elapsedMs,
      companies: results.map((result: any) => ({
        companyNo: result && result.no,
        companyName: result && result.companyName,
        ok: !!(result && result.ok),
        skipped: !!(result && result.skipped),
        skipKind: result && result.skipKind || null,
        elapsedMs: result && result.elapsedMs,
        error: result && result.ok ? null : (result && result.error) || null,
        messageChars: result && result.ok ? String(result.message || '').length : 0,
        analysisMode: result && result.ok && result.analysis ? result.analysis.analysisMode || null : null,
        hasFormUrl: !!(result && result.ok && result.formUrl),
        formResolutionMethod: result && result.ok ? result.formResolutionMethod || null : null,
      })),
    });

  return {
    provider: normalizedProviderId,
    nodeExecutable,
    elapsedMs,
    successes,
    skipped,
    failures,
  };
}

function buildClaudeFormFillPrompt(companies, sender, providerId = getManagedAiProvider(), options: Record<string, any> = {}) {
  const configuredScreenshotDir = settings.getScreenshotDir();
  const promptScreenshotDir = configuredScreenshotDir;
  const autoSendSafe = typeof options.autoSendSafe === 'boolean'
    ? options.autoSendSafe
    : getManagedAiAutoSendSafe();
  const phaseAByCompany = options.phaseAByCompany instanceof Map ? options.phaseAByCompany : new Map<any, any>();
  const phaseACompleted = phaseAByCompany.size > 0;

  // Phase 3: 各社の targetLanguage を決定する。
  //   - messageTemplates.language が 'ja' or 'en' で明示されていれば全社をその言語に固定
  //   - 'auto' (default) なら Phase A の analysis.detectedLanguage を採用
  //   - detected が無い / confidence が低い場合は 'ja' に倒す (既存ユーザー互換)
  const messageTemplatesSetting = settings.getSection('messageTemplates') || {};
  const localeOverride: 'auto' | 'ja' | 'en' = (messageTemplatesSetting.language === 'ja' || messageTemplatesSetting.language === 'en')
    ? messageTemplatesSetting.language
    : 'auto';
  const resolveCompanyLocale = (company: any): 'ja' | 'en' => {
    if (localeOverride !== 'auto') return localeOverride;
    const phaseA = phaseAByCompany.get(String(company.no)) || null;
    const det = phaseA && phaseA.analysis && phaseA.analysis.detectedLanguage;
    if (det && (det.language === 'en' || det.language === 'ja') && (det.confidence || 0) >= 0.5) {
      return det.language;
    }
    return 'ja';
  };
  // バッチ全体の代表 locale (batch_rules の言語選択に使う)。多数決で決める。
  const localeCounts: { ja: number; en: number } = { ja: 0, en: 0 };
  (companies || []).forEach((company: any) => {
    const loc = resolveCompanyLocale(company);
    localeCounts[loc] += 1;
  });
  const batchLocale: 'ja' | 'en' = localeCounts.en > localeCounts.ja ? 'en' : 'ja';
  const parallelFastPrompt = options.promptProfile === 'parallel-fast';
  const promptLimits = {
    note: parallelFastPrompt ? 80 : 120,
    messageDraft: parallelFastPrompt ? 700 : 1500,
    messageCore: parallelFastPrompt ? 450 : 900,
    messagePrompt: parallelFastPrompt ? 500 : 2600,
    analysisHint: parallelFastPrompt ? 120 : 160,
    analysisHintCount: parallelFastPrompt ? 3 : 4,
    siteExcerpt: parallelFastPrompt ? 140 : 220,
    automationHint: parallelFastPrompt ? 120 : 160,
    automationHintCount: parallelFastPrompt ? 2 : 3,
    ...(options.promptLimits && typeof options.promptLimits === 'object' ? options.promptLimits : {}),
  };
  const messageTemplates = settings.getSection('messageTemplates') || {};
  const approachObjective = typeof messageTemplates.approachObjective === 'string' ? messageTemplates.approachObjective.trim() : '';
  const approachGuardrails = typeof messageTemplates.approachGuardrails === 'string' ? messageTemplates.approachGuardrails.trim() : '';
  const missingFormUrlCount = (companies || []).filter((company: any) => !String(company.formUrl || '').trim()).length;
  const allFormUrlsResolved = missingFormUrlCount === 0;
  // 1.2.90: URL 不在 (Phase A の analysis.urlMissing===true) 企業数。
  // CLI に「会社名から WebSearch で公式サイトを探索してね」と明示するために集計。
  const missingSiteUrlCount = (companies || []).filter((company: any) => !String(company.url || '').trim()).length;
  const companyPayloadLines = (companies || []).map((company, index) => {
    const phaseA = phaseAByCompany.get(String(company.no)) || null;
    const phaseAMessage = phaseA && phaseA.message ? String(phaseA.message) : '';
    const phaseAMessagePrompt = phaseA && phaseA.messagePrompt ? String(phaseA.messagePrompt) : '';
    const phaseAUrlMissing = !!(phaseA && phaseA.analysis && phaseA.analysis.urlMissing);
    const siteEmpty = !String(company.url || '').trim();
    const compactPayload = {
      index: index + 1,
      no: company.no,
      name: company.companyName || '(不明)',
      type: String(company.type || '').trim() || undefined,
      site: String(company.url || '').trim() || undefined,
      // Phase 3: 各社で使う出力言語 ('ja' | 'en')。CLI が messageDraft を書き換える時の
      // 言語選択に使う。messageTemplates.language='auto' なら detectedLanguage、
      // 明示指定なら固定値。
      targetLanguage: resolveCompanyLocale(company),
      // 1.2.90: ★ URL 不在マーカー — CLI が会社名で公式サイトを WebSearch する必要がある
      urlMissing: (siteEmpty || phaseAUrlMissing) ? true : undefined,
      form: String(company.formUrl || '').trim() || undefined,
      note: company.notes ? trimOneLineText(company.notes, promptLimits.note) : undefined,
      attempt: company.contactNo && company.contactNo > 1 ? company.contactNo : undefined,
      screenshots: {
        input: path.join(promptScreenshotDir, `ss-${company.no}-input.png`),
        confirm: path.join(promptScreenshotDir, `ss-${company.no}-confirm.png`),
        ...(autoSendSafe ? { sent: path.join(promptScreenshotDir, `ss-${company.no}-sent.png`) } : {}),
      },
      // v2.0.22: messageDraft と messageCore は同じ phaseAMessage を異なる
      // 長さで切ったほぼ重複コンテンツ。messageCore を削除して 1 社あたり
      // ~900 chars 節約 (100 社で 90KB / ~22K tokens 削減)。
      messageDraft: trimMultilineText(phaseAMessage, promptLimits.messageDraft) || undefined,
      messagePrompt: compactMessagePromptForPrompt(phaseAMessagePrompt, promptLimits.messagePrompt) || undefined,
      analysisHints: summarizePhaseAAnalysisForPrompt(phaseA && phaseA.analysis)
        .map((line: any) => trimOneLineText(String(line || '').replace(/^- /, ''), promptLimits.analysisHint))
        .filter(Boolean)
        .slice(0, promptLimits.analysisHintCount),
      siteExcerpt: trimOneLineText(phaseA && phaseA.analysis && phaseA.analysis.siteTextExcerpt, promptLimits.siteExcerpt) || undefined,
      automationHints: buildCompanyAutomationHints(company)
        .map((hint: any) => trimOneLineText(hint, promptLimits.automationHint))
        .filter(Boolean)
        .slice(0, promptLimits.automationHintCount),
      formResolution: phaseA && phaseA.formResolutionMethod && company.formUrl
        ? phaseA.formResolutionMethod
        : undefined,
    };
    return JSON.stringify(compactPayload);
  }).join('\n');

  const senderPayload = JSON.stringify(buildCompactSenderPayload(sender));
  const approachPayload = JSON.stringify(buildCompactApproachPayload(approachObjective, approachGuardrails));

  // Phase 3: batch_rules を Locale Pack から取得する。
  // 多数決で決まった batchLocale を採用する (バッチ内の社数比率で ja/en 切替)。
  // v2.0.51: parallelTabs を batchSize に応じて auto-resolve するため、ここで
  // companies.length を渡す。3 社バッチなら 3 並列指示が batch_rules に入る。
  const effectiveParallelTabs = resolvePhaseBParallelTabs(Array.isArray(companies) ? companies.length : 0);
  // v2.0.59: ユーザー設定 (messageTemplates.formPreferences) からフォーム選好を取得。
  //   preferredKeywords: 優先するフォーム名キーワード (例: パートナー, alliance)
  //   avoidKeywords: 避けるフォーム名キーワード (例: FAQ, support)
  //   approachLabel: アプローチ趣旨ラベル (例: 「パートナー営業」「人材紹介」)
  //   未設定なら locale-pack のデフォルト (= パートナー営業向け) が適用される。
  let formPreferences: any = undefined;
  try {
    const mt = messageTemplates || {};
    // v2.0.99: アプローチ意図 (approachTargets) から formPreferences を生成。
    //   明示的な messageTemplates.formPreferences があればそれが優先される (後方互換)。
    //   これにより「協業/採用/広報 …」の選択がフォーム選択優先順位に反映される。
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const approachIntent = require('./approach-intent');
    const targets = settings.getApproachTargets ? settings.getApproachTargets() : null;
    formPreferences = approachIntent.resolveFormPreferences(targets, mt.formPreferences || null);
  } catch (_) { /* 設定欠如時は locale-pack default を使う */ }
  let batchRuleLines: string[] = [];
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getLocalePack } = require('./locale-pack');
    const pack = getLocalePack(batchLocale);
    if (pack && pack.cliPrompts && typeof pack.cliPrompts.buildBatchRules === 'function') {
      batchRuleLines = pack.cliPrompts.buildBatchRules({
        autoSendSafe,
        parallelTabs: effectiveParallelTabs,
        formPreferences,
        formFillMode: getFormFillMode(),
      });
    }
  } catch (_) { /* Locale Pack 不在時は ja パックを再試行する */ }
  if (batchRuleLines.length === 0) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getLocalePack } = require('./locale-pack');
      const pack = getLocalePack('ja');
      if (pack && pack.cliPrompts && typeof pack.cliPrompts.buildBatchRules === 'function') {
        batchRuleLines = pack.cliPrompts.buildBatchRules({
          autoSendSafe,
          parallelTabs: effectiveParallelTabs,
          formPreferences,
          formFillMode: getFormFillMode(),
        });
      }
    } catch (_) { /* 最終 fallback は空配列 */ }
  }

  return [
    'SALES_CLAW_BATCH_PAYLOAD',
    JSON.stringify({
      companyCount: companies.length,
      phaseACompleted,
      autoSendSafe,
      knownFormUrlCount: (companies || []).filter((company: any) => String(company.formUrl || '').trim()).length,
      missingFormUrlCount,
      screenshotDir: promptScreenshotDir,
      configuredScreenshotDir,
      // Phase 3: バッチ全体の locale 情報。CLI 側で「ja サイトと en サイトが混在する」場合を
      // 把握できるよう、各社の targetLanguage は companies_jsonl にも入れている。
      batchLocale,
      localeOverride,
      localeCounts,
    }),
    '',
    'sender_json:',
    senderPayload,
    '',
    'approach_json:',
    approachPayload,
    '',
    'batch_rules:',
    ...buildTabManagementContractLines(),
    ...batchRuleLines,
    '',
    'companies_jsonl:',
    companyPayloadLines,
  ].join('\n');
}

function getClaudeAutomationModel(providerId = getSelectedAiProvider()) {
  const configured = getConfiguredAiModel(providerId);
  return configured || null;
}

function emitClaudeAutomationLog(text, stream = 'stdout', providerId = getManagedAiProvider()) {
  if (!text) return;
  notifyClients({
    type: 'claude-stdout',
    text: String(text),
    stream,
    provider: providerId,
    time: Date.now(),
  });
}

function writeClaudeFormFillPromptFile(companies, promptText, providerId = getManagedAiProvider()) {
  ensureDataDir();
  const promptFile = resolveDataPath(path.join('ai-prompts', `${providerId}-form-fill-${Date.now()}.md`));
  ensureParentDir(promptFile);
  const summary = (companies || []).map((company: any) => `- ${company.no}: ${company.companyName || company.name || '(unknown)'}`).join('\n');
  const content = [
    `# Sales Claw ${getProviderDisplayName(providerId)} Automation Request`,
    `Created: ${new Date().toISOString()}`,
    '',
    '## Companies',
    summary || '- none',
    '',
    '## Instructions',
    promptText,
    '',
  ].join('\n');
  fs.writeFileSync(promptFile, content, 'utf8');
  return promptFile;
}

function writeWorkspaceClaudeFormFillPromptFile(companies, promptText, providerId = getManagedAiProvider()) {
  const promptFile = resolveDataPath('.sales-claw-work', 'ai-prompts', `${providerId}-form-fill-${Date.now()}.md`);
  ensureParentDir(promptFile);
  const summary = (companies || []).map((company: any) => `- ${company.no}: ${company.companyName || company.name || '(unknown)'}`).join('\n');
  const content = [
    `# Sales Claw ${getProviderDisplayName(providerId)} Automation Request`,
    `Created: ${new Date().toISOString()}`,
    '',
    '## Companies',
    summary || '- none',
    '',
    '## Instructions',
    promptText,
    '',
  ].join('\n');
  fs.writeFileSync(promptFile, content, 'utf8');
  return promptFile;
}

function queueClaudeFormFillInManagedSession(companies, providerId = getManagedAiProvider(), options: Record<string, any> = {}) {
  if (!claudePty) {
    throw new Error('Managed AI session is not running.');
  }
  const normalizedProviderId = normalizeProviderId(providerId);
  const provider = getProvider(normalizedProviderId);
  const state = getManagedAiSessionState();
  const autoSendSafe = typeof options.autoSendSafe === 'boolean'
    ? options.autoSendSafe
    : getManagedAiAutoSendSafe();
  const sender = settings.getSender();
  const phaseAByCompany = options.phaseAByCompany instanceof Map ? options.phaseAByCompany : new Map<any, any>();
  const needsSessionContract = state.contractVersionSent !== MANAGED_AI_CONTRACT_VERSION;
  const sessionContractText = needsSessionContract
    ? buildManagedAiSessionContract(normalizedProviderId, { autoSendSafe })
    : '';
  const fullMessageChars = companies.reduce((total: any, company: any) => {
    const phaseA = phaseAByCompany.get(String(company.no)) || null;
    return total + String(phaseA && phaseA.message ? phaseA.message : '').length;
  }, 0);
  const compactMessageChars = companies.reduce((total: any, company: any) => {
    const phaseA = phaseAByCompany.get(String(company.no)) || null;
    return total + compactMessageForPrompt(phaseA && phaseA.message, sender).length;
  }, 0);
  const promptText = buildClaudeFormFillPrompt(companies, sender, normalizedProviderId, options);
  const promptFile = writeClaudeFormFillPromptFile(companies, promptText, normalizedProviderId);
  const workspacePromptFile = writeWorkspaceClaudeFormFillPromptFile(companies, promptText, normalizedProviderId);
  const model = getClaudeAutomationModel(normalizedProviderId);
  // v2.0.19: 2 回目以降のバッチでは provider preamble + curl 例を省略する。
  // 100 社をバッチサイズ 10 で投入すると 10 バッチ送るが、curl 例 4 種だけで
  // 約 1500 chars (~375 tokens) × 10 = 3750 tokens 節約 / 100 社あたり。
  // session contract と同じ思想で「最初の 1 バッチに instructions、以降は payload のみ」。
  const isFirstBatchInSession = needsSessionContract;
  // v2.0.53: 初回バッチの instructions と curl 例を圧縮 (~2300 chars 削減)。
  //   旧仕様: 13 行の instructions + 4 種類の curl 例 (各 200+ chars) = ~3500 chars
  //   重複: session_contract と CAPTCHA / awaiting_approval ルールが二重定義されていた
  //   新仕様: contract に無い差分 (urlMissing / messageCore / 進行報告) のみ instructions に残し、
  //          curl は 1 つのテンプレートで details だけ差し替える形式に統一。
  //          実機 prompt 中央値 13K chars → 10.7K chars 目標 (Phase B 全体 ~10% トークン削減)
  const curlTemplate = `curl -s -X POST -H "Content-Type: application/json" -H "x-sales-claw-session: \${SALES_CLAW_SESSION}" -d '<JSON>' \${SALES_CLAW_DASHBOARD_URL:-http://127.0.0.1:3765}/api/log-action`;
  const messageLines = isFirstBatchInSession ? [
    `Sales Claw batch payload。${provider.cliLabel} + MCP Playwright で実行。前回会話は引き継がず、この batch のみ実行。`,
    'Phase A は backend 完了済み (再分析・再生成・settings 更新はしない)。',
    'urlMissing=true → WebSearch で「会社名 公式サイト」検索 → 公式ドメイン特定 → サイト確認 → 本文生成 → フォーム入力。公式サイト不明なら error。',
    'urlMissing=false かつ siteExcerpt 空 / 取得失敗 → 本文推測せず error。',
    '本文は companies_jsonl の messageCore を基準に、sender_json の署名・送信停止案内・住所(ある場合)で補完。社員数・設立年・資本金など sender_json に無い値は推測しない。',
    autoSendSafe
      ? 'CAPTCHA / 手動必須項目 / 営業NG / 不確実以外は自動送信 → ss-{No}-sent.png → submitted。送信不要は ss-{No}-input.png → awaiting_approval。'
      : '送信せず ss-{No}-input.png → awaiting_approval で停止。',
    '',
    `★ ログ記録 (必須・省略不可、20 分無応答で auto-error 化)。テンプレ:`,
    '```',
    curlTemplate,
    '```',
    '<JSON> 例 (action 別 details はこれだけ差し替える):',
    `  awaiting_approval: {"no":<No>,"name":"<会社名>","action":"awaiting_approval","details":{"reason":"<理由>","sentMessage":"<入力本文全文>","screenshot":"ss-<No>-input.png","tabKept":true}}`,
    `  submitted:         {"no":<No>,"name":"<会社名>","action":"submitted","details":{"sentMessage":"<入力本文全文>","screenshot":"ss-<No>-sent.png"}}`,
    `  skipped:           {"no":<No>,"name":"<会社名>","action":"skipped","details":"<理由>"}`,
    `  error:             {"no":<No>,"name":"<会社名>","action":"error","details":"<理由>"}`,
    '会社名は JSON エスケープ ("/\\)。SALES_CLAW_SESSION / SALES_CLAW_DASHBOARD_URL は PTY 起動時に env 注入済み。',
    '',
    '★★★ MUST: 本文に **日本語 / 改行 / 引用符** を含む場合 (= ほぼすべてのケース)、',
    '    curl の -d "..." 直接渡しは Windows cmd.exe codepage CP932 で日本語が `?` に化ける。',
    '    必ず以下の sentMessageFile 経路を使うこと:',
    '    Step 1: Write tool で UTF-8 (BOM 無し) のテキストファイルを作成',
    '        例: Write file_path=C:\\\\Users\\\\<user>\\\\AppData\\\\Local\\\\Temp\\\\body-<No>.txt content=<本文全文>',
    '    Step 2: details に "sentMessageFile":"<absolute path>" を指定 (sentMessage は省略可)',
    '    例: {"no":<No>,"name":"<会社名>","action":"awaiting_approval","details":{"sentMessageFile":"C:\\\\Users\\\\xxx\\\\AppData\\\\Local\\\\Temp\\\\body-<No>.txt","screenshot":"ss-<No>-input.png","tabKept":true,"reason":"<理由>","finalFormTab":"<実際のフォームURL>"}}',
    '    → サーバが %TEMP% / OS tmp / Sales Claw data dir 配下から本文を読み、UTF-8 文字化け無しで sentMessage 記録。',
    '★★ サーバは sentMessage に `?` を 3 文字以上連続検出すると 422 で reject する。リトライ時は sentMessageFile を使うこと。',
    '',
    '--- BEGIN SALES CLAW BATCH ---',
    promptText,
    '--- END SALES CLAW BATCH ---',
  ] : [
    // v2.0.19: 2 回目以降のバッチは payload のみ。instructions は既に文脈にある。
    `Sales Claw batch #${(state.batchCount || 0) + 1} (${companies.length}社)。前バッチと同じルールで処理してください。`,
    '',
    '--- BEGIN SALES CLAW BATCH ---',
    promptText,
    '--- END SALES CLAW BATCH ---',
  ];
  state.batchCount = (state.batchCount || 0) + 1;
  if (model && normalizedProviderId === 'claude' && isFirstBatchInSession) {
    messageLines.splice(1, 0, `優先モデル: ${model}`);
  }

  const targets = companies.map((company: any) => ({
    companyNo: company.no,
    companyName: company.companyName || company.name || '',
  }));
  setTargets(targets, true);

  companies.forEach((company: any) => {
    updateLiveMonitor(company.no, {
      source: `${provider.id}-cli`,
      companyNo: company.no,
      companyName: company.companyName || company.name || '',
      status: 'queued',
      step: `${provider.displayName} CLI にキュー投入（2フェーズ並列処理）`,
      currentUrl: company.formUrl || company.url || '',
    });
  });

  emitClaudeAutomationLog(`[AIフォーム入力開始] ${companies.length}社の2フェーズ並列処理を ${provider.displayName} CLI に依頼しました。\n  フェーズA: 企業分析+メッセージ生成（並列）\n  フェーズB: フォーム入力（順次）\n  送信ポリシー: ${autoSendSafe ? '安全なフォームは自動送信' : '確認待ちで停止'}\n`, 'system', providerId);
  // 全プロバイダーで直接テキスト送信に統一（@file参照はGemini PTYで動作しないため）
  const queuedPrompt = [
    ...(needsSessionContract ? [sessionContractText, ''] : []),
    ...messageLines,
  ].join('\n');
  appendAiRunMetric('phase_b_prompt_compiled', {
    provider: normalizedProviderId,
    companyCount: companies.length,
    knownFormUrlCount: companies.filter((company: any) => String(company.formUrl || '').trim()).length,
    missingFormUrlCount: companies.filter((company: any) => !String(company.formUrl || '').trim()).length,
    promptChars: promptText.length,
    promptLines: promptText.split(/\r?\n/).length,
    queuedPromptChars: queuedPrompt.length,
    queuedPromptLines: queuedPrompt.split(/\r?\n/).length,
    estimatedPromptTokens: estimateTextTokens(queuedPrompt),
    sessionContractInjected: needsSessionContract,
    sessionContractChars: sessionContractText.length,
    messageFullChars: fullMessageChars,
    messageCoreChars: compactMessageChars,
    messageTrimmedChars: Math.max(0, fullMessageChars - compactMessageChars),
    autoSendSafe,
    phaseASuccessCount: Array.isArray(options.phaseASuccesses) ? options.phaseASuccesses.length : null,
    phaseAFailureCount: Array.isArray(options.phaseAFailures) ? options.phaseAFailures.length : null,
    parallelTabs: getPhaseBParallelTabs(),
  });
  const queueState = queueManagedAiPrompt(queuedPrompt, normalizedProviderId);
  if (needsSessionContract) {
    state.contractVersionSent = MANAGED_AI_CONTRACT_VERSION;
  }
  notifyClients({ type: 'update', reason: 'claude-automation-queued', time: Date.now() });
  invalidateAiStatusCache(normalizedProviderId);
  return {
    ok: true,
    count: companies.length,
    provider: normalizedProviderId,
    providerLabel: provider.displayName,
    mode: `${provider.id}-cli-managed`,
    autoSendSafe,
    promptFile,
    workspacePromptFile,
    queued: queueState.queued,
    ready: queueState.ready,
    phaseASuccessCount: Array.isArray(options.phaseASuccesses) ? options.phaseASuccesses.length : undefined,
    phaseAFailureCount: Array.isArray(options.phaseAFailures) ? options.phaseAFailures.length : undefined,
    };
}

async function queueAiFormFill(companies, providerId = getSelectedAiProvider(), options: Record<string, any> = {}) {
  const normalizedProviderId = normalizeProviderId(providerId);
  const autoSendSafe = typeof options.autoSendSafe === 'boolean'
    ? options.autoSendSafe
    : getManagedAiAutoSendSafe();
  const provider = getProvider(normalizedProviderId);
  const controller = ensureManagedAiBatchController(normalizedProviderId, autoSendSafe);
  const batchSize = getManagedAiFormBatchSize();
  const batches = chunkManagedAiCompanies(companies, batchSize);
  const batchItems = batches.map((batchCompanies: any) => ({
    id: `${Date.now()}-${++controller.batchCounter}`,
    companies: batchCompanies,
    options: buildManagedAiBatchOptionsSubset({
      ...options,
      autoSendSafe,
    }, batchCompanies),
  }));

  // v2.0.10: defensive — controller.pending を Array に揃える
  if (!Array.isArray(controller.pending)) controller.pending = [];
  controller.pending.push(...batchItems);
  // v2.0.14: バッチ enqueue 時に sleep 防止を発動
  startPowerSaveBlockerIfPossible();
  appendDiagnosticEvent('managed_ai_batches_enqueued', {
    provider: normalizedProviderId,
    companyCount: companies.length,
    batchCount: batchItems.length,
    batchSize,
    activeBatchId: controller.activeBatch ? controller.activeBatch.id : null,
    pendingBatchCount: controller.pending.length,
  });
  appendAiRunMetric('managed_ai_batches_enqueued', {
    provider: normalizedProviderId,
    companyCount: companies.length,
    batchCount: batchItems.length,
    batchSize,
    pendingBatchCount: controller.pending.length,
  });

  let dispatchResult: any = null;
  if (!controller.activeBatch) {
    dispatchResult = dispatchNextManagedAiFormFillBatch();
  } else {
    startManagedAiBatchPoller();
  }

  return {
    ok: true,
    count: companies.length,
    provider: normalizedProviderId,
    providerLabel: provider.displayName,
    mode: `${provider.id}-cli-managed`,
    autoSendSafe,
    batchCount: batchItems.length,
    batchSize,
    activeBatchId: controller.activeBatch ? controller.activeBatch.id : null,
    pendingBatchCount: controller.pending.length + (controller.activeBatch ? 1 : 0),
    ...(dispatchResult || {}),
  };
}

// 同時 launch を直列化するためのキュー。複数の `/api/launch-ai` が同時に走ると
// claudePty / managedAiSessionState のグローバル変数が race condition で壊れ、
// PTY が孤児になったり、setManagedAiSession 内で uncaughtException が発生する。
// stop / timeout でキャンセルされた古い launch が後から PTY を生やさないよう、
// generation token と stale-lock recovery を併用する。
function createLaunchCancelledError(reason = 'cancelled') {
  const err: any = new Error(reason === 'timeout' ? 'AI launch timed out and was cancelled.' : 'AI launch was cancelled.');
  err.code = 'LAUNCH_CANCELLED';
  err.reason = reason;
  return err;
}

function assertManagedAiLaunchActive(launchToken, checkpoint = '') {
  if (launchToken != null && launchToken !== _launchGeneration) {
    throw createLaunchCancelledError(checkpoint || 'cancelled');
  }
}

function cancelManagedAiLaunch(reason = 'cancelled') {
  if (_launchInFlight) {
    appendDiagnosticEvent('managed_ai_launch_cancel_requested', {
      reason,
      ageMs: _launchInFlightStartedAt ? Date.now() - _launchInFlightStartedAt : null,
      killedChildren: _launchSpawnedChildren.size,
    });
  }
  _launchGeneration += 1;
  _launchInFlight = null;
  _launchInFlightStartedAt = 0;
  // 走っている mcp list / mcp add / version probe などを kill する。
  // これをやらないと cancel 後も 30s の mcp add が完走するまで待たされ、
  // 次の launch が「launch already in progress」で弾かれてしまう。
  if (_launchSpawnedChildren.size > 0) {
    for (const child of Array.from(_launchSpawnedChildren)) {
      try {
        if (child && !child.killed) child.kill();
      } catch (_) { /* already dead */ }
      _launchSpawnedChildren.delete(child);
    }
  }
}

async function startManagedAiSession(mode = 'default', providerId = getSelectedAiProvider(), options: Record<string, any> = {}) {
  // Serialize concurrent launches: if one is in progress, await it before starting a new one.
  while (_launchInFlight) {
    const existingLaunch = _launchInFlight;
    const ageMs = Date.now() - _launchInFlightStartedAt;
    if (ageMs > MANAGED_AI_LAUNCH_LOCK_STALE_MS) {
      appendDiagnosticEvent('managed_ai_launch_lock_stale', { ageMs });
      cancelManagedAiLaunch('stale-lock');
      break;
    }
    const remainingMs = Math.max(250, MANAGED_AI_LAUNCH_LOCK_STALE_MS - ageMs);
    await Promise.race([
      existingLaunch.catch(() => null),
      new Promise<any>((resolve) => setTimeout(resolve, Math.min(500, remainingMs))),
    ]);
    if (_launchInFlight === existingLaunch) continue;
  }
  const launchToken = ++_launchGeneration;
  const promise = (async () => _startManagedAiSessionImpl(mode, providerId, { ...options, launchToken }))();
  _launchInFlight = promise;
  _launchInFlightStartedAt = Date.now();
  try {
    return await promise;
  } finally {
    if (_launchInFlight === promise) {
      _launchInFlight = null;
      _launchInFlightStartedAt = 0;
    }
  }
}

// v2.0.96: 確認待ち→AI送信 など「後から prompt を投げたい」経路用。
//   managed PTY が idle watchdog で reap されていても、ログイン済みなら自動で
//   セッションを再起動してから queue できるようにする (ユーザーに再度「AI起動」を
//   押させない)。未ログイン/未インストール時は ensureClaudeAutomationReady の
//   actionable エラーをそのまま返す。
async function ensureManagedAiReadyForPrompt(providerId = getSelectedAiProvider()) {
  const normalizedProviderId = normalizeProviderId(providerId);
  if (claudePty && getManagedAiProvider() === normalizedProviderId) {
    return { ok: true, alreadyRunning: true };
  }
  const ready: any = await ensureClaudeAutomationReady(normalizedProviderId);
  if (!ready.ok) return ready;
  try {
    await startManagedAiSession('default', normalizedProviderId, { allowReuse: true });
    return { ok: true, relaunched: true };
  } catch (e: any) {
    return { ok: false, statusCode: 500, error: 'managed AI セッションの再起動に失敗しました: ' + (e && e.message || e) };
  }
}

async function _startManagedAiSessionImpl(mode = 'default', providerId = getSelectedAiProvider(), options: Record<string, any> = {}) {
  const normalizedProviderId = normalizeProviderId(providerId);
  const provider = getProvider(normalizedProviderId);
  const launchToken = options.launchToken;
  const cols = Math.max(2, Math.min(PTY_MAX_COLS, Math.floor(Number(options.cols) || 120)));
  const rows = Math.max(1, Math.min(PTY_MAX_ROWS, Math.floor(Number(options.rows) || 30)));
  const allowReuse = options.allowReuse !== false;
  // v2.0.49: allowReuse=false は「ユーザーが新規セッションを意図して起動した」を
  //   意味する (UI の「AI を起動」ボタン / auto-recovery 経路)。ユーザーが /login を
  //   済ませた前提で auth 失効 flag をクリアし、Phase A workers が再開できるようにする。
  if (!allowReuse) {
    clearClaudeAuthFailedFlag();
    // suppressAutoRecovery も同時に解除 (auth 復旧したのでまた recover してよい)
    managedAiSuppressAutoRecovery = false;
  }
  const autoSendSafe = typeof options.autoSendSafe === 'boolean'
    ? options.autoSendSafe
    : getConfiguredAiAutoSendSafe();
  assertManagedAiLaunchActive(launchToken, 'start');

  if (claudePty
    && allowReuse
    && getManagedAiProvider() === normalizedProviderId
    && String(claudeProcessMode || '') === String(mode || '')
    && getManagedAiAutoSendSafe() === autoSendSafe) {
    return {
      ok: true,
      mode,
      provider: normalizedProviderId,
      providerLabel: provider.displayName,
      reused: true,
      autoSendSafe,
    };
  }

  if (claudePty) {
    await stopManagedClaudePty({ suppressAutoRecovery: true });
    assertManagedAiLaunchActive(launchToken, 'after-stop-existing');
    claudePty = null;
  }

  if (normalizedProviderId === 'codex') {
    ensureCodexWorkspaceTrusted(PROJECT_ROOT);
  }
  if (normalizedProviderId === 'gemini') {
    ensureGeminiWorkspaceTrusted(PROJECT_ROOT);
  }
  const launchEnv = buildManagedProviderEnv(normalizedProviderId);
  const executable: any = await resolveClaudeExecutable(normalizedProviderId);
  assertManagedAiLaunchActive(launchToken, 'after-resolve-executable');
  if (process.platform === 'win32' && executable === provider.id) {
    // 未インストール時はユーザがコピペで実行できるコマンドを構造化エラーで返す。
    // `npm install -g @<package>` が最も簡単な手順なので、まずそれを案内する。
    const installCommand = `npm install -g ${provider.installPackage}`;
    const err: any = new Error(
      `${provider.cliLabel} が未インストールです。\n` +
      `PowerShell で次のコマンドを実行してください:\n  ${installCommand}\n` +
      `または、ダッシュボードの「AI CLI を準備」ボタンを押すと自動でインストールします。`
    );
    err.code = 'CLI_NOT_INSTALLED';
    err.providerId = normalizedProviderId;
    err.installCommand = installCommand;
    err.providerLabel = provider.displayName;
    throw err;
  }
  // 古い CLI を検出 → 起動前に actionable error を投げる。
  // Codex 0.118 は gpt-5.5 に対応していない / 2026-05-08 でサポート終了するため、
  // 0.128+ への更新を促す (ai-providers.cjs の minRecommendedCliVersion)。
  if (provider.minRecommendedCliVersion) {
    try {
      const probe: any = await runProviderCliCommand(normalizedProviderId, ['--version'], {
        timeout: 5000,
        env: launchEnv,
      });
      assertManagedAiLaunchActive(launchToken, 'after-version-probe');
      const versionLine = String(probe.stdout || probe.stderr || '').trim().split('\n')[0].trim();
      const warning = getProviderVersionWarning(normalizedProviderId, versionLine);
      if (warning) {
        const err: any = new Error(
          `${warning.message}\n` +
          `PowerShell で次のコマンドを実行して更新してください:\n  ${warning.updateCommand}`
        );
        err.code = 'CLI_TOO_OLD';
        err.providerId = normalizedProviderId;
        err.providerLabel = provider.displayName;
        err.installedVersion = warning.installedVersion;
        err.minVersion = warning.minVersion;
        err.updateCommand = warning.updateCommand;
        throw err;
      }
    } catch (e) {
      if (e && e.code === 'CLI_TOO_OLD') throw e;
      if (e && e.code === 'LAUNCH_CANCELLED') throw e;
      // version 取得そのものが失敗した場合は警告のみ。launch は続行。
      console.warn('[launch-ai] version probe failed:', e && e.message || e);
    }
  }
  // MCP Playwright check is blocking only when the launcher explicitly demands it
  // (i.e. batch / form-fill paths). When launched from the in-browser terminal we
  // treat the failure as a warning and let the user start an interactive session;
  // the batch flow will re-validate separately when it actually needs MCP.
  const playwrightSetup: any = await ensureProviderPlaywrightMcp(normalizedProviderId, { env: launchEnv });
  assertManagedAiLaunchActive(launchToken, 'after-mcp-setup');
  // v2.1.0 Phase 2d: internal form MCP も並行 ensure (mode に応じて挙動分岐)
  try {
    const internalFormSetup: any = await ensureProviderInternalFormMcp(normalizedProviderId, { env: launchEnv });
    if (!internalFormSetup.ok) {
      appendDiagnosticEvent('mcp_internal_form_setup_failed', {
        provider: normalizedProviderId, error: String(internalFormSetup.error || ''),
      });
    }
  } catch (e) {
    // best-effort: 失敗しても launch を止めない (Phase 3 で必要に応じて escalate)
    appendDiagnosticEvent('mcp_internal_form_setup_threw', {
      provider: normalizedProviderId, error: e instanceof Error ? e.message : String(e),
    });
  }
  let mcpWarning: any = null;
  if (!playwrightSetup.ok) {
    if (options && options.requireMcp) {
      throw new Error(playwrightSetup.error);
    }
    mcpWarning = playwrightSetup.error || `${provider.displayName} で MCP Playwright の設定確認に失敗しました (バッチ送信時のみ必要)。`;
    console.warn('[launch-ai] non-blocking MCP warning:', mcpWarning);
  }

  // v2.0.46: --session-id を外し、Claude を素の interactive モードで起動する。
  //   旧仕様: 毎回 crypto.randomUUID() で --session-id を渡していた
  //     → Claude CLI が「指定 session の単発タスク」として扱い、応答後に
  //       "Resume this session with: claude --resume <uuid>" を出して exit code 0
  //       で終了。
  //     → Sales Claw の recovery が毎バッチ後に発火 → 新 PTY launch → 認証/path
  //       resolution エラーで連続失敗 → ユーザーが「ログイン求められる」と認識。
  //   新仕様: session-id 無しなら interactive モードでプロンプト待機のまま留まる。
  //     1 PTY で 20 社でも 100 社でもバッチを順次投入できる
  //     (ユーザー設計の「同じターミナルに次のバッチ投げていく」が成立する)。
  const flags = buildLaunchArgs(normalizedProviderId, mode, {
    model: getConfiguredAiModel(normalizedProviderId),
    // sessionId: 削除済み (v2.0.46) — Claude 自動 exit 防止
  });
  const spawnSpec = buildManagedSpawnSpec(normalizedProviderId, executable, flags);
  assertManagedAiLaunchActive(launchToken, 'before-spawn');
  let ptyProc;
  try {
    const nodePty = require('node-pty');
    ptyProc = nodePty.spawn(spawnSpec.command, spawnSpec.args, {
      name: 'xterm-256color',
      cols,
      rows,
      // Phase 0.6: cwd を書き込み可能領域に。packaged Electron では
      // PROJECT_ROOT (C:\Program Files\...) を CLI に渡すと scratch 書き込み
      // で EPERM。getCliWorkspaceDir() が dev/packaged を判定して切替える。
      cwd: getCliWorkspaceDir(),
      env: launchEnv,
    });
    assertManagedAiLaunchActive(launchToken, 'after-spawn');
  } catch (error) {
    if (ptyProc) {
      try { ptyProc.kill(); } catch (_) {}
    }
    if (error && error.code === 'LAUNCH_CANCELLED') throw error;
    appendDiagnosticEvent('managed_ai_spawn_failed', {
      provider: normalizedProviderId,
      mode,
      command: spawnSpec.command,
      argsType: Array.isArray(spawnSpec.args) ? 'array' : typeof spawnSpec.args,
      error: error && error.stack ? String(error.stack).slice(0, 2000) : String(error && error.message || error),
    });
    throw new Error(`${provider.displayName} CLI の起動に失敗しました: ${error && error.message ? error.message : String(error)}`);
  }

  claudePty = ptyProc;
  claudeProcessMode = mode;
  activeAiProvider = normalizedProviderId;
  managedAiAutoSendSafe = autoSendSafe;
  clearManagedAiRecoveryTimer();
  resetManagedAiSessionState(normalizedProviderId);
  resetManagedAiBatchController();
  invalidateAiStatusCache(normalizedProviderId);

  ptyProc.onData((data) => {
    // 個別 try/catch で隔離し、1 つの分析関数が throw しても他の処理と
    // process 全体を巻き込まないようにする。
    try { updateManagedAiReadyFromOutput(normalizedProviderId, data); }
    catch (e) { console.warn('[pty-data] updateReady failed:', e && e.message || e); }
    try { appendManagedAiPtyLog(normalizedProviderId, data, 'output'); }
    catch (e) { console.warn('[pty-data] appendLog failed:', e && e.message || e); }
    try { broadcastPty({ type: 'output', data, provider: normalizedProviderId }); }
    catch (e) { console.warn('[pty-data] broadcast failed:', e && e.message || e); }
    try { detectCliIssuesFromOutput(data, normalizedProviderId); }
    catch (e) { console.warn('[pty-data] detectIssues failed:', e && e.message || e); }
    // P1-5: paste banner 検出。Claude UI が "[Pasted text" を表示したら
    // 即座に 2 回目の Enter を送って expand+実行を起動する。
    // 30 秒の hardcoded 遅延 (前述) はフォールバックとして残す。
    try { detectPasteBannerAndAdvance(data, normalizedProviderId); }
    catch (e) { console.warn('[pty-data] pasteBanner failed:', e && e.message || e); }
  });

  ptyProc.onExit(({ exitCode }) => { try {
    const recoverySnapshot = snapshotManagedAiBatchesForRecovery();
    const suppressRecovery = managedAiSuppressAutoRecovery;
    managedAiSuppressAutoRecovery = false;
    if (claudePty === ptyProc) {
      claudePty = null;
      clearManagedAiSessionStateTimers();
      managedAiSessionState = null;
      invalidateAiStatusCache(normalizedProviderId);
    }
    clearManagedAiRecoveryTimer();
    // v2.1.0: サーキットブレーカ。短時間に繰り返しクラッシュしているなら自動復旧を止める。
    const breakerTripped = !suppressRecovery && recoverySnapshot && recordPtyExitAndCheckBreaker();
    if (breakerTripped) {
      appendDiagnosticEvent('managed_ai_recovery_circuit_open', {
        provider: normalizedProviderId,
        exitCode,
        exitsInWindow: managedAiRecentPtyExits.length,
        windowMs: RECOVERY_BREAKER_WINDOW_MS,
      });
      emitClaudeAutomationLog(
        `[自動復旧を停止] ${getProviderDisplayName(normalizedProviderId)} が短時間に ${managedAiRecentPtyExits.length} 回終了しました。自動復旧を一旦停止します。認証 (CLI のログイン状態) と設定を確認し、問題が解消したら手動で再度「AI を起動」してください。\n`,
        'warn',
        normalizedProviderId,
      );
      resetManagedAiBatchController();
      managedAiRecoveryState = null;
      managedAiRecentPtyExits = []; // ブレーカ作動後はリセット (次の手動起動からカウントし直す)
    } else if (!suppressRecovery && recoverySnapshot && recoverySnapshot.providerId === normalizedProviderId) {
      managedAiRecoveryState = {
        ...recoverySnapshot,
        retries: 0,
        inFlight: false,
      };
      appendDiagnosticEvent('managed_ai_recovery_queued', {
        provider: normalizedProviderId,
        exitCode,
        batchCount: recoverySnapshot.batches.length,
      });
      managedAiRecoveryTimer = setTimeout(() => {
        Promise.resolve(tryRecoverManagedAiSession('pty-exit')).catch((e) => {
          console.warn('[recovery] pty-exit recovery rejected:', e && e.message || e);
        });
      }, 2500);
      if (typeof managedAiRecoveryTimer.unref === 'function') managedAiRecoveryTimer.unref();
    } else {
      resetManagedAiBatchController();
      if (!managedAiRecoveryState || suppressRecovery) {
        // suppressRecovery=true の場合は呼び出し元が再起動/復旧を制御する
      } else {
        managedAiRecoveryState = null;
      }
    }
    if (!suppressRecovery && !recoverySnapshot) {
      try {
        const { getLiveMonitorSummary, finishLiveMonitor: finishMon } = require('./live-monitor');
        const summary = getLiveMonitorSummary();
        const stuckSessions = (summary.events || []).filter(ev =>
          ev && ev.active !== false && !['awaiting_approval', 'submitted', 'completed', 'skipped', 'error'].includes(ev.status)
        );
        stuckSessions.forEach(ev => {
          try {
            finishMon(ev.companyNo, {
              status: 'error',
              step: 'AIセッション終了 (exit code: ' + exitCode + ')',
              companyName: ev.companyName || '',
            });
          } catch (_) {}
        });
        if (stuckSessions.length > 0) {
          console.warn('[ai-exit] ' + stuckSessions.length + '社の未完了セッションをerrorに変更しました');
        }
      } catch (_) {}
    }
    appendManagedAiPtyLog(normalizedProviderId, `process exited with code ${exitCode}`, 'system');
    broadcastPty({ type: 'exit', code: exitCode, provider: normalizedProviderId });
    notifyClients({ type: 'claude-exit', code: exitCode, provider: normalizedProviderId, time: Date.now() });
  } catch (e) {
    // PTY exit handler 内の例外はダッシュボードサーバ全体を落としかねないので
    // 必ず握り潰す。recovery が走らなくても次の手動起動で復活できる。
    console.warn('[pty-exit] handler error:', e && e.stack || e && e.message || e);
  } });

  return {
    ok: true,
    mode,
    provider: normalizedProviderId,
    providerLabel: provider.displayName,
    reused: false,
    autoSendSafe,
  };
}

function buildManagedTerminalViewerUrl() {
  const runtime = dashboardRuntime || readRuntime();
  let baseUrl = runtime && runtime.url ? runtime.url : '';
  if (!baseUrl && server.listening) {
    const address = server.address();
    if (address && typeof address === 'object') {
      const host = !address.address || address.address === '::' ? '127.0.0.1' : address.address;
      baseUrl = `http://${host}:${address.port}`;
    }
  }
  if (!baseUrl) {
    throw new Error('Dashboard runtime URL could not be resolved.');
  }
  const runtimeUrl = new URL(baseUrl);
  const terminalUrl = new URL('/terminal', `${runtimeUrl.protocol === 'https:' ? 'wss:' : 'ws:'}//${runtimeUrl.host}`);
  terminalUrl.searchParams.set('session', ensureDashboardSessionToken());
  return terminalUrl.toString();
}

async function openManagedAiViewerInExternalTerminal(providerId = getManagedAiProvider()) {
  const normalizedProviderId = normalizeProviderId(providerId);
  const provider = getProvider(normalizedProviderId);
  const nodeExecutable: any = await resolveNodeExecutable();
  if (!nodeExecutable || !fs.existsSync(nodeExecutable)) {
    throw new Error('Node.js executable was not found for the external viewer.');
  }

  const viewerScript = path.join(PROJECT_ROOT, 'scripts', 'managed-pty-viewer.cjs');
  if (!fs.existsSync(viewerScript)) {
    throw new Error('Managed PTY viewer script was not found.');
  }

  const viewerUrl = buildManagedTerminalViewerUrl();
  const { spawn } = require('child_process');
  const viewerArgs = [
    escapePowerShellArg(nodeExecutable),
    escapePowerShellArg(viewerScript),
    '--url',
    escapePowerShellArg(viewerUrl),
    '--provider',
    escapePowerShellArg(provider.displayName),
  ];

  if (process.platform === 'win32') {
    const windowTitle = `Sales Claw - ${provider.displayName} Live Viewer`;
    const command = [
      `$Host.UI.RawUI.WindowTitle = ${escapePowerShellArg(windowTitle)}`,
      `Set-Location -LiteralPath ${escapePowerShellArg(PROJECT_ROOT)}`,
      ['&', ...viewerArgs].join(' '),
    ].join('; ');
    const encoded = toPowerShellEncodedCommand(command);
    const child = spawn('cmd.exe', ['/c', 'start', '""', 'powershell.exe', '-NoExit', '-EncodedCommand', encoded], {
      cwd: PROJECT_ROOT,
      env: localToolchain.buildToolEnv(process.env),
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    child.unref();
    return { ok: true, provider: normalizedProviderId, providerLabel: provider.displayName, viewer: true, viewerUrl };
  }

  if (process.platform === 'darwin') {
    const terminalCommand = `cd ${escapePowerShellArg(PROJECT_ROOT)}; ${[...viewerArgs].join(' ')}`;
    const child = spawn('osascript', [
      '-e',
      `tell application "Terminal" to do script ${escapePowerShellArg(terminalCommand)}`,
      '-e',
      'tell application "Terminal" to activate',
    ], {
      cwd: PROJECT_ROOT,
      env: localToolchain.buildToolEnv(process.env),
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return { ok: true, provider: normalizedProviderId, providerLabel: provider.displayName, viewer: true, viewerUrl };
  }

  const terminalPrograms = [
    ['x-terminal-emulator', ['-e', nodeExecutable, viewerScript, '--url', viewerUrl, '--provider', provider.displayName]],
    ['gnome-terminal', ['--', nodeExecutable, viewerScript, '--url', viewerUrl, '--provider', provider.displayName]],
    ['konsole', ['-e', nodeExecutable, viewerScript, '--url', viewerUrl, '--provider', provider.displayName]],
    ['xterm', ['-e', nodeExecutable, viewerScript, '--url', viewerUrl, '--provider', provider.displayName]],
  ];
  for (const [program, args] of terminalPrograms) {
    try {
      const child = spawn(program, args, {
        cwd: PROJECT_ROOT,
        env: localToolchain.buildToolEnv(process.env),
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      return { ok: true, provider: normalizedProviderId, providerLabel: provider.displayName, viewer: true, viewerUrl };
    } catch (_) {
      // try next terminal
    }
  }

  throw new Error('No supported external terminal launcher was found.');
}

async function launchClaudeInExternalTerminal(mode = 'default', providerId = getSelectedAiProvider(), autoSendSafe = getConfiguredAiAutoSendSafe()) {
  if (claudePty) {
    const activeProviderId = getManagedAiProvider();
    const viewer: any = await openManagedAiViewerInExternalTerminal(activeProviderId);
    return {
      ok: true,
      mode: claudeProcessMode || mode,
      provider: activeProviderId,
      providerLabel: getProviderDisplayName(activeProviderId),
      reused: true,
      viewer: true,
      viewerUrl: viewer.viewerUrl,
      autoSendSafe: getManagedAiAutoSendSafe(),
    };
  }

  const session: any = await startManagedAiSession(mode, providerId, {
    allowReuse: true,
    autoSendSafe,
  });
  const viewer: any = await openManagedAiViewerInExternalTerminal(session.provider);
  return {
    ok: true,
    mode: session.mode,
    provider: session.provider,
    providerLabel: session.providerLabel,
    reused: session.reused,
    viewer: true,
    viewerUrl: viewer.viewerUrl,
    autoSendSafe: !!session.autoSendSafe,
  };
}

function getProviderRunningCheckCommand(providerId) {
  const provider = getProvider(providerId);
  if (process.platform === 'win32') {
    return `powershell -NoProfile -Command "$cliRegex = [regex]'[\\\\/]${provider.id}(\\\\.cmd|\\\\.exe)?([''\" ]|$)'; Get-CimInstance Win32_Process | Where-Object { ($_.Name -match '^${provider.id}(\\\\.cmd|\\\\.exe)?$') -or ($_.CommandLine -and $cliRegex.IsMatch($_.CommandLine)) } | Select-Object -First 1 -ExpandProperty ProcessId"`;
  }
  return `pgrep -f "${provider.id}"`;
}

function decorateAiStatus(baseStatus, selectedProviderId, runtimeProviderId, installCommand) {
  return {
    ...baseStatus,
    selectedProvider: selectedProviderId,
    selectedProviderLabel: getProviderDisplayName(selectedProviderId),
    autoSendSafe: getConfiguredAiAutoSendSafe(),
    installState: getProviderInstallState(runtimeProviderId),
    installError: getProviderInstallError(runtimeProviderId),
    installCommand,
  };
}

async function probeClaudeStatus(providerId = getSelectedAiProvider()) {
  const selectedProviderId = normalizeProviderId(providerId);
  const activeHeadlessStatus = headlessAiRun ? getHeadlessRunStatus(headlessAiRun.provider) : null;
  if (activeHeadlessStatus) {
    return {
      ...activeHeadlessStatus,
      selectedProvider: selectedProviderId,
      selectedProviderLabel: getProviderDisplayName(selectedProviderId),
      autoSendSafe: getManagedAiAutoSendSafe(),
      installed: true,
      version: null,
      installState: getProviderInstallState(activeHeadlessStatus.provider),
      installError: getProviderInstallError(activeHeadlessStatus.provider),
      installCommand: localToolchain.getProviderInstallCommand(activeHeadlessStatus.provider),
    };
  }
  const runtimeProviderId = claudePty ? getManagedAiProvider() : selectedProviderId;
  const provider = getProvider(runtimeProviderId);
  const installCommand = localToolchain.getProviderInstallCommand(runtimeProviderId);

  if (claudePty) {
    return {
      provider: runtimeProviderId,
      providerLabel: provider.displayName,
      selectedProvider: selectedProviderId,
      selectedProviderLabel: getProviderDisplayName(selectedProviderId),
      installed: true,
      running: true,
      managed: true,
      mode: claudeProcessMode,
      autoSendSafe: getManagedAiAutoSendSafe(),
      version: null,
      installState: getProviderInstallState(runtimeProviderId),
      installError: getProviderInstallError(runtimeProviderId),
      installCommand,
    };
  }

  const now = Date.now();
  if (_aiStatusCache && _aiStatusCacheProvider === runtimeProviderId && now - _aiStatusCacheTime < AI_STATUS_CACHE_TTL_MS) {
    return decorateAiStatus(_aiStatusCache, selectedProviderId, runtimeProviderId, installCommand);
  }

  const existing = _aiStatusInFlight.get(runtimeProviderId);
  if (existing) {
    const baseStatus: any = await existing;
    return decorateAiStatus(baseStatus, selectedProviderId, runtimeProviderId, installCommand);
  }

  const cacheGeneration = _aiCacheGeneration;
  const promise = (async () => {
    const executable: any = await resolveClaudeExecutable(runtimeProviderId);
    const installed = process.platform !== 'win32' || executable !== provider.id;
    if (!installed) {
      return {
        provider: runtimeProviderId,
        providerLabel: provider.displayName,
        installed: false,
        running: false,
        managed: false,
        version: null,
      };
    }

    const [versionResult, runningResult, auth] = await Promise.all([
      runProviderCliCommand(runtimeProviderId, ['--version'], {
        timeout: 5000,
        env: buildManagedProviderEnv(runtimeProviderId),
      }),
      execCommand(getProviderRunningCheckCommand(runtimeProviderId), { timeout: 3000 }),
      probeClaudeAuthStatus(runtimeProviderId),
    ]);
    const version = !versionResult.ok ? null : (String(versionResult.stdout || versionResult.stderr || '').trim().split('\n')[0].trim() || null);
    const running = !runningResult.error && (runningResult.stdout || '').trim().length > 0;
    const versionWarning = getProviderVersionWarning(runtimeProviderId, version);

    return {
      provider: runtimeProviderId,
      providerLabel: provider.displayName,
      installed: true,
      running,
      managed: false,
      version,
      loggedIn: !!auth.loggedIn,
      authMethod: auth.authMethod || null,
      authError: auth.error || null,
      probeReliability: auth.probeReliability || null,
      cliTooOld: !!versionWarning,
      minVersion: versionWarning ? versionWarning.minVersion : null,
      updateCommand: versionWarning ? versionWarning.updateCommand : null,
      versionWarning: versionWarning ? versionWarning.message : null,
    };
  })();

  _aiStatusInFlight.set(runtimeProviderId, promise);
  try {
    const baseStatus: any = await promise;
    if (_aiCacheGeneration === cacheGeneration) {
      _aiStatusCache = baseStatus;
      _aiStatusCacheProvider = runtimeProviderId;
      _aiStatusCacheTime = Date.now();
    }
    return decorateAiStatus(baseStatus, selectedProviderId, runtimeProviderId, installCommand);
  } finally {
    if (_aiStatusInFlight.get(runtimeProviderId) === promise) {
      _aiStatusInFlight.delete(runtimeProviderId);
    }
  }
}

// データ読み込み → JSON API 用
function syncSubmittedContactsToHistory({ orderedNos, rowMap, logsByCompany, historyMap, latestMonitorUrlByCompany }) {
  let mutated = false;
  (orderedNos || []).forEach((key: any) => {
    const row = rowMap.get(key) || {};
    const companyNo = row.no;
    if (companyNo === undefined || companyNo === null || companyNo === '') return;

    const logs = logsByCompany[key] || [];
    const submittedLog = getLatestLog(logs, 'submitted');
    if (!submittedLog) return;

    const existingHistory = historyMap.get(String(companyNo)) || getHistory(companyNo) || null;
    const contacts = existingHistory && Array.isArray(existingHistory.contacts) ? existingHistory.contacts : [];
    const draftLog = getLatestLog(logs, 'message_draft');
    const message = draftLog ? stringifyLogDetails(draftLog.details) : '';
    const fallbackFormUrl = contacts.length > 0 ? String(contacts[contacts.length - 1].formUrl || '').trim() : '';
    const formUrl = String(
      getKnownFormUrl(companyNo, '', logs)
      || latestMonitorUrlByCompany.get(String(companyNo))
      || row.formUrl
      || fallbackFormUrl
      || ''
    ).trim();
    const submittedAt = String(submittedLog.timestamp || '').trim();

    const alreadyRecorded = contacts.some((contact: any) => {
      const recordedAt = String(contact.date || contact.timestamp || '').trim();
      if (submittedAt && recordedAt === submittedAt) return true;
      return !!message
        && String(contact.message || '') === message
        && String(contact.formUrl || '').trim() === formUrl;
    });
    if (alreadyRecorded) return;
    const approvalArtifacts = getExpectedApprovalArtifacts(companyNo, {
      logs,
      formFillLog: getLatestLog(logs, 'form_fill'),
      awaitingLog: getLatestLog(logs, 'awaiting_approval'),
      confirmLog: getLatestLog(logs, 'confirm_reached'),
      submittedLog,
    });
    const approvalScreenshot = approvalArtifacts
      ? (approvalArtifacts.actual.sent || approvalArtifacts.screenshots.sent || approvalArtifacts.actual.confirm || approvalArtifacts.actual.input || approvalArtifacts.screenshots.confirm || approvalArtifacts.screenshots.input)
      : null;
    const nextHistory = ensureSubmittedContactHistory(
      companyNo,
      row.companyName || row.name || '',
      submittedLog,
      formUrl,
      message,
      existingHistory,
      {
        screenshot: approvalScreenshot || '',
        sourceAction: 'submitted',
        sourceActionAt: submittedAt || '',
        status: 'submitted',
        notes: 'submitted-sync',
      },
    );
    if (nextHistory !== existingHistory) {
      historyMap.set(String(companyNo), nextHistory);
      mutated = true;
    }
  });
  return mutated;
}

function getLatestContactEntry(contactHist: any) {
  if (!contactHist || !Array.isArray(contactHist.contacts) || contactHist.contacts.length === 0) return null;
  return contactHist.contacts[contactHist.contacts.length - 1] || null;
}

function getHistoryContactTimestamp(contact) {
  return parseEventTimestampMs(contact && (contact.sourceActionAt || contact.date || contact.timestamp));
}

function doesHistoryContactRepresentSubmission(contact) {
  if (!contact) return false;
  const normalizedStatus = String(contact.status || contact.sourceAction || '').trim().toLowerCase();
  if (!normalizedStatus) return true;
  return ['submitted', 'sent', 'completed', 'dashboard-approve'].some((marker: any) => normalizedStatus.includes(marker));
}

function buildHistorySubmittedLog(companyNo, companyName, latestContact, fallbackLog: any = null) {
  if (!doesHistoryContactRepresentSubmission(latestContact)) return fallbackLog;
  const timestamp = String(latestContact.sourceActionAt || latestContact.date || latestContact.timestamp || '').trim();
  return {
    ...(fallbackLog || {}),
    companyNo,
    companyName,
    action: 'submitted',
    timestamp,
    details: latestContact.notes || latestContact.response || 'contact-history',
    source: 'contact-history',
  };
}

function buildDashboardDataFromSources() {
  const targetRepair = repairImportedTargetListIfNeeded();
  if (targetRepair && targetRepair.repaired) {
    appendDiagnosticEvent('target_list_repaired_from_import_source', targetRepair);
  }
  const targetData = readTargetList();
  const targetRows = targetData.ok ? targetData.companies : [];
  const allLogs = getAllLogs();
  let historySummary = getAllHistorySummary();
  const _lang = settings.getSection('preferences').language || 'ja';
  let historyMap: Map<string, any> = new Map(historySummary.map((entry: any) => [String(entry.companyNo), getHistory(entry.companyNo)]));
  const outreachTargets = getTargetMap();
  const monitorSummary = getLiveMonitorSummary();
  const liveEvents = monitorSummary && Array.isArray(monitorSummary.events) ? monitorSummary.events : [];
  const latestMonitorUrlByCompany = new Map<any, any>();
  const logsByCompany: Record<string, any> = {};
  const nameToNo: Record<string, any> = {};
  const rowMap = new Map<any, any>();
  const orderedNos: any[] = [];
  const targetNoSet = new Set<any>();

  function upsertCompanyRow(row, source = 'target') {
    if (!row || row.no === undefined || row.no === null || row.no === '') return null;
    const key = String(row.no);
    const existing = rowMap.get(key) || {};
    const next = {
      no: row.no,
      status: row.status !== undefined && row.status !== null ? row.status : (existing.status || ''),
      companyName: row.companyName || row.name || existing.companyName || '',
      type: row.type || existing.type || '',
      url: row.url || existing.url || '',
      formUrl: row.formUrl || existing.formUrl || '',
      notes: row.notes || existing.notes || '',
      captcha: row.captcha || existing.captcha || '',
      progress: row.progress || existing.progress || '',
    };
    rowMap.set(key, next);
    if (!orderedNos.includes(key)) orderedNos.push(key);
    if (next.companyName) nameToNo[next.companyName] = next.no;
    if (source === 'target') targetNoSet.add(key);
    return key;
  }

  function resolveCompanyNoByName(companyName) {
    const name = (companyName || '').trim();
    if (!name) return null;
    if (Object.prototype.hasOwnProperty.call(nameToNo, name)) return nameToNo[name];
    const match = Object.entries(nameToNo).find(([candidate]) => candidate.includes(name) || name.includes(candidate));
    return match ? match[1] : null;
  }

  targetRows.forEach((row: any) => {
    upsertCompanyRow(row, 'target');
  });

  allLogs.forEach(log => {
    let no = log.companyNo;
    if (no === undefined || no === null || no === '') {
      no = resolveCompanyNoByName(log.companyName || log.company || '');
    }
    if (no !== undefined && no !== null) {
      const key = String(no);
      if (!rowMap.has(key)) {
        upsertCompanyRow({
          no,
          companyName: log.companyName || log.company || '',
        }, 'log');
      }
      if (!logsByCompany[key]) logsByCompany[key] = [];
      logsByCompany[key].push(log);
    }
  });

  historySummary.forEach((entry: any) => {
    if (!entry || entry.companyNo === undefined || entry.companyNo === null || entry.companyNo === '') return;
    const key = String(entry.companyNo);
    if (!rowMap.has(key)) {
      upsertCompanyRow({
        no: entry.companyNo,
        companyName: entry.companyName || '',
      }, 'history');
    }
  });

  outreachTargets.forEach((entry, key) => {
    if (!rowMap.has(String(key))) {
      upsertCompanyRow({
        no: entry.companyNo || key,
        companyName: entry.companyName || '',
      }, 'targeted');
    }
  });

  const statusExclude = settings.getExcludeStatuses();
  const stats = { total: 0, approachable: 0, hasFormUrl: 0, noFormUrl: 0, excluded: 0, formFill: 0, confirmReached: 0, submitted: 0, error: 0, awaitingApproval: 0, actionNeeded: 0 };

  liveEvents.forEach((entry: any) => {
    if (!entry || entry.companyNo === undefined || entry.companyNo === null) return;
    const currentUrl = String(entry.currentUrl || entry.formUrl || '').trim();
    if (!currentUrl) return;
    const key = String(entry.companyNo);
    if (!latestMonitorUrlByCompany.has(key)) {
      latestMonitorUrlByCompany.set(key, currentUrl);
    }
  });

  if (syncSubmittedContactsToHistory({ orderedNos, rowMap, logsByCompany, historyMap, latestMonitorUrlByCompany })) {
    historySummary = getAllHistorySummary();
    historyMap = new Map(historySummary.map((entry: any) => [String(entry.companyNo), getHistory(entry.companyNo)]));
  }

  const companies = orderedNos.map((key: any) => {
    const row = rowMap.get(key) || {};
    const no = row.no;
    const isDetachedFromTargetList = !targetNoSet.has(String(no));
    const status = row.status || '';
    const isExcluded = !isDetachedFromTargetList && statusExclude.includes(status);
    const isApproachable = !isExcluded;
    const logs = logsByCompany[key] || [];
    const rawLastLog = logs.length > 0 ? logs[logs.length - 1] : null;
    const contactHist = historyMap.get(String(no)) || null;
    const latestContact = getLatestContactEntry(contactHist);
    const effectiveName = row.companyName || (contactHist ? contactHist.companyName : '') || ((typeof no === 'number' || typeof no === 'string') ? String(no) : '');
    const effectiveFormUrl = getKnownFormUrl(
      no,
      latestMonitorUrlByCompany.get(String(no)) || (latestContact && latestContact.formUrl) || row.formUrl || '',
      logs,
    );
    const submittedLogFromLogs = getLatestLog(logs, 'submitted');
    const latestContactImpliesSubmitted = doesHistoryContactRepresentSubmission(latestContact);
    const latestContactSubmittedAtText = latestContactImpliesSubmitted
      ? String(latestContact.sourceActionAt || latestContact.date || latestContact.timestamp || '').trim()
      : '';
    const latestContactSubmittedAtMs = getHistoryContactTimestamp(latestContact);
    const rawLastLogAtMs = parseEventTimestampMs(rawLastLog && rawLastLog.timestamp);
    const effectiveSubmittedLog = submittedLogFromLogs
      || buildHistorySubmittedLog(no, effectiveName, latestContact);
    const lastLog = latestContactSubmittedAtMs > rawLastLogAtMs
      ? buildHistorySubmittedLog(no, effectiveName, latestContact, rawLastLog)
      : rawLastLog;
    const effectiveLastAction = lastLog ? lastLog.action : null;
    const effectiveSubmittedAt = effectiveSubmittedLog
      ? String(effectiveSubmittedLog.timestamp || '').trim()
      : latestContactSubmittedAtText;

    stats.total++;
    if (!isDetachedFromTargetList && isExcluded) stats.excluded++;
    if (!isDetachedFromTargetList && isApproachable) {
      stats.approachable++;
      if (effectiveFormUrl) stats.hasFormUrl++; else stats.noFormUrl++;
    }
    if (lastLog) {
      if (effectiveLastAction === 'form_fill') stats.formFill++;
      if (effectiveLastAction === 'confirm_reached') stats.confirmReached++;
      if (effectiveLastAction === 'awaiting_approval') stats.awaitingApproval++;
      if (effectiveLastAction === 'submitted') stats.submitted++;
      if (effectiveLastAction === 'error') stats.error++;
    }

    // v2.0.18: 6 アクションを 1 度のスキャンで取得 (旧: 6 回スキャン)
    const latestLogs = getLatestActionLogs(logs, [
      'form_fill', 'site_analysis', 'awaiting_approval', 'confirm_reached', 'error',
    ]);
    const formFillLog = latestLogs.form_fill || null;
    const submittedLog = effectiveSubmittedLog;
    const siteAnalysis = latestLogs.site_analysis || null;
    const awaitingLog = latestLogs.awaiting_approval || null;
    const confirmLog = latestLogs.confirm_reached || null;
    const errorLog = latestLogs.error || null;
    const screenshot = getScreenshotArtifacts(no, {
      logs,
      formFillLog,
      submittedLog,
      awaitingLog,
      confirmLog,
    });
    const contactCount = (contactHist && Array.isArray(contactHist.contacts)) ? contactHist.contacts.length : 0;
    const targetMeta = outreachTargets.get(String(no)) || null;
    const draftDisplay = getDisplayDraftMessageWithSource(logs, contactHist);
    const displayDraftMessage = draftDisplay ? draftDisplay.message : null;
    const displayDraftSource = draftDisplay ? draftDisplay.source : null;
    const lastActionDetail = stringifyLogDetails(lastLog ? lastLog.details : '');
    const lastErrorDetail = stringifyLogDetails(errorLog ? errorLog.details : '');
    const requiresManualReview = !!screenshot.readyForManualApproval;

    if (effectiveLastAction && ['form_fill', 'confirm_reached', 'awaiting_approval'].includes(effectiveLastAction)) {
      stats.actionNeeded++;
    }

    return {
      no, status, name: effectiveName, type: row.type || '',
      url: row.url || '', formUrl: effectiveFormUrl,
      notes: row.notes || '', captcha: row.captcha || '', progress: row.progress || '',
      isApproachable,
      isDetachedFromTargetList,
      canManageInTargetList: !isDetachedFromTargetList,
      isOutreachTarget: !!targetMeta,
      targetedAt: targetMeta ? targetMeta.addedAt : null,
      outreachStatus: null,
      outreachDetail: null,
      outreachUpdatedAt: null,
      lastAction: effectiveLastAction,
      lastActionAt: lastLog ? lastLog.timestamp : null,
      // v2.0.23: lastLog と logs(直近 3 件) は UI から参照されてなかった (grep 0 件)。
      // 1 社あたり 12KB → payload からカット。
      // 履歴詳細は GET /api/companies/:no/status で取得可能。
      hasInputScreenshot: screenshot.hasInput,
      hasConfirmScreenshot: screenshot.hasConfirm,
      hasSentScreenshot: screenshot.hasSent,
      hasAnyScreenshot: screenshot.hasAny,
      screenshotAuditState: screenshot.auditState,
      inputScreenshotName: screenshot.input ? path.basename(screenshot.input) : null,
      confirmScreenshotName: screenshot.confirm ? path.basename(screenshot.confirm) : null,
      sentScreenshotName: screenshot.sent ? path.basename(screenshot.sent) : null,
      readyForApproval: screenshot.readyForApproval,
      readyForManualApproval: requiresManualReview,
      manualReviewReason: screenshot.manualReviewReason || '',
      manualReviewDetail: screenshot.manualReviewDetail || '',
      captchaDetected: screenshot.captchaDetected,
      directSubmitDetected: screenshot.directSubmitDetected,
      sentMessage: displayDraftMessage,
      sentMessageSource: displayDraftSource,
      hasDraftMessage: !!displayDraftMessage,
      sentAt: effectiveSubmittedAt || null,
      // v2.0.23: analysis (raw site_analysis log) は UI 未使用 (grep 0 件) なので削除。
      // analysisInsight は awaiting-card-redesign で使用 → 残す (~2KB/社、構造化済み)。
      analysisInsight: extractAnalysisInsight(siteAnalysis, errorLog, lastLog),
      awaitingAt: awaitingLog ? awaitingLog.timestamp : (confirmLog ? confirmLog.timestamp : null),
      lastActionDetail,
      lastErrorDetail,
      contactCount,
      contactHistory: contactHist ? contactHist.contacts : [],
    };
  });

  // 7日間の日別処理推移（処理推移グラフ用、ユニーク企業数ベース）
  const today = new Date();
  const trendDays = 7;
  const trendActionNeededSets = Array.from({ length: trendDays }, () => new Set<any>());
  const trendSentSets = Array.from({ length: trendDays }, () => new Set<any>());
  const trendErrorSets = Array.from({ length: trendDays }, () => new Set<any>());
  const trendLabels: any[] = [];
  const trendIndexByDay = new Map<any, any>();
  for (let i = trendDays - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    trendLabels.push(i === 0 ? i18nT(_lang, 'analytics.trend.today') : i === 1 ? i18nT(_lang, 'analytics.trend.yesterday') : i18nT(_lang, 'analytics.trend.daysAgo', { n: i }));
    trendIndexByDay.set(d.toISOString().slice(0, 10), trendDays - 1 - i);
  }
  allLogs.forEach((log: any) => {
    if (!log.timestamp || log.companyNo == null) return;
    const timestamp = log.timestamp instanceof Date ? log.timestamp.toISOString() : String(log.timestamp || '');
    const idx = trendIndexByDay.get(timestamp.slice(0, 10));
    if (idx === undefined) return;
    if (log.action === 'form_fill' || log.action === 'confirm_reached' || log.action === 'awaiting_approval') trendActionNeededSets[idx].add(log.companyNo);
    if (log.action === 'submitted') trendSentSets[idx].add(log.companyNo);
    if (log.action === 'error') trendErrorSets[idx].add(log.companyNo);
  });
  historyMap.forEach((history, companyNo) => {
    const contacts = history && Array.isArray(history.contacts) ? history.contacts : [];
    contacts.forEach((contact: any) => {
      if (String(contact && contact.status || '').trim() !== 'submitted') return;
      const dateValue = contact.sourceActionAt || contact.date || contact.sentAt || '';
      const isoDay = (() => {
        const parsed = Date.parse(String(dateValue || ''));
        return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : '';
      })();
      if (!isoDay) return;
      const idx = trendIndexByDay.get(isoDay);
      if (idx === undefined) return;
      trendSentSets[idx].add(Number(companyNo));
    });
  });
  const trendActionNeeded = trendActionNeededSets.map((set: any) => set.size);
  const trendSent = trendSentSets.map((set: any) => set.size);
  const trendError = trendErrorSets.map((set: any) => set.size);

  const runtime = dashboardRuntime || readRuntime();
  // v2.0.10: 全て defensive に Array で保証。client 側 dashboard.ts の
  // `recentLogs.length` / `companies.length` 等が undefined を叩いて
  // "Cannot read properties of undefined (reading 'length')" を出すのを防ぐ。
  return {
    companies: Array.isArray(companies) ? companies : [],
    stats: stats || {},
    recentLogs: Array.isArray(allLogs) ? allLogs.slice(-100).reverse() : [],
    issues: buildOperationalIssues(targetData, runtime) || [],
    liveMonitor: buildMonitorPayload(allLogs) || { events: [], summary: {} },
    runtime,
    trendData: {
      labels: Array.isArray(trendLabels) ? trendLabels : [],
      actionNeeded: Array.isArray(trendActionNeeded) ? trendActionNeeded : [],
      sent: Array.isArray(trendSent) ? trendSent : [],
      error: Array.isArray(trendError) ? trendError : [],
    },
  };
}

function loadData(options: Record<string, any> = {}) {
  const force = !!options.force;
  const cacheKey = getDashboardDataCacheKey();
  if (!force && dashboardDataCacheValue && dashboardDataCacheKey === cacheKey) {
    dashboardDataCacheValue.cacheKey = cacheKey;
    return dashboardDataCacheValue;
  }
  const data: any = buildDashboardDataFromSources();
  data.cacheKey = cacheKey;
  dashboardDataCacheKey = cacheKey;
  dashboardDataCacheValue = data;
  dashboardDataCacheBuiltAt = Date.now();
  return data;
}

// JSON body parser helper
// デフォルトのリクエストボディ最大サイズ (2 MiB)
// マッピング JSON / 設定 JSON を許容しつつ、意図的な memory 圧迫を防ぐ。
const PARSE_JSON_BODY_MAX_BYTES = 2 * 1024 * 1024;

function parseJsonBody(req, maxBytes = PARSE_JSON_BODY_MAX_BYTES) {
  return new Promise((resolve, reject) => {
    // 1.2.111+: 上限超過時に req.destroy() で接続を切ると、クライアント側 fetch()
    // が "Failed to fetch" を投げ、UI 側 translateError() が「ネットワークに
    // 接続できません」と誤翻訳する事故が起きる (Excel/CSV 取込時に多発)。
    // 上限を超えた場合は accumulating を止めて promise を reject するが、
    // 接続は維持して呼び出し側が 413 を返せるようにする。
    // 悪意あるクライアント対策として HARD_CAP (上限の 4 倍) を超えたら destroy。
    const HARD_CAP = Math.max(maxBytes * 4, maxBytes + 16 * 1024 * 1024);
    let body = '';
    let aborted = false;
    let totalBytes = 0;
    req.on('data', chunk => {
      totalBytes += chunk.length;
      if (totalBytes > HARD_CAP) {
        if (!aborted) {
          aborted = true;
          const err: any = new Error('Request body too large');
          err.code = 'BODY_TOO_LARGE';
          err.maxBytes = maxBytes;
          reject(err);
        }
        try { req.destroy(); } catch (_) {}
        return;
      }
      if (aborted) return;
      body += chunk;
      if (body.length > maxBytes) {
        aborted = true;
        const err: any = new Error('Request body too large');
        err.code = 'BODY_TOO_LARGE';
        err.maxBytes = maxBytes;
        reject(err);
      }
    });
    req.on('end', () => {
      if (aborted) return;
      try { resolve(JSON.parse(body)); }
      catch (e) { reject(e); }
    });
    req.on('error', (e) => { if (!aborted) reject(e); });
  });
}

// JSON response helper
function jsonResponse(res, statusCode, data, extraHeaders: Record<string, any> = {}) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(JSON.stringify(data));
}

// HTML テンプレート
function buildPage() {
  // SALES_CLAW_DEV_HOT_RELOAD=1 のとき、./ui/** を再 require して
  // ブラウザ再読み込みごとにディスクから最新を読み直す。
  hotInvalidateUi();
  const _lang = settings.getSection('preferences').language || 'ja';
  const _tz = settings.getSection('preferences').timezone || 'Asia/Tokyo';
  const _t = getTranslations(_lang);
  const buildMeta = getBuildSourceMeta(_lang);
  const settingsTag = (kind) => `<span class="settings-field-chip ${kind}">${_t['settings.tag.' + kind] || kind}</span>`;
  const providerOptions = listProviders();
  const providerSelectHtml = providerOptions.map((provider: any) =>
    `<option value="${provider.id}">${provider.displayName}</option>`
  ).join('');
  return `<!DOCTYPE html>
<html lang="${_lang}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sales Claw</title>
<link rel="icon" type="image/png" href="/assets/favicon.png">
<!-- ローカルバンドル: フォント・Material Symbols・Phosphor・Tailwind (全てオフライン動作) -->
<link rel="stylesheet" href="/assets/vendor/fonts.css">
<link rel="stylesheet" href="/assets/vendor/material-symbols.css">
<link rel="stylesheet" href="/assets/vendor/phosphor.css">
<link rel="stylesheet" href="/assets/vendor/tailwind.css">
<link rel="stylesheet" href="/assets/vendor/js/xterm.css">
<script src="/assets/vendor/js/xterm.js" defer></script>
<script src="/assets/vendor/js/xterm-addon-fit.js" defer></script>
<!-- v2.0.52: VS Code 同等品質のためのアドオン -->
<script src="/assets/vendor/js/xterm-addon-web-links.js" defer></script>
<script src="/assets/vendor/js/xterm-addon-search.js" defer></script>
<script src="/assets/vendor/js/xterm-addon-unicode11.js" defer></script>
<style>
${renderStyles()}
</style>
<script>
// Early theme init (FOUC prevention) — runs before body renders.
(function(){
  try{
    var saved=localStorage.getItem('dashboardTheme');
    var prefersDark=window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches;
    var theme=saved||(prefersDark?'dark':'light');
    document.documentElement.setAttribute('data-theme',theme);
  }catch(_){ document.documentElement.setAttribute('data-theme','light'); }
})();
</script>
</head>
<body class="${APP_BUILD_SOURCE === 'installed' ? 'desktop-build perf-mode' : ''}">
<!-- Toast container -->
<div class="toast-container" id="toastContainer"></div>

<!-- Top App Bar -->
<header class="app-header">
  <!-- Logo area -->
  <div class="app-brand">
    <div class="app-brand-mark">
      <img src="/assets/icon.png" alt="Sales Claw" class="app-brand-logo" onerror="this.style.display='none';var fallback=this.nextElementSibling;if(fallback)fallback.style.display='flex'">
      <span class="app-brand-fallback">SC</span>
    </div>
    <div class="app-brand-copy">
      <span class="app-brand-title">Sales Claw</span>
      <span class="app-brand-caption">${buildMeta.title}</span>
    </div>
  </div>
  <div class="app-brand-meta">
    <span title="Version ${APP_VERSION}" class="app-version-chip">v${APP_VERSION}</span>
    <span class="app-build-chip" style="color:${buildMeta.fg};background:${buildMeta.bg}" title="${buildMeta.title}">${buildMeta.label}</span>
    <button id="updateCheckBtn" type="button" title="${_t['header.updateCheck.title'] || 'Check for updates'}" style="display:flex;align-items:center;gap:4px;padding:3px 8px;border:1px solid var(--border-default);background:var(--bg-surface);color:var(--text-2);font-size:.62rem;font-weight:800;letter-spacing:.04em;text-transform:uppercase;cursor:pointer;border-radius:var(--radius-sm)">
      <span id="updateCheckIcon" class="material-symbols-outlined" style="font-size:13px">sync</span>
      <span id="updateCheckLabel">${_t['header.updateCheck.label'] || 'Update'}</span>
    </button>
  <!-- Live status -->
  <div style="display:flex;align-items:center;gap:6px;margin-right:2px">
    <span class="live-dot on" id="liveDot"></span>
    <span style="font-size:.62rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--text-2)" id="liveLabel">${_t['app.live'] || 'LIVE'}</span>
  </div>
  <small style="font-size:.62rem;color:var(--text-3);margin-right:auto;font-family:var(--font-mono)" id="lastUpdate"></small>
  </div>
  <!-- AI status + mode widget -->
  <div style="display:flex;align-items:center;gap:0;background:var(--bg-raised);border:1px solid var(--border-default);font-size:.72rem;border-radius:var(--radius-sm)">
    <div id="claudeStatusWidget" style="display:flex;align-items:center;gap:6px;padding:4px 10px;border-right:1px solid var(--border-subtle)">
      <span id="claudeStatusDot" class="live-dot" style="width:7px;height:7px"></span>
      <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" style="flex-shrink:0;opacity:.6"><path fill="currentColor" d="M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z"/></svg>
      <span id="claudeStatusLabel" style="color:var(--text-2);white-space:nowrap">AI</span>
    </div>
    <button id="claudeActionBtn" onclick="claudeAction()" style="display:none;background:var(--primary);border:none;border-left:1px solid var(--border-subtle);color:#fff;font-size:.68rem;padding:4px 10px;cursor:pointer;font-weight:600;white-space:nowrap;text-transform:uppercase;letter-spacing:.04em;border-radius:0 var(--radius-sm) var(--radius-sm) 0"></button>
    <button id="claudeStopBtn" onclick="stopClaude()" style="display:none;background:#dc2626;border:none;border-left:1px solid var(--border-subtle);color:#fff;font-size:.68rem;padding:4px 10px;cursor:pointer;font-weight:600;white-space:nowrap;text-transform:uppercase;letter-spacing:.04em;border-radius:0 var(--radius-sm) var(--radius-sm) 0">STOP</button>
    <button id="queueResetBtn" onclick="resetAiQueue()" title="${_t['header.queueReset.title'] || 'Clear stuck queue'}" style="background:#7c3aed;border:none;border-left:1px solid var(--border-subtle);color:#fff;font-size:.68rem;padding:4px 10px;cursor:pointer;font-weight:600;white-space:nowrap;text-transform:uppercase;letter-spacing:.04em;border-radius:0 var(--radius-sm) var(--radius-sm) 0">${_t['header.queueReset.label'] || 'QUEUE'}</button>
  </div>
  <!-- Icon-only action buttons -->
  <div style="display:flex;align-items:center;gap:2px">
    <!-- v2.0.33: 言語切替トグル (ja ↔ en)。クリックで preferences.language を更新 → リロード -->
    <button class="lang-toggle" onclick="toggleLanguage()" title="${_t['header.langToggle.title'] || 'Switch language'}" aria-label="Toggle language" style="display:flex;align-items:center;justify-content:center;width:auto;min-width:36px;height:32px;padding:0 8px;background:none;border:1px solid var(--border-default);cursor:pointer;color:var(--text-2);transition:all .15s;border-radius:var(--radius-sm);font-size:.72rem;font-weight:700;letter-spacing:.04em" onmouseover="this.style.background='var(--bg-hover)';this.style.color='var(--text-1)'" onmouseout="this.style.background='none';this.style.color='var(--text-2)'">
      <span class="material-symbols-outlined" style="font-size:14px;margin-right:4px">language</span>
      <span>${_t['header.langToggle.label'] || 'EN'}</span>
    </button>
    <button class="theme-toggle" onclick="toggleTheme()" title="${_t['header.themeToggle.title'] || 'Toggle theme'}" aria-label="Toggle theme">
      <span class="ti sun"><span class="material-symbols-outlined" style="font-size:18px">light_mode</span></span>
      <span class="ti moon"><span class="material-symbols-outlined" style="font-size:18px">dark_mode</span></span>
    </button>
    <button onclick="showDocsModal()" title="${_t['app.docsTitle'] || 'Guide'}" style="display:flex;align-items:center;justify-content:center;width:32px;height:32px;background:none;border:1px solid transparent;cursor:pointer;color:var(--text-3);transition:all .15s;border-radius:var(--radius-sm)" onmouseover="this.style.background='var(--bg-hover)';this.style.color='var(--text-1)';this.style.borderColor='var(--border-default)'" onmouseout="this.style.background='none';this.style.color='var(--text-3)';this.style.borderColor='transparent'">
      <span class="material-symbols-outlined" style="font-size:18px">menu_book</span>
    </button>
    <button onclick="location.href='/api/export'" title="${_t['app.export'] || 'Export'}" style="display:flex;align-items:center;justify-content:center;width:32px;height:32px;background:none;border:1px solid transparent;cursor:pointer;color:var(--text-3);transition:all .15s;border-radius:var(--radius-sm)" onmouseover="this.style.background='var(--bg-hover)';this.style.color='var(--text-1)';this.style.borderColor='var(--border-default)'" onmouseout="this.style.background='none';this.style.color='var(--text-3)';this.style.borderColor='transparent'">
      <span class="material-symbols-outlined" style="font-size:18px">download</span>
    </button>
  </div>
</header>

<!-- sidebarLastUpdate hidden element (kept for JS compat) -->
<span id="sidebarLastUpdate" style="display:none"></span>
<span id="headerLastUpdate" style="display:none"></span>

<!-- Auto-update banner (shown by pollUpdateStatus) -->
<div id="updateBanner" style="display:none;position:fixed;top:48px;left:0;right:0;z-index:49;background:#2563eb;color:#fff;padding:6px 16px;font-size:.75rem;font-weight:600;align-items:center;gap:8px;justify-content:center"></div>

<!-- Cost summary chip (AI トークン消費概算 — pollCostSummary 経由で表示) -->
<div id="costChip" title="${_t['cost.title.tooltip'] || 'AI token cost estimate'}" style="display:none;position:fixed;bottom:14px;left:14px;z-index:47;background:var(--bg-card);border:1px solid var(--border-default);border-radius:10px;padding:10px 14px;box-shadow:var(--shadow-md);font-size:.72rem;line-height:1.5;color:var(--text-1);min-width:200px;max-width:300px">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
    <span style="display:inline-flex;align-items:center;gap:5px;font-weight:700">
      <span class="material-symbols-outlined" style="font-size:14px;color:var(--primary)">payments</span>
      ${_t['cost.title'] || 'AI cost estimate'}
    </span>
    <button onclick="document.getElementById('costChip').style.display='none'" style="background:none;border:none;color:var(--text-3);cursor:pointer;font-size:14px;padding:0;line-height:1">×</button>
  </div>
  <div style="display:flex;justify-content:space-between;color:var(--text-2)"><span>${_t['cost.today'] || 'Today'}</span><span id="costToday" style="font-family:var(--font-mono);font-weight:600;color:var(--text-1)">—</span></div>
  <div style="display:flex;justify-content:space-between;color:var(--text-2)"><span>${_t['cost.thisMonth'] || 'This month'}</span><span id="costMonth" style="font-family:var(--font-mono);font-weight:600;color:var(--text-1)">—</span></div>
  <div style="display:flex;justify-content:space-between;color:var(--text-3);font-size:.66rem;margin-top:4px;border-top:1px solid var(--border-subtle);padding-top:4px"><span>${_t['cost.avgPerCompany'] || 'Avg/company'}</span><span id="costPerCompany" style="font-family:var(--font-mono)">—</span></div>
</div>

<!-- Recovery banner (前回中断バッチの復旧通知) — pollRecoveryStatus 経由で表示 -->
<div id="recoveryBanner" style="display:none;position:fixed;top:48px;left:0;right:0;z-index:48;background:#ea580c;color:#fff;padding:10px 20px;font-size:.78rem;font-weight:600;align-items:center;gap:14px;justify-content:center;flex-wrap:wrap">
  <span style="display:inline-flex;align-items:center;gap:6px">
    <span class="material-symbols-outlined" style="font-size:18px">history</span>
    <span id="recoveryBannerText">${_t['recovery.banner.text'] || 'Recovery snapshot detected from previous session'}</span>
  </span>
  <span id="recoveryBannerDetail" style="font-weight:400;opacity:.9"></span>
  <button id="recoveryResumeBtn" onclick="resumeRecovery()" style="background:#fff;color:#ea580c;border:none;padding:5px 12px;border-radius:6px;font-weight:700;cursor:pointer;font-size:.72rem">
    ${_t['recovery.banner.resume'] || 'Resume'}
  </button>
  <button id="recoveryDiscardBtn" onclick="discardRecovery()" style="background:transparent;color:#fff;border:1px solid rgba(255,255,255,.5);padding:5px 12px;border-radius:6px;font-weight:600;cursor:pointer;font-size:.72rem">
    ${_t['recovery.banner.discard'] || 'Discard'}
  </button>
</div>

<!-- Docs Modal -->
<!-- AI 起動モード選択モーダル -->
<div id="launchModal" class="launch-modal-shell" onclick="if(event.target===this)closeLaunchModal()">
  <div class="launch-modal-panel">
    <!-- HEAD -->
    <div class="launch-head">
      <div id="launchModalHeaderIcon" class="launch-head-icon">
        <img src="/assets/vendor/ai-icons/claude-code.svg" width="26" height="26" alt="Claude Code">
      </div>
      <div class="launch-head-copy">
        <div id="launchProviderTitle" class="launch-head-title">${_t['launch.title'] || 'Launch AI'}</div>
        <div id="launchProviderSubtitle" class="launch-head-sub">${_t['launch.subtitle'] || 'Launch AI in CLI environment'}</div>
      </div>
      <button class="launch-close" onclick="closeLaunchModal()" aria-label="Close">
        <span class="material-symbols-outlined">close</span>
      </button>
      <div id="launchModalHeader" style="display:none"></div>
    </div>
    <div class="launch-divider"></div>

    <!-- BODY -->
    <div class="launch-body">
      <!-- AI モデル -->
      <section class="launch-section">
        <div class="launch-section-label">${_t['launch.section.aiModel'] || 'AI model'}</div>
        <div class="launch-providers">
          <div id="launchProviderCard_claude" class="launch-provider-card claude" onclick="selectLaunchProvider('claude')">
            <div class="lp-check">✓</div>
            <div class="lp-icon" data-provider="claude">
              <img src="/assets/vendor/ai-icons/claude-code.svg" width="26" height="26" alt="Claude Code">
            </div>
            <div class="lp-name">Claude</div>
            <div class="lp-sub">Anthropic</div>
          </div>
          <div id="launchProviderCard_codex" class="launch-provider-card codex" onclick="selectLaunchProvider('codex')">
            <div class="lp-check">✓</div>
            <div class="lp-icon" data-provider="codex">
              <img src="/assets/vendor/ai-icons/codex-openai.svg" width="26" height="26" alt="Codex">
            </div>
            <div class="lp-name">CodeX</div>
            <div class="lp-sub">OpenAI</div>
          </div>
          <div id="launchProviderCard_gemini" class="launch-provider-card gemini" onclick="selectLaunchProvider('gemini')">
            <div class="lp-check">✓</div>
            <div class="lp-icon" data-provider="gemini">
              <img src="/assets/vendor/ai-icons/gemini-cli.svg" width="26" height="26" alt="Gemini CLI">
            </div>
            <div class="lp-name">Gemini</div>
            <div class="lp-sub">Google</div>
          </div>
        </div>
        <select id="launchProviderSelect" style="display:none">${providerSelectHtml}</select>
        <div id="launchProviderBadge" style="display:none"></div>
      </section>

      <!-- 送信ポリシー -->
      <section class="launch-section">
        <div class="launch-section-label">${_t['launch.submitPolicy.title'] || 'Submission policy'}</div>
        <div class="launch-policy-select">
          <select id="launchAutoSendSafeSelect" onchange="setLaunchAutoSendSafe(this.value === 'true')">
            <option value="false">${_t['launch.submitPolicy.approval'] || 'Stop for approval (recommended)'}</option>
            <option value="true">${_t['launch.submitPolicy.autoSendSafe'] || 'Auto-send safe forms'}</option>
          </select>
          <span class="material-symbols-outlined launch-policy-arrow">expand_more</span>
        </div>
        <div class="launch-policy-note">
          <span class="material-symbols-outlined">verified_user</span>
          <span id="launchAutoSendSafeHelp">${_t['launch.submitPolicy.help'] || 'Safe defaults to protect confidential and personal data.'}</span>
        </div>
      </section>

      <!-- Advanced area -->
      <!-- システム側 (Sales Claw + Playwright + ヒューマン承認) で十分に
           安全制御できているため、起動モードのデフォルトは bypassPermissions
           (yolo) で固定。詳細設定を開いた人だけが変更可能。 -->
      <div id="launchAdvancedModes" style="display:none">
        <section class="launch-section">
          <div class="launch-section-label">${_t['launch.section.mode'] || 'Launch mode (advanced, optional)'}</div>
          <div class="launch-modes">
            <div id="launchOpt_bypassPermissions" class="launch-mode-card recommended" onclick="selectLaunchMode('bypassPermissions')">
              <input type="radio" name="launchMode" value="bypassPermissions" style="display:none">
              <div id="launchOptTag_bypassPermissions" class="launch-mode-tag">${_t['launch.mode.bypass.tag'] || 'Default (yolo)'}</div>
              <div class="launch-mode-icon">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M13 2 L3 14 H12 L11 22 L21 10 H12 Z"/></svg>
              </div>
              <div id="launchOptTitle_bypassPermissions" class="launch-mode-title">${_t['launch.mode.bypass.title'] || 'Skip permissions (yolo / default)'}</div>
              <div id="launchOptDesc_bypassPermissions" class="launch-mode-desc">${_t['launch.mode.bypass.desc'] || 'Sales Claw enforces human approval and logs separately, so the CLI prompts are redundant.'}</div>
              <div id="launchCheck_bypassPermissions" class="launch-mode-check"><span class="material-symbols-outlined">check</span></div>
            </div>
            <div id="launchOpt_auto" class="launch-mode-card dev" onclick="selectLaunchMode('auto')">
              <input type="radio" name="launchMode" value="auto" style="display:none">
              <div id="launchOptTag_auto" class="launch-mode-tag">${_t['launch.mode.auto.tag'] || 'Auto'}</div>
              <div class="launch-mode-icon">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 12 11 14 15 10"/><circle cx="12" cy="12" r="10"/></svg>
              </div>
              <div id="launchOptTitle_auto" class="launch-mode-title">${_t['launch.mode.auto.title'] || 'Auto'}</div>
              <div id="launchOptDesc_auto" class="launch-mode-desc">${_t['launch.mode.auto.desc'] || 'Use CLI permission logic; most actions auto-approve.'}</div>
              <div id="launchCheck_auto" class="launch-mode-check"><span class="material-symbols-outlined">check</span></div>
            </div>
            <div id="launchOpt_default" class="launch-mode-card dev" onclick="selectLaunchMode('default')">
              <input type="radio" name="launchMode" value="default" style="display:none">
              <div id="launchOptTag_default" class="launch-mode-tag">${_t['launch.mode.default.tag'] || 'Dev'}</div>
              <div class="launch-mode-icon">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/></svg>
              </div>
              <div id="launchOptTitle_default" class="launch-mode-title">default</div>
              <div id="launchOptDesc_default" class="launch-mode-desc">${_t['launch.mode.default.desc'] || 'Default. May stop on CLI permission prompts.'}</div>
              <div id="launchCheck_default" class="launch-mode-check"><span class="material-symbols-outlined">check</span></div>
            </div>
            <div id="launchOpt_acceptEdits" class="launch-mode-card dev" onclick="selectLaunchMode('acceptEdits')">
              <input type="radio" name="launchMode" value="acceptEdits" style="display:none">
              <div id="launchOptTag_acceptEdits" class="launch-mode-tag">${_t['launch.mode.acceptEdits.tag'] || 'Dev'}</div>
              <div class="launch-mode-icon">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
              </div>
              <div id="launchOptTitle_acceptEdits" class="launch-mode-title">acceptEdits</div>
              <div id="launchOptDesc_acceptEdits" class="launch-mode-desc">${_t['launch.mode.acceptEdits.desc'] || 'Edits flow; commands/browser may still pause.'}</div>
              <div id="launchCheck_acceptEdits" class="launch-mode-check"><span class="material-symbols-outlined">check</span></div>
            </div>
          </div>
        </section>
        <section class="launch-section">
          <div id="launchSetupDiagnostics" class="launch-diag">
            <div class="launch-diag-head" onclick="toggleDiagPanel()">
              <div class="launch-diag-head-left">
                <div class="launch-section-label" style="margin:0">${_t['launch.diag.title'] || 'Setup diagnostics'}</div>
                <div id="launchDiagBadge" class="launch-diag-badge"></div>
              </div>
              <span id="launchDiagArrow" class="launch-diag-arrow">▼</span>
            </div>
            <div id="launchSetupDiagnosticsBody" class="launch-diag-body">${_t['launch.diag.loading'] || 'Loading diagnostics...'}</div>
          </div>
        </section>
      </div>
    </div>

    <!-- FOOT -->
    <div class="launch-foot">
      <button id="launchAdvancedToggle" class="launch-advanced-link" type="button" onclick="toggleLaunchAdvancedModes()">
        <span class="material-symbols-outlined">settings</span>
        ${_t['launch.advanced'] || 'Advanced'}
      </button>
      <div class="launch-foot-actions">
        <button class="launch-cancel" onclick="closeLaunchModal()">${_t['launch.cancel'] || 'Cancel'}</button>
        <button id="launchExternalBtn" class="launch-external" onclick="confirmExternalLaunch()" style="display:none">${_t['launch.openExternal'] || 'Open External'}</button>
        <button id="launchConfirmBtn" class="launch-confirm-btn" onclick="confirmLaunch()">
          <span class="material-symbols-outlined">play_arrow</span>
          ${_t['launch.confirm'] || 'Launch AI'}
        </button>
      </div>
      <div id="launchSelectedLabel" style="display:none"></div>
    </div>
  </div>
</div>

<div id="docsModal" style="display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.5);z-index:9999;display:none;align-items:center;justify-content:center">
  <div style="background:var(--surface-lowest);border-radius:var(--radius-lg);padding:0;max-width:700px;width:90%;max-height:85vh;overflow:hidden;box-shadow:0 8px 32px rgba(0,0,0,.2)">
    <div style="background:var(--primary);color:var(--on-primary);padding:16px 24px;display:flex;justify-content:space-between;align-items:center">
      <h3 style="margin:0;font-family:var(--font-display);font-size:1rem">${_t['docs.title']}</h3>
      <button onclick="closeDocsModal()" style="background:none;border:none;color:var(--on-primary);font-size:1.2rem;cursor:pointer">&times;</button>
    </div>
    <div style="padding:24px;overflow-y:auto;max-height:calc(85vh - 60px)">
      <div style="margin-bottom:20px">
        <h4 style="font-family:var(--font-display);font-size:.95rem;color:var(--primary);margin-bottom:8px">1. ${_t['docs.quickStart']}</h4>
        <pre style="background:var(--surface-low);padding:12px;border-radius:var(--radius-md);font-size:.8rem;white-space:pre-wrap;line-height:1.7;margin:0">${_t['docs.quickStartContent']}</pre>
      </div>
      <div style="margin-bottom:20px">
        <h4 style="font-family:var(--font-display);font-size:.95rem;color:var(--primary);margin-bottom:8px">2. ${_t['docs.settingsGuide']}</h4>
        <pre style="background:var(--surface-low);padding:12px;border-radius:var(--radius-md);font-size:.8rem;white-space:pre-wrap;line-height:1.7;margin:0">${_t['docs.settingsGuideContent']}</pre>
      </div>
      <div style="margin-bottom:20px">
        <h4 style="font-family:var(--font-display);font-size:.95rem;color:var(--primary);margin-bottom:8px">3. ${_t['docs.workflow']}</h4>
        <pre style="background:var(--surface-low);padding:12px;border-radius:var(--radius-md);font-size:.8rem;white-space:pre-wrap;line-height:1.7;margin:0">${_t['docs.workflowContent']}</pre>
      </div>
      <div style="margin-bottom:20px">
        <h4 style="font-family:var(--font-display);font-size:.95rem;color:var(--primary);margin-bottom:8px">4. ${_t['docs.features'] || 'Key Features'}</h4>
        <pre style="background:var(--surface-low);padding:12px;border-radius:var(--radius-md);font-size:.8rem;white-space:pre-wrap;line-height:1.7;margin:0">${_t['docs.featuresContent'] || ''}</pre>
      </div>
      <div style="text-align:center;padding-top:12px;border-top:1px solid var(--surface-high)">
        <button onclick="closeDocsModal()" style="padding:8px 24px;background:var(--primary);color:var(--on-primary);border:none;border-radius:var(--radius-md);font-size:.82rem;cursor:pointer">${_t['docs.close']}</button>
      </div>
    </div>
  </div>
</div>

<input type="file" id="companyImportInput" accept=".xlsx,.xls,.csv" style="display:none">
<input type="file" id="settingsWorkbookImportInput" accept=".xlsx,.xls" style="display:none">

<div id="companyFormModal" class="modal-shell">
  <div class="modal-panel hud-modal">
    <span class="hud-corner hud-corner-tl"></span>
    <span class="hud-corner hud-corner-tr"></span>
    <span class="hud-corner hud-corner-bl"></span>
    <span class="hud-corner hud-corner-br"></span>

    <div class="modal-head hud-head">
      <div class="hud-head-icon">
        <svg viewBox="0 0 52 58" fill="none" aria-hidden="true">
          <path d="M26 2 L48 14.5 V43.5 L26 56 L4 43.5 V14.5 Z" stroke="currentColor" stroke-width="1.3" fill="color-mix(in srgb, currentColor 6%, transparent)"/>
        </svg>
        <span class="material-symbols-outlined hud-head-sym">apartment</span>
      </div>
      <div class="hud-head-copy">
        <h3 id="companyFormTitle">${_t['companyModal.title'] || 'Add Company'}</h3>
        <span class="hud-head-sub" id="companyFormSub">ADD COMPANY</span>
      </div>
      <button class="hud-close" onclick="closeCompanyFormModal()" aria-label="Close">
        <span class="material-symbols-outlined">close</span>
      </button>
    </div>
    <div class="hud-scanline"></div>

    <div class="modal-body hud-body">
      <input type="hidden" id="companyFormMode" value="create">
      <input type="hidden" id="companyFormCompanyNo" value="">
      <div class="modal-grid">
        <div class="settings-group hud-field">
          <label><span class="material-symbols-outlined">apartment</span>${_t['field.companyName']}</label>
          <input type="text" id="new-companyName" placeholder="${_t['ph.companyName']}">
        </div>
        <div class="settings-group hud-field">
          <label><span class="material-symbols-outlined">category</span>${_t['field.type'] || 'Type'}</label>
          <input type="text" id="new-type" placeholder="${_t['companyModal.placeholder.type'] || 'e.g. SIer / SaaS / Manufacturing'}">
        </div>
        <div class="settings-group hud-field">
          <label><span class="material-symbols-outlined">language</span>${_t['field.website']}</label>
          <input type="text" id="new-url" placeholder="https://example.com">
        </div>
        <div class="settings-group hud-field">
          <label><span class="material-symbols-outlined">link</span>${_t['field.colFormUrl']}</label>
          <input type="text" id="new-formUrl" placeholder="https://example.com/contact">
        </div>
        <div class="settings-group hud-field">
          <label><span class="material-symbols-outlined">radio_button_unchecked</span>${_t['field.colStatus']}</label>
          <input type="text" id="new-status" placeholder="${_t['companyModal.placeholder.status'] || 'e.g. target'}">
        </div>
        <div class="settings-group hud-field">
          <label><span class="material-symbols-outlined">trending_up</span>${_t['field.colProgress']}</label>
          <input type="text" id="new-progress" placeholder="${_t['companyModal.placeholder.progress'] || 'Optional'}">
        </div>
        <div class="settings-group hud-field modal-grid-full">
          <label><span class="material-symbols-outlined">description</span>${_t['field.colNotes']}</label>
          <textarea id="new-notes" placeholder="${_t['companyModal.placeholder.notes'] || 'Internal note'}"></textarea>
        </div>
      </div>
      <label class="hud-check">
        <input type="checkbox" id="new-addTarget" checked>
        <span class="hud-check-box"></span>
        <span class="hud-check-text">${_t['companyModal.addToTarget'] || 'Add this company to outreach targets'}</span>
      </label>
    </div>
    <div class="hud-scanline hud-scanline-bottom"></div>
    <div class="modal-actions hud-actions">
      <button class="btn btn-outline-secondary" onclick="closeCompanyFormModal()">${_t['companyModal.cancel'] || 'Cancel'}</button>
      <button class="btn btn-primary hud-btn-primary" id="companyFormSubmitBtn" onclick="submitCompanyForm()">${_t['companyModal.submit'] || 'Add Company'}</button>
    </div>
  </div>
</div>

<!-- Main content area -->
<main style="margin-top:48px;padding:0;min-height:calc(100vh - 48px);background:var(--surface)">

<!-- Horizontal tab nav -->
<div id="mainTabNav">
  <button class="tab-btn active" data-tab="dashboard">
    <span class="material-symbols-outlined tab-icon">dashboard</span>
    ${_t['tab.dashboard'] || 'Dashboard'}
  </button>
  <button class="tab-btn" data-tab="companies">
    <span class="material-symbols-outlined tab-icon">table_view</span>
    ${_t['tab.companies']}
  </button>
  <button class="tab-btn" data-tab="list-builder" title="${_t['tab.listBuilder.title'] || 'Auto-collect company list'}">
    <span class="material-symbols-outlined tab-icon">playlist_add</span>
    ${_t['tab.listBuilder'] || 'List Builder'}
  </button>
  <!-- v2.0.85: 操作中タブ — AI が WebContentsView 内で実フォーム操作する様子をリアルタイム表示 -->
  <button class="tab-btn" data-tab="live-form" title="${_lang === 'ja' ? 'AI がフォームを操作する様子を表示' : 'Watch AI fill the form live'}">
    <span class="material-symbols-outlined tab-icon">smart_toy</span>
    ${_lang === 'ja' ? '操作中' : 'AI Live'}
    <span id="liveFormBadge" style="display:none;background:var(--success-container,#16a34a);color:#fff;font-size:.55rem;font-weight:800;padding:1px 5px;border-radius:8px;margin-left:4px">●</span>
    <span id="liveFormNeedsHumanBadge" title="${_lang === 'ja' ? '本人確認など要対応のセッション数' : 'Sessions needing manual action'}" style="display:none;align-items:center;gap:3px;background:#f59e0b;color:#3a2a00;font-size:.55rem;font-weight:800;padding:1px 6px;border-radius:8px;margin-left:4px"></span>
  </button>
  <!-- v2.0.93: セッションを終了 — 操作中タブで active session が居る時だけ表示 -->
  <button id="liveSessionEndInline" type="button" class="tab-end-btn" style="display:none" title="${_lang === 'ja' ? '稼働中の AI 操作セッションを終了' : 'End active AI operation session'}">
    <span class="material-symbols-outlined" style="font-size:13px">close</span>
    ${_lang === 'ja' ? 'セッションを終了' : 'End Session'}
  </button>
  <button class="tab-btn" data-tab="awaiting">
    <span class="material-symbols-outlined tab-icon">pending_actions</span>
    ${_t['tab.awaiting']}
    <span style="background:var(--warning-container);color:var(--warning);font-size:.6rem;font-weight:700;padding:1px 6px;border-radius:var(--radius-xl);font-family:var(--font-mono)" id="awaitingCount">0</span>
  </button>
  <button class="tab-btn" data-tab="sent">
    <span class="material-symbols-outlined tab-icon">mark_email_read</span>
    ${_t['tab.sent']}
  </button>
  <button class="tab-btn" data-tab="logs">
    <span class="material-symbols-outlined tab-icon">terminal</span>
    ${_t['tab.logs']}
    <span class="live-dot on" id="cliDot" style="margin-left:4px;width:7px;height:7px"></span>
  </button>
  <button class="tab-btn" data-tab="settings">
    <span class="material-symbols-outlined tab-icon">settings</span>
    ${_t['tab.settings']}
  </button>
</div>

<div style="padding:16px;display:flex;gap:16px;align-items:flex-start">
  <!-- Main content column -->
  <div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:12px">

  <!-- Dashboard tab: analytics-only view -->
  <div class="tab-content active" id="tab-dashboard">
  <div id="analyticsRow" class="chart-panel" style="padding:20px 22px;display:flex;flex-direction:column;margin-bottom:0;gap:0">
    <!-- HERO: donut + ratio + live badge -->
    <div class="analytics-hero">
      <div class="analytics-donut">
        <svg viewBox="0 0 120 120" aria-hidden="true">
          <defs>
            <linearGradient id="donutGradient" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stop-color="#3b82f6"/>
              <stop offset="100%" stop-color="#818cf8"/>
            </linearGradient>
          </defs>
          <circle class="donut-track" cx="60" cy="60" r="52"/>
          <circle class="donut-fill" id="analyticsDonutFill" cx="60" cy="60" r="52" stroke-dasharray="326.7" stroke-dashoffset="326.7"/>
        </svg>
        <div class="analytics-donut-center">
          <span class="analytics-donut-num" id="analyticsPercent">0</span>
          <span class="analytics-donut-suffix">%</span>
          <span class="analytics-donut-label">${_t['analytics.donut.complete'] || 'Complete'}</span>
        </div>
      </div>
      <div class="analytics-hero-main">
        <div class="analytics-hero-title">
          <span class="num" id="analyticsSubmittedNum">0</span>
          <span class="ratio" id="analyticsRatio">/ 0</span>
          <span class="lab">${_t['analytics.hero.sent'] || 'Sent'}</span>
        </div>
        <div class="analytics-pipeline-bar" id="analyticsPipeline">
          <span id="analyticsProgressBar" style="background:linear-gradient(90deg,#3b82f6,#6366f1);width:0%"></span>
        </div>
      </div>
      <div class="analytics-meta">
        <div class="analytics-live"><span class="analytics-live-dot"></span>Live</div>
        <div class="analytics-meta-sum" id="analyticsMetaSum">0 / 0 ${_t['analytics.meta.done'] || 'done'} (0%)</div>
      </div>
    </div>

    <!-- STAT CARDS (7 icons + numbers) -->
    <div class="stat-cards-row">
      <div class="stat-card-v2" style="--_c:#6366f1">
        <div class="stat-card-v2-head">
          <div class="stat-card-v2-icon"><span class="material-symbols-outlined">adjust</span></div>
          <div class="stat-card-v2-label">${_t['stats.target'] || _t['stats.target.label'] || 'Target'}</div>
        </div>
        <div class="stat-card-v2-num" id="s-approachable">0</div>
        <div class="stat-card-v2-note">${_t['stats.target.note'] || 'Total'}</div>
      </div>
      <div class="stat-card-v2" style="--_c:#94a3b8">
        <div class="stat-card-v2-head">
          <div class="stat-card-v2-icon"><span class="material-symbols-outlined">contact_page</span></div>
          <div class="stat-card-v2-label">${_t['stats.hasForm'] || _t['stats.hasForm.label'] || 'Has form'}</div>
        </div>
        <div class="stat-card-v2-num" id="s-hasFormUrl">0</div>
        <div class="stat-card-v2-note">${_t['stats.hasForm.note'] || 'Submittable'}</div>
      </div>
      <div class="stat-card-v2" style="--_c:#10b981">
        <div class="stat-card-v2-head">
          <div class="stat-card-v2-icon"><span class="material-symbols-outlined">mark_email_read</span></div>
          <div class="stat-card-v2-label">${_t['stats.sent'] || _t['stats.sent.label'] || 'Sent'}</div>
        </div>
        <div class="stat-card-v2-num" id="s-submitted">0</div>
        <div class="stat-card-v2-note">${_t['stats.sent.note'] || 'Completed'}</div>
      </div>
      <div class="stat-card-v2" style="--_c:#3b82f6">
        <div class="stat-card-v2-head">
          <div class="stat-card-v2-icon"><span class="material-symbols-outlined">task_alt</span></div>
          <div class="stat-card-v2-label">${_t['stats.filled'] || _t['stats.filled.label'] || 'Action'}</div>
        </div>
        <div class="stat-card-v2-num" id="s-formFill">0</div>
        <div class="stat-card-v2-note">${_t['stats.filled.note'] || 'Needs action'}</div>
      </div>
      <div class="stat-card-v2" style="--_c:#f59e0b">
        <div class="stat-card-v2-head">
          <div class="stat-card-v2-icon"><span class="material-symbols-outlined">hourglass_empty</span></div>
          <div class="stat-card-v2-label">${_t['stats.awaiting'] || _t['stats.awaiting.label'] || 'Awaiting'}</div>
        </div>
        <div class="stat-card-v2-num" id="s-awaitingApproval">0</div>
        <div class="stat-card-v2-note">${_t['stats.awaiting.note'] || 'Awaiting approval'}</div>
      </div>
      <div class="stat-card-v2" style="--_c:#ef4444">
        <div class="stat-card-v2-head">
          <div class="stat-card-v2-icon"><span class="material-symbols-outlined">error_outline</span></div>
          <div class="stat-card-v2-label">${_t['stats.error'] || _t['stats.error.label'] || 'Errors'}</div>
        </div>
        <div class="stat-card-v2-num" id="s-error">0</div>
        <div class="stat-card-v2-note">${_t['stats.error.note'] || 'Error count'}</div>
      </div>
      <div class="stat-card-v2" style="--_c:#64748b">
        <div class="stat-card-v2-head">
          <div class="stat-card-v2-icon"><span class="material-symbols-outlined">block</span></div>
          <div class="stat-card-v2-label">${_t['stats.excluded'] || _t['stats.excluded.label'] || 'Excluded'}</div>
        </div>
        <div class="stat-card-v2-num" id="s-excluded">0</div>
        <div class="stat-card-v2-note">${_t['stats.excluded.note'] || 'Excluded'}</div>
      </div>
    </div>

    <!-- TREND CHART -->
    <div class="analytics-trend-panel">
      <div class="analytics-trend-head">
        <div class="analytics-trend-title">${_t['analytics.trend.title'] || 'Processing trend'}</div>
        <div class="analytics-trend-legend">
          <span class="lg"><span class="dot" style="background:#10b981"></span>${_t['analytics.trend.legend.sent'] || 'Sent'}</span>
          <span class="lg"><span class="dot" style="background:#3b82f6"></span>${_t['analytics.trend.legend.action'] || 'Action'}</span>
          <span class="lg" style="color:#ef4444"><span class="dash"></span>${_t['analytics.trend.legend.error'] || 'Error'}</span>
        </div>
        <div class="analytics-trend-range"><span class="material-symbols-outlined">calendar_month</span>${_t['analytics.trend.range'] || '7 days'}</div>
      </div>
      <div class="analytics-trend-body"><canvas id="trendAreaChart"></canvas></div>
    </div>

    <!-- 3-COLUMN GRID: breakdown donut + daily bars + recent errors -->
    <div class="analytics-grid">
      <div class="analytics-sub-card">
        <div class="analytics-sub-title">${_t['analytics.breakdown.title'] || 'Status breakdown'}</div>
        <div class="breakdown-row">
          <div class="breakdown-donut-wrap">
            <svg viewBox="0 0 120 120" id="breakdownDonutSvg" aria-hidden="true">
              <circle cx="60" cy="60" r="46" fill="none" stroke="var(--bg-raised)" stroke-width="14"/>
            </svg>
            <div class="breakdown-donut-center">
              <div class="breakdown-donut-total" id="breakdownTotal">0</div>
              <div class="breakdown-donut-total-lab">${_t['analytics.breakdown.total'] || 'Total'}</div>
            </div>
          </div>
          <div class="breakdown-legend" id="breakdownLegend"></div>
        </div>
      </div>
      <div class="analytics-sub-card">
        <div class="analytics-sub-title">${_t['analytics.dailyBars.title'] || 'Daily sent'}</div>
        <div class="daily-bars"><canvas id="dailyBarsChart"></canvas></div>
      </div>
      <div class="analytics-sub-card">
        <div class="analytics-sub-title">
          <span>${_t['analytics.recentErrors.title'] || 'Recent errors'}</span>
          <button class="analytics-sub-action" onclick="showAllErrors()">${_t['analytics.recentErrors.viewAll'] || 'View all'}</button>
        </div>
        <div class="recent-errors" id="recentErrorsList">
          <div class="recent-errors-empty">${_t['analytics.recentErrors.empty'] || 'No errors'}</div>
        </div>
      </div>
    </div>

    <!-- INSIGHT CARD with wave deco -->
    <div class="insight-card">
      <div class="insight-icon"><span class="material-symbols-outlined">lightbulb</span></div>
      <div class="insight-body">
        <div class="insight-title">${_t['analytics.insight.title'] || 'Insight'}</div>
        <div class="insight-desc" id="insightDesc">${_t['analytics.insight.loading'] || 'Aggregating data...'}</div>
      </div>
      <svg class="insight-wave" viewBox="0 0 500 120" preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <linearGradient id="waveGradient" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stop-color="#10b981" stop-opacity=".55"/>
            <stop offset="50%" stop-color="#3b82f6" stop-opacity=".55"/>
            <stop offset="100%" stop-color="#a78bfa" stop-opacity=".45"/>
          </linearGradient>
        </defs>
        <path d="M0,60 Q100,20 200,60 T400,60 L500,60" fill="none" stroke="url(#waveGradient)" stroke-width="1.8"/>
        <path d="M0,80 Q125,40 250,80 T500,80" fill="none" stroke="url(#waveGradient)" stroke-width="1.3" opacity=".75"/>
        <path d="M0,40 Q75,90 150,40 T300,40 T450,40 L500,40" fill="none" stroke="url(#waveGradient)" stroke-width="1" opacity=".55"/>
      </svg>
    </div>

    <!-- Legacy hidden refs (kept for backward JS compat) -->
    <div style="display:none">
      <canvas id="statusDonutChart"></canvas>
      <span id="progressLabel"></span>
      <div id="pipeline" class="progress-pipeline"></div>
    </div>
  </div>
  </div>

  <!-- Companies tab (inside main column) -->
  <div class="tab-content" id="tab-companies">
    <div class="company-toolbar" style="flex-direction:column;gap:0">
      <!-- Row 1: Bulk action buttons -->
      <div class="bulk-toolbar" style="justify-content:flex-end">
        <button class="btn btn-outline-primary btn-sm" onclick="triggerCompanyImport()">${_t['action.importTargets'] || 'Import Excel/CSV'}</button>
        <button class="btn btn-outline-secondary btn-sm" onclick="openCompanyFormModal()">${_t['action.addCompany'] || 'Add Company'}</button>
        <button class="btn btn-outline-secondary btn-sm" onclick="toggleAllCompanies()">${_t['action.selectAll']}</button>
        <button class="btn btn-outline-danger btn-sm" onclick="bulkDeleteCompanies()">${_t['action.bulkDeleteCompanies'] || 'Delete Selected'}</button>
        <button class="btn btn-outline-primary btn-sm" onclick="markSelectedTargets(true)">${_t['action.markTarget'] || 'Mark Target'}</button>
        <button class="btn btn-outline-secondary btn-sm" onclick="markSelectedTargets(false)">${_t['action.unmarkTarget'] || 'Unmark Target'}</button>
        <button class="btn btn-primary btn-sm" onclick="prepareSelectedOutreach()">${_t['action.prepareOutreach'] || 'Prepare Outreach'}</button>
      </div>
      <!-- Row 2: Unified filter bar (pills + filter fields + search) -->
      <div class="filter-bar filter-bar-unified">
        <div class="filter-pills">
          <button class="fb active" data-f="all">${_t['filter.all']}</button>
          <button class="fb" data-f="approachable">${_t['filter.target']}</button>
          <button class="fb" data-f="targeted">${_t['filter.targeted'] || '営業対象'}</button>
          <button class="fb" data-f="has-form">${_t['filter.hasForm']}</button>
          <button class="fb" data-f="no-form">${_t['filter.noForm']}</button>
          <button class="fb" data-f="submitted">${_t['filter.sent']}</button>
          <button class="fb" data-f="error">${_t['filter.error']}</button>
          <button class="fb" data-f="excluded">${_t['filter.excluded']}</button>
        </div>
        <span class="filter-bar-divider" aria-hidden="true"></span>
        <div class="filter-field">
          <span class="ms">category</span>
          <select id="companyTypeFilter">
            <option value="">${_t['companies.filter.typeAll'] || 'Type: All'}</option>
          </select>
        </div>
        <div class="filter-field">
          <span class="ms">trending_up</span>
          <select id="companyProgressFilter">
            <option value="">${_t['companies.filter.progressAll'] || 'Progress: All'}</option>
          </select>
        </div>
        <div class="filter-field" style="flex:1;min-width:180px">
          <span class="ms">search</span>
          <input type="text" id="q" placeholder="${_t['filter.search']}">
        </div>
        <button id="clearFiltersBtn" class="filter-clear-btn" onclick="clearAllFilters()">
          <span class="material-symbols-outlined" style="font-size:13px">close</span>
          ${_t['companies.filter.reset'] || 'Reset'}
        </button>
      </div>
    </div>
    <div class="table-shell table-shell-scroll">
      <table class="main-table" id="mt">
<colgroup><col style="width:36px"><col style="width:44px"><col><col style="width:110px"><col style="width:110px"><col style="width:52px"><col style="width:170px"><col style="width:180px"><col style="width:200px"></colgroup>
<thead><tr><th class="checkbox-cell"><input type="checkbox" id="companySelectAll" class="form-check-input" onclick="toggleAllCompanies(this.checked)"></th><th onclick="sortTable('no')">${_t['th.no']} <span class="sort-icon" data-col="no"></span></th><th onclick="sortTable('name')">${_t['th.company']} <span class="sort-icon" data-col="name"></span></th><th onclick="sortTable('type')">${_t['th.type']} <span class="sort-icon" data-col="type"></span></th><th onclick="sortTable('progress')">${_t['th.progress']} <span class="sort-icon" data-col="progress"></span></th><th onclick="sortTable('sent')">${_t['th.sent']} <span class="sort-icon" data-col="sent"></span></th><th>${_t['th.formUrl']}</th><th>${_t['th.message']}</th><th class="action-cell">${_t['th.action']}</th></tr></thead>
        <tbody id="companyBody"></tbody>
      </table>
    </div>
  </div>

  <!-- v2.0.87/.88: AI 操作セッション (theme 対応, CSS var 化)
       v2.0.93: 白カード台座撤去, body 背景に統合し透過。完全レスポンシブ。 -->
  <style>
    /* live-form theme tokens (light/dark 両対応) — bg は親 body の透過に従う */
    .lfs-bg { background: transparent; color: var(--on-surface, #1a1a1a); }
    .lfs-card { background: transparent; border: none; border-radius: 0; padding: 0; }
    .lfs-card-bd { border-bottom: 1px dashed color-mix(in srgb, var(--outline-variant,#d8dee5) 35%, transparent); }
    .lfs-text { color: var(--on-surface, #1a1a1a); }
    .lfs-muted { color: var(--on-surface-variant, #5b6675); }
    .lfs-strong { color: var(--on-surface, #111); font-weight: 600; }
    .lfs-input-bg { background: transparent; }
    .lfs-active-bg { background: var(--primary, #1976d2); color: #fff; }
    .lfs-row-bg { background: color-mix(in srgb, var(--surface-container-low,#fafbfc) 40%, transparent); }
    .lfs-row-bg-active { background: var(--primary-container, #d6e6ff); color: var(--on-primary-container, #002a5c); }
    [data-theme="dark"] .lfs-card { border-color: color-mix(in srgb, #2a3441 70%, transparent); }
    [data-theme="dark"] .lfs-input-bg { background: color-mix(in srgb, #131b26 40%, transparent); }
    [data-theme="dark"] .lfs-row-bg { background: color-mix(in srgb, #131b26 50%, transparent); }
    [data-theme="dark"] .lfs-row-bg-active { background: #1e3a5f; color: #fff; }

    /* v2.0.93: 操作中タブ — 上部サマリ + 下部全幅 WebView */
    .lfs-main-grid {
      display: flex;
      flex-direction: column;
      gap: clamp(6px, 1vw, 12px);
      padding: clamp(6px, 1vw, 14px);
      /* v2.1.2: WebContentsView は Electron 仕様上 HTML より必ず前面に描画され、z-index で
         背面に送れない。そこで slot を画面下部から離し、固定表示の通知類
         (AIコスト目安=左下 bottom:14 / 監視FABボタン=右下 bottom:24 / 監視トースト=右下 bottom:80)
         が WebView に隠れてクリックできなくなる問題を防ぐ。dock は slot の
         getBoundingClientRect に追従するため、この下部余白だけで WebView の占有下端が押し上がる。 */
      padding-bottom: 116px;
      width: 100%;
      /* v2.1.1: 親タブ高さ一杯に伸ばし、子(WebView slot)を flex:1 で埋める。
         これでページ自体はスクロールせず、スクロールは WebView 内部に閉じる
         → スクロール時に native view が HTML を追えず「白い幕」が出る問題を根絶。 */
      height: 100%;
      min-height: 0;
      box-sizing: border-box;
    }
    .lfs-summary-row {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: clamp(8px, 1.2vw, 16px);
      padding: 4px 2px 8px;
    }
    @media (max-width: 880px) {
      .lfs-summary-row { grid-template-columns: 1fr; }
    }
    .lfs-summary-item {
      display: flex; flex-direction: column; gap: 6px; min-width: 0;
    }
    .lfs-summary-item .lfs-summary-head {
      display: flex; align-items: center; gap: 6px;
      font-size: .74rem; font-weight: 600;
      color: var(--on-surface, #111);
    }
    /* v2.0.95: 操作中タブは「純粋なブラウザが開いている」見た目に。
       進捗/現在の操作/実行ステップ・セッションチップは撤去 (右下 Live Monitor に集約)。
       WebView スロットは境界線のみのブラウザフレーム風に。 */
    .lfs-view-slot {
      position: relative;
      width: 100%;
      /* v2.1.1: 固定高さ(80vh)をやめ flex:1 でタブ残余を埋める。min-height は
         flex 計算が崩れた最悪時の可視フロア。背景はタイル間ギャップが
         区切り線に見えるよう薄いサーフェス色に。 */
      flex: 1 1 auto;
      min-height: clamp(360px, 58vh, 900px);
      overflow: hidden;
      contain: layout paint;
      isolation: isolate;
      border-radius: 10px;
      border: 1px solid var(--outline-variant, #d8dee5);
      box-shadow: 0 1px 3px rgba(15,23,42,.06);
      background: var(--surface-variant, #e8edf2);
    }
    [data-theme="dark"] .lfs-view-slot { border-color: color-mix(in srgb, #2a3441 75%, transparent); }

    /* v2.0.93: タブ横の End Session ボタン */
    .tab-end-btn {
      display: inline-flex; align-items: center; gap: 4px;
      background: linear-gradient(180deg, #ef4444, #dc2626);
      color: #fff; border: none; font-size: .68rem; font-weight: 700;
      padding: 5px 10px; border-radius: 999px; cursor: pointer;
      margin-left: 6px; box-shadow: 0 1px 2px rgba(0,0,0,.15);
      transition: filter .15s ease;
    }
    .tab-end-btn:hover { filter: brightness(1.08); }

    /* v2.0.93: フォームセッションタブの × 削除ボタン */
    .lf-session-close {
      display: inline-flex; align-items: center; justify-content: center;
      width: 16px; height: 16px; margin-left: 4px;
      background: rgba(255,255,255,.18); color: inherit;
      border: none; border-radius: 50%; cursor: pointer;
      font-size: 11px; line-height: 1; padding: 0;
      transition: background .15s ease;
    }
    .lf-session-close:hover { background: rgba(239,68,68,.85); color: #fff; }
  </style>
  <div class="tab-content lfs-bg" id="tab-live-form" style="height:calc(100vh - 92px);overflow:hidden">
    <!-- v2.0.93: ヘッダーカード撤去。状態は隠し span で保持 (script からの参照互換) -->
    <span id="liveSessionStatus" data-status="IDLE" style="display:none"></span>
    <span id="liveSessionId" style="display:none"></span>
    <span id="liveSessionMonitor" style="display:none"></span>
    <button id="liveSessionEnd" type="button" style="display:none" aria-hidden="true"></button>

    <!-- メイン グリッド: 上部 = 進捗/現在の操作/実行ステップ サマリ, 下部 = 全幅 WebView -->
    <div class="lfs-main-grid">

      <!-- v2.0.95: ヘッダー撤去 (純粋ブラウザ表示)。要素は script 互換のため残し非表示。 -->
      <div style="display:none;align-items:center;gap:10px;flex-wrap:wrap;padding:4px 2px">
        <span class="material-symbols-outlined" style="font-size:16px;color:#10b981">smart_toy</span>
        <span class="lfs-text" style="font-size:.85rem;font-weight:600">${_lang === 'ja' ? 'AI 操作中のブラウザ画面' : 'AI browser view'}</span>
        <span style="background:#10b981;width:7px;height:7px;border-radius:50%;display:inline-block"></span>
        <span class="lfs-muted" style="font-size:.72rem">${_lang === 'ja' ? 'リアルタイムプレビュー' : 'Real-time preview'}</span>
      </div>

      <!-- v2.0.95: 進捗/現在の操作/実行ステップ サマリは撤去 (右下 Live Monitor に集約)。
           要素 ID は renderProgress/renderCurrent/renderSteps 等の script 互換のため残し非表示。 -->
      <div class="lfs-summary-row" style="display:none">
        <div class="lfs-summary-item">
          <div class="lfs-summary-head">
            <span class="material-symbols-outlined" style="font-size:14px;color:#3b82f6">trending_up</span>
            <span>${_lang === 'ja' ? '進捗状況' : 'Progress'}</span>
          </div>
          <div style="display:flex;align-items:center;gap:12px">
            <svg width="56" height="56" viewBox="0 0 36 36" style="flex-shrink:0">
              <path d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" fill="none" stroke="var(--outline-variant,#d8dee5)" stroke-width="2.5"/>
              <path id="liveProgressArc" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" fill="none" stroke="#3b82f6" stroke-width="2.5" stroke-dasharray="0, 100"/>
              <text id="liveProgressText" x="18" y="20.5" text-anchor="middle" font-size="8" fill="var(--on-surface,#111)" font-weight="700">0%</text>
            </svg>
            <div style="flex:1;min-width:0">
              <div id="liveProgressStep" class="lfs-muted" style="font-size:.7rem">${_lang === 'ja' ? 'ステップ - / -' : 'Step - / -'}</div>
              <div id="liveProgressLabel" class="lfs-strong" style="font-size:.82rem;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${_lang === 'ja' ? '待機中' : 'Idle'}</div>
              <div id="liveProgressEta" class="lfs-muted" style="font-size:.68rem;margin-top:2px">${_lang === 'ja' ? '完了予定: -' : 'ETA: -'}</div>
            </div>
          </div>
        </div>

        <div class="lfs-summary-item">
          <div class="lfs-summary-head">
            <span class="material-symbols-outlined" style="font-size:14px;color:#10b981">play_circle</span>
            <span>${_lang === 'ja' ? '現在の操作' : 'Current Action'}</span>
          </div>
          <div id="liveCurrentAction" class="lfs-text" style="font-size:.76rem;line-height:1.5;min-height:1.5em">${_lang === 'ja' ? 'AI が起動するとここに表示されます。' : 'Action appears here when AI starts.'}</div>
          <div class="lfs-muted" style="font-size:.68rem;display:grid;gap:2px">
            <div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">URL: <span id="liveCurrentUrl" style="color:#3b82f6">-</span></div>
            <div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${_lang === 'ja' ? '要素' : 'Element'}: <span id="liveCurrentElement" style="color:#9333ea;font-family:monospace">-</span></div>
            <div>${_lang === 'ja' ? 'ステータス' : 'Status'}: <span id="liveCurrentStatus" style="color:#10b981">${_lang === 'ja' ? '待機' : 'idle'}</span></div>
          </div>
        </div>

        <div class="lfs-summary-item" style="overflow:hidden">
          <div class="lfs-summary-head">
            <span class="material-symbols-outlined" style="font-size:14px;color:#f59e0b">checklist</span>
            <span>${_lang === 'ja' ? '実行ステップ' : 'Execution Steps'}</span>
          </div>
          <div id="liveStepsList" style="overflow-y:auto;display:flex;flex-direction:column;gap:4px;max-height:160px;min-height:60px;font-size:.7rem">
            <div class="lfs-muted" style="font-size:.7rem;padding:4px">${_lang === 'ja' ? 'AI が動作するとステップが順次表示されます' : 'Steps will appear as AI works'}</div>
          </div>
        </div>
      </div>

      <!-- v2.1.1: 各セッションを表すスリムなブラウザタブ風チップ列を復活
           (ユーザー要望: 各 WebView タブに閉じるボタン)。社名 + ステータス + 個別 ×
           閉じるボタン + アクティブ強調を持つ。docking 行とは独立。 -->
      <div id="liveFormSessions" class="lfs-card-bd" style="display:flex;gap:4px;overflow-x:auto;padding:4px 2px;min-height:30px;flex-shrink:0"></div>

      <!-- v2.0.96: スリムなブラウザツールバー (セッション稼働時のみ表示)。
           WebContentsView は slot 上に native 描画されるため、閉じるボタンは slot の
           外 (上) に置く必要がある。アクティブな社名 + 閉じるボタンのみの最小構成。 -->
      <div id="liveFormToolbar" style="display:none;flex-shrink:0;align-items:center;gap:8px;padding:5px 10px;border:1px solid var(--outline-variant,#d8dee5);border-bottom:none;border-radius:10px 10px 0 0;background:color-mix(in srgb, var(--surface-container-low,#fafbfc) 60%, transparent)">
        <span id="liveFormToolbarDot" style="width:8px;height:8px;border-radius:50%;background:#10b981;flex-shrink:0"></span>
        <span id="liveFormToolbarLabel" style="font-size:.72rem;font-weight:600;color:var(--on-surface,#111);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1">—</span>
        <button id="liveFormMarkSentBtn" type="button" style="display:none;align-items:center;gap:3px;border:1px solid #16a34a;background:#16a34a;color:#fff;font-size:.66rem;font-weight:700;padding:3px 10px;border-radius:6px;cursor:pointer">
          <span class="material-symbols-outlined" style="font-size:13px">check</span>${_lang === 'ja' ? '送信済みにする' : 'Mark sent'}
        </button>
        <button id="liveFormCloseBtn" type="button" title="${_lang === 'ja' ? 'このブラウザを閉じる' : 'Close this browser'}" style="display:inline-flex;align-items:center;gap:3px;border:1px solid var(--outline-variant,#d8dee5);background:transparent;color:var(--on-surface,#111);font-size:.66rem;padding:3px 9px;border-radius:6px;cursor:pointer">
          <span class="material-symbols-outlined" style="font-size:13px">close</span>${_lang === 'ja' ? '閉じる' : 'Close'}
        </button>
      </div>

      <!-- 全幅 WebView slot -->
      <div id="liveFormViewSlot" class="lfs-view-slot">
        <div id="liveFormEmpty" class="lfs-muted" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:.85rem;text-align:center;padding:30px">
          ${_lang === 'ja' ? 'AI 起動 + フォーム入力中にここに WebView が表示されます。reCAPTCHA など人手操作も直接行えます。' : 'WebView appears here during AI form-filling.'}
        </div>
      </div>
    </div>

    <!-- v2.0.90: AI 思考プロセス + スクリーンショット履歴 パネル削除 (ユーザー要望: 機能としても不要)
         画面下部のスクロール領域削減で WebView がスクロール時に取り残されにくくなる副次効果も。 -->
    <div id="liveThoughts" style="display:none"></div>
    <div id="liveScreenshots" style="display:none"></div>
    <script>
      (function(){
        // v2.0.86: 操作中タブで HTML slot 位置に WebContentsView を dock。
        //   旧 (v0.85): showSession で固定座標 (winW*0.45) → window 外に表示される実機 bug
        //   新: HTML slot 要素の getBoundingClientRect() + devicePixelRatio で正確な
        //       page coords を計算 → /api/form-session/:id/set-bounds に POST。
        //       Electron は session.view.setBounds で物理的にその位置に配置。
        let _liveFormPollTimer = null;
        let _activeSessionId = null;

        // v2.0.93: 単一セッション dock 用 — 旧 API (チップクリック時に明示的に呼ぶ)
        async function syncViewBounds(sessionId) {
          if (!sessionId) return;
          if (String(sessionId).startsWith('virtual:')) return;
          const currentTab = document.querySelector('.tab-content.active')?.id;
          if (currentTab !== 'tab-live-form') {
            try {
              await fetch('/api/form-session/' + sessionId + '/set-bounds', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ x: -10000, y: -10000, width: 1, height: 1 }),
              });
            } catch (e) {}
            return;
          }
          const slot = document.getElementById('liveFormViewSlot');
          if (!slot) return;
          const rect = slot.getBoundingClientRect();
          // v2.0.90: viewport 外 (上スクロール時 rect.top < 0) は clip して
          //   表示領域だけに dock。完全に画面外に出たら hide (画面外に park)。
          //   page coord (window 内座標) → Electron setBounds は content area の page coord と一致する想定。
          // v2.0.92: hard guard — slot bbox 外には絶対に出さない (window 右半分占有の再発防止)。
          const winW = window.innerWidth;
          const winH = window.innerHeight;
          const nav = document.getElementById('mainTabNav');
          const reservedTop = nav ? Math.max(0, Math.round(nav.getBoundingClientRect().bottom)) : 0;
          const clippedTop = Math.max(reservedTop, rect.top);
          const clippedBottom = Math.min(winH, rect.bottom);
          const clippedHeight = clippedBottom - clippedTop;
          const clippedLeft = Math.max(0, rect.left);
          // v2.1.2: 監視パネル(右下 liveMonitorCard, 開くと縦長)が開いている時は
          //   WebView の右端をパネル幅(420)+余白 ぶん退避させ、パネルが WebView の
          //   裏に隠れて操作できなくなるのを防ぐ。閉じている時は退避しない。
          const _monPanel = document.getElementById('liveMonitorCard');
          const _monOpen = !!(_monPanel && _monPanel.style.display && _monPanel.style.display !== 'none');
          const _rightReserve = _monOpen ? 452 : 0;
          const clippedRight = Math.min(winW - _rightReserve, rect.right);
          const clippedWidth = clippedRight - clippedLeft;
          const bounds = {
            x: Math.round(clippedLeft),
            y: Math.round(clippedTop),
            width: Math.round(Math.max(0, clippedWidth)),
            height: Math.round(Math.max(0, clippedHeight)),
          };
          if (bounds.width < 50 || bounds.height < 50) {
            // viewport 外 — view を画面外に park (active session で hide はしたくない、
            // dock 位置だけ動かして見えなくする)
            try {
              await fetch('/api/form-session/' + sessionId + '/set-bounds', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ x: -10000, y: -10000, width: 100, height: 100 }),
              });
            } catch (e) {}
            return;
          }
          try {
            await fetch('/api/form-session/' + sessionId + '/set-bounds', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(bounds),
            });
          } catch (e) {}
        }

        // v2.0.93: 並列表示 — N 個のリアル session を slot 内タイルに同時 dock。
        //   Phase B の並列実行 (parallelTabs=3) で 3 社の WebView を同時に見せる。
        async function dockAllSessionsToTiles(realSessions) {
          const currentTab = document.querySelector('.tab-content.active')?.id;
          const slot = document.getElementById('liveFormViewSlot');
          if (currentTab !== 'tab-live-form' || !slot) {
            // 非 active 時は全 session を画面外 park
            for (const s of realSessions) {
              try {
                await fetch('/api/form-session/' + s.id + '/set-bounds', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ x: -10000, y: -10000, width: 1, height: 1 }),
                });
              } catch (e) {}
            }
            return;
          }
          const rect = slot.getBoundingClientRect();
          const winW = window.innerWidth;
          const winH = window.innerHeight;
          const nav = document.getElementById('mainTabNav');
          const reservedTop = nav ? Math.max(0, Math.round(nav.getBoundingClientRect().bottom)) : 0;
          const clippedTop = Math.max(reservedTop, rect.top);
          const clippedBottom = Math.min(winH, rect.bottom);
          const clippedHeight = clippedBottom - clippedTop;
          const clippedLeft = Math.max(0, rect.left);
          // v2.1.2: 監視パネル(右下 liveMonitorCard, 開くと縦長)が開いている時は
          //   WebView の右端をパネル幅(420)+余白 ぶん退避させ、パネルが WebView の
          //   裏に隠れて操作できなくなるのを防ぐ。閉じている時は退避しない。
          const _monPanel = document.getElementById('liveMonitorCard');
          const _monOpen = !!(_monPanel && _monPanel.style.display && _monPanel.style.display !== 'none');
          const _rightReserve = _monOpen ? 452 : 0;
          const clippedRight = Math.min(winW - _rightReserve, rect.right);
          const clippedWidth = clippedRight - clippedLeft;
          const n = realSessions.length;
          // v2.0.96: 4 セッション以上を 2x2 に詰めると 5 個目以降が 50px に潰れて
          //   操作不能になる。完了セッションは自動破棄されるため通常 1-3 個だが、
          //   念のため 4 個以上は「アクティブのみ全幅表示・他は画面外 park」に倒す。
          if (n > 3) {
            const activeId = _activeSessionId || (realSessions[realSessions.length - 1] || {}).id;
            for (const s of realSessions) {
              if (s.id === activeId) { await syncViewBounds(s.id); }
              else {
                try { await fetch('/api/form-session/' + s.id + '/set-bounds', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ x: -10000, y: -10000, width: 1, height: 1 }) }); } catch (e) {}
              }
            }
            return;
          }
          // 1 → 1x1, 2 → 1x2 horizontal, 3 → 1x3 horizontal
          let cols = 1, rows = 1;
          if (n === 2) cols = 2;
          else if (n === 3) cols = 3;
          // v2.1.1: タイル間ギャップを広げ、slot 背景(薄いサーフェス色)が区切り線として
          //   見えるようにする (どの WebView がどの社か分かりやすく)。
          const gap = 8;
          const tileW = Math.floor((clippedWidth - gap * (cols - 1)) / cols);
          const tileH = Math.floor((clippedHeight - gap * (rows - 1)) / rows);
          if (tileW < 50 || tileH < 50) {
            // viewport が狭すぎる場合は active のみ表示、他は park
            const activeId = _activeSessionId || (realSessions[realSessions.length - 1] || {}).id;
            for (const s of realSessions) {
              if (s.id === activeId) await syncViewBounds(s.id);
              else {
                try { await fetch('/api/form-session/' + s.id + '/set-bounds', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ x: -10000, y: -10000, width: 1, height: 1 }) }); } catch (e) {}
              }
            }
            return;
          }
          for (let i = 0; i < n; i++) {
            const s = realSessions[i];
            const r = Math.floor(i / cols);
            const c = i % cols;
            const x = Math.round(clippedLeft + c * (tileW + gap));
            const y = Math.round(clippedTop + r * (tileH + gap));
            const w = tileW;
            const h = tileH;
            try {
              await fetch('/api/form-session/' + s.id + '/set-bounds', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ x, y, width: w, height: h }),
              });
            } catch (e) {}
          }
        }

        async function refreshLiveFormSessions() {
          try {
            const [sessionsRes, dataRes] = await Promise.all([
              fetch('/api/form-session'),
              fetch('/api/data'),
            ]);
            if (!sessionsRes.ok) return;
            const j = await sessionsRes.json();
            const list = j.sessions || [];
            const data = dataRes.ok ? await dataRes.json() : { liveMonitor: { events: [] } };
            const events = (data.liveMonitor && data.liveMonitor.events) || [];

            const bar = document.getElementById('liveFormSessions');
            const empty = document.getElementById('liveFormEmpty');
            if (!bar) return;
            const badge = document.getElementById('liveFormBadge');
            if (badge) badge.style.display = list.length > 0 ? 'inline-block' : 'none';

            // セッション ID / ステータス更新
            const sessionIdEl = document.getElementById('liveSessionId');
            const liveStatusEl = document.getElementById('liveSessionStatus');
            if (list.length === 0) {
              bar.innerHTML = '<span style="color:#5b6675;font-size:.7rem;padding:6px">${_lang === 'ja' ? '稼働中のセッションはありません' : 'No active sessions'}</span>';
              if (empty) empty.style.display = 'flex';
              if (sessionIdEl) sessionIdEl.textContent = '${_lang === 'ja' ? 'セッション待機中…' : 'Waiting for session...'}';
              if (liveStatusEl) { liveStatusEl.textContent = 'IDLE'; liveStatusEl.style.background = '#5b6675'; }
              const endBtnInline = document.getElementById('liveSessionEndInline');
              if (endBtnInline) endBtnInline.style.display = 'none';
              const tb = document.getElementById('liveFormToolbar');
              if (tb) tb.style.display = 'none';
              const slotEl = document.getElementById('liveFormViewSlot');
              if (slotEl) slotEl.style.borderRadius = '10px';
              _activeSessionId = null;
              renderProgress(null, events);
              renderCurrent(null, events);
              renderSteps([], null);
              renderThoughts([]);
              refreshScreenshots([]);
              return;
            }
            const hasRealSession = list.some(s => !String(s.id||'').startsWith('virtual:'));
            if (empty) {
              empty.style.display = hasRealSession ? 'none' : 'flex';
              if (!hasRealSession) {
                empty.innerHTML = '${_lang === 'ja' ? '並列実行中 (外部 Chromium 経路) — WebView は内蔵モード時のみ表示されます。<br>進捗・スクショは右側で確認できます。' : 'Parallel run (external Chromium). WebView only shown in internal mode.'}';
              }
            }
            if (liveStatusEl) { liveStatusEl.textContent = 'LIVE'; liveStatusEl.style.background = '#10b981'; }
            // v2.0.89: FormSessionManager.listSessions() は isActive を返す。
            //   旧 (~v0.88) は s.active を見ていて、fallback で常に list[last] が選ばれ
            //   "active 強調が動かない" 体験になっていた。
            //   さらにユーザーがタブをクリックして _activeSessionId をセットしたら
            //   その選択を最優先する (API は仮想 session を isActive:false で返すので
            //   それだけだと毎 refresh で active が list[last] に戻ってしまう)。
            const clientActive = _activeSessionId && list.some(s => s.id === _activeSessionId) ? _activeSessionId : null;
            const activeSid = clientActive || list.find(s => s.isActive)?.id || list.find(s => s.active)?.id || list[list.length - 1]?.id;
            const activeSession = list.find(s => s.id === activeSid) || list[list.length - 1];
            if (sessionIdEl && activeSession) {
              sessionIdEl.textContent = 'No.' + (activeSession.companyNo || '?') + ' / ' + (activeSession.id || '').slice(0, 12);
            }
            // v2.0.96/97: ブラウザツールバー (実セッション稼働時のみ)。
            //   CAPTCHA/要対応セッションがアクティブなら赤い「要対応」バナー + 送信済みボタン。
            const toolbarEl = document.getElementById('liveFormToolbar');
            const slotEl2 = document.getElementById('liveFormViewSlot');
            const needsHuman = !!(activeSession && (activeSession.captchaDetected || activeSession.needsHuman));
            if (toolbarEl) {
              if (hasRealSession && activeSession && !String(activeSession.id||'').startsWith('virtual:')) {
                toolbarEl.style.display = 'flex';
                if (slotEl2) slotEl2.style.borderRadius = '0 0 10px 10px';
                const labelEl = document.getElementById('liveFormToolbarLabel');
                const dotEl = document.getElementById('liveFormToolbarDot');
                const markBtn = document.getElementById('liveFormMarkSentBtn');
                const nm = (activeSession.companyName || '').toString().slice(0, 40)
                  .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
                const noLabel = 'No.' + (activeSession.companyNo || '?') + (nm ? ' ' + nm : '');
                if (needsHuman) {
                  // 要対応: アンバー(警告)アクセント + アイコン。絵文字は使わず端正に。
                  toolbarEl.style.background = 'color-mix(in srgb, #f59e0b 13%, transparent)';
                  toolbarEl.style.borderColor = 'color-mix(in srgb, #f59e0b 55%, transparent)';
                  if (dotEl) dotEl.style.display = 'none';
                  if (labelEl) labelEl.innerHTML =
                    '<span class="material-symbols-outlined" style="font-size:15px;color:#d97706;vertical-align:-3px;margin-right:5px">verified_user</span>' +
                    '<b style="color:#b45309">${_lang === 'ja' ? '本人確認が必要です' : 'Verification needed'}</b>' +
                    '<span style="opacity:.72;margin-left:7px">${_lang === 'ja' ? '下のブラウザで認証を完了し、右の「送信済みにする」を押してください' : 'complete the check below, then press “Mark sent”'}</span>' +
                    '<span style="opacity:.5;margin-left:7px;font-family:var(--font-mono);font-size:.92em">' + noLabel + '</span>';
                  if (markBtn) markBtn.style.display = 'inline-flex';
                } else {
                  toolbarEl.style.background = 'color-mix(in srgb, var(--surface-container-low,#fafbfc) 60%, transparent)';
                  toolbarEl.style.borderColor = 'var(--outline-variant,#d8dee5)';
                  if (dotEl) { dotEl.style.display = 'inline-block'; dotEl.style.background = '#10b981'; }
                  if (labelEl) labelEl.textContent = noLabel + ' · ' + (activeSession.status || '');
                  if (markBtn) markBtn.style.display = 'none';
                }
                toolbarEl.dataset.activeSid = activeSession.id || '';
                toolbarEl.dataset.activeNo = String(activeSession.companyNo || '');
              } else {
                toolbarEl.style.display = 'none';
                if (slotEl2) slotEl2.style.borderRadius = '10px';
              }
            }
            // v2.0.97: 操作中タブの「要対応」件数バッジ (CAPTCHA セッション数, real+virtual)
            const needsHumanCount = list.filter(s => s.captchaDetected || s.needsHuman).length;
            const nhBadge = document.getElementById('liveFormNeedsHumanBadge');
            if (nhBadge) {
              if (needsHumanCount > 0) { nhBadge.style.display = 'inline-flex'; nhBadge.textContent = '${_lang === 'ja' ? '要対応' : 'action'} ' + needsHumanCount; }
              else nhBadge.style.display = 'none';
            }

            // v2.0.93: chip 再描画メモ化 — 同じ list なら innerHTML 置換をスキップして
            //   無駄な reflow を抑える (Phase B 並列で 2 秒毎に呼ばれるため)
            const sigParts = list.map(s => (s.id||'')+'/'+(s.status||'')+'/'+(s.captchaDetected?1:0)+'/'+(s.id===activeSid?'A':'-'));
            const newSig = sigParts.join('|');
            if (bar.dataset.sig === newSig) {
              // chip だけスキップ。dock / 進捗等は続行
            } else {
              bar.dataset.sig = newSig;
            // v2.0.90: 社名表示 + CAPTCHA バッジ (ユーザー要望: 社名とロボチェッカだと残してわかりやすいように)
            bar.innerHTML = list.map(s => {
              const isActive = s.id === activeSid;
              const cls = isActive ? 'lfs-active-bg' : 'lfs-row-bg lfs-text';
              const ring = isActive ? 'box-shadow:0 0 0 2px #3b82f6' : '';
              const isVirtual = String(s.id||'').startsWith('virtual:');
              const virtualBadge = isVirtual ? '<span title="外部 Chromium 経路 (並列モード)" style="background:#f59e0b;color:#fff;font-size:.55rem;padding:1px 4px;border-radius:3px;margin-left:4px">ext</span>' : '';
              const captchaBadge = s.captchaDetected ? '<span title="${_lang === 'ja' ? '本人確認が必要 — 人手対応' : 'Verification required'}" style="display:inline-flex;align-items:center;background:#f59e0b;color:#3a2a00;font-size:.55rem;padding:1px 5px;border-radius:3px;margin-left:4px;font-weight:800">${_lang === 'ja' ? '要対応' : 'action'}</span>' : '';
              const nameStr = (s.companyName || '').toString().slice(0, 14);
              const escName = nameStr.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
              const fullName = (s.companyName || '').toString().replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
              const titleAttr = 'No.' + (s.companyNo||'?') + ' ' + fullName + ' (' + (s.status||'') + ')';
              return '<span data-sid="' + s.id + '" class="lf-session-chip-wrap" style="display:inline-flex;align-items:center">' +
                '<button data-sid="' + s.id + '" data-no="' + (s.companyNo||'') + '" title="' + titleAttr + '" class="lf-session-btn ' + cls + '" style="' + ring + ';font-size:.72rem;padding:5px 10px;border-radius:999px 0 0 999px;cursor:pointer;white-space:nowrap;border:1px solid var(--outline-variant,#d8dee5);border-right:none;max-width:220px;overflow:hidden;text-overflow:ellipsis">' +
                  '<span style="font-weight:700">No.' + (s.companyNo||'?') + '</span>' +
                  (escName ? ' <span style="opacity:.85">' + escName + '</span>' : '') +
                  ' <span style="opacity:.65;font-size:.62rem">· ' + (s.status||'') + '</span>' +
                  captchaBadge + virtualBadge +
                '</button>' +
                '<button data-close-sid="' + s.id + '" class="lf-session-close ' + cls + '" title="${_lang === 'ja' ? 'このセッションを閉じる' : 'Close this session'}" style="border-radius:0 999px 999px 0;border:1px solid var(--outline-variant,#d8dee5);border-left:none;width:22px;height:auto;align-self:stretch">×</button>' +
                '</span>';
            }).join('');
            bar.querySelectorAll('.lf-session-btn').forEach(b => {
              b.addEventListener('click', async () => {
                const sid = b.getAttribute('data-sid');
                _activeSessionId = sid;
                await syncViewBounds(sid);
                setTimeout(refreshLiveFormSessions, 300);
              });
            });
            bar.querySelectorAll('[data-close-sid]').forEach(b => {
              b.addEventListener('click', async (ev) => {
                ev.stopPropagation();
                const sid = b.getAttribute('data-close-sid');
                if (!sid) return;
                try {
                  if (String(sid).startsWith('virtual:')) {
                    // virtual session は API 削除対象外。UI だけ即時消す。
                    b.closest('.lf-session-chip-wrap')?.remove();
                  } else {
                    await fetch('/api/form-session/' + encodeURIComponent(sid), { method: 'DELETE' });
                  }
                } catch (e) {}
                if (_activeSessionId === sid) _activeSessionId = null;
                refreshLiveFormSessions();
              });
            });
            } // close memoization else

            // v2.0.93: タブ横の "セッションを終了" ボタン制御
            const endBtnInline = document.getElementById('liveSessionEndInline');
            if (endBtnInline) {
              endBtnInline.style.display = hasRealSession ? 'inline-flex' : 'none';
              if (!endBtnInline.dataset.bound) {
                endBtnInline.dataset.bound = '1';
                endBtnInline.addEventListener('click', async () => {
                  if (!confirm('${_lang === 'ja' ? '稼働中のすべてのフォームセッションを終了しますか？' : 'End all active form sessions?'}')) return;
                  try {
                    const r = await fetch('/api/form-session');
                    if (r.ok) {
                      const jj = await r.json();
                      const all = (jj.sessions || []).filter(x => !String(x.id||'').startsWith('virtual:'));
                      await Promise.all(all.map(x => fetch('/api/form-session/' + encodeURIComponent(x.id), { method: 'DELETE' }).catch(()=>{})));
                    }
                  } catch (e) {}
                  _activeSessionId = null;
                  refreshLiveFormSessions();
                });
              }
            }

            // v2.0.96: ツールバーの "閉じる" — 表示中のアクティブセッションのみ破棄
            const closeBtn = document.getElementById('liveFormCloseBtn');
            if (closeBtn && !closeBtn.dataset.bound) {
              closeBtn.dataset.bound = '1';
              closeBtn.addEventListener('click', async () => {
                const tb = document.getElementById('liveFormToolbar');
                const sid = (tb && tb.dataset.activeSid) || _activeSessionId;
                if (!sid || String(sid).startsWith('virtual:')) return;
                try { await fetch('/api/form-session/' + encodeURIComponent(sid), { method: 'DELETE' }); } catch (e) {}
                if (_activeSessionId === sid) _activeSessionId = null;
                refreshLiveFormSessions();
              });
            }

            // v2.0.97: ツールバーの "送信済みにする" — 手動でCAPTCHA解決+送信した後に確定
            const markSentBtn = document.getElementById('liveFormMarkSentBtn');
            if (markSentBtn && !markSentBtn.dataset.bound) {
              markSentBtn.dataset.bound = '1';
              markSentBtn.addEventListener('click', async () => {
                const tb = document.getElementById('liveFormToolbar');
                const no = (tb && tb.dataset.activeNo) || '';
                if (!no) return;
                if (!confirm('${_lang === 'ja' ? 'このフォームを手動送信済みとして記録しますか?完了画面のスクリーンショットを撮影します。' : 'Mark this form as manually submitted? A screenshot of the completion page will be captured.'}')) return;
                markSentBtn.disabled = true;
                try {
                  await fetch('/api/form-session/mark-sent', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ companyNo: no }) });
                } catch (e) {}
                markSentBtn.disabled = false;
                _activeSessionId = null;
                refreshLiveFormSessions();
              });
            }

            const currentTab = document.querySelector('.tab-content.active')?.id;
            if (currentTab === 'tab-live-form') {
              _activeSessionId = activeSid;
              // v2.0.93: 並列タイル表示 — N セッションを同時に slot 内タイルへ dock
              const realSessions = list.filter(s => !String(s.id||'').startsWith('virtual:'));
              if (realSessions.length > 0) await dockAllSessionsToTiles(realSessions);
            }

            // 進捗・現在の操作・ステップ更新 (active session の companyNo を使う)
            const activeNo = activeSession ? Number(activeSession.companyNo) : null;
            const companyEvents = activeNo ? events.filter(e => Number(e.companyNo) === activeNo) : [];
            renderProgress(activeSession, companyEvents);
            renderCurrent(activeSession, companyEvents);
            renderSteps(companyEvents, activeSession);
            renderThoughts(companyEvents);
            refreshScreenshots(list);
          } catch (e) {}
        }

        // 進捗 (% 円グラフ + ステップ数 + ETA)
        function renderProgress(activeSession, events) {
          // v2.0.89: live-monitor.events は action フィールドを持たない (status + step のみ)。
          //   旧コード (~v0.88) は latest.action だけ見ていたので、parallel form-fill 中
          //   ずっと 0% / 「待機中」のままになっていた。status と activeSession.status を
          //   合算判定するように拡張。
          const TOTAL_STEPS = 20;
          const STATUS_WEIGHTS = {
            analyzing: 3, drafting: 5, navigating: 8, loading: 8,
            filling: 13, confirming: 16,
            awaiting_approval: 18, awaiting: 18,
            submitted: 20, skipped: 20, error: 20, done: 20,
          };
          const ACTION_WEIGHTS = {
            site_discovery: 2, site_analysis: 3, message_draft: 5,
            form_fill: 13, confirm_reached: 16,
            awaiting_approval: 18, submitted: 20, skipped: 20, error: 20,
          };
          const LABELS = {
            analyzing: '${_lang === 'ja' ? 'サイトを分析中…' : 'Analyzing site...'}',
            drafting: '${_lang === 'ja' ? 'メッセージを起草中…' : 'Drafting message...'}',
            navigating: '${_lang === 'ja' ? 'フォームへ遷移中…' : 'Navigating...'}',
            loading: '${_lang === 'ja' ? 'ページを読み込み中…' : 'Loading page...'}',
            filling: '${_lang === 'ja' ? 'フォームに情報を入力しています' : 'Filling form...'}',
            confirming: '${_lang === 'ja' ? '確認画面に到達' : 'Reached confirm page'}',
            awaiting_approval: '${_lang === 'ja' ? '承認待ち' : 'Awaiting approval'}',
            awaiting: '${_lang === 'ja' ? '承認待ち' : 'Awaiting approval'}',
            submitted: '${_lang === 'ja' ? '送信完了' : 'Submitted'}',
            skipped: '${_lang === 'ja' ? 'スキップ' : 'Skipped'}',
            error: '${_lang === 'ja' ? 'エラー' : 'Error'}',
            done: '${_lang === 'ja' ? '完了' : 'Done'}',
            site_discovery: '${_lang === 'ja' ? 'サイトを確認中…' : 'Probing site...'}',
            site_analysis: '${_lang === 'ja' ? 'サイトを分析中…' : 'Analyzing site...'}',
            message_draft: '${_lang === 'ja' ? 'メッセージを起草中…' : 'Drafting message...'}',
            form_fill: '${_lang === 'ja' ? 'フォームに情報を入力しています' : 'Filling form...'}',
            confirm_reached: '${_lang === 'ja' ? '確認画面に到達' : 'Reached confirm page'}',
          };
          let currentStep = 1;
          let label = '${_lang === 'ja' ? '待機中' : 'Idle'}';
          const latest = events[events.length - 1];
          // 優先順: latest.action > latest.status > activeSession.status
          const key = (latest && (latest.action || latest.status)) || (activeSession && activeSession.status) || '';
          const weight = ACTION_WEIGHTS[key] || STATUS_WEIGHTS[key];
          if (weight) {
            currentStep = weight;
            label = LABELS[key] || key;
          } else if (latest && latest.step) {
            currentStep = Math.max(currentStep, 2);
            label = String(latest.step).slice(0, 80);
          }
          const pct = Math.round((currentStep / TOTAL_STEPS) * 100);
          const arcEl = document.getElementById('liveProgressArc');
          const textEl = document.getElementById('liveProgressText');
          const stepEl = document.getElementById('liveProgressStep');
          const labelEl = document.getElementById('liveProgressLabel');
          const etaEl = document.getElementById('liveProgressEta');
          if (arcEl) arcEl.setAttribute('stroke-dasharray', pct + ', 100');
          if (textEl) textEl.textContent = pct + '%';
          if (stepEl) stepEl.textContent = '${_lang === 'ja' ? 'ステップ' : 'Step'} ' + currentStep + ' / ' + TOTAL_STEPS;
          if (labelEl) labelEl.textContent = label;
          if (etaEl) {
            if (currentStep >= TOTAL_STEPS) etaEl.textContent = '${_lang === 'ja' ? '完了' : 'Done'}';
            else {
              const remainingSec = (TOTAL_STEPS - currentStep) * 6;
              const mins = Math.ceil(remainingSec / 60);
              etaEl.textContent = '${_lang === 'ja' ? '完了予定: 約' : 'ETA: ~'}' + mins + '${_lang === 'ja' ? '分' : 'min'}';
            }
          }
        }

        // 現在の操作 (URL / element / status)
        function renderCurrent(activeSession, events) {
          const actionEl = document.getElementById('liveCurrentAction');
          const urlEl = document.getElementById('liveCurrentUrl');
          const elemEl = document.getElementById('liveCurrentElement');
          const statusEl = document.getElementById('liveCurrentStatus');
          const latest = events[events.length - 1];
          if (!latest) {
            if (actionEl) actionEl.textContent = '${_lang === 'ja' ? 'AI が起動するとここに表示されます。' : 'Action appears here when AI starts.'}';
            if (urlEl) urlEl.textContent = '-';
            if (elemEl) elemEl.textContent = '-';
            if (statusEl) { statusEl.textContent = '${_lang === 'ja' ? '待機' : 'idle'}'; statusEl.style.color = '#5b6675'; }
            return;
          }
          if (actionEl) actionEl.textContent = (latest.step || latest.action || '').toString().slice(0, 200);
          if (urlEl) urlEl.textContent = (latest.currentUrl || activeSession?.formUrl || '-').toString().slice(0, 80);
          if (elemEl) elemEl.textContent = (latest.element || latest.selector || '-').toString().slice(0, 60);
          if (statusEl) {
            statusEl.textContent = latest.status || '${_lang === 'ja' ? '進行中' : 'running'}';
            statusEl.style.color = latest.status === 'error' ? '#ef4444' : (latest.status === 'submitted' ? '#10b981' : '#3b82f6');
          }
        }

        // v2.0.90: 実行ステップを baseline pipeline 表示に変更。
        //   旧 (~v0.89) は events をそのまま並べていたので、parallel-analysis.ts が
        //   site_discovery を skip するケース (formUrl 既知) では「実行ステップ」が
        //   1 件しか出ず "進捗を追っている感" が皆無だった (ユーザー報告)。
        //   新: 固定 5 段階パイプラインを常時表示し、events / activeSession.status から
        //       現在地を判定して 完了 ✓ / 実行中 ● / 未着手 ◯ をマークする。
        function renderSteps(events, activeSession) {
          const el = document.getElementById('liveStepsList');
          if (!el) return;
          // 固定 5 ステップ
          const PIPELINE = [
            { key: 'analysis', weight: 3,
              label: '${_lang === 'ja' ? 'サイト分析' : 'Site analysis'}',
              actions: ['site_discovery','site_analysis'],
              statuses: ['analyzing','loading'] },
            { key: 'draft', weight: 5,
              label: '${_lang === 'ja' ? 'メッセージ起草' : 'Draft message'}',
              actions: ['message_draft'],
              statuses: ['drafting'] },
            { key: 'navigate', weight: 8,
              label: '${_lang === 'ja' ? 'フォーム遷移' : 'Navigate to form'}',
              actions: ['form_navigate','navigate'],
              statuses: ['navigating'] },
            { key: 'fill', weight: 13,
              label: '${_lang === 'ja' ? 'フォーム入力' : 'Fill form'}',
              actions: ['form_fill'],
              statuses: ['filling','filled'] },
            { key: 'confirm', weight: 16,
              label: '${_lang === 'ja' ? '確認画面到達' : 'Reach confirm'}',
              actions: ['confirm_reached'],
              statuses: ['confirming','confirmed'] },
            { key: 'done', weight: 20,
              label: '${_lang === 'ja' ? '承認待ち / 完了' : 'Awaiting / Done'}',
              actions: ['awaiting_approval','submitted','skipped','error'],
              statuses: ['awaiting_approval','awaiting','submitted','skipped','error','done'] },
          ];

          // 現在の weight を算出 (events の最新 + activeSession.status 両方から)
          const STATUS_WEIGHTS = {
            analyzing: 3, loading: 3, drafting: 5, navigating: 8,
            filling: 13, filled: 13, confirming: 16, confirmed: 16,
            awaiting_approval: 18, awaiting: 18, submitted: 20, skipped: 20, error: 20, done: 20,
          };
          const ACTION_WEIGHTS = {
            site_discovery: 2, site_analysis: 3, message_draft: 5,
            form_navigate: 8, navigate: 8,
            form_fill: 13, confirm_reached: 16,
            awaiting_approval: 18, submitted: 20, skipped: 20, error: 20,
          };
          let maxWeight = 0;
          let isError = false;
          let isSkipped = false;
          let isTerminal = false;
          (events || []).forEach((e) => {
            const w = ACTION_WEIGHTS[e.action] || STATUS_WEIGHTS[e.status] || 0;
            if (w > maxWeight) maxWeight = w;
            if (e.action === 'error' || e.status === 'error') isError = true;
            if (e.action === 'skipped' || e.status === 'skipped') isSkipped = true;
            if (e.action === 'submitted' || e.status === 'submitted' || e.action === 'awaiting_approval' || e.status === 'awaiting_approval' || e.status === 'awaiting') isTerminal = true;
          });
          if (activeSession) {
            const w = STATUS_WEIGHTS[activeSession.status] || 0;
            if (w > maxWeight) maxWeight = w;
          }

          // ステップ毎の状態判定
          const items = PIPELINE.map((step, i) => {
            const nextWeight = i + 1 < PIPELINE.length ? PIPELINE[i+1].weight : Infinity;
            // 完了: 次の step の weight 以上に進んでいる、または現在 step が done/error/skipped
            let state = 'pending';
            if (maxWeight >= nextWeight) state = 'done';
            else if (maxWeight >= step.weight) state = (i === PIPELINE.length - 1 && (isTerminal || isError || isSkipped)) ? 'done' : 'running';
            // 最終ステップが terminal なら done 確定
            if (step.key === 'done' && (isTerminal || isError || isSkipped)) state = 'done';

            // この step に対応する最新 event の timestamp / step text
            let ts = '';
            let detail = '';
            for (let j = (events || []).length - 1; j >= 0; j--) {
              const ev = events[j];
              if (step.actions.includes(ev.action) || step.statuses.includes(ev.status)) {
                ts = (ev.timestamp || ev.updatedAt || '').toString().substr(11, 8);
                detail = (ev.step || '').toString().slice(0, 60);
                break;
              }
            }

            const dotColor = state === 'done'
              ? (step.key === 'done' && isError ? '#ef4444' : '#10b981')
              : state === 'running' ? '#3b82f6' : 'var(--outline-variant,#d8dee5)';
            const dotIcon = state === 'done' ? '✓' : state === 'running' ? '●' : (i+1);
            const dotTextColor = state === 'pending' ? 'var(--on-surface-variant,#5b6675)' : '#fff';
            const statusText = state === 'done' ? '${_lang === 'ja' ? '完了' : 'done'}'
              : state === 'running' ? '${_lang === 'ja' ? '実行中' : 'running'}'
              : '${_lang === 'ja' ? '未' : 'pending'}';
            const statusBg = state === 'done' ? 'var(--surface-variant,#e8edf2)'
              : state === 'running' ? '#3b82f6'
              : 'transparent';
            const statusFg = state === 'done' ? 'var(--on-surface-variant,#5b6675)'
              : state === 'running' ? '#fff'
              : 'var(--on-surface-variant,#5b6675)';
            const rowClass = state === 'running' ? 'lfs-row-bg-active' : 'lfs-row-bg';
            const opacity = state === 'pending' ? '.55' : '1';

            return '<div class="' + rowClass + '" style="display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:6px;font-size:.72rem;opacity:' + opacity + '">' +
              '<span style="width:20px;height:20px;border-radius:50%;background:' + dotColor + ';display:inline-flex;align-items:center;justify-content:center;color:' + dotTextColor + ';font-weight:700;font-size:.62rem;flex-shrink:0">' + dotIcon + '</span>' +
              '<span class="lfs-text" style="flex:1;font-weight:' + (state === 'running' ? '600' : '500') + '">' + step.label +
                (detail ? '<span class="lfs-muted" style="font-weight:400;font-size:.65rem;margin-left:6px">— ' + detail.replace(/</g,'&lt;').replace(/>/g,'&gt;') + '</span>' : '') +
              '</span>' +
              (ts ? '<span class="lfs-muted" style="font-family:monospace;font-size:.62rem;flex-shrink:0">' + ts + '</span>' : '') +
              '<span style="background:' + statusBg + ';color:' + statusFg + ';font-size:.58rem;padding:2px 7px;border-radius:4px;flex-shrink:0;border:1px solid var(--outline-variant,#d8dee5)">' + statusText + '</span>' +
              '</div>';
          });
          el.innerHTML = items.join('');
        }

        // AI 思考プロセス
        function renderThoughts(events) {
          const el = document.getElementById('liveThoughts');
          if (!el) return;
          if (events.length === 0) {
            el.innerHTML = '<div style="color:#5b6675;font-size:.72rem">${_lang === 'ja' ? '思考ログがここにストリーミング表示されます' : 'Reasoning log streams here'}</div>';
            return;
          }
          el.innerHTML = events.slice(-10).reverse().map((e) => {
            const ts = (e.timestamp || e.updatedAt || '').toString().substr(11, 8);
            const text = (e.step || e.action || '').toString().slice(0, 200);
            return '<div style="display:flex;gap:8px;font-size:.72rem;align-items:start"><span class="lfs-muted" style="font-family:monospace;flex-shrink:0">' + ts + '</span>' +
              '<span style="color:#10b981;flex-shrink:0">●</span>' +
              '<span class="lfs-text" style="flex:1">' + text.replace(/</g,'&lt;').replace(/>/g,'&gt;') + '</span>' +
              '</div>';
          }).join('');
        }

        // スクリーンショット履歴
        async function refreshScreenshots(sessions) {
          const el = document.getElementById('liveScreenshots');
          if (!el) return;
          // session 各社の screenshot path を収集 (action-log の screenshot field から)
          try {
            const r = await fetch('/api/data');
            if (!r.ok) return;
            const j = await r.json();
            const events = (j.liveMonitor && j.liveMonitor.events) || [];
            const noSet = new Set(sessions.map(s => Number(s.companyNo)).filter(n => Number.isFinite(n)));
            const shots = [];
            for (const no of noSet) {
              for (const suffix of ['input','confirm','sent']) {
                const url = '/screenshots/ss-' + no + '-' + suffix + '.png';
                shots.push({ no, suffix, url, ts: '' });
              }
            }
            if (shots.length === 0) {
              el.innerHTML = '<div style="color:#5b6675;font-size:.72rem;padding:8px">${_lang === 'ja' ? '撮影されたスクリーンショットがここに並びます' : 'Captured screenshots will appear here'}</div>';
              return;
            }
            // v2.0.89: 旧 (~v0.88) は inline onclick / onerror に escape された
            //   シングルクォートを書いていたが、TS template literal を経由する
            //   タイミングで \\\\' → \\' → ' になり、HTML 属性内の ' と衝突して
            //   "Unexpected string" を投げる。inline script 全体が中断していた。
            //   addEventListener / dataset 経由に変えて根本回避。
            el.innerHTML = shots.map(s => {
              const safeUrl = String(s.url || '').replace(/"/g, '&quot;');
              return '<div class="lf-shot-thumb" data-url="' + safeUrl + '" style="flex-shrink:0;width:140px;cursor:pointer">' +
                '<img data-shot-img="1" src="' + safeUrl + '?t=' + Date.now() + '" style="width:140px;height:90px;object-fit:cover;border-radius:6px;border:1px solid #2a3441;background:#0a0d12">' +
                '<div style="font-size:.62rem;color:#8895a5;margin-top:3px;text-align:center">No.' + s.no + ' · ' + s.suffix + '</div></div>';
            }).join('');
            el.querySelectorAll('.lf-shot-thumb').forEach(div => {
              div.addEventListener('click', () => {
                const u = div.getAttribute('data-url');
                if (u) window.open(u, '_blank');
              });
            });
            el.querySelectorAll('img[data-shot-img]').forEach(img => {
              img.addEventListener('error', () => {
                img.style.opacity = '0.2';
                img.title = '(not captured yet)';
              });
            });
          } catch (e) {}
        }

        // v2.0.93: visibility-aware polling — タブが見えていない時は更新しない
        function startLiveFormPolling() {
          if (_liveFormPollTimer) return;
          refreshLiveFormSessions();
          _liveFormPollTimer = setInterval(() => {
            if (document.hidden) return;
            refreshLiveFormSessions();
          }, 1000);
        }
        function stopLiveFormPolling() {
          if (_liveFormPollTimer) { clearInterval(_liveFormPollTimer); _liveFormPollTimer = null; }
        }
        document.addEventListener('visibilitychange', () => {
          if (!document.hidden && document.querySelector('.tab-content.active')?.id === 'tab-live-form') {
            refreshLiveFormSessions();
          }
        });
        async function notifyTabActive(tab) {
          // v2.0.93: live-form 以外のタブに切替時、HTML 側から
          //   即座に WebView を detach するための park sentinel を送る。
          //   旧 (~v0.91): サーバ /api/form-session/tab-changed に POST → サーバが
          //   parkActiveView 呼ぶ流れだが、fetch 完了まで 50-200ms ラグがあり、
          //   その間 WebView が前タブの位置に残って「ついてくる」体験になる。
          //   新: クライアントから set-bounds で先に detach し、その後サーバへ通知。
          const needsPark = (tab !== 'live-form')
            && _activeSessionId
            && !String(_activeSessionId).startsWith('virtual:');
          if (needsPark) {
            try {
              await fetch('/api/form-session/' + _activeSessionId + '/set-bounds', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ x: -10000, y: -10000, width: 1, height: 1 }),
              });
            } catch (e) {}
          }
          try {
            await fetch('/api/form-session/tab-changed', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ activeTab: tab }),
            });
          } catch (e) {}
          if (tab === 'live-form') {
            // v2.0.93: 並列タイル再 dock — 100ms 待って refreshLiveFormSessions に任せる
            setTimeout(refreshLiveFormSessions, 100);
          }
        }
        document.querySelectorAll('[data-tab]').forEach(btn => {
          btn.addEventListener('click', () => {
            const tab = btn.getAttribute('data-tab');
            notifyTabActive(tab);
            if (tab === 'live-form') startLiveFormPolling();
            else stopLiveFormPolling();
          });
        });
        // v2.0.93: window resize → 並列タイル再 dock
        let _resizeSyncPending = false;
        window.addEventListener('resize', () => {
          if (document.querySelector('.tab-content.active')?.id !== 'tab-live-form') return;
          if (_resizeSyncPending) return;
          _resizeSyncPending = true;
          requestAnimationFrame(() => {
            _resizeSyncPending = false;
            refreshLiveFormSessions();
          });
        });
        // v2.0.90: scroll (window / 全 scrollable 親) でも追従させる。
        //   旧 (~v0.89) は scroll イベント listener 無し → ページを下にスクロール
        //   すると HTML slot は動くのに WebView だけ元位置に残り「表示が辺になる」
        //   実機 bug (No.225 検証時に確認)。
        //   capture:true で全要素の scroll イベントを拾う。requestAnimationFrame で
        //   過剰呼びを抑制 (throttle)。
        let _scrollSyncPending = false;
        function _onScrollSync() {
          if (document.querySelector('.tab-content.active')?.id !== 'tab-live-form') return;
          if (_scrollSyncPending) return;
          _scrollSyncPending = true;
          requestAnimationFrame(() => {
            _scrollSyncPending = false;
            // v2.0.93: 並列タイル対応 — refreshLiveFormSessions 内で dockAllSessionsToTiles を呼ぶ
            refreshLiveFormSessions();
          });
        }
        window.addEventListener('scroll', _onScrollSync, { passive: true, capture: true });
        document.addEventListener('scroll', _onScrollSync, { passive: true, capture: true });
        const refreshBtn = document.getElementById('liveFormRefresh');
        if (refreshBtn) refreshBtn.addEventListener('click', refreshLiveFormSessions);
        // バックグラウンド polling (badge 用)
        // v2.0.93: バックグラウンド polling (badge 用) — 非表示時はスキップ
        setInterval(() => { if (!document.hidden) refreshLiveFormSessions(); }, 10000);
        // v2.0.89: 初期 load 時に live-form タブが既に active なら即 2 秒 polling 起動
        //   (旧: タブ click 時のみ起動 → load 直後は最大 5 秒待ち)
        function _bootLiveFormIfActive() {
          const active = document.querySelector('.tab-content.active')?.id;
          if (active === 'tab-live-form') startLiveFormPolling();
          else notifyTabActive(active ? active.replace(/^tab-/, '') : '');
          // 最初の refresh は即実行 (badge / バー反映を遅らせない)
          refreshLiveFormSessions();
        }
        if (document.readyState === 'complete' || document.readyState === 'interactive') {
          _bootLiveFormIfActive();
        } else {
          document.addEventListener('DOMContentLoaded', _bootLiveFormIfActive, { once: true });
        }
      })();
    </script>
  </div>

  <!-- Awaiting tab -->
  <div class="tab-content" id="tab-awaiting">
    <div style="background:#fff;border:1px solid var(--outline-variant);border-bottom:2px solid var(--primary);padding:10px 16px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
      <div style="display:flex;align-items:center;gap:8px">
        <span class="material-symbols-outlined" style="font-size:16px;color:var(--primary)">pending_actions</span>
        <span style="font-size:.75rem;color:var(--on-surface-variant)">${_t['awaiting.description']}</span>
      </div>
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
        <button class="btn btn-sm btn-outline-primary" onclick="toggleAllAwaiting()">${_t['action.selectAll']}</button>
        <button class="btn btn-sm btn-success" onclick="bulkApprove('sent')">${_t['action.bulkSent']}</button>
        <button class="btn btn-sm btn-outline-danger" onclick="bulkSkipWithFeedback()">${_t['action.bulkSkip']}</button>
        <button class="btn btn-sm btn-outline-danger" onclick="bulkDeleteAwaiting()">${_t['action.bulkDeleteCompanies'] || 'Delete Selected'}</button>
      </div>
    </div>
    <div id="awaitingList" style="padding:16px;background:var(--bg-base)"></div>
  </div>

  <!-- Sent tab -->
  <div class="tab-content" id="tab-sent">
    <div style="background:#fff;border:1px solid var(--outline-variant);border-bottom:2px solid #059669;padding:12px 16px;display:flex;align-items:center;flex-wrap:wrap;gap:10px">
      <div style="display:flex;align-items:center;gap:8px;min-width:0">
        <span class="material-symbols-outlined" style="font-size:16px;color:#059669">mark_email_read</span>
        <div style="display:flex;flex-direction:column;gap:2px">
          <strong style="font-size:.76rem;color:var(--on-surface)">${_t['sent.panelTitle'] || 'Sent log'}</strong>
          <span style="font-size:.66rem;color:var(--outline)">${_t['sent.panelHint'] || 'Filter by company, type, message body, or form URL.'}</span>
        </div>
      </div>
      <input type="text" id="sentSearch" class="form-control-sm" style="width:280px;max-width:100%" placeholder="${_t['sent.search'] || 'Search company, type, message, or URL...'}">
      <select id="sentTypeFilter" class="form-control-sm" style="width:180px;max-width:100%">
        <option value="">${_t['sent.filter.typeAll'] || 'Type: All'}</option>
      </select>
      <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
        <button class="fb-sent fb active" data-sf="all">${_t['sent.all']}</button>
        <button class="fb-sent fb" data-sf="1">${_t['sent.firstOnly']}</button>
        <button class="fb-sent fb" data-sf="2+">${_t['sent.multipleOnly']}</button>
      </div>
      <small style="margin-left:auto;font-family:var(--font-mono);font-size:.68rem;color:var(--outline)" id="sentCount">0 items</small>
    </div>
    <div id="sentList" style="padding:16px;background:var(--bg-base)"></div>
  </div>

  <!-- List Builder tab — full UI (criteria chip-inputs + 4-stage progress + result table + sidebar) -->
  <div class="tab-content" id="tab-list-builder">
    <!-- 上部のページヘッダ + 4 stats カードはユーザ要望で廃止。
         代わりに小さなアクションバーに「営業 NG 企業を見る」ボタンを置き、
         過去に「営業お断り」「採用専用」等で skip された会社を確認できるようにする。 -->
    <div class="lb2-actionbar">
      <button class="lb2-btn-secondary lb2-btn-sm" id="lb2NgViewBtn" type="button">
        <span class="material-symbols-outlined">block</span>
        ${_t['lb.ng.viewBtn'] || 'View NG companies'}
        <span class="lb2-ng-badge" id="lb2NgBadge" hidden>0</span>
      </button>
    </div>

    <!-- 営業 NG モーダル -->
    <div class="lb2-modal-shell" id="lb2NgModal" hidden>
      <div class="lb2-modal-panel" role="dialog" aria-labelledby="lb2NgModalTitle">
        <div class="lb2-modal-head">
          <h3 id="lb2NgModalTitle">${_t['lb.ng.modal.title'] || 'NG companies (skipped)'}</h3>
          <button class="lb2-icon-btn-modal" id="lb2NgModalClose" type="button" aria-label="close">
            <span class="material-symbols-outlined">close</span>
          </button>
        </div>
        <div class="lb2-modal-body">
          <p class="lb2-ng-hint">${_t['lb.ng.modal.hint'] || 'Companies skipped due to "no sales", "recruit-only", "IR-only" notes.'}</p>
          <table class="lb2-history-table">
            <thead>
              <tr>
                <th>${_t['lb.ng.col.when'] || 'When'}</th>
                <th>${_t['lb.ng.col.company'] || 'Company'}</th>
                <th>${_t['lb.ng.col.reason'] || 'Reason'}</th>
              </tr>
            </thead>
            <tbody id="lb2NgTableBody"></tbody>
          </table>
          <div id="lb2NgTableEmpty" class="lb2-history-empty-msg" hidden>${_t['lb.ng.empty'] || 'No NG-skipped companies'}</div>
        </div>
      </div>
    </div>

    <div class="lb2-grid">
      <div class="lb2-main">
        <div class="lb2-card">
          <div class="lb2-mode-tabs" role="tablist">
            <button class="lb2-mode-pill active" data-lb2-mode="ai" type="button" role="tab" aria-selected="true">
              <span class="material-symbols-outlined">smart_toy</span>${_t['lb.mode.ai'] || 'Ask AI'}
              <span class="lb2-mode-tag">${_t['lb.mode.tag.recommended'] || 'Recommended'}</span>
            </button>
            <button class="lb2-mode-pill" data-lb2-mode="url" type="button" role="tab" aria-selected="false">
              <span class="material-symbols-outlined">link</span>${_t['lb.mode.url'] || 'From URL'}
            </button>
            <button class="lb2-mode-pill" data-lb2-mode="category" type="button" role="tab" aria-selected="false">
              <span class="material-symbols-outlined">database</span>${_t['lb.mode.category'] || 'Official API'}
            </button>
          </div>

          <!-- URL モード入力 -->
          <div class="lb2-mode-panel" data-lb2-panel="url" hidden>
            <div class="lb2-helper">
              <span class="material-symbols-outlined">info</span>
              <div>
                <strong>${_t['lb.helper.url.title'] || 'Paste company-list page URLs'}</strong>
                <p>${_t['lb.helper.url.desc'] || 'Auto-scrape paginated public list pages (industry assoc., chamber of commerce, ranking, etc.). robots.txt is respected; halts on CAPTCHA.'}</p>
              </div>
            </div>
            <label class="lb2-field-label" for="lb2UrlInput">${_t['lb.url.label'] || 'URLs (one per line)'}</label>
            <textarea id="lb2UrlInput" class="lb2-textarea" rows="4" placeholder="https://www.jaaa.ne.jp/about/members/&#10;https://example.com/dx-companies"></textarea>
            <div class="lb2-row">
              <div class="lb2-field">
                <label class="lb2-field-label">${_t['lb.url.maxPages'] || 'Max pages'}</label>
                <input id="lb2UrlMaxPages" type="number" class="lb2-input" value="10" min="1" max="50">
              </div>
              <div class="lb2-field">
                <label class="lb2-field-label">${_t['lb.url.maxCompanies'] || 'Max companies'}</label>
                <input id="lb2UrlMaxCompanies" type="number" class="lb2-input" value="100" min="1" max="500">
              </div>
            </div>
          </div>

          <!-- 公式 API モード説明 -->
          <div class="lb2-mode-panel" data-lb2-panel="category" hidden>
            <div class="lb2-helper">
              <span class="material-symbols-outlined">verified</span>
              <div>
                <strong>${_t['lb.helper.api.title'] || 'Query official Japan APIs'}</strong>
                <p>${_t['lb.helper.api.desc'] || 'Combine Houjin-Bangou + gBizINFO + EDINET official APIs.'}</p>
              </div>
            </div>
          </div>

          <div class="lb2-card-head" id="lb2CriteriaHead">
            <h3>${_t['lb.criteria.title'] || 'Criteria'}</h3>
            <span class="lb2-card-hint" id="lb2CriteriaHint">${_t['lb.criteria.hint'] || 'Empty fields are decided by AI'}</span>
          </div>
          <div class="lb2-criteria-grid" id="lb2CriteriaGrid">
            <div class="lb2-field">
              <label class="lb2-field-label"><span class="material-symbols-outlined">work</span>${_t['lb.criteria.industry'] || 'Industry'}</label>
              <div class="lb2-chip-input" data-lb2-chip="industries">
                <input type="text" placeholder="${_t['lb.criteria.industry.placeholder'] || 'e.g. SaaS / press Enter'}" autocomplete="off">
              </div>
            </div>
            <div class="lb2-field">
              <label class="lb2-field-label"><span class="material-symbols-outlined">place</span>${_t['lb.criteria.region'] || 'Region'}</label>
              <div class="lb2-chip-input" data-lb2-chip="regions">
                <input type="text" placeholder="${_t['lb.criteria.region.placeholder'] || 'e.g. Tokyo, Osaka'}" autocomplete="off">
              </div>
            </div>
            <div class="lb2-field">
              <label class="lb2-field-label"><span class="material-symbols-outlined">groups</span>${_t['lb.criteria.employees'] || 'Employee size'}</label>
              <div class="lb2-chip-input" data-lb2-chip="employeeSize">
                <input type="text" placeholder="${_t['lb.criteria.employees.placeholder'] || 'e.g. 50-500'}" autocomplete="off">
              </div>
            </div>
            <div class="lb2-field">
              <label class="lb2-field-label"><span class="material-symbols-outlined">monitoring</span>${_t['lb.criteria.revenue'] || 'Revenue'}</label>
              <div class="lb2-chip-input" data-lb2-chip="revenue">
                <input type="text" placeholder="${_t['lb.criteria.revenue.placeholder'] || 'e.g. 1B+ JPY'}" autocomplete="off">
              </div>
            </div>
            <div class="lb2-field">
              <label class="lb2-field-label"><span class="material-symbols-outlined">badge</span>${_t['lb.criteria.dept'] || 'Dept / role'}</label>
              <div class="lb2-chip-input" data-lb2-chip="departments">
                <input type="text" placeholder="${_t['lb.criteria.dept.placeholder'] || 'e.g. Sales Ops, IT'}" autocomplete="off">
              </div>
            </div>
            <div class="lb2-field">
              <label class="lb2-field-label"><span class="material-symbols-outlined">tag</span>${_t['lb.criteria.keywords'] || 'Keywords'}</label>
              <div class="lb2-chip-input" data-lb2-chip="keywords">
                <input type="text" placeholder="${_t['lb.criteria.keywords.placeholder'] || 'e.g. automation, DX'}" autocomplete="off">
              </div>
            </div>
            <div class="lb2-field">
              <label class="lb2-field-label"><span class="material-symbols-outlined">block</span>${_t['lb.criteria.exclude'] || 'Exclude'}</label>
              <div class="lb2-chip-input" data-lb2-chip="excludes">
                <input type="text" placeholder="${_t['lb.criteria.exclude.placeholder'] || 'e.g. recruit-only'}" autocomplete="off">
              </div>
            </div>
            <div class="lb2-field">
              <label class="lb2-field-label"><span class="material-symbols-outlined">database</span>${_t['lb.criteria.sources'] || 'Sources'}</label>
              <div class="lb2-chip-input" data-lb2-chip="sources">
                <input type="text" placeholder="${_t['lb.criteria.sources.placeholder'] || 'e.g. company site, DB'}" autocomplete="off">
              </div>
            </div>
          </div>
          <div class="lb2-form-toolbar">
            <div class="lb2-form-toolbar-meta">
              <label class="lb2-mini-field">
                <span>${_t['lb.toolbar.count'] || 'Count'}</span>
                <select id="lb2Limit" class="lb2-mini-select">
                  <option value="10">10</option>
                  <option value="30" selected>30</option>
                  <option value="50">50</option>
                  <option value="100">100</option>
                  <option value="200">200</option>
                  <option value="500">500</option>
                </select>
              </label>
              <label class="lb2-mini-field" id="lb2ProviderField">
                <span>${_t['lb.toolbar.cli'] || 'CLI'}</span>
                <select id="lb2Provider" class="lb2-mini-select">
                  <option value="claude" selected>Claude Code</option>
                  <option value="codex">Codex</option>
                  <option value="gemini">Gemini</option>
                </select>
              </label>
            </div>
            <div class="lb2-form-actions">
              <button class="lb2-btn-secondary" id="lb2SaveCriteriaBtn" type="button">
                <span class="material-symbols-outlined">bookmark_add</span>
                ${_t['lb.toolbar.saveCriteria'] || 'Save criteria'}
              </button>
              <button class="lb2-btn-primary" id="lb2RunBtn" type="button">
                <span class="material-symbols-outlined" id="lb2RunBtnIcon">auto_awesome</span>
                <span id="lb2RunBtnLabel">${_t['lb.toolbar.runBtn'] || 'Generate with AI'}</span>
              </button>
            </div>
          </div>
        </div>

        <div class="lb2-card lb2-progress-card" id="lb2Progress" hidden>
          <div class="lb2-progress-head">
            <span class="material-symbols-outlined lb2-spin" aria-hidden="true">autorenew</span>
            <div class="lb2-progress-meta">
              <strong class="lb2-progress-title">${_t['lb.progress.title'] || 'AI processing'}</strong>
              <span class="lb2-progress-message" id="lb2ProgressMessage"></span>
            </div>
            <div class="lb2-progress-stages">
              <span class="lb2-stage" data-lb2-stage="discovery">
                <span class="lb2-stage-dot"></span>${_t['lb.progress.discovery'] || 'Discovery'}
              </span>
              <span class="lb2-stage-arrow">→</span>
              <span class="lb2-stage" data-lb2-stage="qualification">
                <span class="lb2-stage-dot"></span>${_t['lb.progress.scoring'] || 'Scoring'}
              </span>
              <span class="lb2-stage-arrow">→</span>
              <span class="lb2-stage" data-lb2-stage="dedupe">
                <span class="lb2-stage-dot"></span>${_t['lb.progress.dedupe'] || 'Dedupe'}
              </span>
              <span class="lb2-stage-arrow">→</span>
              <span class="lb2-stage" data-lb2-stage="preview_ready">
                <span class="lb2-stage-dot"></span>${_t['lb.progress.listing'] || 'Listing'}
              </span>
            </div>
            <span class="lb2-progress-percent" id="lb2ProgressPercent">0%</span>
            <button class="lb2-progress-cancel" id="lb2CancelBtn" type="button" title="${_t['lb.progress.cancel'] || 'Cancel'}">
              <span class="material-symbols-outlined">close</span>
            </button>
          </div>
          <div class="lb2-progress-bar"><div class="lb2-progress-fill" id="lb2ProgressFill"></div></div>
        </div>

        <div class="lb2-card lb2-result-card" id="lb2Result">
          <div class="lb2-card-head lb2-result-head">
            <div class="lb2-result-headline">
              <h3>${_t['lb.result.title'] || 'Generated list'}</h3>
              <div class="lb2-result-summary" id="lb2ResultSummary">
                <span class="lb2-summary-pill lb2-summary-new">${_t['lb.result.summary.new'] || 'New'} 0</span>
                <span class="lb2-summary-pill lb2-summary-review">${_t['lb.result.summary.review'] || 'Review'} 0</span>
                <span class="lb2-summary-pill lb2-summary-dup">${_t['lb.result.summary.dup'] || 'Dup/Excl'} 0</span>
              </div>
            </div>
            <div class="lb2-result-toolbar">
              <label class="lb2-checkbox-inline">
                <input type="checkbox" id="lb2SelectAll" checked>
                <span>${_t['lb.result.selectAll'] || 'Select all'}</span>
              </label>
              <button class="lb2-btn-secondary lb2-btn-sm" id="lb2ExportCsvBtn" type="button">
                <span class="material-symbols-outlined">download</span>CSV
              </button>
              <button class="lb2-btn-primary lb2-btn-sm" id="lb2CommitBtn" type="button" disabled>
                <span class="material-symbols-outlined">add_task</span>${_t['lb.result.commit'] || 'Add selected'}
              </button>
            </div>
          </div>
          <div class="lb2-result-search">
            <span class="material-symbols-outlined lb2-result-search-icon">search</span>
            <input type="text" id="lb2FilterText" placeholder="${_t['lb.result.filter.placeholder'] || 'Filter by name or industry'}" class="lb2-result-search-input">
            <select id="lb2FilterStatus" class="lb2-mini-select lb2-result-search-status">
              <option value="">${_t['lb.result.filter.allStatus'] || 'All status'}</option>
              <option value="unique">${_t['lb.result.filter.unique'] || 'New'}</option>
              <option value="needs_review">${_t['lb.result.filter.review'] || 'Review'}</option>
              <option value="duplicate">${_t['lb.result.filter.duplicate'] || 'Duplicate'}</option>
              <option value="suppressed">${_t['lb.result.filter.suppressed'] || 'Suppressed'}</option>
            </select>
          </div>
          <div class="lb2-result-table-wrap">
            <table class="lb2-result-table">
              <thead>
                <tr>
                  <th class="lb2-th-check"><span></span></th>
                  <th>${_t['lb.result.col.company'] || 'Company'}</th>
                  <th>URL</th>
                  <th>${_t['lb.result.col.industry'] || 'Industry'}</th>
                  <th>${_t['lb.result.col.region'] || 'Region'}</th>
                  <th>${_t['lb.result.col.employees'] || 'Empl.'}</th>
                  <th class="lb2-th-fit">${_t['lb.result.col.fit'] || 'AI fit'}</th>
                  <th>${_t['lb.result.col.status'] || 'Status'}</th>
                  <th>${_t['lb.result.col.action'] || 'Action'}</th>
                </tr>
              </thead>
              <tbody id="lb2ResultBody"></tbody>
            </table>
          </div>
          <div class="lb2-result-empty" id="lb2ResultEmpty">
            <span class="material-symbols-outlined">data_object</span>
            <p>${_t['lb.result.empty'] || 'Set criteria and click "Generate with AI" to see candidates here.'}</p>
          </div>
        </div>
      </div>

      <aside class="lb2-side">
        <div class="lb2-card lb2-side-card">
          <div class="lb2-side-head">
            <span class="material-symbols-outlined">auto_awesome</span>
            <span>${_t['lb.side.suggest.title'] || 'AI insights'}</span>
          </div>
          <ul class="lb2-suggest-list" id="lb2SuggestList">
            <li class="lb2-suggest-item">${_t['lb.side.suggest.empty'] || 'Run a query to see analytics here.'}</li>
          </ul>
        </div>

        <div class="lb2-card lb2-side-card">
          <div class="lb2-side-head">
            <span class="material-symbols-outlined">recommend</span>
            <span>${_t['lb.side.recommend.title'] || 'Recommendations'}</span>
          </div>
          <button class="lb2-action-row" id="lb2ActionAddTopBtn" type="button" disabled>
            <span class="material-symbols-outlined">bookmark</span>${_t['lb.side.recommend.addTop'] || 'Add top hits'}
          </button>
          <button class="lb2-action-row" id="lb2ActionReanalyzeBtn" type="button" disabled>
            <span class="material-symbols-outlined">refresh</span>${_t['lb.side.recommend.reanalyze'] || 'Re-analyze review'}
          </button>
          <button class="lb2-action-row" id="lb2ActionDraftBtn" type="button" disabled>
            <span class="material-symbols-outlined">edit_note</span>${_t['lb.side.recommend.draft'] || 'Draft outreach'}
          </button>
        </div>

        <div class="lb2-card lb2-side-card">
          <div class="lb2-side-head">
            <span class="material-symbols-outlined">donut_small</span>
            <span>${_t['lb.side.industry.title'] || 'Industry mix'}</span>
          </div>
          <div class="lb2-chart-wrap">
            <canvas id="lb2IndustryChart"></canvas>
            <div class="lb2-chart-empty" id="lb2ChartEmpty">${_t['lb.side.chart.empty'] || 'Appears after a run'}</div>
          </div>
        </div>

        <div class="lb2-card lb2-side-card">
          <div class="lb2-side-head">
            <span class="material-symbols-outlined">history</span>
            <span>${_t['lb.side.history.title'] || 'Recent runs'}</span>
            <button class="lb2-side-head-action" id="lb2HistoryAllBtn" type="button" title="${_t['lb.side.history.viewAll'] || 'View all'}">
              <span class="material-symbols-outlined">open_in_full</span>
            </button>
          </div>
          <ul class="lb2-history-list" id="lb2HistoryList">
            <li class="lb2-history-empty">${_t['lb.side.history.empty'] || 'No runs yet'}</li>
          </ul>
        </div>

        <!-- 履歴一覧モーダル -->
        <div class="lb2-modal-shell" id="lb2HistoryModal" hidden onclick="if(event.target===this)this.hidden=true">
          <div class="lb2-modal-panel" role="dialog" aria-labelledby="lb2HistoryModalTitle" onclick="event.stopPropagation()">
            <div class="lb2-modal-head">
              <h3 id="lb2HistoryModalTitle">${_t['lb.history.modal.title'] || 'All runs'}</h3>
              <button class="lb2-icon-btn-modal" id="lb2HistoryModalClose" type="button" aria-label="close" onclick="event.preventDefault();event.stopPropagation();var m=document.getElementById('lb2HistoryModal');if(m)m.hidden=true">
                <span class="material-symbols-outlined">close</span>
              </button>
            </div>
            <div class="lb2-modal-body">
              <table class="lb2-history-table">
                <thead>
                  <tr>
                    <th>${_t['lb.history.col.started'] || 'Started'}</th>
                    <th>${_t['lb.history.col.status'] || 'Status'}</th>
                    <th>${_t['lb.history.col.mode'] || 'Mode'}</th>
                    <th>${_t['lb.history.col.got'] || 'Got'}</th>
                    <th>${_t['lb.history.col.new'] || 'New'}</th>
                    <th>${_t['lb.history.col.dup'] || 'Dup'}</th>
                    <th>${_t['lb.history.col.review'] || 'Review'}</th>
                    <th>${_t['lb.history.col.time'] || 'Time'}</th>
                    <th>${_t['lb.history.col.action'] || 'Action'}</th>
                  </tr>
                </thead>
                <tbody id="lb2HistoryTableBody"></tbody>
              </table>
              <div id="lb2HistoryTableEmpty" class="lb2-history-empty-msg" hidden>${_t['lb.history.empty'] || 'No runs'}</div>
            </div>
          </div>
        </div>
      </aside>
    </div>
  </div>
  <!-- CLI Activity tab -->
  <div class="tab-content" id="tab-logs">
    <!-- Embedded interactive terminal -->
    <div id="cliTerminalCard" class="cli-term-card">
      <div class="cli-term-head">
        <div class="cli-term-title">
          <span class="material-symbols-outlined" style="font-size:18px;color:var(--primary)">terminal</span>
          <span>${_t['cli.term.terminal'] || 'Terminal'}</span>
          <span id="cliTermProviderBadge" class="cli-term-badge" style="display:none"></span>
          <span id="cliTermStatusDot" class="cli-term-status-dot off" title=""></span>
        </div>
        <div class="cli-term-launchers">
          <button type="button" class="cli-term-launch claude" data-cli-launch="claude">
            <img src="/assets/vendor/ai-icons/claude-code.svg" alt="" class="cli-term-launch-icon" onerror="this.style.display='none'">
            <span>${(_t['cli.term.launchProvider'] || '{provider} を起動').replace('{provider}', 'Claude')}</span>
          </button>
          <button type="button" class="cli-term-launch codex" data-cli-launch="codex">
            <img src="/assets/vendor/ai-icons/codex-openai.svg" alt="" class="cli-term-launch-icon" onerror="this.style.display='none'">
            <span>${(_t['cli.term.launchProvider'] || '{provider} を起動').replace('{provider}', 'Codex')}</span>
          </button>
          <button type="button" class="cli-term-launch gemini" data-cli-launch="gemini">
            <img src="/assets/vendor/ai-icons/gemini-cli.svg" alt="" class="cli-term-launch-icon" onerror="this.style.display='none'">
            <span>${(_t['cli.term.launchProvider'] || '{provider} を起動').replace('{provider}', 'Gemini')}</span>
          </button>
          <button type="button" class="cli-term-stop" data-cli-stop="1" disabled>
            <span class="material-symbols-outlined" style="font-size:14px">stop_circle</span>
            <span>${_t['cli.term.stop'] || '停止'}</span>
          </button>
        </div>
      </div>

      <!-- Auth-error helper banner (auto-shown when /login or 401 detected) -->
      <div id="cliTermAuthHelp" class="cli-term-auth-help" style="display:none">
        <div class="cli-term-auth-help-icon">
          <span class="material-symbols-outlined" style="font-size:22px">lock_open</span>
        </div>
        <div class="cli-term-auth-help-body">
          <h4 id="cliTermAuthHelpTitle">${_t['cli.term.authHelp.title'] || '認証が必要です'}</h4>
          <p id="cliTermAuthHelpDesc">${_t['cli.term.authHelp.desc'] || 'Authentication required. Press the button below to type "/login" automatically.'}</p>
          <ol class="cli-term-auth-help-steps">
            <li>${_t['cli.term.authHelp.step1'] || '下の「<b>/login を実行</b>」ボタンをクリック'}</li>
            <li>${_t['cli.term.authHelp.step2'] || 'ターミナルに <code>/login</code> が自動で入力されます'}</li>
            <li>${_t['cli.term.authHelp.step3'] || 'ブラウザが開く → Anthropic にログイン → 完了したらこの画面に戻る'}</li>
            <li>${_t['cli.term.authHelp.step4'] || 'もう一度「Claude を起動」を押すか、ダッシュボードで「AI を起動」'}</li>
          </ol>
          <div class="cli-term-auth-help-actions">
            <button type="button" class="cli-term-auth-help-btn primary" data-cli-action="type-login">
              <span class="material-symbols-outlined" style="font-size:14px">keyboard</span>
              ${_t['cli.term.authHelp.runLogin'] || '/login を実行'}
            </button>
            <button type="button" class="cli-term-auth-help-btn" data-cli-action="dismiss-help">${_t['cli.term.authHelp.dismiss'] || '閉じる'}</button>
            <a href="https://docs.anthropic.com/en/docs/claude-code/quickstart" target="_blank" rel="noopener" class="cli-term-auth-help-btn link">
              <span class="material-symbols-outlined" style="font-size:14px">help</span>${_t['cli.term.authHelp.officialHelp'] || '公式ヘルプ'}
            </a>
          </div>
        </div>
      </div>

      <!-- Empty state shown before first launch -->
      <div id="cliTermEmpty" class="cli-term-empty">
        <div class="cli-term-empty-illust">
          <span class="material-symbols-outlined" style="font-size:36px;color:var(--text-3)">smart_toy</span>
        </div>
        <p class="cli-term-empty-title">${_t['cli.term.empty.title'] || 'AI CLI を起動してください'}</p>
        <p class="cli-term-empty-sub">${_t['cli.term.empty.sub'] || '上の「Claude を起動」「Codex を起動」「Gemini を起動」のいずれかをクリックすると、ここに対話型ターミナルが立ち上がります。'}</p>
        <p class="cli-term-empty-hint">${_t['cli.term.empty.hint'] || '初回はインストールが必要な場合があります。エラーが出たら自動で案内が表示されます。'}</p>
      </div>

      <!-- xterm container (shown after launch) -->
      <div id="cliTermHost" class="cli-term-host" style="display:none"></div>
    </div>

    <div style="background:#fff;border:1px solid var(--outline-variant);margin-bottom:10px">
      <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 16px;border-bottom:1px solid var(--outline-variant)">
        <div style="display:flex;align-items:center;gap:10px">
          <span style="font-weight:700;font-size:.68rem;text-transform:uppercase;letter-spacing:.07em;color:var(--on-surface)">${_t['cli.live.title'] || 'Live CLI'}</span>
          <span style="font-family:var(--font-mono);font-size:.65rem;color:var(--outline)" id="cliStreamLastEvent">—</span>
        </div>
      </div>
      <div id="cliThinkingRow" style="display:none;align-items:center;gap:8px;padding:10px 16px;background:rgba(99,102,241,.08);border-bottom:1px solid rgba(99,102,241,.16)">
        <span class="think-spin"></span>
        <span id="cliThinkingText" style="font-size:.76rem;color:#6366f1;font-style:italic;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${_t['cli.live.thinking'] || 'Thinking...'}</span>
      </div>
      <div id="cliStream" style="max-height:180px;overflow:auto;padding:10px 16px;background:var(--bg-card)"></div>
    </div>
    <!-- Activity log table -->
    <div style="background:#fff;border:1px solid var(--outline-variant)">
      <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 16px;border-bottom:1px solid var(--outline-variant);flex-wrap:wrap;gap:8px">
        <div style="display:flex;align-items:center;gap:10px">
          <span style="font-weight:700;font-size:.68rem;text-transform:uppercase;letter-spacing:.07em;color:var(--on-surface)">${_t['cli.actionLog']}</span>
          <span style="font-family:var(--font-mono);font-size:.65rem;color:var(--outline)" id="cliLastEvent">—</span>
        </div>
        <span style="font-family:var(--font-mono);font-size:.65rem;color:var(--outline)" id="logCount">0 items</span>
      </div>
      <!-- v2.1.0: 操作ログのタブ(フィルタ)。件数バッジ付き。クライアント側で絞り込む。 -->
      <div class="filter-pills" id="logFilterPills" style="display:flex;gap:6px;flex-wrap:wrap;padding:8px 16px;border-bottom:1px solid var(--outline-variant)">
        <button class="fb active" data-lf="all">${_t['logfilter.all'] || 'すべて'} <b class="lf-badge" id="logBadge-all">0</b></button>
        <button class="fb" data-lf="submitted">${_t['logfilter.sent'] || '送信完了'} <b class="lf-badge" id="logBadge-submitted">0</b></button>
        <button class="fb" data-lf="attention">${_t['logfilter.attention'] || '確認待ち・要対応'} <b class="lf-badge" id="logBadge-attention">0</b></button>
        <button class="fb" data-lf="error">${_t['logfilter.error'] || 'エラー'} <b class="lf-badge" id="logBadge-error">0</b></button>
        <button class="fb" data-lf="progress">${_t['logfilter.progress'] || '進行中'} <b class="lf-badge" id="logBadge-progress">0</b></button>
      </div>
      <table class="main-table">
        <thead><tr><th>${_t['cli.datetime']}</th><th>${_t['th.no']}</th><th>${_t['cli.companyName']}</th><th>${_t['cli.actionType']}</th><th>${_t['cli.details']}</th></tr></thead>
        <tbody id="logBody"></tbody>
      </table>
    </div>
  </div>

  <!-- Settings tab -->
  <div class="tab-content" id="tab-settings">
    <div class="settings-layout">
      <div class="settings-sidebar">
        <button class="settings-sidebar-btn active" data-section="companyProfile"><span class="settings-sidebar-label">${_t['settings.companyProfile']}</span><span class="settings-sidebar-status" id="settingsSidebarStatus-companyProfile"></span></button>
        <button class="settings-sidebar-btn" data-section="valuePropositions"><span class="settings-sidebar-label">${_t['settings.valuePropositions']}</span><span class="settings-sidebar-status" id="settingsSidebarStatus-valuePropositions"></span></button>
        <button class="settings-sidebar-btn" data-section="targetList"><span class="settings-sidebar-label">${_t['settings.targetList']}</span><span class="settings-sidebar-status" id="settingsSidebarStatus-targetList"></span></button>
        <button class="settings-sidebar-btn" data-section="exclusionRules"><span class="settings-sidebar-label">${_t['settings.exclusionRules']}</span><span class="settings-sidebar-status" id="settingsSidebarStatus-exclusionRules"></span></button>
        <button class="settings-sidebar-btn" data-section="messageTemplates"><span class="settings-sidebar-label">${_t['settings.messageTemplates']}</span><span class="settings-sidebar-status" id="settingsSidebarStatus-messageTemplates"></span></button>
        <button class="settings-sidebar-btn" data-section="preferences"><span class="settings-sidebar-label">${_t['settings.preferences']}</span><span class="settings-sidebar-status" id="settingsSidebarStatus-preferences"></span></button>
      </div>
      <div class="settings-main" id="settingsMain">
        <div class="settings-setup-guide" id="settingsSetupGuide">
          <div class="settings-setup-head">
            <div style="min-width:0">
              <div class="settings-setup-eyebrow">${_t['settings.setupGuide.eyebrow']}</div>
              <h3 class="settings-setup-title">${_t['settings.setupGuide.title']}</h3>
            </div>
            <div class="settings-setup-overview">
              <div class="settings-setup-progress-track"><span id="settingsSetupProgressBar"></span></div>
              <div class="settings-setup-progress-label" id="settingsSetupProgressLabel" style="font-size:.72rem">0 / 5</div>
              <div class="settings-setup-progress-note" id="settingsSetupProgressNote"></div>
            </div>
          </div>
          <div class="settings-setup-grid">
            <button type="button" class="setup-check-card" onclick="openSettingsSection('companyProfile')">
              <div class="setup-check-card-head">
                <div class="setup-check-card-title">${_t['settings.companyProfile']}</div>
                <div class="setup-check-card-hint">${_t['settings.setup.companyProfile.hint']}</div>
              </div>
              <span class="setup-status-chip" id="setupStatus-companyProfile"></span>
              <span style="color:var(--text-3);font-size:14px;margin-left:4px">›</span>
              <ul class="setup-check-list" id="setupList-companyProfile"></ul>
            </button>
            <button type="button" class="setup-check-card" onclick="openSettingsSection('valuePropositions')">
              <div class="setup-check-card-head">
                <div class="setup-check-card-title">${_t['settings.valuePropositions']}</div>
                <div class="setup-check-card-hint">${_t['settings.setup.valuePropositions.hint']}</div>
              </div>
              <span class="setup-status-chip" id="setupStatus-valuePropositions"></span>
              <span style="color:var(--text-3);font-size:14px;margin-left:4px">›</span>
              <ul class="setup-check-list" id="setupList-valuePropositions"></ul>
            </button>
            <button type="button" class="setup-check-card" onclick="openSettingsSection('targetList')">
              <div class="setup-check-card-head">
                <div class="setup-check-card-title">${_t['settings.targetList']}</div>
                <div class="setup-check-card-hint">${_t['settings.setup.targetList.hint']}</div>
              </div>
              <span class="setup-status-chip" id="setupStatus-targetList"></span>
              <span style="color:var(--text-3);font-size:14px;margin-left:4px">›</span>
              <ul class="setup-check-list" id="setupList-targetList"></ul>
            </button>
            <button type="button" class="setup-check-card" onclick="openSettingsSection('messageTemplates')">
              <div class="setup-check-card-head">
                <div class="setup-check-card-title">${_t['settings.messageTemplates']}</div>
                <div class="setup-check-card-hint">${_t['settings.setup.messageTemplates.hint']}</div>
              </div>
              <span class="setup-status-chip" id="setupStatus-messageTemplates"></span>
              <span style="color:var(--text-3);font-size:14px;margin-left:4px">›</span>
              <ul class="setup-check-list" id="setupList-messageTemplates"></ul>
            </button>
            <button type="button" class="setup-check-card" onclick="openSettingsSection('preferences')">
              <div class="setup-check-card-head">
                <div class="setup-check-card-title">${_t['settings.preferences']}</div>
                <div class="setup-check-card-hint">${_t['settings.setup.preferences.hint']}</div>
              </div>
              <span class="setup-status-chip" id="setupStatus-preferences"></span>
              <span style="color:var(--text-3);font-size:14px;margin-left:4px">›</span>
              <ul class="setup-check-list" id="setupList-preferences"></ul>
            </button>
            <button type="button" class="setup-check-card" onclick="openSettingsSection('exclusionRules')">
              <div class="setup-check-card-head">
                <div class="setup-check-card-title">${_t['settings.exclusionRules']}</div>
                <div class="setup-check-card-hint">${_t['settings.setup.optionalSection.hint']}</div>
              </div>
              <span class="setup-status-chip" id="setupStatus-exclusionRules"></span>
              <span style="color:var(--text-3);font-size:14px;margin-left:4px">›</span>
              <ul class="setup-check-list" id="setupList-exclusionRules"></ul>
            </button>
          </div>
        </div>

        <!-- Company Profile section -->
        <div class="settings-section active" id="sec-companyProfile">
          <h3>${_t['settings.companyProfile']}</h3>
          <p class="section-desc">${_t['settings.companyProfile.desc']}</p>
          <div class="settings-callout required"><strong>${_t['settings.tag.required']}</strong><span>${_t['settings.setup.companyProfile.hint']}</span></div>
          <div class="settings-callout" style="justify-content:space-between;align-items:center;flex-wrap:wrap">
            <div style="min-width:260px">
              <strong>${_t['settings.excel.title']}</strong><br>
              <span>${_t['settings.excel.desc']}</span>
            </div>
            <div style="display:flex;flex-wrap:wrap;gap:8px;margin-left:auto">
              <button type="button" class="btn btn-outline-primary btn-sm" onclick="downloadSettingsWorkbook('template')">${_t['settings.excel.template']}</button>
              <button type="button" class="btn btn-outline-primary btn-sm" onclick="downloadSettingsWorkbook('current')">${_t['settings.excel.exportCurrent']}</button>
              <button type="button" class="btn btn-outline-primary btn-sm" onclick="triggerSettingsWorkbookImport()">${_t['settings.excel.import']}</button>
            </div>
          </div>
          <div class="settings-row">
            <div class="settings-group">
              <label>${_t['field.companyName']} ${settingsTag('required')}</label>
              <input type="text" id="cp-companyName" placeholder="${_t['ph.companyName']}">
            </div>
            <div class="settings-group">
              <label>${_t['field.companyNameEn']}</label>
              <input type="text" id="cp-companyNameEn" placeholder="${_t['ph.companyNameEn']}">
            </div>
          </div>
          <div class="settings-row">
            <div class="settings-group">
              <label>${_t['field.companyNameKana']}</label>
              <input type="text" id="cp-companyNameKana" placeholder="${_t['ph.companyNameKana']}">
            </div>
            <div class="settings-group">
              <label>${_t['field.representative']}</label>
              <input type="text" id="cp-representative" placeholder="${_t['ph.representative']}">
            </div>
          </div>
          <div class="settings-row">
            <div class="settings-group">
              <label>${_t['field.contactName']} ${settingsTag('required')}</label>
              <input type="text" id="cp-contactName" placeholder="${_t['ph.contactName']}">
            </div>
            <div class="settings-group">
              <label>${_t['field.contactNameKana']}</label>
              <input type="text" id="cp-contactNameKana" placeholder="${_t['ph.contactNameKana']}">
            </div>
          </div>
          <div class="settings-row">
            <div class="settings-group">
              <label>${_t['field.contactTitle']}</label>
              <input type="text" id="cp-contactTitle" placeholder="${_t['ph.contactTitle']}">
            </div>
            <div class="settings-group">
              <label>${_t['field.department']}</label>
              <input type="text" id="cp-department" placeholder="${_t['ph.department']}">
            </div>
          </div>
          <div class="settings-row">
            <div class="settings-group">
              <label>${_t['field.email']} ${settingsTag('required')}</label>
              <input type="email" id="cp-email" placeholder="${_t['ph.email']}">
            </div>
            <div class="settings-group">
              <label>${_t['field.phone']} ${settingsTag('required')}</label>
              <input type="tel" id="cp-phone" placeholder="03-1234-5678">
            </div>
          </div>
          <div class="settings-row">
            <div class="settings-group">
              <label>${_t['field.fax']}</label>
              <input type="tel" id="cp-fax" placeholder="03-1234-5679">
            </div>
            <div class="settings-group">
              <label>${_t['field.mobile']}</label>
              <input type="tel" id="cp-mobile" placeholder="090-1234-5678">
            </div>
          </div>
          <div class="settings-row">
            <div class="settings-group">
              <label>${_t['field.postalCode']}</label>
              <input type="text" id="cp-postalCode" placeholder="100-0001">
            </div>
            <div class="settings-group">
              <label>${_t['field.address']}</label>
              <input type="text" id="cp-address" placeholder="${_t['ph.addressFull']}">
            </div>
          </div>
          <div class="settings-group">
            <label>${_t['field.addressEn']}</label>
            <input type="text" id="cp-addressEn" placeholder="${_t['ph.addressEn']}">
          </div>
          <div class="settings-row">
            <div class="settings-group">
              <label>${_t['field.website']}</label>
              <input type="text" id="cp-website" placeholder="https://example.com">
            </div>
            <div class="settings-group">
              <label>${_t['field.partnerPage']}</label>
              <input type="text" id="cp-partnerPage" placeholder="${_t['ph.partnerPage']}">
            </div>
          </div>
          <div class="settings-group">
            <label>${_t['field.corporateProfile']}</label>
            <input type="text" id="cp-corporateProfile" placeholder="${_t['ph.corporateProfile']}">
          </div>
          <div class="settings-row-3">
            <div class="settings-group">
              <label>${_t['field.established']}</label>
              <input type="text" id="cp-established" placeholder="${_t['ph.established']}">
            </div>
            <div class="settings-group">
              <label>${_t['field.employeeCount']}</label>
              <input type="text" id="cp-employeeCount" placeholder="${_t['ph.employeeCount']}">
            </div>
            <div class="settings-group">
              <label>${_t['field.capital']}</label>
              <input type="text" id="cp-capital" placeholder="${_t['ph.capital']}">
            </div>
          </div>
          <div class="settings-row">
            <div class="settings-group">
              <label>${_t['field.industry']}</label>
              <input type="text" id="cp-industry" placeholder="${_t['ph.industry']}">
            </div>
            <div class="settings-group">
              <label>${_t['field.businessDescription']}</label>
              <input type="text" id="cp-businessDescription" placeholder="${_t['ph.businessDescription']}">
            </div>
          </div>
          <div class="settings-group">
            <label>${_t['field.notes']}</label>
            <textarea id="cp-notes" placeholder="${_t['ph.notes']}"></textarea>
            <div class="help-text">${_t['help.notes']}</div>
          </div>
          <div class="save-bar">
            <button class="btn-save" onclick="saveSection('companyProfile')">${_t['settings.save']} ${_t['settings.companyProfile']}</button>
          </div>
        </div>

        <!-- Value Propositions section -->
        <div class="settings-section" id="sec-valuePropositions">
          <h3>${_t['settings.valuePropositions']}</h3>
          <p class="section-desc">${_t['settings.valuePropositions.desc']}</p>
          <div class="settings-callout recommended"><strong>${_t['settings.tag.recommended']}</strong><span>${_t['settings.setup.valuePropositions.hint']}</span></div>
          <div class="settings-callout"><strong>${_t['settings.excel.coverage']}</strong><span>${_t['settings.excel.coverage.desc']}</span></div>

          <div class="settings-group">
            <label>${_t['field.companyUrl']} ${settingsTag('optional')}</label>
            <input type="text" id="vp-companyUrl" placeholder="${_t['ph.websiteUrl']}">
            <div class="help-text">${_t['help.companyUrl']}</div>
          </div>

          <div class="settings-group">
            <label>${_t['field.serviceUrls']}</label>
            <div class="help-text mb-2">${_t['help.serviceUrls']}</div>
            <div class="list-manager" id="vp-serviceUrls-list"></div>
          </div>

          <div class="settings-group">
            <label>${_t['field.documents']}</label>
            <div class="help-text mb-2">${_t['help.documents']}</div>
            <div class="list-manager" id="vp-documentPaths-list"></div>
          </div>

          <div class="settings-group">
            <label>${_t['field.strengths']} ${settingsTag('required')}</label>
            <div class="help-text mb-2">${_t['help.strengths']}</div>
            <div id="vp-strengths-list"></div>
            <button class="btn btn-sm btn-outline-primary mt-2" onclick="addStrengthItem()">${_t['field.addStrength']}</button>
          </div>

          <div class="settings-group">
            <label>${_t['field.successPatterns']} ${settingsTag('recommended')}</label>
            <div class="help-text mb-2">${_t['help.successPatterns']}</div>
            <div id="vp-successPatterns-list"></div>
            <button class="btn btn-sm btn-outline-primary mt-2" onclick="addSuccessPatternItem()">${_t['field.addPattern']}</button>
          </div>

          <div class="settings-group">
            <label>${_t['field.industryProfiles']} ${settingsTag('recommended')}</label>
            <div class="help-text mb-2">${_t['help.industryProfiles']}</div>
            <div id="vp-industryProfiles-list"></div>
            <button class="btn btn-sm btn-outline-primary mt-2" onclick="addIndustryProfile()">${_t['field.addProfile']}</button>
          </div>

          <!-- 1.2.89: 理想顧客 (ICP) 設定 — sendability-gate / LLM 分析の根拠 -->
          <div class="settings-group">
            <h4 style="margin-top:24px;border-top:1px solid var(--border);padding-top:16px;">${_t['field.idealCustomer'] || '理想顧客 (ICP)'} ${settingsTag('recommended')}</h4>
            <div class="help-text mb-2">${_t['help.idealCustomer'] || '営業対象として理想的な企業の条件と、対象外 (deal breakers) を設定します。空欄でも動きますが、設定すると不適合先への送信を自動停止できます。'}</div>
          </div>

          <div class="settings-group">
            <label>${_t['field.icpDescription'] || '理想顧客の自由記述'}</label>
            <textarea id="vp-icp-description" rows="3" placeholder="例: 国内のSI/SaaS企業で、年間売上10〜500億円規模。CMS・Webアプリ構築の外注ニーズがある。"></textarea>
            <div class="help-text">${_t['help.icpDescription'] || 'LLM 分析時の判断材料として使われます。'}</div>
          </div>

          <div class="settings-group">
            <label>${_t['field.icpMustHave'] || '必須条件 (mustHave)'}</label>
            <div class="help-text mb-2">${_t['help.icpMustHave'] || '相手企業に求める条件 (例: 自社サービスを持つ / DX推進中)。1つ以上満たさないと skipped 候補。'}</div>
            <div id="vp-icp-mustHave-list"></div>
          </div>

          <div class="settings-group">
            <label>${_t['field.icpDealBreakers'] || '営業対象外 (dealBreakers)'} ${settingsTag('recommended')}</label>
            <div class="help-text mb-2">${_t['help.icpDealBreakers'] || '該当すると Phase A で即 skipped (例: 広告代理店 / 新築物件 / 自社で完結する独立系SIer)。部分一致で判定。'}</div>
            <div id="vp-icp-dealBreakers-list"></div>
          </div>

          <div class="settings-group">
            <label>${_t['field.icpPositive'] || '良いお手本 (exemplars.positive)'}</label>
            <div class="help-text mb-2">${_t['help.icpPositive'] || '理想的な過去顧客の社名・タイプ。LLM 分析の参考に使います。'}</div>
            <div id="vp-icp-positive-list"></div>
          </div>

          <div class="settings-group">
            <label>${_t['field.icpNegative'] || '反面教師 (exemplars.negative)'}</label>
            <div class="help-text mb-2">${_t['help.icpNegative'] || '営業しても合わなかった顧客タイプ。LLM 分析の参考に使います。'}</div>
            <div id="vp-icp-negative-list"></div>
          </div>

          <div class="settings-group" style="display:flex;gap:16px;flex-wrap:wrap;">
            <div style="flex:1;min-width:240px;">
              <label>${_t['field.icpMinSiteText'] || 'サイトテキスト最低文字数'}</label>
              <input type="number" id="vp-icp-minSiteTextLength" min="0" max="10000" step="100" placeholder="800">
              <div class="help-text">${_t['help.icpMinSiteText'] || '相手サイトの本文文字数がこれ未満なら fatal error (HTTP fetch 失敗 / JS描画 / 社名のみ等)。default 800。'}</div>
            </div>
            <div style="flex:1;min-width:240px;">
              <label>${_t['field.icpUseLlmAnalyzer'] || 'LLM サイト分析を使う'}</label>
              <select id="vp-icp-useLLMAnalyzer">
                <option value="false">無効 (default, キーワード辞書のみ)</option>
                <option value="true">有効 (CLI で site_text を解析)</option>
              </select>
              <div class="help-text">${_t['help.icpUseLlmAnalyzer'] || '有効にすると Phase A で CLI を呼び業界・適合度を分析。コスト増。'}</div>
            </div>
            <div style="flex:1;min-width:240px;">
              <label>${_t['field.icpUseLlmGenerator'] || 'LLM メッセージ生成を使う'}</label>
              <select id="vp-icp-useLLMMessageGenerator">
                <option value="false">無効 (default, テンプレートで生成)</option>
                <option value="true">有効 (CLI で本文生成)</option>
              </select>
              <div class="help-text">${_t['help.icpUseLlmGenerator'] || '有効にすると Phase A 内で CLI を呼びパーソナライズ本文を生成。コスト増。'}</div>
            </div>
          </div>

          <div class="save-bar">
            <button class="btn-save" onclick="saveSection('valuePropositions')">${_t['settings.save']} ${_t['settings.valuePropositions']}</button>
          </div>
        </div>

        <!-- Target List section -->
        <div class="settings-section" id="sec-targetList">
          <h3>${_t['settings.targetList']}</h3>
          <p class="section-desc">${_t['settings.targetList.desc']}</p>
          <div class="settings-callout required"><strong>${_t['settings.tag.required']}</strong><span>${_t['settings.setup.targetList.hint']}</span></div>

          <div class="settings-group">
            <label>${_t['field.filePath']} ${settingsTag('required')}</label>
            <input type="text" id="tl-filePath" placeholder="${_t['ph.filePath']}">
            <div class="help-text">${_t['help.filePath']}</div>
          </div>
          <div class="settings-row">
            <div class="settings-group">
              <label>${_t['field.fileType']}</label>
              <select id="tl-fileType">
                <option value="xlsx">Excel (.xlsx)</option>
                <option value="csv">CSV (.csv)</option>
              </select>
            </div>
            <div class="settings-group">
              <label>${_t['field.sheetIndex']}</label>
              <input type="number" id="tl-sheetIndex" min="0" value="0">
              <div class="help-text">${_t['help.sheetIndex']}</div>
            </div>
          </div>

          <div class="settings-group">
            <label>${_t['field.columnMapping']} ${settingsTag('recommended')}</label>
            <div class="help-text mb-2">${_t['help.columnMapping']}</div>
            <div class="help-text mb-2">${_t['help.columnMappingCustom']}</div>
            <div class="column-map-toolbar">
              <small class="text-muted">${_t['field.columnMapping']}</small>
              <button type="button" class="btn btn-sm btn-outline-primary" onclick="addCustomColumnMappingRow()">${_t['field.addColumnMapping']}</button>
            </div>
            <div class="column-map-list" id="tl-columnMappingList"></div>
          </div>

          <div class="settings-group">
            <label>${_t['settings.preview']}</label>
            <div class="help-text mb-2">${_t['help.targetPreview']}</div>
            <button class="btn btn-sm btn-outline-primary mb-2" onclick="loadTargetPreview()">${_t['field.loadPreview']}</button>
            <div id="targetPreview"></div>
          </div>

          <div class="save-bar">
            <button class="btn-save" onclick="saveSection('targetList')">${_t['settings.save']} ${_t['settings.targetList']}</button>
          </div>
        </div>

        <!-- Exclusion Rules section -->
        <div class="settings-section" id="sec-exclusionRules">
          <h3>${_t['settings.exclusionRules']}</h3>
          <p class="section-desc">${_t['settings.exclusionRules.desc']}</p>
          <div class="settings-callout optional"><strong>${_t['settings.tag.optional']}</strong><span>${_t['settings.setup.optionalSection.hint']}</span></div>

          <div class="settings-group">
            <label>${_t['field.competitors']}</label>
            <div class="help-text mb-2">${_t['help.competitors']}</div>
            <div id="er-competitors-list"></div>
            <button class="btn btn-sm btn-outline-primary mt-2" onclick="addExclusionItem('competitors')">${_t['field.addCompetitor']}</button>
          </div>

          <div class="settings-group">
            <label>${_t['field.existingClients']}</label>
            <div class="help-text mb-2">${_t['help.existingClients']}</div>
            <div id="er-existingClients-list"></div>
            <button class="btn btn-sm btn-outline-primary mt-2" onclick="addExclusionItem('existingClients')">${_t['field.addClient']}</button>
          </div>

          <div class="settings-group">
            <label>${_t['field.ngList']}</label>
            <div class="help-text mb-2">${_t['help.ngList']}</div>
            <div id="er-ngList-list"></div>
            <button class="btn btn-sm btn-outline-primary mt-2" onclick="addNgItem()">${_t['field.addNg']}</button>
          </div>

          <div class="settings-group">
            <label>${_t['field.customRules']}</label>
            <div class="help-text mb-2">${_t['help.customRules']}</div>
            <div id="er-customRules-list"></div>
            <button class="btn btn-sm btn-outline-primary mt-2" onclick="addCustomRule()">${_t['field.addCustomRule']}</button>
          </div>

          <div class="settings-group">
            <label>${_t['field.excludeStatuses']}</label>
            <div class="help-text mb-2">${_t['help.excludeStatuses']}</div>
            <div class="list-manager" id="er-excludeStatuses-list"></div>
          </div>

          <div class="save-bar">
            <button class="btn-save" onclick="saveSection('exclusionRules')">${_t['settings.save']} ${_t['settings.exclusionRules']}</button>
          </div>
        </div>

        <!-- Message Templates section -->
        <div class="settings-section" id="sec-messageTemplates">
          <h3>${_t['settings.messageTemplates']}</h3>
          <p class="section-desc">${_t['settings.messageTemplates.desc']}</p>
          <div class="settings-callout recommended"><strong>${_t['settings.tag.recommended']}</strong><span>${_t['settings.setup.messageTemplates.hint']}</span></div>

          <div class="settings-row-3">
            <div class="settings-group">
              <label>${_t['field.tone']}</label>
              <select id="mt-tone">
                <option value="formal">${_t['field.toneOptions.formal']}</option>
                <option value="casual">${_t['field.toneOptions.casual']}</option>
                <option value="business">${_t['field.toneOptions.business']}</option>
              </select>
            </div>
            <div class="settings-group">
              <label>${_t['field.msgLanguage']}</label>
              <select id="mt-language">
                <option value="ja">${_t['field.langJa']}</option>
                <option value="en">${_t['field.langEn']}</option>
              </select>
            </div>
            <div class="settings-group">
              <label>${_t['field.maxLength']}</label>
              <input type="number" id="mt-maxLength" min="100" max="10000">
              <div class="help-text">${_t['help.maxLength']}</div>
            </div>
          </div>

          <div class="settings-group">
            <label>${_t['field.signatureFormat']}</label>
            <select id="mt-signatureFormat">
              <option value="full">${_t['field.sigFull']}</option>
              <option value="minimal">${_t['field.sigMinimal']}</option>
              <option value="none">${_t['field.sigNone']}</option>
            </select>
          </div>

          <div class="settings-group">
            <label>${_t['field.inquiryTypes']}</label>
            <div class="help-text mb-2">${_t['help.inquiryTypes']}</div>
            <div class="list-manager" id="mt-inquiryTypes-list"></div>
          </div>

          <div class="settings-group">
            <label>${_t['field.greetingLine']} ${settingsTag('required')}</label>
            <input type="text" id="mt-greetingLine" placeholder="${_t['ph.greeting']}">
          </div>
          <div class="settings-group">
            <label>${_t['field.approachObjective']} ${settingsTag('recommended')}</label>
            <textarea id="mt-approachObjective" placeholder="${_t['ph.approachObjective']}"></textarea>
            <div class="help-text">${_t['help.approachObjective']}</div>
          </div>
          <div class="settings-group">
            <label>${_t['field.approachGuardrails']}</label>
            <textarea id="mt-approachGuardrails" placeholder="${_t['ph.approachGuardrails']}"></textarea>
            <div class="help-text">${_t['help.approachGuardrails']}</div>
          </div>
          <!-- v2.0.99: 営業アプローチ意図 (どの種別のフォームに営業をかけたいか) -->
          <div class="settings-group">
            <label>${_lang === 'ja' ? '営業アプローチ意図' : 'Outreach intent'}</label>
            <div class="help-text" style="margin-bottom:8px">${_lang === 'ja'
              ? 'どの窓口に営業したいかを選びます。AI は対象種別のフォームを優先的に探し、無ければ一般の問い合わせフォームにフォールバックします。採用/広報/IR を選ぶと「採用専用」等の窓口も対象に含めます。'
              : 'Pick which inquiry channels to target. The AI prefers matching forms and falls back to general contact if absent. Selecting recruit/media/IR also includes those dedicated channels.'}</div>
            <div id="mt-approachTargets" style="display:flex;flex-wrap:wrap;gap:8px 16px">
              ${(() => {
                try {
                  // eslint-disable-next-line @typescript-eslint/no-require-imports
                  const ai = require('./approach-intent');
                  const cur = (settings.getApproachTargets && settings.getApproachTargets()) || ai.DEFAULT_TARGETS;
                  return ai.listIntents().map((it: any) => {
                    const checked = cur.indexOf(it.key) >= 0 ? ' checked' : '';
                    const safeLabel = String(it.label).replace(/&/g, '&amp;').replace(/</g, '&lt;');
                    return '<label style="display:inline-flex;align-items:center;gap:5px;font-size:.82rem;cursor:pointer">'
                      + '<input type="checkbox" class="mt-approachTarget" value="' + it.key + '"' + checked + '> ' + safeLabel + '</label>';
                  }).join('');
                } catch (_) { return ''; }
              })()}
            </div>
            <div class="save-bar" style="margin-top:10px">
              <button class="btn-save" id="mt-approachTargetsSave" type="button">${_t['settings.save']} ${_lang === 'ja' ? 'アプローチ意図' : 'Outreach intent'}</button>
              <span id="mt-approachTargetsStatus" style="margin-left:10px;font-size:.8rem"></span>
            </div>
          </div>
          <script>
            (function(){
              var btn = document.getElementById('mt-approachTargetsSave');
              if (!btn || btn.dataset.bound) return;
              btn.dataset.bound = '1';
              btn.addEventListener('click', async function(){
                var status = document.getElementById('mt-approachTargetsStatus');
                var boxes = Array.prototype.slice.call(document.querySelectorAll('.mt-approachTarget:checked'));
                var targets = boxes.map(function(b){ return b.value; });
                if (status){ status.textContent = ${_lang === 'ja' ? "'保存中…'" : "'Saving…'"}; status.style.color = 'var(--text-2)'; }
                try {
                  // 既存 messageTemplates を読み、approachTargets だけ差し替えて PUT (他項目を消さない)
                  var cur = await (await fetch('/api/settings')).json();
                  var mt = (cur && cur.messageTemplates) || {};
                  mt.approachTargets = targets;
                  var r = await fetch('/api/settings/messageTemplates', { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify(mt) });
                  if (!r.ok) throw new Error('HTTP ' + r.status);
                  if (status){ status.textContent = ${_lang === 'ja' ? "'✓ 保存しました'" : "'✓ Saved'"}; status.style.color = 'var(--success,#16a34a)'; }
                } catch (e) {
                  if (status){ status.textContent = ${_lang === 'ja' ? "'保存失敗: '" : "'Save failed: '"} + (e.message||e); status.style.color = 'var(--error,#dc2626)'; }
                }
                setTimeout(function(){ if(status) status.textContent=''; }, 5000);
              });
            })();
          </script>
          <div class="settings-group">
            <label>${_t['field.closingLine']} ${settingsTag('required')}</label>
            <textarea id="mt-closingLine" placeholder="${_t['ph.closing']}"></textarea>
          </div>
          <div class="settings-group">
            <label>${_t['field.cta']} ${settingsTag('recommended')}</label>
            <input type="text" id="mt-cta" placeholder="${_t['ph.cta']}">
          </div>
          <div class="settings-group">
            <label>${_t['field.referenceUrlText']}</label>
            <input type="text" id="mt-referenceUrlText" placeholder="${_t['ph.referenceUrl']}">
          </div>
          <div class="settings-group">
            <label>${_t['field.signatureTemplate']} ${settingsTag('required')}</label>
            <textarea id="mt-signatureTemplate" placeholder="${_t['ph.signature']}"></textarea>
            <div class="help-text">${_t['help.signaturePlaceholders']}</div>
          </div>

          <div class="settings-group" style="margin-top:16px;padding-top:16px;border-top:2px solid var(--surface-high)">
            <label>${_t['field.letterTemplate']}</label>
            <div class="help-text mb-2">${_t['help.letterTemplate']}</div>
            <div class="settings-row-3">
              <div class="settings-group">
                <label>${_t['field.letterEnabled']}</label>
                <select id="mt-letter-enabled">
                  <option value="false">${_t['field.yesNo.no']}</option>
                  <option value="true">${_t['field.yesNo.yes']}</option>
                </select>
              </div>
              <div class="settings-group">
                <label>${_t['field.letterFormat']}</label>
                <select id="mt-letter-format">
                  <option value="A4">A4</option>
                  <option value="letter">Letter</option>
                </select>
              </div>
              <div></div>
            </div>
            <div class="settings-group">
              <label>${_t['field.letterHeader']}</label>
              <textarea id="mt-letter-header" placeholder="${_t['ph.letterHeader']}"></textarea>
            </div>
            <div class="settings-group">
              <label>${_t['field.letterFooter']}</label>
              <textarea id="mt-letter-footer" placeholder="${_t['ph.letterFooter']}"></textarea>
            </div>
          </div>

          <div class="save-bar">
            <button class="btn-save" onclick="saveSection('messageTemplates')">${_t['settings.save']} ${_t['settings.messageTemplates']}</button>
          </div>
        </div>

        <!-- Preferences section -->
        <div class="settings-section" id="sec-preferences">
          <h3>${_t['settings.preferences']}</h3>
          <p class="section-desc">${_t['settings.preferences.desc']}</p>
          <div class="settings-callout optional"><strong>${_t['settings.tag.optional']}</strong><span>${_t['settings.setup.preferences.hint']}</span></div>

          <div class="settings-group" style="background:var(--info-container);padding:12px;border-radius:var(--radius-md);margin-bottom:16px">
            <small style="color:var(--info)">${_t['help.portRestart']}</small>
          </div>

          <div class="settings-row">
            <div class="settings-group">
              <label>${_t['field.dashboardPort']}</label>
              <input type="number" id="pf-dashboardPort" min="1024" max="65535">
            </div>
            <div class="settings-group">
              <label>${_t['field.dashboardHost']}</label>
              <input type="text" id="pf-dashboardHost" placeholder="127.0.0.1">
            </div>
          </div>

          <div class="settings-row-3">
            <div class="settings-group">
              <label>${_t['field.language']}</label>
              <select id="pf-language">
                <option value="ja">${_t['field.langJa']}</option>
                <option value="en">${_t['field.langEn']}</option>
              </select>
            </div>
            <div class="settings-group">
              <label>${_t['field.timezone']}</label>
              <input type="text" id="pf-timezone" placeholder="Asia/Tokyo">
            </div>
            <div class="settings-group">
              <label>${_t['field.dateFormat']}</label>
              <input type="text" id="pf-dateFormat" placeholder="YYYY-MM-DD HH:mm">
            </div>
          </div>

          <div class="settings-row">
            <div class="settings-group">
              <label>${_t['field.screenshotDir']} ${settingsTag('recommended')}</label>
              <div class="settings-path-picker">
                <input type="text" id="pf-screenshotDir" placeholder="screenshots">
                <button type="button" class="btn-picker" onclick="browseForDirectory('pf-screenshotDir')" ${process.versions.electron ? '' : 'title="' + _t['settings.dirPicker.desktopOnlyTitle'] + '"'}>${process.versions.electron ? _t['action.browseFolder'] : _t['action.browseFolderDesktop']}</button>
              </div>
              <div class="help-text">${process.versions.electron ? _t['settings.dirPicker.desktopHelp'] : _t['settings.dirPicker.browserHelp']}</div>
            </div>
            <div class="settings-group">
              <label>${_t['field.dataDir']} ${settingsTag('recommended')}</label>
              <div class="settings-path-picker">
                <input type="text" id="pf-dataDir" placeholder="data">
                <button type="button" class="btn-picker" onclick="browseForDirectory('pf-dataDir')" ${process.versions.electron ? '' : 'title="' + _t['settings.dirPicker.desktopOnlyTitle'] + '"'}>${process.versions.electron ? _t['action.browseFolder'] : _t['action.browseFolderDesktop']}</button>
              </div>
              <div class="help-text">${process.versions.electron ? _t['settings.dirPicker.desktopHelp'] : _t['settings.dirPicker.browserHelp']}</div>
            </div>
          </div>

          <div class="settings-row">
            <div class="settings-group">
              <label>${_t['field.emailKeyword']}</label>
              <input type="text" id="pf-emailSearchKeyword" placeholder="${_t['ph.emailKeyword']}">
            </div>
            <div class="settings-group">
              <label>${_t['field.emailProvider']}</label>
              <select id="pf-emailProvider">
                <option value="outlook">Outlook</option>
                <option value="gmail">Gmail</option>
                <option value="other">Other</option>
              </select>
            </div>
          </div>

          <div class="settings-row-3">
            <div class="settings-group">
              <label>${_t['field.maxRetries']}</label>
              <input type="number" id="pf-maxRetries" min="0" max="10">
              <div class="help-text">${_t['help.maxRetries']}</div>
            </div>
            <div class="settings-group">
              <label>${_t['field.pageTimeout']}</label>
              <input type="number" id="pf-pageTimeout" min="1000" max="120000">
            </div>
            <div class="settings-group">
              <label>${_t['field.formFillTimeout']}</label>
              <input type="number" id="pf-formFillTimeout" min="1000" max="60000">
            </div>
          </div>

          <div class="settings-row-3">
            <div class="settings-group">
              <label>${_t['field.headless']}</label>
              <select id="pf-headless">
                <option value="true">${_t['field.yesNo.yes']}</option>
                <option value="false">${_t['field.yesNo.no']}</option>
              </select>
              <div class="help-text">${_t['help.headless']}</div>
            </div>
            <div class="settings-group">
              <label>${_t['field.locale']}</label>
              <input type="text" id="pf-locale" placeholder="ja-JP">
            </div>
            <div class="settings-group">
              <label>${_t['field.requireApproval']}</label>
              <select id="pf-requireApprovalBeforeSend">
                <option value="true">${_t['field.yesNo.yes']}</option>
                <option value="false">${_t['field.yesNo.no']}</option>
              </select>
              <div class="help-text">${_t['help.requireApproval']}</div>
            </div>
          </div>

          <div class="settings-group">
            <label>${_t['field.autoSendEligibleForms']}</label>
            <select id="pf-autoSendEligibleForms">
              <option value="false">${_t['field.yesNo.no']}</option>
              <option value="true">${_t['field.yesNo.yes']}</option>
            </select>
            <div class="help-text">${_t['help.autoSendEligibleForms']}</div>
          </div>

          <div class="settings-group">
            <label>${_t['field.userAgent']}</label>
            <input type="text" id="pf-userAgent" placeholder="${_t['ph.userAgent']}">
          </div>

          <div class="settings-row-3">
            <div class="settings-group">
              <label>${_t['field.logLevel']}</label>
              <select id="pf-logLevel">
                <option value="debug">Debug</option>
                <option value="info">Info</option>
                <option value="warn">Warn</option>
                <option value="error">Error</option>
              </select>
            </div>
            <div class="settings-group">
              <label>${_t['field.maxLogEntries']}</label>
              <input type="number" id="pf-maxLogEntries" min="100" max="100000">
            </div>
            <div class="settings-group">
              <label>${_t['field.exportPrefix']}</label>
              <input type="text" id="pf-exportFilenamePrefix" placeholder="${_t['ph.exportPrefix']}">
            </div>
            <div class="settings-group">
              <label>${_t['field.managedAiFormBatchSize']}</label>
              <input type="number" id="pf-managedAiFormBatchSize" min="1" max="10" placeholder="3">
              <div class="help-text">${_t['help.managedAiFormBatchSize']}</div>
            </div>
            <div class="settings-group">
              <label>${_t['field.parallelTabs']}</label>
              <input type="number" id="pf-parallelTabs" min="1" max="3" placeholder="1">
              <div class="help-text">${_t['help.parallelTabs']}</div>
            </div>
          </div>

          <!-- v2.1.0: フォーム入力モード (環境設定に統合) -->
          <div class="settings-group" style="margin-top:8px">
            <label>${_lang === 'ja' ? 'フォーム入力モード' : 'Form Fill Mode'}</label>
            <div class="help-text">
              ${_lang === 'ja'
                ? 'AI がフォーム入力に使うブラウザエンジン。internal は Sales Claw アプリ内で完結 (推奨)、playwright は外部 Chrome を起動する旧モード。'
                : 'Browser engine used by AI for form filling. internal completes inside the Sales Claw app (recommended), playwright launches external Chrome (legacy).'}
            </div>
          </div>
          <div class="settings-row-3">
            <div class="settings-group">
              <label>${_lang === 'ja' ? 'モード' : 'Mode'}</label>
              <select id="ff-mode">
                <option value="internal">internal (${_lang === 'ja' ? '推奨・アプリ内完結' : 'Recommended — in-app'})</option>
                <option value="playwright">playwright (${_lang === 'ja' ? '旧・外部 Chrome' : 'Legacy — external Chrome'})</option>
                <option value="both">both (${_lang === 'ja' ? 'A/B テスト用' : 'A/B testing'})</option>
              </select>
              <div class="help-text">
                ${_lang === 'ja'
                  ? 'internal: Electron 内蔵 WebContentsView (外部ブラウザを開かない)'
                  : 'internal: Electron-embedded WebContentsView (no external browser)'}
              </div>
            </div>
            <div class="settings-group">
              <label>${_lang === 'ja' ? '並列度' : 'Parallelism'}</label>
              <input type="number" id="ff-parallelism" min="1" max="5" placeholder="3">
              <div class="help-text">
                ${_lang === 'ja' ? '1-5。同時に処理する社数。デフォルト 3' : '1-5. Companies processed in parallel. Default 3'}
              </div>
            </div>
            <div class="settings-group">
              <label style="opacity:.6">${_lang === 'ja' ? '現在のモード' : 'Current mode'}</label>
              <div id="ff-currentMode" style="padding:8px;background:var(--bg-surface);border:1px solid var(--border);border-radius:6px;font-family:var(--font-mono);font-size:.8rem">—</div>
              <div class="help-text">${_lang === 'ja' ? '保存後、次回 AI 起動から反映 (再起動推奨)' : 'Applies on next AI launch (restart recommended)'}</div>
            </div>
          </div>

          <div class="settings-group" style="margin-top:24px;padding-top:16px;border-top:1px solid var(--border)">
            <label>${_t['field.aiProvider']} ${settingsTag('recommended')}</label>
            <select id="pf-aiProvider">
              ${providerSelectHtml}
            </select>
            <div class="help-text">${_t['help.aiProvider']}</div>
          </div>

          <div class="settings-row-3">
            <div class="settings-group">
              <label>${_t['field.aiModelClaude']} ${settingsTag('recommended')}</label>
              <input type="text" id="pf-aiModelClaude" placeholder="claude-sonnet-4-6">
              <div class="help-text">${_t['help.aiModel']}</div>
            </div>
            <div class="settings-group">
              <label>${_t['field.aiModelCodex']}</label>
              <input type="text" id="pf-aiModelCodex" placeholder="gpt-5-codex">
              <div class="help-text">${_t['help.aiModel']}</div>
            </div>
            <div class="settings-group">
              <label>${_t['field.aiModelGemini']}</label>
              <input type="text" id="pf-aiModelGemini" placeholder="gemini-2.5-pro">
              <div class="help-text">${_t['help.aiModel']}</div>
            </div>
          </div>

          <div class="save-bar">
            <button class="btn-save" onclick="saveSection('preferences'); if(window.__saveFormFill)window.__saveFormFill();">${_t['settings.save']} ${_t['settings.preferences']}</button>
            <span id="ff-saveStatus" style="margin-left:12px;font-size:.8rem"></span>
          </div>
        </div>

        <script>
          (function(){
            // v2.1.0 formFill UI: load → populate → save
            async function loadFormFill() {
              try {
                const r = await fetch('/api/settings');
                if (!r.ok) throw new Error('HTTP ' + r.status);
                const j = await r.json();
                const ff = (j && j.formFill) || {};
                const mode = ff.mode || 'internal';
                const parallelism = ff.parallelism != null ? ff.parallelism : 3;
                document.getElementById('ff-mode').value =
                  (mode === 'playwright' || mode === 'internal' || mode === 'both') ? mode : 'internal';
                document.getElementById('ff-parallelism').value = parallelism;
                document.getElementById('ff-currentMode').textContent = mode;
              } catch (e) {
                document.getElementById('ff-currentMode').textContent = 'error: ' + (e.message || e);
              }
            }
            async function saveFormFill() {
              const status = document.getElementById('ff-saveStatus');
              const modeEl = document.getElementById('ff-mode');
              const parEl = document.getElementById('ff-parallelism');
              if (!modeEl || !parEl || !status) return;
              const mode = modeEl.value;
              const parallelism = Math.min(5, Math.max(1, parseInt(parEl.value, 10) || 3));
              status.textContent = ${_lang === 'ja' ? "'保存中…'" : "'Saving…'"};
              status.style.color = 'var(--text-2)';
              try {
                const r = await fetch('/api/settings/formFill', {
                  method: 'PUT',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ mode: mode, parallelism: parallelism }),
                });
                const j = await r.json().catch(() => ({}));
                if (!r.ok || j.ok === false) throw new Error(j.error || ('HTTP ' + r.status));
                status.textContent = ${_lang === 'ja'
                  ? "'✓ 保存しました。次回 AI 起動から反映されます (再起動推奨)。'"
                  : "'✓ Saved. Will apply on next AI launch (restart recommended).'"};
                status.style.color = 'var(--success, #16a34a)';
                document.getElementById('ff-currentMode').textContent = mode;
              } catch (e) {
                status.textContent = ${_lang === 'ja' ? "'保存失敗: '" : "'Save failed: '"} + (e.message || e);
                status.style.color = 'var(--error, #dc2626)';
              } finally {
                setTimeout(function(){ status.textContent = ''; }, 6000);
              }
            }
            window.__saveFormFill = saveFormFill;
            loadFormFill();
          })();
        </script>

      </div>
    </div>
  </div>
  </div><!-- /main-column -->
</div><!-- /padding:16px flex container -->

<!-- Floating Chat-style Live Monitor -->
<!-- Toast notification (shows when panel is closed) -->
<div id="monitorToast" style="position:fixed;bottom:80px;right:24px;z-index:9990;max-width:320px;background:var(--bg-card);border:1px solid var(--border-default);border-radius:var(--radius-md);box-shadow:var(--shadow-modal);padding:10px 14px;display:none;animation:monitorToastIn .3s var(--ease-spring);cursor:pointer" onclick="toggleMonitorPanel()">
  <div style="display:flex;align-items:flex-start;gap:8px">
    <span id="monitorToastDot" style="width:8px;height:8px;border-radius:50%;background:var(--primary);flex-shrink:0;margin-top:3px"></span>
    <div style="min-width:0;flex:1">
      <div id="monitorToastCompany" style="font-size:.75rem;font-weight:700;color:var(--text-1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">-</div>
      <div id="monitorToastStep" style="font-size:.68rem;color:var(--text-2);margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">-</div>
    </div>
    <span style="font-size:.6rem;color:var(--text-3);font-family:var(--font-mono);flex-shrink:0" id="monitorToastTime">--:--</span>
  </div>
</div>

<!-- Floating toggle button -->
<button id="monitorFab" onclick="toggleMonitorPanel()" style="position:fixed;bottom:24px;right:24px;z-index:9991;width:52px;height:52px;border-radius:50%;background:linear-gradient(135deg,#1a1a1a,#1e293b);color:#eeefeb;border:none;cursor:pointer;box-shadow:var(--shadow-modal);display:flex;align-items:center;justify-content:center;transition:all .25s var(--ease-out-expo)" onmouseover="this.style.transform='scale(1.08)'" onmouseout="this.style.transform='scale(1)'">
  <span id="monitorDot" style="position:absolute;top:10px;right:10px;width:10px;height:10px;border-radius:50%;background:#9a9a96;transition:background .3s;border:2px solid #1a1a1a"></span>
  <span id="monitorFabBadge" style="display:none;position:absolute;top:0;right:0;min-width:18px;height:18px;background:var(--error);color:#fff;font-size:.6rem;font-weight:800;border-radius:9px;padding:0 5px;line-height:18px;text-align:center;border:2px solid #fff;font-family:var(--font-mono)">0</span>
  <span class="material-symbols-outlined" style="font-size:22px">chat</span>
</button>

<!-- Floating panel -->
<div id="liveMonitorCard" style="position:fixed;bottom:84px;right:24px;z-index:9989;width:420px;max-height:min(600px,calc(100vh - 120px));background:var(--bg-card);border:1px solid var(--border-default);border-radius:16px;overflow:hidden;box-shadow:0 20px 60px rgba(15,23,42,.18),0 2px 8px rgba(15,23,42,.08);display:none;flex-direction:column;animation:monitorPanelIn .25s var(--ease-out-expo)">
  <!-- Header -->
  <div style="display:flex;align-items:center;gap:8px;padding:10px 14px;background:linear-gradient(135deg,#1a1a1a 0%,#1e293b 100%);user-select:none;flex-shrink:0">
    <span class="material-symbols-outlined" style="font-size:16px;color:#eeefeb">monitoring</span>
    <span style="font-size:.72rem;font-weight:700;color:#eeefeb;flex:1">Live Activity</span>
    <div id="monitorStatusChip" style="display:inline-flex;align-items:center;gap:5px;background:rgba(255,255,255,.1);color:#9a9a96;font-size:.56rem;font-weight:700;padding:2px 8px;border-radius:4px;letter-spacing:.04em">${_t['monitor.idle'] || 'Idle'}</div>
    <button id="liveMonitorToggleBtn" onclick="toggleMonitorPanel()" style="display:inline-flex;align-items:center;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.14);color:#eeefeb;font-size:14px;padding:3px;border-radius:6px;cursor:pointer;transition:all .15s;line-height:1" onmouseover="this.style.background='rgba(255,255,255,.2)'" onmouseout="this.style.background='rgba(255,255,255,.08)'">✕</button>
  </div>

  <!-- Body -->
  <div id="liveMonitorBody" style="display:flex;flex-direction:column;flex:1;overflow:hidden">
    <!-- Compact Latest Activity -->
    <div style="padding:8px 14px;border-bottom:1px solid var(--border-subtle);background:var(--bg-surface);flex-shrink:0">
      <div style="display:flex;align-items:center;gap:8px">
        <div style="min-width:0;flex:1">
          <div id="monitorCompany" style="font-size:.78rem;font-weight:700;color:var(--text-1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">-</div>
          <div id="monitorStep" style="font-size:.68rem;color:var(--text-2);margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">-</div>
        </div>
        <div id="monitorUpdatedAt" style="font-size:.58rem;font-family:var(--font-mono);color:var(--text-3);white-space:nowrap;flex-shrink:0">-</div>
      </div>
    </div>

    <!-- Thinking indicator -->
    <div id="monitorThinkingRow" style="display:none;align-items:center;gap:8px;padding:6px 14px;background:linear-gradient(90deg,rgba(99,102,241,.06),transparent);border-bottom:1px solid rgba(99,102,241,.1);flex-shrink:0">
      <span class="think-spin"></span>
      <span id="monitorThinkingText" style="font-size:.68rem;color:#6366f1;font-style:italic;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">思考中...</span>
    </div>
    <div id="monitorActiveSummary" style="display:none">-</div>

    <!-- Event List (scrollable, chat-style) -->
    <div id="monitorEventList" style="display:flex;flex-direction:column;flex:1;overflow-y:auto;background:var(--bg-card);overscroll-behavior:contain;padding:4px 0"></div>

    <!-- Collapsible footer: URL + Screenshot -->
    <div id="monitorFooter" style="border-top:1px solid var(--border-subtle);background:var(--bg-surface);flex-shrink:0">
      <div style="display:flex;align-items:center;gap:6px;padding:6px 14px">
        <a id="monitorCurrentUrl" href="#" target="_blank" style="flex:1;font-size:.62rem;color:var(--primary);font-family:var(--font-mono);text-decoration:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">-</a>
        <a id="monitorScreenshotLink" href="#" target="_blank" style="display:none;font-size:.58rem;color:var(--primary);text-decoration:none;font-weight:700;white-space:nowrap">${_t['monitor.screenshot.short'] || 'SS ↗'}</a>
      </div>
      <div id="monitorScreenshotWrap" style="display:none;margin:0 14px 8px;max-height:100px;overflow:auto;overscroll-behavior:contain;border:1px dashed var(--border-default);border-radius:var(--radius-sm);background:var(--bg-deep)"></div>
    </div>
  </div>
</div>
</main>

<script>
(function(){
  if (window.__salesClawFormTabGuard) return;
  window.__salesClawFormTabGuard = true;
  const token = ${serializeForInlineScript(ensureDashboardSessionToken())};
  function notifyFormTab(tab) {
    try {
      fetch('/api/form-session/tab-changed', {
        method: 'POST',
        keepalive: true,
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'x-sales-claw-session': token,
        },
        body: JSON.stringify({ activeTab: tab || '' }),
      }).catch(function(){});
    } catch (_) {}
  }
  document.addEventListener('click', function(ev) {
    const btn = ev.target && ev.target.closest && ev.target.closest('.tab-btn[data-tab]');
    if (!btn) return;
    notifyFormTab(btn.getAttribute('data-tab') || '');
  }, true);
  window.addEventListener('pagehide', function(){ notifyFormTab('pagehide'); });
  const active = document.querySelector('.tab-btn.active[data-tab]');
  notifyFormTab(active ? active.getAttribute('data-tab') : '');
})();
</script>

<script>
const LANG = ${serializeForInlineScript(_lang)};
const PREF_TZ = ${serializeForInlineScript(_tz)};
const I18N = ${serializeForInlineScript(_t)};
const AVAILABLE_AI_PROVIDERS = ${serializeForInlineScript(providerOptions)};
const DASHBOARD_SESSION_TOKEN = ${serializeForInlineScript(ensureDashboardSessionToken())};
const DASHBOARD_SESSION_COOKIE_NAME = ${serializeForInlineScript(getDashboardSessionCookieName())};
const NATIVE_DIRECTORY_PICKER_AVAILABLE = ${process.versions.electron ? 'true' : 'false'};
const BUILD_SOURCE = ${serializeForInlineScript(APP_BUILD_SOURCE)};
${renderAwaitingCardRedesignScript()}
${renderSentCardRedesignScript()}
${renderDashboardScript()}
${renderLaunchCrashGuardScript()}
${renderUpdateCheckControlsScript()}
${renderAnalyticsScript()}
${renderColumnResizerScript()}
${renderCliTerminalScript()}
${renderPaginationScript()}
${renderSettingsRedesignScript()}
${renderProviderIconFixScript()}

// --- Recovery banner (前回中断バッチの復旧通知) ---
(function () {
  function showRecoveryBanner(snap) {
    var el = document.getElementById('recoveryBanner');
    if (!el) return;
    var detail = document.getElementById('recoveryBannerDetail');
    if (detail && snap) {
      var names = (snap.companyNames || []).slice(0, 3).join(', ');
      var more = snap.totalCompanies > 3 ? ('  ほか ' + (snap.totalCompanies - 3) + ' 社') : '';
      detail.textContent = (snap.totalCompanies || 0) + ' 社の処理が中断されました — ' + names + more;
    }
    el.style.display = 'flex';
  }
  function hideRecoveryBanner() {
    var el = document.getElementById('recoveryBanner');
    if (el) el.style.display = 'none';
  }
  window.resumeRecovery = async function () {
    var btn = document.getElementById('recoveryResumeBtn');
    if (btn) { btn.disabled = true; btn.textContent = '実行中…'; }
    try {
      var r = await fetch('/api/recovery/resume', { method: 'POST', headers: { 'x-sales-claw-session': DASHBOARD_SESSION_TOKEN }});
      var j = await r.json().catch(function () { return null; });
      if (j && j.ok) {
        hideRecoveryBanner();
        if (typeof showToast === 'function') showToast('続きから ' + j.requeued + ' 社を再キューしました', 'success');
        else alert('続きから ' + j.requeued + ' 社を再キューしました');
      } else {
        if (btn) { btn.disabled = false; btn.textContent = '続きから実行'; }
        alert('再開失敗: ' + ((j && j.error) || 'unknown'));
      }
    } catch (e) {
      if (btn) { btn.disabled = false; btn.textContent = '続きから実行'; }
      alert('再開失敗: ' + (e && e.message || e));
    }
  };
  window.discardRecovery = async function () {
    if (!confirm('中断バッチを破棄します。よろしいですか？')) return;
    try {
      await fetch('/api/recovery/discard', { method: 'POST', headers: { 'x-sales-claw-session': DASHBOARD_SESSION_TOKEN }});
    } catch (_) {}
    hideRecoveryBanner();
  };
  async function pollRecoveryStatus() {
    try {
      var r = await fetch('/api/recovery/status', { headers: { 'x-sales-claw-session': DASHBOARD_SESSION_TOKEN }});
      var j = await r.json().catch(function () { return null; });
      if (j && j.ok && j.hasSnapshot) showRecoveryBanner(j);
    } catch (_) { /* silent */ }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', pollRecoveryStatus);
  } else {
    pollRecoveryStatus();
  }
})();

// --- Cost summary chip (AI トークン概算) ---
(function () {
  function fmtJpy(n) { return '¥' + Number(n || 0).toLocaleString('ja-JP'); }
  async function pollCostSummary() {
    try {
      var r = await fetch('/api/cost/summary', { headers: { 'x-sales-claw-session': DASHBOARD_SESSION_TOKEN }});
      var j = await r.json().catch(function () { return null; });
      if (!j || !j.ok || !j.summary) return;
      var s = j.summary;
      // 1 社も処理されていない場合は表示しない
      if ((s.companiesProcessed || 0) === 0) return;
      var el = document.getElementById('costChip');
      if (!el) return;
      var t = document.getElementById('costToday');
      var m = document.getElementById('costMonth');
      var p = document.getElementById('costPerCompany');
      if (t) t.textContent = fmtJpy(s.today.estimatedJpy) + ' (' + s.today.companies + ' 社)';
      if (m) m.textContent = fmtJpy(s.thisMonth.estimatedJpy) + ' (' + s.thisMonth.companies + ' 社)';
      if (p) p.textContent = fmtJpy(s.avgJpyPerCompany);
      el.style.display = 'block';
    } catch (_) { /* silent */ }
  }
  // 初回 + 5 分おきに更新
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', pollCostSummary);
  } else {
    pollCostSummary();
  }
  setInterval(pollCostSummary, 5 * 60 * 1000);
})();
</script>

<script>
/* ========== List Builder v2 (lb2): redesigned tab UI ==========
   Mockup-faithful layout — chip-input criteria, 4-stage progress, result table,
   sidebar (insights / recommendations / chart / history). All colors come from
   dashboard CSS variables, so light/dark themes apply automatically. */
(function () {
  'use strict';
  if (window.__lb2Inited) return;
  window.__lb2Inited = true;
  function $(id) { return document.getElementById(id); }
  function $$(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }
  function on(el, ev, fn) { if (el) el.addEventListener(ev, fn); }
  function setHistoryModalOpen(open) {
    const modal = $('lb2HistoryModal');
    if (modal) modal.hidden = !open;
  }
  function closeHistoryModal() { setHistoryModalOpen(false); }
  function openHistoryModal() { setHistoryModalOpen(true); }
  function escHtml(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  let chipState = {};
  let currentRunId = null;
  let currentEventSource = null;
  let currentRecords = [];
  let currentFilter = { text: '', status: '' };
  let industryChart = null;

  // ---- Chip input behaviour ---------------------------------------------------
  $$('#tab-list-builder .lb2-chip-input').forEach(function (container) {
    const key = container.getAttribute('data-lb2-chip');
    chipState[key] = [];
    const input = container.querySelector('input');
    function render() {
      const chips = chipState[key].map((value, idx) =>
        '<span class="lb2-chip" data-lb2-chip-idx="' + idx + '">' +
        escHtml(value) +
        '<button type="button" class="lb2-chip-x" data-lb2-chip-remove="' + idx + '" aria-label="remove">×</button>' +
        '</span>'
      ).join('');
      // re-render chips before the input
      Array.from(container.querySelectorAll('.lb2-chip')).forEach(function (el) { el.remove(); });
      container.insertAdjacentHTML('afterbegin', chips);
    }
    function add(value) {
      const v = String(value || '').trim();
      if (!v) return;
      if (chipState[key].includes(v)) return;
      chipState[key].push(v);
      render();
    }
    on(input, 'keydown', function (ev) {
      if (ev.key === 'Enter' || ev.key === ',') {
        ev.preventDefault();
        add(input.value);
        input.value = '';
      } else if (ev.key === 'Backspace' && !input.value && chipState[key].length > 0) {
        chipState[key].pop();
        render();
      }
    });
    on(input, 'blur', function () {
      if (input.value.trim()) { add(input.value); input.value = ''; }
    });
    on(container, 'click', function (ev) {
      const btn = ev.target.closest('[data-lb2-chip-remove]');
      if (btn) {
        const idx = parseInt(btn.getAttribute('data-lb2-chip-remove'), 10);
        chipState[key].splice(idx, 1);
        render();
        return;
      }
      if (ev.target === container) input.focus();
    });
  });

  // ---- Compose query string from chips ---------------------------------------
  // LANG === 'ja' のときは日本語ラベル、それ以外は英語ラベルを使う。
  // CLI へ送る自然文クエリの体裁にだけ影響する (内部識別子は chipState 側 key)。
  function composeQuery() {
    const parts = [];
    const labels = LANG === 'ja' ? {
      industries: '業種', regions: '地域', employeeSize: '従業員規模', revenue: '売上規模',
      departments: '主な部署/担当者', keywords: 'キーワード', excludes: '除外条件', sources: '優先ソース',
    } : {
      industries: 'Industry', regions: 'Region', employeeSize: 'Employee size', revenue: 'Revenue',
      departments: 'Department/role', keywords: 'Keywords', excludes: 'Exclude', sources: 'Preferred sources',
    };
    Object.keys(labels).forEach(function (key) {
      const values = chipState[key];
      if (values && values.length) parts.push(labels[key] + ': ' + values.join(', '));
    });
    return parts.length ? parts.join(' / ') : '';
  }

  // ---- Stats / state visualisation -------------------------------------------
  // 上部のスタッツカードはユーザ要望で廃止したため、各 stat element を null-safe で更新する。
  function refreshStatsFromRecords(records) {
    const total = records.length;
    const high = records.filter(r => Number(r.fitScore) >= 70).length;
    const review = records.filter(r => r.dedupeDecision === 'needs_review' || r.collectionStatus === 'needs_review').length;
    const elTotal = $('lb2StatTotal'); if (elTotal) elTotal.textContent = total;
    const elHigh = $('lb2StatHigh'); if (elHigh) elHigh.textContent = high;
    const elReview = $('lb2StatReview'); if (elReview) elReview.textContent = review;
  }

  async function refreshStatsFromRuns() {
    try {
      const r = await fetch('/api/list-builder/runs').then(x => x.json()).catch(() => null);
      if (r && Array.isArray(r.runs)) {
        const elSaved = $('lb2StatSaved'); if (elSaved) elSaved.textContent = r.runs.length;
        renderHistory(r.runs.slice(0, 8));
        renderHistoryModalTable(r.runs);
      }
    } catch (_) {}
  }

  function fmtRunTime(run) {
    const ts = run.startedAt ? new Date(run.startedAt) : null;
    if (!ts) return '-';
    return (ts.getMonth() + 1) + '/' + ts.getDate() + ' ' +
      String(ts.getHours()).padStart(2, '0') + ':' + String(ts.getMinutes()).padStart(2, '0');
  }
  function fmtElapsed(run) {
    if (!run.startedAt || !run.completedAt) return '-';
    const ms = new Date(run.completedAt) - new Date(run.startedAt);
    if (ms < 1000) return '< 1s';
    if (ms < 60000) return Math.round(ms / 1000) + 's';
    return Math.round(ms / 60000) + 'm ' + Math.round((ms % 60000) / 1000) + 's';
  }
  function statusPillHtml(status) {
    const cls = status === 'completed' ? 'lb2-hs-ok'
      : status === 'failed' ? 'lb2-hs-fail'
      : status === 'running' || status === 'queued' ? 'lb2-hs-run'
      : status === 'cancelled' ? 'lb2-hs-cancel'
      : status === 'partial' ? 'lb2-hs-warn' : 'lb2-hs-other';
    const labelsJa = { completed: '完了', failed: '失敗', running: '実行中', queued: '待機', cancelled: '中止', partial: '一部' };
    const labelsEn = { completed: 'Done', failed: 'Failed', running: 'Running', queued: 'Queued', cancelled: 'Cancelled', partial: 'Partial' };
    const dict = LANG === 'ja' ? labelsJa : labelsEn;
    const label = dict[status] || status;
    return '<span class="lb2-history-status ' + cls + '">' + escHtml(label) + '</span>';
  }

  function renderHistory(runs) {
    const list = $('lb2HistoryList');
    if (!list) return;
    if (!runs || runs.length === 0) {
      const emptyMsg = (typeof I18N !== 'undefined' && I18N['lb.side.history.empty']) || (LANG === 'ja' ? '履歴はまだありません' : 'No runs yet');
      list.innerHTML = '<li class="lb2-history-empty">' + escHtml(emptyMsg) + '</li>';
      return;
    }
    const countLabel = LANG === 'ja' ? ' 社' : '';
    const delTitle = LANG === 'ja' ? '削除' : 'Delete';
    list.innerHTML = runs.map(function (run) {
      const cnt = run.totalCandidates != null ? run.totalCandidates : (run.newCount || 0);
      return '<li class="lb2-history-item" data-lb2-run="' + escHtml(run.runId) + '">' +
        '<div class="lb2-history-row1">' +
          '<div class="lb2-history-time">' + escHtml(fmtRunTime(run)) + '</div>' +
          statusPillHtml(run.status) +
          '<div class="lb2-history-count">' + cnt + countLabel + '</div>' +
          '<button class="lb2-history-del" type="button" data-lb2-del="' + escHtml(run.runId) + '" title="' + escHtml(delTitle) + '"><span class="material-symbols-outlined">delete</span></button>' +
        '</div>' +
        '</li>';
    }).join('');
    list.querySelectorAll('[data-lb2-run]').forEach(function (el) {
      on(el, 'click', function (ev) {
        if (ev.target.closest('[data-lb2-del]')) return;
        loadRun(el.getAttribute('data-lb2-run'));
      });
    });
    list.querySelectorAll('[data-lb2-del]').forEach(function (btn) {
      on(btn, 'click', async function (ev) {
        ev.stopPropagation();
        const id = btn.getAttribute('data-lb2-del');
        const confirmMsg = LANG === 'ja' ? 'この履歴を削除しますか？' : 'Delete this run?';
        if (!confirm(confirmMsg)) return;
        await fetch('/api/list-builder/runs/' + encodeURIComponent(id), { method: 'DELETE' }).catch(() => {});
        refreshStatsFromRuns();
      });
    });
  }

  function renderHistoryModalTable(runs) {
    const tbody = $('lb2HistoryTableBody');
    const empty = $('lb2HistoryTableEmpty');
    if (!tbody) return;
    if (!runs || runs.length === 0) {
      tbody.innerHTML = '';
      if (empty) empty.hidden = false;
      return;
    }
    if (empty) empty.hidden = true;
    const viewLabel = LANG === 'ja' ? '表示' : 'View';
    tbody.innerHTML = runs.map(function (run) {
      const cnt = run.totalCandidates != null ? run.totalCandidates : 0;
      return '<tr data-lb2-run="' + escHtml(run.runId) + '">' +
        '<td class="lb2-h-time">' + escHtml(fmtRunTime(run)) + '</td>' +
        '<td>' + statusPillHtml(run.status) + '</td>' +
        '<td>' + escHtml(run.mode || '-') + '</td>' +
        '<td>' + cnt + '</td>' +
        '<td>' + (run.newCount || 0) + '</td>' +
        '<td>' + (run.duplicateCount || 0) + '</td>' +
        '<td>' + (run.needsReviewCount || 0) + '</td>' +
        '<td>' + escHtml(fmtElapsed(run)) + '</td>' +
        '<td class="lb2-h-actions">' +
          '<button class="lb2-row-action" type="button" data-lb2-load="' + escHtml(run.runId) + '"><span class="material-symbols-outlined">visibility</span>' + escHtml(viewLabel) + '</button>' +
          '<button class="lb2-row-action lb2-row-action-danger" type="button" data-lb2-del-modal="' + escHtml(run.runId) + '"><span class="material-symbols-outlined">delete</span></button>' +
        '</td>' +
      '</tr>';
    }).join('');
    tbody.querySelectorAll('[data-lb2-load]').forEach(function (b) {
      on(b, 'click', function () {
        loadRun(b.getAttribute('data-lb2-load'));
        closeHistoryModal();
      });
    });
    tbody.querySelectorAll('[data-lb2-del-modal]').forEach(function (b) {
      on(b, 'click', async function () {
        const id = b.getAttribute('data-lb2-del-modal');
        const confirmMsg = LANG === 'ja' ? 'この履歴を削除しますか？' : 'Delete this run?';
        if (!confirm(confirmMsg)) return;
        await fetch('/api/list-builder/runs/' + encodeURIComponent(id), { method: 'DELETE' }).catch(() => {});
        refreshStatsFromRuns();
      });
    });
  }

  on($('lb2HistoryAllBtn'), 'click', function () {
    refreshStatsFromRuns();
    openHistoryModal();
  });
  on($('lb2HistoryModalClose'), 'click', closeHistoryModal);
  on($('lb2HistoryModal'), 'click', function (ev) {
    if (ev.target === ev.currentTarget) closeHistoryModal();
  });
  on(document, 'keydown', function (ev) {
    if (ev.key === 'Escape') closeHistoryModal();
  });

  // ---- 営業 NG モーダル -----------------------------------------------------
  // /api/data から「skipped」の企業を抽出し、details に営業/採用/IR/サポート 系の
  // 文言が入っているもの (= 営業お断り判定で skip された) を一覧表示する。
  async function refreshNgList() {
    try {
      const data = await fetch('/api/data').then(r => r.json()).catch(() => null);
      if (!data || !Array.isArray(data.companies)) return [];
      const ngPattern = /営業|採用専用|採用のみ|IR専用|サポート専用|お断り|お問い合わせはご遠慮/i;
      const ngCompanies = data.companies
        .filter(c => c.action === 'skipped' && ngPattern.test(String(c.details || '')))
        .map(c => ({
          companyNo: c.companyNo,
          companyName: c.companyName,
          details: c.details,
          actionedAt: c.actionedAt || c.timestamp || '',
        }));
      // Update badge count
      const badge = $('lb2NgBadge');
      if (badge) {
        if (ngCompanies.length > 0) {
          badge.textContent = ngCompanies.length;
          badge.hidden = false;
        } else {
          badge.hidden = true;
        }
      }
      return ngCompanies;
    } catch (_) { return []; }
  }
  function renderNgList(companies) {
    const tbody = $('lb2NgTableBody');
    const empty = $('lb2NgTableEmpty');
    if (!tbody) return;
    if (!companies || companies.length === 0) {
      tbody.innerHTML = '';
      if (empty) empty.hidden = false;
      return;
    }
    if (empty) empty.hidden = true;
    tbody.innerHTML = companies.map(function (c) {
      const ts = c.actionedAt ? new Date(c.actionedAt) : null;
      const tsLabel = ts ? (ts.getMonth() + 1) + '/' + ts.getDate() : '-';
      return '<tr>' +
        '<td class="lb2-h-time">' + escHtml(tsLabel) + '</td>' +
        '<td><div class="lb2-cell-name">' + escHtml(c.companyName || ('No.' + c.companyNo)) + '</div></td>' +
        '<td>' + escHtml(String(c.details || '').slice(0, 200)) + '</td>' +
      '</tr>';
    }).join('');
  }
  on($('lb2NgViewBtn'), 'click', async function () {
    const list = await refreshNgList();
    renderNgList(list);
    $('lb2NgModal').hidden = false;
  });
  on($('lb2NgModalClose'), 'click', function () { $('lb2NgModal').hidden = true; });
  on($('lb2NgModal'), 'click', function (ev) {
    if (ev.target.id === 'lb2NgModal') $('lb2NgModal').hidden = true;
  });
  // 起動時に NG 件数バッジを更新
  refreshNgList();

  // ---- Industry mix chart -----------------------------------------------------
  function renderIndustryChart(records) {
    const empty = $('lb2ChartEmpty');
    const canvas = $('lb2IndustryChart');
    if (!canvas) return;
    if (!records || records.length === 0) {
      if (empty) empty.style.display = 'block';
      if (industryChart) { industryChart.destroy(); industryChart = null; }
      return;
    }
    if (empty) empty.style.display = 'none';
    const unknownLabel = LANG === 'ja' ? '不明' : 'Unknown';
    const othersLabel = LANG === 'ja' ? 'その他' : 'Others';
    const counts = {};
    records.forEach(function (r) {
      const key = (r.industry || unknownLabel).trim() || unknownLabel;
      counts[key] = (counts[key] || 0) + 1;
    });
    const sorted = Object.entries(counts).sort(function (a, b) { return b[1] - a[1]; });
    const top = sorted.slice(0, 5);
    const others = sorted.slice(5).reduce(function (sum, e) { return sum + e[1]; }, 0);
    const labels = top.map(function (e) { return e[0]; });
    const data = top.map(function (e) { return e[1]; });
    if (others > 0) { labels.push(othersLabel); data.push(others); }
    const colors = ['#2563eb', '#10b981', '#f59e0b', '#8b5cf6', '#ef4444', '#94a3b8'];
    if (typeof window.Chart === 'undefined') return;
    if (industryChart) industryChart.destroy();
    industryChart = new window.Chart(canvas.getContext('2d'), {
      type: 'doughnut',
      data: { labels: labels, datasets: [{ data: data, backgroundColor: colors, borderWidth: 0 }] },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom', labels: { color: getComputedStyle(document.documentElement).getPropertyValue('--text-2') || '#5a5a58', font: { size: 11 } } },
        },
        cutout: '64%',
      },
    });
  }

  // ---- AI suggestions ---------------------------------------------------------
  function renderSuggestions(records) {
    const list = $('lb2SuggestList');
    if (!list) return;
    const items = [];
    if (records.length === 0) {
      const emptyMsg = (typeof I18N !== 'undefined' && I18N['lb.side.suggest.empty'])
        || (LANG === 'ja'
          ? '条件を入力して「AI で候補企業を生成」を押すと、ここに分析結果が表示されます。'
          : 'Enter criteria and click "Generate with AI" to see insights here.');
      items.push(emptyMsg);
    } else {
      const total = records.length;
      const high = records.filter(r => Number(r.fitScore) >= 70).length;
      if (high > 0) {
        items.push(LANG === 'ja'
          ? '高スコア企業が <strong>' + high + ' 社</strong> 検出されました (fitScore 70+)。'
          : '<strong>' + high + '</strong> high-fit companies detected (fitScore 70+).');
      }
      const dups = records.filter(r => r.dedupeDecision === 'duplicate' || r.dedupeDecision === 'suppressed').length;
      if (dups > 0) {
        items.push(LANG === 'ja'
          ? '既存リストとの重複/除外: ' + dups + ' 社。要確認の場合は「フィルター」で確認できます。'
          : 'Duplicates/excluded vs existing list: ' + dups + '. Use the filter to review.');
      }
      const unknownLabel = LANG === 'ja' ? '不明' : 'Unknown';
      const inds = {};
      records.forEach(function (r) { const k = (r.industry || unknownLabel); inds[k] = (inds[k] || 0) + 1; });
      const topInd = Object.entries(inds).sort(function (a, b) { return b[1] - a[1]; })[0];
      if (topInd && topInd[1] > 1) {
        items.push(LANG === 'ja'
          ? topInd[0] + ' 業種が最も多く (' + topInd[1] + ' 社) ヒットしています。'
          : 'Top industry: ' + topInd[0] + ' (' + topInd[1] + ' hits).');
      }
      const prefs = {};
      records.forEach(function (r) { if (r.prefecture) prefs[r.prefecture] = (prefs[r.prefecture] || 0) + 1; });
      const topPref = Object.entries(prefs).sort(function (a, b) { return b[1] - a[1]; })[0];
      if (topPref && topPref[1] > 1) {
        items.push(LANG === 'ja'
          ? topPref[0] + ' に候補が集中しています (' + topPref[1] + ' 社)。'
          : 'Concentrated in ' + topPref[0] + ' (' + topPref[1] + ' candidates).');
      }
      if (items.length === 0) {
        items.push(LANG === 'ja'
          ? total + ' 社の候補が取得されました。'
          : total + ' candidates retrieved.');
      }
    }
    list.innerHTML = items.map(function (txt) {
      return '<li class="lb2-suggest-item"><span class="material-symbols-outlined">trending_up</span><span>' + txt + '</span></li>';
    }).join('');

    // recommended action enable state
    const has = records.length > 0;
    ['lb2ActionAddTopBtn', 'lb2ActionReanalyzeBtn', 'lb2ActionDraftBtn'].forEach(function (id) {
      const b = $(id); if (b) b.disabled = !has;
    });
  }

  // ---- Result table -----------------------------------------------------------
  function renderResults() {
    const card = $('lb2Result');
    const tbody = $('lb2ResultBody');
    const empty = $('lb2ResultEmpty');
    const tableWrap = card ? card.querySelector('.lb2-result-table-wrap') : null;
    const summary = $('lb2ResultSummary');
    if (!card || !tbody) return;

    const newCount = currentRecords.filter(r => r.dedupeDecision === 'unique').length;
    const dupCount = currentRecords.filter(r => r.dedupeDecision === 'duplicate' || r.dedupeDecision === 'suppressed').length;
    const reviewCount = currentRecords.filter(r => r.dedupeDecision === 'needs_review').length;
    if (summary) {
      const sumNew = LANG === 'ja' ? '新規' : 'New';
      const sumReview = LANG === 'ja' ? '要確認' : 'Review';
      const sumDup = LANG === 'ja' ? '重複/除外' : 'Dup/Excl';
      summary.innerHTML =
        '<span class="lb2-summary-pill lb2-summary-new">' + sumNew + ' ' + newCount + '</span>' +
        '<span class="lb2-summary-pill lb2-summary-review">' + sumReview + ' ' + reviewCount + '</span>' +
        '<span class="lb2-summary-pill lb2-summary-dup">' + sumDup + ' ' + dupCount + '</span>';
    }

    if (currentRecords.length === 0) {
      tbody.innerHTML = '';
      if (empty) empty.hidden = false;
      if (tableWrap) tableWrap.hidden = true;
      const commit = $('lb2CommitBtn'); if (commit) commit.disabled = true;
      return;
    }
    if (empty) empty.hidden = true;
    if (tableWrap) tableWrap.hidden = false;

    const filtered = currentRecords.filter(function (r) {
      const text = currentFilter.text.toLowerCase();
      if (text) {
        const hay = ((r.companyName || '') + ' ' + (r.industry || '') + ' ' + (r.prefecture || '')).toLowerCase();
        if (hay.indexOf(text) === -1) return false;
      }
      if (currentFilter.status && r.dedupeDecision !== currentFilter.status) return false;
      return true;
    });

    const statusDictJa = { unique: '新規', duplicate: '重複', needs_review: '要確認', suppressed: '除外' };
    const statusDictEn = { unique: 'New', duplicate: 'Duplicate', needs_review: 'Review', suppressed: 'Excluded' };
    const statusDict = LANG === 'ja' ? statusDictJa : statusDictEn;
    const moreTitle = LANG === 'ja' ? 'その他' : 'More';
    const detailLabel = LANG === 'ja' ? '詳細' : 'Detail';
    const empUnit = LANG === 'ja' ? '名' : '';
    tbody.innerHTML = filtered.map(function (rec) {
      const decision = rec.dedupeDecision || 'unique';
      const rowCls = decision === 'duplicate' || decision === 'suppressed' ? 'lb2-row-dup'
        : decision === 'needs_review' ? 'lb2-row-review' : '';
      const statusLabel = statusDict[decision] || decision;
      const statusCls = decision === 'unique' ? 'lb2-status-new' : decision === 'duplicate' ? 'lb2-status-dup'
        : decision === 'needs_review' ? 'lb2-status-review' : 'lb2-status-suppressed';
      const canSelect = decision === 'unique' || decision === 'needs_review';
      const checked = decision === 'unique';
      const score = Number(rec.fitScore) || 0;
      const scoreColor = score >= 80 ? 'var(--success)' : score >= 60 ? 'var(--info)' : 'var(--text-3)';
      const dash = (score / 100) * 100;
      const realIdx = currentRecords.indexOf(rec);
      const urlDisplay = rec.url ? rec.url.replace(/^https?:\\/\\//, '').replace(/\\/$/, '') : '';
      const urlCell = rec.url
        ? '<a class="lb2-cell-link" href="' + escHtml(rec.url) + '" target="_blank" rel="noopener">' + escHtml(urlDisplay) + ' <span class="material-symbols-outlined" style="font-size:13px">open_in_new</span></a>'
        : '-';
      const fitDonut = '<div class="lb2-fit-donut" style="--fit-color:' + scoreColor + ';--fit-dash:' + dash + '">'
        + '<svg viewBox="0 0 36 36" aria-hidden="true">'
        +   '<circle class="lb2-fit-track" cx="18" cy="18" r="15.9155"/>'
        +   '<circle class="lb2-fit-fill" cx="18" cy="18" r="15.9155" stroke-dasharray="' + dash + ' 100"/>'
        + '</svg>'
        + '<span class="lb2-fit-num">' + (score || '-') + (score ? '%' : '') + '</span>'
        + '</div>';
      return '<tr class="' + rowCls + '">' +
        '<td><input type="checkbox" data-lb2-idx="' + realIdx + '" ' + (canSelect ? '' : 'disabled') + ' ' + (checked ? 'checked' : '') + '></td>' +
        '<td><div class="lb2-cell-name">' + escHtml(rec.companyName || '-') + '</div>' +
          (rec.notes ? '<div class="lb2-cell-note">' + escHtml(rec.notes) + '</div>' : '') + '</td>' +
        '<td>' + urlCell + '</td>' +
        '<td>' + escHtml(rec.industry || '-') + '</td>' +
        '<td>' + escHtml(rec.prefecture || '-') + '</td>' +
        '<td>' + (rec.employeeCount != null ? rec.employeeCount + empUnit : ('0' + empUnit)) + '</td>' +
        '<td>' + fitDonut + '</td>' +
        '<td><span class="lb2-status-pill ' + statusCls + '">' + statusLabel + '</span></td>' +
        '<td class="lb2-action-cell">' +
          '<button class="lb2-row-action" data-lb2-detail="' + realIdx + '" type="button"><span class="material-symbols-outlined">info</span>' + detailLabel + '</button>' +
          '<button class="lb2-row-more" data-lb2-more="' + realIdx + '" type="button" title="' + escHtml(moreTitle) + '"><span class="material-symbols-outlined">more_vert</span></button>' +
        '</td>' +
      '</tr>';
    }).join('');

    const commit = $('lb2CommitBtn');
    if (commit) commit.disabled = newCount + reviewCount === 0;

    const allCheckbox = $('lb2SelectAll');
    if (allCheckbox) {
      allCheckbox.onchange = function () {
        $$('#lb2ResultBody input[data-lb2-idx]:not([disabled])').forEach(function (cb) { cb.checked = allCheckbox.checked; });
      };
    }
    $$('#lb2ResultBody [data-lb2-detail]').forEach(function (b) {
      on(b, 'click', function () {
        const i = parseInt(b.getAttribute('data-lb2-detail'), 10);
        const r = currentRecords[i];
        if (!r) return;
        const lbl = LANG === 'ja' ? {
          company: '会社名', url: 'URL', form: 'フォーム', industry: '業種', region: '地域',
          employees: '従業員', fit: 'AI 適合度', status: 'ステータス', notes: 'メモ', reasons: '適合理由',
        } : {
          company: 'Company', url: 'URL', form: 'Form', industry: 'Industry', region: 'Region',
          employees: 'Employees', fit: 'AI fit', status: 'Status', notes: 'Notes', reasons: 'Reasons',
        };
        const lines = [];
        lines.push(lbl.company + ': ' + (r.companyName || '-'));
        lines.push(lbl.url + ': ' + (r.url || '-'));
        lines.push(lbl.form + ': ' + (r.formUrl || '-'));
        lines.push(lbl.industry + ': ' + (r.industry || '-'));
        lines.push(lbl.region + ': ' + (r.prefecture || '-'));
        lines.push(lbl.employees + ': ' + (r.employeeCount != null ? r.employeeCount : '-'));
        lines.push(lbl.fit + ': ' + (r.fitScore != null ? r.fitScore : '-'));
        lines.push(lbl.status + ': ' + (r.dedupeDecision || '-'));
        if (r.notes) lines.push(lbl.notes + ': ' + r.notes);
        if (r.fitReasons && r.fitReasons.length) lines.push(lbl.reasons + ': ' + r.fitReasons.join(', '));
        alert(lines.join('\\n'));
      });
    });
  }

  // ---- Progress UI ------------------------------------------------------------
  const STAGE_ORDER = ['discovery', 'qualification', 'dedupe', 'preview_ready'];
  const STAGE_LABELS = LANG === 'ja' ? {
    discovery: '情報収集', extracting: '情報収集', identity_resolution: '情報収集',
    enrichment: '情報補完', official_verification: '情報補完', streaming: 'AI 応答受信中',
    qualification: 'スコアリング', compliance_precheck: 'スコアリング',
    dedupe: '重複除外', preview_ready: 'リスト化',
  } : {
    discovery: 'Discovery', extracting: 'Discovery', identity_resolution: 'Discovery',
    enrichment: 'Enrichment', official_verification: 'Enrichment', streaming: 'Receiving AI response',
    qualification: 'Scoring', compliance_precheck: 'Scoring',
    dedupe: 'Dedupe', preview_ready: 'Listing',
  };
  function setStage(stageKey, percent) {
    const stages = $$('#tab-list-builder [data-lb2-stage]');
    if (stages.length === 0) return;
    let stageIdx = STAGE_ORDER.indexOf(stageKey);
    if (stageIdx < 0) {
      // map intermediate stages
      if (stageKey === 'extracting' || stageKey === 'identity_resolution' || stageKey === 'enrichment' || stageKey === 'streaming') stageIdx = 0;
      else if (stageKey === 'qualification' || stageKey === 'compliance_precheck') stageIdx = 1;
      else if (stageKey === 'dedupe') stageIdx = 2;
      else if (stageKey === 'preview_ready') stageIdx = 3;
      else stageIdx = 0;
    }
    stages.forEach(function (el, i) {
      el.classList.remove('lb2-stage-active', 'lb2-stage-done');
      if (i < stageIdx) el.classList.add('lb2-stage-done');
      else if (i === stageIdx) el.classList.add('lb2-stage-active');
    });
    if (percent != null) {
      const fill = $('lb2ProgressFill');
      if (fill) fill.style.width = Math.max(0, Math.min(100, percent)) + '%';
      $('lb2ProgressPercent').textContent = Math.round(percent) + '%';
    }
  }
  function showProgress(message) {
    const card = $('lb2Progress');
    if (card) card.hidden = false;
    if (message != null) $('lb2ProgressMessage').textContent = message;
  }
  function hideProgress() {
    const card = $('lb2Progress');
    if (card) card.hidden = true;
  }

  // ---- SSE subscription -------------------------------------------------------
  function subscribeStream(runId) {
    if (currentEventSource) { try { currentEventSource.close(); } catch (_) {} }
    let url = '/api/list-builder/stream/' + encodeURIComponent(runId);
    if (typeof DASHBOARD_SESSION_TOKEN !== 'undefined' && DASHBOARD_SESSION_TOKEN) {
      url += '?session=' + encodeURIComponent(DASHBOARD_SESSION_TOKEN);
    }
    currentEventSource = new EventSource(url);
    currentEventSource.addEventListener('progress', function (ev) {
      try {
        const data = JSON.parse(ev.data);
        const fallbackInProgress = LANG === 'ja' ? '進行中' : 'In progress';
        const label = STAGE_LABELS[data.stage] || data.stage || fallbackInProgress;
        const pct = (data.completed && data.total) ? (data.completed / data.total * 100)
          : data.stage === 'streaming' ? 35
          : data.stage === 'discovery' ? 25
          : data.stage === 'qualification' ? 60
          : data.stage === 'dedupe' ? 80
          : data.stage === 'preview_ready' ? 95 : null;
        const runningSuffix = LANG === 'ja' ? ' を実行中…' : ' running…';
        showProgress(data.message || (data.current && data.current.companyName) || label + runningSuffix);
        setStage(data.stage, pct);
      } catch (_) {}
    });
    currentEventSource.addEventListener('done', function () {
      setStage('preview_ready', 100);
      showProgress(LANG === 'ja' ? '完了。結果を読み込んでいます…' : 'Done. Loading results…');
      fetch('/api/list-builder/runs/' + encodeURIComponent(runId)).then(x => x.json()).then(function (data) {
        const records = (data && data.run && data.run.candidates) || data.candidates || [];
        currentRecords = records;
        renderResults();
        refreshStatsFromRecords(records);
        renderIndustryChart(records);
        renderSuggestions(records);
        setTimeout(hideProgress, 700);
        refreshStatsFromRuns();
      }).catch(function () { setTimeout(hideProgress, 700); });
      try { currentEventSource.close(); } catch (_) {}
      currentEventSource = null;
    });
    currentEventSource.addEventListener('error', function (ev) {
      let msg = LANG === 'ja' ? '通信エラー' : 'Connection error';
      try { const d = JSON.parse(ev.data || '{}'); if (d && d.error) msg = d.error; } catch (_) {}
      showProgress((LANG === 'ja' ? 'エラー: ' : 'Error: ') + msg);
      const fill = $('lb2ProgressFill');
      if (fill) fill.style.background = 'linear-gradient(90deg, var(--error) 0%, #fca5a5 100%)';
    });
  }

  function loadRun(runId) {
    if (!runId) return;
    fetch('/api/list-builder/runs/' + encodeURIComponent(runId)).then(x => x.json()).then(function (data) {
      const records = (data && data.run && data.run.candidates) || data.candidates || [];
      currentRunId = runId;
      currentRecords = records;
      renderResults();
      refreshStatsFromRecords(records);
      renderIndustryChart(records);
      renderSuggestions(records);
      hideProgress();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }

  // ---- Mode switch (AI / URL / Category) ----------------------------------------
  let currentMode = 'ai';
  function setMode(mode) {
    if (!['ai', 'url', 'category'].includes(mode)) mode = 'ai';
    currentMode = mode;
    $$('#tab-list-builder .lb2-mode-pill').forEach(function (p) {
      const isActive = p.getAttribute('data-lb2-mode') === mode;
      p.classList.toggle('active', isActive);
      p.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });
    $$('#tab-list-builder .lb2-mode-panel').forEach(function (panel) {
      panel.hidden = panel.getAttribute('data-lb2-panel') !== mode;
    });
    // criteria 表示制御 (URL モード時は隠す)
    const grid = $('lb2CriteriaGrid');
    const head = $('lb2CriteriaHead');
    const showCriteria = mode === 'ai' || mode === 'category';
    if (grid) grid.style.display = showCriteria ? 'grid' : 'none';
    if (head) head.style.display = showCriteria ? 'flex' : 'none';
    // CLI selector は AI モードのみ
    const provField = $('lb2ProviderField');
    if (provField) provField.style.display = mode === 'ai' ? 'flex' : 'none';
    // ヒント文言の切替
    const hint = $('lb2CriteriaHint');
    if (hint) {
      if (LANG === 'ja') {
        hint.textContent = mode === 'ai' ? '空欄の項目は AI が判断します'
          : mode === 'category' ? 'API キー設定タブで登録した法人番号API/gBizINFO で検索します'
          : '';
      } else {
        hint.textContent = mode === 'ai' ? 'Blank fields are decided by AI'
          : mode === 'category' ? 'Searches via Houjin-Bangou / gBizINFO using API keys from Settings (JP only)'
          : '';
      }
    }
    // ボタンラベル切替
    const lbl = $('lb2RunBtnLabel');
    const ico = $('lb2RunBtnIcon');
    if (mode === 'url') {
      if (lbl) lbl.textContent = LANG === 'ja' ? 'URL をスキャン開始' : 'Start URL scan';
      if (ico) ico.textContent = 'play_arrow';
    } else if (mode === 'category') {
      if (lbl) lbl.textContent = LANG === 'ja' ? '公式 API で検索' : 'Search official APIs';
      if (ico) ico.textContent = 'search';
    } else {
      if (lbl) lbl.textContent = LANG === 'ja' ? 'AI で候補企業を生成' : 'Generate with AI';
      if (ico) ico.textContent = 'auto_awesome';
    }
  }
  $$('#tab-list-builder .lb2-mode-pill').forEach(function (pill) {
    on(pill, 'click', function () { setMode(pill.getAttribute('data-lb2-mode')); });
  });

  // ---- Run button (mode-aware) -------------------------------------------------
  on($('lb2RunBtn'), 'click', async function () {
    const limit = parseInt($('lb2Limit').value, 10) || 30;
    const fill = $('lb2ProgressFill');
    if (fill) fill.style.background = '';

    const errPrefix = LANG === 'ja' ? 'エラー: ' : 'Error: ';

    if (currentMode === 'url') {
      const raw = ($('lb2UrlInput') ? $('lb2UrlInput').value : '').trim();
      const urls = raw.split(/[\\n,]/).map(function (s) { return s.trim(); }).filter(Boolean);
      if (urls.length === 0) { alert(LANG === 'ja' ? 'URL を入力してください' : 'Please enter a URL'); return; }
      const maxPages = parseInt($('lb2UrlMaxPages').value, 10) || 10;
      const maxCompanies = parseInt($('lb2UrlMaxCompanies').value, 10) || 100;
      showProgress(LANG === 'ja' ? 'URL スキャン開始中…' : 'Starting URL scan…');
      setStage('discovery', 5);
      try {
        const resp = await fetch('/api/list-builder/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: 'url', payload: { urls: urls, maxPages: maxPages, maxCompanies: maxCompanies } }),
        });
        const data = await resp.json();
        if (!data.ok) { showProgress(errPrefix + (data.error || 'unknown')); return; }
        currentRunId = data.runId;
        subscribeStream(currentRunId);
      } catch (e) { showProgress(errPrefix + e.message); }
      return;
    }

    if (currentMode === 'category') {
      // chip-input から CategorySearchParams 形式に変換
      const params = {
        industries: chipState.industries || [],
        prefectures: chipState.regions || [],
        keywords: chipState.keywords || [],
        employeeRanges: chipState.employeeSize || [],
        revenueRanges: chipState.revenue || [],
        growthTrend: 'any',
        unknownFieldPolicy: 'standard',
        limit: limit,
      };
      if (params.industries.length === 0 && params.prefectures.length === 0 && params.keywords.length === 0) {
        alert(LANG === 'ja'
          ? '業種・地域・キーワードのいずれかを 1 つ以上入力してください'
          : 'Please enter at least one industry, region, or keyword.');
        return;
      }
      showProgress(LANG === 'ja' ? '公式 API で検索中…' : 'Searching official APIs…');
      setStage('discovery', 8);
      try {
        const resp = await fetch('/api/list-builder/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: 'category', payload: params }),
        });
        const data = await resp.json();
        if (!data.ok) { showProgress(errPrefix + (data.error || 'unknown')); return; }
        currentRunId = data.runId;
        subscribeStream(currentRunId);
      } catch (e) { showProgress(errPrefix + e.message); }
      return;
    }

    // AI モード (cli-run)
    const query = composeQuery();
    if (!query) {
      const needsCriteria = LANG === 'ja'
        ? '業種・地域などの条件を 1 つ以上入力してください'
        : 'Please enter at least one criterion (industry, region, etc.)';
      if (typeof showToast === 'function') showToast(needsCriteria, 'info');
      else alert(needsCriteria);
      return;
    }
    const provider = $('lb2Provider').value || 'claude';
    showProgress(provider + (LANG === 'ja' ? ' CLI に依頼中…' : ' CLI: sending request…'));
    setStage('discovery', 8);
    try {
      const resp = await fetch('/api/list-builder/cli-run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: query, limit: limit, provider: provider }),
      });
      const data = await resp.json();
      if (!data.ok) {
        showProgress(errPrefix + (data.error || 'unknown'));
        return;
      }
      currentRunId = data.runId;
      subscribeStream(currentRunId);
    } catch (e) { showProgress(errPrefix + e.message); }
  });

  on($('lb2CancelBtn'), 'click', function () {
    if (!currentRunId) { hideProgress(); return; }
    fetch('/api/list-builder/runs/' + encodeURIComponent(currentRunId) + '/cancel', { method: 'POST' })
      .catch(function () {})
      .finally(function () {
        if (currentEventSource) { try { currentEventSource.close(); } catch (_) {} }
        hideProgress();
      });
  });

  on($('lb2FilterText'), 'input', function (ev) {
    currentFilter.text = ev.target.value || '';
    renderResults();
  });
  on($('lb2FilterStatus'), 'change', function (ev) {
    currentFilter.status = ev.target.value || '';
    renderResults();
  });

  on($('lb2ExportCsvBtn'), 'click', function () {
    if (!currentRunId) return;
    const url = '/api/list-builder/runs/' + encodeURIComponent(currentRunId) + '/export.csv' +
      (typeof DASHBOARD_SESSION_TOKEN !== 'undefined' && DASHBOARD_SESSION_TOKEN ? ('?session=' + encodeURIComponent(DASHBOARD_SESSION_TOKEN)) : '');
    window.open(url, '_blank');
  });

  on($('lb2CommitBtn'), 'click', async function () {
    if (!currentRunId || currentRecords.length === 0) return;
    const errPrefix = LANG === 'ja' ? 'エラー: ' : 'Error: ';
    const checked = $$('#lb2ResultBody input[data-lb2-idx]:checked');
    if (checked.length === 0) {
      alert(LANG === 'ja' ? '追加する企業を選択してください' : 'Please select companies to add');
      return;
    }
    const ids = checked.map(function (cb) {
      const i = parseInt(cb.getAttribute('data-lb2-idx'), 10);
      return currentRecords[i] && currentRecords[i].id;
    }).filter(Boolean);
    try {
      const resp = await fetch('/api/list-builder/commit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId: currentRunId, recordIds: ids }),
      });
      const data = await resp.json();
      if (data.ok) {
        const msg = LANG === 'ja'
          ? data.appended + ' 社をターゲットリストに追加しました'
          : 'Added ' + data.appended + ' companies to the target list';
        if (typeof showToast === 'function') showToast(msg, 'success'); else alert(msg);
        $('lb2Result').hidden = true;
        currentRecords = [];
        refreshStatsFromRuns();
      } else {
        alert(errPrefix + (data.error || 'unknown'));
      }
    } catch (e) { alert(errPrefix + e.message); }
  });

  on($('lb2ActionAddTopBtn'), 'click', function () {
    // 高スコアのチェックボックスをすべて ON にしてから commit を促す
    let toggled = 0;
    $$('#lb2ResultBody input[data-lb2-idx]:not([disabled])').forEach(function (cb) {
      const i = parseInt(cb.getAttribute('data-lb2-idx'), 10);
      const r = currentRecords[i];
      if (r && Number(r.fitScore) >= 70) { cb.checked = true; toggled++; }
    });
    if (toggled > 0) $('lb2CommitBtn').click();
  });

  // ---- Init -------------------------------------------------------------------
  refreshStatsFromRuns();
  renderSuggestions([]);
  renderIndustryChart([]);

  // タブ切替時の挙動:
  //   - list-builder タブを離れたら進捗/結果カード/履歴モーダルを閉じてリセット
  //     (バックグラウンドの SSE 自体は維持。完了時に状態を最新化する)
  //   - list-builder タブに戻ったら履歴を最新化
  document.addEventListener('click', function (ev) {
    const btn = ev.target.closest('.tab-btn[data-tab]');
    if (!btn) return;
    const target = btn.getAttribute('data-tab');
    if (target === 'list-builder') {
      refreshStatsFromRuns();
      return;
    }
    // 他タブへ切替 → list-builder の一時的なオーバーレイをしまう (結果カードは常時表示)
    const progress = $('lb2Progress'); if (progress) progress.hidden = true;
    closeHistoryModal();
  });
})();
</script>

</body>
</html>`;
}

// Settings API dispatcher (src/routes/settings-api.cjs に分離済み)
// lazy-init: 初回リクエストで factory を呼んで dispatcher を取得する。
// ctx に渡す関数群はすべて function 宣言で hoisting 済み。
let _settingsApiDispatch: any = null;
function getSettingsApiDispatch() {
  if (!_settingsApiDispatch) {
    _settingsApiDispatch = require('./routes/settings-api')({
      jsonResponse,
      parseJsonBody,
      notifyClients,
      refreshWatchTargets,
      openDirectoryPicker,
      toStoredProjectPath,
      loadData,
      purgeHistoryOnlyCompany,
      findRuntimeCompanyRecord,
      // v2.0.50: mutation API (create/update/delete/import) 完了直後にダッシュ
      //   ボードのインメモリキャッシュを即時無効化するため。
      //   旧仕様: fs watcher の debounce (500ms) を待ってから invalidate → その間
      //          GET /api/dashboard は古いキャッシュを返し、UI が「削除したのに残って
      //          いる」「送信したのに表示されない」と誤認する事象が報告されていた。
      invalidateDashboardDataCache,
    });
  }
  return _settingsApiDispatch;
}

// Simple API dispatcher (src/routes/simple-api.cjs)
// /api/cli-log, /api/check-update, /api/install-update, /api/update-status, /api/export, /api/data,
// /api/claude-status, /api/ai/status, /api/ai/setup-diagnostics, /api/ai-submit*
let _simpleApiDispatch: any = null;
function getSimpleApiDispatch() {
  if (!_simpleApiDispatch) {
    _simpleApiDispatch = require('./routes/simple-api')({
      jsonResponse,
      parseJsonBody,
      loadData,
      sseClients,
      probeClaudeStatus,
      probeAiSetupDiagnostics,
      getSelectedAiProvider,
      ensureParentDir,
      AUTO_UPDATE_ENABLED,
      APP_BUILD_SOURCE,
      APP_VERSION,
      getFormSessionManager: () => _formSessionManager,
    });
  }
  return _simpleApiDispatch;
}

// AI Runtime API dispatcher (src/routes/ai-runtime-api.cjs)
// /api/install-ai-cli, /api/launch-ai, /api/launch-ai-external, /api/stop-ai, /api/ai-input
let _aiRuntimeApiDispatch: any = null;
function getAiRuntimeApiDispatch() {
  if (!_aiRuntimeApiDispatch) {
    _aiRuntimeApiDispatch = require('./routes/ai-runtime-api')({
      jsonResponse,
      parseJsonBody,
      PROJECT_ROOT,
      normalizeProviderId,
      getSelectedAiProvider,
      getProvider,
      getProviderDisplayName,
      probeNpmStatus,
      probeClaudeStatus,
      installAiRuntime: localToolchain.installAiRuntime,
      getProviderInstallCommand: localToolchain.getProviderInstallCommand,
      localToolchain, // 進捗付きインストール用に全モジュールを渡す
      setProviderInstallState,
      invalidateAiStatusCache,
      clearAiExecutablePath: (providerId) => { _aiExecutablePath[providerId] = null; },
      startManagedAiSession,
      cancelManagedAiLaunch,
      launchClaudeInExternalTerminal,
      stopManagedClaudePty,
      stopHeadlessAiRun,
      getActiveHeadlessRun,
      getHeadlessAiRun: () => headlessAiRun,
      getManagedAiProvider,
      getClaudePty: () => claudePty,
      getClaudeProcess: () => claudeProcess,
      clearClaudeProcess: () => {
        if (claudeProcess && !claudeProcess.killed) {
          try { claudeProcess.kill(); } catch (_) {}
        }
        claudeProcess = null;
      },
      appendDiagnosticEvent,
    });
  }
  return _aiRuntimeApiDispatch;
}

// Form Session API dispatcher (src/routes/form-session-api.cjs)
// /api/form-session/* 全 10 エンドポイント
let _formSessionApiDispatch: any = null;
function getFormSessionApiDispatch() {
  if (!_formSessionApiDispatch) {
    _formSessionApiDispatch = require('./routes/form-session-api')({
      jsonResponse,
      parseJsonBody,
      getFormSessionManager: () => _formSessionManager,
      settings,
      getCompanyLogContext,
    });
  }
  return _formSessionApiDispatch;
}

// Approve API dispatcher (src/routes/approve-api.cjs)
// /api/approve (確認待ち → 送信済み / スキップ)
let _approveApiDispatch: any = null;
function getApproveApiDispatch() {
  if (!_approveApiDispatch) {
    _approveApiDispatch = require('./routes/approve-api')({
      getUiLang,
      i18nT,
      appendDiagnosticEvent,
      getCompanyLogContext,
      isAwaitingTransitionAllowed,
      findRuntimeCompanyRecord,
      getKnownFormUrl,
      ensureSubmittedContactHistory,
      stringifyLogDetails,
      getLatestLog,
      updateCompany,
      notifyClients,
      ensureParentDir,
      getFormSessionManager: () => _formSessionManager,
    });
  }
  return _approveApiDispatch;
}

// AI Form Fill API dispatcher (src/routes/ai-form-fill-api.cjs)
// /api/ai-form-fill (AI バッチキュー投入のメインエンドポイント)
let _aiFormFillApiDispatch: any = null;
function getAiFormFillApiDispatch() {
  if (!_aiFormFillApiDispatch) {
    _aiFormFillApiDispatch = require('./routes/ai-form-fill-api')({
      jsonResponse,
      parseJsonBody,
      normalizeProviderId,
      getSelectedAiProvider,
      getManagedAiProvider,
      isAiRuntimeActivelyProcessing,
      findCompaniesByNos,
      appendDiagnosticEvent,
      executeBackendPhaseABatch,
      ensureClaudeAutomationReady,
      queueAiFormFill,
      getManagedAiAutoSendSafe,
      getManagedAiReservedCompanyNos,
      cleanupStaleManagedAiMonitorEvents,
      getActiveHeadlessRun,
      getClaudePty: () => claudePty,
      getManagedAiBatchController: () => managedAiBatchController,
      setManagedAiBatchActive: (value) => {
        if (managedAiBatchController) managedAiBatchController.activeBatch = value;
      },
      // v2.0.16: pipeline 用に batch size を expose
      getManagedAiFormBatchSize,
      // v2.0.98: flush サイズ (= 並列度) の単一ノブ。formFill.parallelism を読む。
      getFormFillParallelism: () => settings.getFormFillParallelism(),
      // v2.0.10: PTY 死亡時に pending も自動ドレインできるよう exposure
      clearManagedAiBatchPending: () => {
        if (!managedAiBatchController) return 0;
        const cleared = managedAiBatchController.pending ? managedAiBatchController.pending.length : 0;
        managedAiBatchController.pending = [];
        managedAiBatchController.pendingSinceMs = 0;
        managedAiBatchController.queueStuckNotified = false;
        if (cleared > 0) {
          appendDiagnosticEvent('managed_ai_pending_drained', {
            provider: managedAiBatchController.providerId,
            clearedCount: cleared,
            reason: 'pty-dead-stale-queue',
          });
        }
        return cleared;
      },
      getManagedAiRecoveryTimer: () => managedAiRecoveryTimer,
    });
  }
  return _aiFormFillApiDispatch;
}

// Recovery API dispatcher (lazy)
let _recoveryApiDispatch: any = null;
function getRecoveryApiDispatch() {
  if (!_recoveryApiDispatch) {
    _recoveryApiDispatch = require('./routes/recovery-api')({
      jsonResponse,
      parseJsonBody,
      queueAiFormFill,
      appendDiagnosticEvent,
      ensureClaudeAutomationReady,
      findCompaniesByNos,
      logAction,
      getAllLogs,
    });
  }
  return _recoveryApiDispatch;
}

// AI Final Submit API dispatcher (P2: awaiting_approval → AI に submit させる)
let _aiSubmitFinalApiDispatch: any = null;
function getAiSubmitFinalApiDispatch() {
  if (!_aiSubmitFinalApiDispatch) {
    _aiSubmitFinalApiDispatch = require('./routes/ai-submit-final-api')({
      jsonResponse,
      parseJsonBody,
      findCompaniesByNos,
      getCompanyLogContext,
      getClaudePty: () => claudePty,
      queueManagedAiPrompt,
      getSelectedAiProvider,
      appendDiagnosticEvent,
      getKnownFormUrl,
      ensureManagedAiReadyForPrompt,
    });
  }
  return _aiSubmitFinalApiDispatch;
}

// Parallel form-fill API dispatcher (P1-4 並列化エンドポイント)
let _parallelFormFillApiDispatch: any = null;
function getParallelFormFillApiDispatch() {
  if (!_parallelFormFillApiDispatch) {
    _parallelFormFillApiDispatch = require('./routes/parallel-form-fill-api')({
      jsonResponse,
      parseJsonBody,
      findCompaniesByNos,
      executeBackendPhaseABatch,
      appendDiagnosticEvent,
      buildClaudeFormFillPrompt,
      writeWorkspaceClaudeFormFillPromptFile,
      buildHeadlessArgs,
      buildCliCommandSpec,
      resolveClaudeExecutable,
      buildManagedProviderEnv,
      createHeadlessAiLogFile,
      appendHeadlessAiLog,
      emitClaudeAutomationLog,
      getSender: settings.getSender,
      getProvider,
      normalizeProviderId,
      getSelectedAiProvider,
      isHeadlessAutomationProvider: isParallelDispatchProvider,
      getAutomationModeForProvider,
      hasCompanyTerminalLogSince: companyHasTerminalLogSince,
      markParallelCompaniesFailed,
      PROJECT_ROOT,
    });
  }
  return _parallelFormFillApiDispatch;
}

// Error Recovery API dispatcher (P1-3: lazy)
let _errorRecoveryApiDispatch: any = null;
function getErrorRecoveryApiDispatch() {
  if (!_errorRecoveryApiDispatch) {
    _errorRecoveryApiDispatch = require('./routes/error-recovery-api')({
      jsonResponse,
      parseJsonBody,
      loadData,
      queueAiFormFill,
      findCompaniesByNos,
      ensureClaudeAutomationReady,
      getSelectedAiProvider,
      getManagedAiProvider,
      getClaudePty: () => claudePty,
      getActiveHeadlessRun,
      getManagedAiAutoSendSafe,
      appendDiagnosticEvent,
    });
  }
  return _errorRecoveryApiDispatch;
}

// Onboarding wizard dispatcher (lazy)
let _onboardingApiDispatch: any = null;
function getOnboardingApiDispatch() {
  if (!_onboardingApiDispatch) {
    _onboardingApiDispatch = require('./routes/onboarding-api')({
      jsonResponse,
      parseJsonBody,
      settingsManager: settings,
      getDataPath: resolveDataPath,
      probeClaudeAuthStatus,
      importTargetList,
      readTargetList,
      refreshWatchTargets,
      notifyClients,
      appendDiagnosticEvent,
      getDashboardSessionToken: () => dashboardSessionToken || '',
    });
  }
  return _onboardingApiDispatch;
}

let _listBuilderApiDispatch: any = null;
function getListBuilderApiDispatch() {
  if (!_listBuilderApiDispatch) {
    _listBuilderApiDispatch = require('./routes/list-builder-api')({
      jsonResponse,
      parseJsonBody,
      appendCompany,
      readTargetList,
      getAllHistorySummary,
      getDashboardSessionToken: () => dashboardSessionToken || '',
      // CLI Agent モード用 ctx (cli-run エンドポイントから headless CLI を起動するため)
      cliAgentCtx: {
        projectRoot: PROJECT_ROOT,
        resolveExecutable: (providerId) => resolveClaudeExecutable(providerId),
        buildHeadlessArgs: (providerId, mode, opts) => buildHeadlessArgs(providerId, mode, opts),
        buildCliCommandSpec: (executable, args) => buildCliCommandSpec(executable, args),
        buildBaseEnv: (providerId) => buildManagedProviderEnv(providerId),
      },
    });
    // 起動時に古い list-builder run データを掃除（cacheTtlDays 設定値）
    try {
      const lbConfig = settings.getListBuilderConfig && settings.getListBuilderConfig();
      const ttl = (lbConfig && Number.isInteger(lbConfig.cacheTtlDays)) ? lbConfig.cacheTtlDays : 30;
      const runManager = require('./list-builder/run-manager');
      const r = runManager.cleanupOldRuns(ttl);
      if (r && r.removed > 0) {
        appendDiagnosticEvent('list_builder_cleanup', { removed: r.removed, ttlDays: ttl });
      }
    } catch (e) {
      // クリーンアップ失敗は致命的でない
      try { appendDiagnosticEvent('list_builder_cleanup_failed', { error: e.message }); } catch (_) {}
    }
  }
  return _listBuilderApiDispatch;
}

// settings.json に _onboardedAt があるかどうかで初回セットアップ判定。
// 互換性: _onboardedAt が無くても companyProfile が完全 かつ サンプル既定値で
// ない (≒ 既存ユーザーが手で設定済み) なら通過させる。
const SAMPLE_PROFILE_MARKERS = [
  'サンプル株式会社',
  'Sample Inc.',
  'sample@example.com',
  '担当者名',
];
function _looksLikeSampleProfile(profile) {
  if (!profile) return true;
  const blob = [profile.companyName, profile.companyNameEn, profile.email, profile.contactName].join('|');
  return SAMPLE_PROFILE_MARKERS.some((m: any) => blob.includes(m));
}
function isOnboardingComplete() {
  try {
    const all = settings.getAll() || {};
    if (all._onboardedAt && all.companyProfile && String(all.companyProfile.address || '').trim()) return true;
    if (!settings.isConfigured()) return false;
    if (!all.companyProfile || !String(all.companyProfile.address || '').trim()) return false;
    // 既存ユーザー保護: companyProfile が埋まっていて、かつサンプル既定値の
    // マーカー (= サンプルそのまま) を含まない場合は wizard をスキップする。
    return !_looksLikeSampleProfile(all.companyProfile);
  } catch (_) {
    return true; // フェイルセーフ: 検出失敗時は通常画面を出す
  }
}

// HTTP Server
const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url || '/', 'http://127.0.0.1');
  const pathname = requestUrl.pathname;

  if (demoMode.isBlockedInDemo(pathname, req.method)) {
    demoMode.sendDemoBlockedResponse(res, pathname);
    return;
  }

  if (pathname === '/events' || pathname.startsWith('/screenshots/') || pathname.startsWith('/api/') || pathname === '/list-builder') {
    // Internal CLI log endpoint: verify shared secret (X-CLI-Token header required)
    const isInternalCliLog = pathname === '/api/cli-log' && req.headers['x-cli-token'] === CLI_LOG_SECRET;
    // 1.2.91: /api/log-action は managed PTY 内 CLI からの curl 呼び出しを想定。
    // CLI には Origin/Referer がないため allowTokenWithoutOrigin でゲートを通す。
    // session token は SALES_CLAW_SESSION env で注入済み。
    const isLogAction = pathname === '/api/log-action';
    const auth = isInternalCliLog ? { ok: true } : isAuthorizedDashboardRequest(req, { allowTokenWithoutOrigin: isLogAction });
    if (!auth.ok) {
      if (pathname.startsWith('/api/approve') || pathname.startsWith('/api/install-claude-cli') || pathname.startsWith('/api/install-ai-cli')) {
        appendDiagnosticEvent('auth_rejected', {
          path: pathname,
          method: req.method,
          statusCode: auth.statusCode,
          error: auth.error,
        });
        console.warn(`[dashboard-auth] ${req.method} ${pathname} rejected: ${auth.error}`);
      }
      jsonResponse(res, auth.statusCode, { ok: false, error: auth.error }, {
        'Set-Cookie': buildDashboardSessionCookieHeaders(),
      });
      return;
    }
  }

  // WebSocket upgrade is handled below
  if (pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n');
    res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  // v2.0.87: Screenshots serving
  // /screenshots/ss-{No}-{suffix}.png → settings.getScreenshotDir() 配下
  // 操作セッション UI が AI 撮影した PNG をサムネ表示するため。
  if (pathname.startsWith('/screenshots/')) {
    const relative = decodeURIComponent(pathname.slice('/screenshots/'.length));
    // path traversal guard
    if (relative.includes('..') || relative.includes('\0') || !relative.endsWith('.png')) {
      res.writeHead(400); res.end('Bad request'); return;
    }
    try {
      const ssDir = settings.getScreenshotDir ? settings.getScreenshotDir() : 'screenshots';
      const filepath = path.join(ssDir, relative);
      // resolved path が ssDir 配下にあることを再確認
      const normalized = path.resolve(filepath);
      if (!normalized.startsWith(path.resolve(ssDir))) {
        res.writeHead(403); res.end('Forbidden'); return;
      }
      const data = fs.readFileSync(normalized);
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' });
      res.end(data);
    } catch (_) {
      res.writeHead(404); res.end('Not found');
    }
    return;
  }

  // Assets serving (favicon, icons, vendor fonts/css)
  // /assets/foo.png         → assets/foo.png (レガシー)
  // /assets/vendor/x.woff2  → assets/vendor/x.woff2 (新規・ローカルバンドル)
  if (pathname.startsWith('/assets/')) {
    const relative = decodeURIComponent(pathname.slice('/assets/'.length));
    const ext = path.extname(relative).toLowerCase();
    const mime = assetMimeFor(ext);
    for (const filepath of getAssetCandidates(relative)) {
      try {
        const data = fs.readFileSync(filepath);
        // フォント・CSS・画像は長期キャッシュ（ファイル名が変わらない前提）
        const cache = ['.woff2', '.woff', '.ttf', '.otf', '.css', '.js', '.png', '.ico', '.svg']
          .includes(ext) ? 'public, max-age=604800, immutable' : 'public, max-age=86400';
        res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': cache });
        res.end(data);
        return;
      } catch (_) {}
    }
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  // Screenshot serving
  if (pathname.startsWith('/screenshots/')) {
    const filename = path.basename(pathname);
    const filepath = findScreenshotPath(filename);
    if (!filepath) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    try {
      const img = fs.readFileSync(filepath);
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Cache-Control': 'no-store',
      });
      res.end(img);
    } catch {
      res.writeHead(404);
      res.end('Not found');
    }
    return;
  }

  // --- Force-reset managed AI queue (v2.0.10) ---
  // POST /api/managed-ai-batch/reset
  //   pending + activeBatch を空にして「処理中」扱いの会社を解放する。
  //   PTY が生きている場合は拒否 (誤操作で実行中タスクが消えるのを防ぐ)。
  //   ユーザーが「既に処理中です」エラーから抜け出すための非常脱出弁。
  if (pathname === '/api/managed-ai-batch/reset' && req.method === 'POST') {
    try {
      if (claudePty || getActiveHeadlessRun()) {
        jsonResponse(res, 409, {
          ok: false,
          error: 'AI セッションが現在稼働中のためリセットできません。停止してから再実行してください。',
        });
        return;
      }
      const controller: any = managedAiBatchController;
      const clearedPending = controller && Array.isArray(controller.pending) ? controller.pending.length : 0;
      const clearedActive = controller && controller.activeBatch ? 1 : 0;
      if (controller) {
        controller.pending = [];
        controller.activeBatch = null;
        controller.pendingSinceMs = 0;
        controller.queueStuckNotified = false;
      }
      try { clearRecoverySnapshot(); } catch (_) { /* swallow */ }
      cleanupStaleManagedAiMonitorEvents(0);
      // v2.0.14: 強制リセット時は sleep 抑止も解除する (誰も処理しないなら不要)
      stopPowerSaveBlockerIfActive();
      appendDiagnosticEvent('managed_ai_batch_force_reset', {
        clearedPending,
        clearedActive,
        source: 'user-api',
      });
      jsonResponse(res, 200, {
        ok: true,
        clearedPending,
        clearedActive,
        message: `pending=${clearedPending}, active=${clearedActive} をクリアしました。リスト画面から再キューできます。`,
      });
    } catch (err: any) {
      jsonResponse(res, 500, { ok: false, error: String(err && err.message || err) });
    }
    return;
  }

  // --- Per-company status (v2.0.10) ---
  // GET /api/companies/:no/status
  //   action-log から最新のステータス遷移を組み立てて返す。
  //   ダッシュボードでも CLI でもこの API を使うことで「何が起きたか」が単一窓口に。
  const companyStatusMatch = pathname.match(/^\/api\/companies\/(\d+)\/status$/);
  if (companyStatusMatch && req.method === 'GET') {
    try {
      const { getAllLogs } = require('./action-logger');
      const no = Number(companyStatusMatch[1]);
      const allLogs = getAllLogs() || [];
      const companyLogs = allLogs.filter((log: any) => Number(log.companyNo) === no);
      const TERMINAL = new Set(['awaiting_approval', 'submitted', 'skipped', 'error']);
      const terminal = [...companyLogs].reverse().find((log: any) => TERMINAL.has(String(log.action)));
      const lastNonSystem = [...companyLogs].reverse().find((log: any) => log.action !== 'settings_changed');
      const actionsByType: Record<string, number> = {};
      companyLogs.forEach((log: any) => { actionsByType[log.action] = (actionsByType[log.action] || 0) + 1; });
      jsonResponse(res, 200, {
        ok: true,
        companyNo: no,
        totalLogs: companyLogs.length,
        actionsByType,
        currentStatus: terminal ? terminal.action : (lastNonSystem ? lastNonSystem.action : 'untouched'),
        lastUpdated: lastNonSystem ? lastNonSystem.timestamp : null,
        terminalReached: !!terminal,
        terminalAction: terminal ? terminal.action : null,
        terminalAt: terminal ? terminal.timestamp : null,
        timeline: companyLogs.map((log: any) => ({
          timestamp: log.timestamp,
          action: log.action,
          // details は長文 (message 本文等) を含むので preview に切る
          detailsPreview: typeof log.details === 'string'
            ? log.details.slice(0, 200)
            : (log.details ? JSON.stringify(log.details).slice(0, 200) : ''),
        })),
      });
    } catch (err: any) {
      jsonResponse(res, 500, { ok: false, error: String(err && err.message || err) });
    }
    return;
  }

  // --- Phase B Health Check (A3) ---
  // GET /api/phase-b-health
  //   フォーム入力バッチを投入する前に、UI から呼び出して問題を事前検知する。
  //   auth 画面を起動しないよう軽量 probe のみ (claudePty 存在 / controller 状態 /
  //   pending バッチ数 / 直近 diagnostic イベントの error 件数)。
  //   過去バグ (47 バッチ滞留) のような状態を「投入前」に気付かせる。
  if (pathname === '/api/phase-b-health' && req.method === 'GET') {
    try {
      const controller: any = managedAiBatchController;
      const provider = getSelectedAiProvider();
      const pendingBatchCount = controller && Array.isArray(controller.pending) ? controller.pending.length : 0;
      const activeBatch = controller && controller.activeBatch
        ? {
            id: controller.activeBatch.id,
            companyCount: controller.activeBatch.companyNos ? controller.activeBatch.companyNos.length : 0,
            startedAt: controller.activeBatch.startedAt,
            lastProgressAt: controller.activeBatch.lastProgressAt,
            stallNotified: !!controller.activeBatch.stallNotified,
          }
        : null;
      const queueStuck = pendingBatchCount > 0 && !activeBatch && (
        controller && controller.pendingSinceMs
          ? (Date.now() - controller.pendingSinceMs) > MANAGED_AI_QUEUE_STUCK_MS
          : false
      );
      const warnings: string[] = [];
      if (!claudePty && pendingBatchCount > 0) {
        warnings.push('Managed AI session が起動していないのに pending バッチがあります。/api/launch-ai で再起動するか、停止→再投入してください。');
      }
      if (queueStuck) {
        warnings.push(`pending バッチが ${Math.round((Date.now() - controller.pendingSinceMs) / 1000)} 秒間 dispatch されていません。`);
      }
      if (activeBatch && activeBatch.stallNotified) {
        warnings.push('現在の active バッチが stall watchdog に検知されています。CLI ログを確認してください。');
      }
      jsonResponse(res, 200, {
        ok: true,
        healthy: warnings.length === 0 && !queueStuck,
        provider,
        managedSessionAlive: !!claudePty,
        pendingBatchCount,
        activeBatch,
        queueStuck,
        warnings,
        timestamp: Date.now(),
      });
    } catch (err: any) {
      jsonResponse(res, 200, {
        ok: false,
        healthy: false,
        error: String(err && err.message || err),
      });
    }
    return;
  }

  // --- Settings API endpoints (src/routes/settings-api.cjs に分離済み) ---
  // /api/settings/*, /api/companies/*, /api/outreach-targets, /api/outreach/prepare,
  // /api/target-list/import を 1 箇所の dispatcher で処理する。
  if (await getSettingsApiDispatch()(req, res, pathname)) return;

  // --- Simple API endpoints (src/routes/simple-api.cjs) ---
  // /api/cli-log, /api/check-update, /api/install-update, /api/update-status, /api/export, /api/data,
  // /api/claude-status, /api/ai/status, /api/ai/setup-diagnostics, /api/ai-submit*
  if (await getSimpleApiDispatch()(req, res, pathname, requestUrl)) return;

  // --- AI Runtime API endpoints (src/routes/ai-runtime-api.cjs) ---
  // /api/install-ai-cli, /api/launch-ai, /api/launch-ai-external, /api/stop-ai, /api/ai-input
  // queryParams を渡すのは /api/ai-toolchain/status?provider=... / /api/install-ai-cli/stream?provider=...
  if (await getAiRuntimeApiDispatch()(req, res, pathname, requestUrl?.searchParams)) return;

  // --- Form Session API endpoints (src/routes/form-session-api.cjs) ---
  // /api/form-session/* 全 10 エンドポイント
  if (await getFormSessionApiDispatch()(req, res, pathname)) return;

  // --- Approve API endpoint (src/routes/approve-api.cjs) ---
  // POST /api/approve
  if (await getApproveApiDispatch()(req, res, pathname)) return;

  // --- AI Form Fill API endpoint (src/routes/ai-form-fill-api.cjs) ---
  // POST /api/ai-form-fill
  if (await getAiFormFillApiDispatch()(req, res, pathname)) return;

  // --- Recovery API (src/routes/recovery-api.cjs) ---
  // GET /api/recovery/status, POST /api/recovery/{resume,discard}
  if (await getRecoveryApiDispatch()(req, res, pathname)) return;

  // --- Error Recovery API (src/routes/error-recovery-api.cjs) — P1-3 ---
  // GET /api/errors/grouped, POST /api/error/retry
  if (await getErrorRecoveryApiDispatch()(req, res, pathname)) return;

  // --- Parallel Form Fill API (src/routes/parallel-form-fill-api.cjs) — P1-4 ---
  // POST /api/ai-form-fill-parallel (concurrency 1〜3)
  if (await getParallelFormFillApiDispatch()(req, res, pathname)) return;

  // --- AI Final Submit API (src/routes/ai-submit-final-api.cjs) ---
  // POST /api/ai-submit-final (awaiting_approval → AI に submit させる)
  if (await getAiSubmitFinalApiDispatch()(req, res, pathname)) return;

  // --- Onboarding Wizard (src/routes/onboarding-api.cjs) ---
  // GET /onboarding, POST /api/onboarding/{progress,validate,import-targets,complete,reset}, GET /api/onboarding/{progress,check-ai}
  if (await getOnboardingApiDispatch()(req, res, pathname, requestUrl.searchParams)) return;

  // --- List Builder API (src/routes/list-builder-api.cjs) ---
  // POST /api/list-builder/run, GET /api/list-builder/stream/:runId (SSE), POST /api/list-builder/commit,
  // GET /api/list-builder/runs, GET /api/list-builder/runs/:runId, POST /api/list-builder/runs/:runId/cancel,
  // POST /api/list-builder/runs/:runId/retry-failed, DELETE /api/list-builder/runs/:runId,
  // GET /api/list-builder/api-key-status
  if (await getListBuilderApiDispatch()(req, res, pathname, requestUrl.searchParams)) return;

  // --- Onboarding 未完了なら / にアクセス時に /onboarding へリダイレクト ---
  if (pathname === '/' && req.method === 'GET' && !isOnboardingComplete()) {
    const sessQuery = requestUrl.searchParams.get('session');
    const sessSuffix = sessQuery ? ('?session=' + encodeURIComponent(sessQuery)) : '';
    res.writeHead(302, { Location: '/onboarding' + sessSuffix });
    res.end();
    return;
  }

  // --- Existing API endpoints ---


  // ── Form Session API (/api/form-session/*) ────────────────────────
  // form-session routes は src/routes/form-session-api.cjs に分離済み (dispatcher で処理)

  // Dashboard HTML
  const _isDemo = demoMode.isDemoMode();
  const _frameAncestors = _isDemo ? demoMode.getDemoFrameAncestors() : "'none'";
  const _htmlHeaders = {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Set-Cookie': buildDashboardSessionCookieHeaders(),
    'Content-Security-Policy': [
      // 全アセット (フォント・Tailwind・Phosphor・Material Symbols) はローカルバンドル済み
      // 外部CDN依存ゼロ → 厳格な 'self' のみで運用
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "connect-src 'self'",
      "font-src 'self' data:",
      'frame-ancestors ' + _frameAncestors,
      "object-src 'none'",
    ].join('; ') + ';',
    'X-Content-Type-Options': 'nosniff',
    // 1.2.94 B1: Referer 経由で session token がリーク しないよう強制
    'Referrer-Policy': 'no-referrer',
  };
  if (!_isDemo) {
    _htmlHeaders['X-Frame-Options'] = 'DENY';
  }
  res.writeHead(200, _htmlHeaders);
  const _embedFlag = requestUrl.searchParams.get('embed') === '1';
  res.end(demoMode.injectDemoBanner(buildPage(), { embed: _embedFlag }));
});

async function startDashboardServer(opts: Record<string, any> = {}) {
  if (opts.formSessionManager) _formSessionManager = opts.formSessionManager;
  if (dashboardRuntime && server.listening) return dashboardRuntime;
  if (serverStartPromise) return serverStartPromise;

  ensureStandaloneDashboardLockHooks();
  if (!standaloneDashboardLockHeld) {
    const lock: any = await claimStandaloneDashboardLock();
    if (!lock.ok) {
      dashboardRuntime = lock.runtime || readRuntime();
      return dashboardRuntime;
    }
  }

  // Lock を確保した時点で、stale な dashboard-runtime.json (= 過去に死んだ
  // プロセスが残した記録) を実体削除する。これをしないと:
  //   - Electron renderer / cli-logger / action-logger が readRuntime() で
  //     古い port (例: 3765) を引いて、今回起動するサーバー (例: 3456) に
  //     辿り着けない
  //   - 「ネットワークに接続できません」エラーの再発を招く
  // 生きてるサーバーの runtime.json は触らない (isRuntimeStale の判定で除外)。
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { clearStaleRuntimes } = require('./dashboard-runtime');
    const removed: string[] = clearStaleRuntimes();
    if (removed.length > 0) {
      console.log(`[startup] cleaned ${removed.length} stale dashboard-runtime file(s):`,
        removed.map((f: any) => path.basename(path.dirname(f)) + '/' + path.basename(f)).join(', '));
      try {
        appendDiagnosticEvent('stale_dashboard_runtime_cleaned', {
          removedCount: removed.length,
          removedFiles: removed,
        });
      } catch (_) { /* best-effort */ }
    }
  } catch (e: any) {
    console.warn('[startup] stale runtime cleanup failed:', e && e.message);
  }

  serverStartPromise = (async () => {
    const preferredPort = settings.getPort();
    const bindHost = settings.getHost();
    const listenPort: any = await findAvailablePort(preferredPort, bindHost);

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(listenPort, bindHost, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });

    const address = server.address();
    dashboardRuntime = writeRuntime({
      bindHost,
      host: bindHost,
      port: typeof address === 'object' && address ? address.port : preferredPort,
      preferredPort,
    });

    // CLI log shared secret を環境変数に公開（子プロセスが継承）
    process.env.SALES_CLAW_CLI_TOKEN = CLI_LOG_SECRET;

    refreshWatchTargets();
    startHeartbeat();
    cleanupStaleManagedAiMonitorEvents();

    // 1.2.94 B2: list-builder の古い run dir を起動時に削除 (デフォルト 30 日経過)
    // 旧: cleanupOldRuns() の呼び出し元なし → data/list-builder/runs/ が無限蓄積
    try {
      const runManager = require('./list-builder/run-manager');
      const cleanupResult = runManager.cleanupOldRuns(30);
      if (cleanupResult && cleanupResult.removed > 0) {
        console.log(`[startup] cleaned up ${cleanupResult.removed} old list-builder runs (>30 days)`);
        appendDiagnosticEvent('list_builder_runs_cleaned', {
          removed: cleanupResult.removed,
          ttlDays: 30,
        });
      }
    } catch (e) {
      console.warn('[startup] list-builder cleanup failed:', e && e.message);
    }

    // 起動時 recovery snapshot 検出（永続化された managed batch 残りがあれば診断イベントとして記録）
    try {
      const snap = loadRecoverySnapshot();
      if (snap && Array.isArray(snap.batches) && snap.batches.length > 0) {
        console.log(`[startup] recovery snapshot detected: ${snap.batches.length} batches`);
        appendDiagnosticEvent('managed_ai_recovery_snapshot_detected_on_startup', {
          batchCount: snap.batches.length,
          providerId: snap.providerId,
        });
      }
    } catch (_) {}

    const _sl = settings.getSection('preferences').language || 'ja';
    console.log(`\n===================================`);
    console.log(`  ${i18nT(_sl, 'startup.title')}`);
    console.log(`  ${dashboardRuntime.url}`);
    console.log(`===================================\n`);
    console.log(`\n${i18nT(_sl, 'startup.noPolling')}`);
    console.log(`${i18nT(_sl, 'startup.stop')}\n`);

    return dashboardRuntime;
  })().catch((error) => {
    serverStartPromise = null;
    throw error;
  });

  return serverStartPromise;
}

// WebSocket upgrade for PTY terminal
server.on('upgrade', (request, socket, head) => {
  const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');
  if (requestUrl.pathname === '/terminal') {
    const auth = isAuthorizedDashboardRequest(request, { allowTokenWithoutOrigin: true });
    if (!auth.ok) {
      rejectUpgradeRequest(socket, auth.statusCode, auth.error);
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

server.on('close', () => {
  closeWatchers();
  clearRuntime();
  releaseStandaloneDashboardLock();
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  dashboardRuntime = null;
  serverStartPromise = null;
});

if (require.main === module) {
  (async () => {
    const runtime: any = await startDashboardServer();
    if (!server.listening) {
      const runtimeUrl = runtime && runtime.url ? runtime.url : 'http://127.0.0.1';
      console.log(`[Dashboard] 既存の dashboard-server が起動中です: ${runtimeUrl}`);
      return;
    }
  })().catch((error) => {
    console.error('[Dashboard] 起動失敗:', error.message);
    releaseStandaloneDashboardLock();
    process.exitCode = 1;
  });
}

module.exports = {
  loadData,
  // v2.0.26: テストから prompt の中身を verify できるよう export。
  // 本番経路では非公開関数として使われ続けるが、export 自体は副作用なし。
  buildClaudeFormFillPrompt,
  buildManagedAiSessionContract,
  getPhaseBParallelTabs,
  getManagedAiFormBatchSize,
  server,
  startDashboardServer,
  // electron-main.js が before-quit / will-quit でこれを await することで、
  // PTY 子プロセスや WebContentsView の孤児化を防ぐ。
  gracefulShutdown,
  // v2.1.0 Phase 2d: electron-main から IPC server 起動後の pipe path を渡す
  setInternalFormMcpIpcPipePath,
  // v2.1.0 Phase 2d: formFill mode 取得 (electron-main で IPC server を起動するか判定)
  getFormFillMode,
  // v2.0.77: electron-main から IPC server 起動/失敗を診断記録できるよう export
  appendDiagnosticEvent,
};

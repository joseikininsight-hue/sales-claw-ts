// アクションログ管理
// 各企業に対する操作を記録・表示する

import * as fs from 'fs';
import * as http from 'http';
import { getRequestTarget } from './dashboard-runtime';
import { ensureDataDir, resolveDataPath } from './data-paths';
import { acquireFileLock as _acquireFileLock, releaseFileLock } from './file-lock';
import type { ActionLogEntry, ActionType, ActionDetails } from './types/action-log';

interface SettingsManagerShape {
  getSection: (key: string) => { maxLogEntries?: number } | undefined;
  getHost: () => string;
  getPort: () => number;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const settings = require('./settings-manager') as SettingsManagerShape;

// SQLite adapter は将来用 (現在は always null = JSON 経路)
function getSqliteAdapter(): null { return null; }

interface LogCache {
  filePath: string | null;
  signature: string | null;
  data: ActionLogEntry[];
}

const logCache: LogCache = {
  filePath: null,
  signature: null,
  data: [],
};

// v2.0.14: 100 社規模で logAction が連打されるとき、全件 parse+stringify+write
// で I/O コストが O(N²) に近づく。一連の logAction の disk write を 500ms
// 単位に間引いて、UI 表示用の in-memory cache を即時更新する設計に変更。
//
// 不変条件:
//   - logAction は in-memory cache に即 push (UI の getAllLogs は最新値が見える)
//   - 500ms 以内に来た複数 logAction は 1 回の write にまとまる
//   - terminal action (submitted/error/skipped/awaiting_approval) は即 flush
//     (クラッシュで失うと痛い)
//   - process.on('beforeExit') / SIGTERM で flush
const FLUSH_DEBOUNCE_MS = 500;
const TERMINAL_ACTIONS = new Set(['submitted', 'error', 'skipped', 'awaiting_approval']);
let _flushTimer: ReturnType<typeof setTimeout> | null = null;
let _pendingFlush = false;

function scheduleDebouncedFlush(): void {
  _pendingFlush = true;
  if (_flushTimer) return;
  _flushTimer = setTimeout(() => {
    _flushTimer = null;
    if (!_pendingFlush) return;
    _pendingFlush = false;
    flushNow();
  }, FLUSH_DEBOUNCE_MS);
  if (typeof _flushTimer.unref === 'function') _flushTimer.unref();
}

function flushNow(): void {
  if (_flushTimer) {
    clearTimeout(_flushTimer);
    _flushTimer = null;
  }
  _pendingFlush = false;
  // v2.0.19: 単一 disk write は lock 必須 (rename atomic だが Windows で他プロセス
  // の同時アクセスを安全に直列化するため)
  const filePath = getLogFile();
  const lockFile = acquireFileLock(filePath);
  try {
    saveLog(logCache.data);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn('[action-logger] flushNow failed:', msg);
  } finally {
    releaseFileLock(lockFile);
  }
}

// プロセス終了時に必ず flush (クラッシュ時の log 消失を最小化)
let _exitHooksInstalled = false;
function installExitHooks(): void {
  if (_exitHooksInstalled) return;
  _exitHooksInstalled = true;
  const onExit = () => { try { flushNow(); } catch (_) { /* swallow */ } };
  process.once('beforeExit', onExit);
  process.once('SIGINT', () => { onExit(); process.exit(130); });
  process.once('SIGTERM', () => { onExit(); process.exit(143); });
}

function getLogFile(): string {
  return resolveDataPath('action-log.json');
}

function cloneValue<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (typeof globalThis.structuredClone === 'function') {
    return globalThis.structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

function getFileSignature(filePath: string): string | null {
  try {
    const stat = fs.statSync(filePath);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return null;
  }
}

function readJsonCached(filePath: string, fallbackValue: ActionLogEntry[]): ActionLogEntry[] {
  const signature = getFileSignature(filePath);
  if (logCache.filePath === filePath && logCache.signature === signature) {
    return logCache.data;
  }

  if (signature === null) {
    logCache.filePath = filePath;
    logCache.signature = null;
    logCache.data = fallbackValue;
    return fallbackValue;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    // v2.0.25: Array 以外 (null / number / object) でも安全に空配列フォールバック
    const sanitized: ActionLogEntry[] = Array.isArray(parsed) ? (parsed as ActionLogEntry[]) : [];
    if (!Array.isArray(parsed)) {
      console.warn(`[action-logger] expected Array but got ${parsed === null ? 'null' : typeof parsed}; using empty fallback. file: ${filePath}`);
    }
    logCache.filePath = filePath;
    logCache.signature = signature;
    logCache.data = sanitized;
    return sanitized;
  } catch (parseErr: unknown) {
    // 1.2.92: JSON 破損検知 → corrupt として隔離 + 警告ログ
    try {
      const backup = filePath + '.corrupt.' + Date.now();
      fs.copyFileSync(filePath, backup);
      const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
      console.warn(`[action-logger] JSON parse failed: ${filePath} - backed up to ${backup}, continuing with empty fallback. Error: ${msg}`);
    } catch (backupErr: unknown) {
      const pmsg = parseErr instanceof Error ? parseErr.message : String(parseErr);
      const bmsg = backupErr instanceof Error ? backupErr.message : String(backupErr);
      console.warn(`[action-logger] JSON parse failed AND backup failed: ${filePath}. parse: ${pmsg}, backup: ${bmsg}`);
    }
    logCache.filePath = filePath;
    logCache.signature = signature;
    logCache.data = fallbackValue;
    return fallbackValue;
  }
}

function writeJsonCached(filePath: string, data: ActionLogEntry[]): void {
  ensureDataDir();
  const tmpFile = filePath + '.tmp.' + process.pid;
  fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2), 'utf-8');
  try {
    fs.renameSync(tmpFile, filePath);
  } catch (e: unknown) {
    const code = (e && typeof e === 'object' && 'code' in e) ? (e as { code?: string }).code : undefined;
    if (process.platform === 'win32' && (code === 'EPERM' || code === 'EBUSY')) {
      fs.copyFileSync(tmpFile, filePath);
      try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    } else {
      try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
      throw e;
    }
  }
  logCache.filePath = filePath;
  logCache.signature = getFileSignature(filePath);
  logCache.data = data;
}

function acquireFileLock(filePath: string): string | null {
  try {
    return _acquireFileLock(filePath, { label: 'action-logger', maxWaitMs: 3000 });
  } catch (e: unknown) {
    console.warn('[action-logger]', e instanceof Error ? e.message : String(e));
    return null;
  }
}

function loadLog(): ActionLogEntry[] {
  return readJsonCached(getLogFile(), []);
}

function saveLog(entries: ActionLogEntry[]): void {
  const prefs = settings.getSection('preferences');
  const maxEntries = Math.max(100, Number(prefs?.maxLogEntries) || 10000);
  const trimmed = entries.slice(-maxEntries);
  writeJsonCached(getLogFile(), trimmed);
}

function notifyCliLog(companyNo: number | string, companyName: string, action: string): void {
  try {
    const target = getRequestTarget(settings.getHost(), settings.getPort());
    const msg = `[No.${companyNo}] ${companyName} → ${action}`;
    const payload = JSON.stringify({ message: msg, type: 'action' });
    const req = http.request({
      hostname: target.hostname,
      port: target.port,
      path: '/api/cli-log',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'X-CLI-Token': process.env.SALES_CLAW_CLI_TOKEN ?? '',
      },
    });
    req.on('error', () => undefined);
    req.write(payload);
    req.end();
  } catch { /* ignore */ }
}

/** 操作ログを 1 件追加し、追加後のエントリー総数を返す。
 *
 * v2.0.14: in-memory cache に即 push、disk write は debounce (500ms)。
 * Terminal action (submitted / error / skipped / awaiting_approval) は即 flush。
 * これで 100 社 × 5-7 アクション = 500-700 logAction の I/O コストを大幅削減。
 */
export function logAction(
  companyNo: number | string,
  companyName: string,
  action: ActionType | string,
  details: ActionDetails
): number {
  installExitHooks();
  const filePath = getLogFile();
  let entryCount = 0;
  const newEntry: ActionLogEntry = {
    timestamp: new Date().toISOString(),
    companyNo,
    companyName,
    action: action as ActionType,
    details,
  };
  // v2.0.19: lock を取らずに in-memory cache に push。
  // 旧実装は logAction 毎に acquireFileLock を取って disk から readFileSync 後 push
  // していたため Windows で 50ms+ かかっていた。
  // 設計上 cache は最新を持っているので、外部プロセスからの書き込みを最新で取り直す
  // 必要は無い (saveLog の writeJsonCached が atomic rename で書く)。
  // 初回だけ cache を warm up する。
  if (logCache.filePath !== filePath || logCache.data.length === 0) {
    const lockFile = acquireFileLock(filePath);
    try {
      logCache.data = loadLog();
    } finally {
      releaseFileLock(lockFile);
    }
  }
  logCache.data.push(newEntry);
  entryCount = logCache.data.length;
  // Terminal action なら即 flush (クラッシュ時にも残す)、それ以外は debounce
  if (TERMINAL_ACTIONS.has(String(action))) {
    flushNow();
  } else {
    scheduleDebouncedFlush();
  }
  notifyCliLog(companyNo, companyName, action);
  return entryCount;
}

/** 指定企業の操作ログ全件を返す (新しい順ではなく挿入順)。 */
export function getCompanyLog(companyNo: number | string): ActionLogEntry[] {
  const sqlite = getSqliteAdapter();
  if (sqlite !== null) {
    // SQLite 経路 (現状未実装)
  }
  return cloneValue(loadLog().filter((e: any) => e.companyNo === companyNo));
}

/** 全企業分の操作ログを返す。 */
export function getAllLogs(): ActionLogEntry[] {
  const sqlite = getSqliteAdapter();
  if (sqlite !== null) {
    // SQLite 経路 (現状未実装)
  }
  return cloneValue(loadLog());
}

/** 各企業の最新アクション 1 件ずつを返す。 */
export function getLatestActions(): ActionLogEntry[] {
  const sqlite = getSqliteAdapter();
  if (sqlite !== null) {
    // SQLite 経路 (現状未実装)
  }
  const entries = loadLog();
  const latest: Record<string, ActionLogEntry> = {};
  entries.forEach((e: any) => {
    latest[String(e.companyNo)] = e;
  });
  return Object.values(latest).map((entry: any) => ({ ...entry }));
}

/** 指定企業のログを全削除し、削除件数を返す。 */
export function removeCompanyLogs(companyNo: number | string): number {
  const sqlite = getSqliteAdapter();
  if (sqlite !== null) {
    // SQLite 経路 (現状未実装)
  }
  const filePath = getLogFile();
  const lockFile = acquireFileLock(filePath);
  try {
    const key = String(companyNo);
    logCache.signature = null;
    const entries = loadLog();
    const remaining = entries.filter((entry: any) => String(entry.companyNo) !== key);
    const removedCount = entries.length - remaining.length;
    if (removedCount > 0) {
      saveLog(remaining);
    }
    return removedCount;
  } finally {
    releaseFileLock(lockFile);
  }
}

module.exports = { logAction, getCompanyLog, getAllLogs, getLatestActions, removeCompanyLogs };

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
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as ActionLogEntry[];
    logCache.filePath = filePath;
    logCache.signature = signature;
    logCache.data = parsed;
    return parsed;
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

/** 操作ログを 1 件追加し、追加後のエントリー総数を返す。 */
export function logAction(
  companyNo: number | string,
  companyName: string,
  action: ActionType | string,
  details: ActionDetails
): number {
  const filePath = getLogFile();
  const lockFile = acquireFileLock(filePath);
  let entryCount = 0;
  try {
    logCache.signature = null;
    const entries = loadLog();
    entries.push({
      timestamp: new Date().toISOString(),
      companyNo,
      companyName,
      action: action as ActionType,
      details,
    });
    saveLog(entries);
    entryCount = entries.length;
  } finally {
    releaseFileLock(lockFile);
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

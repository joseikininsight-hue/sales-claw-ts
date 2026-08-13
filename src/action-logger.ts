// アクションログ管理
// 各企業に対する操作を記録・表示する

import * as fs from 'fs';
import * as http from 'http';
import { getRequestTarget } from './dashboard-runtime';
import { resolveDataPath } from './data-paths';
import { acquireFileLock as _acquireFileLock, releaseFileLock, atomicWriteJson } from './file-lock';
import type { ActionLogEntry, ActionType, ActionDetails } from './types/action-log';
import { getErrorMessage } from './types/helpers';

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

function flushNow(exitFlush = false): void {
  if (_flushTimer) {
    clearTimeout(_flushTimer);
    _flushTimer = null;
  }
  _pendingFlush = false;
  // 根本原因 2 の対策: ロック取得失敗時はロック無し書き込みを禁止。
  // 通常は maxWaitMs 短め (1500ms)、終了時は長め (5000ms) で best-effort。
  const filePath = getLogFile();
  const maxWaitMs = exitFlush ? 5000 : 1500;
  let lockFile: string | null = null;
  try {
    lockFile = _acquireFileLock(filePath, { label: 'action-logger', maxWaitMs });
  } catch (e: unknown) {
    // ロック取得失敗: ロック無し書き込みは torn write を招くため禁止。
    // dirty フラグを立てたまま次の debounce 周期に委ねる。
    _pendingFlush = true;
    console.warn('[action-logger] flushNow: lock timeout, will retry:', getErrorMessage(e));
    // terminal action 等で flushNow が直接呼ばれた場合、タイマーが張られていないと
    // 次の logAction まで永続化が遅延する。非終了時はデバウンスを張り直す。
    if (!exitFlush) scheduleDebouncedFlush();
    return;
  }
  try {
    // 別プロセス (Phase A サブプロセス群など) が同じファイルへ書いた追記を
    // 全置換の前にマージする。ロックは torn write しか防げず、キャッシュ全体で
    // ファイルを上書きすると「後勝ち」で他プロセスのエントリが消える (lost update)。
    // 自プロセスが最後に書いた時点の signature と一致する場合はマージ不要。
    if (getFileSignature(filePath) !== logCache.signature) {
      mergeForeignEntriesIntoCache(filePath);
    }
    saveLog(logCache.data);
  } catch (e: unknown) {
    const msg = getErrorMessage(e);
    console.warn('[action-logger] flushNow failed:', msg);
  } finally {
    releaseFileLock(lockFile);
  }
}

/**
 * エントリの同一性キー。Windows のタイマ分解能では ms timestamp が衝突しうる
 * (既定 15.6ms 粒度) ため、details も含めて同一 timestamp の別エントリを
 * 誤って重複扱いしないようにする。
 */
function entryIdentityKey(entry: ActionLogEntry): string {
  let detailsKey = '';
  try {
    detailsKey = JSON.stringify(entry?.details ?? '');
  } catch { /* 循環参照等は空キー扱い */ }
  return `${entry?.timestamp ?? ''}|${entry?.companyNo ?? ''}|${entry?.action ?? ''}|${detailsKey}`;
}

/** ISO8601 timestamp の時系列比較 (ロケール非依存のバイト順比較)。 */
function compareByTimestamp(a: ActionLogEntry, b: ActionLogEntry): number {
  const ta = String(a?.timestamp ?? '');
  const tb = String(b?.timestamp ?? '');
  return ta < tb ? -1 : ta > tb ? 1 : 0;
}

/**
 * ディスク上にあって in-memory cache に無いエントリを cache へ取り込み、
 * timestamp 昇順に並べ直す。呼び出し側でファイルロックを保持していること。
 */
function mergeForeignEntriesIntoCache(filePath: string): void {
  let diskEntries: ActionLogEntry[] = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    diskEntries = Array.isArray(parsed) ? (parsed as ActionLogEntry[]) : [];
  } catch {
    // 読めない/壊れている場合はマージせず、既存の cache を正とする
    return;
  }
  if (diskEntries.length === 0) return;
  const known = new Set(logCache.data.map(entryIdentityKey));
  const foreign = diskEntries.filter((entry) => !known.has(entryIdentityKey(entry)));
  if (foreign.length === 0) return;
  // sort は stable (ES2019+) なので、同一 timestamp のエントリは挿入順を保つ。
  // getLatestActions の「配列順 = 時系列順」前提はこの安定性に依存している。
  logCache.data = logCache.data.concat(foreign).sort(compareByTimestamp);
  console.warn(`[action-logger] merged ${foreign.length} entr${foreign.length === 1 ? 'y' : 'ies'} written by another process`);
}

// プロセス終了時に必ず flush (クラッシュ時の log 消失を最小化)
let _exitHooksInstalled = false;
function installExitHooks(): void {
  if (_exitHooksInstalled) return;
  _exitHooksInstalled = true;
  // 終了時は exitFlush=true で長めタイムアウト (5000ms) を使う
  const onExit = () => { try { flushNow(true); } catch (_) { /* swallow */ } };
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
    let sanitized: ActionLogEntry[] = Array.isArray(parsed) ? (parsed as ActionLogEntry[]) : [];
    if (!Array.isArray(parsed)) {
      console.warn(`[action-logger] expected Array but got ${parsed === null ? 'null' : typeof parsed}; using empty fallback. file: ${filePath}`);
    }
    // flush 待ちの自プロセスエントリを持ったまま別プロセスの書き込みで signature が
    // 変わった場合、ディスク内容で cache を全置換すると未 flush 分が消滅する。
    // pending がある間だけ「ディスク ∪ (メモリ − ディスク)」で保護する。
    if ((_pendingFlush || _flushTimer) && logCache.filePath === filePath && logCache.data.length > 0) {
      const known = new Set(sanitized.map(entryIdentityKey));
      const pendingOnly = logCache.data.filter((entry) => !known.has(entryIdentityKey(entry)));
      if (pendingOnly.length > 0) {
        sanitized = sanitized.concat(pendingOnly).sort(compareByTimestamp);
      }
    }
    // 注意: マージ後の signature は「ディスク内容」を指すが data は未 flush 分を
    // 含むため、一時的に signature ≠ data 内容となる。この不整合は次の flushNow
    // がディスク差分を再マージしてから全書き込みすることで解消される (意図的)。
    logCache.filePath = filePath;
    logCache.signature = signature;
    logCache.data = sanitized;
    return sanitized;
  } catch (parseErr: unknown) {
    // 1.2.92: JSON 破損検知 → corrupt として隔離 + 警告ログ
    const corruptPath = filePath + '.corrupt.' + Date.now();
    try {
      fs.copyFileSync(filePath, corruptPath);
      const msg = getErrorMessage(parseErr);
      console.warn(`[action-logger] JSON parse failed: ${filePath} - backed up to ${corruptPath}, continuing with empty fallback. Error: ${msg}`);
    } catch (backupErr: unknown) {
      const pmsg = getErrorMessage(parseErr);
      const bmsg = getErrorMessage(backupErr);
      console.warn(`[action-logger] JSON parse failed AND backup failed: ${filePath}. parse: ${pmsg}, backup: ${bmsg}`);
    }
    // 根本原因 5 の対策: .bak が存在すれば復元を試みる
    const bakPath = filePath + '.bak';
    try {
      const bakParsed = JSON.parse(fs.readFileSync(bakPath, 'utf-8'));
      const bakData: ActionLogEntry[] = Array.isArray(bakParsed) ? (bakParsed as ActionLogEntry[]) : [];
      // .bak から本体へ復元
      fs.copyFileSync(bakPath, filePath);
      console.warn(`[action-logger] restored from ${bakPath}: ${bakData.length} entries`);
      logCache.filePath = filePath;
      logCache.signature = getFileSignature(filePath);
      logCache.data = bakData;
      return bakData;
    } catch {
      // .bak も読めない場合は空フォールバック（最後の手段）
    }
    logCache.filePath = filePath;
    logCache.signature = signature;
    logCache.data = fallbackValue;
    return fallbackValue;
  }
}

function writeJsonCached(filePath: string, data: ActionLogEntry[]): void {
  // 根本原因 5 の対策: 書き込み直前に現在の正常値を .bak として保存
  if (fs.existsSync(filePath)) {
    try { fs.copyFileSync(filePath, filePath + '.bak'); } catch { /* backup 失敗は致命的でない */ }
  }
  // 根本原因 1・2 の対策: copyFileSync フォールバックを撤廃し、fsync 付き
  // atomicWriteJson に一本化。EPERM/EBUSY は atomicWriteJson 内でリトライする。
  atomicWriteJson(filePath, JSON.stringify(data, null, 2));
  logCache.filePath = filePath;
  logCache.signature = getFileSignature(filePath);
  logCache.data = data;
}

function acquireFileLock(filePath: string): string | null {
  try {
    return _acquireFileLock(filePath, { label: 'action-logger', maxWaitMs: 3000 });
  } catch (e: unknown) {
    console.warn('[action-logger]', getErrorMessage(e));
    return null;
  }
}

function loadLog(): ActionLogEntry[] {
  return readJsonCached(getLogFile(), []);
}

function saveLog(entries: ActionLogEntry[]): void {
  // 根本原因 4 の対策: maxLogEntries の既定値を 10000 → 2000 に縮小し、
  // フル書き直し時の JSON サイズ・ロック保持時間を抑制する。
  const prefs = settings.getSection('preferences');
  const maxEntries = Math.max(100, Number(prefs?.maxLogEntries) || 2000);
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
  // flushNow() also acquires this file's lock. Flush before taking the
  // removal lock to avoid a same-process lock timeout.
  if (_pendingFlush || _flushTimer) {
    try { flushNow(); } catch { /* keep going - best effort */ }
  }
  const filePath = getLogFile();
  const lockFile = acquireFileLock(filePath);
  try {
    const key = String(companyNo);
    const entries = logCache.data && logCache.data.length > 0
      ? logCache.data
      : loadLog();
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

function resetCacheForTests(): void {
  if (_flushTimer) {
    clearTimeout(_flushTimer);
    _flushTimer = null;
  }
  _pendingFlush = false;
  logCache.filePath = null;
  logCache.signature = null;
  logCache.data = [];
}

module.exports = {
  logAction,
  getCompanyLog,
  getAllLogs,
  getLatestActions,
  removeCompanyLogs,
  _test: {
    flushNow,
    resetCache: resetCacheForTests,
  },
};

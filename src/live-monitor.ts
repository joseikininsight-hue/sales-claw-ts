'use strict';

const fs = require('fs');
const path = require('path');
const { ensureDataDir, resolveDataPath } = require('./data-paths');

/**
 * ライブモニタ用 JSON ファイル（live-monitor.json）の絶対パスを返す。
 * @returns {string} ファイルパス
 */
function getLiveMonitorFile() {
  return resolveDataPath('live-monitor.json');
}

function defaultState() {
  return {
    updatedAt: null,
    sessions: {},
    lastEvent: null,
    events: [],
  };
}

const FINAL_STATUSES = new Set([
  'awaiting_approval',
  'submitted',
  'completed',
  'skipped',
  'error',
  'user_required',
]);
const STALE_SESSION_TTL_MS = 5 * 60 * 1000;
// 根本原因 4 の対策: 保存イベント上限を 1000 → 300 に縮小してフル書き直しサイズを抑制
const MAX_MONITOR_EVENTS_STORED = 300;
const MAX_MONITOR_EVENTS_SUMMARY = 200;
const monitorCache: { filePath: string | null; signature: string | null; data: any } = {
  filePath: null,
  signature: null,
  data: null,
};

// v2.0.21: updateLiveMonitor の disk write を debounced 化。
// 100 社 Phase A で各社 3-5 update → 500 回の lock + writeState を
// 直列処理すると Windows で 7-10 秒の純粋 I/O コスト。
// 同じ思想: in-memory に push、500ms TTL で書き出し。
// 終了状態 (final status) は即 flush で永続化する。
const LIVE_MONITOR_FLUSH_DEBOUNCE_MS = 500;
let _liveMonitorFlushTimer: ReturnType<typeof setTimeout> | null = null;
let _liveMonitorDirty = false;

function scheduleLiveMonitorFlush(): void {
  _liveMonitorDirty = true;
  if (_liveMonitorFlushTimer) return;
  _liveMonitorFlushTimer = setTimeout(() => {
    _liveMonitorFlushTimer = null;
    if (!_liveMonitorDirty) return;
    _liveMonitorDirty = false;
    flushLiveMonitorNow();
  }, LIVE_MONITOR_FLUSH_DEBOUNCE_MS);
  if (typeof _liveMonitorFlushTimer.unref === 'function') _liveMonitorFlushTimer.unref();
}

function flushLiveMonitorNow(exitFlush = false): void {
  if (_liveMonitorFlushTimer) {
    clearTimeout(_liveMonitorFlushTimer);
    _liveMonitorFlushTimer = null;
  }
  _liveMonitorDirty = false;
  if (!monitorCache.data) return;
  const filePath = getLiveMonitorFile();
  // 根本原因 2 の対策: ロック取得失敗時はロック無し書き込みを禁止。
  // 終了時 (exitFlush=true) は maxWaitMs 長め (5000ms)、通常は 1500ms。
  const maxWaitMs = exitFlush ? 5000 : 1500;
  let lockFile = null;
  try {
    lockFile = _acquireFileLock(filePath, { label: 'live-monitor', maxWaitMs });
  } catch (e: any) {
    // ロック取得失敗: ロック無し書き込みは torn write を招くため禁止。
    // dirty フラグを立てたまま次の debounce 周期に委ねる。
    _liveMonitorDirty = true;
    console.warn('[live-monitor] flushLiveMonitorNow: lock timeout, will retry:', e && e.message || e);
    // 直接呼び出し (final ステータス即 flush 等) でタイマー未設定だと次の update まで
    // 永続化されない。非終了時はデバウンスを張り直す。
    if (!exitFlush) scheduleLiveMonitorFlush();
    return;
  }
  try {
    writeState(monitorCache.data);
  } catch (e: any) {
    console.warn('[live-monitor] flush failed:', e && e.message || e);
  } finally {
    releaseFileLock(lockFile);
  }
}

let _liveMonitorExitHooksInstalled = false;
function installLiveMonitorExitHooks(): void {
  if (_liveMonitorExitHooksInstalled) return;
  _liveMonitorExitHooksInstalled = true;
  // 終了時は exitFlush=true で長めタイムアウト (5000ms) を使う
  const onExit = () => { try { flushLiveMonitorNow(true); } catch (_) { /* swallow */ } };
  process.once('beforeExit', onExit);
  process.once('SIGINT', () => { onExit(); process.exit(130); });
  process.once('SIGTERM', () => { onExit(); process.exit(143); });
}

function isFinalStatus(entry) {
  const status = entry && typeof entry.status === 'string' ? entry.status.trim() : '';
  return FINAL_STATUSES.has(status);
}

function parseUpdatedAtMs(entry) {
  const ms = Date.parse(entry && entry.updatedAt ? entry.updatedAt : '');
  return Number.isFinite(ms) ? ms : null;
}

function getFileSignature(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return null;
  }
}

function shouldDropSession(state, key, entry) {
  if (!entry) return true;
  if (isFinalStatus(entry)) return true;

  const updatedAtMs = parseUpdatedAtMs(entry);
  if (updatedAtMs !== null && (Date.now() - updatedAtMs) > STALE_SESSION_TTL_MS) {
    return true;
  }

  const events = Array.isArray(state.events) ? state.events : [];
  return events.some((event: any) => {
    if (!event || String(event.companyNo) !== String(entry.companyNo)) return false;
    if (event.active !== false && !isFinalStatus(event)) return false;
    const eventUpdatedAtMs = parseUpdatedAtMs(event);
    return eventUpdatedAtMs !== null && updatedAtMs !== null && eventUpdatedAtMs >= updatedAtMs;
  });
}

function pruneState(state) {
  let changed = false;
  Object.entries(state.sessions || {}).forEach(([key, entry]) => {
    if (!shouldDropSession(state, key, entry)) return;
    delete state.sessions[key];
    changed = true;
  });
  return changed;
}

function readState() {
  const filePath = getLiveMonitorFile();
  const signature = getFileSignature(filePath);
  if (monitorCache.filePath === filePath && monitorCache.signature === signature && monitorCache.data) {
    return monitorCache.data;
  }

  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const state = {
      updatedAt: raw && raw.updatedAt ? raw.updatedAt : null,
      sessions: raw && raw.sessions && typeof raw.sessions === 'object' ? raw.sessions : {},
      lastEvent: raw && raw.lastEvent ? raw.lastEvent : null,
      events: Array.isArray(raw && raw.events) ? raw.events : [],
    };
    monitorCache.filePath = filePath;
    monitorCache.signature = signature;
    monitorCache.data = state;
    // 1.2.92 C1 fix: pruneState による writeState は ロック内で行われない経路があった
    // (getLiveMonitorSummary 等は readState をロック取得前に呼ぶ)。
    // SSE ポーリング中の writeState で別 write を上書きする race を防ぐため、
    // pruneState を「読み取り専用」化する: state を変更しても ファイルへの書込みは
    // 次回 updateLiveMonitor (lock 取得済) のタイミングで行う。
    pruneState(state); // メモリ上 state は更新されるが disk write はスキップ
    return state;
  } catch (parseErr) {
    // 1.2.92: corruption も backup
    if (parseErr && parseErr.name === 'SyntaxError') {
      const corruptPath = filePath + '.corrupt.' + Date.now();
      try {
        fs.copyFileSync(filePath, corruptPath);
        console.warn(`[live-monitor] live-monitor.json parse failed: ${filePath} → backup ${corruptPath}, error: ${parseErr.message}`);
      } catch (_) {}
      // 根本原因 5 の対策: .bak が存在すれば復元を試みる
      const bakPath = filePath + '.bak';
      try {
        const rawBak = JSON.parse(fs.readFileSync(bakPath, 'utf8'));
        const bakState = {
          updatedAt: rawBak && rawBak.updatedAt ? rawBak.updatedAt : null,
          sessions: rawBak && rawBak.sessions && typeof rawBak.sessions === 'object' ? rawBak.sessions : {},
          lastEvent: rawBak && rawBak.lastEvent ? rawBak.lastEvent : null,
          events: Array.isArray(rawBak && rawBak.events) ? rawBak.events : [],
        };
        // .bak から本体へ復元
        fs.copyFileSync(bakPath, filePath);
        console.warn(`[live-monitor] restored from ${bakPath}`);
        monitorCache.filePath = filePath;
        monitorCache.signature = getFileSignature(filePath);
        monitorCache.data = bakState;
        pruneState(bakState);
        return bakState;
      } catch (_) {
        // .bak も読めない場合は空フォールバック（最後の手段）
      }
    }
    const state = defaultState();
    monitorCache.filePath = filePath;
    monitorCache.signature = signature;
    monitorCache.data = state;
    return state;
  }
}

// 共通実装は src/file-lock.ts。詳細はそちらのコメント参照。
const { acquireFileLock: _acquireFileLock, releaseFileLock, atomicWriteJson } = require('./file-lock');

// 根本原因 1 の対策: ロック取得失敗時に null を返してロック無し書き込みを続行する
// 旧実装を廃止。取得失敗は呼び出し元に throw する。
// (write を伴う操作はロックを必須とし、読み取り専用の呼び出しは別経路にする)
function acquireFileLock(filePath) {
  return _acquireFileLock(filePath, { label: 'live-monitor', maxWaitMs: 3000 });
}

function writeState(state) {
  // 根本原因 5 の対策: 書き込み直前に現在の正常値を .bak として保存
  const filePath = getLiveMonitorFile();
  if (fs.existsSync(filePath)) {
    try { fs.copyFileSync(filePath, filePath + '.bak'); } catch (_) { /* backup 失敗は致命的でない */ }
  }
  // 根本原因 1・2 の対策: copyFileSync フォールバックを撤廃し atomicWriteJson に統一
  atomicWriteJson(filePath, JSON.stringify(state, null, 2));
  monitorCache.filePath = filePath;
  monitorCache.signature = getFileSignature(filePath);
  monitorCache.data = state;
}

function normalizeEntry(companyNo, patch) {
  const next = { ...(patch || {}) };
  next.companyNo = Number(companyNo);
  next.updatedAt = next.updatedAt || new Date().toISOString();
  if (next.latestScreenshot) next.latestScreenshot = path.resolve(next.latestScreenshot);
  return next;
}

function serializeEntry(entry) {
  if (!entry) return null;
  return {
    ...entry,
    latestScreenshotName: entry.latestScreenshot ? path.basename(entry.latestScreenshot) : null,
  };
}

function toComparableSnapshot(entry) {
  if (!entry) return null;
  return JSON.stringify({
    companyNo: entry.companyNo != null ? Number(entry.companyNo) : null,
    companyName: entry.companyName || '',
    status: entry.status || '',
    step: entry.step || '',
    currentUrl: entry.currentUrl || entry.formUrl || '',
    latestScreenshot: entry.latestScreenshot ? path.resolve(entry.latestScreenshot) : '',
    active: entry.active !== false,
  });
}

function appendEvent(state, previous, next, kind) {
  if (toComparableSnapshot(previous) === toComparableSnapshot(next)) return;
  const event = {
    ...next,
    kind: kind || 'update',
    currentUrl: next.currentUrl || next.formUrl || '',
  };
  state.events = [event, ...(Array.isArray(state.events) ? state.events : [])].slice(0, MAX_MONITOR_EVENTS_STORED);
}

/**
 * @typedef {Object} LiveMonitorEntry
 * @property {number} companyNo
 * @property {string} [companyName]
 * @property {string} [status]
 * @property {string} [step]
 * @property {string} [currentUrl]
 * @property {string} [formUrl]
 * @property {string} [latestScreenshot]
 * @property {string|null} [latestScreenshotName]
 * @property {boolean} [active]
 * @property {string} [updatedAt]
 * @property {string} [finishedAt]
 * @property {string} [kind]
 */

/**
 * @typedef {Object} LiveMonitorSummary
 * @property {number} activeCount
 * @property {LiveMonitorEntry|null} primary
 * @property {Array<LiveMonitorEntry>} events
 * @property {string|null} updatedAt
 */

/**
 * 企業のライブモニタ状態を更新する。最終ステータスなら自動でセッション終了扱い。
 * @param {number|string} companyNo - 企業番号
 * @param {Partial<LiveMonitorEntry>} [patch] - 更新する項目
 * @returns {LiveMonitorEntry|null} 更新後のエントリ（serialize 済み）
 */
function updateLiveMonitor(companyNo, patch: Record<string, unknown> = {}) {
  installLiveMonitorExitHooks();
  const key = String(companyNo);
  // v2.0.21: lock を取らずに in-memory cache に更新。disk write は debounce。
  // 最終ステータス (final status) の場合だけ即 flush して永続化。
  if (!monitorCache.data) {
    const filePath = getLiveMonitorFile();
    // 初期化時の readState はロック任意 (読み取りのみ)。失敗してもフォールバック可。
    let lockFile: string | null = null;
    try { lockFile = _acquireFileLock(filePath, { label: 'live-monitor-init', maxWaitMs: 1500 }); } catch (_) { /* ignore */ }
    try { monitorCache.data = readState(); }
    finally { releaseFileLock(lockFile); }
  }
  const state = monitorCache.data;
  const previous = state.sessions[key] || null;
  const next: any = {
    ...(previous || {}),
    ...normalizeEntry(companyNo, patch),
    active: patch.active !== undefined ? patch.active : true,
  };
  const shouldCloseSession = next.active === false || isFinalStatus(next);
  if (shouldCloseSession) {
    next.active = false;
    next.finishedAt = patch.finishedAt || next.finishedAt || new Date().toISOString();
    delete state.sessions[key];
    state.lastEvent = next;
  } else {
    state.sessions[key] = next;
  }
  state.updatedAt = next.updatedAt;
  appendEvent(state, previous, next, patch.kind || (shouldCloseSession ? 'finish' : 'update'));
  if (shouldCloseSession) {
    // 最終状態は即 flush でクラッシュ時にも残す
    flushLiveMonitorNow();
  } else {
    scheduleLiveMonitorFlush();
  }
  return serializeEntry(next);
}

/**
 * 企業のセッションを終了状態としてモニタに記録する。
 * @param {number|string} companyNo - 企業番号
 * @param {Partial<LiveMonitorEntry>} [patch] - 終了時に上書きする項目
 * @returns {LiveMonitorEntry|null} 終了エントリ（serialize 済み）
 */
function finishLiveMonitor(companyNo, patch: Record<string, unknown> = {}) {
  const filePath = getLiveMonitorFile();
  const lockFile = acquireFileLock(filePath);
  try {
    const key = String(companyNo);
    monitorCache.signature = null;
    const state = readState();
    const previous = state.sessions[key] || null;
    const next = {
      ...(previous || { companyNo: Number(companyNo) }),
      ...normalizeEntry(companyNo, patch),
      active: false,
      finishedAt: patch.finishedAt || new Date().toISOString(),
    };
    delete state.sessions[key];
    state.lastEvent = next;
    state.updatedAt = next.updatedAt;
    appendEvent(state, previous, next, patch.kind || 'finish');
    writeState(state);
    return serializeEntry(next);
  } finally {
    releaseFileLock(lockFile);
  }
}

/**
 * 企業のアクティブセッションだけを削除する（events / lastEvent は残す）。
 * @param {number|string} companyNo - 企業番号
 * @returns {boolean} 該当セッションがあって削除した場合 true
 */
function clearLiveMonitor(companyNo) {
  const filePath = getLiveMonitorFile();
  const lockFile = acquireFileLock(filePath);
  try {
    const key = String(companyNo);
    monitorCache.signature = null;
    const state = readState();
    if (!state.sessions[key]) return false;
    delete state.sessions[key];
    state.updatedAt = new Date().toISOString();
    writeState(state);
    return true;
  } finally {
    releaseFileLock(lockFile);
  }
}

/**
 * 企業に関連するセッション・events・lastEvent を全て削除する。
 * @param {number|string} companyNo - 企業番号
 * @returns {boolean} 何かを削除した場合 true
 */
function removeCompanyMonitor(companyNo) {
  const filePath = getLiveMonitorFile();
  const lockFile = acquireFileLock(filePath);
  try {
    const key = String(companyNo);
    monitorCache.signature = null;
    const state = readState();
    let changed = false;

    if (state.sessions && state.sessions[key]) {
      delete state.sessions[key];
      changed = true;
    }

    if (Array.isArray(state.events)) {
      const nextEvents = state.events.filter((entry: any) => String(entry && entry.companyNo) !== key);
      if (nextEvents.length !== state.events.length) {
        state.events = nextEvents;
        changed = true;
      }
    }

    if (state.lastEvent && String(state.lastEvent.companyNo) === key) {
      state.lastEvent = null;
      changed = true;
    }

    if (!changed) return false;
    state.updatedAt = new Date().toISOString();
    writeState(state);
    return true;
  } finally {
    releaseFileLock(lockFile);
  }
}

/**
 * ダッシュボード表示用のライブモニタサマリーを取得する。
 * @returns {LiveMonitorSummary} アクティブ件数・代表セッション・履歴イベント
 */
function getLiveMonitorSummary() {
  const state = readState();
  const sessions = Object.values(state.sessions || {})
    .sort((a: any, b: any) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime());
  const candidates = [...sessions];
  if (state.lastEvent) candidates.push(state.lastEvent);
  const primary = candidates
    .sort((a: any, b: any) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime())[0] || null;
  const activeSessions = sessions.filter((entry: any) => entry && entry.active !== false && !isFinalStatus(entry));
  const history = Array.isArray(state.events) ? [...state.events] : [];
  const fallbackEvents = [...sessions];
  if (state.lastEvent) fallbackEvents.push(state.lastEvent);
  fallbackEvents.forEach((entry: any) => {
    const snapshot = toComparableSnapshot(entry);
    const exists = history.some((event: any) => toComparableSnapshot(event) === snapshot);
    if (!exists) history.push(entry);
  });
  return {
    activeCount: activeSessions.length,
    primary: serializeEntry(primary),
    events: history
      .map(serializeEntry)
      .sort((a: any, b: any) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime())
      .slice(0, MAX_MONITOR_EVENTS_SUMMARY),
    updatedAt: state.updatedAt,
  };
}

/**
 * ライブモニタ JSON ファイルの絶対パスを返す（getLiveMonitorFile のエイリアス）。
 * @returns {string} ファイルパス
 */
function getMonitorFile() {
  return getLiveMonitorFile();
}

/**
 * 現在の代表セッション 1 件を返す（旧 API 互換用）。
 * @returns {LiveMonitorEntry|null} 代表エントリ
 */
function readLiveMonitor() {
  return getLiveMonitorSummary().primary;
}

/**
 * 旧名互換: readLiveMonitor() と同じ。
 * @returns {LiveMonitorEntry|null} 代表エントリ
 */
function readMonitorState() {
  return readLiveMonitor();
}

module.exports = {
  clearLiveMonitor,
  finishLiveMonitor,
  getLiveMonitorFile,
  getMonitorFile,
  getLiveMonitorSummary,
  readLiveMonitor,
  readMonitorState,
  removeCompanyMonitor,
  updateLiveMonitor,
};

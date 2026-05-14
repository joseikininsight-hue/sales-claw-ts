'use strict';

// Run Manager — list-builder の実行単位 (run) を管理する
//
// 要件§9.5 / §12 / §14:
//   - 各 run は ID を持ち、状態 (queued/running/completed/failed/cancelled/partial)
//     を持つ
//   - checkpoint を data/list-builder/runs/{runId}/ に保存
//   - cancel: 実行中ランを停止
//   - retry-failed: failed/blocked のみ再実行
//   - 保持期間: cacheTtlDays (default 30)
//
// 永続化:
//   data/list-builder/runs/{runId}/run.json     - メタ情報
//   data/list-builder/runs/{runId}/candidates.json - 取得した候補
//   data/list-builder/runs/{runId}/checkpoint.json - 中断時の進捗

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { resolveDataPath, ensureDataDir } = require('../data-paths');
const { acquireFileLock: _acquireFileLock, releaseFileLock } = require('../file-lock');

const VALID_STATUSES = new Set([
  'queued', 'running', 'completed', 'failed', 'cancelled', 'partial',
]);

// メモリ内 run 状態 (cancel フラグなど揮発性のもの)
const liveState = new Map<any, any>();

function getRunsDir() {
  return resolveDataPath('list-builder', 'runs');
}

function getArtifactDir(kind) {
  if (!/^(evidence|lifecycle)$/.test(kind)) {
    throw new Error('invalid artifact kind');
  }
  return resolveDataPath('list-builder', kind);
}

function getRunDir(runId) {
  if (!runId || !/^run_[a-z0-9_-]+$/i.test(runId)) {
    throw new Error('invalid runId');
  }
  return path.join(getRunsDir(), runId);
}

function ensureRunDir(runId) {
  const dir = getRunDir(runId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function generateRunId() {
  const ts = Date.now().toString(36);
  const rnd = crypto.randomBytes(4).toString('hex');
  return `run_${ts}_${rnd}`;
}

function payloadHash(payload) {
  try {
    const text = JSON.stringify(payload || {});
    return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
  } catch (_) {
    return '';
  }
}

// JSON ファイル atomic 書き込み
function writeJsonAtomic(filePath, data) {
  ensureDataDir();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmpFile = filePath + '.tmp.' + process.pid;
  fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2), 'utf-8');
  try {
    fs.renameSync(tmpFile, filePath);
  } catch (e) {
    if (process.platform === 'win32' && (e.code === 'EPERM' || e.code === 'EBUSY')) {
      fs.copyFileSync(tmpFile, filePath);
      try { fs.unlinkSync(tmpFile); } catch (_) {}
    } else {
      try { fs.unlinkSync(tmpFile); } catch (_) {}
      throw e;
    }
  }
}

function readJsonSafe(filePath, fallback: any = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (_) {
    return fallback;
  }
}

function sanitizeArtifactId(value) {
  const text = String(value || '').trim();
  const safe = text.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 120);
  return safe || ('record_' + crypto.randomBytes(4).toString('hex'));
}

function acquireRunLock(runId) {
  try {
    return _acquireFileLock(path.join(getRunDir(runId), 'run.json'), {
      label: 'run-manager:' + runId, maxWaitMs: 3000,
    });
  } catch (_) {
    return null;
  }
}

// --- public API ---

// 新規 run を作成
//
// payload: 元のリクエスト payload
// mode: 'url' | 'nlq' | 'category'
function createRun({ mode, payload, requestedBy }) {
  if (!mode || typeof mode !== 'string') throw new Error('mode required');
  const runId = generateRunId();
  const dir = ensureRunDir(runId);
  const now = new Date().toISOString();
  const run = {
    runId,
    mode,
    status: 'queued',
    payloadHash: payloadHash(payload),
    startedAt: now,
    completedAt: null,
    totalCandidates: 0,
    verifiedCount: 0,
    newCount: 0,
    duplicateCount: 0,
    needsReviewCount: 0,
    failedCount: 0,
    blockedCount: 0,
    requestedBy: requestedBy || '',
    costEstimate: { serpApiRequests: 0, aiTokens: 0, estimatedJpy: 0 },
    loosenedConditions: [],
  };
  writeJsonAtomic(path.join(dir, 'run.json'), run);
  // payload は別ファイルに（再実行用）
  writeJsonAtomic(path.join(dir, 'payload.json'), payload || {});
  return run;
}

// run を取得
function getRun(runId) {
  try {
    return readJsonSafe(path.join(getRunDir(runId), 'run.json'));
  } catch (_) {
    return null;
  }
}

// run のメタ情報を更新
function updateRun(runId, updates) {
  const dir = getRunDir(runId);
  const lock = acquireRunLock(runId);
  if (!lock) return { ok: false, error: 'failed to acquire lock' };
  try {
    const current = readJsonSafe(path.join(dir, 'run.json'), null);
    if (!current) return { ok: false, error: 'run not found' };
    const next = { ...current, ...updates };
    if (updates.status === 'completed' || updates.status === 'failed'
        || updates.status === 'cancelled' || updates.status === 'partial') {
      if (!next.completedAt) next.completedAt = new Date().toISOString();
    }
    writeJsonAtomic(path.join(dir, 'run.json'), next);
    return { ok: true, run: next };
  } finally {
    releaseFileLock(lock);
  }
}

// 候補一覧を保存（最新で上書き）
// 1.2.92 C2 fix: file-lock で concurrent write を排他化
// 旧: orchestrator が saveCandidates と cancel-handler の saveCheckpoint を
// 同時実行すると、片方が部分書込状態の上書きを起こす race。
function saveCandidates(runId, candidates) {
  const dir = ensureRunDir(runId);
  const filePath = path.join(dir, 'candidates.json');
  const lock = acquireRunLock(runId);
  try {
    writeJsonAtomic(filePath, {
      savedAt: new Date().toISOString(),
      candidates: Array.isArray(candidates) ? candidates : [],
    });
  } finally {
    releaseFileLock(lock);
  }
  return { ok: true };
}

function loadCandidates(runId) {
  try {
    const data = readJsonSafe(path.join(getRunDir(runId), 'candidates.json'), null);
    return data ? data.candidates : [];
  } catch (_) {
    return [];
  }
}

// チェックポイント保存
// 1.2.92 C2 fix: file-lock で concurrent write を排他化
function saveCheckpoint(runId, checkpoint) {
  const dir = ensureRunDir(runId);
  const lock = acquireRunLock(runId);
  try {
    writeJsonAtomic(path.join(dir, 'checkpoint.json'), {
      savedAt: new Date().toISOString(),
      checkpoint,
    });
  } finally {
    releaseFileLock(lock);
  }
}

function loadCheckpoint(runId) {
  try {
    const data = readJsonSafe(path.join(getRunDir(runId), 'checkpoint.json'), null);
    return data ? data.checkpoint : null;
  } catch (_) {
    return null;
  }
}

// payload を取得
function loadPayload(runId) {
  try {
    return readJsonSafe(path.join(getRunDir(runId), 'payload.json'), null);
  } catch (_) {
    return null;
  }
}

function saveCommittedRecordArtifacts({ runId, targetNo, record }) {
  if (!record || typeof record !== 'object') return { ok: false, error: 'record required' };
  const recordId = sanitizeArtifactId(record.id || record.recordId || `target_${targetNo}`);
  const now = new Date().toISOString();

  const evidencePath = path.join(getArtifactDir('evidence'), recordId + '.json');
  writeJsonAtomic(evidencePath, {
    version: 1,
    recordId,
    targetNo,
    runId: runId || '',
    savedAt: now,
    evidence: Array.isArray(record.evidence) ? record.evidence : [],
    fieldConfidence: (record.fieldConfidence && typeof record.fieldConfidence === 'object')
      ? record.fieldConfidence
      : {},
  });

  const lifecyclePath = path.join(getArtifactDir('lifecycle'), recordId + '.json');
  writeJsonAtomic(lifecyclePath, {
    version: 1,
    recordId,
    targetNo,
    runId: runId || '',
    committedAt: now,
    discoveredAt: record.discoveredAt || '',
    discoverySource: record.discoverySource || '',
    sourceListUrl: record.sourceListUrl || '',
    lastVerifiedAt: record.lastVerifiedAt || '',
    collectionStatus: record.collectionStatus || '',
    doNotContactReason: record.doNotContactReason || '',
    dedupeDecision: record.dedupeDecision || '',
    dedupeMatchKey: record.dedupeMatchKey || '',
    riskFlags: Array.isArray(record.riskFlags) ? record.riskFlags : [],
  });

  return { ok: true, recordId, evidencePath, lifecyclePath };
}

// 全 run を一覧（メタ情報のみ）
function listRuns(filter: Record<string, any> = {}) {
  const runsDir = getRunsDir();
  if (!fs.existsSync(runsDir)) return [];
  const dirs = fs.readdirSync(runsDir).filter((d: any) => /^run_/.test(d));
  const results: any[] = [];
  for (const d of dirs) {
    const run = readJsonSafe(path.join(runsDir, d, 'run.json'), null);
    if (run) {
      if (filter.status && run.status !== filter.status) continue;
      if (filter.mode && run.mode !== filter.mode) continue;
      results.push(run);
    }
  }
  // 新しい順
  results.sort((a: any, b: any) => (b.startedAt || '').localeCompare(a.startedAt || ''));
  return results;
}

// run を削除（ディレクトリ全体）
function deleteRun(runId) {
  const dir = getRunDir(runId);
  if (!fs.existsSync(dir)) return { ok: false, error: 'not found' };
  fs.rmSync(dir, { recursive: true, force: true });
  liveState.delete(runId);
  return { ok: true };
}

// --- cancel / retry ---

function requestCancel(runId) {
  let state = liveState.get(runId);
  if (!state) {
    state = { cancelled: false };
    liveState.set(runId, state);
  }
  state.cancelled = true;
  // 永続化メタも更新
  updateRun(runId, { status: 'cancelled' });
  return { ok: true };
}

function isCancelled(runId) {
  const state = liveState.get(runId);
  return !!(state && state.cancelled);
}

function clearLiveState(runId) {
  liveState.delete(runId);
}

// 古い run を削除（cacheTtlDays 経過）
function cleanupOldRuns(ttlDays = 30) {
  const runs = listRuns();
  const cutoff = Date.now() - ttlDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const run of runs) {
    const startedMs = Date.parse(run.startedAt || '') || 0;
    if (startedMs > 0 && startedMs < cutoff) {
      const r = deleteRun(run.runId);
      if (r.ok) removed++;
    }
  }
  return { ok: true, removed };
}

module.exports = {
  generateRunId,
  payloadHash,
  createRun,
  getRun,
  updateRun,
  saveCandidates,
  loadCandidates,
  saveCheckpoint,
  loadCheckpoint,
  loadPayload,
  saveCommittedRecordArtifacts,
  listRuns,
  deleteRun,
  requestCancel,
  isCancelled,
  clearLiveState,
  cleanupOldRuns,
  // テスト用
  _internal: {
    VALID_STATUSES,
    getRunsDir,
    getRunDir,
    getArtifactDir,
    liveState,
  },
};

'use strict';

/**
 * dashboard-server.lock の I/O 専用モジュール (Stage 4 分割の第1段)
 * ─────────────────────────────────────────────────────────────────
 *
 * dashboard-server.ts (9540 行) から純粋な lock ファイル I/O を切り出した。
 *
 * ロック取得・解放の状態管理 (`standaloneDashboardLockHeld` フラグや
 * `claimStandaloneDashboardLock` / `releaseStandaloneDashboardLock` /
 * `ensureStandaloneDashboardLockHooks`) はサーバープロセス状態に密結合
 * しているため dashboard-server.ts に残置する。
 *
 * 本ファイルは「ファイルにどう書く / 読むか」だけを担当し、
 * dashboard-server.ts はそれを使って排他制御ロジックを組み立てる。
 *
 * 関連: docs/dashboard-port-lifecycle.md
 */

import * as fs from 'fs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { resolveDataPath, ensureDataDir } = require('./data-paths');

export interface DashboardLockPayload {
  /** ロック保持プロセスの PID */
  pid: number;
  /** ISO 8601 タイムスタンプ */
  startedAt: string;
  /** 起動時の cwd (デバッグ用) */
  cwd: string;
}

/**
 * Lock ファイルのパス (resolveDataPath('dashboard-server.lock'))。
 */
export function getDashboardLockFile(): string {
  return resolveDataPath('dashboard-server.lock');
}

/**
 * Lock ファイルを安全に読む。ファイル無し / 壊れた JSON は null。
 */
export function readDashboardLock(): Partial<DashboardLockPayload> | null {
  const lockFile = getDashboardLockFile();
  if (!fs.existsSync(lockFile)) return null;
  try {
    return JSON.parse(fs.readFileSync(lockFile, 'utf8')) as Partial<DashboardLockPayload>;
  } catch {
    return null;
  }
}

/**
 * Lock ファイルを書く。data dir が無ければ作る。
 */
export function writeDashboardLock(payload: DashboardLockPayload): void {
  ensureDataDir();
  fs.writeFileSync(getDashboardLockFile(), JSON.stringify(payload, null, 2), 'utf8');
}

/**
 * Lock ファイルを削除する。ファイル無しは no-op。例外は飲み込む (best-effort)。
 */
export function removeDashboardLock(): boolean {
  const lockFile = getDashboardLockFile();
  try {
    if (fs.existsSync(lockFile)) {
      fs.unlinkSync(lockFile);
      return true;
    }
  } catch {
    // best-effort
  }
  return false;
}

/**
 * PID が生きているか判定 (process.kill(pid, 0) による存在確認)。
 *
 * - 0 / 負数 / NaN は false (旧形式 lock には PID が無いケースの fallback)
 * - EPERM (権限なし) は alive とみなす (プロセス存在は確定)
 * - ESRCH は dead
 *
 * dashboard-runtime.ts の isPidAlive と同一実装。重複だが循環依存を避けるため
 * 各モジュールで独立実装する (どちらも数行)。
 */
export function isProcessAlive(pid: unknown): boolean {
  const normalized = Number(pid);
  if (!Number.isFinite(normalized) || normalized <= 0) return false;
  try {
    process.kill(normalized, 0);
    return true;
  } catch (err: any) {
    if (err && err.code === 'EPERM') return true;
    return false;
  }
}

module.exports = {
  getDashboardLockFile,
  readDashboardLock,
  writeDashboardLock,
  removeDashboardLock,
  isProcessAlive,
};

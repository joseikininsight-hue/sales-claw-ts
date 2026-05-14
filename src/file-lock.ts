// Cross-process file lock helper.
//
// 旧実装 (action-logger.cjs / live-monitor.cjs / contact-history.cjs に
// コピペで存在) は以下の問題を抱えていた:
//
//  1. busy-wait `while (Date.now() < waitEnd) {}` で main thread を最大
//     50 ms × 60 回 = 3 秒 完全停止。SSE / HTTP / heartbeat も止まる。
//  2. 3 秒タイムアウト後に lock ファイルを「強制削除」して再取得していた。
//     先行プロセスが正常稼働中でも横取りされ、排他保証が壊れる。
//  3. 同じロジックが 3 ファイルに重複していて、修正のたびにドリフト。
//
// このモジュールでは:
//
//  - **Atomics.wait** で busy-wait を排除。Atomics.wait(unshared, 0, 0, ms)
//    は OS レベル sleep (CPU 消費なし、event loop タイマーには影響なし)。
//  - **PID 生存チェック** で stale lock 判定。先行プロセスが本当に死んでいる
//    場合のみ force-take。生きている場合は素直にタイムアウト失敗を返す。
//  - 共通モジュール 1 ヶ所に集約 → ドリフト解消。

import * as fs from 'fs';

export interface AcquireFileLockOptions {
  /** 最大待機時間 (ms)。default 3000 */
  maxWaitMs?: number;
  /** このミリ秒以上 mtime が古ければ stale 判定。default 10000 */
  staleAfterMs?: number;
  /** エラーメッセージ用のオーナー名 (例: 'action-logger') */
  label?: string;
}

/** sleep without busy-loop. Atomics.wait は SAB が必須なので毎回作る。 */
function _sleepSync(ms: number): void {
  if (ms <= 0) return;
  const sab = new SharedArrayBuffer(4);
  const view = new Int32Array(sab);
  // Atomics.wait は実際の値が expected と一致する場合のみ wait。
  // 0 == 0 なので timeout まで block。OS レベル sleep。
  Atomics.wait(view, 0, 0, ms);
}

/** PID が存在する (= プロセスが生きている) かチェック。 */
function _isPidAlive(pid: number | null | undefined): boolean {
  if (!Number.isFinite(pid as number) || (pid as number) <= 0) return false;
  try {
    // process.kill(pid, 0) はシグナル送信せず存在チェックだけする。
    // Windows でも POSIX でも動作。
    process.kill(pid as number, 0);
    return true;
  } catch (e: unknown) {
    // EPERM = プロセスは存在するが他ユーザーのもの (= 生きている)
    if (e && typeof e === 'object' && 'code' in e && (e as { code?: string }).code === 'EPERM') {
      return true;
    }
    return false;
  }
}

/** lockfile の中身から所有者 PID を読む。読めなければ null。 */
function _readLockHolderPid(lockFile: string): number | null {
  try {
    const raw = fs.readFileSync(lockFile, 'utf8').trim();
    const pid = parseInt(raw, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** lockfile が stale (= 先行プロセスが死んでいる、または mtime が古すぎる) か判定。 */
function _isStaleLock(lockFile: string, staleAfterMs: number): boolean {
  let stat: fs.Stats;
  try { stat = fs.statSync(lockFile); }
  catch { return true; /* 存在しないなら stale 扱い (race) */ }

  // PID-based check が最優先 (確実)
  const pid = _readLockHolderPid(lockFile);
  if (pid !== null && pid !== process.pid && !_isPidAlive(pid)) {
    return true;
  }
  // 万一 PID が読めない場合は mtime で fallback
  if (Date.now() - stat.mtimeMs > staleAfterMs) return true;
  return false;
}

/**
 * 排他ロックを取得する。
 *
 * @param filePath - ロック対象ファイル (実際のロックは filePath + '.lock')
 * @returns 取得した lockfile のパス。リリース時に releaseFileLock() に渡す。
 * @throws Error maxWaitMs を超えても取得できなかった場合 (force-take しない)
 */
export function acquireFileLock(filePath: string, options: AcquireFileLockOptions = {}): string {
  const lockFile = filePath + '.lock';
  const maxWaitMs = Number.isFinite(options.maxWaitMs) ? options.maxWaitMs! : 3000;
  const staleAfterMs = Number.isFinite(options.staleAfterMs) ? options.staleAfterMs! : 10000;
  const label = options.label ?? 'file-lock';

  const deadline = Date.now() + maxWaitMs;
  let attempt = 0;
  while (Date.now() < deadline) {
    try {
      // O_EXCL 相当: 既存だと EEXIST、無ければ作る
      fs.writeFileSync(lockFile, String(process.pid), { flag: 'wx' });
      return lockFile;
    } catch (e: unknown) {
      const code = (e && typeof e === 'object' && 'code' in e) ? (e as { code?: string }).code : undefined;
      if (code !== 'EEXIST') {
        // ENOENT (親ディレクトリ無い) などは早期に throw
        throw e;
      }
      // EEXIST: 先行ロックが存在 → stale なら掃除して即リトライ、生きてるなら sleep
      if (_isStaleLock(lockFile, staleAfterMs)) {
        try { fs.unlinkSync(lockFile); } catch { /* ignore */ }
        continue; // 即リトライ (sleep 不要)
      }
      // 指数バックオフ: 1ms, 2ms, 4ms, 8ms, ... 最大 50ms
      const sleepMs = Math.min(50, 1 << Math.min(attempt, 5));
      attempt += 1;
      _sleepSync(sleepMs);
    }
  }

  // タイムアウト. ★ 旧実装は force-take していたが、生きているプロセスから
  // ロックを横取りすると排他保証が壊れるので、ここでは throw する。
  // 呼び出し側が「ロックなしでも続行する」ポリシーなら、try/catch で握り潰し。
  const heldBy = _readLockHolderPid(lockFile);
  const heldByLabel = heldBy ? `pid=${heldBy}, alive=${_isPidAlive(heldBy)}` : 'unknown';
  throw new Error(`[${label}] file lock timeout after ${maxWaitMs}ms (held by ${heldByLabel}): ${lockFile}`);
}

/**
 * ロックを解放する。自分で取ったロック以外は触らない (PID 確認)。
 */
export function releaseFileLock(lockFile: string | null | undefined): void {
  if (!lockFile) return;
  try {
    const pid = _readLockHolderPid(lockFile);
    if (pid !== null && pid !== process.pid) return; // 他者のロックは触らない
    fs.unlinkSync(lockFile);
  } catch {
    // 既に消えている等は問題なし
  }
}

module.exports = {
  acquireFileLock,
  releaseFileLock,
};

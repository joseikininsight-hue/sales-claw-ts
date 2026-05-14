// Async, size-rotated, append-only log writer.
//
// 設計動機 (Audit H2 + H8 への統合対応):
//
//  - **H2 (PTY 同期 I/O)**: `appendFileSync` は AI セッション中の 50–200
//    chunk/s で main thread を直接ブロックする。HTTP / SSE / heartbeat の
//    レイテンシが目に見えて悪化する。本モジュールは fire-and-forget な
//    async キューに置換し、呼び出し側は即座にリターンする。
//
//  - **H8 (ログ無限増殖)**: dashboard-diagnostics.jsonl / ai-run-metrics.jsonl
//    / ai-runs/*.log がいずれも上限なしで成長していた。数日で GB 級に到達
//    して SSD 圧迫 + appendFileSync 自体も低速化する。本モジュールは
//    バイト数閾値ベースで `.1` バックアップに 1 段ローテートする。

import * as fs from 'fs';
import * as path from 'path';

export interface LogWriterOptions {
  /** ローテート閾値 (default: 5 MiB) */
  maxBytes?: number;
}

interface QueueState {
  buffer: string[];
  writing: boolean;
  /** 起動後に file size を 1 度だけ stat した値 + 累積追加分。SIZE_UNKNOWN なら未取得 */
  sizeBytes: number;
  options: Required<LogWriterOptions>;
}

/** ファイル毎の書込みキュー & 状態。 */
const _queues = new Map<string, QueueState>();

/** デフォルト上限 5 MiB。pty-log は 1 MiB を明示指定。 */
export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

/** sizeBytes が未取得を表すセンチネル。 */
const SIZE_UNKNOWN = -1;

function _ensureParentDir(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function _getQueue(filePath: string, options?: LogWriterOptions): QueueState {
  let q = _queues.get(filePath);
  if (!q) {
    q = {
      buffer: [],
      writing: false,
      sizeBytes: SIZE_UNKNOWN,
      options: { maxBytes: options?.maxBytes ?? DEFAULT_MAX_BYTES },
    };
    _queues.set(filePath, q);
  } else if (options) {
    // 異なる options 指定があれば options 部分のみ上書き
    q.options = { ...q.options, ...options };
  }
  return q;
}

/** Async でログ行を append する。呼び出し側は即時にリターン。 */
export function appendLine(filePath: string, text: string, options: LogWriterOptions = {}): void {
  if (typeof filePath !== 'string' || !filePath) return;
  if (typeof text !== 'string' || text.length === 0) return;
  const q = _getQueue(filePath, options);
  q.buffer.push(text);
  _scheduleDrain(filePath);
}

function _scheduleDrain(filePath: string): void {
  const q = _queues.get(filePath);
  if (!q || q.writing || q.buffer.length === 0) return;
  q.writing = true;
  setImmediate(() => {
    _drain(filePath).catch(() => { /* 個別ファイルのエラーは握り潰す */ });
  });
}

async function _drain(filePath: string): Promise<void> {
  const q = _queues.get(filePath);
  if (!q) return;
  try {
    while (q.buffer.length > 0) {
      // 最初の書込みでだけ stat する。以後は累積管理。
      if (q.sizeBytes === SIZE_UNKNOWN) {
        try { q.sizeBytes = (await fs.promises.stat(filePath)).size; }
        catch { q.sizeBytes = 0; }
      }

      const maxBytes = q.options.maxBytes || DEFAULT_MAX_BYTES;
      if (q.sizeBytes > 0 && q.sizeBytes >= maxBytes) {
        await _rotateAsync(filePath);
        q.sizeBytes = 0;
      }

      // バッファ全部を 1 回でフラッシュ (multiple appendFile syscall を avoid)
      const chunk = q.buffer.splice(0, q.buffer.length).join('');
      try { _ensureParentDir(filePath); } catch { /* ignore */ }
      await fs.promises.appendFile(filePath, chunk, 'utf8');
      q.sizeBytes += chunk.length;
    }
  } finally {
    q.writing = false;
    // drain 中に新しい行が来ていれば再起動
    if (q.buffer.length > 0) _scheduleDrain(filePath);
  }
}

async function _rotateAsync(filePath: string): Promise<void> {
  const backup = filePath + '.1';
  try { await fs.promises.unlink(backup); } catch { /* ignore */ }
  try { await fs.promises.rename(filePath, backup); } catch { /* ignore */ }
}

function _rotateSync(filePath: string): void {
  const backup = filePath + '.1';
  try { fs.unlinkSync(backup); } catch { /* ignore */ }
  try { fs.renameSync(filePath, backup); } catch { /* ignore */ }
}

/**
 * 全 queue が drain されるまで待つ (graceful shutdown 用)。
 * timeoutMs を超えたら諦めて返す。
 */
export async function flushAll(timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const promises: Promise<void>[] = [];
  for (const filePath of _queues.keys()) {
    promises.push(_waitForDrain(filePath, deadline));
  }
  await Promise.all(promises);
}

function _waitForDrain(filePath: string, deadline: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const tick = (): void => {
      const q = _queues.get(filePath);
      if (!q || (!q.writing && q.buffer.length === 0)) { resolve(); return; }
      if (Date.now() >= deadline) { resolve(); return; }
      setTimeout(tick, 20);
    };
    tick();
  });
}

/**
 * 全 queue を sync で強制フラッシュ。SIGINT / SIGTERM / uncaughtException
 * 経由の gracefulShutdown 内で、event loop が止まる前の最後の保険。
 *
 * 通常の fast-path では使わない (sync I/O = main thread block)。
 */
export function flushAllSync(): void {
  for (const [filePath, q] of _queues.entries()) {
    if (q.buffer.length === 0) continue;
    try {
      const chunk = q.buffer.splice(0, q.buffer.length).join('');
      const maxBytes = q.options.maxBytes || DEFAULT_MAX_BYTES;

      let sizeBytes = q.sizeBytes;
      if (sizeBytes === SIZE_UNKNOWN) {
        try { sizeBytes = fs.statSync(filePath).size; } catch { sizeBytes = 0; }
      }
      if (sizeBytes > 0 && sizeBytes >= maxBytes) {
        _rotateSync(filePath);
        sizeBytes = 0;
      }

      try { _ensureParentDir(filePath); } catch { /* ignore */ }
      fs.appendFileSync(filePath, chunk, 'utf8');
      q.sizeBytes = sizeBytes + chunk.length;
    } catch {
      // shutdown 中なのでログを書き残せなくても致命ではない
    }
  }
}

/** テスト用: 内部状態をリセット (queue を全部捨てる)。本番コードからは呼ばない。 */
export function _resetForTesting(): void {
  _queues.clear();
}

module.exports = {
  DEFAULT_MAX_BYTES,
  appendLine,
  flushAll,
  flushAllSync,
  _resetForTesting,
};

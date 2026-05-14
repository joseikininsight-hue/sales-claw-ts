// Startup cleanup utility
//
// data ディレクトリに残存する `.tmp.<PID>` / `.lock` ファイルのうち、
// 一定時間以上古いものを削除する。並列書き込み失敗や異常終了で
// 残ったゴミファイルを、アプリ起動時にまとめて掃除するために使う。
//
// - ログ出力はせず、結果オブジェクトを返すので、呼び出し側で
//   出力制御する（console.log などは呼び出し側で）
// - テスト容易性のため、オプションで `dataDir` / `maxAgeMs` / `now`
//   を差し替え可能

import * as fs from 'fs';
import * as path from 'path';
import { getDataDir, PROJECT_ROOT } from './data-paths';

/** デフォルトの「古い」閾値: 24 時間 */
export const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** `foo.json.tmp.12345` のような一時書き込みファイル */
const TMP_PATTERN = /\.tmp\.\d+$/;

/** `foo.lock` のようなロックファイル */
const LOCK_PATTERN = /\.lock$/;

/**
 * 誤爆防止: これらの名前は古くても削除しない。
 * 稼働中プロセスが抱えているロックが 24h 以上生きていることは稀だが、
 * 保険として重要ロックを明示的に保護する。
 */
const PROTECTED_NAMES = new Set<string>([
  'action-log.json.lock',
  'contact-history.json.lock',
  'live-monitor.json.lock',
  'settings.json.lock',
]);

/** サブディレクトリ再帰上限（recovery/ など 1 階層で十分） */
const MAX_SUBDIR_DEPTH = 2;

export interface CleanupOptions {
  dataDir?: string;
  maxAgeMs?: number;
  now?: number;
  allowedRoots?: string[];
}

export interface CleanupRemoved {
  path: string;
  ageMs: number;
  kind: 'tmp' | 'lock';
}

export interface CleanupError {
  path: string;
  error: string;
}

export interface CleanupResult {
  removed: CleanupRemoved[];
  errors: CleanupError[];
  scanned: number;
}

function isPathInsideRoot(target: string, root: string | null | undefined): boolean {
  if (!root) return true; // PROJECT_ROOT 未設定環境は素通し
  const relative = path.relative(root, target);
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export function cleanupStaleFiles(options: CleanupOptions = {}): CleanupResult {
  const dir = options.dataDir ?? getDataDir();
  const maxAgeMs = Number(options.maxAgeMs) > 0 ? Number(options.maxAgeMs) : DEFAULT_MAX_AGE_MS;
  const now = options.now ?? Date.now();
  const allowedRoots = Array.isArray(options.allowedRoots) && options.allowedRoots.length > 0
    ? options.allowedRoots
    : [PROJECT_ROOT, getDataDir()].filter((p): p is string => typeof p === 'string' && p.length > 0);
  const result: CleanupResult = { removed: [], errors: [], scanned: 0 };

  if (!fs.existsSync(dir)) return result;

  // 安全チェック: 走査対象が許可されたルート配下かを検証（任意パス走査を防止）
  const resolvedDir = path.resolve(dir);
  const isAllowed = allowedRoots.some((root: any) => {
    const resolvedRoot = path.resolve(root);
    return resolvedDir === resolvedRoot || isPathInsideRoot(resolvedDir, resolvedRoot);
  });
  if (!isAllowed) {
    result.errors.push({ path: resolvedDir, error: 'directory outside allowed roots; skipped' });
    return result;
  }

  walk(resolvedDir, 0, maxAgeMs, now, result);
  return result;
}

function walk(dir: string, depth: number, maxAgeMs: number, now: number, result: CleanupResult): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.errors.push({ path: dir, error: msg });
    return;
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth + 1 <= MAX_SUBDIR_DEPTH) walk(full, depth + 1, maxAgeMs, now, result);
      continue;
    }
    if (!entry.isFile()) continue;

    const isTmp = TMP_PATTERN.test(entry.name);
    const isLock = LOCK_PATTERN.test(entry.name);
    if (!isTmp && !isLock) continue;
    if (PROTECTED_NAMES.has(entry.name)) continue;

    result.scanned += 1;
    try {
      const stat = fs.statSync(full);
      if (!stat.isFile()) continue;
      const age = now - stat.mtimeMs;
      if (age < maxAgeMs) continue;
      fs.unlinkSync(full);
      result.removed.push({ path: full, ageMs: age, kind: isLock ? 'lock' : 'tmp' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push({ path: full, error: msg });
    }
  }
}

module.exports = { cleanupStaleFiles, DEFAULT_MAX_AGE_MS };

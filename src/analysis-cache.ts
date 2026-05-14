'use strict';

/**
 * Analysis Cache
 * ──────────────
 * 企業サイト分析結果 (analyzeCompanyLite の出力 + LLM 解析結果) を
 * ディスクにキャッシュし、同じ会社を再度分析する時にゼロトークンで返す。
 *
 * 背景:
 *   2026-06-15 から Anthropic Pro / Max プランの Programmatic Credit 枠が
 *   有限になる。同じ会社を 2 回・3 回と再分析していると、定額枠を
 *   無駄に食い潰す。
 *
 *   このプロジェクトでは:
 *     - 営業リストの「再投入」 (前回失敗した会社を再試行)
 *     - 同じ会社が複数リストに重複している
 *     - 開発中のデバッグでバッチを何度も流す
 *   いずれの場合も「サイトテキスト + LLM 解析結果」 は短期間変わらないので、
 *   30 日 TTL でキャッシュしても安全。
 *
 * 設計:
 *   - key: 正規化 URL + 会社名のハッシュ (sha256, 先頭 16 文字)
 *   - value: analyzeCompanyLite の戻り値 (JSON シリアライズ可能)
 *   - 保存先: <runtime data dir>/cache/analysis/<key>.json
 *   - TTL: 30 日 (cachedAt > now - TTL なら hit)
 *   - LRU evict: 単体ファイル方式のため、エントリ数上限を超えたら古い順に削除
 *   - 並行アクセス: read は無ロック、write は writeFile (atomic) で十分。
 *     最悪同じ会社を 2 並列で分析しても、後勝ちで上書きされるだけで害なし。
 *
 * セキュリティ:
 *   - URL / 会社名はそのままキャッシュキーに含めない (sha256 で匿名化)
 *   - キャッシュ値も平文 JSON だが、サイトの公開情報のみなので機密ではない
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { resolveDataPath, ensureDataDir } = require('./data-paths');

/** デフォルト TTL: 30 日 */
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** エントリ数上限。これを超えたら古い順に evict */
const MAX_ENTRIES = 5000;

/** evict 実行頻度: write 何回ごとにディレクトリスキャン+整理するか */
const EVICT_EVERY_WRITES = 50;
let writesSinceEvict = 0;

export type AnalysisCacheEntry<T = any> = {
  /** ISO 8601 timestamp */
  cachedAt: string;
  /** TTL を計算する起点。デフォルト cachedAt と同じ。 */
  expiresAt: string;
  /** schema バージョン。互換性破壊時に bump して全 invalidate */
  schemaVersion: number;
  /** 実体 (analyzeCompanyLite の出力) */
  value: T;
};

/**
 * 現在の cache schema バージョン。互換性破壊変更があった時に bump する。
 * 既存キャッシュは schemaVersion 不一致で自動的に miss 扱いされる。
 */
export const CACHE_SCHEMA_VERSION = 1;

function getCacheDir(): string {
  return resolveDataPath(path.join('cache', 'analysis'));
}

function ensureCacheDir(): string {
  ensureDataDir();
  const dir = getCacheDir();
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch (_) { /* best-effort */ }
  return dir;
}

/** URL を正規化: protocol 小文字、末尾 / 削除、query/hash 削除 */
function normalizeUrl(rawUrl: string): string {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  try {
    const u = new URL(rawUrl);
    const host = u.hostname.toLowerCase();
    const pathname = u.pathname.replace(/\/+$/, '');
    return `${u.protocol}//${host}${pathname}`;
  } catch {
    return rawUrl.trim().toLowerCase();
  }
}

/** 会社名を正規化: 全角→半角、空白圧縮、株式会社 prefix 揺れの正規化 */
function normalizeCompanyName(rawName: string): string {
  if (!rawName || typeof rawName !== 'string') return '';
  return rawName
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** key の hash 計算 */
function buildCacheKey(rawUrl: string, rawCompanyName: string): string {
  const urlN = normalizeUrl(rawUrl);
  const nameN = normalizeCompanyName(rawCompanyName);
  const composite = `${urlN}|${nameN}|v${CACHE_SCHEMA_VERSION}`;
  return crypto.createHash('sha256').update(composite).digest('hex').slice(0, 16);
}

/** ファイルパス */
function buildCachePath(key: string): string {
  return path.join(getCacheDir(), `${key}.json`);
}

/**
 * キャッシュから読む。hit なら value を返す、miss / expired / parse 失敗時は null。
 */
export function getCachedAnalysis<T = any>(
  rawUrl: string,
  rawCompanyName: string,
  options: { ttlMs?: number } = {},
): T | null {
  if (!rawUrl && !rawCompanyName) return null;

  // ttlMs の解釈:
  //   - 数値かつ >= 0 ならそのまま採用 (0 は「即時 expire」を意味する)
  //   - 未指定・負数・非数値なら DEFAULT_TTL_MS
  const explicitTtl = typeof options.ttlMs === 'number' && options.ttlMs >= 0;
  const ttlMs = explicitTtl ? (options.ttlMs as number) : DEFAULT_TTL_MS;

  // ttlMs=0 は「キャッシュ無効化」と解釈し、ファイル読まずに miss を返す
  if (ttlMs === 0) return null;

  const key = buildCacheKey(rawUrl, rawCompanyName);
  const filePath = buildCachePath(key);

  let raw: string;
  try {
    if (!fs.existsSync(filePath)) return null;
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }

  let parsed: AnalysisCacheEntry<T>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  // schemaVersion 不一致 → miss
  if (parsed.schemaVersion !== CACHE_SCHEMA_VERSION) return null;

  // TTL チェック
  const cachedAtMs = Date.parse(parsed.cachedAt);
  if (!Number.isFinite(cachedAtMs)) return null;
  if (Date.now() - cachedAtMs > ttlMs) return null;

  return parsed.value;
}

/**
 * キャッシュに書く。書き込みエラーは catch して捨てる (キャッシュ失敗で本処理を止めない)。
 */
export function setCachedAnalysis<T = any>(
  rawUrl: string,
  rawCompanyName: string,
  value: T,
  options: { ttlMs?: number } = {},
): void {
  if (!rawUrl && !rawCompanyName) return;
  if (value == null) return;

  const ttlMs = typeof options.ttlMs === 'number' && options.ttlMs > 0
    ? options.ttlMs
    : DEFAULT_TTL_MS;

  const key = buildCacheKey(rawUrl, rawCompanyName);
  const entry: AnalysisCacheEntry<T> = {
    cachedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
    schemaVersion: CACHE_SCHEMA_VERSION,
    value,
  };

  // cache dir には PII (社名・URL がエントリ value 内に含まれる) が書かれる可能性が
  // あるので、可能ならパーミッションを 0o700 (owner only) で作成する。
  // Windows では mode option は ignored だが ACL は親ディレクトリから継承されるため
  // %APPDATA% 配下 (= 各ユーザー所有) であれば実害は最小限。
  try {
    ensureCacheDir();
    const dir = getCacheDir();
    try {
      if (process.platform !== 'win32') {
        fs.chmodSync(dir, 0o700);
      }
    } catch { /* best-effort */ }
    const filePath = buildCachePath(key);
    const tmpPath = `${filePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmpPath, JSON.stringify(entry), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmpPath, filePath);  // atomic on POSIX, near-atomic on Windows
  } catch {
    return;
  }

  // 周期的 evict (毎 EVICT_EVERY_WRITES 書き込みに 1 回だけ実行)
  writesSinceEvict += 1;
  if (writesSinceEvict >= EVICT_EVERY_WRITES) {
    writesSinceEvict = 0;
    try { evictExcessEntries(MAX_ENTRIES); } catch { /* best-effort */ }
  }
}

/**
 * エントリ数が limit を超えたら、mtime 古い順に削除する。
 * O(N) の readdir + stat + sort。N=5000 でも数十ミリ秒で済む。
 */
function evictExcessEntries(limit: number): void {
  const dir = getCacheDir();
  if (!fs.existsSync(dir)) return;
  // stat 失敗ファイルは「不明」として除外する (mtimeMs=0 を返して
  // 先頭に並べると正常ファイルより先に消されてしまう)。
  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      const full = path.join(dir, f);
      try {
        const stat = fs.statSync(full);
        return { full, mtimeMs: stat.mtimeMs, ok: true };
      } catch {
        return { full, mtimeMs: 0, ok: false };
      }
    })
    .filter(x => x.ok)
    .sort((a, b) => a.mtimeMs - b.mtimeMs);

  if (files.length <= limit) return;
  const toDelete = files.slice(0, files.length - limit);
  for (const f of toDelete) {
    try { fs.unlinkSync(f.full); } catch { /* best-effort */ }
  }
}

/**
 * デバッグ用: キャッシュディレクトリ内のエントリ件数を返す。
 */
export function getCacheStats(): { entryCount: number; cacheDir: string } {
  const dir = getCacheDir();
  if (!fs.existsSync(dir)) return { entryCount: 0, cacheDir: dir };
  try {
    const entries = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    return { entryCount: entries.length, cacheDir: dir };
  } catch {
    return { entryCount: 0, cacheDir: dir };
  }
}

/**
 * テスト・運用用: キャッシュを完全に破棄する。
 */
export function clearAllCache(): { deleted: number } {
  const dir = getCacheDir();
  if (!fs.existsSync(dir)) return { deleted: 0 };
  let deleted = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        fs.unlinkSync(path.join(dir, f));
        deleted += 1;
      } catch { /* best-effort */ }
    }
  } catch { /* best-effort */ }
  return { deleted };
}

module.exports = {
  CACHE_SCHEMA_VERSION,
  getCachedAnalysis,
  setCachedAnalysis,
  getCacheStats,
  clearAllCache,
};

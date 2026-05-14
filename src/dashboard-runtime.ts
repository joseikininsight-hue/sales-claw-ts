// Dashboard runtime info — port/host/url を data/dashboard-runtime.json で公開
//
// このファイルが扱うのは「いまサーバーがどこで listen しているか」を
// 別プロセス (Electron renderer / action-logger / cli-logger / 他テストなど)
// に伝えるための publish/subscribe レイヤ。
//
// stale 検出方針:
//   - runtime.json は writeRuntime() でサーバーが listen 完了した瞬間に書く
//   - 死んだ PID の runtime.json は readRuntime() で無視する
//   - DEFAULT_STALE_MS (24h) を超えた runtime.json も無視する
//   - clearStaleRuntimes() は startup 時に呼ぶことで stale ファイルを実体削除する
//
// これにより:
//   - Electron renderer が古い 3765 を引いて「ネットワークに接続できません」を
//     出す事故が再発しない
//   - dev / installed の data dir が異なる場合でも、生きてる方のみを採用する
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveDataPath } from './data-paths';

/** 24 時間以上前の runtime.json は stale とみなす */
const DEFAULT_STALE_MS = 24 * 60 * 60 * 1000;

export interface DashboardRuntime {
  bindHost: string;
  host: string;
  port: number;
  preferredPort: number;
  startedAt: string;
  url: string;
  /** サーバープロセスの PID。0 は未指定 (旧形式互換) */
  pid: number;
}

export interface RuntimeRequestTarget {
  hostname: string;
  port: number;
  url: string;
}

interface ScoredRuntime {
  runtime: DashboardRuntime;
  score: number;
}

function getRuntimeFile(): string {
  return resolveDataPath('dashboard-runtime.json');
}

function getAlternateRuntimeFiles(): string[] {
  const files: string[] = [];
  const appData = typeof process.env.APPDATA === 'string' ? process.env.APPDATA.trim() : '';
  if (appData) {
    files.push(path.join(appData, 'sales-claw', 'runtime', 'data', 'dashboard-runtime.json'));
  }
  files.push(path.join(os.homedir(), '.sales-claw', 'data', 'dashboard-runtime.json'));
  return files;
}

function getRuntimeFiles(): string[] {
  const seen = new Set<string>();
  const files = [getRuntimeFile(), ...getAlternateRuntimeFiles()];
  return files.filter(file => {
    const resolved = path.resolve(file);
    if (seen.has(resolved)) return false;
    seen.add(resolved);
    return true;
  });
}

function ensureDataDir(): void {
  const dir = path.dirname(getRuntimeFile());
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function toClientHost(host: string | undefined): string {
  if (!host || host === '0.0.0.0' || host === '::' || host === '::0') return '127.0.0.1';
  return host;
}

function buildRuntimeUrl(host: string | undefined, port: number | string): string {
  return `http://${toClientHost(host)}:${port}`;
}

interface RawRuntime {
  bindHost?: string;
  host?: string;
  port?: number | string;
  preferredPort?: number | string;
  startedAt?: string;
  url?: string;
  pid?: number | string;
}

function normalizeRuntime(raw: RawRuntime | null | undefined): DashboardRuntime | null {
  if (!raw || raw.port === undefined || raw.port === null || raw.port === '') return null;
  const portNum = typeof raw.port === 'number' ? raw.port : Number(raw.port);
  if (!Number.isFinite(portNum)) return null;
  const host = toClientHost(raw.host ?? raw.bindHost ?? '127.0.0.1');
  const bindHost = raw.bindHost ?? raw.host ?? '127.0.0.1';
  const preferredPortRaw = raw.preferredPort ?? raw.port;
  const preferredPort = typeof preferredPortRaw === 'number'
    ? preferredPortRaw
    : Number(preferredPortRaw) || portNum;
  const pidNum = raw.pid === undefined || raw.pid === null || raw.pid === ''
    ? 0
    : (typeof raw.pid === 'number' ? raw.pid : Number(raw.pid));
  return {
    bindHost,
    host,
    port: portNum,
    preferredPort,
    startedAt: raw.startedAt ?? '',
    url: raw.url ?? buildRuntimeUrl(host, portNum),
    pid: Number.isFinite(pidNum) ? pidNum : 0,
  };
}

/**
 * PID が生きているかチェック。
 * - 0 / 負数 / NaN は false (旧形式 runtime には PID が無い)
 * - process.kill(pid, 0) で確認 (権限エラーは alive 扱い: ESRCH のみ dead)
 */
function isPidAlive(pid: number | undefined | null): boolean {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (err: any) {
    // EPERM = 権限なし (= プロセス存在する) / ESRCH = プロセス無し
    if (err && err.code === 'EPERM') return true;
    return false;
  }
}

/**
 * runtime が stale (死んでる or 古すぎる) か判定。
 * - PID が書かれていて死んでいる → stale
 * - PID が無いが startedAt が DEFAULT_STALE_MS より古い → stale
 * - その他 → not stale
 */
function isRuntimeStale(runtime: DashboardRuntime, now: number = Date.now()): boolean {
  // PID が書かれている場合は alive チェックを最優先
  if (runtime.pid > 0) {
    return !isPidAlive(runtime.pid);
  }
  // 旧形式 (PID 無し): startedAt が古ければ stale
  const startedAt = Date.parse(runtime.startedAt || '');
  if (!Number.isFinite(startedAt) || startedAt <= 0) {
    // startedAt も無い → 信頼できないので stale 扱い
    return true;
  }
  return (now - startedAt) > DEFAULT_STALE_MS;
}

function getRuntimeScore(runtime: DashboardRuntime, stat: fs.Stats | null): number {
  const startedAt = Date.parse(runtime.startedAt || '') || 0;
  const mtime = stat && typeof stat.mtimeMs === 'number' ? stat.mtimeMs : 0;
  return Math.max(startedAt, mtime);
}

export interface WriteRuntimeInput {
  bindHost?: string;
  host?: string;
  port: number;
  preferredPort?: number;
  startedAt?: string;
  /** サーバー PID。省略時は呼び出し元プロセスの PID を使う */
  pid?: number;
}

function writeRuntime(runtime: WriteRuntimeInput): DashboardRuntime {
  ensureDataDir();
  const bindHost = runtime.bindHost ?? runtime.host ?? '127.0.0.1';
  const host = toClientHost(runtime.host ?? runtime.bindHost ?? '127.0.0.1');
  const pidValue = runtime.pid !== undefined ? Number(runtime.pid) : process.pid;
  const normalized: DashboardRuntime = {
    bindHost,
    host,
    port: runtime.port,
    preferredPort: runtime.preferredPort ?? runtime.port,
    startedAt: runtime.startedAt ?? new Date().toISOString(),
    url: buildRuntimeUrl(host, runtime.port),
    pid: Number.isFinite(pidValue) && pidValue > 0 ? pidValue : 0,
  };
  fs.writeFileSync(getRuntimeFile(), JSON.stringify(normalized, null, 2), 'utf8');
  return normalized;
}

/**
 * runtime.json を読み出す。stale (PID 死亡 or 古い) ものは無視する。
 * 複数の候補ファイル (primary + alternates) を見比べて、生きてるものの
 * 中から最新 (startedAt または mtime が新しい) ものを返す。
 */
export function readRuntime(): DashboardRuntime | null {
  const runtimes: ScoredRuntime[] = [];
  const now = Date.now();
  for (const file of getRuntimeFiles()) {
    try {
      const stat = fs.statSync(file);
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as RawRuntime;
      const normalized = normalizeRuntime(raw);
      if (!normalized) continue;
      // stale (死亡 PID / 24h 超) は採用しない
      if (isRuntimeStale(normalized, now)) continue;
      runtimes.push({ runtime: normalized, score: getRuntimeScore(normalized, stat) });
    } catch {
      // noop
    }
  }
  if (!runtimes.length) return null;
  runtimes.sort((a: any, b: any) => b.score - a.score);
  return runtimes[0].runtime;
}

function clearRuntime(): void {
  try {
    const runtimeFile = getRuntimeFile();
    if (fs.existsSync(runtimeFile)) fs.unlinkSync(runtimeFile);
  } catch {
    // noop
  }
}

/**
 * 起動時に呼ぶ: primary + alternates をスキャンして stale な runtime.json を削除。
 *
 * 「stale」の条件は isRuntimeStale と同じ:
 *   - PID が書かれていて、その PID が死んでいる
 *   - PID が無く、startedAt が 24h より古い
 *   - JSON が壊れている / port が無い
 *
 * 生きてるサーバーのファイルは触らない (touch しない、削除もしない)。
 * 返り値: 削除したファイルパスの配列。
 */
export function clearStaleRuntimes(): string[] {
  const removed: string[] = [];
  const now = Date.now();
  for (const file of getRuntimeFiles()) {
    if (!fs.existsSync(file)) continue;
    let normalized: DashboardRuntime | null = null;
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as RawRuntime;
      normalized = normalizeRuntime(raw);
    } catch {
      normalized = null;
    }
    // パース失敗 or stale なら削除
    const shouldRemove = !normalized || isRuntimeStale(normalized, now);
    if (shouldRemove) {
      try {
        fs.unlinkSync(file);
        removed.push(file);
      } catch {
        // best-effort
      }
    }
  }
  return removed;
}

function getRequestTarget(fallbackHost: string | undefined, fallbackPort: number): RuntimeRequestTarget {
  const runtime = readRuntime();
  if (runtime) {
    return {
      hostname: runtime.host,
      port: runtime.port,
      url: runtime.url,
    };
  }
  return {
    hostname: toClientHost(fallbackHost ?? '127.0.0.1'),
    port: fallbackPort,
    url: buildRuntimeUrl(fallbackHost ?? '127.0.0.1', fallbackPort),
  };
}

module.exports = {
  buildRuntimeUrl,
  clearRuntime,
  clearStaleRuntimes,
  getRequestTarget,
  getRuntimeFile,
  getRuntimeFiles,
  isPidAlive,
  isRuntimeStale,
  readRuntime,
  toClientHost,
  writeRuntime,
};

export {
  buildRuntimeUrl,
  clearRuntime,
  getRequestTarget,
  getRuntimeFile,
  getRuntimeFiles,
  isPidAlive,
  isRuntimeStale,
  toClientHost,
  writeRuntime,
};

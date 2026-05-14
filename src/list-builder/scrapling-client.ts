// Scrapling Client — 公開ページの補助フェッチャ
//
// 要件§2.2 / §2.3 / §10:
//   - settings.listBuilder.scraplingMcpEnabled が true のときに使う
//   - settings.listBuilder.scraplingPythonPath で Python の場所を指定
//   - ユーザー側で `pip install scrapling` 必須 (Sales Claw は同梱しない)
//   - 突破系ツールではなく「公開ページが通常の HTTP で取れない場合の補助」として運用

import * as path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import type { ListBuilderConfig } from '../types/settings';

interface SettingsManagerShape {
  getListBuilderConfig?: () => Partial<ListBuilderConfig>;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const settings = require('../settings-manager') as SettingsManagerShape;

const PYTHON_SCRIPT = path.join(__dirname, '..', '..', '..', 'scripts', 'scrapling-fetch.py');
const DEFAULT_TIMEOUT_MS = 60000;
const PROBE_TIMEOUT_MS = 5000;

interface AvailabilityCache {
  checkedAt: number;
  available: boolean | null;
  pythonPath: string;
}

let availabilityCache: AvailabilityCache = {
  checkedAt: 0,
  available: null,
  pythonPath: '',
};
const AVAILABILITY_TTL_MS = 5 * 60 * 1000;  // 5 分

export interface ChildResult {
  ok: boolean;
  code?: number | null;
  stdout?: string;
  stderr?: string;
  error?: string;
  killed?: boolean;
}

export type RunChildFn = (argv: string[], opts?: { timeoutMs?: number }) => Promise<ChildResult>;

export interface FetchPageOptions {
  mode?: 'stealthy' | 'dynamic' | 'fetch' | string;
  timeoutMs?: number;
  runner?: { runChild: RunChildFn };
}

export interface FetchPageSuccess {
  ok: true;
  html: string;
  statusCode: number;
  finalUrl: string;
  title?: string;
  truncated?: boolean;
  fetcherKind: 'scrapling';
}

export interface FetchPageError {
  ok: false;
  error: string;
  errorCode?: 'NOT_ENABLED' | 'TIMEOUT' | 'SPAWN_FAILED' | 'PARSE_ERROR' | string;
}

export type FetchPageResult = FetchPageSuccess | FetchPageError;

export function getPythonPath(): string {
  const cfg = settings.getListBuilderConfig?.() ?? {};
  return (typeof cfg.scraplingPythonPath === 'string' && cfg.scraplingPythonPath.trim())
    ? cfg.scraplingPythonPath.trim()
    : 'python';
}

export function isEnabled(): boolean {
  const cfg = settings.getListBuilderConfig?.() ?? {};
  return Boolean(cfg.scraplingMcpEnabled);
}

/** 子プロセス実行ラッパ */
function runChild(argv: string[], opts: { timeoutMs?: number } = {}): Promise<ChildResult> {
  return new Promise<ChildResult>((resolve) => {
    const exec = argv[0];
    const args = argv.slice(1);
    let stdout = '';
    let stderr = '';
    let settled = false;
    let killedByTimeout = false;

    let child: ChildProcess;
    try {
      child = spawn(exec, args, {
        // shell: false (デフォルト) — コマンドインジェクション防止のため必須
        windowsHide: true,
      });
    } catch (e: unknown) {
      const code = (e && typeof e === 'object' && 'code' in e) ? (e as { code?: string | null }).code : null;
      return resolve({ ok: false, error: e instanceof Error ? e.message : String(e), code: typeof code === 'number' ? code : null });
    }

    const timer = setTimeout(() => {
      if (settled) return;
      killedByTimeout = true;
      try { child.kill(); } catch { /* ignore */ }
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf-8'); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf-8'); });

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const codeNum = typeof err.code === 'number' ? err.code : null;
      resolve({ ok: false, error: err.message, code: codeNum });
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killedByTimeout) {
        resolve({ ok: false, error: 'timeout', killed: true, stdout, stderr });
        return;
      }
      resolve({ ok: code === 0, code, stdout, stderr });
    });
  });
}

/** Scrapling が動く環境か確認する (キャッシュあり) */
export async function isAvailable(opts: { force?: boolean } = {}): Promise<boolean> {
  if (!isEnabled()) return false;
  const pythonPath = getPythonPath();
  const now = Date.now();
  if (
    !opts.force
    && availabilityCache.available !== null
    && availabilityCache.pythonPath === pythonPath
    && (now - availabilityCache.checkedAt) < AVAILABILITY_TTL_MS
  ) {
    return availabilityCache.available;
  }

  const result: any = await runChild(
    [pythonPath, '-c', 'import scrapling; print("scrapling-ok")'],
    { timeoutMs: PROBE_TIMEOUT_MS }
  );

  const ok = result.ok && /scrapling-ok/.test(result.stdout ?? '');
  availabilityCache = {
    checkedAt: now,
    available: ok,
    pythonPath,
  };
  return ok;
}

/** 公開ページを取得する */
export async function fetchPage(url: string, opts: FetchPageOptions = {}): Promise<FetchPageResult> {
  if (typeof url !== 'string' || !url) {
    return { ok: false, error: 'url required' };
  }
  if (!isEnabled()) {
    return { ok: false, error: 'scrapling not enabled', errorCode: 'NOT_ENABLED' };
  }

  let parsed: URL;
  try { parsed = new URL(url); }
  catch { return { ok: false, error: 'invalid URL' }; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: 'unsupported scheme' };
  }

  const runner = opts.runner ?? { runChild };
  const pythonPath = getPythonPath();
  const mode = opts.mode ?? 'stealthy';
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeoutSec = Math.max(1, Math.ceil(timeoutMs / 1000));

  const argv = [
    pythonPath,
    PYTHON_SCRIPT,
    url,
    '--mode', mode,
    '--timeout', String(timeoutSec),
  ];

  const result: any = await runner.runChild(argv, {
    timeoutMs: timeoutMs + 5000,
  });

  if (!result.ok && !result.stdout) {
    return {
      ok: false,
      error: result.error ?? 'spawn failed',
      errorCode: result.killed ? 'TIMEOUT' : 'SPAWN_FAILED',
    };
  }

  let parsedOutput: Record<string, unknown>;
  try {
    parsedOutput = JSON.parse((result.stdout ?? '').trim()) as Record<string, unknown>;
  } catch {
    return {
      ok: false,
      error: 'failed to parse scrapling worker output',
      errorCode: 'PARSE_ERROR',
    };
  }

  if (parsedOutput.ok === false) {
    return parsedOutput as unknown as FetchPageError;
  }

  return {
    ...(parsedOutput as unknown as Omit<FetchPageSuccess, 'fetcherKind'>),
    fetcherKind: 'scrapling',
  };
}

/** テスト用: キャッシュリセット */
export function _resetCache(): void {
  availabilityCache = { checkedAt: 0, available: null, pythonPath: '' };
}

module.exports = {
  isEnabled,
  isAvailable,
  fetchPage,
  getPythonPath,
  _resetCache,
  _internal: {
    runChild,
    PYTHON_SCRIPT,
    AVAILABILITY_TTL_MS,
    DEFAULT_TIMEOUT_MS,
  },
};

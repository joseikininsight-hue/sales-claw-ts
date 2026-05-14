// 公式データソースクライアント共通の HTTP ユーティリティ
//
// - SSRF 対策 (ALLOW LIST 方式 + DNS lookup ガード)
// - JSON / CSV / XML レスポンス取得
// - タイムアウト・リダイレクト追従の上限設定
// - 簡易レート制限 (per-host 最低間隔)

import * as http from 'http';
import * as https from 'https';
import * as dns from 'dns';
import * as net from 'net';
import { URL } from 'url';

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_BODY_BYTES = 5 * 1024 * 1024; // 5MB
// 公式 API は通常 200 OK で返るため、デフォルトでリダイレクト追従を無効化する。
const DEFAULT_MAX_REDIRECTS = 0;

// プライベート/予約 IP アドレスは公式 API でも当然プロキシしないので拒否。
const PRIVATE_PATTERNS: RegExp[] = [
  /^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./, /^0\./,
  /^::1$/, /^fe80:/, /^fc[0-9a-f]{2}:/, /^fd[0-9a-f]{2}:/,
  /^localhost$/i,
];

export interface HttpRequestOptions {
  method?: 'GET' | 'POST' | string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  timeoutMs?: number;
  maxBodyBytes?: number;
  maxRedirects?: number;
  allowedHosts: string[];
  minIntervalMs?: number;
  redirectDepth?: number;
  encoding?: BufferEncoding;
}

export interface HttpResponseSuccess {
  ok: true;
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  finalUrl: string;
}

export interface HttpResponseError {
  ok: false;
  error: string;
  status?: number;
  body?: Buffer;
  code?: string;
  finalUrl?: string;
}

export type HttpResponse = HttpResponseSuccess | HttpResponseError;

export interface JsonResponseSuccess extends HttpResponseSuccess {
  json: unknown;
}
export type JsonResponse = JsonResponseSuccess | HttpResponseError;

export interface TextResponseSuccess extends HttpResponseSuccess {
  text: string;
}
export type TextResponse = TextResponseSuccess | HttpResponseError;

function isPrivateHost(hostname: string | undefined | null): boolean {
  if (!hostname) return true;
  const normalized = String(hostname).replace(/^\[|\]$/g, '').toLowerCase();
  return PRIVATE_PATTERNS.some((re: any) => re.test(normalized));
}

function isPrivateAddress(address: string | undefined | null): boolean {
  if (!address) return true;
  let normalized = String(address).replace(/^\[|\]$/g, '').toLowerCase();
  if (normalized.startsWith('::ffff:')) normalized = normalized.slice('::ffff:'.length);
  if (net.isIPv4(normalized)) return isPrivateHost(normalized);
  if (net.isIPv6(normalized)) {
    return normalized === '::1'
      || normalized.startsWith('fe80:')
      || normalized.startsWith('fc')
      || normalized.startsWith('fd');
  }
  return isPrivateHost(normalized);
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address?: string, family?: number) => void;

function publicLookup(hostname: string, options: dns.LookupOneOptions, callback: LookupCallback): void {
  dns.lookup(hostname, options, (err, address, family) => {
    if (err) return callback(err);
    if (isPrivateAddress(address)) {
      const blocked: NodeJS.ErrnoException = new Error('private address blocked');
      blocked.code = 'EPRIVATEADDR';
      return callback(blocked);
    }
    callback(null, address, family);
  });
}

/**
 * ホスト ALLOW LIST 検証。サブドメインは明示しない限り許可しない (厳格)。
 */
function validateAllowedHost(parsedUrl: URL | null, allowedHosts: string[]): boolean {
  if (!parsedUrl) return false;
  if (!Array.isArray(allowedHosts) || allowedHosts.length === 0) return false;
  const host = parsedUrl.hostname.toLowerCase();
  return allowedHosts.some((allowed: any) => host === allowed.toLowerCase());
}

// per-host レート制限のための内部キャッシュ。
const lastRequestAt = new Map<string, number>();

/** エラーメッセージから API キー漏洩を防ぐためのサニタイザ。 */
function sanitizeErrorMessage(message: string | undefined | null): string {
  if (typeof message !== 'string') return '';
  return message.replace(/([?&][a-zA-Z][\w-]*=)([^&\s'"]{4,})/g, (_m, key: string, val: string) => {
    return key + val.slice(0, 2) + '****';
  });
}

async function enforceRateLimit(hostname: string, minIntervalMs: number | undefined): Promise<void> {
  if (!minIntervalMs || minIntervalMs <= 0) return;
  const last = lastRequestAt.get(hostname) ?? 0;
  const elapsed = Date.now() - last;
  if (elapsed < minIntervalMs) {
    await new Promise<unknown>((resolve) => setTimeout(resolve, minIntervalMs - elapsed));
  }
  lastRequestAt.set(hostname, Date.now());
}

/** メイン: HTTP リクエストを送って Buffer を返す。 */
async function request(url: string, options: HttpRequestOptions): Promise<HttpResponse> {
  const allowedHosts = options.allowedHosts || [];
  if (allowedHosts.length === 0) {
    return { ok: false, error: 'allowedHosts is required' };
  }

  let parsed: URL;
  try { parsed = new URL(url); }
  catch { return { ok: false, error: 'invalid URL' }; }

  if (!/^https?:$/.test(parsed.protocol)) {
    return { ok: false, error: 'unsupported scheme' };
  }
  if (isPrivateHost(parsed.hostname)) {
    return { ok: false, error: 'private host blocked' };
  }
  if (!validateAllowedHost(parsed, allowedHosts)) {
    return { ok: false, error: `host not in allow list: ${parsed.hostname}` };
  }

  await enforceRateLimit(parsed.hostname, options.minIntervalMs);

  const redirectDepth = Number(options.redirectDepth) || 0;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  if (redirectDepth > maxRedirects) {
    return { ok: false, error: 'too many redirects' };
  }

  return await new Promise<HttpResponse>((resolve) => {
    const lib = parsed.protocol === 'https:' ? https : http;
    let settled = false;
    let aborted = false;
    let req: http.ClientRequest | null = null;
    const chunks: Buffer[] = [];
    let totalLength = 0;
    const maxBody = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

    const finish = (result: HttpResponse): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      aborted = true;
      try { req?.destroy(); } catch { /* ignore */ }
      finish({ ok: false, error: 'timeout' });
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    const reqOptions: http.RequestOptions = {
      method: options.method ?? 'GET',
      headers: {
        'User-Agent': 'SalesClaw/1.0 ListBuilder',
        'Accept': 'application/json,text/csv,application/xml,*/*;q=0.5',
        'Accept-Language': 'ja,en;q=0.5',
        ...(options.headers ?? {}),
      },
      lookup: publicLookup as unknown as http.RequestOptions['lookup'],
    };

    req = lib.request(parsed, reqOptions, (res) => {
      const status = res.statusCode ?? 0;

      // リダイレクト追従。デフォルトは maxRedirects=0 で追従しない (DNS Rebinding 防止)。
      if (status >= 300 && status < 400 && res.headers.location && maxRedirects > 0) {
        settled = true;
        clearTimeout(timer);
        try { req?.destroy(); } catch { /* ignore */ }
        const nextUrl = new URL(res.headers.location, url).toString();
        return resolve(request(nextUrl, {
          ...options,
          redirectDepth: redirectDepth + 1,
        }));
      }

      res.on('data', (chunk: Buffer) => {
        if (aborted || settled) return;
        chunks.push(chunk);
        totalLength += chunk.length;
        if (totalLength > maxBody) {
          aborted = true;
          try { req?.destroy(); } catch { /* ignore */ }
          finish({
            ok: false,
            status,
            error: 'response too large',
            body: Buffer.concat(chunks, maxBody),
          });
        }
      });

      res.on('end', () => {
        if (aborted) return;
        if (status >= 400) {
          finish({
            ok: false,
            status,
            error: `HTTP ${status}`,
            body: Buffer.concat(chunks),
            finalUrl: url,
          });
        } else {
          finish({
            ok: true,
            status,
            headers: res.headers,
            body: Buffer.concat(chunks),
            finalUrl: url,
          });
        }
      });
    });

    req.on('error', (e: NodeJS.ErrnoException) => {
      if (!settled) finish({
        ok: false,
        error: sanitizeErrorMessage(e.message),
        code: e.code,
      });
    });

    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

/** JSON レスポンス便利関数 */
async function requestJson(url: string, options: HttpRequestOptions): Promise<JsonResponse> {
  const result: any = await request(url, {
    ...options,
    headers: { Accept: 'application/json', ...(options.headers ?? {}) },
  });
  if (!result.ok) return result;
  try {
    const text = result.body.toString('utf-8');
    return { ...result, json: JSON.parse(text) };
  } catch {
    return { ok: false, error: 'invalid JSON', status: result.status };
  }
}

/** CSV / TSV レスポンス便利関数 (生テキストのみ返す) */
async function requestText(url: string, options: HttpRequestOptions): Promise<TextResponse> {
  const result: any = await request(url, options);
  if (!result.ok) return result;
  return { ...result, text: result.body.toString(options.encoding ?? 'utf-8') };
}

module.exports = {
  request,
  requestJson,
  requestText,
  isPrivateHost,
  isPrivateAddress,
  validateAllowedHost,
  sanitizeErrorMessage,
  _internal: {
    PRIVATE_PATTERNS,
    DEFAULT_TIMEOUT_MS,
    DEFAULT_MAX_BODY_BYTES,
    DEFAULT_MAX_REDIRECTS,
  },
};

export {
  request,
  requestJson,
  requestText,
  isPrivateHost,
  isPrivateAddress,
  validateAllowedHost,
  sanitizeErrorMessage,
};

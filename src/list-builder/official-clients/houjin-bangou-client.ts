// 国税庁法人番号 Web-API クライアント
//
// 公式仕様: https://www.houjin-bangou.nta.go.jp/webapi/

import * as httpClient from './http-client';

interface SettingsManagerShape {
  getApiKey: (provider: string) => string | undefined;
  hasApiKey: (provider: string) => boolean;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const settings = require('../../settings-manager') as SettingsManagerShape;

const API_BASE = 'https://api.houjin-bangou.nta.go.jp/4';
const ALLOWED_HOSTS: string[] = ['api.houjin-bangou.nta.go.jp'];
const RESPONSE_TYPE = '12';                  // CSV (UTF-8)
const DEFAULT_MIN_INTERVAL_MS = 1000;
const DEFAULT_TIMEOUT_MS = 10000;

export interface HoujinCompanyRecord {
  corporateNumber: string;
  officialName: string;
  prefecture: string;
  city: string;
  officialAddress: string;
  source: 'houjin_bangou';
  sourceConfidence: 'high';
}

export interface SearchByNamePayload {
  name: string;
  mode?: 1 | 2;
  address?: string;
  limit?: number;
}

export interface FetcherOptions {
  apiKey?: string;
  timeoutMs?: number;
  minIntervalMs?: number;
  fetcher?: TextFetcher;
}

export type TextFetcher = (url: string, opts?: FetcherOptions) => Promise<httpClient.TextResponse>;

export interface HoujinResultSuccess {
  ok: true;
  records: HoujinCompanyRecord[];
  totalRows: number;
}

export interface HoujinResultError {
  ok: false;
  error: string;
  status?: number;
}

export type HoujinResult = HoujinResultSuccess | HoujinResultError;

/** CSV 1 行を簡易パースする (カンマ区切り、ダブルクォート対応) */
function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuote = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === ',') {
        result.push(current);
        current = '';
      } else if (ch === '"') {
        inQuote = true;
      } else {
        current += ch;
      }
    }
  }
  result.push(current);
  return result;
}

/** CSV 全体をパース (複数行、引用符内の改行対応) */
function parseCsv(text: string | undefined | null): string[][] {
  if (!text) return [];
  const rows: string[][] = [];
  let buffer = '';
  let inQuote = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') inQuote = !inQuote;
    if ((ch === '\n' || ch === '\r') && !inQuote) {
      if (buffer.length > 0) {
        rows.push(parseCsvLine(buffer));
        buffer = '';
      }
      if (ch === '\r' && text[i + 1] === '\n') i++;
    } else {
      buffer += ch;
    }
  }
  if (buffer.length > 0) {
    rows.push(parseCsvLine(buffer));
  }
  return rows;
}

/** CSV 1 行を CompanyRecord 風オブジェクトに正規化 */
function rowToRecord(row: string[] | null | undefined): HoujinCompanyRecord | null {
  if (!Array.isArray(row) || row.length < 15) return null;
  const corporateNumber = (row[1] ?? '').replace(/\D/g, '');
  if (corporateNumber.length !== 13) return null;

  const officialName = (row[6] ?? '').trim();
  const prefecture = (row[13] ?? '').trim();
  const city = (row[14] ?? '').trim();
  const street = (row[15] ?? '').trim();
  const officialAddress = [prefecture, city, street].filter(Boolean).join('');

  return {
    corporateNumber,
    officialName,
    prefecture,
    city,
    officialAddress,
    source: 'houjin_bangou',
    sourceConfidence: 'high',
  };
}

function buildUrl(endpoint: string, params: Record<string, string | number | undefined | null>, apiKey: string): string {
  const url = new URL(`${API_BASE}/${endpoint}`);
  url.searchParams.set('id', apiKey);
  url.searchParams.set('type', RESPONSE_TYPE);
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== '') {
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

/** 法人番号で検索 */
async function searchByCorporateNumber(
  numbers: string | string[],
  opts: FetcherOptions = {}
): Promise<HoujinResult> {
  const apiKey = opts.apiKey ?? settings.getApiKey('houjinBangou');
  if (!apiKey) return { ok: false, error: 'API key not configured (apiKeys.houjinBangou)' };

  const arr = Array.isArray(numbers) ? numbers : [numbers];
  const cleaned = arr
    .map((n: any) => String(n ?? '').replace(/\D/g, ''))
    .filter((n: any) => n.length === 13);
  if (cleaned.length === 0) return { ok: false, error: 'no valid 13-digit corporate numbers' };
  if (cleaned.length > 10) {
    return { ok: false, error: '法人番号 API は 1 リクエストで最大 10 件まで' };
  }

  const url = buildUrl('num', { number: cleaned.join(',') }, apiKey);
  const fetcher = opts.fetcher ?? defaultTextFetcher;
  const result: any = await fetcher(url, opts);
  if (!result.ok) return { ok: false, error: result.error, status: result.status };

  return parseResponse(result.text);
}

/** 会社名で検索 (部分一致) */
async function searchByName(payload: SearchByNamePayload, opts: FetcherOptions = {}): Promise<HoujinResult> {
  const apiKey = opts.apiKey ?? settings.getApiKey('houjinBangou');
  if (!apiKey) return { ok: false, error: 'API key not configured (apiKeys.houjinBangou)' };
  if (!payload || !payload.name || typeof payload.name !== 'string') {
    return { ok: false, error: 'name is required' };
  }

  const params: Record<string, string | number | undefined> = {
    name: payload.name,
    mode: payload.mode ?? 2,
  };
  if (payload.address) params.address = payload.address;

  const url = buildUrl('name', params, apiKey);
  const fetcher = opts.fetcher ?? defaultTextFetcher;
  const result: any = await fetcher(url, opts);
  if (!result.ok) return { ok: false, error: result.error, status: result.status };

  const parsed = parseResponse(result.text);
  if (!parsed.ok) return parsed;

  if (payload.limit && parsed.records.length > payload.limit) {
    return { ...parsed, records: parsed.records.slice(0, payload.limit) };
  }
  return parsed;
}

/** レスポンステキストをパース */
function parseResponse(text: string | undefined | null): HoujinResult {
  if (typeof text !== 'string') return { ok: false, error: 'no response text' };
  const rows = parseCsv(text);
  const records: HoujinCompanyRecord[] = [];
  for (const row of rows) {
    const record = rowToRecord(row);
    if (record) records.push(record);
  }
  return { ok: true, records, totalRows: rows.length };
}

/** 既定の fetcher (HTTPS テキスト取得) */
async function defaultTextFetcher(url: string, opts: FetcherOptions = {}): Promise<httpClient.TextResponse> {
  return await httpClient.requestText(url, {
    allowedHosts: ALLOWED_HOSTS,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    minIntervalMs: opts.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS,
    encoding: 'utf-8',
  });
}

function isConfigured(): boolean {
  return settings.hasApiKey('houjinBangou');
}

module.exports = {
  searchByCorporateNumber,
  searchByName,
  isConfigured,
  _internal: {
    parseCsv,
    parseCsvLine,
    rowToRecord,
    parseResponse,
    buildUrl,
    API_BASE,
    ALLOWED_HOSTS,
  },
};

export { searchByCorporateNumber, searchByName, isConfigured };

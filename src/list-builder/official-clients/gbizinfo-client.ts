// gBizINFO API クライアント
//
// 公式仕様: https://info.gbiz.go.jp/api/index.html

import * as httpClient from './http-client';

interface SettingsManagerShape {
  getApiKey: (provider: string) => string | undefined;
  hasApiKey: (provider: string) => boolean;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const settings = require('../../settings-manager') as SettingsManagerShape;

const API_BASE = 'https://info.gbiz.go.jp/hojin/v1';
const ALLOWED_HOSTS: string[] = ['info.gbiz.go.jp'];
const DEFAULT_MIN_INTERVAL_MS = 500;
const DEFAULT_TIMEOUT_MS = 10000;

interface GBizInfoRaw {
  corporate_number?: string;
  name?: string;
  name_en?: string;
  kana?: string;
  location?: string;
  postal_code?: string;
  status?: string;
  close_date?: string | null;
  representative_name?: string;
  capital_stock?: number | string;
  employee_number?: number | string;
  business_summary?: string;
  business_items?: string[];
}

export interface GBizCompanyRecord {
  corporateNumber: string;
  officialName: string;
  officialNameEn: string;
  officialNameKana: string;
  officialAddress: string;
  prefecture: string;
  postalCode: string;
  representativeName: string;
  employeeCount: number | null;
  capitalStock: number | null;
  businessSummary: string;
  businessItems: string[];
  status: string;
  closeDate: string | null;
  source: 'gbizinfo';
  sourceConfidence: 'high';
}

export interface GBizSearchPayload {
  name?: string;
  prefectureCodes?: string[];
  businessItem?: string;
  capitalStockFrom?: number;
  capitalStockTo?: number;
  employeeNumberFrom?: number;
  employeeNumberTo?: number;
  page?: number;
  limit?: number;
}

export interface FetcherOptions {
  apiKey?: string;
  timeoutMs?: number;
  minIntervalMs?: number;
  fetcher?: JsonFetcher;
}

export type JsonFetcher = (url: string, apiKey: string, opts?: FetcherOptions) => Promise<httpClient.JsonResponse>;

export interface GBizResultSuccess {
  ok: true;
  records: GBizCompanyRecord[];
  totalCount: number;
  raw?: unknown;
}

export interface GBizResultError {
  ok: false;
  error: string;
  status?: number;
}

export type GBizResult = GBizResultSuccess | GBizResultError;

function parseNumberSafe(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** gBizINFO レスポンスを CompanyRecord 風オブジェクトに正規化 */
function infoToRecord(info: GBizInfoRaw | null | undefined): GBizCompanyRecord | null {
  if (!info || typeof info !== 'object') return null;
  const corporateNumber = (info.corporate_number ?? '').replace(/\D/g, '');
  if (corporateNumber.length !== 13) return null;

  const location = typeof info.location === 'string' ? info.location.trim() : '';
  const prefMatch = location.match(/^(.{2,4}?[都道府県])/);
  const prefecture = prefMatch ? prefMatch[1] : '';

  const employeeCount = parseNumberSafe(info.employee_number);
  const capital = parseNumberSafe(info.capital_stock);

  return {
    corporateNumber,
    officialName: info.name ?? '',
    officialNameEn: info.name_en ?? '',
    officialNameKana: info.kana ?? '',
    officialAddress: location,
    prefecture,
    postalCode: info.postal_code ?? '',
    representativeName: info.representative_name ?? '',
    employeeCount,
    capitalStock: capital,
    businessSummary: info.business_summary ?? '',
    businessItems: Array.isArray(info.business_items) ? info.business_items : [],
    status: info.status ?? '',
    closeDate: info.close_date ?? null,
    source: 'gbizinfo',
    sourceConfidence: 'high',
  };
}

/** 法人番号で単一企業を取得 */
async function getByCorporateNumber(corporateNumber: string | number, opts: FetcherOptions = {}): Promise<GBizResult> {
  const apiKey = opts.apiKey ?? settings.getApiKey('gBizInfo');
  if (!apiKey) return { ok: false, error: 'API key not configured (apiKeys.gBizInfo)' };

  const cn = String(corporateNumber ?? '').replace(/\D/g, '');
  if (cn.length !== 13) return { ok: false, error: 'invalid corporate number (must be 13 digits)' };

  const url = `${API_BASE}/hojin/${cn}`;
  const fetcher = opts.fetcher ?? defaultJsonFetcher;
  const result: any = await fetcher(url, apiKey, opts);
  if (!result.ok) return { ok: false, error: result.error, status: result.status };

  const json = result.json as { 'hojin-infos'?: GBizInfoRaw[] } | null;
  const infos = json?.['hojin-infos'] ?? [];
  const records = infos.map(infoToRecord).filter((r): r is GBizCompanyRecord => r !== null);
  return { ok: true, records, totalCount: records.length };
}

/** 検索エンドポイント */
async function search(payload: GBizSearchPayload, opts: FetcherOptions = {}): Promise<GBizResult> {
  const apiKey = opts.apiKey ?? settings.getApiKey('gBizInfo');
  if (!apiKey) return { ok: false, error: 'API key not configured (apiKeys.gBizInfo)' };
  if (!payload || typeof payload !== 'object') {
    return { ok: false, error: 'payload required' };
  }

  const url = new URL(`${API_BASE}/hojin`);
  if (payload.name) url.searchParams.set('name', payload.name);
  if (Array.isArray(payload.prefectureCodes) && payload.prefectureCodes.length > 0) {
    url.searchParams.set('prefecture', payload.prefectureCodes.join(','));
  }
  if (payload.businessItem) url.searchParams.set('business_item', payload.businessItem);
  if (payload.capitalStockFrom !== undefined) url.searchParams.set('capital_stock_from', String(payload.capitalStockFrom));
  if (payload.capitalStockTo !== undefined) url.searchParams.set('capital_stock_to', String(payload.capitalStockTo));
  if (payload.employeeNumberFrom !== undefined) url.searchParams.set('employee_number_from', String(payload.employeeNumberFrom));
  if (payload.employeeNumberTo !== undefined) url.searchParams.set('employee_number_to', String(payload.employeeNumberTo));
  if (payload.page) url.searchParams.set('page', String(payload.page));
  if (payload.limit) url.searchParams.set('limit', String(Math.min(payload.limit, 1000)));

  const fetcher = opts.fetcher ?? defaultJsonFetcher;
  const result: any = await fetcher(url.toString(), apiKey, opts);
  if (!result.ok) return { ok: false, error: result.error, status: result.status };

  const json = result.json as { 'hojin-infos'?: GBizInfoRaw[]; errors?: unknown } | null;
  const infos = json?.['hojin-infos'] ?? [];
  const records = infos.map(infoToRecord).filter((r): r is GBizCompanyRecord => r !== null);
  return {
    ok: true,
    records,
    totalCount: typeof json?.errors === 'undefined' ? records.length : 0,
    raw: json,
  };
}

async function defaultJsonFetcher(url: string, apiKey: string, opts: FetcherOptions = {}): Promise<httpClient.JsonResponse> {
  return await httpClient.requestJson(url, {
    allowedHosts: ALLOWED_HOSTS,
    headers: { 'X-hojinInfo-api-token': apiKey },
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    minIntervalMs: opts.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS,
  });
}

function isConfigured(): boolean {
  return settings.hasApiKey('gBizInfo');
}

module.exports = {
  getByCorporateNumber,
  search,
  isConfigured,
  _internal: {
    infoToRecord,
    parseNumberSafe,
    API_BASE,
    ALLOWED_HOSTS,
  },
};

export { getByCorporateNumber, search, isConfigured };

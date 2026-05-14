// EDINET API クライアント (v2)
//
// 公式仕様: https://disclosure.edinet-fsa.go.jp/EKW0EZ0015.html

import * as httpClient from './http-client';

interface SettingsManagerShape {
  getApiKey: (provider: string) => string | undefined;
  hasApiKey: (provider: string) => boolean;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const settings = require('../../settings-manager') as SettingsManagerShape;

const API_BASE = 'https://disclosure.edinet-fsa.go.jp/api/v2';
const ALLOWED_HOSTS: string[] = ['disclosure.edinet-fsa.go.jp'];
const DEFAULT_MIN_INTERVAL_MS = 1000;
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_BODY_BYTES = 50 * 1024 * 1024;

export interface ListDocumentsPayload {
  date: string;
  type?: 1 | 2;
}

export interface GetDocumentPayload {
  docID: string;
  type?: 1 | 2 | 5;
}

export interface FindByCorporateNumberPayload {
  corporateNumber: string;
  daysBack?: number;
}

export interface FetcherOptions {
  apiKey?: string;
  timeoutMs?: number;
  minIntervalMs?: number;
  maxBodyBytes?: number;
  fetcher?: JsonFetcher | BinaryFetcher;
}

interface EdinetMetadata {
  status?: string;
  message?: string;
  [key: string]: unknown;
}

interface EdinetDocument {
  filerCorporateNumber?: string;
  JCN?: string;
  [key: string]: unknown;
}

interface EdinetListResponse {
  metadata?: EdinetMetadata;
  results?: EdinetDocument[];
}

export interface EdinetListResult {
  ok: true;
  documents: EdinetDocument[];
  totalCount: number;
  metadata?: EdinetMetadata;
}

export interface EdinetGetResult {
  ok: true;
  body: Buffer;
  contentType: string | string[] | null;
  size: number;
}

export interface ErrorResult {
  ok: false;
  error: string;
  status?: number;
  code?: string;
}

type ListReturn = EdinetListResult | ErrorResult;
type GetReturn = EdinetGetResult | ErrorResult;

type JsonFetcher = (url: string, opts?: FetcherOptions) => Promise<httpClient.JsonResponse>;
type BinaryFetcher = (url: string, opts?: FetcherOptions) => Promise<httpClient.HttpResponse>;

/** 指定日付の書類一覧を取得 */
async function listDocuments(payload: ListDocumentsPayload, opts: FetcherOptions = {}): Promise<ListReturn> {
  const apiKey = opts.apiKey ?? settings.getApiKey('edinet');
  if (!apiKey) return { ok: false, error: 'API key not configured (apiKeys.edinet)' };

  if (!payload || !payload.date || !/^\d{4}-\d{2}-\d{2}$/.test(payload.date)) {
    return { ok: false, error: 'date is required (YYYY-MM-DD)' };
  }

  const url = new URL(`${API_BASE}/documents.json`);
  url.searchParams.set('date', payload.date);
  url.searchParams.set('type', String(payload.type ?? 2));
  url.searchParams.set('Subscription-Key', apiKey);

  const fetcher = (opts.fetcher as JsonFetcher | undefined) ?? defaultJsonFetcher;
  const result: any = await fetcher(url.toString(), opts);
  if (!result.ok) return result;

  const json = result.json as EdinetListResponse | null;
  if (!json || json.metadata?.status !== '200') {
    return { ok: false, error: `EDINET API error: ${json?.metadata?.message ?? 'unknown'}` };
  }

  const documents = Array.isArray(json.results) ? json.results : [];
  return {
    ok: true,
    documents,
    totalCount: documents.length,
    metadata: json.metadata,
  };
}

/** 特定書類のメタ情報・本体取得 */
async function getDocument(payload: GetDocumentPayload, opts: FetcherOptions = {}): Promise<GetReturn> {
  const apiKey = opts.apiKey ?? settings.getApiKey('edinet');
  if (!apiKey) return { ok: false, error: 'API key not configured (apiKeys.edinet)' };
  if (!payload || !payload.docID || typeof payload.docID !== 'string') {
    return { ok: false, error: 'docID required' };
  }
  if (!/^[A-Za-z0-9]{1,32}$/.test(payload.docID)) {
    return { ok: false, error: 'invalid docID format' };
  }

  const url = new URL(`${API_BASE}/documents/${encodeURIComponent(payload.docID)}`);
  url.searchParams.set('type', String(payload.type ?? 5));
  url.searchParams.set('Subscription-Key', apiKey);

  const fetcher = (opts.fetcher as BinaryFetcher | undefined) ?? defaultBinaryFetcher;
  const result: any = await fetcher(url.toString(), opts);
  if (!result.ok) return result;

  return {
    ok: true,
    body: result.body,
    contentType: result.headers ? (result.headers['content-type'] ?? null) : null,
    size: result.body ? result.body.length : 0,
  };
}

/** 法人番号から該当する書類一覧を「直近 N 日」で逆順に検索する補助関数 */
async function findDocumentsByCorporateNumber(
  payload: FindByCorporateNumberPayload,
  opts: FetcherOptions = {}
): Promise<ListReturn> {
  const corporateNumber = String(payload?.corporateNumber ?? '').replace(/\D/g, '');
  if (corporateNumber.length !== 13) {
    return { ok: false, error: 'invalid corporate number (must be 13 digits)' };
  }
  const daysBack = Math.min(Math.max(payload?.daysBack ?? 30, 1), 365);

  const matches: EdinetDocument[] = [];
  const today = new Date();

  for (let i = 0; i < daysBack; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);

    const list: any = await listDocuments({ date: dateStr, type: 2 }, opts);
    if (!list.ok) continue;

    for (const doc of list.documents) {
      const filerCn = String(doc.filerCorporateNumber ?? doc.JCN ?? '').replace(/\D/g, '');
      if (filerCn === corporateNumber) {
        matches.push(doc);
      }
    }
  }

  return { ok: true, documents: matches, totalCount: matches.length };
}

async function defaultJsonFetcher(url: string, opts: FetcherOptions = {}): Promise<httpClient.JsonResponse> {
  return await httpClient.requestJson(url, {
    allowedHosts: ALLOWED_HOSTS,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    minIntervalMs: opts.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS,
  });
}

async function defaultBinaryFetcher(url: string, opts: FetcherOptions = {}): Promise<httpClient.HttpResponse> {
  return await httpClient.request(url, {
    allowedHosts: ALLOWED_HOSTS,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    minIntervalMs: opts.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS,
    maxBodyBytes: opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
  });
}

function isConfigured(): boolean {
  return settings.hasApiKey('edinet');
}

module.exports = {
  listDocuments,
  getDocument,
  findDocumentsByCorporateNumber,
  isConfigured,
  _internal: {
    API_BASE,
    ALLOWED_HOSTS,
  },
};

export {
  listDocuments,
  getDocument,
  findDocumentsByCorporateNumber,
  isConfigured,
};

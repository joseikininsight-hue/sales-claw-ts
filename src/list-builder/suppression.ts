// Suppression List — 営業対象から除外すべき企業の登録・照合
//
// 用途:
//   - 過去送信済み・既存顧客・競合・要望によるブロック・苦情先などを登録
//   - list-builder の dedupe Layer 5 で参照される
//   - UI から手動追加・削除・一覧表示

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

import { resolveDataPath, ensureDataDir } from '../data-paths';
import { acquireFileLock as _acquireFileLock, releaseFileLock } from '../file-lock';
import * as urlNormalizer from './url-normalizer';
import * as nameNormalizer from './name-normalizer';

export type SuppressionType = 'domain' | 'companyName' | 'corporateNumber' | 'formUrl';

export type SuppressionReason =
  | 'user_blocked'
  | 'past_contacted'
  | 'complaint'
  | 'do_not_contact'
  | 'competitor'
  | 'customer'
  | 'partner'
  | 'invalid';

export interface SuppressionRecord {
  id: string;
  type: SuppressionType;
  value: string;
  normalizedValue: string;
  reason: SuppressionReason;
  createdAt: string;
  createdBy: string;
}

export interface SuppressionData {
  version: number;
  records: SuppressionRecord[];
}

export interface AddSuppressionPayload {
  type: SuppressionType;
  value: string;
  reason?: SuppressionReason;
  createdBy?: string;
}

export interface AddSuppressionResult {
  ok: boolean;
  error?: string;
  record?: SuppressionRecord;
  alreadyExists?: boolean;
}

export interface RemoveSuppressionResult {
  ok: boolean;
  error?: string;
  removed?: number;
}

export interface SuppressionFilter {
  type?: SuppressionType;
  reason?: SuppressionReason;
}

export interface MatchCandidateInput {
  corporateNumber?: string;
  domainRoot?: string;
  normalizedName?: string;
  formUrl?: string;
  url?: string;
  companyName?: string;
}

export interface MatchOptions {
  data?: SuppressionData;
}

const SUPPRESSION_VERSION = 1;
const VALID_TYPES = new Set<SuppressionType>(['domain', 'companyName', 'corporateNumber', 'formUrl']);
const VALID_REASONS = new Set<SuppressionReason>([
  'user_blocked',
  'past_contacted',
  'complaint',
  'do_not_contact',
  'competitor',
  'customer',
  'partner',
  'invalid',
]);

interface CacheState {
  filePath: string | null;
  signature: string | null;
  data: SuppressionData | null;
}

const cache: CacheState = {
  filePath: null,
  signature: null,
  data: null,
};

function getSuppressionFile(): string {
  return resolveDataPath('suppression-list.json');
}

function getFileSignature(filePath: string): string | null {
  try {
    const stat = fs.statSync(filePath);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return null;
  }
}

function acquireFileLock(filePath: string): string | null {
  try {
    return _acquireFileLock(filePath, { label: 'suppression', maxWaitMs: 3000 });
  } catch (e: unknown) {
    console.warn('[suppression]', e instanceof Error ? e.message : String(e));
    return null;
  }
}

function defaultData(): SuppressionData {
  return { version: SUPPRESSION_VERSION, records: [] };
}

function readJsonCached(filePath: string): SuppressionData {
  const signature = getFileSignature(filePath);
  if (cache.filePath === filePath && cache.signature === signature && cache.data) {
    return cache.data;
  }

  if (signature === null) {
    cache.filePath = filePath;
    cache.signature = null;
    cache.data = defaultData();
    return cache.data;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
    const normalized = normalizeLoaded(parsed);
    cache.filePath = filePath;
    cache.signature = signature;
    cache.data = normalized;
    return normalized;
  } catch (e: unknown) {
    console.warn('[suppression] failed to read', filePath, e instanceof Error ? e.message : String(e));
    return defaultData();
  }
}

function normalizeLoaded(parsed: unknown): SuppressionData {
  if (!parsed || typeof parsed !== 'object') return defaultData();
  const p = parsed as { version?: unknown; records?: unknown };
  const version = Number.isInteger(p.version) ? (p.version as number) : SUPPRESSION_VERSION;
  const records = Array.isArray(p.records)
    ? p.records.filter(isValidRecord)
    : [];
  return { version, records };
}

function writeJsonAtomic(filePath: string, data: SuppressionData): void {
  ensureDataDir();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmpFile = filePath + '.tmp.' + process.pid;
  fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2), 'utf-8');
  try {
    fs.renameSync(tmpFile, filePath);
  } catch (e: unknown) {
    const code = (e && typeof e === 'object' && 'code' in e) ? (e as { code?: string }).code : undefined;
    if (process.platform === 'win32' && (code === 'EPERM' || code === 'EBUSY')) {
      fs.copyFileSync(tmpFile, filePath);
      try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    } else {
      try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
      throw e;
    }
  }
  cache.filePath = filePath;
  cache.signature = getFileSignature(filePath);
  cache.data = data;
}

function isValidRecord(record: unknown): record is SuppressionRecord {
  if (!record || typeof record !== 'object') return false;
  const r = record as Record<string, unknown>;
  return (
    typeof r.id === 'string' && r.id.length > 0
    && typeof r.type === 'string' && VALID_TYPES.has(r.type as SuppressionType)
    && typeof r.value === 'string' && r.value.length > 0
  );
}

function generateId(): string {
  return 'sup_' + crypto.randomBytes(8).toString('hex');
}

/** type に応じて正規化キーを生成 */
export function buildNormalizedValue(type: SuppressionType, rawValue: unknown): string {
  if (typeof rawValue !== 'string') return '';
  const value = rawValue.trim();
  if (!value) return '';

  switch (type) {
    case 'domain': {
      const probeUrl = /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`;
      const parsed = urlNormalizer.normalize(probeUrl);
      return parsed.valid ? parsed.domainRoot : value.toLowerCase();
    }
    case 'formUrl': {
      const parsed = urlNormalizer.normalize(value);
      return parsed.valid ? parsed.normalized : value.toLowerCase();
    }
    case 'companyName': {
      const norm = nameNormalizer.normalize(value);
      return norm.valid ? norm.normalized : value.toLowerCase();
    }
    case 'corporateNumber': {
      const digits = value.replace(/\D/g, '');
      return digits.length === 13 ? digits : '';
    }
    default:
      return value;
  }
}

// --- public API ---

export function loadSuppressionList(): SuppressionData {
  return readJsonCached(getSuppressionFile());
}

export function addSuppression(payload: AddSuppressionPayload): AddSuppressionResult {
  if (!payload || typeof payload !== 'object') {
    return { ok: false, error: 'invalid payload' };
  }
  const { type, value, reason } = payload;
  if (!VALID_TYPES.has(type)) {
    return { ok: false, error: `invalid type: ${type}` };
  }
  if (typeof value !== 'string' || !value.trim()) {
    return { ok: false, error: 'value required' };
  }
  if (reason && !VALID_REASONS.has(reason)) {
    return { ok: false, error: `invalid reason: ${reason}` };
  }

  const normalizedValue = buildNormalizedValue(type, value);
  if (!normalizedValue) {
    return { ok: false, error: 'value normalization failed' };
  }

  const filePath = getSuppressionFile();
  const lock = acquireFileLock(filePath);
  if (!lock) {
    return { ok: false, error: 'failed to acquire file lock' };
  }
  try {
    cache.signature = null;
    const data = loadSuppressionList();

    const existing = data.records.find(
      (r) => r.type === type && r.normalizedValue === normalizedValue
    );
    if (existing) {
      return { ok: true, record: existing, alreadyExists: true };
    }

    const record: SuppressionRecord = {
      id: generateId(),
      type,
      value: value.trim(),
      normalizedValue,
      reason: reason ?? 'user_blocked',
      createdAt: new Date().toISOString(),
      createdBy: typeof payload.createdBy === 'string' ? payload.createdBy : '',
    };
    const next: SuppressionData = {
      version: data.version,
      records: [...data.records, record],
    };
    writeJsonAtomic(filePath, next);
    return { ok: true, record, alreadyExists: false };
  } finally {
    releaseFileLock(lock);
  }
}

export function removeSuppression(id: string): RemoveSuppressionResult {
  if (typeof id !== 'string' || !id) {
    return { ok: false, error: 'id required' };
  }
  const filePath = getSuppressionFile();
  const lock = acquireFileLock(filePath);
  if (!lock) {
    return { ok: false, error: 'failed to acquire file lock' };
  }
  try {
    cache.signature = null;
    const data = loadSuppressionList();
    const before = data.records.length;
    const next: SuppressionData = {
      version: data.version,
      records: data.records.filter((r: any) => r.id !== id),
    };
    if (next.records.length === before) {
      return { ok: false, error: 'not found' };
    }
    writeJsonAtomic(filePath, next);
    return { ok: true, removed: before - next.records.length };
  } finally {
    releaseFileLock(lock);
  }
}

export function listSuppressions(filter: SuppressionFilter = {}): SuppressionRecord[] {
  const data = loadSuppressionList();
  let records = data.records;
  if (filter.type) records = records.filter((r: any) => r.type === filter.type);
  if (filter.reason) records = records.filter((r: any) => r.reason === filter.reason);
  return records;
}

/** 与えられた CompanyRecord が Suppression にマッチするか判定 */
export function matchSuppression(record: MatchCandidateInput | null | undefined, options: MatchOptions = {}): SuppressionRecord | null {
  if (!record || typeof record !== 'object') return null;
  const data = options.data ?? loadSuppressionList();
  if (!data.records.length) return null;

  const candidate = {
    corporateNumber: typeof record.corporateNumber === 'string'
      ? record.corporateNumber.replace(/\D/g, '')
      : '',
    domainRoot: typeof record.domainRoot === 'string' && record.domainRoot
      ? record.domainRoot.toLowerCase()
      : (record.url ? urlNormalizer.normalize(record.url).domainRoot : ''),
    normalizedName: typeof record.normalizedName === 'string' && record.normalizedName
      ? record.normalizedName
      : (record.companyName ? nameNormalizer.normalize(record.companyName).normalized : ''),
    formUrl: record.formUrl ? urlNormalizer.normalize(record.formUrl).normalized : '',
  };

  for (const sup of data.records) {
    switch (sup.type) {
      case 'corporateNumber':
        if (candidate.corporateNumber && candidate.corporateNumber === sup.normalizedValue) return sup;
        break;
      case 'domain':
        if (candidate.domainRoot && candidate.domainRoot === sup.normalizedValue) return sup;
        break;
      case 'companyName':
        if (candidate.normalizedName && candidate.normalizedName === sup.normalizedValue) return sup;
        break;
      case 'formUrl':
        if (candidate.formUrl && candidate.formUrl === sup.normalizedValue) return sup;
        break;
    }
  }

  return null;
}

export function isSuppressed(record: MatchCandidateInput | null | undefined, options?: MatchOptions): boolean {
  return matchSuppression(record, options) !== null;
}

/** テスト用: キャッシュをクリア */
export function _invalidateCache(): void {
  if (process.env.NODE_ENV !== 'test' && process.env.SALES_CLAW_TEST_MODE !== '1') {
    console.warn('[suppression] _invalidateCache called outside test mode (no-op)');
    return;
  }
  cache.filePath = null;
  cache.signature = null;
  cache.data = null;
}

module.exports = {
  loadSuppressionList,
  addSuppression,
  removeSuppression,
  listSuppressions,
  matchSuppression,
  isSuppressed,
  buildNormalizedValue,
  _invalidateCache,
  _internal: {
    VALID_TYPES,
    VALID_REASONS,
    SUPPRESSION_VERSION,
  },
};

// 企業ごとの連絡履歴管理
// 何回目の連絡で何を送ったかを記録し、2回目以降のメッセージ作成に活用する

import * as fs from 'fs';
import { ensureDataDir, resolveDataPath } from './data-paths';
import { acquireFileLock as _acquireFileLock, releaseFileLock } from './file-lock';

export interface ContactRecord {
  message: string;
  formUrl?: string;
  method?: string;
  response?: string | null;
  notes?: string;
  screenshot?: string;
  sourceAction?: string;
  sourceActionAt?: string;
  status?: string;
  timestamp?: string;
  sentAt?: string;
}

export interface ContactEntry {
  contactNo: number;
  date: string;
  message: string;
  formUrl: string;
  method: string;
  response: string | null;
  notes: string;
  screenshot: string;
  sourceAction: string;
  sourceActionAt: string;
  status: string;
  responseDate?: string;
}

export interface CompanyHistory {
  companyNo: number | string;
  companyName: string;
  contacts: ContactEntry[];
}

export interface HistorySummaryEntry {
  companyNo: number | string;
  companyName: string;
  contactCount: number;
  lastDate: string | null;
  lastContactNo: number;
}

interface HistoryData {
  [companyNo: string]: CompanyHistory;
}

interface HistoryCache {
  filePath: string | null;
  signature: string | null;
  data: HistoryData;
}

const historyCache: HistoryCache = {
  filePath: null,
  signature: null,
  data: {},
};

function getHistoryFile(): string {
  return resolveDataPath('contact-history.json');
}

function cloneValue<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (typeof globalThis.structuredClone === 'function') {
    return globalThis.structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

function getFileSignature(filePath: string): string | null {
  try {
    const stat = fs.statSync(filePath);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return null;
  }
}

function readJsonCached(filePath: string, fallbackValue: HistoryData): HistoryData {
  const signature = getFileSignature(filePath);
  if (historyCache.filePath === filePath && historyCache.signature === signature) {
    return historyCache.data;
  }

  if (signature === null) {
    historyCache.filePath = filePath;
    historyCache.signature = null;
    historyCache.data = fallbackValue;
    return fallbackValue;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as HistoryData;
    historyCache.filePath = filePath;
    historyCache.signature = signature;
    historyCache.data = parsed;
    return parsed;
  } catch {
    historyCache.filePath = filePath;
    historyCache.signature = signature;
    historyCache.data = fallbackValue;
    return fallbackValue;
  }
}

function acquireFileLock(filePath: string): string | null {
  try {
    return _acquireFileLock(filePath, { label: 'contact-history', maxWaitMs: 3000 });
  } catch (e: unknown) {
    console.warn('[contact-history]', e instanceof Error ? e.message : String(e));
    return null;
  }
}

function writeJsonCached(filePath: string, data: HistoryData): void {
  ensureDataDir();
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
  historyCache.filePath = filePath;
  historyCache.signature = getFileSignature(filePath);
  historyCache.data = data;
}

function loadHistory(): HistoryData {
  return readJsonCached(getHistoryFile(), {});
}

function saveHistory(data: HistoryData): void {
  writeJsonCached(getHistoryFile(), data);
}

/** 送信記録を追加する。返り値は何回目の連絡か (1, 2, 3...) */
export function recordContact(companyNo: number | string, companyName: string, record: ContactRecord): number {
  const filePath = getHistoryFile();
  const lockFile = acquireFileLock(filePath);
  try {
    historyCache.signature = null;
    const history = loadHistory();
    const key = String(companyNo);

    if (!history[key]) {
      history[key] = {
        companyNo,
        companyName,
        contacts: [],
      };
    }

    const contactNo = history[key].contacts.length + 1;
    const recordedAt = record.timestamp ?? record.sentAt ?? new Date().toISOString();

    history[key].contacts.push({
      contactNo,
      date: recordedAt,
      message: record.message,
      formUrl: record.formUrl ?? '',
      method: record.method ?? 'web_form',
      response: record.response ?? null,
      notes: record.notes ?? '',
      screenshot: record.screenshot ?? '',
      sourceAction: record.sourceAction ?? '',
      sourceActionAt: record.sourceActionAt ?? '',
      status: record.status ?? '',
    });

    saveHistory(history);
    return contactNo;
  } finally {
    releaseFileLock(lockFile);
  }
}

/** 企業の連絡履歴を取得する。 */
export function getHistory(companyNo: number | string): CompanyHistory | null {
  const history = loadHistory();
  return cloneValue(history[String(companyNo)] ?? null);
}

/** 企業の連絡回数を取得する (0 = 未連絡) */
export function getContactCount(companyNo: number | string): number {
  const h = getHistory(companyNo);
  return h ? h.contacts.length : 0;
}

/** 企業の前回送信メッセージを取得する */
export function getLastMessage(companyNo: number | string): string | null {
  const h = getHistory(companyNo);
  if (!h || h.contacts.length === 0) return null;
  return h.contacts[h.contacts.length - 1].message;
}

/** 全企業の連絡履歴サマリーを取得する。 */
export function getAllHistorySummary(): HistorySummaryEntry[] {
  const history = loadHistory();
  return Object.values(history).map((h: any) => ({
    companyNo: h.companyNo,
    companyName: h.companyName,
    contactCount: h.contacts.length,
    lastDate: h.contacts.length > 0 ? h.contacts[h.contacts.length - 1].date : null,
    lastContactNo: h.contacts.length,
  }));
}

/** 連絡に対するレスポンス (返信有無等) を記録する。 */
export function recordResponse(companyNo: number | string, contactNo: number, response: string, notes?: string): boolean {
  const filePath = getHistoryFile();
  const lockFile = acquireFileLock(filePath);
  try {
    historyCache.signature = null;
    const history = loadHistory();
    const key = String(companyNo);
    if (!history[key]) return false;

    const contact = history[key].contacts.find((c: any) => c.contactNo === contactNo);
    if (!contact) return false;

    contact.response = response;
    contact.notes = notes ?? contact.notes;
    contact.responseDate = new Date().toISOString();

    saveHistory(history);
    return true;
  } finally {
    releaseFileLock(lockFile);
  }
}

/** 企業の連絡履歴を完全削除する。 */
export function removeHistory(companyNo: number | string): boolean {
  const filePath = getHistoryFile();
  const lockFile = acquireFileLock(filePath);
  try {
    historyCache.signature = null;
    const history = loadHistory();
    const key = String(companyNo);
    if (!Object.prototype.hasOwnProperty.call(history, key)) return false;
    delete history[key];
    saveHistory(history);
    return true;
  } finally {
    releaseFileLock(lockFile);
  }
}

module.exports = {
  recordContact,
  getHistory,
  getContactCount,
  getLastMessage,
  getAllHistorySummary,
  recordResponse,
  removeHistory,
};

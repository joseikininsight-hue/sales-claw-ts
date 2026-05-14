// Outreach targets — 営業対象として「アクティブ化」した会社の永続化
//
// data/outreach-targets.json に { companyNo, companyName, addedAt, updatedAt } の配列を持つ。

import * as fs from 'fs';
import * as path from 'path';
import { resolveDataPath } from './data-paths';

export interface OutreachTargetEntry {
  companyNo: number | string;
  companyName: string;
  addedAt: string;
  updatedAt: string;
}

export interface SetTargetInput {
  companyNo: number | string;
  companyName?: string;
}

function getTargetsFile(): string {
  return resolveDataPath('outreach-targets.json');
}

function ensureDataDir(): void {
  const dir = path.dirname(getTargetsFile());
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadTargets(): OutreachTargetEntry[] {
  ensureDataDir();
  try {
    const raw = JSON.parse(fs.readFileSync(getTargetsFile(), 'utf8')) as unknown;
    if (Array.isArray(raw)) return raw as OutreachTargetEntry[];
    return [];
  } catch {
    return [];
  }
}

function saveTargets(entries: OutreachTargetEntry[]): void {
  ensureDataDir();
  fs.writeFileSync(getTargetsFile(), JSON.stringify(entries, null, 2), 'utf8');
}

function getTargetMap(): Map<string, OutreachTargetEntry> {
  const map = new Map<string, OutreachTargetEntry>();
  loadTargets().forEach((entry: any) => {
    map.set(String(entry.companyNo), entry);
  });
  return map;
}

function setTargets(companies: SetTargetInput[] | null | undefined, active = true): OutreachTargetEntry[] {
  const current = loadTargets();
  const map = new Map<string, OutreachTargetEntry>(current.map((entry: any) => [String(entry.companyNo), entry]));

  (companies ?? []).forEach((company: any) => {
    const key = String(company.companyNo);
    if (!active) {
      map.delete(key);
      return;
    }

    const now = new Date().toISOString();
    const existing = map.get(key);
    map.set(key, {
      companyNo: company.companyNo,
      companyName: company.companyName ?? (existing ? existing.companyName : ''),
      addedAt: existing ? existing.addedAt : now,
      updatedAt: now,
    });
  });

  const next = Array.from(map.values()).sort((a: any, b: any) => Number(a.companyNo) - Number(b.companyNo));
  saveTargets(next);
  return next;
}

module.exports = {
  getTargetsFile,
  getTargetMap,
  loadTargets,
  saveTargets,
  setTargets,
};

export {
  getTargetsFile,
  getTargetMap,
  loadTargets,
  saveTargets,
  setTargets,
};

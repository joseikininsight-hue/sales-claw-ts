// Dedupe — 4 層の重複検出 + Suppression 照合
//
// 要件 §6.2 (docs/list-builder-requirements.md v2.0) に基づく検出ロジック:
//
//   Layer 1: 法人番号 + 公式ドメイン                → duplicate (確定除外)
//   Layer 2: URL 正規化マッチ                       → duplicate (確定除外)
//   Layer 3: 会社名正規化マッチ                     → duplicate (確定除外)
//   Layer 4: ファジー (Levenshtein) しきい値超え    → needs_review (要確認)
//   Layer 5: Suppression List 照合                  → suppressed

import * as urlNormalizer from './url-normalizer';
import * as nameNormalizer from './name-normalizer';
import type { SuppressionRecord } from './suppression';

export type DedupeDecision = 'duplicate' | 'needs_review' | 'suppressed' | 'unique';
export type DedupeMatchKey = 'corporateNumber' | 'domain' | 'url' | 'name' | 'fuzzy' | 'suppression' | null;

export interface CompanyCandidate {
  id?: string | number;
  no?: number;
  companyNo?: number;
  source?: string;
  companyName?: string;
  officialName?: string;
  url?: string;
  formUrl?: string;
  domainRoot?: string;
  normalizedName?: string;
  corporateNumber?: string;
  [key: string]: unknown;
}

export interface PrecomputedKeys {
  corporateNumber: string;
  domainRoot: string;
  normalizedUrl: string;
  normalizedName: string;
  companyName: string;
}

export interface MatchedAgainstRecord {
  source?: string;
  id?: string;
  companyName?: string;
  url?: string;
  formUrl?: string;
  corporateNumber?: string;
  domainRoot?: string;
}

export interface MatchedAgainstSuppression {
  source: 'suppression';
  id: string;
  type: SuppressionRecord['type'];
  reason: SuppressionRecord['reason'];
}

export interface DedupeResult {
  decision: DedupeDecision;
  matchedAgainst: MatchedAgainstRecord | MatchedAgainstSuppression | null;
  matchKey: DedupeMatchKey;
  similarity: number;
  reason: string;
}

export interface DedupeOptions {
  fuzzyThreshold?: number;
}

export interface BatchDedupeResultItem extends DedupeResult {
  candidate: CompanyCandidate;
}

/** Levenshtein 距離 (自前実装、外部依存なし) */
export function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a) return b ? b.length : 0;
  if (!b) return a.length;
  if (a.length > b.length) {
    const tmp = a;
    a = b;
    b = tmp;
  }

  let prev = new Array<number>(a.length + 1);
  let curr = new Array<number>(a.length + 1);
  for (let i = 0; i <= a.length; i++) prev[i] = i;

  for (let j = 1; j <= b.length; j++) {
    curr[0] = j;
    for (let i = 1; i <= a.length; i++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[i] = Math.min(
        prev[i] + 1,        // deletion
        curr[i - 1] + 1,    // insertion
        prev[i - 1] + cost  // substitution
      );
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[a.length];
}

/** 2 文字列の類似度を 0.0〜1.0 で返す */
export function similarityRatio(a: string, b: string): number {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshteinDistance(a, b) / maxLen;
}

/** 候補レコードの正規化キー一括計算 */
export function precomputeKeys(record: CompanyCandidate | null | undefined): PrecomputedKeys {
  if (!record || typeof record !== 'object') {
    return {
      corporateNumber: '', domainRoot: '', normalizedUrl: '',
      normalizedName: '', companyName: '',
    };
  }

  const cnDigits = typeof record.corporateNumber === 'string'
    ? record.corporateNumber.replace(/\D/g, '')
    : '';
  const corporateNumber = cnDigits.length === 13 ? cnDigits : '';

  const urlInfo = record.url ? urlNormalizer.normalize(record.url) : null;
  const normalizedUrl = urlInfo && urlInfo.valid ? urlInfo.normalized : '';
  const domainRoot = (record.domainRoot && typeof record.domainRoot === 'string')
    ? record.domainRoot.toLowerCase()
    : (urlInfo && urlInfo.valid ? urlInfo.domainRoot : '');

  let normalizedName = '';
  if (typeof record.normalizedName === 'string' && record.normalizedName) {
    normalizedName = record.normalizedName;
  } else if (record.companyName) {
    const n = nameNormalizer.normalize(record.companyName);
    normalizedName = n.valid ? n.normalized : '';
  }

  return {
    corporateNumber,
    domainRoot,
    normalizedUrl,
    normalizedName,
    companyName: typeof record.companyName === 'string' ? record.companyName : '',
  };
}

export function sanitizeMatchedAgainst(record: CompanyCandidate | null | undefined): MatchedAgainstRecord | null {
  if (!record || typeof record !== 'object') return null;
  const keys = precomputeKeys(record);
  const out: MatchedAgainstRecord = {
    source: typeof record.source === 'string' ? record.source : '',
    id: String(record.id ?? record.no ?? record.companyNo ?? '').slice(0, 100),
    companyName: typeof record.companyName === 'string'
      ? record.companyName
      : (typeof record.officialName === 'string' ? record.officialName : ''),
    url: typeof record.url === 'string' ? record.url : '',
    formUrl: typeof record.formUrl === 'string' ? record.formUrl : '',
    corporateNumber: keys.corporateNumber,
    domainRoot: keys.domainRoot,
  };
  (Object.keys(out) as Array<keyof MatchedAgainstRecord>).forEach((key: any) => {
    if (out[key] === '' || out[key] === undefined || out[key] === null) delete out[key];
  });
  return out;
}

/** メイン: 1 候補に対して既存レコードを走査 */
export function checkDuplicate(
  candidate: CompanyCandidate,
  existingRecords: CompanyCandidate[],
  suppressionRecords: SuppressionRecord[] = [],
  options: DedupeOptions = {}
): DedupeResult {
  const fuzzyThreshold = typeof options.fuzzyThreshold === 'number'
    ? options.fuzzyThreshold
    : 0.9;

  const cKeys = precomputeKeys(candidate);

  // ---------- Layer 5 (Suppression) を最優先で確認 ----------
  for (const sup of suppressionRecords) {
    if (!sup || !sup.type || !sup.normalizedValue) continue;
    let matched = false;
    switch (sup.type) {
      case 'corporateNumber':
        matched = Boolean(cKeys.corporateNumber) && cKeys.corporateNumber === sup.normalizedValue;
        break;
      case 'domain':
        matched = Boolean(cKeys.domainRoot) && cKeys.domainRoot === sup.normalizedValue;
        break;
      case 'companyName':
        matched = Boolean(cKeys.normalizedName) && cKeys.normalizedName === sup.normalizedValue;
        break;
      case 'formUrl':
        if (candidate.formUrl) {
          const fInfo = urlNormalizer.normalize(candidate.formUrl);
          matched = fInfo.valid && fInfo.normalized === sup.normalizedValue;
        }
        break;
    }
    if (matched) {
      return {
        decision: 'suppressed',
        matchedAgainst: {
          source: 'suppression',
          id: sup.id,
          type: sup.type,
          reason: sup.reason ?? 'user_blocked',
        },
        matchKey: 'suppression',
        similarity: 1.0,
        reason: `Suppression list (${sup.type}: ${sup.reason ?? 'user_blocked'})`,
      };
    }
  }

  // ---------- Layer 1〜4 ----------
  let bestFuzzy: { existing: CompanyCandidate; similarity: number } | null = null;

  for (const existing of existingRecords) {
    if (!existing) continue;
    const eKeys = precomputeKeys(existing);

    // Layer 1a: 法人番号一致
    if (cKeys.corporateNumber && eKeys.corporateNumber
        && cKeys.corporateNumber === eKeys.corporateNumber) {
      return {
        decision: 'duplicate',
        matchedAgainst: sanitizeMatchedAgainst(existing),
        matchKey: 'corporateNumber',
        similarity: 1.0,
        reason: `法人番号一致: ${cKeys.corporateNumber}`,
      };
    }

    // Layer 1b: 公式ドメイン一致
    if (cKeys.domainRoot && eKeys.domainRoot && cKeys.domainRoot === eKeys.domainRoot) {
      return {
        decision: 'duplicate',
        matchedAgainst: sanitizeMatchedAgainst(existing),
        matchKey: 'domain',
        similarity: 1.0,
        reason: `公式ドメイン一致: ${cKeys.domainRoot}`,
      };
    }

    // Layer 2: URL 完全一致
    if (cKeys.normalizedUrl && eKeys.normalizedUrl
        && cKeys.normalizedUrl === eKeys.normalizedUrl) {
      return {
        decision: 'duplicate',
        matchedAgainst: sanitizeMatchedAgainst(existing),
        matchKey: 'url',
        similarity: 1.0,
        reason: `URL一致: ${cKeys.normalizedUrl}`,
      };
    }

    // Layer 3: 会社名正規化キー完全一致
    if (cKeys.normalizedName && eKeys.normalizedName
        && cKeys.normalizedName === eKeys.normalizedName) {
      return {
        decision: 'duplicate',
        matchedAgainst: sanitizeMatchedAgainst(existing),
        matchKey: 'name',
        similarity: 1.0,
        reason: `会社名一致: ${eKeys.companyName || existing.companyName}`,
      };
    }

    // Layer 4 候補: ファジー類似度を計算
    if (cKeys.normalizedName && eKeys.normalizedName) {
      const sim = similarityRatio(cKeys.normalizedName, eKeys.normalizedName);
      if (sim >= fuzzyThreshold && (!bestFuzzy || sim > bestFuzzy.similarity)) {
        bestFuzzy = { existing, similarity: sim };
      }
    }
  }

  // ---------- Layer 4 確定 ----------
  if (bestFuzzy) {
    return {
      decision: 'needs_review',
      matchedAgainst: sanitizeMatchedAgainst(bestFuzzy.existing),
      matchKey: 'fuzzy',
      similarity: bestFuzzy.similarity,
      reason: `類似会社あり (${(bestFuzzy.similarity * 100).toFixed(1)}%): ${
        bestFuzzy.existing.companyName ?? ''
      }`,
    };
  }

  // ---------- 重複なし ----------
  return {
    decision: 'unique',
    matchedAgainst: null,
    matchKey: null,
    similarity: 0,
    reason: '',
  };
}

/** 複数候補をまとめて評価し、同一バッチ内重複も検出する。 */
export function checkDuplicates(
  candidates: CompanyCandidate[],
  existingRecords: CompanyCandidate[],
  suppressionRecords: SuppressionRecord[] = [],
  options: DedupeOptions = {}
): BatchDedupeResultItem[] {
  const results: BatchDedupeResultItem[] = [];
  const acceptedThisRun: CompanyCandidate[] = [];

  for (const candidate of candidates) {
    const merged = existingRecords.concat(acceptedThisRun);
    const result = checkDuplicate(candidate, merged, suppressionRecords, options);
    results.push({ candidate, ...result });
    if (result.decision === 'unique' || result.decision === 'needs_review') {
      acceptedThisRun.push(candidate);
    }
  }

  return results;
}

module.exports = {
  checkDuplicate,
  checkDuplicates,
  similarityRatio,
  levenshteinDistance,
  precomputeKeys,
  sanitizeMatchedAgainst,
};

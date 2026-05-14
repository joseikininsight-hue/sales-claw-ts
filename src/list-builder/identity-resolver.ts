// Identity Resolver — 候補企業の同一性を公式データソースで解決する
//
// 解決優先順位 (要件§3 Stage 3):
//   1. corporateNumber が既にある → gBizINFO で確認・補完
//   2. companyName + 住所で 法人番号API name search
//      - 一意特定 → confidence: high
//      - 複数候補 → 住所/ドメイン一致でフィルタ → unique なら medium
//      - フィルタ後も複数 → candidates として返す (low)
//   3. url のみ → domainRoot だけ確定 (low)

import * as houjin from './official-clients/houjin-bangou-client';
import * as gbiz from './official-clients/gbizinfo-client';
import * as urlNormalizer from './url-normalizer';
import * as nameNormalizer from './name-normalizer';

export type IdentityConfidence = 'high' | 'medium' | 'low';
export type IdentitySource = 'gbizinfo' | 'houjin_bangou' | 'input' | 'url';

export interface IdentityResolveInput {
  companyName?: string;
  url?: string;
  prefecture?: string;
  corporateNumber?: string;
  domainRoot?: string;
}

export interface IdentityResolveOptions {
  apiKey?: string;
  timeoutMs?: number;
  minIntervalMs?: number;
  gbizFetcher?: gbiz.JsonFetcher;
  houjinFetcher?: houjin.TextFetcher;
}

export interface IdentityRecord {
  companyName?: string;
  url?: string;
  prefecture?: string;
  domainRoot?: string;
  corporateNumber?: string;
  officialName?: string;
  [key: string]: unknown;
}

export interface IdentityResolveSuccess {
  ok: true;
  record: IdentityRecord;
  source: IdentitySource;
  confidence: IdentityConfidence;
  candidates?: IdentityRecord[];
  warning?: string;
}

export interface IdentityResolveError {
  ok: false;
  error: string;
  record?: IdentityRecord;
}

export type IdentityResolveResult = IdentityResolveSuccess | IdentityResolveError;

function filterByPrefectureOnly<T extends { prefecture?: string }>(candidates: T[], input: IdentityResolveInput): T[] {
  if (!Array.isArray(candidates) || candidates.length === 0) return [];
  const inputPref = (input?.prefecture ?? '').trim();
  if (!inputPref) return candidates;
  return candidates.filter((c: any) => !c.prefecture || c.prefecture === inputPref);
}

/** 候補の中から、入力情報と一致するものを絞り込む */
export function filterCandidates<T extends { prefecture?: string; officialName?: string }>(candidates: T[], input: IdentityResolveInput): T[] {
  if (!Array.isArray(candidates) || candidates.length === 0) return [];
  const inputPref = (input.prefecture ?? '').trim();
  const inputName = nameNormalizer.normalize(input.companyName ?? '').normalized;

  return candidates.filter((c: any) => {
    if (inputPref && c.prefecture && c.prefecture !== inputPref) {
      return false;
    }
    if (inputName && c.officialName) {
      const candName = nameNormalizer.normalize(c.officialName).normalized;
      if (candName !== inputName) return false;
    }
    return true;
  });
}

export function extractDomainRootFromInput(input: IdentityResolveInput | null | undefined): string {
  if (!input) return '';
  if (typeof input.domainRoot === 'string' && input.domainRoot) return input.domainRoot.toLowerCase();
  if (input.url) {
    const u = urlNormalizer.normalize(input.url);
    return u.valid ? u.domainRoot : '';
  }
  return '';
}

/** メイン: 同一性解決 */
export async function resolve(input: IdentityResolveInput | null | undefined, opts: IdentityResolveOptions = {}): Promise<IdentityResolveResult> {
  if (!input || typeof input !== 'object') {
    return { ok: false, error: 'input required' };
  }

  const baseRecord: IdentityRecord = {
    companyName: input.companyName ?? '',
    url: input.url ?? '',
    prefecture: input.prefecture ?? '',
    domainRoot: extractDomainRootFromInput(input),
  };

  // ---- Step 1: 既知の法人番号があれば公式 API で確認 ----
  if (input.corporateNumber) {
    const cn = String(input.corporateNumber).replace(/\D/g, '');
    if (cn.length === 13) {
      // 1a: gBizINFO
      if (gbiz.isConfigured() || opts.gbizFetcher) {
        const result: any = await gbiz.getByCorporateNumber(cn, {
          ...opts,
          fetcher: opts.gbizFetcher,
        });
        if (result.ok && result.records.length > 0) {
          return {
            ok: true,
            record: { ...baseRecord, ...result.records[0], corporateNumber: cn },
            source: 'gbizinfo',
            confidence: 'high',
          };
        }
      }
      // 1b: 法人番号API で逆引き照合
      if (houjin.isConfigured() || opts.houjinFetcher) {
        const houjinResult: any = await houjin.searchByCorporateNumber(cn, {
          ...opts,
          fetcher: opts.houjinFetcher,
        });
        if (houjinResult.ok && houjinResult.records.length > 0) {
          const matched = houjinResult.records[0];
          if (input.companyName) {
            const inputKey = nameNormalizer.normalize(input.companyName).normalized;
            const officialKey = nameNormalizer.normalize(matched.officialName).normalized;
            const nameMatches = Boolean(inputKey) && Boolean(officialKey)
              && (inputKey === officialKey
                  || officialKey.includes(inputKey)
                  || inputKey.includes(officialKey));
            const base: IdentityResolveSuccess = {
              ok: true,
              record: { ...baseRecord, ...matched },
              source: 'houjin_bangou',
              confidence: nameMatches ? 'high' : 'low',
            };
            if (!nameMatches) base.warning = 'corporate number found but name does not match';
            return base;
          }
          return {
            ok: true,
            record: { ...baseRecord, ...matched },
            source: 'houjin_bangou',
            confidence: 'medium',
          };
        }
      }
      return {
        ok: true,
        record: { ...baseRecord, corporateNumber: cn },
        source: 'input',
        confidence: 'low',
      };
    }
  }

  // ---- Step 2: 法人番号API で会社名検索 ----
  if (input.companyName && (houjin.isConfigured() || opts.houjinFetcher)) {
    const result: any = await houjin.searchByName({
      name: input.companyName,
      address: input.prefecture || undefined,
      limit: 20,
    }, { ...opts, fetcher: opts.houjinFetcher });

    if (result.ok && result.records.length > 0) {
      // 一意特定
      if (result.records.length === 1) {
        return {
          ok: true,
          record: { ...baseRecord, ...result.records[0] },
          source: 'houjin_bangou',
          confidence: 'high',
        };
      }

      // 複数候補 → 住所・名前一致でフィルタ
      const filtered = filterCandidates(result.records, input);
      if (filtered.length === 1) {
        return {
          ok: true,
          record: { ...baseRecord, ...filtered[0] },
          source: 'houjin_bangou',
          confidence: 'medium',
        };
      }

      const candidates: IdentityRecord[] = (filtered.length > 0
        ? filtered.slice(0, 10)
        : filterByPrefectureOnly(result.records, input).slice(0, 10)
      ) as unknown as IdentityRecord[];
      return {
        ok: true,
        record: baseRecord,
        candidates,
        source: 'houjin_bangou',
        confidence: 'low',
      };
    }
  }

  // ---- Step 3: URL のみ → domainRoot だけ確定 ----
  if (baseRecord.domainRoot) {
    return {
      ok: true,
      record: baseRecord,
      source: 'url',
      confidence: 'low',
    };
  }

  return {
    ok: false,
    error: 'identity could not be resolved',
    record: baseRecord,
  };
}

module.exports = {
  resolve,
  filterCandidates,
  extractDomainRootFromInput,
};

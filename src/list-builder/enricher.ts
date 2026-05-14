// Enricher — extractor の HTML を受け取って record を補完する
//
// 要件§3 Stage 5:
//   - industry 検出 (既存 company-analyzer を流用)
//   - employeeCount 抽出
//   - revenue 抽出
//   - growthTrend 判定 (上場企業のみ)
//   - prefecture 抽出
//   - formUrl 探索

import * as employeeCountEnricher from './enrichers/employee-count';
import * as revenueEnricher from './enrichers/revenue';
import * as growthTrendEnricher from './enrichers/growth-trend';
import type { RevenueHistoryEntry } from './enrichers/growth-trend';

interface ExtractorShape {
  findContactLinks: (html: string, sourceUrl: string) => Array<{ url: string; matchedBy?: 'text' | 'href' | string }>;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const extractor = require('./extractor') as ExtractorShape;

export interface EnrichRecord {
  url?: string;
  canonicalUrl?: string;
  industry?: string;
  employeeCount?: number;
  companySize?: string;
  revenueMillionYen?: number;
  revenue?: number;
  growthTrend?: string;
  growthTrendSource?: string;
  prefecture?: string;
  officialAddress?: string;
  formUrl?: string;
  formType?: string;
  riskFlags?: string[];
  evidence?: EvidenceEntry[];
  fieldConfidence?: Record<string, number>;
  lastVerifiedAt?: string;
  [key: string]: unknown;
}

export interface EnrichInput {
  record?: EnrichRecord;
  html?: string;
  edinetData?: { revenueMillionYen?: number };
  revenueHistory?: RevenueHistoryEntry[];
  riskFlags?: string[];
  formType?: string;
}

export interface EvidenceEntry {
  field: string;
  value: string;
  sourceUrl: string;
  sourceType: string;
  extractedAt: string;
  confidence: number;
  snippet: string;
}

export interface EnrichSuccess {
  ok: true;
  record: EnrichRecord;
  evidence: EvidenceEntry[];
}

export interface EnrichError {
  ok: false;
  error: string;
}

export type EnrichResult = EnrichSuccess | EnrichError;

const INDUSTRY_KEYWORDS: Record<string, string[]> = {
  'SaaS': ['saas', 'クラウド', 'サブスクリプション', 'web サービス', 'プラットフォーム'],
  'SIer': ['システムインテグレーター', 'sier', 'システム開発', '受託開発'],
  '製造': ['製造', '工場', 'メーカー', 'manufacturer'],
  '小売': ['小売', '販売', 'ec', 'eコマース', 'retail'],
  '金融': ['銀行', '証券', '保険', '金融', 'finance', 'bank', 'insurance'],
  'ヘルスケア': ['医療', '医薬', 'ヘルスケア', 'healthcare', 'medical'],
  '物流': ['物流', '配送', '運輸', 'logistics', 'shipping'],
  '不動産': ['不動産', '住宅', 'real estate'],
  '建設': ['建設', '建築', 'construction'],
  '広告/マーケ': ['広告', 'マーケティング', 'advertising', 'marketing', 'pr'],
  'コンサル': ['コンサル', 'consulting', 'アドバイザリー'],
};

export function detectIndustry(html: string | null | undefined): { industry: string | null; confidence: number } {
  if (!html) return { industry: null, confidence: 0 };
  const lower = html.toLowerCase();
  let bestIndustry: string | null = null;
  let bestScore = 0;

  for (const [industry, keywords] of Object.entries(INDUSTRY_KEYWORDS)) {
    let score = 0;
    for (const kw of keywords) {
      const matches = lower.split(kw.toLowerCase()).length - 1;
      score += matches;
    }
    if (score > bestScore) {
      bestScore = score;
      bestIndustry = industry;
    }
  }

  if (bestScore < 2) return { industry: null, confidence: 0 };
  return {
    industry: bestIndustry,
    confidence: Math.min(0.3 + bestScore * 0.05, 0.7),
  };
}

export function detectPrefecture(text: string | null | undefined): string | null {
  if (!text) return null;
  const m = text.match(/(北海道|東京都|京都府|大阪府|[一-龥]{2,3}県)/);
  return m ? m[1] : null;
}

function makeEvidence(
  field: string,
  value: string | number,
  sourceUrl: string,
  sourceType: string,
  confidence: number,
  snippet?: string
): EvidenceEntry {
  return {
    field,
    value: typeof value === 'string' ? value : String(value),
    sourceUrl: sourceUrl ?? '',
    sourceType: sourceType ?? 'unknown',
    extractedAt: new Date().toISOString(),
    confidence,
    snippet: snippet ?? '',
  };
}

/** メイン: enrichment 実行 */
export async function enrich(input: EnrichInput | null | undefined, _opts: Record<string, unknown> = {}): Promise<EnrichResult> {
  if (!input || typeof input !== 'object') {
    return { ok: false, error: 'input required' };
  }
  const baseRecord: EnrichRecord = input.record ?? {};
  const html = input.html ?? '';
  const sourceUrl = baseRecord.url ?? baseRecord.canonicalUrl ?? '';
  const evidence: EvidenceEntry[] = [];
  const fieldConfidence: Record<string, number> = { ...(baseRecord.fieldConfidence ?? {}) };

  const enriched: EnrichRecord = { ...baseRecord };

  // ---- 業種 ----
  if (!enriched.industry) {
    const ind = detectIndustry(html);
    if (ind.industry) {
      enriched.industry = ind.industry;
      fieldConfidence.industry = ind.confidence;
      evidence.push(makeEvidence('industry', ind.industry, sourceUrl, 'official_site', ind.confidence));
    }
  }

  // ---- 従業員数 ----
  if (typeof enriched.employeeCount !== 'number' || enriched.employeeCount <= 0) {
    const r = employeeCountEnricher.extract({
      html,
      existingEmployeeCount: baseRecord.employeeCount,
    });
    if (r.value !== null) {
      enriched.employeeCount = r.value;
      enriched.companySize = employeeCountEnricher.classifySize(r.value);
      fieldConfidence.employeeCount = r.confidence;
      evidence.push(makeEvidence(
        'employeeCount', r.value, sourceUrl, r.source === 'html' ? 'official_site' : 'official_api',
        r.confidence, r.matchedText
      ));
    }
  }

  // ---- 売上高 ----
  if (typeof enriched.revenueMillionYen !== 'number' || enriched.revenueMillionYen <= 0) {
    const r = revenueEnricher.extract({
      html,
      existingRevenue: baseRecord.revenueMillionYen,
      edinetData: input.edinetData,
    });
    if (r.value !== null) {
      enriched.revenueMillionYen = r.value;
      enriched.revenue = r.value;
      fieldConfidence.revenue = r.confidence;
      evidence.push(makeEvidence(
        'revenue', r.value, sourceUrl,
        r.source === 'edinet' ? 'ir' : (r.source === 'html' ? 'official_site' : 'official_api'),
        r.confidence, r.matchedText
      ));
    }
  }

  // ---- 成長性 (上場企業のみ) ----
  if (!enriched.growthTrend || enriched.growthTrend === 'unknown') {
    const r = growthTrendEnricher.classify({
      record: enriched as Record<string, unknown>,
      revenueHistory: input.revenueHistory,
    });
    if (r.trend !== 'unknown') {
      enriched.growthTrend = r.trend;
      enriched.growthTrendSource = r.source === 'edinet' ? 'edinet_ir' : 'unknown';
      fieldConfidence.growthTrend = 0.8;
      if (typeof r.cagr === 'number') {
        evidence.push(makeEvidence(
          'growthTrend', r.trend, '', 'ir', 0.8,
          `CAGR ${(r.cagr * 100).toFixed(1)}% over ${r.years} years`
        ));
      }
    } else {
      enriched.growthTrend = 'unknown';
      enriched.growthTrendSource = 'unknown';
    }
  }

  // ---- 都道府県 ----
  if (!enriched.prefecture && enriched.officialAddress) {
    const pref = detectPrefecture(enriched.officialAddress);
    if (pref) {
      enriched.prefecture = pref;
      fieldConfidence.prefecture = 0.8;
    }
  }

  // ---- 問い合わせフォーム URL ----
  if (!enriched.formUrl && html) {
    const links = extractor.findContactLinks(html, sourceUrl);
    if (links.length > 0) {
      const best = links.find((l: any) => l.matchedBy === 'text') ?? links[0];
      enriched.formUrl = best.url;
      fieldConfidence.formUrl = best.matchedBy === 'text' ? 0.7 : 0.5;
      evidence.push(makeEvidence('formUrl', best.url, sourceUrl, 'official_site', fieldConfidence.formUrl));
    }
  }

  // ---- riskFlags の継承 ----
  if (Array.isArray(input.riskFlags)) {
    enriched.riskFlags = [...(enriched.riskFlags ?? []), ...input.riskFlags];
  }
  if (input.formType && (!enriched.formType || enriched.formType === 'unknown')) {
    enriched.formType = input.formType;
  }

  enriched.fieldConfidence = fieldConfidence;
  enriched.evidence = (enriched.evidence ?? []).concat(evidence);
  enriched.lastVerifiedAt = new Date().toISOString();

  return { ok: true, record: enriched, evidence };
}

module.exports = {
  enrich,
  detectIndustry,
  detectPrefecture,
  INDUSTRY_KEYWORDS,
};

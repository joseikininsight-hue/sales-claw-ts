// Growth Trend Enricher — 成長性 (growing / stable / declining) を判定
//
// 要件§4.3 の運用方針:
//   - 上場企業のみ EDINET / IR 情報から厳密判定
//   - 非上場企業は判定不能 → unknown を返し、フィルタから除外しない
//
// 判定ロジック:
//   過去 3 期分の売上を比較し、CAGR (年平均成長率) を算出
//   - CAGR >= 10% → growing
//   - 0% <= CAGR < 10% → stable
//   - CAGR < 0% → declining
//   - データ不足 → unknown

export type GrowthTrend = 'growing' | 'stable' | 'declining' | 'unknown';
export type GrowthSource = 'edinet' | 'unknown';

export interface RevenueHistoryEntry {
  fiscalYear: number;
  revenueMillionYen: number;
}

export interface GrowthClassifyRecord {
  listingStatus?: string;
  edinetVerified?: boolean;
  [key: string]: unknown;
}

export interface GrowthClassifyInput {
  record?: GrowthClassifyRecord;
  revenueHistory?: RevenueHistoryEntry[];
}

export interface GrowthClassifyResult {
  trend: GrowthTrend;
  source: GrowthSource;
  cagr?: number;
  years?: number;
}

export const GROWING_THRESHOLD = 0.10;     // CAGR 10% 以上
export const STABLE_LOWER_BOUND = 0;       // 0% 以上は stable
export const MIN_HISTORY_YEARS = 2;        // 最低 2 期分のデータが必要

/** 年平均成長率 (CAGR) を計算。出力は小数点表記 (0.1 = 10%) */
export function calculateCAGR(history: RevenueHistoryEntry[] | null | undefined): number | null {
  if (!Array.isArray(history) || history.length < MIN_HISTORY_YEARS) return null;
  const sorted = [...history].sort((a: any, b: any) => a.fiscalYear - b.fiscalYear);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (!first || !last
      || typeof first.revenueMillionYen !== 'number'
      || typeof last.revenueMillionYen !== 'number'
      || first.revenueMillionYen <= 0) {
    return null;
  }
  const years = last.fiscalYear - first.fiscalYear;
  if (years <= 0) return null;
  // CAGR = (last / first) ^ (1/years) - 1
  return Math.pow(last.revenueMillionYen / first.revenueMillionYen, 1 / years) - 1;
}

/**
 * 上場フラグを判定。厳密に上場と確認できない場合は false。
 * 判定根拠は明示フィールドのみに限定する:
 *   - record.listingStatus === 'listed'         (要件§4.2 の正式フィールド)
 *   - record.edinetVerified === true            (オーケストレータが EDINET 照合した印)
 */
export function isListed(record: GrowthClassifyRecord | null | undefined): boolean {
  if (!record || typeof record !== 'object') return false;
  if (record.listingStatus === 'listed') return true;
  if (record.edinetVerified === true) return true;
  return false;
}

/** メイン: 成長性判定 */
export function classify(input: GrowthClassifyInput | null | undefined): GrowthClassifyResult {
  if (!input || typeof input !== 'object') {
    return { trend: 'unknown', source: 'unknown' };
  }
  const record = input.record;
  const history = input.revenueHistory;

  // 上場/開示企業以外は判定しない (要件§4.3)
  if (!isListed(record)) {
    return { trend: 'unknown', source: 'unknown' };
  }

  const cagr = calculateCAGR(history);
  if (cagr === null) {
    return { trend: 'unknown', source: 'unknown' };
  }

  let trend: GrowthTrend;
  if (cagr >= GROWING_THRESHOLD) trend = 'growing';
  else if (cagr >= STABLE_LOWER_BOUND) trend = 'stable';
  else trend = 'declining';

  const sorted = [...history!].sort((a: any, b: any) => a.fiscalYear - b.fiscalYear);
  const elapsedYears = sorted[sorted.length - 1].fiscalYear - sorted[0].fiscalYear;

  return {
    trend,
    source: 'edinet',
    cagr,
    years: elapsedYears,
  };
}

module.exports = {
  classify,
  calculateCAGR,
  isListed,
  GROWING_THRESHOLD,
  STABLE_LOWER_BOUND,
  MIN_HISTORY_YEARS,
};

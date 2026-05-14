// Revenue Enricher — 売上高を抽出する (百万円単位で正規化)
//
// 優先順位:
//   1. record.revenueMillionYen (既存値) があれば採用
//   2. EDINET から取得した IR 数値 (Phase 7 で連携)
//   3. 公式サイト HTML から「売上高: XXX」を抽出
//
// 数値正規化:
//   - 「100億円」→ 10000 (百万円)
//   - 「100百万円」→ 100
//   - 「1,234億円」→ 123400
//   - 「1兆円」→ 1000000

export type RevenueSource = 'existing' | 'edinet' | 'html' | 'unknown';

export interface RevenueResult {
  value: number | null;
  source: RevenueSource;
  confidence: number;
  matchedText?: string;
}

export type RevenueRange =
  | 'under_100m'
  | '100m-1b'
  | '1b-10b'
  | '10b-100b'
  | 'over_100b'
  | 'unknown';

export interface RevenueInput {
  html?: string;
  existingRevenue?: number;
  edinetData?: { revenueMillionYen?: number };
}

// 「売上高: 100億円」「Sales: 1,234 million yen」等のパターン
const REVENUE_PATTERNS: RegExp[] = [
  // 日本語: 売上高 / 売上 / 連結売上高
  /(?:連結)?売上高?\s*[:：]?\s*(?:約\s*)?([\d,]{1,15}(?:\.\d+)?)\s*(兆|億|百万|万|千|)\s*円/,
  // 英語: (Net) Sales / Revenue
  /(?:Net\s+)?(?:Sales|Revenue)\s*[:：]?\s*(?:approx\.?\s*)?(?:JPY|¥)?\s*([\d,]{1,15}(?:\.\d+)?)\s*(million|billion|trillion|百万|億|兆|)/i,
];

// 単位 → 百万円への変換係数
const UNIT_TO_MILLION: Record<string, number> = {
  '兆': 1000000,
  'trillion': 1000000,
  '億': 100,
  'billion': 1000,           // 1 billion = 1,000 million
  '百万': 1,
  'million': 1,
  '万': 0.01,
  '千': 0.001,
  '': 0.000001,              // 単位なし = 円扱い
};

/** 数値文字列を百万円に変換 */
function toMillionYen(numStr: string | null | undefined, unit: string | null | undefined): number | null {
  if (typeof numStr !== 'string') return null;
  const num = Number(numStr.replace(/,/g, ''));
  if (!Number.isFinite(num) || num < 0) return null;
  const unitKey = (typeof unit === 'string' ? unit.toLowerCase() : '') || '';
  const factor = UNIT_TO_MILLION[unitKey];
  if (factor === undefined) return null;
  const result = num * factor;
  // 上限チェック (100兆円超は異常値として弾く)
  if (result > 100_000_000) return null;
  return Math.round(result);
}

function htmlToText(html: string | null | undefined): string {
  if (!html) return '';
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ');
}

/** メイン抽出関数 */
function extract(input: RevenueInput | null | undefined): RevenueResult {
  if (!input || typeof input !== 'object') {
    return { value: null, source: 'unknown', confidence: 0 };
  }

  // 1. 既存値 (gBizINFO 等)
  if (typeof input.existingRevenue === 'number' && input.existingRevenue > 0) {
    return {
      value: input.existingRevenue,
      source: 'existing',
      confidence: 0.9,
    };
  }

  // 2. EDINET 由来 (呼び出し側で事前に整形して渡す想定)
  if (input.edinetData && typeof input.edinetData.revenueMillionYen === 'number') {
    return {
      value: input.edinetData.revenueMillionYen,
      source: 'edinet',
      confidence: 0.95,
    };
  }

  // 3. HTML から抽出
  const text = htmlToText(input.html);
  if (!text) return { value: null, source: 'unknown', confidence: 0 };

  for (const pattern of REVENUE_PATTERNS) {
    const m = text.match(pattern);
    if (m) {
      const value = toMillionYen(m[1], m[2]);
      if (value !== null && value > 0) {
        return {
          value,
          source: 'html',
          confidence: 0.5,  // HTML 抽出は IR 直接より信頼度低
          matchedText: m[0],
        };
      }
    }
  }

  return { value: null, source: 'unknown', confidence: 0 };
}

/** 売上高 → revenueRange マッチ */
function classifyRange(revenueMillionYen: number | null | undefined): RevenueRange {
  if (typeof revenueMillionYen !== 'number') return 'unknown';
  if (revenueMillionYen < 100) return 'under_100m';
  if (revenueMillionYen < 1000) return '100m-1b';
  if (revenueMillionYen < 10000) return '1b-10b';
  if (revenueMillionYen < 100000) return '10b-100b';
  return 'over_100b';
}

module.exports = {
  extract,
  classifyRange,
  toMillionYen,
  htmlToText,
  REVENUE_PATTERNS,
  UNIT_TO_MILLION,
};

export { extract, classifyRange, toMillionYen, htmlToText, REVENUE_PATTERNS, UNIT_TO_MILLION };

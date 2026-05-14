// Employee Count Enricher — 従業員数を抽出する
//
// 優先順位:
//   1. record.employeeCount (gBizINFO 由来) があればそのまま使う
//   2. 公式サイト HTML から「従業員数」「Employees」等の表現を抽出
//   3. 取得失敗 → unknown

export type EmployeeCountSource = 'existing' | 'html' | 'unknown';

export interface EmployeeCountResult {
  value: number | null;
  source: EmployeeCountSource;
  confidence: number;
  matchedText?: string;
}

export type CompanySize = 'small' | 'medium' | 'large' | 'unknown';

export interface EmployeeCountInput {
  html?: string;
  existingEmployeeCount?: number;
}

// 「100名」「1,000人」「約 100 名」「100 (連結)」 等の従業員数を抽出
const EMPLOYEE_PATTERNS: RegExp[] = [
  // 日本語: 連結 1,234 名 / 連結従業員数 1,234 名
  /連結(?:従業員(?:数)?)?\s*[:：]?\s*(?:約\s*)?([\d,]{1,8})\s*[人名]/,
  // 日本語: 従業員数 1,234 名 / 従業員 1,234 名
  /従業員(?:数)?\s*[:：]?\s*(?:約\s*)?([\d,]{1,8})\s*[人名]/,
  // 英語: Employees / Number of employees: 1,234
  /(?:Number\s+of\s+)?[Ee]mployees\s*[:：]?\s*(?:approx?\.?\s*)?([\d,]{1,8})/,
  // 「社員数 1,234 人」
  /社員(?:数)?\s*[:：]?\s*(?:約\s*)?([\d,]{1,8})\s*[人名]/,
];

/** 1,234 のようなコンマ区切り文字列を数値化 */
function parseInteger(value: string | null | undefined): number | null {
  if (typeof value !== 'string') return null;
  const stripped = value.replace(/,/g, '').trim();
  const n = Number(stripped);
  if (!Number.isFinite(n) || n < 0 || n > 10000000) return null;
  return Math.floor(n);
}

/** HTML からテキストを抽出 (簡易) */
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
function extract(input: EmployeeCountInput | null | undefined): EmployeeCountResult {
  if (!input || typeof input !== 'object') {
    return { value: null, source: 'unknown', confidence: 0 };
  }

  // 1. 既存値があればそれを使う
  if (typeof input.existingEmployeeCount === 'number'
      && input.existingEmployeeCount > 0) {
    return {
      value: input.existingEmployeeCount,
      source: 'existing',
      confidence: 0.9,
    };
  }

  // 2. HTML から抽出
  const text = htmlToText(input.html);
  if (!text) return { value: null, source: 'unknown', confidence: 0 };

  for (const pattern of EMPLOYEE_PATTERNS) {
    const m = text.match(pattern);
    if (m) {
      const n = parseInteger(m[1]);
      if (n !== null) {
        return {
          value: n,
          source: 'html',
          // 連結 / 従業員数明示は信頼度高い、英語表現や社員は中
          confidence: /連結|従業員数/.test(m[0]) ? 0.8 : 0.6,
          matchedText: m[0],
        };
      }
    }
  }

  return { value: null, source: 'unknown', confidence: 0 };
}

/** 従業員数 → companySize の判定 */
function classifySize(employeeCount: number | null | undefined): CompanySize {
  if (typeof employeeCount !== 'number' || employeeCount <= 0) return 'unknown';
  if (employeeCount <= 50) return 'small';
  if (employeeCount <= 300) return 'medium';
  return 'large';
}

module.exports = {
  extract,
  classifySize,
  htmlToText,
  parseInteger,
  EMPLOYEE_PATTERNS,
};

export { extract, classifySize, htmlToText, parseInteger, EMPLOYEE_PATTERNS };

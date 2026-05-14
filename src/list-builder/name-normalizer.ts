// Name Normalizer — 会社名のゆらぎを吸収して dedupe 用の正規化キーを返す
//
// 吸収する揺らぎ:
//   - 法人格表現: 株式会社 / (株) / ㈱ / Inc. / Co.,Ltd. / Corp. / Ltd. /
//                有限会社 / 合同会社 / 合資会社 / 一般社団法人 / 医療法人 / 学校法人
//   - 前株 / 後株 差異
//   - 全角 ⇔ 半角 (英数字・記号・カタカナ)
//   - スペース (半角・全角)
//   - カタカナ ⇔ ひらがな (dedupe 補助のみ。表示用には保持)
//   - 大文字 ⇔ 小文字 (英字)

export interface NameNormalizeResult {
  /** 完全正規化 (小文字・記号除去・法人格除去) */
  normalized: string;
  /** 法人格を取り除いた表示用本体 */
  base: string;
  /** 前株 */
  prefix: string;
  /** 後株 */
  suffix: string;
  /** ひらがな寄せ後の比較用 */
  hiraganaForm: string;
  isHoldings: boolean;
  valid: boolean;
  original: string;
}

export interface CorporatePieces {
  prefix: string;
  base: string;
  suffix: string;
}

const CORPORATE_FORMS: string[] = [
  // 日本語法人格
  '株式会社', '有限会社', '合同会社', '合資会社', '合名会社',
  '一般社団法人', '一般財団法人', '公益社団法人', '公益財団法人',
  '医療法人', '医療法人社団', '社会福祉法人', '学校法人', '宗教法人',
  '特定非営利活動法人', '独立行政法人', '地方独立行政法人',
  // 略記
  '(株)', '(有)', '(同)', '(資)', '(名)',
  '(株)', '(有)', '(同)', '(資)', '(名)',
  '㈱', '㈲', '㈳', '㈵',
  // 英文法人格
  'Co., Ltd.', 'Co.,Ltd.', 'Co. Ltd.', 'Co Ltd',
  'Co., Ltd', 'Co.,Ltd', 'Co. Ltd',
  'Corporation', 'Corp.', 'Corp',
  'Incorporated', 'Inc.', 'Inc',
  'Limited', 'Ltd.', 'Ltd',
  'L.L.C.', 'LLC', 'L.L.P.', 'LLP',
  'GmbH', 'AG', 'S.A.', 'S.A.S.', 'S.r.l.', 'S.p.A.',
  'Pty Ltd', 'Pty. Ltd.',
];

const SORTED_CORPORATE_FORMS: string[] = [...CORPORATE_FORMS].sort((a: any, b: any) => b.length - a.length);

const HOLDINGS_KEYWORDS: string[] = ['HD', 'Holdings', 'ホールディングス', 'グループ', 'Group'];

const FULLWIDTH_ASCII_OFFSET = 0xFEE0;

export function toHalfwidth(input: string | undefined | null): string {
  if (!input) return '';
  let result = '';
  for (const ch of input) {
    const code = ch.charCodeAt(0);
    if (code >= 0xFF01 && code <= 0xFF5E) {
      result += String.fromCharCode(code - FULLWIDTH_ASCII_OFFSET);
    } else if (code === 0x3000) {
      result += ' ';
    } else {
      result += ch;
    }
  }
  return result;
}

export function toHiragana(input: string | undefined | null): string {
  if (!input) return '';
  let result = '';
  for (const ch of input) {
    const code = ch.charCodeAt(0);
    if (code >= 0x30A1 && code <= 0x30F6) {
      result += String.fromCharCode(code - 0x60);
    } else {
      result += ch;
    }
  }
  return result;
}

/** 法人格を会社名から剥がす */
export function stripCorporateForms(name: string | undefined | null): CorporatePieces {
  if (!name) return { prefix: '', base: '', suffix: '' };

  let prefix = '';
  let working = name;

  // 前方一致 (case-insensitive)
  for (const form of SORTED_CORPORATE_FORMS) {
    const lowerForm = form.toLowerCase();
    if (working.toLowerCase().startsWith(lowerForm)) {
      prefix = working.slice(0, form.length);
      working = working.slice(form.length).trim();
      break;
    }
  }

  // 後方一致 (case-insensitive)
  let suffix = '';
  for (const form of SORTED_CORPORATE_FORMS) {
    const lowerForm = form.toLowerCase();
    if (working.toLowerCase().endsWith(lowerForm)) {
      suffix = working.slice(working.length - form.length);
      working = working.slice(0, working.length - form.length).trim();
      break;
    }
  }

  // 全角括弧 → 半角化された後の追加チェック
  const altPrefixPatterns = [/^\(株\)\s*/, /^\(有\)\s*/, /^\(同\)\s*/];
  for (const pat of altPrefixPatterns) {
    const m = working.match(pat);
    if (m) {
      if (!prefix) prefix = m[0].trim();
      working = working.replace(pat, '').trim();
      break;
    }
  }
  const altSuffixPatterns = [/\s*\(株\)$/, /\s*\(有\)$/, /\s*\(同\)$/];
  for (const pat of altSuffixPatterns) {
    const m = working.match(pat);
    if (m) {
      if (!suffix) suffix = m[0].trim();
      working = working.replace(pat, '').trim();
      break;
    }
  }

  return { prefix, base: working, suffix };
}

/** 完全正規化キー (dedupe 比較に使う) */
export function buildNormalizedKey(base: string | undefined | null): string {
  if (!base) return '';
  let key = toHalfwidth(base);
  key = toHiragana(key);
  key = key.toLowerCase();
  key = key.replace(/[\s　\.,;:'"`!?\-_~・/\\()（）\[\]{}<>＿－〜ーー‐-―−]/g, '');
  return key;
}

export function isHoldings(name: string | undefined | null): boolean {
  if (!name) return false;
  const lowered = name.toLowerCase();
  return HOLDINGS_KEYWORDS.some((kw: any) => {
    const lk = kw.toLowerCase();
    return lowered.includes(lk);
  });
}

export function normalize(input: unknown): NameNormalizeResult {
  const original = typeof input === 'string' ? input.trim() : '';
  if (!original) {
    return {
      normalized: '',
      base: '',
      prefix: '',
      suffix: '',
      hiraganaForm: '',
      isHoldings: false,
      valid: false,
      original,
    };
  }

  const halfwidth = toHalfwidth(original);
  const { prefix, base, suffix } = stripCorporateForms(halfwidth);
  const normalized = buildNormalizedKey(base);
  const hiraganaForm = toHiragana(toHalfwidth(base)).toLowerCase();

  return {
    normalized,
    base,
    prefix,
    suffix,
    hiraganaForm,
    isHoldings: isHoldings(original),
    valid: normalized.length > 0,
    original,
  };
}

/** 2 つの会社名が完全一致するか (dedupe Layer 2) */
export function isSameName(a: unknown, b: unknown): boolean {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na.valid || !nb.valid) return false;
  return na.normalized === nb.normalized;
}

module.exports = {
  normalize,
  isSameName,
  toHalfwidth,
  toHiragana,
  stripCorporateForms,
  buildNormalizedKey,
  isHoldings,
  _internal: {
    CORPORATE_FORMS,
    SORTED_CORPORATE_FORMS,
    HOLDINGS_KEYWORDS,
  },
};

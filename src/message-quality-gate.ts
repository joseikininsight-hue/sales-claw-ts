'use strict';

/**
 * Message Quality Gate (Phase B)
 * ────────────────────────────────
 * LLM 生成メッセージを送信前に 8 項目で自動検証する。1 つでも fatal が
 * あれば送信中止。warn は許容するが UI に表示する。
 *
 * 検証項目:
 *   1. 事実引用検証 (evidence_quotes / siteText の一部が本文にあるか)
 *   2. 守秘違反 (個別社名 + 金額の組み合わせ)
 *   3. 禁止フレーズ (Win-Win / 相互発展 等)
 *   4. 長さ (style.maxLength)
 *   5. 自社署名の存在
 *   6. CTA の存在
 *   7. 担当者名 / 会社名の不正混入 (テンプレ展開漏れ)
 *   8. 営業お断りキーワード自身を本文に書いてしまっていないか
 *   9. 自社設定値との矛盾 (社員数 / 設立年 / 資本金)
 *
 * Phase A の sendability-gate と異なり、これは「LLM 生成後」の検証。
 * sendability-gate は「LLM 呼ぶ前」の検証。役割が違う。
 */

// 陳腐な営業フレーズ。デフォルト + ownContext.voice.must_avoid で拡張する。
const DEFAULT_FORBIDDEN_PHRASES = [
  'Win-Win', 'win-win', 'WIN-WIN',
  '相互発展', '相互の発展',
  'ぜひお力添え',
  '末永くお付き合い',
  'お互いに利益',
];

/**
 * @param {object} args
 * @param {string} args.message - LLM 生成本文
 * @param {object} args.targetProfile - analyzer 結果 (evidenceQuotes 等)
 * @param {object} args.ownContext - 自社情報 (companyName, contactName, etc.)
 * @param {object} [args.idealCustomer] - dealBreakers で守秘リストを補完
 * @param {object} [args.style] - maxLength / signatureTemplate
 * @param {string[]} [args.protectedPartners] - 個別社名 (e.g. 過去取引先)
 *
 * @returns {{
 *   ok: boolean,
 *   action: 'send' | 'regenerate' | 'reject',
 *   failures: Array<{ name, severity: 'fatal'|'warn'|'info', reason }>,
 *   reason: string,
 * }}
 */
function evaluate({
  message,
  targetProfile = {},
  ownContext = {},
  idealCustomer = null,
  style = null,
  protectedPartners = [],
}: {
  message?: string;
  targetProfile?: Record<string, any>;
  ownContext?: Record<string, any>;
  idealCustomer?: any;
  style?: any;
  protectedPartners?: unknown[];
} = {}) {
  if (!message || typeof message !== 'string') {
    return failure('reject', [{ name: 'message_present', severity: 'fatal', reason: 'message が空' }]);
  }
  const trimmed = message.trim();
  if (trimmed.length < 50) {
    return failure('reject', [{ name: 'min_length', severity: 'fatal', reason: `本文 ${trimmed.length} 字 (最低 50 字)` }]);
  }

  const failures: unknown[] = [];

  // 1. 事実引用検証
  // evidence_quotes が指定されている場合、最低 1 つの quote の主要部分が
  // 本文に含まれているか。「拝見し嘘」防止の核。
  const quotes = Array.isArray(targetProfile.evidenceQuotes) ? targetProfile.evidenceQuotes : [];
  if (quotes.length > 0) {
    const hit = quotes.some((q: any) => {
      const tokens = extractKeyTokens(q);
      return tokens.length > 0 && tokens.some((t: any) => trimmed.includes(t));
    });
    if (!hit) {
      failures.push({
        name: 'evidence_citation',
        severity: 'warn',
        reason: '本文に evidence_quotes 由来のキーワードが含まれていない (LLM が事実を反映していない可能性)',
      });
    }
  }

  // 2. 守秘違反: 個別社名 + 金額/件数の組み合わせ検出
  // protectedPartners が指定されていれば、そのいずれかが本文にある場合 → fatal
  // (個別社名を出すこと自体が違反)
  for (const partner of protectedPartners) {
    if (typeof partner !== 'string' || !partner.trim()) continue;
    if (trimmed.includes(partner)) {
      failures.push({
        name: 'confidentiality_partner_name',
        severity: 'fatal',
        reason: `protected partner 名 "${partner}" が本文に出現`,
      });
    }
  }
  // 金額表現 + 取引先表記 (様/御中) が同一文中に出現
  // 「様」だけ・金額だけは普通の文章でも出るので、両方そろった時だけ守秘違反疑い
  const confidentialitySentence = trimmed
    .split(/[。！？!?\n]/)
    .find((sentence: any) => /[\d一二三四五六七八九十百千万億,，]+\s*(?:円|万円|億円)/.test(sentence)
      && /(?:[一-龠ァ-ヴA-Za-z0-9]{2,}\s*(?:様|御中))/.test(sentence));
  if (confidentialitySentence) {
    failures.push({
      name: 'confidentiality_company_amount',
      severity: 'fatal',
      reason: '同一文内に個別社名 + 金額の組み合わせを検出 (守秘違反の可能性)',
    });
  }

  // 3. 禁止フレーズ
  const forbidden = [
    ...DEFAULT_FORBIDDEN_PHRASES,
    ...(Array.isArray(ownContext.voice && ownContext.voice.must_avoid) ? ownContext.voice.must_avoid : []),
  ];
  const forbidHits = forbidden.filter((p: any) => p && trimmed.includes(p));
  if (forbidHits.length > 0) {
    failures.push({
      name: 'forbidden_phrases',
      severity: 'warn',
      reason: `禁止フレーズ検出: ${forbidHits.join(', ')}`,
    });
  }

  // 4. 長さ check
  if (style && Number.isFinite(Number(style.maxLength))) {
    const max = Math.floor(Number(style.maxLength));
    if (trimmed.length > max) {
      failures.push({
        name: 'max_length',
        severity: 'warn',
        reason: `本文 ${trimmed.length} 字 > 上限 ${max} 字`,
      });
    }
  }

  // 5. 署名の存在 (自社名が本文末尾近くにあるか)
  if (ownContext.companyName) {
    const tail = trimmed.slice(-300);
    if (!tail.includes(ownContext.companyName)) {
      failures.push({
        name: 'signature_present',
        severity: 'warn',
        reason: '本文末尾に自社名が見当たらない (署名漏れの可能性)',
      });
    }
  }

  // 6. CTA の存在
  if (style && style.cta && !trimmed.includes(style.cta) && !/お願いいたします|よろしくお願い/.test(trimmed)) {
    failures.push({
      name: 'cta_present',
      severity: 'info',
      reason: 'CTA フレーズが見当たらない',
    });
  }

  // 7. テンプレ未展開検出 ({companyName} {contactName} などのプレースホルダ)
  if (/\{[a-zA-Z_]+\}/.test(trimmed)) {
    failures.push({
      name: 'unexpanded_template',
      severity: 'fatal',
      reason: `テンプレ変数 ${(trimmed.match(/\{[a-zA-Z_]+\}/g) ?? []).join(', ')} が未展開`,
    });
  }

  // 8. ICP の exclusionKeywords が本文に紛れ込んでいないか
  // (LLM が「営業お断りな会社ですが…」みたいに書いてしまうケース)
  if (idealCustomer && Array.isArray(idealCustomer.exclusionKeywords && idealCustomer.exclusionKeywords.patterns)) {
    const kw = idealCustomer.exclusionKeywords.patterns;
    const hits = kw.filter((k: any) => trimmed.includes(k));
    if (hits.length > 0) {
      failures.push({
        name: 'no_exclusion_in_body',
        severity: 'warn',
        reason: `本文に exclusion keyword が混入: ${hits.join(', ')}`,
      });
    }
  }

  // 9. 自社設定値との矛盾検出 (P5)
  // フォーム要求項目に引っ張られて、LLM が「社員数 約50名」のような
  // 設定にない数値を作る事故をここで止める。
  const consistency = checkSettingsConsistency(trimmed, ownContext);
  if (!consistency.pass) {
    failures.push(...consistency.issues.map((issue: any) => ({
      name: 'settings_consistency',
      severity: 'fatal',
      reason: `${issue.field} が設定値と矛盾: 生成="${issue.generated_value}" / 設定="${issue.expected_value}"`,
    })));
  }

  // action 決定
  const fatal = failures.some((f: any) => f.severity === 'fatal');
  if (fatal) {
    return failure('reject', failures);
  }
  if (failures.some((f: any) => f.severity === 'warn')) {
    // warn のみなら send (UI 表示する)
    return {
      ok: true,
      action: 'send',
      failures,
      reason: failures.map((f: any) => `[${f.severity}] ${f.name}: ${f.reason}`).join(' / '),
    };
  }
  return {
    ok: true,
    action: 'send',
    failures: [],
    reason: '',
  };
}

function failure(action, failures) {
  return {
    ok: false,
    action,
    failures,
    reason: failures.map((f: any) => `[${f.severity}] ${f.name}: ${f.reason}`).join(' / '),
  };
}

/**
 * 引用文 (evidence_quote) からキー部分を抽出して、本文との一致判定に使う。
 * 引用そのままだと長すぎて完全一致しないので、キー名詞を取り出す。
 */
function extractKeyTokens(quote) {
  if (typeof quote !== 'string') return [];
  const tokens = quote
    .replace(/[、。「」『』（）()]/g, ' ')
    .split(/\s+|の|を|は|が|に|で|と|も|や/)
    .map((t: any) => t.trim())
    .filter((t: any) => t.length >= 4);  // 4 文字以上の token を採用
  return Array.from(new Set(tokens)).slice(0, 5);
}

function checkSettingsConsistency(message, ownContext: Record<string, any> = {}) {
  const profile = extractOwnProfile(ownContext);
  const issues: unknown[] = [];
  if (!message || typeof message !== 'string') return { pass: true, issues };

  const checks = [
    {
      key: 'employeeCount',
      name: '社員数',
      expected: profile.employeeCount,
      expectedKind: 'number',
      patterns: [
        /(?:社員数|従業員数|従業員|社員|スタッフ)[^\d０-９]{0,12}(?:約|およそ)?\s*([0-9０-９][0-9０-９,，]*)\s*(?:名|人)/g,
      ],
    },
    {
      key: 'established',
      name: '設立年',
      expected: profile.established,
      expectedKind: 'year',
      patterns: [
        /(?:設立|創業|創立)[^\d０-９]{0,12}([12１２][0-9０-９]{3})\s*年/g,
      ],
    },
    {
      key: 'capital',
      name: '資本金',
      expected: profile.capital,
      expectedKind: 'number',
      patterns: [
        /資本金[^\d０-９]{0,12}(?:約|およそ)?\s*([0-9０-９][0-9０-９,，]*)\s*(?:万円|億円|円)?/g,
      ],
    },
  ];

  for (const check of checks) {
    const expected = extractExpectedValue(check.expected, check.expectedKind);
    if (!expected) continue;
    for (const pattern of check.patterns) {
      for (const match of message.matchAll(pattern)) {
        const generated = normalizeNumber(match[1]);
        if (!generated || generated === expected) continue;
        issues.push({
          field: check.name,
          generated_value: match[0],
          expected_value: check.expected,
          severity: 'critical',
        });
      }
    }
  }

  return { pass: issues.length === 0, issues };
}

function extractOwnProfile(ownContext) {
  if (!ownContext || typeof ownContext !== 'object') return {};
  const candidates = [
    ownContext.companyProfile,
    ownContext.profile,
    ownContext.senderFacts,
    ownContext.facts,
    ownContext,
  ];
  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'object') return candidate;
  }
  return {};
}

function extractExpectedValue(value, kind) {
  if (value == null) return '';
  const text = String(value).trim();
  if (!text) return '';
  if (kind === 'year') {
    const year = normalizeDigits(text).match(/[12][0-9]{3}/);
    return year ? year[0] : '';
  }
  return normalizeNumber(text);
}

function normalizeNumber(value) {
  return normalizeDigits(value).replace(/[^\d]/g, '');
}

function normalizeDigits(value) {
  return String(value == null ? '' : value).replace(/[０-９]/g, (ch) => String(ch.charCodeAt(0) - 0xFF10));
}

module.exports = {
  evaluate,
  // テスト用 export
  extractKeyTokens,
  checkSettingsConsistency,
  DEFAULT_FORBIDDEN_PHRASES,
};

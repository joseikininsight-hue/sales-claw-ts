// 法令適合 (P0-4 + Phase 4) — locale 別の規制チェックを提供する。
//
// 重要: 本モジュールは「ユーザーが法令を守る助けを提供する」ものであり、
// 法令適合を保証するものではない。最終責任はユーザー側にある。
//
// 機能:
//   1. injectRequiredFooter(message, profile, options)
//      送信メッセージに以下が含まれていない場合、locale に応じたフッターを追記:
//        - 送信者識別 (companyName / contactName)
//        - 連絡先 (email)
//        - locale 固有の必須項目 (例: en-us では postal address)
//        - オプトアウト案内 (locale 固有の文言)
//
//   2. checkCompliance(message, profile)
//      メッセージをスキャンして欠落要素を boolean フラグで返す (legacy / UI 互換)。
//
//   3. evaluate(message, options)
//      Phase 4 新規 API。locale を引数 or companyProfile.country から自動判定し、
//      i18n キー配列を返す。
//
//   4. evaluateForUi(message, profile)
//      Legacy API。日本語ラベル配列を返す (既存ダッシュボード互換)。
//
// 規制セット (本機能は法令適合を保証するものではない):
//   - ja-jp: 特定電子メール法 4 項要件
//   - en-us: CAN-SPAM Act (postal address mandatory)
//   - en-eu: GDPR Art. 13 / 6 (lawful basis / right to object)
//   - other: 最小要件 (送信者識別 + オプトアウト)

import type { CompanyProfile } from './types/settings';
import type { Country } from './types/locale';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getComplianceRules } = require('./locale-pack');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const settings = require('./settings-manager');

export interface ComplianceCheck {
  hasSenderName: boolean;
  hasSenderCompany: boolean;
  hasSenderAddress: boolean;
  hasOptOut: boolean;
  hasContactEmail: boolean;
  missing: string[];
}

export type ComplianceStatus = 'ok' | 'warn' | 'fail';

export interface ComplianceEvaluation {
  status: ComplianceStatus;
  /** locale 別の欠落要素ラベル (ja-jp は日本語、en-* は i18n キー) */
  missing: string[];
  summary: string;
}

export interface EvaluateOptions {
  /** 明示的に locale を指定する。未指定なら companyProfile.country から判定 */
  locale?: Country;
  /** チェック対象プロフィール。未指定なら settings.getSection('companyProfile') を読む */
  profile?: ComplianceProfile;
}

export interface InjectFooterOptions {
  /** オプトアウト案内のみ追加 (signature が既にある場合) */
  optOutOnly?: boolean;
  /** 明示的に locale を指定する。未指定なら profile.country / settings から判定 */
  locale?: Country;
}

/** メッセージ判定に使う最小限のプロフィール形。`CompanyProfile` のサブセット */
export type ComplianceProfile = Partial<Pick<CompanyProfile, 'companyName' | 'contactName' | 'email' | 'phone' | 'address' | 'country'>>;

interface ComplianceCheckRule {
  id: string;
  required: boolean;
  patterns: RegExp[];
  errorKey: string;
  hint: string;
}

// --- locale 判定 ---

function resolveCountry(explicit: Country | undefined, profile: ComplianceProfile | undefined): Country {
  if (explicit) return explicit;
  if (profile && profile.country) return profile.country;
  try {
    const cp = settings.getSection ? (settings.getSection('companyProfile') || {}) : {};
    if (cp && cp.country) return cp.country as Country;
  } catch (_) { /* ignore */ }
  return 'ja-jp';
}

function loadProfile(profile: ComplianceProfile | undefined): ComplianceProfile {
  if (profile) return profile;
  try {
    const cp = settings.getSection ? (settings.getSection('companyProfile') || {}) : {};
    return cp || {};
  } catch (_) {
    return {};
  }
}

// --- rule check 実行 ---

/**
 * ルール 1 件をメッセージに対して評価する。
 * - patterns が空: profile 値ベースで判定 (rule.id に応じて field を選ぶ)
 * - patterns あり: いずれかの regex がヒットしたら satisfied=true
 */
function ruleSatisfied(rule: ComplianceCheckRule, text: string, profile: ComplianceProfile): boolean {
  if (rule.patterns && rule.patterns.length > 0) {
    return rule.patterns.some((p) => p.test(text));
  }
  // patterns 空 = profile フィールドベース判定。id ごとに参照する field を決める。
  switch (rule.id) {
    case 'sender-company':
      return Boolean(profile.companyName && text.includes(String(profile.companyName)));
    case 'sender-name':
      return Boolean(profile.contactName && text.includes(String(profile.contactName)));
    case 'sender-address':
    case 'postal-address':
      return Boolean(profile.address && text.includes(String(profile.address)));
    case 'contact-email':
      return Boolean(profile.email && text.includes(String(profile.email)));
    default:
      // 未知の id でパターンも値も無いものは「常に satisfied」扱い (誤検出より誤陰性)
      return true;
  }
}

// --- legacy API (boolean フラグ) ---

/**
 * Legacy: ja-jp 4 項要件 + opt-out を boolean で返す。既存テスト / UI と互換。
 * country に関わらず ja-jp 視点で評価する点に注意 (locale 別評価は evaluate() を使う)。
 */
export function checkCompliance(message: string, profile: ComplianceProfile = {}): ComplianceCheck {
  const text = String(message ?? '');
  const result: ComplianceCheck = {
    hasSenderName: false,
    hasSenderCompany: false,
    hasSenderAddress: false,
    hasOptOut: false,
    hasContactEmail: false,
    missing: [],
  };

  if (profile.contactName && text.includes(String(profile.contactName))) {
    result.hasSenderName = true;
  }
  if (profile.companyName && text.includes(String(profile.companyName))) {
    result.hasSenderCompany = true;
  }
  if (profile.email && text.includes(String(profile.email))) {
    result.hasContactEmail = true;
  }
  if (profile.address && text.includes(String(profile.address))) {
    result.hasSenderAddress = true;
  }
  // ja-jp opt-out パターン (legacy 互換のためここで定義)
  const OPT_OUT_PATTERNS = /(配信停止|送信停止|ご不要の場合|お断り|オプトアウト|unsubscribe|今後[\s　]*ご連絡[\s　]*(が)?不要)/i;
  if (OPT_OUT_PATTERNS.test(text)) {
    result.hasOptOut = true;
  }

  if (!result.hasSenderCompany) result.missing.push('送信元会社名');
  if (!result.hasSenderName) result.missing.push('送信者氏名');
  if (!result.hasSenderAddress) result.missing.push('送信元住所');
  if (!result.hasContactEmail) result.missing.push('連絡先メール');
  if (!result.hasOptOut) result.missing.push('オプトアウト案内');

  return result;
}

// --- Phase 4: locale 別 evaluate API ---

/**
 * Phase 4 API: locale を考慮して評価する。
 * - status: required ルールが 1 つでも欠けたら 'fail'、optional のみ欠けたら 'warn'、全て満たせば 'ok'
 * - missing: i18n キー (string) の配列。UI 側で t(lang, key) で展開する
 */
export function evaluate(message: string, options: EvaluateOptions = {}): ComplianceEvaluation {
  const text = String(message ?? '');
  const profile = loadProfile(options.profile);
  const country = resolveCountry(options.locale, profile);
  const rules: ComplianceCheckRule[] = getComplianceRules(country) || [];

  const missingKeys: string[] = [];
  let hasRequiredMissing = false;

  for (const rule of rules) {
    const ok = ruleSatisfied(rule, text, profile);
    if (!ok) {
      missingKeys.push(rule.errorKey);
      if (rule.required) hasRequiredMissing = true;
    }
  }

  if (missingKeys.length === 0) {
    return { status: 'ok', missing: [], summary: 'All compliance checks passed.' };
  }
  return {
    status: hasRequiredMissing ? 'fail' : 'warn',
    missing: missingKeys,
    summary: missingKeys.join(', ') + ' missing',
  };
}

// --- フッター生成 ---

interface FooterStrings {
  addressLabel?: string;
  phoneLabel?: string;
  emailLabel?: string;
  optOutLine: (email: string) => string;
  /** locale 固有の追加文言 (例: GDPR lawful basis) */
  trailer?: string;
  /** 住所が必須かどうか (en-us は CAN-SPAM で必須) */
  requireAddress?: boolean;
}

function getFooterStrings(country: Country): FooterStrings {
  switch (country) {
    case 'ja-jp':
      return {
        addressLabel: '住所',
        phoneLabel: 'TEL',
        emailLabel: 'MAIL',
        optOutLine: (email: string) =>
          '※今後のご連絡が不要な場合は ' + email + ' までご一報ください。速やかに送信を停止いたします。',
      };
    case 'en-us':
      return {
        addressLabel: '',
        phoneLabel: 'Phone',
        emailLabel: 'Email',
        requireAddress: true,
        optOutLine: (email: string) =>
          'If you\'d prefer not to receive future messages, please reply with "unsubscribe" or email ' + email + '.',
      };
    case 'en-eu':
      return {
        addressLabel: '',
        phoneLabel: 'Phone',
        emailLabel: 'Email',
        optOutLine: (email: string) =>
          'You may object to this processing at any time by replying with "unsubscribe" or emailing ' + email + '.',
        trailer:
          'We process your contact information based on legitimate interest under GDPR Art. 6(1)(f). You may object at any time.',
      };
    case 'other':
    default:
      return {
        emailLabel: 'Email',
        optOutLine: (email: string) =>
          'If you do not wish to receive further messages, please reply "unsubscribe" or email ' + email + '.',
      };
  }
}

function isOptOutPresent(text: string, country: Country): boolean {
  if (country === 'ja-jp') {
    return /(配信停止|送信停止|ご不要の場合|お断り|オプトアウト|unsubscribe|今後[\s　]*ご連絡[\s　]*(が)?不要|今後[\s　]*の[\s　]*連絡[\s　]*(が)?不要)/i.test(text);
  }
  // en-us / en-eu / other
  if (/\b(unsubscribe|opt[-\s]?out|do not contact|stop receiving|remove me from)\b/i.test(text)) return true;
  if (country === 'en-eu' && /\b(withdraw consent|right to object)\b/i.test(text)) return true;
  return false;
}

export function buildRequiredFooter(profile: ComplianceProfile = {}, options: { locale?: Country } = {}): string {
  const country = resolveCountry(options.locale, profile);
  const s = getFooterStrings(country);
  const lines: string[] = [];
  if (profile.companyName) lines.push(String(profile.companyName));
  if (profile.contactName) lines.push(String(profile.contactName));
  if (profile.address) {
    lines.push(s.addressLabel ? s.addressLabel + ': ' + String(profile.address) : String(profile.address));
  }
  if (profile.phone) {
    lines.push((s.phoneLabel || 'Phone') + ': ' + String(profile.phone));
  }
  if (profile.email) {
    lines.push((s.emailLabel || 'Email') + ': ' + String(profile.email));
  }
  if (profile.email) {
    lines.push('');
    lines.push(s.optOutLine(String(profile.email)));
  }
  if (s.trailer) {
    lines.push('');
    lines.push(s.trailer);
  }
  return lines.join('\n');
}

/** 必須フッターをメッセージに追加する。既に含まれている要素はスキップする。 */
export function injectRequiredFooter(
  message: string,
  profile: ComplianceProfile = {},
  options: InjectFooterOptions = {}
): string {
  const text = String(message ?? '');
  const optOutOnly = Boolean(options.optOutOnly);
  const country = resolveCountry(options.locale, profile);
  const s = getFooterStrings(country);
  const lines: string[] = [];

  // 既存判定 (text 内に含まれているか)
  const hasCompany = profile.companyName ? text.includes(String(profile.companyName)) : false;
  const hasName = profile.contactName ? text.includes(String(profile.contactName)) : false;
  const hasAddress = profile.address ? text.includes(String(profile.address)) : false;
  const hasEmail = profile.email ? text.includes(String(profile.email)) : false;
  const hasOpt = isOptOutPresent(text, country);
  const hasTrailer = s.trailer ? text.includes(s.trailer) : true;

  if (!optOutOnly) {
    if (!hasCompany && profile.companyName) {
      lines.push(String(profile.companyName));
    }
    if (!hasName && profile.contactName) {
      lines.push(String(profile.contactName));
    }
    if (!hasAddress && profile.address) {
      lines.push(s.addressLabel ? s.addressLabel + ': ' + String(profile.address) : String(profile.address));
    }
    if (profile.phone && !text.includes(String(profile.phone))) {
      lines.push((s.phoneLabel || 'Phone') + ': ' + String(profile.phone));
    }
    if (!hasEmail && profile.email) {
      lines.push((s.emailLabel || 'Email') + ': ' + String(profile.email));
    }
  }
  if (!hasOpt && profile.email) {
    lines.push('');
    lines.push(s.optOutLine(String(profile.email)));
  }
  if (!optOutOnly && s.trailer && !hasTrailer) {
    lines.push('');
    lines.push(s.trailer);
  }
  if (lines.length === 0) return text;

  // 末尾に空行を 1 つ挟んで連結
  const ending = text.endsWith('\n') ? '' : '\n';
  return text + ending + '\n' + lines.join('\n');
}

/** UI 表示用の compliance バッジ判定 (legacy / ja-jp 互換)。 */
export function evaluateForUi(message: string, profile: ComplianceProfile = {}): ComplianceEvaluation {
  const c = checkCompliance(message, profile);
  if (c.missing.length === 0) {
    return { status: 'ok', missing: [], summary: '送信者表示・オプトアウト案内 揃い' };
  }
  // sender 不足は致命的、opt-out 不足は warn
  const fatalKeys: string[] = ['送信元会社名', '送信者氏名', '送信元住所', '連絡先メール'];
  const fatalCount = fatalKeys.filter((m: any) => c.missing.includes(m)).length;
  return {
    status: fatalCount > 0 ? 'fail' : 'warn',
    missing: c.missing,
    summary: c.missing.join(' / ') + ' が含まれていません',
  };
}

module.exports = {
  buildRequiredFooter,
  checkCompliance,
  injectRequiredFooter,
  evaluateForUi,
  evaluate,
};

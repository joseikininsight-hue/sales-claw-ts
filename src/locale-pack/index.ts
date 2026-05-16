// Locale Pack エントリポイント (Phase 2 + Phase 4)
//
// `getLocalePack(locale)` で ja / en のロケール固有データを取得できる。
// `getComplianceRules(country)` で country (ja-jp / en-us / en-eu / other) 単位の
// コンプライアンス規則を取得できる (Phase 4)。
//
// 本機能は法令適合を保証するものではない。最終責任はユーザー側にある。

import type { Locale, Country } from '../types/locale';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const ja = require('./ja');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const en = require('./en');

export interface ComplianceCheckRule {
  id: string;
  required: boolean;
  patterns: RegExp[];
  errorKey: string;
  hint: string;
}

/** Phase 3: CLI 自動化プロンプト用 batch_rules ビルダー */
export interface CliPromptsModule {
  buildBatchRules: (opts: { autoSendSafe: boolean; parallelTabs: number }) => string[];
}

/** Phase 3: LLM メッセージ生成プロンプトビルダー */
export interface LlmPromptsModule {
  buildGeneratorPrompt: (args: {
    targetProfile: Record<string, unknown>;
    ownContext: Record<string, unknown>;
    idealCustomer?: Record<string, unknown> | null;
    style?: Record<string, unknown> | null;
    sanitize: (value: unknown, options?: { maxLen?: number }) => string;
  }) => string;
}

/** Phase 3: テンプレ本文の locale 別フレーズ集 */
export interface MessageTemplatesModule {
  observation: {
    partnerNote: string;
    focusNote: (focusLabel: string) => string;
    areaNote: (areaLabel: string) => string;
    typeNote: (companyType: string) => string;
    fallbackNote: (companyName: string) => string;
  };
  proposal: {
    withGap: (
      strengthLabel: string,
      capability: string,
      areaLabel: string,
      secondaryText: string,
    ) => string;
    secondaryComplement: (secondaryLabel: string) => string;
    fallbackStrength: (label: string, detail: string) => string;
  };
  proof: {
    partnerProof: (partner: string, proof: string, matchedType: string) => string;
    fallbackProof: (proof: string) => string;
  };
  urlMissing: {
    introWithName: (companyName: string, contactName: string) => string;
    introNameless: (companyName: string) => string;
    proposalWithStrengths: (companyName: string, ownStrengths: string) => string;
    proposalWithoutStrengths: (companyName: string) => string;
    defaultClosing: string;
    optOutLine: string;
    cliPlaceholder: string;
    defaultGreeting: string;
  };
  opener: {
    partnerOpener: (mainStrength: string) => string;
    focusOpener: (focusLabel: string) => string;
    areaOpener: (areaStr: string) => string;
    defaultOpener: string;
  };
  hook: {
    withPartnerArea: (label: string, detail: string, partnerArea: string) => string;
    withDetailOnly: (label: string, detail: string) => string;
    fallbackStrength: (label: string, detail: string) => string;
  };
  defaults: {
    greetingLine: string;
    introWithName: (companyName: string, contactName: string) => string;
  };
}

export interface LocalePack {
  formFinderHints: {
    contactKeywords: string[];
    submitKeywords: string[];
  };
  sendabilityExclusions: string[];
  keywordDict: {
    businessAreas: Record<string, string[]>;
    focusAreas: Record<string, string[]>;
  };
  complianceRules: {
    ja_jp: ComplianceCheckRule[];
    en_us: ComplianceCheckRule[];
    en_eu: ComplianceCheckRule[];
    other: ComplianceCheckRule[];
  };
  // Phase 3
  cliPrompts: CliPromptsModule;
  llmPrompts: LlmPromptsModule;
  messageTemplates: MessageTemplatesModule;
}

export function getLocalePack(locale: Locale): LocalePack {
  return locale === 'en' ? (en as LocalePack) : (ja as LocalePack);
}

/**
 * country (ja-jp / en-us / en-eu / other) に対応するコンプライアンス規則を返す。
 * ja-jp は ja パック、それ以外は en パックから取得する。
 */
export function getComplianceRules(country: Country | undefined | null): ComplianceCheckRule[] {
  const normalized: Country = (country || 'ja-jp') as Country;
  const pack: LocalePack = normalized === 'ja-jp' ? (ja as LocalePack) : (en as LocalePack);
  const rules = pack.complianceRules || ({} as LocalePack['complianceRules']);
  switch (normalized) {
    case 'ja-jp': return rules.ja_jp || [];
    case 'en-us': return rules.en_us || [];
    case 'en-eu': return rules.en_eu || [];
    case 'other':
    default:
      return rules.other || [];
  }
}

module.exports = { getLocalePack, getComplianceRules };

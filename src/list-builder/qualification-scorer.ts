// Qualification Scorer — 候補企業の営業適合度を 0-100 で算出
//
// 要件§7 (docs/list-builder-requirements.md v2.0) に基づく。

import type { ListBuilderScoring } from '../types/settings';

interface SettingsManagerShape {
  getListBuilderScoring?: () => Partial<ListBuilderScoring>;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const settings = require('../settings-manager') as SettingsManagerShape;

export type RecommendedAction = 'add' | 'review' | 'skip';

export type FormType = 'general_contact' | 'sales_inquiry' | 'partnership' | 'recruit' | 'support' | 'ir' | string;

export interface ScorerRecord {
  industry?: string;
  prefecture?: string;
  employeeCount?: number;
  revenueMillionYen?: number;
  formType?: FormType;
  formUrl?: string;
  corporateNumber?: string;
  domainRoot?: string;
  businessSummary?: string;
  businessItems?: string[];
  priorContactCount?: number;
  riskFlags?: string[];
}

export interface ScorerCriteria {
  industries?: string[];
  prefectures?: string[];
  employeeRanges?: string[];
  revenueRanges?: string[];
  keywords?: string[];
}

export interface ScorerOptions {
  scoring?: Partial<ListBuilderScoring>;
  ignoreRiskFlags?: boolean;
}

export interface ScorerResult {
  fitScore: number;
  fitReasons: string[];
  riskFlags: string[];
  recommendedAction: RecommendedAction;
}

export const DEFAULT_SCORING: ListBuilderScoring = {
  industry: 20,
  prefecture: 10,
  size: 15,
  officialVerified: 15,
  formAvailable: 15,
  noPriorContact: 15,
  keywordMatch: 10,
};

export const FORM_TYPES_SAFE = new Set<FormType>(['general_contact', 'sales_inquiry', 'partnership']);

export const FORM_TYPES_BLOCKING = new Set<FormType>(['recruit', 'support', 'ir']);

/** 重大なリスクフラグ (一発で skip にする) */
export const SKIP_RISK_FLAGS = new Set<string>([
  'sales_prohibited',
  'recruit_only',
  'support_only',
  'ir_only',
  'access_blocked',
  'captcha_detected',
  'login_required',
]);

/** employeeRange に該当するか判定 */
export function matchesEmployeeRange(count: number | undefined, ranges: string[] | null | undefined): boolean {
  if (!Array.isArray(ranges) || ranges.length === 0) return false;
  if (typeof count !== 'number' || !Number.isFinite(count)) return false;

  return ranges.some((range: any) => {
    if (range === '5001+') return count >= 5001;
    const m = /^(\d+)-(\d+)$/.exec(range);
    if (!m) return false;
    const min = Number(m[1]);
    const max = Number(m[2]);
    return count >= min && count <= max;
  });
}

/** revenueRange に該当するか判定 (入力 revenue は百万円単位) */
export function matchesRevenueRange(revenueMillionYen: number | undefined, ranges: string[] | null | undefined): boolean {
  if (!Array.isArray(ranges) || ranges.length === 0) return false;
  if (typeof revenueMillionYen !== 'number' || !Number.isFinite(revenueMillionYen)) return false;

  return ranges.some((range: any) => {
    switch (range) {
      case 'under_100m':  return revenueMillionYen < 100;
      case '100m-1b':     return revenueMillionYen >= 100 && revenueMillionYen < 1000;
      case '1b-10b':      return revenueMillionYen >= 1000 && revenueMillionYen < 10000;
      case '10b-100b':    return revenueMillionYen >= 10000 && revenueMillionYen < 100000;
      case 'over_100b':   return revenueMillionYen >= 100000;
      default:            return false;
    }
  });
}

/** メイン: 適合度スコアを計算する */
export function score(record: ScorerRecord | null | undefined, criteria: ScorerCriteria | null | undefined, options: ScorerOptions = {}): ScorerResult {
  if (!record || typeof record !== 'object') {
    return { fitScore: 0, fitReasons: [], riskFlags: [], recommendedAction: 'skip' };
  }
  const fromSettings = settings.getListBuilderScoring?.();
  const cfg: ListBuilderScoring = {
    ...DEFAULT_SCORING,
    ...((fromSettings && typeof fromSettings === 'object') ? fromSettings : {}),
    ...((options.scoring && typeof options.scoring === 'object') ? options.scoring : {}),
  };
  const c = criteria ?? {};
  let total = 0;
  const reasons: string[] = [];
  const flags: string[] = Array.isArray(record.riskFlags) ? [...record.riskFlags] : [];

  // ---- 重大リスクフラグの検出 (即 skip) ----
  if (!options.ignoreRiskFlags) {
    for (const f of flags) {
      if (SKIP_RISK_FLAGS.has(f)) {
        return {
          fitScore: 0,
          fitReasons: [`リスクフラグ: ${f}`],
          riskFlags: flags,
          recommendedAction: 'skip',
        };
      }
    }
  }

  if (Array.isArray(c.industries) && c.industries.length > 0
      && record.industry
      && c.industries.includes(record.industry)) {
    total += cfg.industry || 0;
    reasons.push(`業種一致: ${record.industry}`);
  }

  if (Array.isArray(c.prefectures) && c.prefectures.length > 0
      && record.prefecture
      && c.prefectures.includes(record.prefecture)) {
    total += cfg.prefecture || 0;
    reasons.push(`地域一致: ${record.prefecture}`);
  }

  if (matchesEmployeeRange(record.employeeCount, c.employeeRanges)) {
    total += cfg.size || 0;
    reasons.push(`規模一致: 従業員 ${record.employeeCount}名`);
  }

  if (record.corporateNumber && record.domainRoot) {
    total += cfg.officialVerified || 0;
    reasons.push('公式サイト確認済み');
  }

  if (record.formUrl && FORM_TYPES_SAFE.has(record.formType as FormType)) {
    total += cfg.formAvailable || 0;
    reasons.push(`問い合わせフォームあり: ${record.formType}`);
  } else if (record.formUrl && FORM_TYPES_BLOCKING.has(record.formType as FormType)) {
    flags.push(`form_type_${record.formType}_blocking`);
  }

  const priorCount = typeof record.priorContactCount === 'number' ? record.priorContactCount : 0;
  if (priorCount === 0) {
    total += cfg.noPriorContact || 0;
    reasons.push('過去送信なし');
  }

  if (Array.isArray(c.keywords) && c.keywords.length > 0) {
    const haystack = [
      record.businessSummary ?? '',
      record.industry ?? '',
      Array.isArray(record.businessItems) ? record.businessItems.join(' ') : '',
    ].join(' ').toLowerCase();
    const matched = c.keywords.find((kw: any) =>
      typeof kw === 'string' && kw.length > 0 && haystack.includes(kw.toLowerCase())
    );
    if (matched) {
      total += cfg.keywordMatch || 0;
      reasons.push(`キーワード一致: ${matched}`);
    }
  }

  let action: RecommendedAction = 'skip';
  if (total >= 70) action = 'add';
  else if (total >= 50) action = 'review';

  return {
    fitScore: total,
    fitReasons: reasons,
    riskFlags: flags,
    recommendedAction: action,
  };
}

/** バッチスコア計算 */
export function scoreAll(records: ScorerRecord[] | null | undefined, criteria: ScorerCriteria | null | undefined, options: ScorerOptions = {}): Array<ScorerRecord & ScorerResult> {
  if (!Array.isArray(records)) return [];
  return records.map((r: any) => ({ ...r, ...score(r, criteria, options) }));
}

module.exports = {
  score,
  scoreAll,
  matchesEmployeeRange,
  matchesRevenueRange,
  DEFAULT_SCORING,
  FORM_TYPES_SAFE,
  FORM_TYPES_BLOCKING,
  SKIP_RISK_FLAGS,
};

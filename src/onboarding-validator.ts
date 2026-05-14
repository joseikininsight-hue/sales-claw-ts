// Onboarding wizard input validation.
//
// 各ステップ単位で部分検証もできるよう、関数を分離する。
// 軽量化のため zod / ajv 等の追加依存は入れず手書きルールで実装。

import type { CompanyProfile, Strength } from './types/settings';
import type { TargetCompany } from './types/target';

export type ValidationCode = 'required' | 'invalid' | 'min_length';

export interface ValidationError {
  field: string;
  code: ValidationCode;
  message?: string;
}

export interface AiAuthStatus {
  installed?: boolean;
  loggedIn?: boolean;
  providerLabel?: string;
  [key: string]: unknown;
}

export interface AiAuthOptions {
  bypassAi?: boolean;
}

export interface OnboardingPayload {
  companyProfile?: Partial<CompanyProfile>;
  valuePropositions?: { strengths?: Partial<Strength>[] };
  targetList?: Partial<TargetCompany>[] | null;
  aiAuthStatus?: AiAuthStatus | null;
  bypassAi?: boolean;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^[+]?[\d\-()\s]{8,}$/;
const URL_RE = /^https?:\/\/[^\s<>]+$/i;

function _required(field: string, value: unknown): ValidationError | null {
  if (value === null || value === undefined) return { field, code: 'required' };
  if (typeof value === 'string' && value.trim() === '') return { field, code: 'required' };
  if (Array.isArray(value) && value.length === 0) return { field, code: 'required' };
  return null;
}

/** Step 1 (companyProfile) の検証。 */
export function validateCompanyProfile(profile: Partial<CompanyProfile> = {}): ValidationError[] {
  const errors: ValidationError[] = [];
  const required: Array<keyof CompanyProfile> = ['companyName', 'contactName', 'email', 'phone', 'address'];
  for (const f of required) {
    const r = _required(f, profile[f]);
    if (r) errors.push({ ...r, message: `${f} は必須です` });
  }
  if (profile.email && !EMAIL_RE.test(String(profile.email).trim())) {
    errors.push({ field: 'email', code: 'invalid', message: 'メールアドレスの形式が正しくありません' });
  }
  if (profile.phone && !PHONE_RE.test(String(profile.phone).trim())) {
    errors.push({ field: 'phone', code: 'invalid', message: '電話番号の形式が正しくありません' });
  }
  if (profile.website && !URL_RE.test(String(profile.website).trim())) {
    errors.push({ field: 'website', code: 'invalid', message: 'Web サイトの URL は http:// または https:// で始めてください' });
  }
  return errors;
}

/**
 * Step 2 (valuePropositions.strengths) の検証。
 * 最低 1 つ。各 strength は label と detail が必須。
 */
export function validateStrengths(strengths: Partial<Strength>[] = []): ValidationError[] {
  const errors: ValidationError[] = [];
  if (!Array.isArray(strengths) || strengths.length === 0) {
    errors.push({ field: 'strengths', code: 'min_length', message: '強みを最低 1 つ追加してください' });
    return errors;
  }
  strengths.forEach((s, i) => {
    if (!s || typeof s !== 'object') {
      errors.push({ field: `strengths[${i}]`, code: 'invalid', message: '不正な形式の強みです' });
      return;
    }
    const r1 = _required(`strengths[${i}].label`, s.label);
    if (r1) errors.push({ ...r1, message: `${i + 1} 件目の強み「ラベル」は必須です` });
    const r2 = _required(`strengths[${i}].detail`, s.detail);
    if (r2) errors.push({ ...r2, message: `${i + 1} 件目の強み「詳細」は必須です` });
  });
  return errors;
}

/**
 * Step 3 (target list) の検証。
 * リスト未アップロード = スキップ扱いで OK (errors なし)。
 * アップロードした場合は最低 1 件、name 必須。
 */
export function validateTargetList(targets: Partial<TargetCompany>[] | null | undefined): ValidationError[] {
  const errors: ValidationError[] = [];
  if (!targets) return errors; // skip allowed
  if (!Array.isArray(targets) || targets.length === 0) {
    errors.push({ field: 'targets', code: 'min_length', message: 'ターゲット会社が 0 件です。スキップするかアップロードし直してください' });
    return errors;
  }
  let missingNames = 0;
  for (const t of targets) {
    const candidate = t as Record<string, unknown>;
    const name = candidate && (candidate.name ?? candidate.companyName ?? candidate.company ?? candidate['会社名']);
    if (!name || String(name).trim() === '') missingNames++;
  }
  if (missingNames > 0) {
    errors.push({
      field: 'targets',
      code: 'invalid',
      message: `${missingNames} 件のレコードに会社名がありません。Excel/CSV の先頭行に「会社名」列があることを確認してください`,
    });
  }
  return errors;
}

/**
 * Step 4 (AI provider 認証状態) の検証。
 * loggedIn が false でもスキップ可能だが、wizard 完了は許可しない方針。
 * なので「強制終了したい場合」は別フィールド `bypassAi` で明示する。
 */
export function validateAiAuth(authStatus: AiAuthStatus | null | undefined, options: AiAuthOptions = {}): ValidationError[] {
  const errors: ValidationError[] = [];
  if (options.bypassAi === true) return errors;
  if (!authStatus) {
    errors.push({ field: 'aiAuth', code: 'required', message: 'AI プロバイダの認証状態を確認できませんでした' });
    return errors;
  }
  if (!authStatus.installed) {
    errors.push({ field: 'aiAuth', code: 'invalid', message: `${authStatus.providerLabel ?? 'AI'} CLI がインストールされていません` });
  }
  if (!authStatus.loggedIn) {
    errors.push({ field: 'aiAuth', code: 'invalid', message: `${authStatus.providerLabel ?? 'AI'} にログインしてください` });
  }
  return errors;
}

/** 全ステップ統合検証 (最終 submit 時)。 */
export function validateAll(payload: OnboardingPayload = {}): ValidationError[] {
  return [
    ...validateCompanyProfile(payload.companyProfile),
    ...validateStrengths(payload.valuePropositions?.strengths),
    ...validateTargetList(payload.targetList),
    ...validateAiAuth(payload.aiAuthStatus, { bypassAi: Boolean(payload.bypassAi) }),
  ];
}

module.exports = {
  validateCompanyProfile,
  validateStrengths,
  validateTargetList,
  validateAiAuth,
  validateAll,
  // expose for tests
  _internals: { EMAIL_RE, PHONE_RE, URL_RE },
};

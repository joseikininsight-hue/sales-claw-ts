// 法令適合 (P0-4) — 特定電子メール法 / 個人情報保護法 への配慮を支援する。
//
// 重要: 本モジュールは「ユーザーが法令を守る助けを提供する」ものであり、
// 法令適合を保証するものではない。最終責任はユーザー側。
//
// 機能:
//   1. injectRequiredFooter(message, profile)
//      送信メッセージに以下が含まれていない場合、フッターとして追記:
//        - 送信者氏名 (companyProfile.contactName / companyName)
//        - 連絡先 (email / phone) - 既に signature にあれば追加しない
//        - オプトアウト方法 (送信停止希望はこちらまで: <email>)
//
//   2. checkCompliance(message, profile, options)
//      メッセージをスキャンして欠落要素のリストを返す。UI で「コンプライアンス
//      チェック」アイコンに使う。
//
// 特定電子メール法 4 項の主な要件 (法律実装の参考、保証ではない):
//   - 表示者の氏名・名称 / 住所 / 受信拒否の通知を行うための電子メールアドレス
//
// フォーム入力の場合「電子メールに該当しない」見解もあるが、相手企業に
// 営業目的で連絡する以上、同等の表示を入れておくのが安全。

import type { CompanyProfile } from './types/settings';

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
  missing: string[];
  summary: string;
}

export interface InjectFooterOptions {
  /** オプトアウト案内のみ追加 (signature が既にある場合) */
  optOutOnly?: boolean;
}

/** メッセージ判定に使う最小限のプロフィール形。`CompanyProfile` のサブセット */
export type ComplianceProfile = Partial<Pick<CompanyProfile, 'companyName' | 'contactName' | 'email' | 'phone' | 'address'>>;

/** メッセージにオプトアウト案内 + 送信元情報があるかをスキャンする。 */
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
  // オプトアウト指示: 「配信停止」「送信停止」「ご不要の場合」「お断り」「unsubscribe」等のキーワード
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

export function buildRequiredFooter(profile: ComplianceProfile = {}): string {
  const lines: string[] = [];
  if (profile.companyName) lines.push(String(profile.companyName));
  if (profile.contactName) lines.push(String(profile.contactName));
  if (profile.address) lines.push('住所: ' + String(profile.address));
  if (profile.phone) lines.push('TEL: ' + String(profile.phone));
  if (profile.email) lines.push('MAIL: ' + String(profile.email));
  if (profile.email) {
    lines.push('');
    lines.push('※今後のご連絡が不要な場合は ' + String(profile.email) + ' までご一報ください。速やかに送信を停止いたします。');
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
  const check = checkCompliance(text, profile);
  const lines: string[] = [];

  if (!optOutOnly) {
    if (!check.hasSenderCompany && profile.companyName) {
      lines.push(String(profile.companyName));
    }
    if (!check.hasSenderName && profile.contactName) {
      lines.push(String(profile.contactName));
    }
    if (!check.hasSenderAddress && profile.address) {
      lines.push('住所: ' + String(profile.address));
    }
    if (profile.phone && !text.includes(String(profile.phone))) {
      lines.push('TEL: ' + String(profile.phone));
    }
    if (!check.hasContactEmail && profile.email) {
      lines.push('MAIL: ' + String(profile.email));
    }
  }
  if (!check.hasOptOut && profile.email) {
    lines.push('');
    lines.push('※今後のご連絡が不要な場合は ' + String(profile.email) + ' までご一報ください。速やかに送信を停止いたします。');
  }
  if (lines.length === 0) return text;

  // 末尾に空行を 1 つ挟んで連結
  const ending = text.endsWith('\n') ? '' : '\n';
  return text + ending + '\n' + lines.join('\n');
}

/** UI 表示用の compliance バッジ判定。 */
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
};

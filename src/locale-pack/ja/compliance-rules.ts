// 日本ロケール (ja-jp) 向けコンプライアンスチェック規則。
//
// 特定電子メール法 4 項要件 (本機能は法令適合を保証するものではない / 最終責任はユーザー):
//   - 送信元会社名 (companyName)
//   - 送信者氏名 (contactName)
//   - 連絡先メール (email)
//   - オプトアウト案内 (配信停止 / 送信停止 / 今後ご連絡が不要 等)
//
// 注意: 本ファイルは「日本のサイトに営業フォームから連絡する場合」を主対象とする。
//       他国の規制 (CAN-SPAM / GDPR) は en/compliance-rules.ts に定義する。

export interface ComplianceCheck {
  /** ルール識別子 (UI / ログ / i18n キー組み立てに使用) */
  id: string;
  /** 必須フラグ (false なら warn 扱い / true なら fail 扱い) */
  required: boolean;
  /** メッセージ内に該当要素が存在するか判定する regex 群。空配列ならプロフィール値ベースで判定 */
  patterns: RegExp[];
  /** i18n キー (UI 側で t(lang, key) で展開する想定) */
  errorKey: string;
  /** ユーザー向けヒント (該当 locale の自然言語) */
  hint: string;
}

const ja_jp: ComplianceCheck[] = [
  {
    id: 'sender-company',
    required: true,
    patterns: [],
    errorKey: 'compliance.ja_jp.missing.senderCompany',
    hint: '送信元の会社名 (companyProfile.companyName) を本文末尾に表示してください。',
  },
  {
    id: 'sender-name',
    required: true,
    patterns: [],
    errorKey: 'compliance.ja_jp.missing.senderName',
    hint: '送信者氏名 (companyProfile.contactName) を本文末尾に表示してください。',
  },
  {
    id: 'sender-address',
    required: true,
    patterns: [],
    errorKey: 'compliance.ja_jp.missing.senderAddress',
    hint: '住所 (companyProfile.address) を本文末尾に表示してください (特定電子メール法 4 項)。',
  },
  {
    id: 'contact-email',
    required: true,
    patterns: [],
    errorKey: 'compliance.ja_jp.missing.contactEmail',
    hint: '連絡先メール (companyProfile.email) を本文末尾に表示してください。',
  },
  {
    id: 'opt-out',
    required: false,
    patterns: [
      /(配信停止|送信停止|ご不要の場合|お断り|オプトアウト|unsubscribe|今後[\s　]*ご連絡[\s　]*(が)?不要|今後[\s　]*の[\s　]*連絡[\s　]*(が)?不要)/i,
    ],
    errorKey: 'compliance.ja_jp.missing.optOut',
    hint: '受信拒否方法 (例: 「今後ご連絡が不要な場合は <email> までご一報ください」) を本文に含めてください。',
  },
];

const en_us: ComplianceCheck[] = [];
const en_eu: ComplianceCheck[] = [];
const other: ComplianceCheck[] = [];

// ja パックは ja-jp ルールのみ提供する。en_us / en_eu / other は en/compliance-rules.ts で定義し、
// getComplianceRules() で country -> pack の dispatch を行う。
module.exports = { ja_jp, en_us, en_eu, other };
export {};

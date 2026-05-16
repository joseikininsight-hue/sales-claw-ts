// 英語ロケール向けコンプライアンスチェック規則。
//
// 本ファイルは US (CAN-SPAM), EU (GDPR), Other (最小要件) の 3 つの規制セットを定義する。
// 本機能は法令適合を保証するものではない。最終責任はユーザー側にある。
//
// 規制の概要 (参考):
//   - CAN-SPAM Act (US, 15 U.S.C. § 7704):
//       * 識別可能な送信者情報
//       * 有効な物理 (postal) 住所  ← REQUIRED
//       * オプトアウト手段の明示
//       * 商業目的であることの開示
//   - GDPR (EU Regulation 2016/679):
//       * データ管理者 (controller) の identification
//       * 処理の法的根拠 (lawful basis) の表示
//       * オプトアウト / 同意撤回手段の明示
//
// 注意: 法令解釈はユーザー側で行う。本データは「機械的に検出できる典型パターン」のみ列挙する。

import type { ComplianceCheck } from '../ja/compliance-rules';

const ja_jp: ComplianceCheck[] = [];

const OPT_OUT_EN = /\b(unsubscribe|opt[-\s]?out|do not contact|stop receiving|remove me from|click here to unsubscribe)\b/i;
const OPT_OUT_GDPR = /\b(withdraw consent|right to object|right to erasure|exercise your rights)\b/i;

const en_us: ComplianceCheck[] = [
  {
    id: 'sender-company',
    required: true,
    patterns: [],
    errorKey: 'compliance.en_us.missing.senderCompany',
    hint: 'Identify yourself or your company by name (CAN-SPAM sender identification).',
  },
  {
    id: 'sender-name',
    required: true,
    patterns: [],
    errorKey: 'compliance.en_us.missing.senderName',
    hint: 'Include the sender contact name so the recipient can identify who is reaching out.',
  },
  {
    id: 'postal-address',
    required: true,
    patterns: [],
    errorKey: 'compliance.en_us.missing.postalAddress',
    hint: 'Physical postal address is mandatory under CAN-SPAM. Include a valid street / PO box address.',
  },
  {
    id: 'contact-email',
    required: true,
    patterns: [],
    errorKey: 'compliance.en_us.missing.contactEmail',
    hint: 'Provide a reply-to email address the recipient can use to contact you or opt out.',
  },
  {
    id: 'opt-out',
    required: true,
    patterns: [OPT_OUT_EN],
    errorKey: 'compliance.en_us.missing.optOut',
    hint: 'Provide a clear opt-out / unsubscribe mechanism (e.g. "Reply with unsubscribe to stop receiving messages").',
  },
  {
    id: 'commercial-disclosure',
    required: false,
    patterns: [
      /\b(this is a commercial message|advertisement|sales inquiry|business outreach|partnership inquiry)\b/i,
    ],
    errorKey: 'compliance.en_us.missing.commercialDisclosure',
    hint: 'Disclose that the message is a commercial / sales outreach (recommended under CAN-SPAM).',
  },
];

const en_eu: ComplianceCheck[] = [
  {
    id: 'sender-company',
    required: true,
    patterns: [],
    errorKey: 'compliance.en_eu.missing.senderCompany',
    hint: 'Identify yourself as the data controller (company name) under GDPR Art. 13.',
  },
  {
    id: 'sender-name',
    required: true,
    patterns: [],
    errorKey: 'compliance.en_eu.missing.senderName',
    hint: 'Include the sender contact name for transparency.',
  },
  {
    id: 'contact-email',
    required: true,
    patterns: [],
    errorKey: 'compliance.en_eu.missing.contactEmail',
    hint: 'Provide a contact email so the recipient can exercise GDPR rights.',
  },
  {
    id: 'lawful-basis',
    required: true,
    patterns: [
      /\b(legitimate interest|lawful basis|article 6|art\.?\s*6|consent|legal obligation|contract)\b/i,
    ],
    errorKey: 'compliance.en_eu.missing.lawfulBasis',
    hint: 'State the lawful basis for processing (e.g. "based on legitimate interest under GDPR Art. 6(1)(f)").',
  },
  {
    id: 'opt-out',
    required: true,
    patterns: [OPT_OUT_EN, OPT_OUT_GDPR],
    errorKey: 'compliance.en_eu.missing.optOut',
    hint: 'Inform recipients of their right to object / withdraw consent and how to do so.',
  },
  {
    id: 'data-controller',
    required: false,
    patterns: [
      /\b(data controller|controller within the meaning|on behalf of)\b/i,
    ],
    errorKey: 'compliance.en_eu.missing.dataController',
    hint: 'Identify yourself as the data controller and (if applicable) the DPO contact.',
  },
];

// Other: 最小要件のみ — 送信者識別 + オプトアウト
const other: ComplianceCheck[] = [
  {
    id: 'sender-company',
    required: true,
    patterns: [],
    errorKey: 'compliance.other.missing.senderCompany',
    hint: 'Identify the sender (company or individual) so the recipient knows who is contacting them.',
  },
  {
    id: 'opt-out',
    required: true,
    patterns: [OPT_OUT_EN],
    errorKey: 'compliance.other.missing.optOut',
    hint: 'Provide a way to opt out of further communications.',
  },
];

module.exports = { ja_jp, en_us, en_eu, other };
export {};

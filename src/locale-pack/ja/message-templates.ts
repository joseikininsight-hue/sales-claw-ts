// メッセージビルダー用テキスト断片 (日本語)
//
// message-builder.ts の buildObservationPoints / buildProposalPoint /
// buildProofPoint / buildMessage / buildCustomMessage 内のハードコード文を
// 関数として抽出。本ファイルは「ある程度の入力 → 1 行の文字列」を返すだけで、
// truncation や finalize は呼び出し側に委ねる。

interface ObservationStrings {
  partnerNote: string;
  focusNote: (focusLabel: string) => string;
  areaNote: (areaLabel: string) => string;
  typeNote: (companyType: string) => string;
  fallbackNote: (companyName: string) => string;
}

interface ProposalStrings {
  withGap: (
    strengthLabel: string,
    capability: string,
    areaLabel: string,
    secondaryText: string,
  ) => string;
  secondaryComplement: (secondaryLabel: string) => string;
  fallbackStrength: (label: string, detail: string) => string;
}

interface ProofStrings {
  partnerProof: (partner: string, proof: string, matchedType: string) => string;
  fallbackProof: (proof: string) => string;
}

interface UrlMissingStrings {
  introWithName: (companyName: string, contactName: string) => string;
  introNameless: (companyName: string) => string;
  proposalWithStrengths: (companyName: string, ownStrengths: string) => string;
  proposalWithoutStrengths: (companyName: string) => string;
  defaultClosing: string;
  optOutLine: string;
  cliPlaceholder: string;
  defaultGreeting: string;
}

interface OpenerStrings {
  partnerOpener: (mainStrength: string) => string;
  focusOpener: (focusLabel: string) => string;
  areaOpener: (areaStr: string) => string;
  defaultOpener: string;
}

interface HookStrings {
  withPartnerArea: (label: string, detail: string, partnerArea: string) => string;
  withDetailOnly: (label: string, detail: string) => string;
  fallbackStrength: (label: string, detail: string) => string;
}

interface DefaultStrings {
  greetingLine: string;
  introWithName: (companyName: string, contactName: string) => string;
}

const observation: ObservationStrings = {
  partnerNote: '貴社サイトで外部連携や募集に関する記載を拝見しました。',
  focusNote: (focusLabel: string) =>
    `特に${focusLabel}を継続テーマとして進めておられる点が印象に残りました。`,
  areaNote: (areaLabel: string) =>
    `また、${areaLabel}を軸に事業展開されており、案件によって周辺領域まで含めた体制づくりが必要になるのではないかと感じました。`,
  typeNote: (companyType: string) =>
    `貴社が${companyType}として幅広い案件対応を担われている前提で拝見しました。`,
  fallbackNote: (companyName: string) =>
    `${companyName}様の公開情報を拝見し、汎用的な売り込みではなく実務面で補完できる余地を考えてご連絡しています。`,
};

const proposal: ProposalStrings = {
  withGap: (strengthLabel: string, capability: string, areaLabel: string, secondaryText: string) =>
    `弊社では${strengthLabel}を主な対応領域としており、${capability}貴社の${areaLabel}領域でも、要件整理後の実装や不足しやすい専門工程の補完役としてご一緒できる余地があると考えております。${secondaryText}`,
  secondaryComplement: (secondaryLabel: string) =>
    `必要に応じて${secondaryLabel}周辺まで含めて柔軟に支援できます。`,
  fallbackStrength: (label: string, detail: string) =>
    `弊社では${label}を主な対応領域としており、${detail}必要な工程だけを補完する形でもご一緒できます。`,
};

const proof: ProofStrings = {
  partnerProof: (partner: string, proofText: string, matchedType: string) =>
    `${partner ? `実際に${partner}様では、` : '実際の支援では、'}${proofText}${proofText.endsWith('。') ? '' : '。'}${matchedType ? `${matchedType}に近い文脈でも、必要な工程だけを補完する進め方に対応できます。` : '必要な工程だけを切り出して進める形にも対応できます。'}`,
  fallbackProof: (proofText: string) =>
    `${proofText}${proofText.endsWith('。') ? '' : '。'}要件整理後の実装や追加開発の補完といった進め方でご一緒することが多いです。`,
};

const urlMissing: UrlMissingStrings = {
  defaultGreeting: 'お世話になります。',
  introWithName: (companyName: string, contactName: string) =>
    `${companyName}の${contactName}と申します。`,
  introNameless: (companyName: string) => `${companyName || ''}より失礼いたします。`,
  proposalWithStrengths: (companyName: string, ownStrengths: string) =>
    `弊社では${ownStrengths}を中心にご支援しております。${companyName}様のお取り組みを拝見し、お役に立てる場面があるかもしれずご連絡しました。`,
  proposalWithoutStrengths: (companyName: string) =>
    `${companyName}様のお取り組みを拝見し、ご連絡しました。`,
  defaultClosing:
    'もしご関心いただけましたら、30分程度の情報交換のお時間をいただけますと幸いです。',
  optOutLine: '不要であれば本メッセージへのご返信は不要です。',
  cliPlaceholder: '【URL 不在のため、CLI 本体が公式サイト探索後に本文を最終化します】',
};

const opener: OpenerStrings = {
  partnerOpener: (mainStrength: string) =>
    `貴社のパートナー募集を拝見し、${mainStrength}の専門チームとして協業の可能性があるのではないかと思い、ご連絡いたしました。`,
  focusOpener: (focusLabel: string) =>
    `貴社の${focusLabel}への取り組みを拝見し、お力添えできることがあるのではないかと思い、ご連絡いたしました。`,
  areaOpener: (areaStr: string) =>
    `貴社の${areaStr}事業を拝見いたしました。顧客案件の中で、専門パートナーが必要になることはございませんでしょうか。`,
  defaultOpener: '貴社の事業について拝見し、ご連絡いたしました。',
};

const hook: HookStrings = {
  withPartnerArea: (label: string, detail: string, partnerArea: string) =>
    `弊社は${label}を専門としており、${detail}。貴社の${partnerArea}の知見と、弊社の技術力を組み合わせることで、顧客への提案の幅を広げるお手伝いができるのではないかと考えております。`,
  withDetailOnly: (label: string, detail: string) =>
    `弊社は${label}を専門としており、${detail}。お力添えできるかと存じます。`,
  fallbackStrength: (label: string, detail: string) =>
    `弊社は${label}を専門としております。${detail || ''}`,
};

const defaults: DefaultStrings = {
  greetingLine: 'お世話になります。',
  introWithName: (companyName: string, contactName: string) =>
    `${companyName}の${contactName}と申します。`,
};

module.exports = {
  observation,
  proposal,
  proof,
  urlMissing,
  opener,
  hook,
  defaults,
};

export {};

// Message-builder text fragments (English)
//
// English-equivalent of src/locale-pack/ja/message-templates.ts. Same shape:
// each function returns a single short sentence and the caller is responsible
// for truncation / finalization.

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
  partnerNote: 'I noticed sections on your site that mention partnerships and external collaboration.',
  focusNote: (focusLabel: string) =>
    `In particular, your ongoing focus on ${focusLabel} stood out to me.`,
  areaNote: (areaLabel: string) =>
    `You also seem to operate around ${areaLabel}, which suggests there may be cases where complementary skills around adjacent areas would be useful.`,
  typeNote: (companyType: string) =>
    `I read your site assuming you handle a wide range of engagements as a ${companyType}.`,
  fallbackNote: (companyName: string) =>
    `I went through ${companyName}\'s public information and could potentially complement your operations on the implementation side rather than offer a generic pitch.`,
};

const proposal: ProposalStrings = {
  withGap: (strengthLabel: string, capability: string, areaLabel: string, secondaryText: string) =>
    `We focus on ${strengthLabel} and ${capability} For your ${areaLabel} efforts as well, we may be able to help by complementing the implementation phase or specialist steps that tend to be in short supply. ${secondaryText}`,
  secondaryComplement: (secondaryLabel: string) =>
    `If needed, we can flexibly extend support to areas around ${secondaryLabel}.`,
  fallbackStrength: (label: string, detail: string) =>
    `We focus on ${label} and ${detail} We can also engage in a way that complements only the steps you need.`,
};

const proof: ProofStrings = {
  partnerProof: (partner: string, proofText: string, matchedType: string) =>
    `${partner ? `In an actual engagement with ${partner}, ` : 'In past engagements, '}${proofText}${proofText.endsWith('.') ? '' : '.'} ${matchedType ? `In contexts close to ${matchedType}, we can also engage in a complement-only mode.` : 'We can also engage by carving out only the steps you need.'}`,
  fallbackProof: (proofText: string) =>
    `${proofText}${proofText.endsWith('.') ? '' : '.'} We often engage by complementing post-requirements implementation or additional development.`,
};

const urlMissing: UrlMissingStrings = {
  defaultGreeting: 'Hello,',
  introWithName: (companyName: string, contactName: string) =>
    `My name is ${contactName} from ${companyName}.`,
  introNameless: (companyName: string) => `Reaching out from ${companyName || ''}.`,
  proposalWithStrengths: (companyName: string, ownStrengths: string) =>
    `We primarily support clients with ${ownStrengths}. After looking at ${companyName}\'s work, there might be situations where we could be useful, so I wanted to get in touch.`,
  proposalWithoutStrengths: (companyName: string) =>
    `After looking at ${companyName}\'s work, I wanted to get in touch.`,
  defaultClosing:
    'If this is of interest, would you have around 30 minutes for an information exchange?',
  optOutLine: 'No reply needed if this is not relevant.',
  cliPlaceholder: '[URL is missing — the CLI itself will finalize the body after locating the official site]',
};

const opener: OpenerStrings = {
  partnerOpener: (mainStrength: string) =>
    `I came across your partner program and thought we might be a good fit as a specialist team in ${mainStrength}, so I wanted to reach out.`,
  focusOpener: (focusLabel: string) =>
    `I noticed your work on ${focusLabel} and thought there might be areas where we could help, so I wanted to reach out.`,
  areaOpener: (areaStr: string) =>
    `I had a look at your ${areaStr} business. I imagine there are projects where having a specialist partner would be useful — is that ever the case?`,
  defaultOpener: 'I had a look at your business and wanted to get in touch.',
};

const hook: HookStrings = {
  withPartnerArea: (label: string, detail: string, partnerArea: string) =>
    `We specialize in ${label} and ${detail}. By combining your knowledge in ${partnerArea} with our technical capabilities, we may be able to help broaden the scope of what you can offer your clients.`,
  withDetailOnly: (label: string, detail: string) =>
    `We specialize in ${label} and ${detail}. We may be able to help.`,
  fallbackStrength: (label: string, detail: string) =>
    `We specialize in ${label}. ${detail || ''}`,
};

const defaults: DefaultStrings = {
  greetingLine: 'Hello,',
  introWithName: (companyName: string, contactName: string) =>
    `My name is ${contactName} from ${companyName}.`,
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

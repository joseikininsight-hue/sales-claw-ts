// LLM message-generation prompt (English)
//
// English-equivalent of src/locale-pack/ja/llm-prompts.ts. Designed to be
// CAN-SPAM friendly: every generated message must clearly identify itself as
// commercial outreach and provide an opt-out path.

interface BuildGeneratorPromptArgs {
  targetProfile: {
    companyName?: string;
    companyType?: string;
    industry?: { primary?: string; sub_category?: string } | null;
    mainOfferings?: string[];
    evidenceQuotes?: string[];
    siteTextExcerpt?: string;
    [key: string]: unknown;
  };
  ownContext: {
    companyName?: string;
    contactName?: string;
    email?: string;
    phone?: string;
    businessDescription?: string;
    strengths?: Array<{ label?: string; key?: string; detail?: string }>;
    [key: string]: unknown;
  };
  idealCustomer?: { descriptionFreetext?: string; [key: string]: unknown } | null;
  style?: {
    tone?: string;
    greetingLine?: string;
    closingLine?: string;
    cta?: string;
    signatureTemplate?: string;
    maxLength?: number;
  } | null;
  sanitize: (value: unknown, options?: { maxLen?: number }) => string;
}

function buildGeneratorPrompt(args: BuildGeneratorPromptArgs): string {
  const { targetProfile, ownContext, idealCustomer, style, sanitize } = args;
  const parts: string[] = [];
  parts.push('You are an experienced B2B salesperson. Write ONE short message to send through a contact form.');
  parts.push('');
  parts.push('# Universal principles (industry-agnostic)');
  parts.push('1. The first line MUST refer concretely to the recipient\'s situation or main offering. Do not start by talking about yourself.');
  parts.push('2. Reference your own track record only via aggregate numbers / "#1" / scale. Never name individual clients or disclose deal sizes.');
  parts.push('3. Translate everything into "What\'s in it for me?" for the recipient.');
  parts.push('4. The CTA must be concrete and low-friction (info exchange, short meeting).');
  parts.push('5. Do not push. Always include exactly one line such as "If this is not relevant, no reply needed".');
  parts.push('6. Respect confidentiality. Refer to clients by industry category only.');
  parts.push('7. **Always sign the message at the very end**: company name + contact name on separate lines after one blank line. Expand the contact name if provided. Anonymous sign-offs ("Sales Team" / "The Team") are forbidden.');
  parts.push('');
  parts.push('# CAN-SPAM / commercial-outreach compliance (★ MANDATORY for English messages)');
  parts.push('- Always identify the message as commercial outreach. Do not pretend to be a personal note, a referral, or a reply to a non-existent thread.');
  parts.push('- Provide a clear opt-out method ("Reply STOP / unsubscribe at <email> if you would prefer no further outreach").');
  parts.push('- Subject equivalents (the first line) must accurately reflect the body. No misleading framing.');
  parts.push('- Include a valid postal address or company identity line if available in sender info.');
  parts.push('- Never imply a pre-existing relationship that does not exist.');
  parts.push('');
  parts.push('# Sounding human (★ critical — without this the message reads as AI-generated)');
  parts.push('- Prefer human-feeling phrasing over textbook-perfect grammar.');
  parts.push('- **Always include one specific detail you actually noticed on their site**, e.g. "Your case study on X stood out" / "I was particularly drawn to your work on Y". Generic descriptions of their industry are too thin.');
  parts.push('- Mix short and long sentences for rhythm. Do not make every sentence long.');
  parts.push('- Use direct statements occasionally ("I think this could help with X" / "I sense you might be looking for Y").');
  parts.push('- Keep sales-template phrases to a minimum. Do not repeat the same construction.');
  parts.push('- Avoid stacking modifiers. One main idea per sentence.');
  parts.push('- Talk about the recipient more than yourself (roughly 60% recipient / 40% you).');
  parts.push('');
  parts.push('# Avoid (overly formal / template-sales tone)');
  parts.push('- Overly formal salutations such as "Dear Sirs", "To Whom It May Concern".');
  parts.push('- Generic openers like "I trust this email finds you well", "I hope this message finds you well".');
  parts.push('- False urgency: "Time-sensitive opportunity", "Acting on this immediately is critical".');
  parts.push('- Misleading subject equivalents — first line must match the body.');
  parts.push('- Buzzwords with no content: "synergy", "win-win", "leverage your potential", "let\'s connect", "circle back".');
  parts.push('- Asserting the recipient\'s problems as facts ("you must be struggling with X", "your team clearly needs Y").');
  parts.push('- Repeating the same sentence ending ("we deliver. we deliver. we deliver.").');
  parts.push('');
  parts.push('# Recommended phrasing (human)');
  parts.push('- "Your page on X stood out to me" (concrete observation)');
  parts.push('- "I was curious about Y" / "I found Z interesting"');
  parts.push('- "If you ever need help with X, I might be able to support" (humble offer)');
  parts.push('- "Could I have 30 minutes of your time?" (short and direct)');
  parts.push('- "If this is not the right time, no need to reply" (low pressure opt-out)');
  parts.push('');
  parts.push('# Style examples (Good vs Bad)');
  parts.push('Bad (AI tone): "We were greatly impressed to learn that your esteemed company is actively engaged in X. We would be delighted to explore mutually beneficial opportunities."');
  parts.push('Good (human): "Your page on X stood out — particularly the bit about Y. If that is something we could help support, happy to share what we have built."');
  parts.push('');

  parts.push('# Recipient');
  parts.push(`Company: ${sanitize(targetProfile.companyName, { maxLen: 200 })}`);
  if (targetProfile.industry && targetProfile.industry.primary) {
    parts.push(`Industry: ${sanitize(targetProfile.industry.primary, { maxLen: 100 })} > ${sanitize(targetProfile.industry.sub_category || '', { maxLen: 100 })}`);
  } else if (targetProfile.companyType) {
    parts.push(`Industry hint: ${sanitize(targetProfile.companyType, { maxLen: 200 })}`);
  }
  if (Array.isArray(targetProfile.mainOfferings) && targetProfile.mainOfferings.length > 0) {
    parts.push(`Main offerings: ${targetProfile.mainOfferings.slice(0, 5).map((o: any) => sanitize(o, { maxLen: 150 })).join(' / ')}`);
  }
  if (Array.isArray(targetProfile.evidenceQuotes) && targetProfile.evidenceQuotes.length > 0) {
    parts.push('Source quotes (reflect ONE of these in the first line):');
    targetProfile.evidenceQuotes.slice(0, 5).forEach((q: any) => parts.push(`  - "${sanitize(q, { maxLen: 300 })}"`));
  } else if (targetProfile.siteTextExcerpt) {
    parts.push('Site excerpt (use to anchor your first line):');
    parts.push('```');
    parts.push(sanitize(targetProfile.siteTextExcerpt, { maxLen: 1500 }));
    parts.push('```');
  }

  parts.push('');
  parts.push('# Sender info (MUST be expanded as the signature at the very end)');
  const ownCompanyName = sanitize(ownContext.companyName || '', { maxLen: 200 });
  const ownContactName = sanitize(ownContext.contactName || '', { maxLen: 200 });
  if (ownCompanyName) parts.push(`Company: ${ownCompanyName}`);
  if (ownContactName) parts.push(`From: ${ownContactName}`);
  if (ownContext.email) parts.push(`Email: ${sanitize(ownContext.email, { maxLen: 100 })}`);
  if (ownContext.phone) parts.push(`Phone: ${sanitize(ownContext.phone, { maxLen: 50 })}`);
  if (ownContext.businessDescription) parts.push(`Business: ${sanitize(ownContext.businessDescription, { maxLen: 1000 })}`);
  if (!ownContactName) {
    parts.push('Note: contact name is not configured. Keep self-introduction and signature concise using only the company name. Do NOT use anonymous labels like "Sales Team".');
  }
  if (Array.isArray(ownContext.strengths) && ownContext.strengths.length > 0) {
    parts.push('Our strengths (pick 1-2 to use, never list all):');
    ownContext.strengths.slice(0, 5).forEach((s: any) => {
      const label = sanitize(s.label || s.key || '', { maxLen: 100 });
      const detail = sanitize(s.detail || '', { maxLen: 500 });
      parts.push(`  - ${label}: ${detail}`.trim());
    });
  }

  if (idealCustomer) {
    if (idealCustomer.descriptionFreetext) {
      parts.push('');
      parts.push(`# Ideal customer (think about how the recipient fits): ${sanitize(idealCustomer.descriptionFreetext, { maxLen: 1000 })}`);
    }
  }

  if (style) {
    parts.push('');
    parts.push('# Style / structure');
    if (style.tone) parts.push(`Tone: ${style.tone}`);
    if (style.greetingLine) parts.push(`Opening: use "${style.greetingLine}"`);
    if (style.closingLine) parts.push(`Closing: incorporate "${style.closingLine}"`);
    if (style.cta) parts.push(`CTA: use "${style.cta}"`);
    if (style.signatureTemplate) {
      parts.push(`Signature template (expand at the end): ${style.signatureTemplate}`);
    }
    if (style.maxLength) parts.push(`Maximum body length: ${style.maxLength} characters`);
  }

  parts.push('');
  parts.push('# Forbidden');
  parts.push('- Cliches like "Win-Win", "synergy", "leverage your potential".');
  parts.push('- Pairing a specific client name with a deal amount (confidentiality breach).');
  parts.push('- If you write "I saw your work on X", you MUST anchor it in evidence_quotes or siteTextExcerpt (no fabrication).');
  parts.push('- Asserting the recipient\'s problems as definite facts.');
  parts.push('- Ending without a signature, or signing as "Sales Team" / generic placeholder.');
  parts.push('- Misleading the recipient about the commercial nature of the message.');
  parts.push('');
  parts.push('# Output');
  parts.push('Output the body text only. No preamble, no postscript, no code blocks, no JSON wrapping.');
  parts.push('Output a single message that contains line breaks.');
  parts.push('');
  parts.push('# Required closing structure');
  parts.push('End the message exactly with:');
  parts.push('  (blank line)');
  parts.push(ownContactName ? `  ${ownCompanyName || ''}\n  ${ownContactName}` : `  ${ownCompanyName || '(Sender company)'}`);
  if (ownContext.phone) parts.push(`  Phone: ${sanitize(ownContext.phone, { maxLen: 50 })}`);
  if (ownContext.email) parts.push(`  Email: ${sanitize(ownContext.email, { maxLen: 100 })}`);
  parts.push('  (Reply with "unsubscribe" or "STOP" if you do not wish to receive further outreach.)');

  return parts.join('\n');
}

module.exports = { buildGeneratorPrompt };

export {};

// CLI Prompt batch_rules (English)
//
// English-equivalent of src/locale-pack/ja/cli-prompts.ts. Used for prospects
// whose detected language is `en` (and locale override is `'en'` or `'auto'`).
// Semantically equivalent to the Japanese rules; do not introduce extra
// behavior that would diverge between locales.

interface FormPreferences {
  preferredKeywords?: string[];
  avoidKeywords?: string[];
  approachLabel?: string;
}

interface BuildBatchRulesOpts {
  autoSendSafe: boolean;
  parallelTabs: number;
  formPreferences?: FormPreferences;
  formFillMode?: string; // v2.1.0: 'internal' (in-app WebContentsView) vs 'playwright' (external Chrome)
}

// v2.0.59: default form preference (partnership outreach).
// Override via settings.json: messageTemplates.formPreferences.
const DEFAULT_PREFERRED_KEYWORDS_EN = ['partnership', 'partner', 'cooperation', 'alliance', 'business inquiry', 'corporate inquiry'];
const DEFAULT_AVOID_KEYWORDS_EN = ['FAQ', 'customer support', 'product support', 'help center', 'customer service'];
const DEFAULT_APPROACH_LABEL_EN = 'partnership / cooperation outreach';

function buildFormSelectionRuleEn(pref: FormPreferences | undefined): string {
  const preferred = (pref && Array.isArray(pref.preferredKeywords) && pref.preferredKeywords.length > 0)
    ? pref.preferredKeywords : DEFAULT_PREFERRED_KEYWORDS_EN;
  const avoid = (pref && Array.isArray(pref.avoidKeywords) && pref.avoidKeywords.length > 0)
    ? pref.avoidKeywords : DEFAULT_AVOID_KEYWORDS_EN;
  const label = (pref && typeof pref.approachLabel === 'string' && pref.approachLabel.trim())
    ? pref.approachLabel.trim() : DEFAULT_APPROACH_LABEL_EN;
  const preferredStr = preferred.map((k: any) => `"${k}"`).join(' / ');
  const avoidStr = avoid.map((k: any) => `"${k}"`).join(' / ');
  return `- ★ Form selection priority (outreach intent: ${label}): (1) Use ${preferredStr} forms when present. (2) Fall back to generic Contact only if (1) does not exist. (3) Avoid ${avoidStr} forms — they are end-user channels, not B2B sales destinations (e.g. faq.oracle.co.jp/app/ask/referer_id/contact is a general Q&A intake, not a partner channel).`;
}

function buildBatchRules(opts: BuildBatchRulesOpts): string[] {
  const tabs = Number.isFinite(opts && opts.parallelTabs) ? Number(opts.parallelTabs) : 1;
  const autoSendSafe = !!(opts && opts.autoSendSafe);
  const formPref = opts && opts.formPreferences;
  const isInternal = !opts || opts.formFillMode !== 'playwright'; // default is internal (in-app browser)

  const lines: string[] = [
    '- Phase A is already done by the backend. Do NOT re-analyze the target site unless the form URL is unresolved.',
    '- ★ urlMissing=true companies: run WebSearch **at most 2 queries**. 1st query "<company name> official site" → if the top 3 results pin the official domain, navigate directly. Only if undecided (ambiguous domains, e.g. foreign-affiliated / group companies) may you run a 2nd query ("<company name> contact" or the formal English name). If still not decided within 30 seconds OR no official found, **mark as error immediately**. No per-candidate navigate-and-check loops, no 3rd query, no wikipedia detours (loop prevention).',
    '- ★ For companies with urlMissing=false but with empty siteExcerpt or failed site fetch, do NOT contact. Stop and mark as error. NEVER guess content and proceed to awaiting_approval / submitted.',
    '- ★ awaiting_approval / submitted is only accepted by the API when Phase A site_analysis collected sufficient site text AND form_fill → confirm_reached have already been logged.',
    '- ★ Fill in one shot: from the browser_fill_form return value, re-type only fields with ok:false (value_mismatch / not_found) via browser_type, and make sure the bundled validation.problems is **empty before clicking submit**. problems lists required-but-empty / unchecked / radio-unselected / constraint-violating fields with selector + label, so you can fix them before hitting the site\'s "required field" error page. If problems is empty, do NOT re-snapshot — go straight to the submit button.',
    '- ★ How to reach the confirmation screen: submit/confirm button candidates are provided in the browser_snapshot buttons array with selector + text (best candidate first). Pick the "Confirm"/"Submit" one and browser_click(selector) — no browser_evaluate button hunting needed. Only if buttons is empty, locate it by visible text ("Submit", "Confirm", "Send", "Next"). After clicking, use browser_wait_for until the confirmation text/URL change appears, then log confirm_reached. If you stop at form_fill without logging confirm_reached, that company cannot proceed to the send decision and stays incomplete.',
    '- When messagePrompt is provided, use it to finalize the body for this specific company before filling the form.',
    '- messageDraft is the Phase A draft, messagePrompt is the generation context. Prefer messagePrompt; fall back to messageDraft only.',
    '- Even when rewriting the body, do NOT add facts not present in messagePrompt / analysisHints / siteExcerpt. Never invent figures (employee count, founding year, capital, etc.) that are not in sender_json.',
    '- Do not add sender information that is not in sender_json.',
    '- The body MUST end with the sender company name / contact / email / phone / address (if any) from sender_json plus a clear opt-out notice. If address is unset, do not invent one.',
    buildFormSelectionRuleEn(formPref),
    '- For unresolved forms, shallowly check the site for Contact / Get in touch / Inquiries pages or common paths.',
    '- awaiting_approval is only allowed once the form has been filled AND ss-{No}-input.png has been captured.',
    '- If you encounter a CAPTCHA, do NOT stop. Fill all fields you can → take ss-{No}-input.png → mark as awaiting_approval (a human will solve the CAPTCHA and submit).',
    '- For visible checkbox-style reCAPTCHA v2 ("I am not a robot"), you may attempt one browser_click. If an image challenge appears, give up and go to awaiting_approval.',
    '- Mark as error due to CAPTCHA only when "the form does not render" or "a page-level gate (e.g. Cloudflare) prevents reaching the body".',
  ];

  if (tabs <= 1) {
    lines.push('- Process companies one at a time and keep status reports concise.');
  } else {
    // v2.1.0: tab-open instructions differ by mode. In internal mode window.open does
    //   not follow the in-app tab manager, so open each company tab via browser_tabs new.
    const openRuleEn = isInternal
      ? `- Parallel sequence: first thinking decides "open ${tabs} tabs simultaneously" → immediately emit ${tabs} browser_tabs({action:"new", url:<company URL>, companyNo:<No>}) as parallel tool_use (one dedicated tab per company). Do NOT use window.open (it is not tracked by the in-app browser).`
      : `- Parallel sequence: first thinking decides "open ${tabs} tabs simultaneously" → immediately emit first company as browser_navigate, the remaining ${tabs - 1} as browser_evaluate(window.open) + browser_tabs(select) as parallel tool_use.`;
    lines.push(
      `- ★★ MUST use parallel tool_use. Claude can emit multiple tool_use blocks in a single thinking. On the first response, fire ${tabs} tab-open calls **in parallel within the same assistant message**. Sequential "company 1 → wait → company 2" is forbidden.`,
      openRuleEn,
      `- Wait until all ${tabs} navigations settle → then issue ${tabs} parallel browser_snapshot calls → then ${tabs} parallel browser_fill_form calls (Claude API supports parallel calls of the same tool kind).`,
      `- Screenshots / curl are per-company but emit ${tabs} parallel calls when possible. Never exceed ${tabs + 1} concurrent tabs (resource contention).`,
      `- Parallel emission applies only to tools with the same precondition / same decision axis. CAPTCHA analysis, body finalization, send-decision must be per-company sequential.`,
      `- Each company's awaiting_approval / submitted log MUST include the finalFormTab URL.`,
    );
  }

  lines.push(
    autoSendSafe
      ? '- ★ Auto-send safe forms: once all fields are filled successfully + required consent checkboxes are checked + the confirmation screen is reached, click the submit button without hesitation and complete as submitted. The ONLY 4 reasons to stop at awaiting_approval are: (1) an interactive image/checkbox CAPTCHA remains, (2) a required field demands a value not present in settings, (3) no-solicitation / out-of-scope form → skipped, (4) clicking submit does not advance to a confirmation/completion screen. Never stop "just in case" or "because uncertain".'
      : '- Do NOT submit. Stop at awaiting_approval.',
  );
  lines.push('- After completing submitted, keep ss-{No}-sent.png and close that company\'s tab (session).');
  lines.push(
    '- Only keep tabs open for awaiting_approval (filled but not sent). For not-filled (other than CAPTCHA) or no-form cases, mark as error / skipped.',
  );

  return lines;
}

module.exports = { buildBatchRules };

export {};

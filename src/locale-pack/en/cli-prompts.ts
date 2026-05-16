// CLI Prompt batch_rules (English)
//
// English-equivalent of src/locale-pack/ja/cli-prompts.ts. Used for prospects
// whose detected language is `en` (and locale override is `'en'` or `'auto'`).
// Semantically equivalent to the Japanese rules; do not introduce extra
// behavior that would diverge between locales.

interface BuildBatchRulesOpts {
  autoSendSafe: boolean;
  parallelTabs: number;
}

function buildBatchRules(opts: BuildBatchRulesOpts): string[] {
  const tabs = Number.isFinite(opts && opts.parallelTabs) ? Number(opts.parallelTabs) : 1;
  const autoSendSafe = !!(opts && opts.autoSendSafe);

  const lines: string[] = [
    '- Phase A is already done by the backend. Do NOT re-analyze the target site unless the form URL is unresolved.',
    '- ★ For companies with urlMissing=true, run a WebSearch for "<company name> official site", identify the official domain, then site-analyze → draft → fill the form. If you cannot find an official site, mark as error.',
    '- ★ For companies with urlMissing=false but with empty siteExcerpt or failed site fetch, do NOT contact. Stop and mark as error. NEVER guess content and proceed to awaiting_approval / submitted.',
    '- ★ awaiting_approval / submitted is only accepted by the API when Phase A site_analysis collected sufficient site text AND form_fill → confirm_reached have already been logged.',
    '- When messagePrompt is provided, use it to finalize the body for this specific company before filling the form.',
    '- messageDraft is the Phase A draft, messagePrompt is the generation context. Prefer messagePrompt; fall back to messageDraft only.',
    '- Even when rewriting the body, do NOT add facts not present in messagePrompt / analysisHints / siteExcerpt. Never invent figures (employee count, founding year, capital, etc.) that are not in sender_json.',
    '- Do not add sender information that is not in sender_json.',
    '- The body MUST end with the sender company name / contact / email / phone / address (if any) from sender_json plus a clear opt-out notice. If address is unset, do not invent one.',
    '- For unresolved forms, shallowly check the site for Contact / Get in touch / Inquiries pages or common paths.',
    '- awaiting_approval is only allowed once the form has been filled AND ss-{No}-input.png has been captured.',
    '- If you encounter a CAPTCHA, do NOT stop. Fill all fields you can → take ss-{No}-input.png → mark as awaiting_approval (a human will solve the CAPTCHA and submit).',
    '- For visible checkbox-style reCAPTCHA v2 ("I am not a robot"), you may attempt one browser_click. If an image challenge appears, give up and go to awaiting_approval.',
    '- Mark as error due to CAPTCHA only when "the form does not render" or "a page-level gate (e.g. Cloudflare) prevents reaching the body".',
  ];

  if (tabs <= 1) {
    lines.push('- Process companies one at a time and keep status reports concise.');
  } else {
    lines.push(
      `- ★ Tab-parallel pipeline allowed (max ${tabs} tabs in flight): after issuing browser_navigate, you may open the next company\'s tab via window.open / browser_tabs and issue a navigate without waiting for the snapshot. Wait for both navigations to settle, then run browser_snapshot → browser_fill_form. Never have more than 4 tabs open simultaneously (Claude\'s state tracking breaks down). Keep each company\'s input, screenshot, and log strictly per-company. Each company\'s awaiting_approval / submitted log MUST include the finalFormTab URL.\n- Pipelining is only allowed for navigation-bound steps (site reach / form discovery / form_fill navigation wait). CAPTCHA analysis and body generation must be done one company at a time.`,
    );
  }

  lines.push(
    autoSendSafe
      ? '- Unless CAPTCHA / required-manual-fields / no-solicitation / uncertainty applies, when the confirmation screen is captured, proceed all the way to final submission and mark as submitted.'
      : '- Do NOT submit. Stop at awaiting_approval.',
  );
  lines.push('- After successful submission, keep the sent screenshot and close the submitted tab.');
  lines.push(
    '- Only keep tabs open for awaiting_approval (filled but not sent). For not-filled (other than CAPTCHA) or no-form cases, mark as error / skipped.',
  );

  return lines;
}

module.exports = { buildBatchRules };

export {};

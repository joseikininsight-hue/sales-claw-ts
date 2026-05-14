'use strict';

/**
 * LLM Message Generator (Phase B)
 * ─────────────────────────────────
 * 既存の message-builder.cjs はテンプレ断片組立で「貴社が${companyType}と
 * して幅広い案件対応を担われている前提で拝見しました」みたいな嘘文を
 * 自動生成していた。
 *
 * Phase B では CLI (Claude/Codex/Gemini) を headless で呼んで、相手企業の
 * 事実 (analyzer.evidenceQuotes) と自社情報を渡して本文を直接書かせる。
 *
 * Phase A の analyzer と同じ spawn / JSON 抽出パターンを使う。
 * 出力は JSON ではなく **本文テキスト** (1 メッセージ)。
 * メタ情報は別フィールドで返す。
 *
 * 失敗時は呼び出し側に null を返し、テンプレ fallback。
 */

const { spawn, spawnSync } = require('child_process');

const DEFAULT_TIMEOUT_MS = 60000;
const MAX_BUFFER_BYTES = 256 * 1024;

/**
 * Prompt injection 緩和。詳細は llm-site-analyzer.cjs::sanitizePromptInput と同等。
 */
function sanitizePromptInput(value, options: Record<string, any> = {}) {
  if (value == null) return '';
  let s = typeof value === 'string' ? value : String(value);
  s = s.replace(/[ --]/g, '');
  s = s.replace(/```/g, '[BACKTICK x3]');
  s = s.replace(/^(#{1,6})\s/gm, ' $1 ');
  const maxLen = Number.isFinite(Number(options.maxLen)) ? Number(options.maxLen) : 8000;
  if (s.length > maxLen) s = s.slice(0, maxLen);
  return s;
}

/**
 * @param {object} args
 * @param {object} args.targetProfile - LLM analyzer 出力 + 既存 analysis
 *        - companyName, industry, mainOfferings, evidenceQuotes 等
 * @param {object} args.ownContext - 自社情報 (companyProfile + valuePropositions)
 * @param {object} args.idealCustomer - ICP (descriptionFreetext, dealBreakers)
 * @param {object} args.style - messageTemplates の style/tone/closingLine 等
 * @param {string} args.providerId - 'claude' | 'codex' | 'gemini'
 * @param {string} args.executablePath - CLI 絶対パス
 * @param {number} [args.timeoutMs=60000]
 *
 * @returns Promise<{
 *   ok: boolean,
 *   message?: string,    # 生成された本文テキスト
 *   elapsedMs?: number,
 *   error?: string,
 *   fallbackTo?: 'template',
 *   rawCliOutput?: string,
 * }>
 */
async function generateMessageWithCli({
  targetProfile,
  ownContext,
  idealCustomer = null,
  style = null,
  providerId = 'claude',
  executablePath,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  model = '',
  providerHomeDir = '',
}) {
  if (!executablePath) {
    return { ok: false, error: 'executablePath 未指定', fallbackTo: 'template' };
  }
  if (!targetProfile || !targetProfile.companyName) {
    return { ok: false, error: 'targetProfile.companyName 必須', fallbackTo: 'template' };
  }
  if (!ownContext) {
    return { ok: false, error: 'ownContext 必須', fallbackTo: 'template' };
  }

  const prompt = buildGeneratorPrompt({ targetProfile, ownContext, idealCustomer, style });
  const startedAt = Date.now();
  const cliResult: any = await runCliHeadless({ providerId, executablePath, prompt, timeoutMs, model, providerHomeDir });
  const elapsedMs = Date.now() - startedAt;

  if (!cliResult.ok) {
    return {
      ok: false,
      error: cliResult.error || 'CLI failed',
      fallbackTo: 'template',
      elapsedMs,
    };
  }

  const message = extractMessageFromCliOutput(cliResult.stdout);
  if (!message || message.length < 50) {
    return {
      ok: false,
      error: 'CLI 出力からメッセージを抽出できなかった (50字未満)',
      rawCliOutput: cliResult.stdout.slice(0, 1000),
      fallbackTo: 'template',
      elapsedMs,
    };
  }

  return {
    ok: true,
    message,
    elapsedMs,
    rawCliOutput: cliResult.stdout.slice(0, 500),
  };
}

/**
 * メッセージ生成プロンプト。原則は analyzer と同じく業界非依存。
 * - 自社情報 (identity, offerings, voice) は短く
 * - 相手情報 (industry, evidence_quotes) を確実に引用させる
 * - 守秘違反検出のための禁止リスト
 */
function buildGeneratorPrompt({ targetProfile, ownContext, idealCustomer, style }) {
  const parts: any[] = [];
  parts.push('あなたは経験豊富な BtoB 営業のプロです。問い合わせフォーム経由で送る短い文面を 1 通だけ書いてください。');
  parts.push('');
  parts.push('# 普遍的原則 (業界を問わない)');
  parts.push('1. 1 行目で相手の状況・主力サービスに具体言及 (自分の話から始めない)');
  parts.push('2. 自社実績は累積数字 / No.1 / 規模感のみ。個別の取引先社名や金額は出さない');
  parts.push('3. 相手にとっての価値変換 (What\'s in it for me?)');
  parts.push('4. CTA は具体的・低い壁 (情報交換 / 短時間ミーティング)');
  parts.push('5. 押し付けない。「不要であれば返信不要」を 1 行明記');
  parts.push('6. 守秘義務遵守。社名は業態カテゴリで匿名化');
  parts.push('7. **署名は必ず本文末尾に書く**: 自社名 + 担当者名を空行 1 つ後に配置。担当者名が指定されていれば必ず展開する。"営業担当" / "担当" だけの匿名署名は禁止。');
  parts.push('');
  parts.push('# 人間味を出す原則 (★最重要 — これが弱いと文面が AI 臭くなる)');
  parts.push('- 完璧な敬語より、人として書いている感触を優先する');
  parts.push('- **サイトを実際に読み込んで「気づいたディテール 1 つ」** を必ず入れる。例: "〇〇のページが印象に残りました" / "とくに〜の取り組みが気になりました"。汎用的な業態説明だけでは薄い。');
  parts.push('- 短文と長文を混ぜてリズムを作る (全文長くしない)');
  parts.push('- 仮説止まりだけでなく、ところどころ素直に断言する ("〜だと思います" / "〜が必要だと感じています")');
  parts.push('- 営業テンプレ表現を **最低限** に。同じ言い回しを連発しない (e.g. 「〜しております」「〜と存じます」「〜と認識しております」の繰り返し)');
  parts.push('- 修飾語の連発を避ける。1 文の主旨を 1 つに絞る');
  parts.push('- 自社の話より相手の話の比率を高く (相手 6 割 : 自社 4 割 程度)');
  parts.push('');
  parts.push('# 強く避ける表現 (AI 臭・テンプレ営業臭)');
  parts.push('- 「突然のご連絡失礼いたします」「何卒よろしくお願い申し上げます」のような使い古された定型句は冒頭・末尾どちらでも 1 つだけ');
  parts.push('- 「〜と認識しております」「〜と存じます」「〜という認識でおります」「〜の旨」「〜と承知しております」（論文調）');
  parts.push('- 「貴社のますますのご発展」系の取って付けたフレーズ');
  parts.push('- 「拝見」「賜り」「頂戴」を 3 回以上');
  parts.push('- 同じ文末を連続 (例: 「〜しております。〜しております。〜しております。」)');
  parts.push('- 「相互発展」「Win-Win」「ご縁」「お力添え」');
  parts.push('- 「〜なのではないでしょうか」のような相手の状態を勝手に断定');
  parts.push('- 「事業展開されている」「展開されている領域」「〜という事業領域」を多用 (汎用すぎる)');
  parts.push('');
  parts.push('# 推奨表現 (人間味)');
  parts.push('- "〜のページが印象に残りました" (具体的な観察)');
  parts.push('- "〜が気になりました" / "〜が興味深かったです"');
  parts.push('- "〜だと思っていて、〜の場面ではお役に立てるかもしれません" (率直な提案)');
  parts.push('- "30 分だけお時間いただけませんか" (短く・率直)');
  parts.push('- "もし〜なら、お手伝いできることがあるかもしれません" (押し付けない断言)');
  parts.push('');
  parts.push('# 文体のリズム例 (Good vs Bad)');
  parts.push('Bad (AI 臭): "貴社が〇〇事業を展開されていることを拝見し、ご連絡差し上げました。とりわけ〜領域は〜と密接に絡む領域と認識しております。"');
  parts.push('Good (人間): "〇〇事業のページを拝見しました。とくに〜の取り組みが気になっていて、もし〜の場面があればお役に立てるかもしれません。"');
  parts.push('');

  parts.push('# 相手企業');
  parts.push(`会社名: ${sanitizePromptInput(targetProfile.companyName, { maxLen: 200 })}`);
  if (targetProfile.industry && targetProfile.industry.primary) {
    parts.push(`業界: ${sanitizePromptInput(targetProfile.industry.primary, { maxLen: 100 })} > ${sanitizePromptInput(targetProfile.industry.sub_category || '', { maxLen: 100 })}`);
  } else if (targetProfile.companyType) {
    parts.push(`業界ヒント: ${sanitizePromptInput(targetProfile.companyType, { maxLen: 200 })}`);
  }
  if (Array.isArray(targetProfile.mainOfferings) && targetProfile.mainOfferings.length > 0) {
    parts.push(`主力: ${targetProfile.mainOfferings.slice(0, 5).map((o: any) => sanitizePromptInput(o, { maxLen: 150 })).join(' / ')}`);
  }
  if (Array.isArray(targetProfile.evidenceQuotes) && targetProfile.evidenceQuotes.length > 0) {
    parts.push('原文引用 (1 行目はこの中から 1 つ必ず反映する):');
    targetProfile.evidenceQuotes.slice(0, 5).forEach((q: any) => parts.push(`  - "${sanitizePromptInput(q, { maxLen: 300 })}"`));
  } else if (targetProfile.siteTextExcerpt) {
    parts.push('サイト本文抜粋 (1 行目に活用):');
    parts.push('```');
    parts.push(sanitizePromptInput(targetProfile.siteTextExcerpt, { maxLen: 1500 }));
    parts.push('```');
  }

  parts.push('');
  parts.push('# 自社情報 (本文末尾に必ず署名として展開すること)');
  const ownCompanyName = sanitizePromptInput(ownContext.companyName || '', { maxLen: 200 });
  const ownContactName = sanitizePromptInput(ownContext.contactName || '', { maxLen: 200 });
  if (ownCompanyName) parts.push(`会社名: ${ownCompanyName}`);
  if (ownContactName) parts.push(`差出人: ${ownContactName}`);
  if (ownContext.email) parts.push(`メール: ${sanitizePromptInput(ownContext.email, { maxLen: 100 })}`);
  if (ownContext.phone) parts.push(`電話: ${sanitizePromptInput(ownContext.phone, { maxLen: 50 })}`);
  if (ownContext.businessDescription) parts.push(`事業: ${sanitizePromptInput(ownContext.businessDescription, { maxLen: 1000 })}`);
  if (!ownContactName) {
    parts.push('注意: 担当者名が未設定です。本文の自己紹介・署名は会社名のみで簡潔に書いてください ("営業担当" のような匿名表現は禁止)。');
  }
  if (Array.isArray(ownContext.strengths) && ownContext.strengths.length > 0) {
    parts.push('自社の強み (1-2 個に絞って使う):');
    ownContext.strengths.slice(0, 5).forEach((s: any) => {
      const label = sanitizePromptInput(s.label || s.key || '', { maxLen: 100 });
      const detail = sanitizePromptInput(s.detail || '', { maxLen: 500 });
      parts.push(`  - ${label}: ${detail}`.trim());
    });
  }

  if (idealCustomer) {
    if (idealCustomer.descriptionFreetext) {
      parts.push('');
      parts.push(`# 理想顧客 (相手がこれにどう当てはまるか考える): ${sanitizePromptInput(idealCustomer.descriptionFreetext, { maxLen: 1000 })}`);
    }
  }

  if (style) {
    parts.push('');
    parts.push('# 文体 / 構造');
    if (style.tone) parts.push(`トーン: ${style.tone}`);
    if (style.greetingLine) parts.push(`書き出し: 「${style.greetingLine}」を使用`);
    if (style.closingLine) parts.push(`締め: 「${style.closingLine}」を組み込む`);
    if (style.cta) parts.push(`CTA: 「${style.cta}」を使う`);
    if (style.signatureTemplate) {
      parts.push(`署名テンプレ (末尾に展開): ${style.signatureTemplate}`);
    }
    if (style.maxLength) parts.push(`本文長: 最大 ${style.maxLength} 文字`);
  }

  parts.push('');
  parts.push('# 禁止');
  parts.push('- 「Win-Win」「相互発展」「ぜひお力添え」などの陳腐な営業フレーズ');
  parts.push('- 個別の取引先社名 + 金額の組み合わせ (守秘違反)');
  parts.push('- 「貴社の事業を拝見し」と書く場合は必ず evidence_quotes か siteTextExcerpt の事実を1つ反映 (創作禁止)');
  parts.push('- 相手の課題を断定的に決めつける表現');
  parts.push('- 末尾署名なし、または "営業担当" 等の匿名署名で終わること');
  parts.push('');
  parts.push('# 出力');
  parts.push('本文テキストのみを出力。前置き・後書き・コードブロック・JSON 装飾は一切なし。');
  parts.push('改行を含む 1 通のメッセージとして出力してください。');
  parts.push('');
  parts.push('# 必須末尾構造');
  parts.push('本文の最後を必ず以下の形式で締めくくる:');
  parts.push('  (空行)');
  parts.push(ownContactName ? `  ${ownCompanyName || ''}\n  ${ownContactName}` : `  ${ownCompanyName || '(自社名)'}`);
  if (ownContext.phone) parts.push(`  TEL: ${sanitizePromptInput(ownContext.phone, { maxLen: 50 })}`);
  if (ownContext.email) parts.push(`  MAIL: ${sanitizePromptInput(ownContext.email, { maxLen: 100 })}`);

  return parts.join('\n');
}

// 強制 kill (SIGTERM 効かない Windows 用 taskkill /F フォールバック)
function hardKill(child) {
  if (!child || child.killed) return;
  try { child.kill('SIGTERM'); } catch (_) {}
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { windowsHide: true, timeout: 3000 });
    } else {
      child.kill('SIGKILL');
    }
  } catch (_) { /* best-effort */ }
}

// バッファ truncation 戦略: Codex --json は head 保持、その他は両端保持
function appendBuffer(current, chunk, mode) {
  const next = current + String(chunk || '');
  if (next.length <= MAX_BUFFER_BYTES) return next;
  if (mode === 'head') return next.slice(0, MAX_BUFFER_BYTES);
  const half = Math.floor(MAX_BUFFER_BYTES / 2);
  return next.slice(0, half) + '\n[...buffer truncated middle...]\n' + next.slice(next.length - half);
}

function runCliHeadless({ providerId, executablePath, prompt, timeoutMs, model = '', providerHomeDir = '' }) {
  return new Promise<any>((resolve) => {
    let args;
    let bufferMode = 'both';
    const modelArg = typeof model === 'string' && model.trim() ? model.trim() : '';
    if (providerId === 'claude') {
      args = ['-p', prompt, '--dangerously-skip-permissions', '--permission-mode', 'bypassPermissions'];
      // Prompt cache 再利用率を上げる (per-machine な dynamic section を first user message に逃がす)
      // 2026-06-15 以降の Programmatic Credit 枠の消費を抑える効果がある
      args.push('--exclude-dynamic-system-prompt-sections');
      if (modelArg) args.push('--model', modelArg);
    } else if (providerId === 'codex') {
      args = ['exec', '--dangerously-bypass-approvals-and-sandbox', '--json', prompt];
      if (modelArg) args.push('--model', modelArg);
      bufferMode = 'head';
    } else if (providerId === 'gemini') {
      args = ['-p', prompt, '-o', 'text', '--approval-mode', 'yolo'];
      if (modelArg) args.push('-m', modelArg);
    } else {
      resolve({ ok: false, error: `unknown providerId: ${providerId}` });
      return;
    }

    let child;
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { if (child && !child.killed) hardKill(child); } catch (_) {}
      resolve(result);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      finish({ ok: false, error: `CLI timeout after ${timeoutMs}ms`, timedOut: true });
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    // spawn env を sanitize:
    //   - ANTHROPIC_API_KEY / BEDROCK / VERTEX 系を削除 → Programmatic Credit 枠で課金
    //   - providerHomeDir 指定があれば HOME / USERPROFILE をそこに向ける
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { buildSanitizedSpawnEnv, stripSanitizerMeta } = require('./spawn-env-sanitizer');
    const sanitizedEnv = buildSanitizedSpawnEnv({
      providerId,
      providerHomeDir: providerHomeDir || '',
    });
    const removedKeysForLog: string[] = (sanitizedEnv as any).__removedKeys || [];
    const homeOverriddenForLog: boolean = !!(sanitizedEnv as any).__homeOverridden;
    const spawnEnv = stripSanitizerMeta(sanitizedEnv);

    try {
      child = spawn(executablePath, args, {
        cwd: process.cwd(),
        env: spawnEnv,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      // env サニタイズ実績を起動 1 回だけ stderr に記録 (CI / バッチログ用)
      if (removedKeysForLog.length > 0 || homeOverriddenForLog) {
        try {
          process.stderr.write(`[llm-msg] env sanitized: removed=${JSON.stringify(removedKeysForLog)}, homeOverridden=${homeOverriddenForLog}\n`);
        } catch (_) { /* best-effort */ }
      }
    } catch (error) {
      finish({ ok: false, error: 'spawn failed: ' + (error.message || String(error)) });
      return;
    }

    child.stdout.on('data', (chunk) => { stdout = appendBuffer(stdout, chunk, bufferMode); });
    child.stderr.on('data', (chunk) => { stderr = appendBuffer(stderr, chunk, 'head'); });
    child.on('error', (error) => {
      finish({ ok: false, error: 'child error: ' + (error.message || String(error)), stderr });
    });
    child.on('close', (code) => {
      if (timedOut) return;
      if (code !== 0) {
        finish({ ok: false, error: `CLI exited with code ${code}`, stdout, stderr });
        return;
      }
      finish({ ok: true, stdout, stderr });
    });
  });
}

/**
 * CLI 出力からメッセージ本文を抽出。
 * - 余計な markdown コードブロック / 前置きをトリム
 * - codex は --json でストリーム JSON を返すので、その中の "agent_message" を組立てる
 */
function extractMessageFromCliOutput(text) {
  if (!text || typeof text !== 'string') return '';
  let body = text.trim();

  // Codex --json は line-by-line JSON。各 event の type=='item.completed' で
  // item.item_type=='agent_message' のものに content[].text を取り出す。
  if (body.startsWith('{') && body.includes('"item_type"')) {
    const messages: any[] = [];
    body.split(/\r?\n/).forEach((line: any) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) return;
      try {
        const ev = JSON.parse(trimmed);
        const item = ev && ev.item;
        if (item && item.item_type === 'agent_message' && item.text) {
          messages.push(String(item.text));
        }
      } catch (_) { /* skip non-JSON line */ }
    });
    if (messages.length > 0) {
      body = messages.join('\n').trim();
    }
  }

  // markdown ``` ブロックで囲まれている → 中身だけ抽出
  const mdMatch = body.match(/```(?:[a-z]*\s*\n)?([\s\S]+?)\n?```/);
  if (mdMatch) body = mdMatch[1].trim();

  // 「以下の本文をお送りします:」みたいな前置きを削る
  body = body.replace(/^[\s\S]{0,200}?(?:本文|お送りします?|以下です?|生成しました)[:：]?\s*\n+/m, '');

  return body.trim();
}

module.exports = {
  generateMessageWithCli,
  // テスト用 export
  buildGeneratorPrompt,
  extractMessageFromCliOutput,
};

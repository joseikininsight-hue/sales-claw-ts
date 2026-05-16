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
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getLocalePack } = require('./locale-pack');

const DEFAULT_TIMEOUT_MS = 60000;
const MAX_BUFFER_BYTES = 256 * 1024;

/**
 * Prompt injection 緩和。詳細は llm-site-analyzer.cjs::sanitizePromptInput と同等。
 */
function sanitizePromptInput(value, options: Record<string, unknown> = {}) {
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
  // Phase 3: メッセージ生成 locale (デフォルト 'ja' で互換)
  locale = 'ja',
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

  const prompt = buildGeneratorPrompt({ targetProfile, ownContext, idealCustomer, style, locale });
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
 *
 * Phase 3: locale ('ja' | 'en') を受けて、対応する Locale Pack の
 * llmPrompts.buildGeneratorPrompt にデリゲート。デフォルト 'ja' で互換維持。
 */
function buildGeneratorPrompt({ targetProfile, ownContext, idealCustomer, style, locale = 'ja' }) {
  const normalizedLocale = locale === 'en' ? 'en' : 'ja';
  const pack = getLocalePack(normalizedLocale);
  if (pack && pack.llmPrompts && typeof pack.llmPrompts.buildGeneratorPrompt === 'function') {
    return pack.llmPrompts.buildGeneratorPrompt({
      targetProfile,
      ownContext,
      idealCustomer,
      style,
      sanitize: sanitizePromptInput,
    });
  }
  // Locale Pack 未ロード時は安全側で空 prompt を返す (上位は CLI 失敗 → template fallback で受ける)
  return '';
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
  return new Promise<unknown>((resolve) => {
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
    const messages: unknown[] = [];
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

'use strict';

/**
 * CLI Agent Discovery
 *
 * 既存の Claude Code / Codex / Gemini CLI を headless モードで起動し、
 * "公開情報から企業候補を JSON で返してもらう" 役割を持つ。
 *
 * 既存の自然言語/カテゴリモードが要求する SerpApi / 法人番号 API キーを
 * 必要とせず、ユーザの CLI 認証だけで動かせるのが特徴。
 *
 * Workflow:
 *   1. buildAgentPrompt(query, limit) でプロンプトを生成
 *   2. headless spawn して stdin にプロンプトを流す (Sales Claw 内の他経路と
 *      同じく ai-providers.buildHeadlessArgs を経由)
 *   3. stdout を集約 → parseAgentOutput で JSON 配列を抽出
 *   4. 候補配列を返す (orchestrator の dedupe/scoring に渡す前提)
 */

const { spawn } = require('child_process');

const DEFAULT_TIMEOUT_MS = 8 * 60 * 1000; // 8 分: Claude が web 検索 + 50社程度なら十分
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 200;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/**
 * Build the prompt that instructs the CLI agent to discover companies and
 * return ONLY a JSON array.
 */
function buildAgentPrompt(query, limit, options: Record<string, any> = {}) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || DEFAULT_LIMIT, MAX_LIMIT));
  const userQuery = String(query || '').trim();
  const extraGuidance = options.extraGuidance ? `\n${options.extraGuidance}\n` : '';

  return [
    'あなたは日本企業のリサーチエージェントです。次の条件に合う企業を ' + safeLimit + ' 社まで公開情報から探し、JSON 配列で返してください。',
    '',
    '## 検索条件',
    userQuery || '(条件未指定: 関連性の高い日本企業を選んでください)',
    '',
    '## 出力ルール（厳守）',
    '1. 出力は JSON 配列のみ。前後に説明文・markdown コードフェンス・絵文字を付けない。',
    '2. 各要素は次のキーを必ず含む (情報が無ければ null を入れる):',
    '   - companyName (string, 正式社名)',
    '   - url (string, 公式サイトの最上位 URL)',
    '   - industry (string, 例: "SIer", "SaaS", "受託開発")',
    '   - prefecture (string, 例: "東京都", "大阪府")',
    '   - employeeCount (number | null)',
    '   - formUrl (string | null, お問い合わせフォームの URL があれば)',
    '   - sourceUrl (string, 情報の根拠 URL を 1 件)',
    '   - notes (string | null, 「営業お断り記載あり」など特記事項)',
    '3. 公開ページに営業お断り / 採用専用 / IR専用 / サポート専用 などの記載があれば notes に明記し、formUrl は null にする。',
    '4. ログイン必須・CAPTCHA・robots.txt 禁止のページは取得しない。',
    '5. 同じ企業を重複して入れない。',
    '6. 自信のないフィールドは null。推測で埋めない。',
    '7. 最終出力以外は印字しない (思考は内部で行うこと)。',
    extraGuidance,
    '',
    '## 出力例',
    '[',
    '  {"companyName":"株式会社サンプル","url":"https://example.co.jp","industry":"SIer","prefecture":"東京都","employeeCount":120,"formUrl":"https://example.co.jp/contact","sourceUrl":"https://example.co.jp/company","notes":null}',
    ']',
  ].join('\n');
}

/**
 * Extract the JSON array from possibly-noisy CLI output.
 * Returns { candidates: array | null, error: string | null, rawJson: string | null }
 */
function parseAgentOutput(rawText) {
  const text = String(rawText || '');
  if (!text.trim()) return { candidates: null, error: 'empty output', rawJson: null };

  const candidates: any[] = [];
  // 1. Prefer fenced ```json ... ```
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence) candidates.push(fence[1]);
  // 2. First [...] block
  const arrIdx = text.indexOf('[');
  if (arrIdx >= 0) {
    const end = text.lastIndexOf(']');
    if (end > arrIdx) candidates.push(text.slice(arrIdx, end + 1));
  }
  // 3. Whole text
  candidates.push(text.trim());

  for (const slice of candidates) {
    const trimmed = String(slice || '').trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return { candidates: parsed, error: null, rawJson: trimmed };
      }
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.companies)) {
        return { candidates: parsed.companies, error: null, rawJson: trimmed };
      }
    } catch (_) { /* try next */ }
  }
  return { candidates: null, error: 'could not parse JSON array from output', rawJson: null };
}

/**
 * Normalize raw agent records to CompanyRecord-shaped entries that the rest of
 * list-builder pipeline can consume (dedupe / qualification-scorer).
 */
function normalizeAgentRecords(rawRecords, options: Record<string, any> = {}) {
  if (!Array.isArray(rawRecords)) return [];
  const now = new Date().toISOString();
  const sourceUrlFallback = options.sourceUrl || null;
  return rawRecords
    .filter((r: any) => r && typeof r === 'object' && typeof r.companyName === 'string' && r.companyName.trim())
    .map((r, idx) => {
      const url = typeof r.url === 'string' ? r.url.trim() : null;
      const formUrl = typeof r.formUrl === 'string' ? r.formUrl.trim() : null;
      const employeeCount = Number.isFinite(Number(r.employeeCount)) ? Number(r.employeeCount) : null;
      return {
        id: `cli-agent-${Date.now()}-${idx}`,
        companyName: r.companyName.trim(),
        url: url || null,
        formUrl: formUrl || null,
        industry: typeof r.industry === 'string' ? r.industry.trim() : null,
        prefecture: typeof r.prefecture === 'string' ? r.prefecture.trim() : null,
        employeeCount,
        notes: typeof r.notes === 'string' ? r.notes.trim() : null,
        discoverySource: 'cli_agent',
        sourceListUrl: typeof r.sourceUrl === 'string' && r.sourceUrl.trim() ? r.sourceUrl.trim() : sourceUrlFallback,
        evidence: [{
          field: 'companyName',
          value: r.companyName,
          sourceUrl: typeof r.sourceUrl === 'string' ? r.sourceUrl : '',
          sourceType: 'cli_agent',
          extractedAt: now,
          confidence: 0.6,
          snippet: typeof r.notes === 'string' ? r.notes : null,
        }],
        sourceConfidence: 'medium',
        fieldConfidence: {
          companyName: 0.85,
          url: url ? 0.7 : 0,
          industry: r.industry ? 0.6 : 0,
          prefecture: r.prefecture ? 0.6 : 0,
          employeeCount: employeeCount ? 0.5 : 0,
          formUrl: formUrl ? 0.6 : 0,
        },
        collectionStatus: 'verified',
        discoveredAt: now,
        lastVerifiedAt: now,
      };
    });
}

/**
 * Spawn the CLI in headless mode and feed the prompt via stdin.
 *
 * ctx must provide:
 *   - resolveExecutable(providerId) → Promise<string>
 *   - buildHeadlessArgs(providerId, mode, opts) → { args, ... }
 *   - buildCliCommandSpec(executable, args) → { command, args, windowsVerbatimArguments? }
 *   - buildBaseEnv(providerId) → env
 *   - projectRoot (string)
 */
async function runCliAgent({ query, limit, providerId = 'claude', mode = 'bypassPermissions', timeoutMs = DEFAULT_TIMEOUT_MS, signal, ctx, onProgress }) {
  if (!ctx || typeof ctx.resolveExecutable !== 'function') {
    throw new Error('runCliAgent requires ctx with resolveExecutable / buildHeadlessArgs / buildCliCommandSpec / buildBaseEnv');
  }
  const prompt = buildAgentPrompt(query, limit);
  const headlessSpec = ctx.buildHeadlessArgs(providerId, mode, {
    cwd: ctx.projectRoot,
    prompt: '',
  });
  const executable: any = await ctx.resolveExecutable(providerId);
  const spawnSpec = ctx.buildCliCommandSpec(executable, headlessSpec.args);
  const env = ctx.buildBaseEnv(providerId);

  return await new Promise<any>((resolve) => {
    const startedAt = Date.now();
    let stdoutBuf = '';
    let stderrBuf = '';
    let settled = false;
    let killTimer: any = null;

    const finish = (payload) => {
      if (settled) return;
      settled = true;
      if (killTimer) { try { clearTimeout(killTimer); } catch (_) {} }
      resolve({
        ...payload,
        elapsedMs: Date.now() - startedAt,
        stdout: stdoutBuf,
        stderr: stderrBuf,
      });
    };

    let child;
    try {
      child = spawn(spawnSpec.command, spawnSpec.args, {
        cwd: ctx.projectRoot,
        env,
        windowsHide: true,
        windowsVerbatimArguments: spawnSpec.windowsVerbatimArguments === true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      finish({ ok: false, error: 'spawn failed: ' + (e && e.message), candidates: null });
      return;
    }

    if (signal && typeof signal.addEventListener === 'function') {
      signal.addEventListener('abort', () => {
        try { child.kill('SIGTERM'); } catch (_) {}
        finish({ ok: false, error: 'aborted by user', candidates: null });
      }, { once: true });
    }

    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString('utf8');
      if (stdoutBuf.length > MAX_OUTPUT_BYTES) stdoutBuf = stdoutBuf.slice(stdoutBuf.length - MAX_OUTPUT_BYTES);
      if (typeof onProgress === 'function') {
        try { onProgress({ stage: 'streaming', bytes: stdoutBuf.length }); } catch (_) {}
      }
    });
    child.stderr.on('data', (chunk) => {
      stderrBuf += chunk.toString('utf8');
      if (stderrBuf.length > MAX_OUTPUT_BYTES) stderrBuf = stderrBuf.slice(stderrBuf.length - MAX_OUTPUT_BYTES);
    });
    child.on('error', (e) => finish({ ok: false, error: 'process error: ' + (e && e.message), candidates: null }));
    child.on('close', (code) => {
      if (settled) return;
      const parsed = parseAgentOutput(stdoutBuf);
      if (!parsed.candidates) {
        finish({
          ok: false,
          error: parsed.error || ('CLI exited with code ' + code + ', no JSON found'),
          candidates: null,
          exitCode: code,
        });
        return;
      }
      finish({
        ok: true,
        error: null,
        candidates: parsed.candidates,
        rawJson: parsed.rawJson,
        exitCode: code,
      });
    });

    killTimer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch (_) {}
      setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 5000);
      finish({ ok: false, error: 'timeout after ' + Math.round(timeoutMs / 1000) + 's', candidates: null });
    }, timeoutMs);
    if (typeof killTimer.unref === 'function') killTimer.unref();

    try {
      child.stdin.write(prompt + '\n');
      child.stdin.end();
    } catch (e) {
      finish({ ok: false, error: 'stdin write failed: ' + (e && e.message), candidates: null });
    }
  });
}

module.exports = {
  buildAgentPrompt,
  parseAgentOutput,
  normalizeAgentRecords,
  runCliAgent,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  DEFAULT_TIMEOUT_MS,
};

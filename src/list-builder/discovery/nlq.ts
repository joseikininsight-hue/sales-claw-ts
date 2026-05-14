// NLQ (Natural Language Query) Discovery
//
// 自由文クエリ → LLM で構造化クエリ → 公式 API + 検索 API
//
// 要件§5.2:
//   - LLM (Sonnet) で固定 JSON スキーマ StructuredSearchIntent を生成
//   - 公式データソース (法人番号 API / gBizINFO) で一次検索
//   - 不足分を SerpApi で補完
//   - LLM が推定した値は confidence を低めに設定

export interface StructuredSearchIntent {
  industries: string[];
  prefectures: string[];
  companySizeHints: string[];
  revenueHints: string[];
  keywords: string[];
  negativeKeywords: string[];
  mustHave: string[];
  niceToHave: string[];
}

export interface LlmMessages {
  system: string;
  user: string;
}

export interface LlmResult {
  ok: boolean;
  text?: string;
  error?: string;
}

export type LlmInvoker = (messages: LlmMessages, opts?: ParseQueryOptions) => Promise<LlmResult>;

export interface ParseQueryPayload {
  query: string;
}

export interface ParseQueryOptions {
  llmInvoker?: LlmInvoker;
  timeoutMs?: number;
}

export interface ParseQuerySuccess {
  ok: true;
  intent: StructuredSearchIntent;
  raw: string;
}

export interface ParseQueryError {
  ok: false;
  error: string;
}

export type ParseQueryResult = ParseQuerySuccess | ParseQueryError;

export const SYSTEM_PROMPT = `あなたは日本のB2B営業向け企業検索アシスタントです。
ユーザーの自由文クエリを、必ず以下のJSON形式に変換してください。
JSON以外の文章・説明・コードブロックは絶対に出力しないでください。

スキーマ:
{
  "industries": string[],         // 業種 (例: ['SaaS', 'SIer', '製造', '小売'])
  "prefectures": string[],        // 都道府県 (例: ['東京都', '大阪府'])
  "companySizeHints": string[],   // 規模ヒント (例: ['中小', '中堅'])
  "revenueHints": string[],       // 売上ヒント (例: ['10-100億'])
  "keywords": string[],           // 必須キーワード (事業内容・特徴)
  "negativeKeywords": string[],   // 除外キーワード
  "mustHave": string[],           // 必須条件 (例: ['自社プロダクト', 'BtoB'])
  "niceToHave": string[]          // 緩和可能条件
}

各フィールドは「該当なし」なら空配列 [] にしてください。
都道府県は「都/道/府/県」を含む正式名で出力してください。
業種は一般的なカテゴリ名で出力してください（業界の独自名を勝手に作らない）。`;

/** JSON 抜き出し (LLM がコードブロックで返してきても対応) */
export function extractJson(text: string | null | undefined): unknown {
  if (typeof text !== 'string') return null;
  let trimmed = text.trim();
  trimmed = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  const slice = trimmed.slice(start, end + 1);
  try {
    return JSON.parse(slice);
  } catch {
    return null;
  }
}

const MAX_ARRAY_ITEMS = 50;
const MAX_STRING_LENGTH = 200;

/** 構造化クエリの妥当性検証 (型チェック + 不足フィールド補完 + 上限ガード) */
export function validateStructuredIntent(parsed: unknown): StructuredSearchIntent | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const p = parsed as Record<string, unknown>;
  const ensureStringArray = (v: unknown): string[] => {
    if (!Array.isArray(v)) return [];
    return v
      .filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= MAX_STRING_LENGTH)
      .slice(0, MAX_ARRAY_ITEMS);
  };
  return {
    industries: ensureStringArray(p.industries),
    prefectures: ensureStringArray(p.prefectures),
    companySizeHints: ensureStringArray(p.companySizeHints),
    revenueHints: ensureStringArray(p.revenueHints),
    keywords: ensureStringArray(p.keywords),
    negativeKeywords: ensureStringArray(p.negativeKeywords),
    mustHave: ensureStringArray(p.mustHave),
    niceToHave: ensureStringArray(p.niceToHave),
  };
}

/** 自由文 → StructuredSearchIntent */
export async function parseQuery(payload: ParseQueryPayload, opts: ParseQueryOptions = {}): Promise<ParseQueryResult> {
  if (!payload || typeof payload.query !== 'string' || !payload.query.trim()) {
    return { ok: false, error: 'query required' };
  }

  const llmInvoker = opts.llmInvoker ?? defaultLlmInvoker;
  const result: any = await llmInvoker({
    system: SYSTEM_PROMPT,
    user: payload.query.trim(),
  }, opts);

  if (!result || !result.ok) {
    return { ok: false, error: result?.error ?? 'LLM call failed' };
  }

  const json = extractJson(result.text);
  if (!json) {
    return { ok: false, error: 'failed to parse JSON from LLM response' };
  }

  const intent = validateStructuredIntent(json);
  if (!intent) {
    return { ok: false, error: 'invalid structured intent shape' };
  }

  return { ok: true, intent, raw: result.text ?? '' };
}

interface AiProvidersShape {
  invokeJson?: (req: { systemPrompt: string; userPrompt: string; timeoutMs: number }) => Promise<LlmResult>;
  invoke?: (req: { systemPrompt: string; userPrompt: string; timeoutMs: number }) => Promise<LlmResult>;
}

/** 既定の LLM 呼び出し: ai-providers 経由 */
async function defaultLlmInvoker(messages: LlmMessages, opts: ParseQueryOptions = {}): Promise<LlmResult> {
  let aiProviders: AiProvidersShape;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    aiProviders = require('../../ai-providers') as AiProvidersShape;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: 'ai-providers not available: ' + msg };
  }

  if (typeof aiProviders.invokeJson === 'function') {
    return await aiProviders.invokeJson({
      systemPrompt: messages.system,
      userPrompt: messages.user,
      timeoutMs: opts.timeoutMs ?? 30000,
    });
  }
  if (typeof aiProviders.invoke === 'function') {
    return await aiProviders.invoke({
      systemPrompt: messages.system,
      userPrompt: messages.user,
      timeoutMs: opts.timeoutMs ?? 30000,
    });
  }

  return {
    ok: false,
    error: 'ai-providers does not expose invoke()/invokeJson(). Phase 5: pass opts.llmInvoker explicitly.',
  };
}

module.exports = {
  parseQuery,
  extractJson,
  validateStructuredIntent,
  SYSTEM_PROMPT,
};

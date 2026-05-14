// Error Recovery API (P1-3)。
//
// action-log の error エントリを原因別にグルーピングして返す + 一括リトライ。
//
//   GET  /api/errors/grouped       原因別 (CAPTCHA / フォームなし / タイムアウト / MCP / その他)
//   POST /api/error/retry          { companyNos: [...] } → /api/ai-form-fill 相当を内部呼び出し

import type { IncomingMessage, ServerResponse } from 'http';

export type JsonResponseFn = (res: ServerResponse, status: number, body: unknown) => void;
export type ParseJsonBodyFn = (req: IncomingMessage) => Promise<Record<string, unknown> | null>;

export interface ErrorCategory {
  key: string;
  label: string;
  pattern?: RegExp;
}

export interface CompanyEntry {
  no?: number;
  name?: string;
  type?: string;
  formUrl?: string;
  status?: string;
  lastAction?: string;
  lastActionAt?: string;
  lastErrorDetail?: unknown;
  errorReason?: unknown;
  lastActionDetail?: unknown;
  lastLog?: { details?: unknown };
  logs?: Array<{ action?: string; details?: unknown }>;
}

export interface ErrorRecoveryRouteContext {
  jsonResponse: JsonResponseFn;
  parseJsonBody: ParseJsonBodyFn;
  loadData: () => { companies?: CompanyEntry[] };
  queueAiFormFill: (companies: CompanyEntry[], provider: string, options: Record<string, unknown>) => Promise<Record<string, unknown>>;
  findCompaniesByNos: (nos: number[]) => { ok: boolean; error?: string; companies?: CompanyEntry[] };
  ensureClaudeAutomationReady: (provider: string) => Promise<{ ok: boolean; statusCode?: number; error?: string }>;
  getSelectedAiProvider: () => string;
  getManagedAiProvider?: () => string;
  getClaudePty?: () => unknown;
  getActiveHeadlessRun?: () => { provider?: string } | null;
  getManagedAiAutoSendSafe: () => boolean;
  appendDiagnosticEvent?: (event: string, payload: Record<string, unknown>) => void;
}

export type ErrorRecoveryDispatcher = (req: IncomingMessage, res: ServerResponse, pathname: string) => Promise<boolean>;

export const ERROR_CATEGORIES: ErrorCategory[] = [
  { key: 'captcha',     label: 'CAPTCHA / reCAPTCHA',   pattern: /captcha|reCAPTCHA|hCaptcha|画像認証|ロボット|ロボチェッカー/i },
  { key: 'no_form',     label: 'Web フォームなし',         pattern: /Web\s*フォームなし|mailto|メール\s*リンクのみ|フォーム.*(見当たらない|見つからない|見つけられない|存在しない|なし|無い)|問い合わせ.*フォーム.*(不明|なし|無い)|問い合わせ窓口.*(見当たらない|見つからない|見つけられない|なし|不明)|フォームURL.*未解決/i },
  { key: 'timeout',     label: 'タイムアウト',              pattern: /タイムアウト|更新なし|stalled|stall|フェーズB遷移タイムアウト|timeout/i },
  { key: 'mcp',         label: 'MCP / Playwright',      pattern: /MCP\s*Playwright|playwright が|playwright\s*未/i },
  { key: 'unsupported', label: '営業NG / 対象外',         pattern: /営業NG|営業お断り|対象外|採用専用|IR専用|報道専用|既存顧客専用/i },
  { key: 'auth',        label: '認証必要',                 pattern: /Login|ログインが必要|認証/i },
  { key: 'parse',       label: '入力欄特定不能',           pattern: /入力可能.*項目.*特定できません|フィールド.*(見当たらない|見つからない)|項目.*不足|select.*不明/i },
];

export function categorizeError(detailsRaw: unknown): ErrorCategory {
  const text = String(
    detailsRaw == null
      ? ''
      : (typeof detailsRaw === 'object' ? JSON.stringify(detailsRaw) : detailsRaw)
  );
  for (const cat of ERROR_CATEGORIES) {
    if (cat.pattern && cat.pattern.test(text)) return cat;
  }
  return { key: 'other', label: 'その他' };
}

export function getCompanyErrorReason(company: CompanyEntry | null | undefined): unknown {
  if (!company || typeof company !== 'object') return '';
  const fromLogs = Array.isArray(company.logs)
    ? [...company.logs].reverse().find((log: any) => String(log?.action ?? '') === 'error')
    : null;
  return company.lastErrorDetail
    ?? company.errorReason
    ?? company.lastActionDetail
    ?? company.lastLog?.details
    ?? fromLogs?.details
    ?? '';
}

export function isErroredCompany(company: CompanyEntry | null | undefined): boolean {
  const lastAction = String(company?.lastAction ?? '').toLowerCase();
  const status = String(company?.status ?? '').toLowerCase();
  return lastAction === 'error' || status === 'error';
}

interface GroupedEntry {
  key: string;
  label: string;
  count: number;
  companies: Array<{
    no: number | undefined;
    name: string | undefined;
    type: string | undefined;
    formUrl: string | undefined;
    status: string | undefined;
    reason: string;
    lastActionAt: string | undefined;
  }>;
}

function createErrorRecoveryRoutes(ctx: ErrorRecoveryRouteContext): ErrorRecoveryDispatcher {
  const {
    jsonResponse,
    parseJsonBody,
    loadData,
    queueAiFormFill,
    findCompaniesByNos,
    ensureClaudeAutomationReady,
    getSelectedAiProvider,
    getManagedAiProvider,
    getClaudePty,
    getActiveHeadlessRun,
    getManagedAiAutoSendSafe,
    appendDiagnosticEvent,
  } = ctx;

  function resolveActiveProvider(explicitProvider: string | undefined): string {
    const activePty = getClaudePty?.();
    if (activePty && typeof getManagedAiProvider === 'function') {
      return getManagedAiProvider();
    }
    const headless = getActiveHeadlessRun?.();
    if (headless && headless.provider) {
      return headless.provider;
    }
    if (explicitProvider) return explicitProvider;
    return getSelectedAiProvider();
  }

  async function handleGroupedErrors(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const data = loadData();
      const companies = data.companies ?? [];
      const errored = companies.filter(isErroredCompany);
      const groups: Record<string, GroupedEntry> = {};
      for (const c of errored) {
        const reason = getCompanyErrorReason(c);
        const cat = categorizeError(reason);
        if (!groups[cat.key]) groups[cat.key] = { key: cat.key, label: cat.label, count: 0, companies: [] };
        groups[cat.key].count++;
        groups[cat.key].companies.push({
          no: c.no,
          name: c.name,
          type: c.type,
          formUrl: c.formUrl,
          status: c.status,
          reason: typeof reason === 'object' ? JSON.stringify(reason) : String(reason).slice(0, 280),
          lastActionAt: c.lastActionAt,
        });
      }
      const sorted = Object.values(groups).sort((a: any, b: any) => b.count - a.count);
      jsonResponse(res, 200, { ok: true, total: errored.length, groups: sorted });
    } catch (e: unknown) {
      jsonResponse(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  async function handleRetry(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const body = (await parseJsonBody(req)) ?? {};
      const rawNos = Array.isArray(body.companyNos)
        ? (body.companyNos as unknown[]).map(Number).filter((n: any) => Number.isFinite(n) && n > 0)
        : [];
      const companyNos = Array.from(new Set(rawNos));
      if (companyNos.length === 0) {
        jsonResponse(res, 400, { ok: false, error: 'companyNos is required' });
        return;
      }
      if (companyNos.length > 50) {
        jsonResponse(res, 400, { ok: false, error: 'companyNos is too large; max 50 per retry' });
        return;
      }
      const found = findCompaniesByNos(companyNos);
      if (!found || !found.ok) {
        jsonResponse(res, 400, { ok: false, error: found?.error ?? 'companies not found' });
        return;
      }
      const provider = resolveActiveProvider(typeof body.provider === 'string' ? body.provider : undefined);
      const ready: any = await ensureClaudeAutomationReady(provider).catch((e: unknown) => ({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      } as const));
      if (!ready.ok) {
        const r = ready as { ok: false; statusCode?: number; error?: string };
        jsonResponse(res, r.statusCode || 409, { ok: false, error: r.error });
        return;
      }
      const result: any = await queueAiFormFill(found.companies ?? [], provider, {
        autoSendSafe: getManagedAiAutoSendSafe(),
        phaseAByCompany: new Map<any, any>(),
        phaseASuccesses: [],
        phaseAFailures: [],
      });
      if (typeof appendDiagnosticEvent === 'function') {
        appendDiagnosticEvent('error_retry_queued', { companyNos, provider });
      }
      jsonResponse(res, 200, { ok: true, requeued: companyNos.length, ...result });
    } catch (e: unknown) {
      jsonResponse(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return async function dispatch(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
    const method = req.method;
    if (pathname === '/api/errors/grouped' && method === 'GET') {
      await handleGroupedErrors(req, res);
      return true;
    }
    if (pathname === '/api/error/retry' && method === 'POST') {
      await handleRetry(req, res);
      return true;
    }
    return false;
  };
}

const moduleExports = Object.assign(createErrorRecoveryRoutes, {
  ERROR_CATEGORIES,
  categorizeError,
  getCompanyErrorReason,
  isErroredCompany,
});

module.exports = moduleExports;
export default createErrorRecoveryRoutes;

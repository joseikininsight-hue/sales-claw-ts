// Recovery API.
//
// 前回セッションの managed AI batch スナップショットを扱うエンドポイント。
// 起動時に loadRecoverySnapshot() で検出済み = 中断されたバッチがあるため、
// ユーザーが「続きから実行」「破棄」を選べるようにする。
//
//   GET  /api/recovery/status    現在のスナップショット概要
//   POST /api/recovery/resume    スナップショットを再 queue
//   POST /api/recovery/discard   スナップショットを破棄

import type { IncomingMessage, ServerResponse } from 'http';
import { loadRecoverySnapshot, clearRecoverySnapshot } from '../recovery-store';

export type JsonResponseFn = (res: ServerResponse, status: number, body: unknown) => void;

export interface RecoveryRouteContext {
  jsonResponse: JsonResponseFn;
  parseJsonBody?: (req: IncomingMessage) => Promise<unknown>;
  queueAiFormFill: (companies: unknown[], providerId: string, options: Record<string, unknown>) => Promise<Record<string, unknown>>;
  appendDiagnosticEvent?: (event: string, payload: Record<string, unknown>) => void;
  ensureClaudeAutomationReady?: (providerId: string) => Promise<{ ok: boolean; statusCode?: number; error?: string }>;
  findCompaniesByNos?: (nos: number[]) => { ok: boolean; companies?: unknown[] };
}

export type RecoveryDispatcher = (req: IncomingMessage, res: ServerResponse, pathname: string) => Promise<boolean>;

interface SnapCompany { no?: number | string; companyNo?: number | string; companyName?: string; name?: string }

function createRecoveryRoutes(ctx: RecoveryRouteContext): RecoveryDispatcher {
  const {
    jsonResponse,
    queueAiFormFill,
    appendDiagnosticEvent,
    ensureClaudeAutomationReady,
    findCompaniesByNos,
  } = ctx;

  async function handleStatus(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const snap = loadRecoverySnapshot();
      if (!snap || !Array.isArray(snap.batches) || snap.batches.length === 0) {
        jsonResponse(res, 200, { ok: true, hasSnapshot: false });
        return;
      }
      const totalCompanies = snap.batches.reduce(
        (acc: number, b) => acc + (Array.isArray(b.companies) ? b.companies.length : 0),
        0
      );
      jsonResponse(res, 200, {
        ok: true,
        hasSnapshot: true,
        providerId: snap.providerId || null,
        mode: snap.mode || '',
        autoSendSafe: Boolean(snap.autoSendSafe),
        batchCount: snap.batches.length,
        totalCompanies,
        savedAt: snap.savedAt || null,
        // 軽量プレビュー用に会社名リストも返す
        companyNames: snap.batches.flatMap((b: any) =>
          (b.companies || []).map((c: SnapCompany) =>
            c.companyName || c.name || ('#' + (c.no ?? c.companyNo ?? '?'))
          )
        ).slice(0, 20),
      });
    } catch (e: unknown) {
      jsonResponse(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  async function handleResume(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const snap = loadRecoverySnapshot();
      if (!snap || !Array.isArray(snap.batches) || snap.batches.length === 0) {
        // 409 (state conflict) を返す。404 だと UI 側が「API endpoint 不在」=「バージョン古い」と誤訳してしまう。
        // snapshot は起動時には存在したが resume 中に discard / 別タブ操作で消えるレースが現実に起きる。
        jsonResponse(res, 409, {
          ok: false,
          code: 'no_snapshot',
          error: 'リカバリ対象のスナップショットがありません (既に再開済 / 破棄済の可能性)',
        });
        return;
      }
      const providerId = snap.providerId || 'claude';
      const ready = typeof ensureClaudeAutomationReady === 'function'
        ? await ensureClaudeAutomationReady(providerId).catch(() => ({ ok: true }))
        : { ok: true } as const;
      if (!ready.ok) {
        const r = ready as { ok: false; statusCode?: number; error?: string };
        jsonResponse(res, r.statusCode || 409, { ok: false, error: r.error || 'AI runtime が準備できていません' });
        return;
      }
      // 全バッチを統合して 1 回 queue。queueAiFormFill 側で batchSize 単位に分割される。
      const allCompanies = snap.batches.flatMap((b: any) => (b.companies || [])) as SnapCompany[];
      // 念のため最新の company レコードに突き合わせ (削除済み等を除外)
      const nos = allCompanies
        .map((c: any) => Number(c.no ?? c.companyNo))
        .filter((n: any) => Number.isFinite(n));
      const found = typeof findCompaniesByNos === 'function'
        ? findCompaniesByNos(nos)
        : { ok: true, companies: allCompanies };
      const companies = (found && found.ok && Array.isArray(found.companies) && found.companies.length > 0)
        ? found.companies
        : allCompanies;

      const result: any = await queueAiFormFill(companies, providerId, {
        autoSendSafe: Boolean(snap.autoSendSafe),
        // Phase A 再実行のための空 payload (再分析させる)
        phaseAByCompany: new Map<any, any>(),
        phaseASuccesses: [],
        phaseAFailures: [],
      });
      // 再 queue が成功したらスナップショット破棄
      clearRecoverySnapshot();
      if (typeof appendDiagnosticEvent === 'function') {
        appendDiagnosticEvent('recovery_resume_completed', {
          providerId,
          requeuedCompanies: companies.length,
        });
      }
      jsonResponse(res, 200, { ok: true, requeued: companies.length, ...result });
    } catch (e: unknown) {
      jsonResponse(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  async function handleDiscard(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      clearRecoverySnapshot();
      if (typeof appendDiagnosticEvent === 'function') {
        appendDiagnosticEvent('recovery_snapshot_discarded', {});
      }
      jsonResponse(res, 200, { ok: true });
    } catch (e: unknown) {
      jsonResponse(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return async function dispatch(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
    const method = req.method;
    if (pathname === '/api/recovery/status' && method === 'GET') {
      await handleStatus(req, res);
      return true;
    }
    if (pathname === '/api/recovery/resume' && method === 'POST') {
      await handleResume(req, res);
      return true;
    }
    if (pathname === '/api/recovery/discard' && method === 'POST') {
      await handleDiscard(req, res);
      return true;
    }
    return false;
  };
}

module.exports = createRecoveryRoutes;
export default createRecoveryRoutes;

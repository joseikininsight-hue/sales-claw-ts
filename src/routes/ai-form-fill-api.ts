'use strict';

/**
 * AI Form Fill API Routes
 *
 * dashboard-server.cjs から切り出された AI フォーム入力キュー投入 API。
 * Phase 2 リファクタリングの一環として、モノリス化した dashboard-server.cjs から
 * /api/ai-form-fill のハンドラを分離する。
 *
 * 対応エンドポイント:
 *  - POST /api/ai-form-fill
 *
 * 既存の dashboard-server.cjs のロジックは変更せずそのまま移植している。
 * claudePty / managedAiBatchController / managedAiRecoveryTimer のような state は
 * 依然として dashboard-server.cjs に存在するため、getter / setter 関数で ctx 経由で
 * 参照する。
 */

const { getHistory } = require('../contact-history');
const { getLiveMonitorSummary } = require('../live-monitor');

/**
 * AI Form Fill API ルーターを生成する factory。
 * dashboard-server.cjs から require して呼び、共有ユーティリティ & state アクセサを ctx で注入する。
 *
 * @param {object} ctx
 * @param {function} ctx.jsonResponse - (res, statusCode, data, extraHeaders?) を書き込む
 * @param {function} ctx.parseJsonBody - (req) → Promise<object>
 *
 * @param {function} ctx.normalizeProviderId - (id) → 正規化された providerId
 * @param {function} ctx.getSelectedAiProvider - () → 現在選択中の providerId
 * @param {function} ctx.isAiRuntimeActivelyProcessing - () → boolean
 *
 * @param {function} ctx.getClaudePty - () → claudePty | null
 * @param {function} ctx.findCompaniesByNos - (companyNos) → { ok, companies?, error? }
 * @param {function} ctx.appendDiagnosticEvent - (type, payload) → void
 * @param {function} ctx.executeBackendPhaseABatch - (companies, providerId) → Promise<{ successes, failures, elapsedMs }>
 * @param {function} ctx.ensureClaudeAutomationReady - (providerId) → Promise<{ ok, providerId?, error?, statusCode? }>
 * @param {function} ctx.queueAiFormFill - (companies, providerId, options) → Promise<object>
 * @param {function} ctx.getManagedAiAutoSendSafe - () → boolean
 * @param {function} ctx.getManagedAiReservedCompanyNos - () → Set<number>
 * @param {function} ctx.cleanupStaleManagedAiMonitorEvents - (thresholdMs) → void
 * @param {function} ctx.getActiveHeadlessRun - () → run | null
 *
 * @param {function} ctx.getManagedAiBatchController - () → managedAiBatchController | null
 * @param {function} ctx.setManagedAiBatchActive - (value) → void (managedAiBatchController.activeBatch = value と同等)
 * @param {function} ctx.getManagedAiRecoveryTimer - () → managedAiRecoveryTimer | null
 *
 * @returns {function} dispatch(req, res, pathname) → Promise<boolean> (handled なら true)
 */
module.exports = function createAiFormFillRoutes(ctx) {
  const {
    jsonResponse,
    parseJsonBody,
    normalizeProviderId,
    getSelectedAiProvider,
    getManagedAiProvider,
    isAiRuntimeActivelyProcessing,
    getClaudePty,
    findCompaniesByNos,
    appendDiagnosticEvent,
    executeBackendPhaseABatch,
    ensureClaudeAutomationReady,
    queueAiFormFill,
    getManagedAiAutoSendSafe,
    getManagedAiReservedCompanyNos,
    cleanupStaleManagedAiMonitorEvents,
    getActiveHeadlessRun,
    getManagedAiBatchController,
    setManagedAiBatchActive,
    clearManagedAiBatchPending,
    getManagedAiRecoveryTimer,
  } = ctx;

  /**
   * provider 解決の優先順位 (active session first):
   *   1. 現在 PTY が走っている provider (= getManagedAiProvider)
   *   2. headless run の provider
   *   3. 明示指定された data.provider
   *   4. settings 上の選択 (= getSelectedAiProvider)
   *
   * ユーザーの mental model は「いま動いてる AI に投げる」。launcher で
   * Codex を起動したのに settings 既定が Claude のままだと、UI が
   * `provider: 'claude'` を送って ensureClaudeAutomationReady で
   * 「現在の管理セッションは Codex です」というエラーになる。
   * 実 PTY を最優先にすることでこの ergonomic mismatch を吸収する。
   * 明示指定 (explicitProvider) は PTY が無い時のフォールバックに退ける。
   */
  function resolveActiveProvider(explicitProvider) {
    const activePty = getClaudePty && getClaudePty();
    if (activePty && typeof getManagedAiProvider === 'function') {
      return normalizeProviderId(getManagedAiProvider());
    }
    const headless = getActiveHeadlessRun && getActiveHeadlessRun();
    if (headless && headless.provider) {
      return normalizeProviderId(headless.provider);
    }
    if (explicitProvider) return normalizeProviderId(explicitProvider);
    return normalizeProviderId(getSelectedAiProvider());
  }

  // POST /api/ai-form-fill — queue work into the selected AI automation runtime
  async function handleAiFormFill(req, res) {
    try {
      const data: any = await parseJsonBody(req);
      const companyNos = Array.isArray(data && data.companyNos) ? data.companyNos : [];
      const providerId = resolveActiveProvider(data && data.provider);
      if (companyNos.length === 0) {
        appendDiagnosticEvent('ai_form_fill_invalid_request', { companyNos, provider: providerId });
        jsonResponse(res, 400, { ok: false, error: 'companyNos is required.' });
        return;
      }
      const found = findCompaniesByNos(companyNos);
      if (!found.ok) {
        appendDiagnosticEvent('ai_form_fill_target_lookup_failed', {
          companyNos,
          provider: providerId,
          error: found.error || 'Target companies not found.',
        });
        jsonResponse(res, 400, { ok: false, error: found.error || 'Target companies not found.' });
        return;
      }

      // 重複キューイング防止: 実際に稼働中のAI/batchだけを基準に判定する
      // (getLiveMonitorSummary はファイル冒頭で既に require 済み)
      const claudePty = getClaudePty();
      const managedAiRecoveryTimer = getManagedAiRecoveryTimer();
      const managedAiBatchController = getManagedAiBatchController();
      const ptyActuallyRunning = !!(claudePty || getActiveHeadlessRun());
      if (!ptyActuallyRunning) {
        // PTYが停止中かつリカバリタイマーもない → activeBatch + pending は確実に古い。
        // v2.0.10: pending も一緒にドレインする。
        // 過去バグ: Phase B が起動失敗 (MCP playwright already exists 等) でログが
        // 残らなかった会社が controller.pending に永久滞留し、再キュー時に
        // 「既に処理中です」エラーで弾かれ続けた。PTY が死んでいる時点で
        // pending は意味を成さない (誰も処理しない) ので捨てて再投入を許す。
        if (!managedAiRecoveryTimer && managedAiBatchController) {
          setManagedAiBatchActive(null);
          if (typeof clearManagedAiBatchPending === 'function') {
            try { clearManagedAiBatchPending(); } catch (_) { /* swallow */ }
          }
        }
        cleanupStaleManagedAiMonitorEvents(0);
      }
      const monitorSummary = getLiveMonitorSummary();
      const activeNos = getManagedAiReservedCompanyNos();
      if (isAiRuntimeActivelyProcessing()) {
        (monitorSummary.events || [])
          .filter(ev => ev && ev.active !== false && !['awaiting_approval','submitted','completed','skipped','error'].includes(ev.status))
          .forEach((ev: any) => {
            activeNos.add(Number(ev.companyNo));
          });
      }
      const alreadyQueued = found.companies.filter(c => activeNos.has(Number(c.no)));
      if (alreadyQueued.length > 0) {
        const names = alreadyQueued.map(c => c.companyName || c.name || '#' + c.no).join(', ');
        jsonResponse(res, 409, { ok: false, error: '以下の企業は既に処理中です: ' + names + '。完了後に再度キューしてください。' });
        return;
      }

      // 2回目以降のアプローチ判定: 送信済み企業にはcontactNoを付与
      // (getHistory はファイル冒頭で既に require 済み)
      const companiesWithContactNo = found.companies.map(c => {
        const history = getHistory(c.no);
        const contactNo = (history && Array.isArray(history.contacts)) ? history.contacts.length + 1 : 1;
        return { ...c, contactNo };
      });

      // Electron モード判定（WebContentsView が使えるか）
      let electronMode = false;
      try {
        const electron = require('electron');
        electronMode = !!(electron && electron.BrowserWindow);
      } catch (_) { electronMode = false; }

      if (!electronMode) {
        appendDiagnosticEvent('ai_form_fill_not_electron', { providerId });
        jsonResponse(res, 503, {
          ok: false,
          error: 'Electron デスクトップアプリから実行してください。Node 単体 (npm run dashboard) では WebContentsView が使えないためフォーム入力は実施できません。',
          code: 'ELECTRON_REQUIRED',
          detail: 'Current runtime does not expose the electron module (likely running as plain Node).',
        });
        return;
      }

      const ready: any = await ensureClaudeAutomationReady(providerId);
      if (!ready.ok) {
        appendDiagnosticEvent('ai_form_fill_not_ready', {
          companyNos,
          provider: ready.providerId || providerId,
          error: ready.error || 'AI automation is not ready.',
          statusCode: ready.statusCode || 409,
        });
        jsonResponse(res, ready.statusCode || 409, { ok: false, error: ready.error });
        return;
      }

      const phaseA: any = await executeBackendPhaseABatch(companiesWithContactNo, providerId);
      const phaseASkipped = Array.isArray(phaseA.skipped) ? phaseA.skipped : [];
      if (phaseA.successes.length === 0) {
        // 区別: 全件 skipped (URL未設定 / dealBreakers / 営業お断り 等) なのか、
        // 全件 failure (subprocess crash / HTTP エラー) なのか、混在なのか。
        const allSkipped = phaseASkipped.length > 0 && phaseA.failures.length === 0;
        const skipReasons = phaseASkipped.map((s: any) => `#${s.no} ${s.companyName || ''}: ${s.reason || s.skipKind || 'skipped'}`).join('\n');
        appendDiagnosticEvent('ai_form_fill_phase_a_no_success', {
          companyNos,
          provider: providerId,
          successCount: 0,
          skippedCount: phaseASkipped.length,
          failureCount: phaseA.failures.length,
          allSkipped,
          elapsedMs: phaseA.elapsedMs,
        });
        const errorMsg = allSkipped
          ? `選択された ${phaseASkipped.length} 社すべてが処理対象外としてスキップされました。\n\n主な理由:\n${skipReasons}\n\nURL 未設定の企業は、target list の URL または formUrl を設定してから再実行してください。`
          : `Phase A（企業分析+文面生成）が ${phaseA.failures.length} 件失敗、${phaseASkipped.length} 件スキップされました。\n\n主な失敗:\n${phaseA.failures.map((entry: any) => `#${entry && (entry.no || entry.companyNo) || '?'} ${entry && entry.companyName || ''}: ${entry && entry.error || 'phase_a_failed'}`).join('\n') || '(詳細なし)'}`;
        jsonResponse(res, 409, {
          ok: false,
          error: errorMsg,
          phaseA: {
            successCount: 0,
            skippedCount: phaseASkipped.length,
            failureCount: phaseA.failures.length,
            elapsedMs: phaseA.elapsedMs,
            skipped: phaseASkipped.map((entry: any) => ({
              companyNo: entry.no,
              companyName: entry.companyName,
              reason: entry.reason,
              skipKind: entry.skipKind || null,
            })),
            failures: phaseA.failures.map((entry: any) => ({
              companyNo: entry && entry.no,
              companyName: entry && entry.companyName,
              error: entry && entry.error,
            })),
          },
        });
        return;
      }

      const successfulCompanies = companiesWithContactNo.filter((company: any) =>
        phaseA.successes.some((entry: any) => String(entry.companyNo) === String(company.no))
      ).map((company: any) => {
        const phaseAResult = phaseA.successes.find((entry: any) => String(entry.companyNo) === String(company.no));
        return {
          ...company,
          formUrl: (phaseAResult && phaseAResult.formUrl) || company.formUrl || '',
          phaseA: phaseAResult ? {
            analysis: phaseAResult.analysis || null,
            message: phaseAResult.message || '',
            messagePrompt: phaseAResult.messagePrompt || '',
            analysisElapsedMs: phaseAResult.elapsedMs,
            formUrl: phaseAResult.formUrl || company.formUrl || '',
            formResolutionMethod: phaseAResult.formResolutionMethod || null,
          } : null,
        };
      });
      const phaseAByCompany = new Map(
        phaseA.successes.map((entry: any) => [
          String(entry.companyNo),
          {
            analysis: entry.analysis || null,
            message: entry.message || '',
            messagePrompt: entry.messagePrompt || '',
            elapsedMs: entry.elapsedMs,
            formUrl: entry.formUrl || '',
            formResolutionMethod: entry.formResolutionMethod || null,
          },
        ])
      );

      const result: any = await queueAiFormFill(successfulCompanies, providerId, {
        autoSendSafe: getManagedAiAutoSendSafe(),
        phaseAByCompany,
        phaseASuccesses: phaseA.successes,
        phaseAFailures: phaseA.failures,
      });
      jsonResponse(res, 200, {
        ...result,
        phaseA: {
          successCount: phaseA.successes.length,
          failureCount: phaseA.failures.length,
          elapsedMs: phaseA.elapsedMs,
          failures: phaseA.failures.map((entry: any) => ({
            companyNo: entry.companyNo,
            companyName: entry.companyName,
            error: entry.error,
          })),
        },
      });
    } catch (e) {
      appendDiagnosticEvent('ai_form_fill_internal_error', { error: e.message });
      jsonResponse(res, 500, { ok: false, error: e.message });
    }
  }

  /**
   * 受信した request が /api/ai-form-fill の管轄であれば handle して true を返す。
   * 管轄外であれば false を返して呼び出し側に処理を戻す。
   *
   * @param {http.IncomingMessage} req
   * @param {http.ServerResponse} res
   * @param {string} pathname - URL.pathname (? 以降削除済み)
   * @returns {Promise<boolean>}
   */
  return async function dispatch(req, res, pathname) {
    if (pathname === '/api/ai-form-fill' && req.method === 'POST') {
      await handleAiFormFill(req, res);
      return true;
    }
    return false;
  };
};

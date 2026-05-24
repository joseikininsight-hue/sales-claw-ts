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
    getManagedAiFormBatchSize,
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
        // v2.0.65: Target list が消えた/移動した時の UX 改善。
        //   旧: 「Target list file not found: <path>」を返すだけで、ユーザーは
        //     どこで再選択すればいいか分からなかった。
        //   新: code:'TARGET_LIST_MISSING' を返し、UI 側でユーザー誘導バナーを出せるようにする。
        const rawError = String(found.error || 'Target companies not found.');
        const isMissingFile = /file not found|no such file|ENOENT/i.test(rawError);
        jsonResponse(res, 400, {
          ok: false,
          error: rawError,
          ...(isMissingFile ? {
            code: 'TARGET_LIST_MISSING',
            hint: '企業リスト (target-list.xlsx) が見つかりません。「設定」→「ターゲットリスト」から再選択するか、List Builder で新しいリストを作成してください。',
          } : {}),
        });
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
        // v2.0.42: live-monitor の古い「analyzing / active=true」event は
        //   Phase A subprocess crash や stop 前の状態がそのまま残っているゴミ。
        //   旧: 何分前の event であろうと activeNos に追加 → 再キュー時に
        //     「既に処理中」エラーで弾かれる事故 (4社が数時間 stuck)。
        //   新: 5分以上更新がない event は古いゴミとして無視する。本当に処理中
        //     なら 5分以内に何らかの logAction / monitor update が出るはず。
        const STALE_MONITOR_MS = 5 * 60 * 1000;
        const nowMs = Date.now();
        (monitorSummary.events || [])
          .filter(ev => ev && ev.active !== false && !['awaiting_approval','submitted','completed','skipped','error'].includes(ev.status))
          .filter(ev => {
            const tsRaw = ev.updatedAt || ev.timestamp || ev.time;
            const tsMs = tsRaw ? Date.parse(String(tsRaw)) : 0;
            if (!Number.isFinite(tsMs) || tsMs === 0) return true; // ts 無いものは保守的に in-flight 扱い
            return (nowMs - tsMs) < STALE_MONITOR_MS;
          })
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

      // v2.0.16 パイプライン: Phase A が 1 件 success するたびに即 Phase B に enqueue。
      // バッファ管理: getManagedAiFormBatchSize 件溜まるか Phase A 完走したら flush。
      // 旧: Phase A 全件完了を待ってから queueAiFormFill → 200 社で 5-10 分の待ち時間。
      // 新: 最初の 1-2 社が分析完了した瞬間に Playwright が動き出す。
      const pipelineEnabled = process.env.SALES_CLAW_PIPELINE !== 'off';
      const batchSize = (typeof getManagedAiFormBatchSize === 'function' ? getManagedAiFormBatchSize() : 3);
      const pipelineBuffer: any[] = [];
      const pipelinePhaseAByCompany = new Map<string, any>();
      let pipelineQueuedCount = 0;
      let pipelineQueueError: any = null;
      // v2.0.19: queueAiFormFill の呼び出しを Promise chain で **順次** 実行する。
      // 旧実装は Promise.resolve().then(...) で投げ放しだったため、Phase A の
      // onSuccess が連続発火すると enqueue 順序が逆転して controller.pending
      // 内のバッチ順が乱れる可能性があった。
      let pipelineChain: Promise<any> = Promise.resolve();

      function pipelineEnqueueBuffer(reason: string) {
        if (pipelineBuffer.length === 0) return;
        const batch = pipelineBuffer.splice(0);
        const localMap = new Map(batch.map((c: any) => [String(c.no), pipelinePhaseAByCompany.get(String(c.no))]));
        pipelineQueuedCount += batch.length;
        appendDiagnosticEvent('phase_a_pipeline_flush', {
          provider: providerId,
          reason,
          companyCount: batch.length,
          companyNos: batch.map((c: any) => c.no),
        });
        // 順次 await でバッチ順序を保証する。Phase A 自体は止まらない (この chain は
        // 別 Promise で連結されるだけ)。
        pipelineChain = pipelineChain.then(() => queueAiFormFill(batch, providerId, {
          autoSendSafe: getManagedAiAutoSendSafe(),
          phaseAByCompany: localMap,
          phaseASuccesses: batch.map((c: any) => c.phaseA),
          phaseAFailures: [],
        })).catch((err: any) => {
          pipelineQueueError = err;
          appendDiagnosticEvent('phase_a_pipeline_enqueue_failed', {
            provider: providerId,
            error: String(err && err.message || err).slice(0, 400),
            companyCount: batch.length,
          });
        });
      }

      const phaseAOptions: any = pipelineEnabled ? {
        onSuccess: (phaseAResult: any, originalCompany: any) => {
          const enriched = {
            ...originalCompany,
            formUrl: (phaseAResult && phaseAResult.formUrl) || originalCompany.formUrl || '',
            phaseA: {
              analysis: phaseAResult.analysis || null,
              message: phaseAResult.message || '',
              messagePrompt: phaseAResult.messagePrompt || '',
              analysisElapsedMs: phaseAResult.elapsedMs,
              formUrl: phaseAResult.formUrl || originalCompany.formUrl || '',
              formResolutionMethod: phaseAResult.formResolutionMethod || null,
            },
          };
          pipelinePhaseAByCompany.set(String(originalCompany.no), {
            analysis: phaseAResult.analysis || null,
            message: phaseAResult.message || '',
            messagePrompt: phaseAResult.messagePrompt || '',
            elapsedMs: phaseAResult.elapsedMs,
            formUrl: phaseAResult.formUrl || '',
            formResolutionMethod: phaseAResult.formResolutionMethod || null,
          });
          pipelineBuffer.push(enriched);
          if (pipelineBuffer.length >= batchSize) {
            pipelineEnqueueBuffer('buffer-full');
          }
        },
      } : {};

      const phaseA: any = await executeBackendPhaseABatch(companiesWithContactNo, providerId, phaseAOptions);
      // Phase A 完了 → buffer に残ったものを最後の batch として flush
      if (pipelineEnabled) {
        pipelineEnqueueBuffer('phase-a-done');
        // pipeline chain が完走するまで待って batch 順序を確定させてから response を返す
        try { await pipelineChain; } catch (_) { /* error は pipelineQueueError に格納済み */ }
      }
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

      // pipeline mode では既に enqueue 済みなので、bulk 再 enqueue を skip。
      // pipeline OFF の旧パスでは従来通り bulk enqueue。
      const result: any = pipelineEnabled
        ? {
            ok: !pipelineQueueError,
            count: pipelineQueuedCount,
            provider: providerId,
            mode: `${providerId}-cli-managed`,
            pipeline: true,
            error: pipelineQueueError ? String(pipelineQueueError.message || pipelineQueueError) : undefined,
          }
        : await queueAiFormFill(successfulCompanies, providerId, {
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

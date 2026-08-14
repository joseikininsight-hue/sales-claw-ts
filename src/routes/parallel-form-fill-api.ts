'use strict';

/**
 * Parallel form-fill API (P1-4)。
 *
 * POST /api/ai-form-fill-parallel
 *   body: { companyNos: number[], provider?: string, concurrency?: number, timeoutMs?: number, staggerMs?: number }
 *   - concurrency 1〜3 (デフォルト 2)
 *   - timeoutMs デフォルト 15分 / staggerMs デフォルト 30秒
 *   - Phase A は executeBackendPhaseABatch で並列分析 (既存)
 *   - Phase B は parallel-dispatcher.runParallelBatch でヘッドレス Claude を
 *     最大 N 並列で spawn
 *
 *   N=1 の場合は managed PTY 経由 (queueAiFormFill) と機能的に同等になる
 *   が、本ルートは管理セッションに触れないので並列実行が安全。
 */

const {
  DEFAULT_CONCURRENCY,
  DEFAULT_STAGGER_MS,
  DEFAULT_TIMEOUT_MS,
  runParallelBatch,
} = require('../ai-runtime/parallel-dispatcher');

function publicErrorMessage(error, fallback = 'request failed') {
  return String(error && error.message || error || fallback)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200) || fallback;
}

function parseBoundedNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

module.exports = function createParallelFormFillRoutes(ctx) {
  const {
    jsonResponse,
    parseJsonBody,
    findCompaniesByNos,
    executeBackendPhaseABatch,
    appendDiagnosticEvent,
    buildClaudeFormFillPrompt,
    writeWorkspaceClaudeFormFillPromptFile,
    buildHeadlessArgs,
    buildCliCommandSpec,
    resolveClaudeExecutable,
    buildManagedProviderEnv,
    createHeadlessAiLogFile,
    appendHeadlessAiLog,
    emitClaudeAutomationLog,
    getSender,
    getProvider,
    normalizeProviderId,
    getSelectedAiProvider,
    isHeadlessAutomationProvider,
    getAutomationModeForProvider,
    hasCompanyTerminalLogSince,
    markParallelCompaniesFailed,
    PROJECT_ROOT,
  } = ctx;

  async function handleParallelFormFill(req, res) {
    try {
      const body: any = await parseJsonBody(req);
      const companyNos = Array.isArray(body && body.companyNos)
        ? body.companyNos.map(Number).filter(Number.isFinite)
        : [];
      // v2.1.9: 既定 concurrency を settings formFill.parallelism (1-3 に clamp) に連動。
      let settingsConcurrency = DEFAULT_CONCURRENCY;
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const settingsManager = require('../settings-manager');
        const ff = settingsManager.getSection('formFill') || {};
        if (Number.isFinite(Number(ff.parallelism))) {
          settingsConcurrency = Math.max(1, Math.min(3, Math.floor(Number(ff.parallelism))));
        }
      } catch (_) { /* settings 不在時は既定値 */ }
      const concurrency = parseBoundedNumber(body && body.concurrency, settingsConcurrency, 1, 3);
      const timeoutMs = parseBoundedNumber(body && body.timeoutMs, DEFAULT_TIMEOUT_MS, 60 * 1000, 30 * 60 * 1000);
      const staggerMs = parseBoundedNumber(body && body.staggerMs, DEFAULT_STAGGER_MS, 0, 120 * 1000);
      const providerId = normalizeProviderId((body && body.provider) || getSelectedAiProvider());

      if (companyNos.length === 0) {
        jsonResponse(res, 400, { ok: false, error: 'companyNos is required' });
        return;
      }
      if (!isHeadlessAutomationProvider(providerId)) {
        jsonResponse(res, 400, {
          ok: false,
          error: `${getProvider(providerId).displayName || providerId} は headless 並列実行に対応していません。`,
        });
        return;
      }
      const found = findCompaniesByNos(companyNos);
      if (!found || !found.ok) {
        jsonResponse(res, 400, { ok: false, error: (found && found.error) || 'companies not found' });
        return;
      }

      // Phase A: 既存の executeBackendPhaseABatch (並列分析 + メッセージ生成)
      const phaseA: any = await executeBackendPhaseABatch(found.companies, providerId);
      if (!phaseA || phaseA.successes.length === 0) {
        // 1.2.81+: skipped を failure と区別 (URL未設定 / 営業お断り / dealBreakers 等の正常 skip)
        const phaseASkipped = Array.isArray(phaseA && phaseA.skipped) ? phaseA.skipped : [];
        const phaseAFailures = Array.isArray(phaseA && phaseA.failures) ? phaseA.failures : [];
        const allSkipped = phaseASkipped.length > 0 && phaseAFailures.length === 0;
        const skipReasons = phaseASkipped.map((s: any) => `#${s.no} ${s.companyName || ''}: ${s.reason || s.skipKind || 'skipped'}`).join('\n');
        const errorMsg = allSkipped
          ? `選択された ${phaseASkipped.length} 社すべてが処理対象外としてスキップされました。\n\n主な理由:\n${skipReasons}\n\nURL 未設定の企業は、target list の URL または formUrl を設定してから再実行してください。`
          : `Phase A が ${phaseAFailures.length} 件失敗、${phaseASkipped.length} 件スキップされました。\n\n主な失敗:\n${phaseAFailures.map((f: any) => `#${f && (f.no || f.companyNo) || '?'} ${f && f.companyName || ''}: ${f && f.error || 'phase_a_failed'}`).join('\n') || '(詳細なし)'}`;
        jsonResponse(res, 409, {
          ok: false,
          error: errorMsg,
          phaseA: {
            successCount: 0,
            skippedCount: phaseASkipped.length,
            failureCount: phaseAFailures.length,
            elapsedMs: phaseA && phaseA.elapsedMs,
            skipped: phaseASkipped.map((s: any) => ({
              companyNo: s.no,
              companyName: s.companyName,
              reason: s.reason,
              skipKind: s.skipKind || null,
            })),
            failures: phaseAFailures.map((f: any) => ({
              companyNo: f && f.no,
              companyName: f && f.companyName,
              error: typeof (f && f.error) === 'string' ? f.error.slice(0, 200) : 'phase_a_failed',
            })),
          },
        });
        return;
      }

      // Phase A 成功した会社だけを Phase B に渡す
      const phaseAByNo: Map<string, any> = new Map(phaseA.successes.map((s: any) => [String(s.companyNo), s]));
      const phaseBCompanies = found.companies
        .filter((c: any) => phaseAByNo.has(String(c.no)))
        .map((c: any) => {
          const a = phaseAByNo.get(String(c.no));
          return {
            ...c,
            phaseA: {
              analysis: a.analysis || null,
              message: a.message || '',
              messagePrompt: a.messagePrompt || '',
              formUrl: a.formUrl || c.formUrl || '',
              formResolutionMethod: a.formResolutionMethod || null,
            },
            formUrl: a.formUrl || c.formUrl || '',
          };
        });

      // 自動送信ポリシー (確認待ちで停止) は managed と同じ semantics に倣う。
      // ヘッドレスではユーザーが画面を見ていないので、安全側で必ず confirm 待ち。
      const autoSendSafe = false;

      // 重要-4 修正: Phase A の analysis / message / messagePrompt を slot 内 prompt
      // 構築時に渡す。Map<companyNo(string), phaseAResult> 形式で
      // buildClaudeFormFillPrompt が要求する形に合わせる。
      const phaseAByCompany = new Map(phaseA.successes.map((s: any) => [String(s.companyNo), {
        analysis: s.analysis || null,
        message: s.message || '',
        messagePrompt: s.messagePrompt || '',
        elapsedMs: s.elapsedMs,
        formUrl: s.formUrl || '',
        formResolutionMethod: s.formResolutionMethod || null,
      }]));

      const result: any = await runParallelBatch(phaseBCompanies, {
        providerId,
        projectRoot: PROJECT_ROOT,
        runtimeBaseDir: '',
        appendDiagnosticEvent,
        emitLog: (text, stream, pid, slotIdx) => {
          try { emitClaudeAutomationLog(`[slot ${slotIdx}] ${text}`, stream, pid); } catch (_) {}
        },
        // 重要-2 修正: slotIdx を受け取って slot 別ログファイルを返す
        createLogFile: (pid, slotIdx) => createHeadlessAiLogFile(pid, slotIdx),
        appendLog: (filePath, stream, text) => appendHeadlessAiLog(filePath, stream, text),
        // 重要-4 修正: Phase A データを buildClaudeFormFillPrompt に必ず渡す
        // 1.2.37: 並列 slot はレート制限に当たりやすいので prompt を短くする。
        buildPromptText: (companies) => buildClaudeFormFillPrompt(companies, getSender(), providerId, {
          autoSendSafe,
          phaseAByCompany,
          promptProfile: 'parallel-fast',
        }),
        writePromptFile: (companies, promptText, pid) => writeWorkspaceClaudeFormFillPromptFile(companies, promptText, pid),
        buildHeadlessArgs: (pid, mode, opts) => buildHeadlessArgs(pid, mode, opts),
        buildCliCommandSpec: (exe, args) => buildCliCommandSpec(exe, args),
        resolveExecutable: (pid) => resolveClaudeExecutable(pid),
        buildBaseEnv: (pid) => buildManagedProviderEnv(pid),
        hasCompanyTerminalLogSince,
        markCompaniesFailed: markParallelCompaniesFailed,
      }, {
        concurrency,
        timeoutMs,
        staggerMs,
        mode: getAutomationModeForProvider(providerId),
      });

      jsonResponse(res, 200, {
        ok: result.ok,
        provider: providerId,
        concurrency,
        timeoutMs,
        staggerMs,
        totalCompanies: phaseBCompanies.length,
        phaseA: {
          successCount: phaseA.successes.length,
          failureCount: phaseA.failures.length,
          elapsedMs: phaseA.elapsedMs,
        },
        phaseB: {
          succeededSlots: result.succeeded,
          failedSlots: result.failed,
          succeededCompanies: result.succeededCompanies,
          failedCompanies: result.failedCompanies,
          elapsedMs: result.elapsedMs,
          slots: (result.slots || []).map((s: any) => ({
            slotIdx: s.slotIdx,
            ok: s.ok,
            error: s.error || null,
            companyNos: (s.companies || []).map((c: any) => c.no),
            elapsedMs: s.elapsedMs,
            exitCode: s.exitCode || null,
            promptFile: s.promptFile || null,
            logFile: s.logFile || null,
            failedCompanyNos: s.failedCompanyNos || [],
            missingCompanyNos: s.missingCompanyNos || [],
          })),
        },
      });
    } catch (e) {
      jsonResponse(res, 500, { ok: false, error: publicErrorMessage(e) });
    }
  }

  return async function dispatch(req, res, pathname) {
    if (pathname === '/api/ai-form-fill-parallel' && req.method === 'POST') {
      await handleParallelFormFill(req, res);
      return true;
    }
    return false;
  };
};

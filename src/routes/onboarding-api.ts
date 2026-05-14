'use strict';

/**
 * Onboarding Wizard API.
 *
 *   GET  /onboarding                     wizard HTML (top-level page)
 *   POST /api/onboarding/progress        save partial state (resume)
 *   GET  /api/onboarding/progress        load saved partial state
 *   POST /api/onboarding/validate        per-step server-side validation
 *   POST /api/onboarding/import-targets  multipart file upload (Excel/CSV)
 *   GET  /api/onboarding/check-ai        AI provider auth status
 *   POST /api/onboarding/complete        finalize → settings.json + _onboardedAt
 *   POST /api/onboarding/reset           drop _onboardedAt to re-trigger wizard (dev only)
 */

const fs = require('fs');
const path = require('path');
const validator = require('../onboarding-validator');
const { renderOnboardingPage } = require('../onboarding-wizard');

module.exports = function createOnboardingRoutes(ctx) {
  const {
    jsonResponse,
    parseJsonBody,
    settingsManager,                 // src/settings-manager.cjs
    getDataPath,                     // (filename) => absolute path under runtime data dir
    probeClaudeAuthStatus,
    importTargetList,
    readTargetList,
    refreshWatchTargets,
    notifyClients,
    appendDiagnosticEvent,
    getDashboardSessionToken,
  } = ctx;

  const PROGRESS_FILE = getDataPath ? getDataPath('onboarding-progress.json') : null;

  function readProgress() {
    if (!PROGRESS_FILE) return null;
    try {
      if (!fs.existsSync(PROGRESS_FILE)) return null;
      return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
    } catch (_) { return null; }
  }
  function writeProgress(obj) {
    if (!PROGRESS_FILE) return;
    try {
      fs.mkdirSync(path.dirname(PROGRESS_FILE), { recursive: true });
      fs.writeFileSync(PROGRESS_FILE, JSON.stringify(obj || {}, null, 2));
    } catch (e) {
      console.warn('[onboarding] failed to write progress:', e && e.message);
    }
  }
  function clearProgress() {
    if (!PROGRESS_FILE) return;
    try { fs.unlinkSync(PROGRESS_FILE); } catch (_) {}
  }

  // ---------- handlers ----------

  async function handleGetWizard(req, res, queryParams) {
    try {
      const sessionToken = typeof getDashboardSessionToken === 'function' ? getDashboardSessionToken() : '';
      // ?fresh=1 で進捗をクリアして最初から開始 (再実行用)
      const fresh = queryParams && queryParams.get && queryParams.get('fresh') === '1';
      if (fresh) {
        clearProgress();
        try {
          // load() の戻り値は deepFreeze 済なので clone してから mutate する
          const all = settingsManager.getAll() || {};
          const next = JSON.parse(JSON.stringify(all));
          delete next._onboardedAt;
          delete next._onboardingVersion;
          settingsManager.save(next);
        } catch (_) {}
      }
      const html = renderOnboardingPage({
        sessionToken,
        savedProgress: readProgress(),
      });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Onboarding wizard render failed: ' + (e && e.message || e));
    }
  }

  async function handleSaveProgress(req, res) {
    try {
      const body: any = await parseJsonBody(req);
      writeProgress(body || {});
      jsonResponse(res, 200, { ok: true });
    } catch (e) {
      jsonResponse(res, 500, { ok: false, error: e.message });
    }
  }

  async function handleGetProgress(req, res) {
    jsonResponse(res, 200, { ok: true, progress: readProgress() });
  }

  async function handleValidate(req, res) {
    try {
      const body: any = await parseJsonBody(req);
      let errors: Array<{ field: string; code: string; message?: string }> = [];
      switch (body.step) {
        case 'companyProfile':
          errors = validator.validateCompanyProfile(body.companyProfile || {});
          break;
        case 'strengths':
          errors = validator.validateStrengths(body.strengths || []);
          break;
        case 'targetList':
          errors = validator.validateTargetList(body.targets);
          break;
        case 'aiAuth':
          errors = validator.validateAiAuth(body.authStatus, { bypassAi: !!body.bypassAi });
          break;
        case 'all':
          errors = validator.validateAll(body);
          break;
        default:
          errors = [{ field: 'step', code: 'unknown_step', message: 'unknown step: ' + body.step }];
      }
      jsonResponse(res, 200, { ok: errors.length === 0, errors });
    } catch (e) {
      jsonResponse(res, 500, { ok: false, error: e.message });
    }
  }

  async function handleImportTargets(req, res) {
    try {
      const body: any = await parseJsonBody(req);
      const fileName = body && body.fileName ? String(body.fileName) : '';
      const contentBase64 = body && body.contentBase64 ? String(body.contentBase64) : '';
      if (!fileName || !contentBase64) {
        jsonResponse(res, 400, { ok: false, error: 'fileName と contentBase64 が必要です' });
        return;
      }
      const ext = (path.extname(fileName).toLowerCase().replace('.', '')) || 'xlsx';
      if (!['xlsx', 'xls', 'csv'].includes(ext)) {
        jsonResponse(res, 400, { ok: false, error: '対応していないファイル形式: .' + ext });
        return;
      }
      const buffer = Buffer.from(contentBase64, 'base64');
      if (typeof importTargetList !== 'function') {
        jsonResponse(res, 500, { ok: false, error: 'ターゲットリスト取り込み機能を初期化できませんでした' });
        return;
      }

      const imported = importTargetList({ fileName, buffer });
      if (!imported || !imported.ok) {
        jsonResponse(res, 400, {
          ok: false,
          error: (imported && imported.error) || 'ターゲットリストの取り込みに失敗しました',
          warnings: (imported && imported.warnings) || [],
          totalDataRows: imported && imported.totalDataRows,
          detectedMapping: imported && imported.detectedMapping,
        });
        return;
      }
      if (typeof refreshWatchTargets === 'function') refreshWatchTargets();
      if (typeof notifyClients === 'function') {
        notifyClients({ type: 'update', reason: 'onboarding-target-list-imported', time: Date.now() });
      }

      const targetData = typeof readTargetList === 'function' ? readTargetList() : null;
      const targets = targetData && targetData.ok && Array.isArray(targetData.companies)
        ? targetData.companies.map((c: any) => ({
          no: c.no,
          name: c.companyName || c.name || '',
          companyName: c.companyName || c.name || '',
          type: c.type || '',
          url: c.url || '',
          formUrl: c.formUrl || '',
          status: c.status || '',
        }))
        : [];
      const progress = readProgress() || {};
      progress.targetListMeta = {
        fileName,
        count: imported.companyCount || targets.length,
        ext,
        filePath: imported.filePath || '',
      };
      writeProgress(progress);
      if (typeof notifyClients === 'function') {
        notifyClients({ type: 'target-list-validation-deferred', reason: 'onboarding-target-list-imported', time: Date.now() });
      }
      jsonResponse(res, 200, {
        ok: true,
        targets,
        fileName,
        count: imported.companyCount || targets.length,
        targetPath: imported.filePath || '',
        warnings: imported.warnings || [],
        totalDataRows: imported.totalDataRows,
        skippedRowCount: imported.skippedRowCount,
        detectedMapping: imported.detectedMapping,
      });
    } catch (e) {
      jsonResponse(res, 500, { ok: false, error: e.message });
    }
  }

  async function handleCheckAi(req, res, queryParams) {
    try {
      const provider = (queryParams && queryParams.get('provider')) || 'claude';
      const status: any = await probeClaudeAuthStatus(provider).catch((e) => ({ provider, error: e.message, installed: false, loggedIn: false }));
      jsonResponse(res, 200, { ok: true, status });
    } catch (e) {
      jsonResponse(res, 500, { ok: false, error: e.message });
    }
  }

  async function handleComplete(req, res) {
    try {
      const body: any = await parseJsonBody(req);
      // 最終検証
      const errors = validator.validateAll({
        companyProfile: body.companyProfile,
        valuePropositions: body.valuePropositions,
        targetList: body.targetList,
        aiAuthStatus: body.aiAuthStatus,
        bypassAi: body.bypassAi,
      });
      if (errors.length > 0) {
        jsonResponse(res, 400, { ok: false, errors });
        return;
      }

      // settings.json に書き込み (既存 settings をマージ)
      const current = settingsManager.getAll() || {};
      const next = JSON.parse(JSON.stringify(current));

      next.companyProfile = Object.assign({}, next.companyProfile || {}, body.companyProfile || {});
      next.valuePropositions = Object.assign({}, next.valuePropositions || {}, {
        strengths: (body.valuePropositions && body.valuePropositions.strengths) || next.valuePropositions?.strengths || [],
      });
      if (body.aiProvider) next.aiProvider = body.aiProvider;

      // marker
      next._onboardedAt = new Date().toISOString();
      next._onboardingVersion = 2;

      // ターゲットリストは /api/onboarding/import-targets で正規 importer が
      // canonical xlsx と targetList 設定を保存済み。ここで再保存すると .xlsx を
      // JSON で上書きし得るため、完了処理では触らない。
      //
      // 1.2.94 B3: defensive 検証 — settings.targetList.filePath が存在するか確認。
      // ファイルが消えてる場合 (ユーザーが手動削除等) は完了をブロックしない (skip 扱い)
      // が、診断イベントに記録して後追い可能にする。
      try {
        const tl = next.targetList || {};
        if (tl.filePath) {
          const path = require('path');
          const fs = require('fs');
          const absPath = path.isAbsolute(tl.filePath) ? tl.filePath : path.join(process.cwd(), tl.filePath);
          if (!fs.existsSync(absPath)) {
            if (typeof appendDiagnosticEvent === 'function') {
              appendDiagnosticEvent('onboarding_targetlist_file_missing_at_complete', {
                filePath: tl.filePath,
                resolved: absPath,
              });
            }
          }
        }
      } catch (_) {}

      settingsManager.save(next);
      clearProgress();
      if (typeof appendDiagnosticEvent === 'function') {
        appendDiagnosticEvent('onboarding_completed', {
          aiProvider: next.aiProvider,
          targetCount: Array.isArray(body.targetList) ? body.targetList.length : 0,
          bypassAi: !!body.bypassAi,
        });
      }
      jsonResponse(res, 200, { ok: true });
    } catch (e) {
      jsonResponse(res, 500, { ok: false, error: e.message });
    }
  }

  async function handleReset(req, res) {
    try {
      // settings load() の戻り値は deepFreeze 済 (cache 安全性のため)。
      // 直接 delete すると strict mode で throw → 500 になる。
      // JSON 経由で deep clone してから mutate する (handleComplete と同様)。
      const current = settingsManager.getAll() || {};
      const next = JSON.parse(JSON.stringify(current));
      delete next._onboardedAt;
      delete next._onboardingVersion;
      settingsManager.save(next);
      clearProgress();
      jsonResponse(res, 200, { ok: true });
    } catch (e) {
      jsonResponse(res, 500, { ok: false, error: e.message });
    }
  }

  // ---------- dispatch ----------

  /**
   * @returns {Promise<boolean>} handled なら true
   */
  return async function dispatch(req, res, pathname, queryParams) {
    const method = req.method;

    // GET /onboarding (top-level page) — ?fresh=1 で進捗を破棄して再実行
    if (pathname === '/onboarding' && method === 'GET') {
      await handleGetWizard(req, res, queryParams);
      return true;
    }
    if (pathname === '/api/onboarding/progress' && method === 'GET') {
      await handleGetProgress(req, res);
      return true;
    }
    if (pathname === '/api/onboarding/progress' && method === 'POST') {
      await handleSaveProgress(req, res);
      return true;
    }
    if (pathname === '/api/onboarding/validate' && method === 'POST') {
      await handleValidate(req, res);
      return true;
    }
    if (pathname === '/api/onboarding/import-targets' && method === 'POST') {
      await handleImportTargets(req, res);
      return true;
    }
    if (pathname === '/api/onboarding/check-ai' && method === 'GET') {
      await handleCheckAi(req, res, queryParams);
      return true;
    }
    if (pathname === '/api/onboarding/complete' && method === 'POST') {
      await handleComplete(req, res);
      return true;
    }
    if (pathname === '/api/onboarding/reset' && method === 'POST') {
      await handleReset(req, res);
      return true;
    }
    return false;
  };
};

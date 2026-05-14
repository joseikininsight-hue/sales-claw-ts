'use strict';

/**
 * Approve API Routes
 *
 * dashboard-server.cjs から切り出された /api/approve エンドポイント。
 * Phase 2 リファクタリングの一環として、モノリス化した dashboard-server.cjs から
 * 承認（送信済み / スキップ）系ハンドラを分離する。
 *
 * 対応エンドポイント:
 *  - POST /api/approve — 確認待ち → 送信済み / スキップ判定
 *
 * 既存の dashboard-server.cjs のロジックは変更せずそのまま移植している。
 * req.on('data') / req.on('end') の callback スタイルも維持している。
 */

const fs = require('fs');
const { logAction } = require('../action-logger');
const { recordContact, getHistory } = require('../contact-history');
const { assertApprovalArtifacts, getExpectedApprovalArtifacts, buildApprovalLogDetails } = require('../approval-artifacts');
const { finishLiveMonitor } = require('../live-monitor');
const { ensureDataDir, resolveDataPath } = require('../data-paths');

/**
 * Approve API ルーターを生成する factory。
 * dashboard-server.cjs から require して呼び、共有ユーティリティを ctx で注入する。
 *
 * @param {object} ctx - 依存注入
 * @param {function} ctx.getUiLang - () → 現在の UI 言語
 * @param {function} ctx.i18nT - (lang, key, params?) → 翻訳文字列
 * @param {function} ctx.appendDiagnosticEvent - (type, payload) → void
 * @param {function} ctx.getCompanyLogContext - (companyNo) → auditContext
 * @param {function} ctx.isAwaitingTransitionAllowed - (lastAction, decision) → boolean
 * @param {function} ctx.findRuntimeCompanyRecord - (companyNo) → runtimeRecord | null
 * @param {function} ctx.getKnownFormUrl - (companyNo, preferredUrl?, logs?) → string
 * @param {function} ctx.ensureSubmittedContactHistory - (...) → void
 * @param {function} ctx.stringifyLogDetails - (details) → string
 * @param {function} ctx.getLatestLog - (logs, action) → log | undefined
 * @param {function} ctx.updateCompany - (companyNo, patch) → void
 * @param {function} ctx.notifyClients - (payload?) → void
 * @param {function} ctx.ensureParentDir - (filePath) → void
 * @returns {function} dispatch(req, res, pathname) → Promise<boolean> (handled なら true)
 */
module.exports = function createApproveRoutes(ctx) {
  const {
    getUiLang,
    i18nT,
    appendDiagnosticEvent,
    getCompanyLogContext,
    isAwaitingTransitionAllowed,
    findRuntimeCompanyRecord,
    getKnownFormUrl,
    ensureSubmittedContactHistory,
    stringifyLogDetails,
    getLatestLog,
    updateCompany,
    notifyClients,
    ensureParentDir,
  } = ctx;

  // approve の body は JSON 1 KiB 以下を想定 (feedback ~2000 chars + 小さなメタ情報)
  const APPROVE_BODY_MAX_BYTES = 64 * 1024;

  async function handleApprove(req, res) {
    let body = '';
    let aborted = false;
    req.on('data', chunk => {
      if (aborted) return;
      body += chunk;
      if (body.length > APPROVE_BODY_MAX_BYTES) {
        aborted = true;
        try { req.destroy(); } catch (_) {}
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Request body too large' }));
      }
    });
    req.on('end', () => {
      if (aborted) return;
      try {
        const { companyNo, companyName, decision, feedback } = JSON.parse(body);
        const companyNoNum = Number(companyNo);
        const lang = getUiLang();
        const normalizedDecision = String(decision || '').trim();
        if (!Number.isFinite(companyNoNum) || !normalizedDecision) {
          appendDiagnosticEvent('approve_invalid_request', {
            companyNo,
            decision: normalizedDecision || '',
          });
          console.warn(`[approve] invalid request: companyNo=${companyNo} decision=${normalizedDecision || '-'}`);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: i18nT(lang, 'audit.invalidRequest') || 'companyNo and decision required' }));
          return;
        }
        const auditContext = getCompanyLogContext(companyNoNum);
        let approvalArtifacts: any = null;
        const allowInputOnlyApproval = !!(auditContext.screenshot && auditContext.screenshot.readyForManualApproval);
        if (normalizedDecision === 'sent' || normalizedDecision === 'skip') {
          if (!isAwaitingTransitionAllowed(auditContext.lastAction, normalizedDecision)) {
            appendDiagnosticEvent('approve_blocked_invalid_state', {
              companyNo: companyNoNum,
              companyName,
              decision: normalizedDecision,
              state: auditContext.lastAction || '',
            });
            console.warn(`[approve] blocked invalid state: companyNo=${companyNoNum} decision=${normalizedDecision} state=${auditContext.lastAction || '-'}`);
            res.writeHead(409, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              error: i18nT(lang, 'audit.blockedInvalidState', { state: auditContext.lastAction || '-' }),
            }));
            return;
          }
          if (normalizedDecision === 'sent') {
            try {
              approvalArtifacts = assertApprovalArtifacts(companyNoNum, {
                logs: auditContext.logs,
                formFillLog: auditContext.formFillLog,
                awaitingLog: auditContext.awaitingLog,
                confirmLog: auditContext.confirmLog,
                submittedLog: auditContext.submittedLog,
                allowInputOnly: allowInputOnlyApproval,
                message: i18nT(lang, 'audit.blockedMissingScreenshot'),
              });
            } catch (error) {
              appendDiagnosticEvent('approve_blocked_missing_screenshot', {
                companyNo: companyNoNum,
                companyName,
                decision: normalizedDecision,
                allowInputOnlyApproval,
                screenshotState: auditContext.screenshot ? auditContext.screenshot.auditState : '',
              });
              console.warn(`[approve] blocked missing screenshot: companyNo=${companyNoNum} decision=${normalizedDecision}`);
              res.writeHead(409, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: i18nT(lang, 'audit.blockedMissingScreenshot') }));
              return;
            }
          } else {
            approvalArtifacts = getExpectedApprovalArtifacts(companyNoNum, {
              logs: auditContext.logs,
              formFillLog: auditContext.formFillLog,
              awaitingLog: auditContext.awaitingLog,
              confirmLog: auditContext.confirmLog,
              submittedLog: auditContext.submittedLog,
            });
          }
        }
        if (normalizedDecision === 'sent') {
          const approvalScreenshot = approvalArtifacts
            ? (approvalArtifacts.actual.sent || approvalArtifacts.actual.confirm || approvalArtifacts.actual.input || approvalArtifacts.screenshots.sent || approvalArtifacts.screenshots.confirm || approvalArtifacts.screenshots.input)
            : null;
          logAction(companyNoNum, companyName, 'submitted', buildApprovalLogDetails({
            companyNo: companyNoNum,
            source: 'dashboard-approve',
            action: 'submitted',
            mode: 'manual',
            screenshot: approvalScreenshot,
            success: true,
            verified: true,
            detail: allowInputOnlyApproval ? 'ダッシュボードで手動送信完了を確認' : 'ダッシュボードで承認済み',
            approvalRequired: true,
          }));
          const draft = auditContext.allLogs.filter(l => String(l.companyNo) === String(companyNoNum) && l.action === 'message_draft').pop();
          const knownFormUrl = getKnownFormUrl(companyNoNum, findRuntimeCompanyRecord(companyNoNum)?.formUrl || '');
          ensureSubmittedContactHistory(
            companyNoNum,
            companyName,
            auditContext.submittedLog || getLatestLog(auditContext.logs || [], 'submitted') || { timestamp: new Date().toISOString() },
            knownFormUrl,
            draft ? stringifyLogDetails(draft.details) : '',
            getHistory(companyNoNum),
            {
              screenshot: approvalScreenshot || '',
              sourceAction: 'dashboard-approve',
              sourceActionAt: auditContext.submittedLog && auditContext.submittedLog.timestamp ? auditContext.submittedLog.timestamp : new Date().toISOString(),
              status: 'submitted',
              notes: allowInputOnlyApproval ? 'manual-approve-input-only' : 'manual-approve-confirmed',
            },
          );
          finishLiveMonitor(companyNoNum, {
            companyNo: companyNoNum,
            companyName,
            status: 'submitted',
            step: allowInputOnlyApproval ? 'ダッシュボードで手動送信完了を確認' : 'ダッシュボードで承認済み',
            currentUrl: knownFormUrl,
            formUrl: knownFormUrl,
            latestScreenshot: approvalScreenshot,
          });
          // 元のCSV/Excelに送信済みを書き戻す（失敗してもメイン処理に影響させない）
          try { updateCompany(companyNoNum, { progress: '送信済み' }); } catch (_) {}
        } else if (normalizedDecision === 'skip') {
          const reason = feedback ? 'Skip reason: ' + feedback : 'Skipped from dashboard';
          const approvalScreenshot = approvalArtifacts
            ? (approvalArtifacts.actual.confirm || approvalArtifacts.actual.input || approvalArtifacts.screenshots.confirm || approvalArtifacts.screenshots.input)
            : null;
          logAction(companyNoNum, companyName, 'skipped', buildApprovalLogDetails({
            companyNo: companyNoNum,
            source: 'dashboard-approve',
            action: 'skipped',
            mode: 'manual',
            screenshot: approvalScreenshot,
            success: true,
            verified: true,
            detail: 'ダッシュボードでスキップ',
            reason,
            approvalRequired: true,
          }));
          if (feedback) {
            ensureDataDir();
            const fbFile = resolveDataPath('skip-feedback.json');
            ensureParentDir(fbFile);
            let fbData: any[] = [];
            try { fbData = JSON.parse(fs.readFileSync(fbFile, 'utf-8')); } catch {}
            fbData.push({ date: new Date().toISOString(), companyNo: companyNoNum, companyName, feedback });
            fs.writeFileSync(fbFile, JSON.stringify(fbData, null, 2), 'utf-8');
          }
          finishLiveMonitor(companyNoNum, {
            companyNo: companyNoNum,
            companyName,
            status: 'skipped',
            step: 'ダッシュボードでスキップ',
            latestScreenshot: approvalScreenshot,
          });
          // 元のCSV/Excelにスキップを書き戻す
          try { updateCompany(companyNoNum, { progress: 'スキップ' }); } catch (_) {}
        } else {
          appendDiagnosticEvent('approve_invalid_decision', {
            companyNo: companyNoNum,
            companyName,
            decision: normalizedDecision,
          });
          console.warn(`[approve] invalid decision: companyNo=${companyNoNum} decision=${normalizedDecision}`);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: i18nT(lang, 'audit.invalidDecision') || 'decision must be "sent" or "skip"' }));
          return;
        }
        notifyClients();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        appendDiagnosticEvent('approve_internal_error', {
          error: e.message,
        });
        console.error(`[approve] internal error: ${e.message}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  }

  return async function dispatch(req, res, pathname) {
    if (pathname === '/api/approve' && req.method === 'POST') {
      await handleApprove(req, res);
      return true;
    }
    return false;
  };
};

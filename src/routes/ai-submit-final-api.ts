// AI Final Submit API (P2: 「AI に送信させる」ボタン用)
//
// 確認待ち (awaiting_approval) 状態の会社について、AI に「フォームを
// 再度 focus して submit ボタンをクリック → ss-{No}-sent.png 撮影 → submitted
// ログ記録」を実行させる。
//
//   POST /api/ai-submit-final  { companyNo, companyName }

import type { IncomingMessage, ServerResponse } from 'http';

export type JsonResponseFn = (res: ServerResponse, status: number, body: unknown) => void;
export type ParseJsonBodyFn = (req: IncomingMessage) => Promise<Record<string, unknown> | null>;

export interface CompanyRecord {
  no?: number | string;
  companyNo?: number | string;
  companyName?: string;
  name?: string;
  formUrl?: string;
  [key: string]: unknown;
}

export interface CompanyLogContext {
  lastAction?: string;
  knownFormUrl?: string;
  screenshot?: {
    captchaDetected?: boolean;
    manualReviewReason?: string;
  };
  [key: string]: unknown;
}

export interface AiSubmitFinalRouteContext {
  jsonResponse: JsonResponseFn;
  parseJsonBody: ParseJsonBodyFn;
  findCompaniesByNos: (nos: number[]) => { ok: boolean; companies?: CompanyRecord[] };
  getCompanyLogContext?: (companyNo: number) => CompanyLogContext | null;
  getClaudePty?: () => unknown;
  queueManagedAiPrompt: (prompt: string, provider: string) => { queueLength?: number };
  getSelectedAiProvider?: () => string;
  appendDiagnosticEvent?: (event: string, payload: Record<string, unknown>) => void;
  settingsManager?: {
    getSender?: () => { email?: string };
  };
}

export type AiSubmitFinalDispatcher = (req: IncomingMessage, res: ServerResponse, pathname: string) => Promise<boolean>;

function createAiSubmitFinalRoutes(ctx: AiSubmitFinalRouteContext): AiSubmitFinalDispatcher {
  const {
    jsonResponse,
    parseJsonBody,
    findCompaniesByNos,
    getCompanyLogContext,
    getClaudePty,
    queueManagedAiPrompt,
    getSelectedAiProvider,
    appendDiagnosticEvent,
    settingsManager,
  } = ctx;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const body = (await parseJsonBody(req)) ?? {};
      const companyNo = Number(body.companyNo);
      const companyName = String(body.companyName ?? '').trim();
      if (!Number.isFinite(companyNo) || companyNo <= 0) {
        jsonResponse(res, 400, { ok: false, error: 'companyNo is required' });
        return;
      }

      const found = findCompaniesByNos([companyNo]);
      if (!found || !found.ok || !Array.isArray(found.companies) || found.companies.length === 0) {
        jsonResponse(res, 404, { ok: false, error: 'company not found' });
        return;
      }
      const company = found.companies[0];
      const name = companyName || company.companyName || company.name || ('#' + companyNo);

      const ctxLog = getCompanyLogContext ? getCompanyLogContext(companyNo) : null;
      const lastAction = ctxLog?.lastAction ?? '';
      if (lastAction !== 'awaiting_approval') {
        jsonResponse(res, 409, {
          ok: false,
          error: '確認待ち (awaiting_approval) の会社にだけ AI 送信が使えます (現状: ' + lastAction + ')',
        });
        return;
      }
      const ssState = ctxLog?.screenshot;
      if (ssState && (ssState.captchaDetected || ssState.manualReviewReason === 'captcha')) {
        jsonResponse(res, 409, {
          ok: false,
          error: 'CAPTCHA / 認証が要求されているため AI に送信させられません。ブラウザで手動送信してください',
        });
        return;
      }

      const claudePty = typeof getClaudePty === 'function' ? getClaudePty() : null;
      if (!claudePty) {
        jsonResponse(res, 409, {
          ok: false,
          error: 'managed Claude が起動していません。先に「AI を起動」してから AI 送信を実行してください',
        });
        return;
      }

      const formUrl = company.formUrl ?? ctxLog?.knownFormUrl ?? '';
      const senderProfile = settingsManager?.getSender?.() ?? {};
      const senderEmail = senderProfile.email ?? '';
      const provider = String(body.provider ?? '') ||
        (typeof getSelectedAiProvider === 'function' ? getSelectedAiProvider() : 'claude');

      const prompt = [
        `=== AI 最終送信タスク (No.${companyNo} ${name}) ===`,
        '',
        '【背景】',
        `この会社 No.${companyNo} は確認待ち (awaiting_approval) で、フォーム入力済み + ${formUrl ? 'フォーム URL ' + formUrl : 'フォームタブ'} が保持されている前提です。`,
        '',
        '【手順 (必須)】',
        '1. browser_tabs で全タブを確認し、入力済みフォームのタブ (finalFormTab) を特定する。',
        '   - 既に閉じている場合は formUrl を再 navigate して入力をやり直す必要があるが、',
        '   - その時間がかかる場合は user 側で入力をやり直して欲しいので一旦 error ログを残して停止すること。',
        `2. browser_take_screenshot で送信前の最終確認スクリーンショットを撮影 (上書き ss-${companyNo}-confirm.png)。`,
        '3. 確認画面にある「送信」「Submit」「確定」「Send」ボタンを browser_click で押す。',
        '4. 送信完了画面 (ありがとう / Thank you / Complete / 完了 / 受け付けました 等) に到達したことを browser_snapshot で確認。',
        `5. browser_take_screenshot で完了画面のスクリーンショットを ss-${companyNo}-sent.png として保存。`,
        '',
        '【ログ記録】',
        '次の Node.js コマンドを bash で実行して submitted ログを必ず残す:',
        '```',
        `cd "${process.cwd().replace(/\\/g, '\\\\')}" && node -e "`,
        `const { logAction } = require('./src/action-logger');`,
        `logAction(${companyNo}, '${String(name).replace(/'/g, "\\'")}', 'submitted', JSON.stringify({ source: 'ai-final-submit', screenshot: 'ss-${companyNo}-sent.png', verified: true }));`,
        `console.log('submitted logged');`,
        '"',
        '```',
        '',
        '【失敗時】',
        '- 送信ボタンが見つからない / ページが応答しない → error ログを記録、タブを保持して停止。',
        senderEmail ? `- 送信完了画面の判定がつかない場合は ${senderEmail} で送信成功のメール返信を待つ前提で submitted-pending を記録 (CAPTCHA や reCAPTCHA は触らない)。` : '',
        '',
        '【注意】',
        '- 必ず該当タブだけを操作。他社のタブには触らない。',
        '- 完了したらこのタブも閉じて差し支えありません。',
      ].filter(Boolean).join('\n');

      const queueResult = queueManagedAiPrompt(prompt, provider);
      if (typeof appendDiagnosticEvent === 'function') {
        appendDiagnosticEvent('ai_final_submit_queued', {
          companyNo, name, provider,
          promptChars: prompt.length,
        });
      }

      jsonResponse(res, 202, {
        ok: true,
        queued: true,
        companyNo,
        companyName: name,
        provider,
        queueLength: queueResult?.queueLength ?? null,
        message: 'AI 送信タスクをキューしました。1〜3 分で完了します。ダッシュボードのライブモニタで進捗を確認してください。',
      });
    } catch (e: unknown) {
      jsonResponse(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return async function dispatch(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
    if (pathname === '/api/ai-submit-final' && req.method === 'POST') {
      await handle(req, res);
      return true;
    }
    return false;
  };
}

module.exports = createAiSubmitFinalRoutes;
export default createAiSubmitFinalRoutes;

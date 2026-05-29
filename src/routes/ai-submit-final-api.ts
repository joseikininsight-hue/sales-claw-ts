// AI Final Submit API (P2: 「AI に送信させる」ボタン用)
//
// 確認待ち (awaiting_approval) 状態の会社について、AI に最終送信を実行させる。
//
// v2.0.96 全面改修:
//   - 完了セッションは自動破棄されるようになった (form-session-manager) ため、
//     送信時はライブセッションに依存せず formUrl から **セッションを再生成 +
//     承認済み本文を再入力 + submit** する。アプリ再起動/セッション退避後でも動く。
//   - managed PTY が idle watchdog で落ちていても ensureManagedAiReadyForPrompt で
//     自動再起動してから queue する (旧: 409 で即拒否)。
//   - プロンプトを内蔵 MCP の sessionId 契約に書き換え、ログ記録を
//     curl POST /api/log-action (sentMessage 必須) に修正 (旧: 廃止済み node -e)。
//   - formUrl 解決を getKnownFormUrl に統一 (旧: 常に undefined の knownFormUrl 参照)。
//
//   POST /api/ai-submit-final  { companyNo, companyName }

import type { IncomingMessage, ServerResponse } from 'http';
import { randomUUID } from 'crypto';

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

export interface LogEntry {
  action?: string;
  details?: unknown;
  [key: string]: unknown;
}

export interface CompanyLogContext {
  lastAction?: string;
  logs?: LogEntry[];
  awaitingLog?: LogEntry | null;
  screenshot?: {
    captchaDetected?: boolean;
    manualReviewReason?: string;
  };
  [key: string]: unknown;
}

export interface EnsureReadyResult {
  ok: boolean;
  statusCode?: number;
  error?: string;
  relaunched?: boolean;
  alreadyRunning?: boolean;
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
  getKnownFormUrl?: (companyNo: number, preferredUrl?: string, logs?: LogEntry[]) => string;
  ensureManagedAiReadyForPrompt?: (provider: string) => Promise<EnsureReadyResult>;
}

export type AiSubmitFinalDispatcher = (req: IncomingMessage, res: ServerResponse, pathname: string) => Promise<boolean>;

// awaiting_approval ログ details から、実際にフォームへ入力した本文を取り出す。
// 1.2.100+ は details がオブジェクトで sentMessage を持つ。旧ログは文字列のことも。
function extractSentMessage(awaitingLog: LogEntry | null | undefined): string {
  if (!awaitingLog) return '';
  const d = awaitingLog.details;
  if (d == null) return '';
  if (typeof d === 'string') {
    try {
      const o = JSON.parse(d);
      if (o && typeof o === 'object') {
        return String(o.sentMessage || o.actualBody || o.body || o.message || '');
      }
    } catch { /* プレーン文字列 body */ }
    return d;
  }
  if (typeof d === 'object') {
    const o = d as Record<string, unknown>;
    return String(o.sentMessage || o.actualBody || o.body || o.message || '');
  }
  return '';
}

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
    getKnownFormUrl,
    ensureManagedAiReadyForPrompt,
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

      // 承認済み本文 (awaiting_approval で実際に入力した本文) を再入力に使う。
      const sentMessage = extractSentMessage(ctxLog?.awaitingLog);
      if (!sentMessage || sentMessage.trim().length < 10) {
        jsonResponse(res, 409, {
          ok: false,
          error: '承認済みの送信本文 (sentMessage) がログに見つかりません。お手数ですが該当社をもう一度フォーム入力し直してください。',
        });
        return;
      }

      // formUrl 解決 (company.formUrl → 過去ログの確定 formUrl)。
      const formUrl = typeof getKnownFormUrl === 'function'
        ? getKnownFormUrl(companyNo, company.formUrl || '', ctxLog?.logs || [])
        : (company.formUrl || '');

      const provider = String(body.provider ?? '') ||
        (typeof getSelectedAiProvider === 'function' ? getSelectedAiProvider() : 'claude');

      // managed PTY が落ちていたら自動再起動してから queue する。
      let readiness: EnsureReadyResult = { ok: true };
      const claudePty = typeof getClaudePty === 'function' ? getClaudePty() : null;
      if (!claudePty) {
        if (typeof ensureManagedAiReadyForPrompt === 'function') {
          readiness = await ensureManagedAiReadyForPrompt(provider);
        } else {
          readiness = { ok: false, statusCode: 409, error: 'managed Claude が起動していません。先に「AI を起動」してください。' };
        }
        if (!readiness.ok) {
          jsonResponse(res, readiness.statusCode || 409, { ok: false, error: readiness.error || 'AI セッションを準備できませんでした' });
          return;
        }
      }

      // プロンプト構造への注入を防ぐ: 改行・セクション見出し記号・バッククォートを除去。
      const escName = String(name)
        .replace(/[\r\n]+/g, ' ')
        .replace(/[【】`]/g, '')
        .replace(/'/g, '’')
        .slice(0, 80)
        .trim() || ('#' + companyNo);
      // 本文セクションは推測不能なランダム区切りで囲み、本文側に同一区切りが
      // 紛れても無効化する (prompt injection 対策 — security-reviewer MED 指摘)。
      const bodyDelim = '----BODY-' + randomUUID() + '----';
      const safeBody = sentMessage.split(bodyDelim).join('');
      const navStep = formUrl
        ? `1. browser_navigate({ url: ${JSON.stringify(formUrl)}, companyNo: ${companyNo} }) で送信対象フォームを開く (返り値の sessionId を以後の全 browser_* 呼び出しで使う)。`
        : `1. formUrl が不明。WebSearch で「${escName} 公式 お問い合わせ」を検索し公式ドメインの問い合わせフォームを特定 → browser_navigate({ url: <フォームURL>, companyNo: ${companyNo} }) で開く (返り値の sessionId を以後使う)。`;

      const prompt = [
        `=== AI 最終送信タスク (No.${companyNo} ${escName}) ===`,
        '',
        '【背景】',
        `この会社 No.${companyNo} は確認待ち (awaiting_approval) です。フォームセッションは既に破棄されているため、`,
        'formUrl からセッションを再生成し、承認済みの本文を再入力してから送信してください。',
        '本文は人間が承認済みなので、再生成せず下記の【送信本文】をそのまま使うこと。',
        '',
        '【送信本文 (下記 2 本の区切り行の間の文字列をそのまま本文フィールドへ入力)】',
        bodyDelim,
        safeBody,
        bodyDelim,
        '',
        '【手順 (内蔵 MCP / 必須)】',
        navStep,
        '2. browser_snapshot({ sessionId }) でフォーム構造を取得。',
        '3. 送信者情報を dist-ts/src/settings-manager (getSender / getStrengths 等) から読み、',
        '   会社名 / 担当者名 / メール / 電話 + 上記【送信本文】を browser_fill_form({ sessionId, mappings }) で再入力する。',
        '   - 設定に存在しない項目は推測しない。必須は 会社名/担当者名/メール/電話/本文。',
        `4. browser_take_screenshot({ sessionId, suffix: 'confirm' }) で送信前確認を撮影 (ss-${companyNo}-confirm.png)。`,
        '5. 「送信」「確認画面へ」「Submit」「確定」「Send」等のボタンを browser_click({ sessionId, ... }) で押す。',
        '   - 確認画面が出たら最終「送信」までクリックする。CAPTCHA/reCAPTCHA 画像課題が出たら触らず error ログを残して停止。',
        '6. 送信完了画面 (ありがとう / Thank you / Complete / 完了 / 受け付けました 等) を browser_snapshot({ sessionId }) で確認。',
        `7. browser_take_screenshot({ sessionId, suffix: 'sent' }) で完了画面を ss-${companyNo}-sent.png として保存。`,
        '',
        '【ログ記録 (必須・curl のみ。node -e は禁止)】',
        '送信完了を確認したら以下で submitted を記録する。details.sentMessage は上記【送信本文】と同一にすること:',
        '```bash',
        `curl -s -X POST -H "Content-Type: application/json" -H "x-sales-claw-session: $SALES_CLAW_SESSION" \\`,
        `  -d '{"no":${companyNo},"name":${JSON.stringify(escName)},"action":"submitted","details":{"sentMessage":"<上記の送信本文をそのまま>","screenshot":"ss-${companyNo}-sent.png","source":"ai-final-submit"}}' \\`,
        `  "\${SALES_CLAW_DASHBOARD_URL:-http://127.0.0.1:3765}/api/log-action"`,
        '```',
        '- 日本語が `?` に化ける場合は、本文を Write tool で UTF-8 ファイルに書き、details から sentMessage を外して "sentMessageFile":"<絶対パス>" を渡す。',
        '',
        '【失敗時】',
        '- 送信ボタンが見つからない / ページが応答しない / フォーム再構築不能 → action:"error" を curl /api/log-action で記録して停止。',
        '- CAPTCHA / reCAPTCHA 画像課題 → 触らず action:"error"(details.reason に captcha) を記録して停止。',
        '',
        '【注意】',
        '- 1 社分のみ。この sessionId 以外のセッションには触らない。',
        '- 完了後はセッションを閉じて差し支えない。',
      ].filter(Boolean).join('\n');

      const queueResult = queueManagedAiPrompt(prompt, provider);
      if (typeof appendDiagnosticEvent === 'function') {
        appendDiagnosticEvent('ai_final_submit_queued', {
          companyNo,
          name,
          provider,
          promptChars: prompt.length,
          hasFormUrl: !!formUrl,
          sentMessageChars: sentMessage.length,
          relaunched: !!readiness.relaunched,
        });
      }

      jsonResponse(res, 202, {
        ok: true,
        queued: true,
        companyNo,
        companyName: name,
        provider,
        relaunched: !!readiness.relaunched,
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

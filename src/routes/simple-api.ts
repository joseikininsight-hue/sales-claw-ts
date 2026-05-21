'use strict';

/**
 * Simple API Routes
 *
 * dashboard-server.cjs から切り出された軽量 API ハンドラ群。
 * Phase 2 リファクタリングの一環として、モノリス化した dashboard-server.cjs から
 * シンプルなエンドポイントをまとめる。
 *
 * 対応エンドポイント:
 *  - POST /api/cli-log              — CLI からの外部ログ受信 (SSE push)
 *  - POST /api/check-update         — 自動更新の即時チェックフラグ書き出し
 *  - POST /api/install-update       — 自動更新インストールフラグ書き出し
 *  - GET  /api/update-status        — 更新ステータス返却 (electron-main が書き込んだ JSON を読む)
 *  - GET  /api/export               — action-log / companies の Excel export
 *  - GET  /api/data                 — ダッシュボードデータ (loadData 結果) を返す
 *  - GET  /api/claude-status        — AI プロバイダ状態 (エイリアス)
 *  - GET  /api/ai/status            — AI プロバイダ状態
 *  - GET  /api/ai/setup-diagnostics — セットアップ診断情報
 *  - POST /api/ai-submit            — 410 Gone (直接 JS 送信廃止)
 *  - GET  /api/ai-submit-status     — 410 Gone (直接 JS 送信ステータス廃止)
 *
 * 既存の dashboard-server.cjs のロジックは変更せずそのまま移植している。
 */

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const settings = require('../settings-manager');
const { ensureDataDir, resolveDataPath } = require('../data-paths');
const { getAllLogs, logAction } = require('../action-logger');
const { recordContact } = require('../contact-history');
const costEstimator = require('../cost-estimator');

function csvCell(value) {
  let s = value == null ? '' : (typeof value === 'object' ? JSON.stringify(value) : String(value));
  // Excel formula injection guard. Keep the visible value, but force text.
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function normalizeValidationTargets(data) {
  return ((data && data.companies) || [])
    .map((c: any) => ({
      no: c.no,
      name: c.name || c.companyName || '',
      url: c.url || '',
      formUrl: c.formUrl || '',
    }))
    .filter((c: any) => c.name);
}

function getTargetValidationState() {
  if (!global.__SC_TLV_STATE || typeof global.__SC_TLV_STATE !== 'object') {
    global.__SC_TLV_STATE = {
      running: false,
      startedAt: null,
      finishedAt: null,
      done: 0,
      total: 0,
      error: null,
    };
  }
  return global.__SC_TLV_STATE;
}

/**
 * Simple API ルーターを生成する factory。
 * dashboard-server.cjs から require して呼び、共有ユーティリティを ctx で注入する。
 *
 * @param {object} ctx - 依存注入
 * @param {function} ctx.jsonResponse - (res, statusCode, data, extraHeaders?) を書き込む
 * @param {function} ctx.parseJsonBody - (req) → Promise<object> (現状未使用だが将来用に受け取る)
 * @param {function} ctx.loadData - () → { companies, recentLogs, ... }
 * @param {Set} ctx.sseClients - SSE 接続中の res オブジェクトセット (cli-log の push 先)
 * @param {function} ctx.probeClaudeStatus - (providerId) → Promise<status>
 * @param {function} ctx.probeAiSetupDiagnostics - (providerId) → Promise<diagnostics>
 * @param {function} ctx.getSelectedAiProvider - () → string (現在選択中プロバイダID)
 * @param {function} ctx.ensureParentDir - (filePath) 親ディレクトリを作る
 * @param {boolean}  ctx.AUTO_UPDATE_ENABLED - 自動更新が有効か
 * @param {string}   ctx.APP_BUILD_SOURCE - 'development' | 'dashboard-only' | 'packaged' など
 * @param {string}   ctx.APP_VERSION - アプリバージョン文字列
 * @returns {function} dispatch(req, res, pathname, requestUrl) → Promise<boolean> (handled なら true)
 */
module.exports = function createSimpleApiRoutes(ctx) {
  const {
    jsonResponse,
    loadData,
    sseClients,
    probeClaudeStatus,
    probeAiSetupDiagnostics,
    getSelectedAiProvider,
    ensureParentDir,
    AUTO_UPDATE_ENABLED,
    APP_BUILD_SOURCE,
    APP_VERSION,
  } = ctx;

  function broadcastSse(payload) {
    try {
      const message = 'data: ' + JSON.stringify(payload) + '\n\n';
      sseClients.forEach((client: any) => {
        try { client.write(message); } catch (_) {}
      });
    } catch (_) {}
  }

  function parseDetailsMaybe(details) {
    if (details && typeof details === 'object') return details;
    if (typeof details !== 'string') return {};
    const trimmed = details.trim();
    if (!trimmed) return {};
    try {
      const parsed = JSON.parse(trimmed);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_) {
      return {};
    }
  }

  function getLogsForCompany(no) {
    try {
      return getAllLogs().filter((log: any) => String(log.companyNo) === String(no));
    } catch (_) {
      return [];
    }
  }

  function extractSiteAnalysisPayload(log) {
    const parsed = parseDetailsMaybe(log && log.details);
    if (parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0) return parsed;
    return null;
  }

  function validateTerminalActionPrerequisites(no) {
    const logs = getLogsForCompany(no);
    const hasFormFill = logs.some((log: any) => log.action === 'form_fill');
    const hasConfirmReached = logs.some((log: any) => log.action === 'confirm_reached');
    if (!hasFormFill) {
      return {
        ok: false,
        error: 'form_fill log is required before awaiting_approval/submitted.',
        hint: 'フォームに実入力してから form_fill を記録し、その後スクリーンショット撮影を完了してください。',
      };
    }
    if (!hasConfirmReached) {
      return {
        ok: false,
        error: 'confirm_reached log is required before awaiting_approval/submitted.',
        hint: 'ss-{No}-input.png 撮影後に confirm_reached を記録してから awaiting_approval/submitted にしてください。',
      };
    }

    const siteLogs = logs
      .filter((log: any) => log.action === 'site_analysis')
      .map((log: any) => ({ log, analysis: extractSiteAnalysisPayload(log) }))
      .filter((entry: any) => entry.analysis);
    const latest = siteLogs[siteLogs.length - 1];
    const idealCustomer = settings.getIdealCustomer ? settings.getIdealCustomer() : null;
    const minSiteTextLength = idealCustomer && Number.isFinite(Number(idealCustomer.minSiteTextLength))
      ? Math.max(0, Math.floor(Number(idealCustomer.minSiteTextLength)))
      : 800;
    // v2.0.56: form_fill + confirm_reached がそろえば site_analysis ログが
    //   無くても awaiting_approval を許可する。
    //   旧仕様: site_analysis が必須 → Phase A をスキップした社 / Phase A 結果が
    //          古くて action-log から消失した社 (再起動・log rotation 等) で、
    //          Claude が MCP Playwright で実際にフォーム入力 + 確認画面到達まで
    //          成功させたにもかかわらず error 化される事故が頻発していた
    //          (実機ログで No.84, 86 などで「フォーム入力済み・確認ページ到達済み。
    //           ただし API が site_analysis を要求」と error 化を確認)。
    //   新仕様: form_fill + confirm_reached の両方がある = Phase B で
    //          MCP Playwright でサイト確認 → フォーム入力 → 確認画面到達まで
    //          成功した証拠なので、site_analysis 無しでも通過させる。
    //          sentMessage 品質は次の validateSentMessageQuality で別途検査される。
    const filledAndReached = hasFormFill && hasConfirmReached;
    if (!latest) {
      if (filledAndReached) {
        return { ok: true };
      }
      return {
        ok: false,
        error: 'site_analysis log is required before awaiting_approval/submitted.',
        hint: '企業サイト本文を取得・分析し、site_analysis を記録してからフォーム入力してください。',
      };
    }
    const analysis = latest.analysis;
    const siteTextLength = Number(analysis.siteTextLength) || 0;
    // urlMissing=true の場合でも form_fill + confirm_reached 記録済みであれば
    // Phase B で CLI が WebSearch を通じて公式サイトを特定・入力したとみなして通過させる。
    const isUrlMissingButFilled = analysis.urlMissing === true && hasFormFill;
    if (!isUrlMissingButFilled && !filledAndReached && siteTextLength < minSiteTextLength) {
      return {
        ok: false,
        error: `site_analysis is insufficient (${siteTextLength} chars; required ${minSiteTextLength}).`,
        hint: 'サイト取得失敗の会社はフォーム入力せず error/skipped にしてください。本文推測で awaiting_approval/submitted にはできません。',
      };
    }
    return { ok: true };
  }

  function validateSentMessageQuality(sentMsg) {
    try {
      const messageQualityGate = require('../message-quality-gate');
      const profile = settings.getSection('companyProfile') || {};
      const sender = settings.getSender ? settings.getSender() : {};
      const templates = settings.getSection('messageTemplates') || {};
      const style = {
        ...((settings.getMessageStyle && settings.getMessageStyle()) || {}),
        cta: templates.cta || '',
        signatureTemplate: templates.signatureTemplate || '',
      };
      const ownContext = {
        ...sender,
        contactName: sender.name || profile.contactName || '',
        companyName: sender.companyName || profile.companyName || '',
        companyProfile: profile,
      };
      const result = messageQualityGate.evaluate({
        message: sentMsg,
        ownContext,
        idealCustomer: settings.getIdealCustomer ? settings.getIdealCustomer() : null,
        style,
      });
      if (!result.ok) {
        return {
          ok: false,
          error: 'sentMessage failed message quality gate: ' + result.reason,
          hint: '設定値と矛盾する社員数・設立年・資本金などを修正し、実フォーム本文を再生成してください。',
          qualityCheck: result,
        };
      }
      return { ok: true, qualityCheck: result };
    } catch (e) {
      return {
        ok: false,
        error: 'sentMessage quality gate failed to run: ' + (e && e.message || e),
        hint: '品質ゲートを実行できなかったため安全側で拒否しました。',
      };
    }
  }

  // ---------- 各ハンドラ関数 ----------

  // POST /api/ai-submit — 410 Gone
  async function handleAiSubmit(_req, res) {
    jsonResponse(res, 410, {
      ok: false,
      error: 'Direct JS AI submission has been removed. Submit manually from the preserved browser tab.',
    });
  }

  // GET /api/ai-submit-status — 410 Gone
  async function handleAiSubmitStatus(_req, res) {
    jsonResponse(res, 410, {
      ok: false,
      error: 'Direct JS AI submission status has been removed.',
    });
  }

  // POST /api/resend-prepare — 「編集して再送」用エンドポイント
  // body: { no, name, message, formUrl? }
  // 効果: 編集された本文で message_draft → resend_requested ログを追加し、
  //       contact-history に resend_pending として記録する。
  //       実際のフォーム入力 + input スクショが完了するまでは確認待ちに戻さない。
  async function handleResendPrepare(req, res) {
    const MAX = 96 * 1024; // 本文の長さに余裕を持たせる
    let body = '';
    let overflow = false;
    req.on('data', chunk => {
      body += chunk;
      if (body.length > MAX) {
        overflow = true;
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Payload too large' }));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (overflow) return;
      try {
        const parsed = JSON.parse(body || '{}');
        const companyNo = parseInt(parsed.no, 10);
        const name = String(parsed.name || '').trim();
        const message = typeof parsed.message === 'string' ? parsed.message : '';
        const formUrl = typeof parsed.formUrl === 'string' ? parsed.formUrl.trim() : '';

        if (!companyNo || !Number.isFinite(companyNo) || companyNo <= 0) {
          jsonResponse(res, 400, { ok: false, error: 'Invalid company number' });
          return;
        }
        if (!name) {
          jsonResponse(res, 400, { ok: false, error: 'Company name is required' });
          return;
        }
        if (!message.trim()) {
          jsonResponse(res, 400, { ok: false, error: 'Message body is required' });
          return;
        }
        if (message.length > 32 * 1024) {
          jsonResponse(res, 400, { ok: false, error: 'Message body too large (>32KB)' });
          return;
        }

        // 1) 編集後本文を新しい message_draft として記録
        logAction(companyNo, name, 'message_draft', message);

        // 2) 再送依頼を監査ログとして記録する。
        //    フォーム入力 + ss-{No}-input.png なしで awaiting_approval には戻さない。
        const note = '再送依頼: 編集後の本文を記録。AIフォーム入力の再実行待ち';
        logAction(companyNo, name, 'resend_requested', note);

        // 3) 連絡履歴に「再送リクエスト」として追記 (実送信は次の AI セッションで行う想定)
        let contactNo: any = null;
        try {
          contactNo = recordContact(companyNo, name, {
            message,
            formUrl,
            method: 'web_form',
            status: 'resend_pending',
            sourceAction: 'resend_request',
            sourceActionAt: new Date().toISOString(),
            response: null,
            notes: '編集して再送 (UI から要求)',
          });
        } catch (e) {
          // 履歴書き込みに失敗しても action-log は残っているので致命ではない
          console.warn('[resend-prepare] recordContact failed:', e && e.message);
        }

        jsonResponse(res, 200, {
          ok: true,
          no: companyNo,
          contactNo,
          message: '再送下書きを記録しました。AIフォーム入力を再実行すると確認待ちに戻ります。',
        });
      } catch (e) {
        jsonResponse(res, 400, { ok: false, error: e.message });
      }
    });
  }

  // POST /api/cli-log — CLI からのログを SSE で push
  // 1.2.91 セキュリティ修正: Phase B prompt の logAction shell command (node -e) は
  // 会社名を文字列リテラル展開する設計でシェル/プロンプトインジェクション RCE を許す。
  // 専用 API endpoint で安全に受け、サーバー側で sanitize してから logAction を呼ぶ。
  async function handleLogAction(req, res) {
    const ALLOWED_ACTIONS = new Set(['awaiting_approval', 'submitted', 'skipped', 'error', 'confirm_reached', 'form_fill']);
    const MAX_NAME_LEN = 200;
    const MAX_DETAILS_LEN = 4000;
    let body = '';
    let bodyOverflow = false;
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 16 * 1024) {
        bodyOverflow = true;
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Payload too large' }));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (bodyOverflow) return;
      try {
        const data = JSON.parse(body);
        const no = Number(data.no);
        if (!Number.isFinite(no) || no <= 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Invalid no' }));
          return;
        }
        const action = String(data.action || '').trim();
        if (!ALLOWED_ACTIONS.has(action)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Invalid action. Allowed: ' + [...ALLOWED_ACTIONS].join(',') }));
          return;
        }
        // サニタイズ: 会社名・details は最大長で truncate。Control char (0x00-0x1f) を除去。
        const name = String(data.name || '').slice(0, MAX_NAME_LEN).replace(/[\x00-\x1f\x7f]/g, ' ');
        const detailsRaw = data.details;
        let details;
        if (typeof detailsRaw === 'string') {
          details = detailsRaw.slice(0, MAX_DETAILS_LEN).replace(/[\x00-\x1f\x7f]/g, ' ');
        } else if (detailsRaw && typeof detailsRaw === 'object') {
          // オブジェクトはそのまま JSON.stringify で渡す (action-logger 側で stringify)
          // 中身の文字列値もサニタイズ
          const sanitize = (val) => {
            if (typeof val === 'string') return val.slice(0, MAX_DETAILS_LEN).replace(/[\x00-\x1f\x7f]/g, ' ');
            if (Array.isArray(val)) return val.map(sanitize);
            if (val && typeof val === 'object') {
              const out: Record<string, any> = {};
              for (const k of Object.keys(val)) out[k] = sanitize(val[k]);
              return out;
            }
            return val;
          };
          details = JSON.stringify(sanitize(detailsRaw)).slice(0, MAX_DETAILS_LEN);
        } else {
          details = '';
        }
        // 1.2.98: スクショ無し submitted/awaiting_approval ガード
        // ユーザはダッシュボードのスクショで送信内容を判定する。スクショ無しで
        // submitted/awaiting_approval を書かれると、過去の送信内容が確認できない。
        // details に screenshot プロパティが無い、または指す PNG が存在しないなら拒否。
        if (action === 'submitted' || action === 'awaiting_approval') {
          let shotPath: any = null;
          if (typeof detailsRaw === 'object' && detailsRaw && typeof detailsRaw.screenshot === 'string') {
            shotPath = detailsRaw.screenshot.trim();
          } else if (typeof detailsRaw === 'string') {
            const m = detailsRaw.match(/ss-\d+-(?:input|sent|confirm)\.png/);
            if (m) shotPath = m[0];
          }
          if (!shotPath) {
            res.writeHead(422, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              ok: false,
              error: 'Screenshot is required for ' + action + '. details.screenshot must point to ss-' + no + '-{input|sent|confirm}.png.',
              hint: 'browser_take_screenshot で screenshots/ss-' + no + '-input.png (awaiting) または ss-' + no + '-sent.png (submitted) を撮影してから logAction を呼んでください。',
            }));
            return;
          }
          const shotDir = settings.getScreenshotDir ? settings.getScreenshotDir() : path.join(process.cwd(), 'screenshots');
          const shotAbs = path.isAbsolute(shotPath) ? shotPath : path.join(shotDir, path.basename(shotPath));
          if (!fs.existsSync(shotAbs)) {
            res.writeHead(422, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              ok: false,
              error: 'Screenshot file does not exist: ' + shotAbs,
              hint: 'スクリーンショットを screenshots/ ディレクトリへ保存してから logAction を呼んでください。',
            }));
            return;
          }
        }
        // 1.2.100: details.sentMessage 必須化
        // CLI が実際にフォーム入力した本文を必ずログに記録させる。
        // これが無いとダッシュボードは Phase A の templateDraft を表示してしまい、
        // 「ダッシュボード表示 ≠ 実送信内容」事故が起きる (NEC ネクサ事案で発覚)。
        let sentMsg = '';
        if (action === 'submitted' || action === 'awaiting_approval') {
          if (typeof detailsRaw === 'object' && detailsRaw) {
            const cands = [detailsRaw.sentMessage, detailsRaw.actualBody, detailsRaw.body, detailsRaw.message];
            for (const c of cands) {
              if (typeof c === 'string' && c.trim().length > 0) { sentMsg = c.trim(); break; }
            }
            // v2.0.58: ファイル経由で sentMessage を渡す経路を追加。
            //   背景: curl の -d 引数で複数行 JSON を escape するのが鬼門で、
            //   Claude が \n/quote/特殊文字を含む長文 sentMessage を渡すと
            //   shell escape ミスで本文末尾が truncate される事故が頻発した。
            //   解決: 本文をファイルに書いて curl では path だけ渡す。
            //   サーバ側で fs.readFileSync して sentMsg に格納する。
            //   パストラバーサル防止: 絶対パス + 既知の安全ディレクトリ配下のみ許可。
            const filePath = typeof detailsRaw.sentMessageFile === 'string' && detailsRaw.sentMessageFile.trim()
              ? detailsRaw.sentMessageFile.trim()
              : (typeof detailsRaw.bodyFile === 'string' ? detailsRaw.bodyFile.trim() : '');
            if (!sentMsg && filePath) {
              try {
                const fs = require('fs');
                const path = require('path');
                const absPath = path.resolve(filePath);
                // 安全ディレクトリ確認: data 配下 / tmp 配下のみ許可
                let dataDir = '';
                try {
                  // eslint-disable-next-line @typescript-eslint/no-require-imports
                  const dp = require('../data-paths');
                  if (typeof dp.resolveDataPath === 'function') dataDir = path.resolve(dp.resolveDataPath(''));
                } catch (_) { /* dataDir empty - tempDir only */ }
                const tempDir = path.resolve(require('os').tmpdir());
                const userDataDir = process.env.SALES_CLAW_USER_DATA_DIR ? path.resolve(process.env.SALES_CLAW_USER_DATA_DIR) : '';
                const safeRoots = [dataDir, tempDir, userDataDir].filter(Boolean);
                const isSafe = safeRoots.some((root: any) => absPath.startsWith(root + path.sep) || absPath === root);
                if (!isSafe) {
                  res.writeHead(422, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({
                    ok: false,
                    error: 'sentMessageFile must reside under sales-claw data dir or system temp dir.',
                    hint: 'BOM 無し UTF-8 で os.tmpdir() (Windows: %TEMP%, Linux: /tmp) に書き出してから path を渡してください。',
                  }));
                  return;
                }
                if (fs.statSync(absPath).size > 64 * 1024) {
                  res.writeHead(422, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({
                    ok: false,
                    error: 'sentMessageFile too large (>64KB).',
                  }));
                  return;
                }
                const raw = fs.readFileSync(absPath, 'utf8');
                // BOM 除去
                sentMsg = raw.replace(/^﻿/, '').trim();
              } catch (e: any) {
                res.writeHead(422, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                  ok: false,
                  error: 'sentMessageFile read failed: ' + (e && e.message || e),
                  hint: 'ファイルが存在し、サーバから読める permission か確認してください。BOM 無し UTF-8 推奨。',
                }));
                return;
              }
            }
          }
          if (!sentMsg) {
            res.writeHead(422, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              ok: false,
              error: 'details.sentMessage is required for ' + action + ' (実フォームに入力した本文をそのまま渡してください).',
              hint: 'curl -d \'{"no":' + no + ',"name":"...","action":"' + action + '","details":{"sentMessage":"<実際にフォームに入力したお問い合わせ本文>","screenshot":"ss-' + no + '-input.png"}}\' のように details.sentMessage を必ず含めてください。Phase A の templateDraft ではなく、CLI が WebSearch 後に最終化した本文を使ってください。',
            }));
            return;
          }
          // v2.0.57: 30 文字下限を 10 文字に緩和。
          //   旧仕様 (30 chars): Claude が curl の -d 引数で複数行 JSON を渡す際に
          //     shell escape ミスで本文末尾が truncate されて 30 chars 未満 → 422
          //     → リトライループ → dispatcher 進まず → ユーザーが「3 社しか処理さ
          //     れない」と感じる事故が頻発 (実機 PTY ログで「メッセージが短すぎる
          //     エラーでした。正しい本文をファイルに書いて curl で送信します」を
          //     2026-05-21 08:00 周辺で 10 回以上観測)。
          //   新仕様 (10 chars): TEL/MAIL ダンプだけの縮退本文 (例: 「TEL:090...」)
          //     は依然弾けるが、一般的な署名 + 本文短縮ケースは通過させる。
          //     既に placeholder 検出 / quality gate が後段で別途バリデーション
          //     しているため安全性は維持。
          if (sentMsg.length < 10) {
            res.writeHead(422, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              ok: false,
              error: 'details.sentMessage too short (' + sentMsg.length + ' chars). 10 文字以上の実本文を渡してください。',
              hint: 'TEL/MAIL のダンプだけのような縮退本文は不可。companyProfile + valuePropositions を活用した本文を生成してください。',
            }));
            return;
          }
        }
        if (action === 'submitted' || action === 'awaiting_approval') {
          const prerequisite = validateTerminalActionPrerequisites(no);
          if (!prerequisite.ok) {
            res.writeHead(422, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              ok: false,
              error: prerequisite.error,
              hint: prerequisite.hint,
            }));
            return;
          }
          const quality = validateSentMessageQuality(sentMsg);
          if (!quality.ok) {
            res.writeHead(422, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              ok: false,
              error: quality.error,
              hint: quality.hint,
              qualityCheck: quality.qualityCheck,
            }));
            return;
          }
        }
        // 1.2.98: 未確定 placeholder 本文の誤送信ガード
        // urlMissing 経路で Phase A が生成する templateDraft には
        // 「【URL 不在のため、CLI 本体が公式サイト探索後に本文を最終化します】」
        // が含まれる。Phase B の CLI が WebSearch + 本文最終化を完遂しないまま
        // submitted / awaiting_approval を投げると、この prompt 風文言が実際に
        // 顧客へ送られてしまう (1.2.97 で実害発生)。検出したら 422 で拒否し、
        // CLI に再生成を促す。
        if (action === 'submitted' || action === 'awaiting_approval') {
          const haystack = typeof details === 'string' ? details : JSON.stringify(details || '');
          const PLACEHOLDER_PATTERNS = [
            'CLI 本体が公式サイト探索後に本文を最終化します',
            'CLI本体が公式サイト探索後に本文を最終化します',
            '__CLI_PENDING__',
            '【URL 不在のため',
          ];
          const hit = PLACEHOLDER_PATTERNS.find((p: any) => haystack.indexOf(p) >= 0);
          if (hit) {
            res.writeHead(422, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              ok: false,
              error: 'Placeholder body detected — CLI must regenerate the message via WebSearch before logging ' + action + '.',
              detected: hit,
              hint: 'urlMissing=true 経路: Phase B の CLI 本体が WebSearch で公式サイトを発見し、buildMessagePrompt() に基づいて本文を最終化してください。templateDraft をそのまま送らないでください。',
            }));
            return;
          }
        }
        logAction(no, name, action, details);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, no, action }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
  }

  async function handleCliLog(req, res) {
    const CLI_LOG_MAX = 64 * 1024;
    let body = '';
    let bodyOverflow = false;
    req.on('data', chunk => {
      body += chunk;
      if (body.length > CLI_LOG_MAX) {
        bodyOverflow = true;
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Payload too large' }));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (bodyOverflow) return;
      try {
        const { message, type } = JSON.parse(body);
        const CLI_LOG_ALLOWED_TYPES = new Set(['info', 'step', 'error', 'action', 'warn', 'warning', 'thinking', 'debug']);
        const safeType = CLI_LOG_ALLOWED_TYPES.has(type) ? type : 'info';
        sseClients.forEach(r => {
          r.write(`data: ${JSON.stringify({ type: 'cli-log', message: String(message || '').slice(0, 4000), logType: safeType, time: new Date().toISOString() })}\n\n`);
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  }

  // GET /api/ai/status (エイリアス: /api/claude-status)
  async function handleAiStatus(req, res, requestUrl) {
    try {
      const requestedProvider = requestUrl.searchParams.get('provider') || getSelectedAiProvider();
      const status: any = await probeClaudeStatus(requestedProvider);
      jsonResponse(res, 200, status);
    } catch (e) {
      jsonResponse(res, 500, { ok: false, error: e.message });
    }
  }

  // GET /api/ai/setup-diagnostics — プロバイダセットアップ診断
  async function handleAiSetupDiagnostics(req, res, requestUrl) {
    try {
      const requestedProvider = requestUrl.searchParams.get('provider') || getSelectedAiProvider();
      const diagnostics: any = await probeAiSetupDiagnostics(requestedProvider);
      jsonResponse(res, 200, { ok: true, ...diagnostics });
    } catch (e) {
      jsonResponse(res, 500, { ok: false, error: e.message });
    }
  }

  // POST /api/install-update — electron-main.js 用のインストールフラグを書き出す
  async function handleCheckUpdate(_req, res) {
    try {
      if (!AUTO_UPDATE_ENABLED) {
        jsonResponse(res, 409, {
          ok: false,
          error: APP_BUILD_SOURCE === 'development'
            ? 'Development build does not support auto-update checks.'
            : 'Auto-update is not available in this runtime.',
          buildSource: APP_BUILD_SOURCE,
          appVersion: APP_VERSION,
        });
        return;
      }
      ensureDataDir();
      const flagFile = resolveDataPath('check-update.flag');
      ensureParentDir(flagFile);
      fs.writeFileSync(flagFile, Date.now().toString());
      jsonResponse(res, 200, { ok: true, state: 'check-requested', appVersion: APP_VERSION });
    } catch (e) {
      jsonResponse(res, 500, { ok: false, error: e.message });
    }
  }

  // POST /api/install-update — electron-main.js 用のインストールフラグを書き出す
  async function handleInstallUpdate(_req, res) {
    try {
      if (!AUTO_UPDATE_ENABLED) {
        jsonResponse(res, 409, {
          ok: false,
          error: APP_BUILD_SOURCE === 'development'
            ? 'Development build does not support auto-install updates.'
            : 'Auto-update is not available in this runtime.',
          buildSource: APP_BUILD_SOURCE,
          appVersion: APP_VERSION,
        });
        return;
      }
      ensureDataDir();
      const flagFile = resolveDataPath('install-update.flag');
      ensureParentDir(flagFile);
      fs.writeFileSync(flagFile, Date.now().toString());
      jsonResponse(res, 200, { ok: true });
    } catch (e) {
      jsonResponse(res, 500, { ok: false, error: e.message });
    }
  }

  // GET /api/update-status — electron-main.js が書き込んだステータスを返す
  async function handleUpdateStatus(_req, res) {
    try {
      if (APP_BUILD_SOURCE === 'dashboard-only') {
        jsonResponse(res, 200, {
          ok: true,
          state: 'dashboard-only',
          appVersion: APP_VERSION,
          buildSource: APP_BUILD_SOURCE,
          autoUpdateEnabled: false,
        });
        return;
      }

      if (!AUTO_UPDATE_ENABLED) {
        jsonResponse(res, 200, {
          ok: true,
          state: APP_BUILD_SOURCE === 'development' ? 'disabled-dev' : 'disabled',
          appVersion: APP_VERSION,
          buildSource: APP_BUILD_SOURCE,
          autoUpdateEnabled: false,
        });
        return;
      }

      const statusFile = resolveDataPath('update-status.json');
      if (fs.existsSync(statusFile)) {
        const raw = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
        // Stale state 自動補正:
        // 直前の起動で「v2.0.X downloaded」のままアプリが再起動 → 新版インストール →
        // 起動した瞬間は update-status.json がまだ "downloaded" を指している。
        // しかし APP_VERSION === raw.version なら**既にそのバージョンを実行中**なので、
        // バナーを「準備完了」ではなく「最新版」として返す。
        // これをしないと「v2.0.4 の準備完了 — 今すぐ再起動してインストール」が
        // 永久に出続ける (1 分後の polling まで自然に消えない場合がある)。
        const STALE_DOWNLOADED_STATES = ['downloaded', 'downloading', 'available'];
        if (raw && STALE_DOWNLOADED_STATES.includes(raw.state) &&
            raw.version && String(raw.version) === String(APP_VERSION)) {
          raw.state = 'up-to-date';
          raw.message = `Already running v${APP_VERSION} — banner suppressed by API normalization.`;
          raw.autoCorrectedFrom = 'downloaded-stale';
        }
        jsonResponse(res, 200, { ok: true, buildSource: APP_BUILD_SOURCE, autoUpdateEnabled: AUTO_UPDATE_ENABLED, ...raw, appVersion: APP_VERSION });
      } else {
        jsonResponse(res, 200, { ok: true, state: 'unknown', appVersion: APP_VERSION, buildSource: APP_BUILD_SOURCE, autoUpdateEnabled: AUTO_UPDATE_ENABLED });
      }
    } catch (e) {
      jsonResponse(res, 200, { ok: true, state: 'unknown', appVersion: APP_VERSION, buildSource: APP_BUILD_SOURCE, autoUpdateEnabled: AUTO_UPDATE_ENABLED });
    }
  }

  // GET /api/export — Excel export (1.2.102 全件 + 行動履歴 + 連絡履歴 + スクショ + 集計)
  async function handleExport(_req, res) {
    try {
      const data = loadData();
      const prefs = settings.getSection('preferences');
      const tz = prefs.timezone || 'Asia/Tokyo';
      const prefix = prefs.exportFilenamePrefix || 'outreach_progress';
      const fmt = (ts) => { try { return ts ? new Date(ts).toLocaleString('ja-JP', { timeZone: tz }) : ''; } catch (_) { return String(ts || ''); } };
      const stringify = (v) => v == null ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v));

      // 全件 action-log を取得 (recentLogs はダッシュボード用に切り詰められている)
      const allLogs = getAllLogs() || [];
      const logsByCompany = new Map<any, any>();
      allLogs.forEach((l: any) => {
        const key = String(l.companyNo);
        if (!logsByCompany.has(key)) logsByCompany.set(key, []);
        logsByCompany.get(key).push(l);
      });

      // 連絡履歴 (contact-history.json) を直接読む
      let contactHistory: Record<string, any> = {};
      try {
        const chPath = resolveDataPath('contact-history.json');
        if (fs.existsSync(chPath)) {
          contactHistory = JSON.parse(fs.readFileSync(chPath, 'utf-8')) || {};
        }
      } catch (_) { /* ignore */ }

      // sentMessage を action-log details から拾う (1.2.100 ガード後の新ログ)
      const extractSentMessage = (logs) => {
        for (let i = logs.length - 1; i >= 0; i -= 1) {
          const l = logs[i];
          if (l.action !== 'awaiting_approval' && l.action !== 'submitted' && l.action !== 'form_fill') continue;
          let d = l.details;
          if (typeof d === 'string') { try { d = JSON.parse(d); } catch (_) { d = null; } }
          if (d && typeof d === 'object') {
            const c = d.sentMessage || d.actualBody || d.body || d.message;
            if (typeof c === 'string' && c.trim().length >= 30) return c.trim();
          }
        }
        return '';
      };
      const extractScreenshots = (logs) => {
        const found = new Set<any>();
        logs.forEach((l: any) => {
          let d = l.details;
          if (typeof d === 'string') {
            const m = d.match(/ss-\d+-(?:input|sent|confirm|error)\.png/g);
            if (m) m.forEach((x: any) => found.add(x));
          } else if (d && typeof d === 'object') {
            ['screenshot', 'inputScreenshot', 'sentScreenshot', 'confirmScreenshot'].forEach((k: any) => {
              if (typeof d[k] === 'string' && d[k]) found.add(path.basename(d[k]));
            });
          }
        });
        return Array.from(found).sort();
      };
      const extractSiteAnalysis = (logs) => {
        const e = logs.find((l: any) => l.action === 'site_analysis');
        if (!e) return '';
        return typeof e.details === 'string' ? e.details : JSON.stringify(e.details || '');
      };

      const wb = XLSX.utils.book_new();

      // Sheet 1: Progress (拡張版)
      const headers = [
        'No.', 'Status', '会社名', '種別', '進捗', 'Form URL', 'Company URL',
        'CAPTCHA', '最終アクション', '最終アクション時刻', '初回アクション時刻',
        '送信回数', '営業対象', '実送信本文 (sentMessage)', 'site_analysis',
        'スクショ', 'エラー詳細', 'スキップ理由', 'メモ', 'タグ', '全ログ数'
      ];
      const rows = [headers];
      data.companies.forEach((c: any) => {
        const logs = logsByCompany.get(String(c.no)) || [];
        const ch = contactHistory[String(c.no)];
        const firstLog = logs[0];
        const lastLog = logs[logs.length - 1];
        rows.push([
          c.no, c.status, c.name, c.type,
          c.lastAction || c.progress || 'Pending',
          c.formUrl || '', c.url || '',
          c.captcha || '',
          lastLog ? lastLog.action : '',
          lastLog ? fmt(lastLog.timestamp) : '',
          firstLog ? fmt(firstLog.timestamp) : '',
          ch && Array.isArray(ch.contacts) ? ch.contacts.length : 0,
          c.isOutreachTarget ? '対象' : '',
          extractSentMessage(logs),
          extractSiteAnalysis(logs),
          extractScreenshots(logs).join(', '),
          c.lastErrorDetail || '',
          c.manualReviewReason || '',
          c.notes || '',
          Array.isArray(c.tags) ? c.tags.join(', ') : '',
          logs.length,
        ]);
      });
      const ws = XLSX.utils.aoa_to_sheet(rows);
      ws['!cols'] = [
        { wch: 5 }, { wch: 8 }, { wch: 28 }, { wch: 24 }, { wch: 14 }, { wch: 40 }, { wch: 40 },
        { wch: 8 }, { wch: 18 }, { wch: 18 }, { wch: 18 },
        { wch: 8 }, { wch: 8 }, { wch: 60 }, { wch: 60 },
        { wch: 50 }, { wch: 50 }, { wch: 40 }, { wch: 30 }, { wch: 20 }, { wch: 8 }
      ];
      XLSX.utils.book_append_sheet(wb, ws, 'Progress');

      // Sheet 2: Action Log (全件)
      const logRows = [['#', 'Time', 'No.', '会社名', 'Action', 'Details (raw)']];
      allLogs.forEach((l, idx) => {
        logRows.push([idx + 1, fmt(l.timestamp), l.companyNo, l.companyName, l.action, stringify(l.details)]);
      });
      const ws2 = XLSX.utils.aoa_to_sheet(logRows);
      ws2['!cols'] = [{ wch: 6 }, { wch: 20 }, { wch: 5 }, { wch: 28 }, { wch: 18 }, { wch: 100 }];
      XLSX.utils.book_append_sheet(wb, ws2, 'Action Log (全件)');

      // Sheet 3: Contact History
      const chRows = [['No.', '会社名', '送信時刻', '本文', 'フォーム URL', '応答受信時刻', '応答内容', 'メタ']];
      Object.entries(contactHistory).forEach(([no, entry]) => {
        if (!entry || !Array.isArray(entry.contacts)) return;
        entry.contacts.forEach((contact: any) => {
          chRows.push([
            no, entry.companyName || '',
            fmt(contact.sentAt || contact.timestamp),
            contact.message || '',
            contact.formUrl || '',
            fmt(contact.respondedAt),
            contact.response || '',
            stringify(contact.meta || {}),
          ]);
        });
      });
      const ws3 = XLSX.utils.aoa_to_sheet(chRows);
      ws3['!cols'] = [{ wch: 5 }, { wch: 28 }, { wch: 20 }, { wch: 80 }, { wch: 40 }, { wch: 20 }, { wch: 50 }, { wch: 30 }];
      XLSX.utils.book_append_sheet(wb, ws3, '連絡履歴');

      // Sheet 4: Screenshots index
      const shotDir = settings.getScreenshotDir ? settings.getScreenshotDir() : path.join(process.cwd(), 'screenshots');
      const shotRows = [['No.', '会社名', 'ファイル名', '種別', 'ファイルパス', 'ファイルサイズ (bytes)', '更新日時']];
      try {
        if (fs.existsSync(shotDir)) {
          const files = fs.readdirSync(shotDir).filter((f: any) => /^ss-\d+-(input|sent|confirm|error)\.png$/i.test(f));
          const companyByNo = new Map(data.companies.map((c: any) => [String(c.no), c.name]));
          files.sort((a: any, b: any) => {
            const an = parseInt(a.match(/^ss-(\d+)/)[1], 10);
            const bn = parseInt(b.match(/^ss-(\d+)/)[1], 10);
            return an !== bn ? an - bn : a.localeCompare(b);
          });
          files.forEach((f: any) => {
            const m = f.match(/^ss-(\d+)-(input|sent|confirm|error)\.png$/i);
            if (!m) return;
            const fp = path.join(shotDir, f);
            const stat = fs.statSync(fp);
            shotRows.push([m[1], companyByNo.get(m[1]) || '', f, m[2], fp, stat.size, fmt(stat.mtime.toISOString())]);
          });
        }
      } catch (_) { /* ignore */ }
      const ws4 = XLSX.utils.aoa_to_sheet(shotRows);
      ws4['!cols'] = [{ wch: 5 }, { wch: 28 }, { wch: 24 }, { wch: 10 }, { wch: 80 }, { wch: 14 }, { wch: 20 }];
      XLSX.utils.book_append_sheet(wb, ws4, 'スクリーンショット');

      // Sheet 5: Summary
      const statusCount: Record<string, any> = {};
      data.companies.forEach((c: any) => { statusCount[c.status] = (statusCount[c.status] || 0) + 1; });
      const actionCount: Record<string, any> = {};
      allLogs.forEach((l: any) => { actionCount[l.action] = (actionCount[l.action] || 0) + 1; });
      const sumRows = [
        ['集計項目', '値'],
        ['エクスポート時刻', fmt(new Date().toISOString())],
        ['Sales Claw バージョン', require('../../../package.json').version || ''],
        ['企業数 (合計)', data.companies.length],
        ['アクションログ件数 (全件)', allLogs.length],
        ['連絡履歴のある企業数', Object.keys(contactHistory).length],
        ['', ''],
        ['ステータス内訳', ''],
        ...Object.entries(statusCount).map(([k, v]) => [`  ${k}`, v]),
        ['', ''],
        ['アクション内訳', ''],
        ...Object.entries(actionCount).map(([k, v]) => [`  ${k}`, v]),
      ];
      const ws5 = XLSX.utils.aoa_to_sheet(sumRows);
      ws5['!cols'] = [{ wch: 28 }, { wch: 24 }];
      XLSX.utils.book_append_sheet(wb, ws5, 'サマリ');

      const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${prefix}_${new Date().toISOString().slice(0,10)}.xlsx"`,
      });
      res.end(buf);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Export error: ' + e.message);
    }
  }

  // GET /api/data — ダッシュボードデータ
  async function handleData(_req, res) {
    try {
      jsonResponse(res, 200, loadData());
    } catch (e: any) {
      // v2.0.12: 500 を返す前に stack trace を必ずサーバ標準エラーに出す。
      // 過去にこの try/catch が e.message だけ返して根本原因が分からないまま
      // 「読込失敗: Cannot read properties of undefined (reading 'length')」が
      // 出続けた事故 (2026-05-15)。
      try {
        // eslint-disable-next-line no-console
        console.error('[/api/data] loadData() threw:', e && e.stack ? e.stack : String(e));
      } catch (_) { /* swallow */ }
      jsonResponse(res, 500, { error: e.message, stack: process.env.NODE_ENV !== 'production' ? String(e.stack || '').slice(0, 4000) : undefined });
    }
  }

  // ---------- dispatch ----------

  /**
   * 受信した request が simple API の管轄であれば handle して true を返す。
   * 管轄外であれば false を返して呼び出し側に処理を戻す。
   *
   * @param {http.IncomingMessage} req
   * @param {http.ServerResponse} res
   * @param {string} pathname - URL.pathname (? 以降削除済み)
   * @param {URL} requestUrl - new URL(req.url, 'http://127.0.0.1') 等で事前に構築した URL オブジェクト
   * @returns {Promise<boolean>}
   */
  return async function dispatch(req, res, pathname, requestUrl) {
    // すべて pathname (? 除去済み) で比較する。
    // req.url 直接参照はクエリ文字列で誤マッチ or バイパスするリスクがある。
    const method = req.method;

    // POST /api/ai-submit (410 Gone)
    if (pathname === '/api/ai-submit' && method === 'POST') {
      await handleAiSubmit(req, res);
      return true;
    }

    // GET /api/ai-submit-status (410 Gone) — オリジナルは method 指定なしだったため GET のみに限定せず ?
    //   元コード: if (req.url === '/api/ai-submit-status') { ... }
    //   method に関係なく 410 を返していたので、そのまま踏襲する。
    if (pathname === '/api/ai-submit-status') {
      await handleAiSubmitStatus(req, res);
      return true;
    }

    // POST /api/cli-log
    if (pathname === '/api/log-action' && method === 'POST') {
      await handleLogAction(req, res);
      return true;
    }
    if (pathname === '/api/cli-log' && method === 'POST') {
      await handleCliLog(req, res);
      return true;
    }

    // POST /api/resend-prepare
    if (pathname === '/api/resend-prepare' && method === 'POST') {
      await handleResendPrepare(req, res);
      return true;
    }

    // GET /api/claude-status または /api/ai/status
    if ((pathname === '/api/claude-status' || pathname === '/api/ai/status') && method === 'GET') {
      await handleAiStatus(req, res, requestUrl);
      return true;
    }

    // GET /api/ai/setup-diagnostics
    if (pathname === '/api/ai/setup-diagnostics' && method === 'GET') {
      await handleAiSetupDiagnostics(req, res, requestUrl);
      return true;
    }

    // POST /api/check-update
    if (pathname === '/api/check-update' && method === 'POST') {
      await handleCheckUpdate(req, res);
      return true;
    }

    // POST /api/install-update
    if (pathname === '/api/install-update' && method === 'POST') {
      await handleInstallUpdate(req, res);
      return true;
    }

    // GET /api/update-status
    if (pathname === '/api/update-status' && method === 'GET') {
      await handleUpdateStatus(req, res);
      return true;
    }

    // GET /api/export
    //   元コード: if (req.url === '/api/export') { ... } (method チェックなし)
    //   そのまま method 指定なしで踏襲する
    if (pathname === '/api/export') {
      await handleExport(req, res);
      return true;
    }

    // GET /api/export/action-log.csv  (P1-7) 行動ログを CSV で取得
    if (pathname === '/api/export/action-log.csv' && method === 'GET') {
      try {
        const tz = settings.getSection('preferences').timezone || 'Asia/Tokyo';
        const lines = ['Timestamp,CompanyNo,CompanyName,Action,Details'];
        for (const l of (getAllLogs() || [])) {
          const ts = new Date(l.timestamp).toLocaleString('ja-JP', { timeZone: tz });
          lines.push([csvCell(ts), csvCell(l.companyNo), csvCell(l.companyName), csvCell(l.action), csvCell(l.details)].join(','));
        }
        const csv = '﻿' + lines.join('\r\n'); // BOM 付き UTF-8 (Excel 互換)
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="action-log_${new Date().toISOString().slice(0,10)}.csv"`,
        });
        res.end(csv);
      } catch (e) {
        jsonResponse(res, 500, { ok: false, error: e.message });
      }
      return true;
    }

    // GET /api/export/companies.csv  会社一覧 CSV (P1-7)
    if (pathname === '/api/export/companies.csv' && method === 'GET') {
      try {
        const data = loadData();
        const lines = ['No,CompanyName,Type,URL,FormURL,Status,LastAction,LastActionAt,ContactCount'];
        for (const c of (data.companies || [])) {
          lines.push([
            csvCell(c.no), csvCell(c.name), csvCell(c.type), csvCell(c.url), csvCell(c.formUrl),
            csvCell(c.status), csvCell(c.lastAction), csvCell(c.lastActionAt), csvCell(c.contactCount),
          ].join(','));
        }
        const csv = '﻿' + lines.join('\r\n');
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="companies_${new Date().toISOString().slice(0,10)}.csv"`,
        });
        res.end(csv);
      } catch (e) {
        jsonResponse(res, 500, { ok: false, error: e.message });
      }
      return true;
    }

    // GET /api/data
    //   元コード: if (req.url === '/api/data') { ... } (method チェックなし)
    //   そのまま method 指定なしで踏襲する
    if (pathname === '/api/data') {
      await handleData(req, res);
      return true;
    }

    // GET /api/cost/summary  AI トークン消費の概算 (P0-3 コスト可視化)
    if (pathname === '/api/cost/summary' && method === 'GET') {
      try {
        const prefs = settings.getSection('preferences') || {};
        const usdJpy = Number(prefs.usdJpy) || undefined;
        const summary = costEstimator.summarize({ usdJpy });
        jsonResponse(res, 200, { ok: true, summary });
      } catch (e) {
        jsonResponse(res, 500, { ok: false, error: e.message });
      }
      return true;
    }

    // POST /api/target-list/validate  ターゲットリストのデータ品質検証 (P1-1)
    if (pathname === '/api/target-list/validate' && method === 'POST') {
      try {
        const tlv = require('../target-list-validator');
        const data = loadData();
        const targets = normalizeValidationTargets(data);
        const state = getTargetValidationState();
        // バックグラウンド実行: 即レスポンス → 完了時に SSE で push (簡易)
        // 同時に何度も走らないよう簡易ロック
        if (state.running) {
          jsonResponse(res, 409, { ok: false, error: 'already running' });
          return true;
        }
        Object.assign(state, {
          running: true,
          startedAt: new Date().toISOString(),
          finishedAt: null,
          done: 0,
          total: targets.length,
          error: null,
        });
        // 即時レスポンス
        jsonResponse(res, 202, { ok: true, accepted: true, total: targets.length });
        // 非同期実行
        (async () => {
          try {
            const result: any = await tlv.validateTargetList(targets, {
              onProgress(done, total) {
                state.done = done;
                state.total = total;
              },
            });
            // 結果をディスクに保存
            const out = resolveDataPath('target-list-validation.json');
            state.done = result.checked || targets.length;
            state.total = result.total || targets.length;
            state.finishedAt = new Date().toISOString();
            fs.mkdirSync(path.dirname(out), { recursive: true });
            fs.writeFileSync(out, JSON.stringify({ generatedAt: state.finishedAt, ...result }, null, 2));
            broadcastSse({ type: 'target-list-validation-complete', result, time: Date.now() });
          } catch (e) {
            state.error = e && e.message ? e.message : String(e);
            console.warn('[target-list-validate] failed:', e && e.message || e);
          } finally {
            state.running = false;
            state.finishedAt = state.finishedAt || new Date().toISOString();
          }
        })();
      } catch (e) {
        const state = getTargetValidationState();
        state.running = false;
        state.error = e.message;
        jsonResponse(res, 500, { ok: false, error: e.message });
      }
      return true;
    }

    // GET /api/target-list/validation-result  最後の検証結果を取得 (P1-1)
    if (pathname === '/api/target-list/validation-result' && method === 'GET') {
      try {
        const fs = require('fs');
        const out = resolveDataPath('target-list-validation.json');
        const state = getTargetValidationState();
        if (!fs.existsSync(out)) {
          jsonResponse(res, 200, { ok: true, hasResult: false, running: !!state.running, progress: state });
          return true;
        }
        const result = JSON.parse(fs.readFileSync(out, 'utf8'));
        jsonResponse(res, 200, { ok: true, hasResult: true, running: !!state.running, progress: state, ...result });
      } catch (e) {
        jsonResponse(res, 500, { ok: false, error: e.message });
      }
      return true;
    }

    // POST /api/compliance/check  メッセージの法令適合チェック (P0-4)
    if (pathname === '/api/compliance/check' && method === 'POST') {
      try {
        const compliance = require('../compliance');
        const data: any = await new Promise((resolve, reject) => {
          let body = '';
          req.on('data', (c) => { body += c; if (body.length > 256 * 1024) { req.destroy(); reject(new Error('payload too large')); } });
          req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch (e) { reject(e); } });
          req.on('error', reject);
        });
        const profile = settings.getSection('companyProfile') || {};
        const evaluation = compliance.evaluateForUi(String(data.message || ''), profile);
        jsonResponse(res, 200, { ok: true, evaluation });
      } catch (e) {
        jsonResponse(res, 500, { ok: false, error: e.message });
      }
      return true;
    }

    // 管轄外
    return false;
  };
};

module.exports._test = {
  csvCell,
  normalizeValidationTargets,
};

'use strict';

/**
 * Form Session API Routes
 *
 * dashboard-server.cjs から切り出された Form Session 系 API ハンドラ群。
 * Phase 2 リファクタリングの一環として、モノリス化した dashboard-server.cjs から
 * ルーター関数を集約する。
 *
 * 対応エンドポイント (全 10):
 *  - POST   /api/form-session/create
 *  - GET    /api/form-session
 *  - POST   /api/form-session/active/hide
 *  - GET    /api/form-session/{id}/structure
 *  - POST   /api/form-session/{id}/fill
 *  - POST   /api/form-session/{id}/screenshot
 *  - POST   /api/form-session/{id}/show
 *  - POST   /api/form-session/{id}/hide
 *  - GET    /api/form-session/{id}/info
 *  - DELETE /api/form-session/{id}
 *
 * Electronモード専用 (FormSessionManager 依存)。
 * _formSessionManager が null の場合は 501 を返す。
 *
 * 既存の dashboard-server.cjs のロジックは変更せずそのまま移植している。
 */

const path = require('path');
const fs = require('fs');
const { logAction } = require('../action-logger');

/**
 * Form Session API ルーターを生成する factory。
 * dashboard-server.cjs から require して呼び、共有ユーティリティを ctx で注入する。
 *
 * @param {object} ctx - 依存注入
 * @param {function} ctx.jsonResponse - (res, statusCode, data, extraHeaders?) を書き込む
 * @param {function} ctx.parseJsonBody - (req) → Promise<object>
 * @param {function} ctx.getFormSessionManager - () → FormSessionManager | null (lazy ref)
 * @param {object}   ctx.settings - settings-manager インスタンス (getSender / getScreenshotDir 等)
 * @returns {function} dispatch(req, res, pathname) → Promise<boolean> (handled なら true)
 */
module.exports = function createFormSessionRoutes(ctx) {
  const {
    jsonResponse,
    parseJsonBody,
    getFormSessionManager,
    settings,
    getCompanyLogContext,
  } = ctx;

  // ---------- 各ハンドラ関数 ----------

  // POST /api/form-session/create
  async function handleCreate(req, res) {
    const _formSessionManager = getFormSessionManager();
    try {
      const body: any = await parseJsonBody(req);
      const formUrl = typeof body.formUrl === 'string' ? body.formUrl.trim() : '';
      const companyNo = body.companyNo != null ? String(body.companyNo) : '';
      if (!formUrl) { jsonResponse(res, 400, { ok: false, error: 'formUrl が必要です' }); return; }

      const sessionId: any = await _formSessionManager.createSession(formUrl, companyNo);
      jsonResponse(res, 200, { ok: true, sessionId });
    } catch (e) {
      jsonResponse(res, 500, { ok: false, error: e.message });
    }
  }

  // GET /api/form-session (list)
  async function handleList(req, res) {
    const _formSessionManager = getFormSessionManager();
    const realSessions = _formSessionManager ? _formSessionManager.listSessions() : [];
    // v2.0.89: parallel-dispatcher (外部 Chrome 経路) は internal WebContentsView を
    //   使わないため form-session は作られない。だが UI のセッションタブバーには
    //   現在処理中の company を出す必要があるので、live-monitor の active sessions
    //   から「仮想 session」を合成して realSessions に追加する。
    //   - id は "virtual:<companyNo>" にする (実体ナビ操作には使えない目印)
    //   - status は live-monitor の status を流用
    //   - WebView dock は出ない (kind:'virtual' で UI 側が分岐できる)
    let virtualSessions: Array<Record<string, unknown>> = [];
    try {
      const { getLiveMonitorSummary } = require('../live-monitor');
      const summary = getLiveMonitorSummary();
      const taken = new Set(realSessions.map((s: any) => String(s.companyNo)));
      // v2.0.90: 完了系 (submitted/skipped/error/awaiting_approval) は session タブから外す。
      //   旧 (~v0.89) は全 active 企業を出していたので、20社流すと完了したものまで
      //   タブに残り続けて見づらかった (ユーザー報告: 送信した履歴エラーなどはタブから削除)。
      const TERMINAL_STATUSES = new Set([
        'submitted', 'skipped', 'error', 'awaiting_approval', 'awaiting',
        'done', 'completed', 'finished',
      ]);
      // companyNo ごとに最新 event を選び、最新が in-progress なら入れる
      const latestByCompany = new Map<string, any>();
      (summary && Array.isArray(summary.events) ? summary.events : []).forEach((ev: any) => {
        if (!ev || ev.companyNo == null) return;
        const noKey = String(ev.companyNo);
        const prev = latestByCompany.get(noKey);
        if (!prev) { latestByCompany.set(noKey, ev); return; }
        const prevT = new Date(prev.updatedAt || 0).getTime();
        const curT = new Date(ev.updatedAt || 0).getTime();
        if (curT >= prevT) latestByCompany.set(noKey, ev);
      });
      latestByCompany.forEach((ev, noKey) => {
        if (taken.has(noKey)) return;
        if (ev.active === false) return;
        const statusKey = String(ev.status || '').toLowerCase();
        const actionKey = String(ev.action || '').toLowerCase();
        if (TERMINAL_STATUSES.has(statusKey) || TERMINAL_STATUSES.has(actionKey)) return;
        // CAPTCHA 検知フラグ (events に書かれていれば拾う)
        const captchaDetected = !!(ev.captchaDetected || ev.captcha || (ev.details && (ev.details.captchaDetected || ev.details.captcha)));
        virtualSessions.push({
          id: `virtual:${noKey}`,
          companyNo: ev.companyNo,
          companyName: ev.companyName || '',
          formUrl: ev.currentUrl || ev.formUrl || '',
          status: ev.status || ev.action || 'running',
          captchaDetected,
          isActive: false,
          active: false,
          kind: 'virtual',
          source: ev.source || 'live-monitor',
        });
      });
    } catch (_) { /* live-monitor unavailable */ }
    jsonResponse(res, 200, { ok: true, sessions: [...realSessions, ...virtualSessions] });
  }

  // POST /api/form-session/active/hide (hide current session without knowing sessionId)
  async function handleActiveHide(req, res) {
    const _formSessionManager = getFormSessionManager();
    _formSessionManager.hideCurrentSession();
    jsonResponse(res, 200, { ok: true });
  }

  // GET /api/form-session/:id/structure
  async function handleStructure(req, res, sessionId) {
    const _formSessionManager = getFormSessionManager();
    try {
      const result: any = await _formSessionManager.getFormStructure(sessionId);
      // 後方互換: 配列が返った場合は fields 扱い、オブジェクトなら { fields, meta }
      const fields = Array.isArray(result) ? result : (result && result.fields) || [];
      const meta = (result && result.meta) || null;
      jsonResponse(res, 200, { ok: true, fields, meta });
    } catch (e) {
      jsonResponse(res, 500, { ok: false, error: e.message });
    }
  }

  // POST /api/form-session/:id/fill  — backend validates mappings against settings
  async function handleFill(req, res, sessionId) {
    const _formSessionManager = getFormSessionManager();
    try {
      const body: any = await parseJsonBody(req);
      const rawMappings = Array.isArray(body.mappings) ? body.mappings : [];

      // 許可リスト: settings に存在するキーからのみ値を使用
      const sender = settings.getSender();
      const allowedValues = {
        companyName: sender.companyName || '',
        contactName: sender.name || '',
        name: sender.name || '',
        contactNameKana: sender.nameKana || '',
        nameKana: sender.nameKana || '',
        contactTitle: sender.title || '',
        title: sender.title || '',
        department: sender.department || '',
        email: sender.email || '',
        phone: sender.phone || '',
        mobile: sender.mobile || '',
        fax: sender.fax || '',
        website: sender.website || '',
        address: sender.address || '',
        postalCode: sender.postalCode || '',
      };

      const validMappings = rawMappings
        .filter(m => m && typeof m.selector === 'string' && m.selector.trim())
        .map(m => {
          // value は settings からの値または AI が生成したメッセージ本文のみ許可
          const resolved = m.valueKey && allowedValues[m.valueKey] !== undefined
            ? allowedValues[m.valueKey]
            : (typeof m.value === 'string' ? m.value : '');
          return { selector: m.selector.trim(), value: resolved, type: m.type || 'text' };
        })
        .filter(m => m.value !== '');

      const results: any = await _formSessionManager.fillForm(sessionId, validMappings);
      // v2.1.4: MCP 経路 (fill_form op) と同じく検証サマリを同梱 (best-effort)
      let validation: any = null;
      try {
        if (typeof _formSessionManager.getValidationSummary === 'function') {
          validation = await _formSessionManager.getValidationSummary(sessionId);
        }
      } catch (_) { /* no-op */ }
      jsonResponse(res, 200, { ok: true, results, validation });
    } catch (e) {
      jsonResponse(res, 500, { ok: false, error: e.message });
    }
  }

  // POST /api/form-session/:id/screenshot
  async function handleScreenshot(req, res, sessionId) {
    const _formSessionManager = getFormSessionManager();
    try {
      const body: any = await parseJsonBody(req);
      const session = _formSessionManager.getSession(sessionId);
      if (!session) { jsonResponse(res, 404, { ok: false, error: 'Session not found' }); return; }

      const ALLOWED_SUFFIXES = ['input', 'confirm', 'sent', 'error'];
      const suffix = ALLOWED_SUFFIXES.includes(body.suffix) ? body.suffix : 'input';
      const safeNo = String(session.companyNo).replace(/[^a-zA-Z0-9_-]/g, '_');
      const screenshotDir = settings.getScreenshotDir();
      const savePath = path.join(screenshotDir, `ss-${safeNo}-${suffix}.png`);

      const savedPath: any = await _formSessionManager.captureScreenshot(sessionId, savePath);
      jsonResponse(res, 200, { ok: true, path: savedPath });
    } catch (e) {
      jsonResponse(res, 500, { ok: false, error: e.message });
    }
  }

  // POST /api/form-session/:id/show
  async function handleShow(req, res, sessionId) {
    const _formSessionManager = getFormSessionManager();
    try {
      _formSessionManager.showSession(sessionId);
      jsonResponse(res, 200, { ok: true });
    } catch (e) {
      jsonResponse(res, 500, { ok: false, error: e.message });
    }
  }

  // POST /api/form-session/:id/hide
  async function handleHide(req, res, sessionId) {
    const _formSessionManager = getFormSessionManager();
    try {
      _formSessionManager.hideCurrentSession();
      jsonResponse(res, 200, { ok: true });
    } catch (e) {
      jsonResponse(res, 500, { ok: false, error: e.message });
    }
  }

  // GET /api/form-session/:id/info
  async function handleInfo(req, res, sessionId) {
    const _formSessionManager = getFormSessionManager();
    const info = _formSessionManager.getSession(sessionId);
    if (!info) { jsonResponse(res, 404, { ok: false, error: 'Session not found' }); return; }
    jsonResponse(res, 200, { ok: true, session: info });
  }

  // DELETE /api/form-session/:id  (destroy)
  async function handleDelete(req, res, sessionId) {
    const _formSessionManager = getFormSessionManager();
    try {
      _formSessionManager.destroySession(sessionId);
      jsonResponse(res, 200, { ok: true });
    } catch (e) {
      jsonResponse(res, 500, { ok: false, error: e.message });
    }
  }

  // v2.0.97: POST /api/form-session/mark-sent  { companyNo }
  //   reCAPTCHA 等を人間がライブブラウザで手動解決+送信した後に「送信済み」へ確定する。
  //   ライブセッションから ss-{No}-sent.png を撮影 → awaiting ログの sentMessage で
  //   submitted を記録 → セッション破棄。
  async function handleMarkSent(req, res) {
    const _formSessionManager = getFormSessionManager();
    try {
      const body: any = await parseJsonBody(req).catch(() => ({}));
      // companyNo は正の整数に限定する。NaN/不正値が action-log に書かれて監査記録が
      // 壊れるのを防ぐ (simple-api の log-action ガードと同等)。数値化でパスも安全になる。
      const companyNoNum = Number(body && body.companyNo);
      if (!Number.isFinite(companyNoNum) || companyNoNum <= 0) {
        jsonResponse(res, 400, { ok: false, error: 'companyNo は正の整数が必要です' }); return;
      }
      const companyNo = String(companyNoNum);
      const safeNo = companyNo; // 正の整数なのでファイル名に安全

      const sessions = typeof _formSessionManager.listSessions === 'function' ? _formSessionManager.listSessions() : [];
      const sess = sessions.find((s: any) => String(s.companyNo) === companyNo && !String(s.id || '').startsWith('virtual:'));

      // awaiting ログから sentMessage / 社名を取得
      let sentMessage = '';
      let name = (sess && sess.companyName) || ('#' + companyNo);
      if (typeof getCompanyLogContext === 'function') {
        const ctxLog: any = getCompanyLogContext(companyNoNum);
        const aw = ctxLog && ctxLog.awaitingLog;
        if (aw) {
          const d = aw.details;
          if (typeof d === 'string') {
            try { const o = JSON.parse(d); sentMessage = (o && (o.sentMessage || o.body || o.message)) || d; } catch { sentMessage = d; }
          } else if (d && typeof d === 'object') {
            sentMessage = d.sentMessage || d.body || d.message || '';
          }
        }
        if (ctxLog && ctxLog.lastLog && ctxLog.lastLog.companyName) name = ctxLog.lastLog.companyName;
      }

      // 完了スクショ: live session があれば撮影、無ければ input を sent としてコピー
      const screenshotName = 'ss-' + safeNo + '-sent.png';
      const screenshotDir = settings.getScreenshotDir();
      const savePath = path.join(screenshotDir, screenshotName);
      let captured = false;
      if (sess) {
        try { await _formSessionManager.captureScreenshot(sess.id, savePath); captured = true; } catch (_) {}
      }
      if (!captured) {
        try {
          const inputPath = path.join(screenshotDir, 'ss-' + safeNo + '-input.png');
          if (fs.existsSync(inputPath)) { fs.copyFileSync(inputPath, savePath); captured = true; }
        } catch (_) {}
      }

      // submitted 記録 (server-side 直叩き — 人間の手動確認を表す信頼経路)
      logAction(companyNoNum, name, 'submitted', {
        sentMessage: sentMessage && sentMessage.trim().length >= 10 ? sentMessage : '(手動送信: 本文ログ無し)',
        screenshot: captured ? screenshotName : '',
        source: 'manual-captcha-submit',
        verified: true,
      });

      // セッション破棄
      if (typeof _formSessionManager.destroySessionsByCompanyNo === 'function') {
        _formSessionManager.destroySessionsByCompanyNo(companyNo);
      }
      // スクショが撮れなかった場合は warning を返して UI 側で注意喚起できるようにする
      jsonResponse(res, 200, {
        ok: true,
        companyNo: companyNoNum,
        screenshot: captured ? screenshotName : null,
        warning: captured ? undefined : 'completion screenshot could not be captured (logged without ss-sent)',
      });
    } catch (e) {
      jsonResponse(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  // ---------- dispatch ----------

  /**
   * 受信した request が form-session API の管轄であれば handle して true を返す。
   * 管轄外であれば false を返して呼び出し側に処理を戻す。
   *
   * Electronモード前提: _formSessionManager が null の場合は 501 を返して true で終了。
   *
   * @param {http.IncomingMessage} req
   * @param {http.ServerResponse} res
   * @param {string} pathname - URL.pathname (? 以降削除済み)
   * @returns {Promise<boolean>}
   */
  return async function dispatch(req, res, pathname) {
    if (!pathname.startsWith('/api/form-session')) return false;

    const _formSessionManager = getFormSessionManager();
    const method = req.method;
    // v2.0.89: dashboard:preview (非 Electron) でも GET list は仮想 session を返す
    //   ことで UI のセッションタブバー / 進捗バーが parallel 実行中に動作確認できる。
    //   manager が必要な write 系操作のみ Electron 必須で 501 にする。
    if (!_formSessionManager) {
      if (pathname === '/api/form-session' && method === 'GET') {
        await handleList(req, res);
        return true;
      }
      jsonResponse(res, 501, { ok: false, error: 'FormSession はElectronモードでのみ利用できます' });
      return true;
    }

    // 固定パス (優先) ──────────────────────────────────
    // POST /api/form-session/create
    if (pathname === '/api/form-session/create' && method === 'POST') {
      await handleCreate(req, res);
      return true;
    }

    // GET /api/form-session (list)
    if (pathname === '/api/form-session' && method === 'GET') {
      await handleList(req, res);
      return true;
    }

    // POST /api/form-session/active/hide
    if (pathname === '/api/form-session/active/hide' && method === 'POST') {
      await handleActiveHide(req, res);
      return true;
    }

    // v2.0.85: POST /api/form-session/tab-changed
    //   HTML 側のタブ切替で呼ばれる。activeTab !== 'live-form' なら全 session hide。
    if (pathname === '/api/form-session/tab-changed' && method === 'POST') {
      try {
        const body = await parseJsonBody(req).catch(() => ({}));
        const activeTab = body && typeof body.activeTab === 'string' ? body.activeTab : '';
        let hidden: any = null;
        if (activeTab !== 'live-form') {
          // WebContentsView は DOM タブの display:none に追従しない。
          // 非 live-form では全 view を detach し、戻った時だけ setViewBounds で復帰する。
          if (typeof _formSessionManager.hideAllSessions === 'function') {
            hidden = _formSessionManager.hideAllSessions();
          } else if (typeof _formSessionManager.parkActiveView === 'function') {
            hidden = _formSessionManager.parkActiveView();
          } else {
            _formSessionManager.hideCurrentSession();
            hidden = { ok: true, hidden: 1 };
          }
        }
        // live-form タブの場合は HTML 側が setViewBounds を後追いで呼ぶ
        jsonResponse(res, 200, { ok: true, activeTab, hidden });
      } catch (e) {
        jsonResponse(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
      }
      return true;
    }

    // v2.0.86: POST /api/form-session/:id/set-bounds
    //   HTML 側で計算した slot 要素の bbox (page coords) を渡す。
    //   WebContentsView をその位置に正確配置 = HTML 上で「ここに表示」と思った所に必ず重なる。
    //   Body: { x: number, y: number, width: number, height: number }
    if (pathname.match(/^\/api\/form-session\/[^/]+\/set-bounds$/) && method === 'POST') {
      const sid = pathname.split('/')[3];
      try {
        const body = await parseJsonBody(req).catch(() => ({}));
        if (typeof _formSessionManager.setViewBounds === 'function') {
          const r = _formSessionManager.setViewBounds(sid, body);
          jsonResponse(res, r.ok ? 200 : 500, r);
        } else {
          jsonResponse(res, 501, { ok: false, error: 'setViewBounds not available' });
        }
      } catch (e) {
        jsonResponse(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
      }
      return true;
    }

    // v2.0.97: POST /api/form-session/mark-sent (手動送信→送信済み確定)
    //   動的 :id matcher より前に置く ("mark-sent" を sessionId と誤認させない)。
    if (pathname === '/api/form-session/mark-sent' && method === 'POST') {
      await handleMarkSent(req, res);
      return true;
    }

    // 動的 ID 付きパス ──────────────────────────────────
    // /api/form-session/:id  または /api/form-session/:id/:action
    const sessionMatch = pathname.match(/^\/api\/form-session\/([^/]+)(?:\/(.+))?$/);
    if (sessionMatch) {
      const sessionId = sessionMatch[1];
      const action = sessionMatch[2] || '';

      // GET .../structure
      if (action === 'structure' && method === 'GET') {
        await handleStructure(req, res, sessionId);
        return true;
      }

      // POST .../fill
      if (action === 'fill' && method === 'POST') {
        await handleFill(req, res, sessionId);
        return true;
      }

      // POST .../screenshot
      if (action === 'screenshot' && method === 'POST') {
        await handleScreenshot(req, res, sessionId);
        return true;
      }

      // POST .../show
      if (action === 'show' && method === 'POST') {
        await handleShow(req, res, sessionId);
        return true;
      }

      // POST .../hide
      if (action === 'hide' && method === 'POST') {
        await handleHide(req, res, sessionId);
        return true;
      }

      // GET .../info
      if (action === 'info' && method === 'GET') {
        await handleInfo(req, res, sessionId);
        return true;
      }

      // DELETE .../  (destroy)
      if (!action && method === 'DELETE') {
        await handleDelete(req, res, sessionId);
        return true;
      }
    }

    // /api/form-session/* にマッチしたがハンドラなし → 404 で終了 (既存仕様)
    jsonResponse(res, 404, { ok: false, error: 'Not found' });
    return true;
  };
};

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
    jsonResponse(res, 200, { ok: true, sessions: _formSessionManager.listSessions() });
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
      jsonResponse(res, 200, { ok: true, results });
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

    // Electronモード必須: FormSessionManager が未注入なら 501 で終了
    const _formSessionManager = getFormSessionManager();
    if (!_formSessionManager) {
      jsonResponse(res, 501, { ok: false, error: 'FormSession はElectronモードでのみ利用できます' });
      return true;
    }

    const method = req.method;

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
        if (activeTab !== 'live-form') {
          // 全 session hide
          _formSessionManager.hideCurrentSession();
        } else {
          // live-form タブ active 化: 最新 active session を再 show
          const sessions = (_formSessionManager._sessions && Array.from(_formSessionManager._sessions.values())) || [];
          const candidate = sessions[sessions.length - 1];
          if (candidate && candidate.id) {
            try { _formSessionManager.showSession(candidate.id); } catch (_) {}
          }
        }
        jsonResponse(res, 200, { ok: true, activeTab });
      } catch (e) {
        jsonResponse(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
      }
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

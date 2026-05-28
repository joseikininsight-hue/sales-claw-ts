'use strict';

const fs = require('fs');
const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const path = require('path');
const settings = require('./settings-manager');

// WebContentsView bounds for the form review pane (right 55% of content area)
const HEADER_HEIGHT = 56;
const PANEL_LEFT_RATIO = 0.45; // dashboard left panel takes 45%
const MAX_SESSIONS = 30;
const ALLOWED_SCREENSHOT_SUFFIXES = new Set(['input', 'confirm', 'sent', 'error']);
const DNS_LOOKUP_TIMEOUT_MS = 5000;

function isBlockedIpv4(address) {
  const parts = String(address).split('.').map((part: any) => Number(part));
  if (parts.length !== 4 || parts.some((part: any) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b, c] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168)) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function isBlockedIpv6(address) {
  const normalized = String(address).toLowerCase();
  const mapped = normalized.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return isBlockedIpv4(mapped[1]);
  const mappedHex = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const high = Number.parseInt(mappedHex[1], 16);
    const low = Number.parseInt(mappedHex[2], 16);
    if (!Number.isFinite(high) || !Number.isFinite(low)) return true;
    return isBlockedIpv4([
      (high >> 8) & 0xff,
      high & 0xff,
      (low >> 8) & 0xff,
      low & 0xff,
    ].join('.'));
  }
  const firstHextet = Number.parseInt(normalized.split(':')[0] || '0', 16);
  return (
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    (Number.isFinite(firstHextet) && (firstHextet & 0xffc0) === 0xfe80) ||
    normalized.startsWith('ff') ||
    normalized.startsWith('2001:db8:')
  );
}

function isBlockedIpAddress(address) {
  const bareAddress = String(address || '').replace(/^\[|\]$/g, '');
  const version = net.isIP(bareAddress);
  if (version === 4) return isBlockedIpv4(bareAddress);
  if (version === 6) return isBlockedIpv6(bareAddress);
  return true;
}

function withTimeout(promise, timeoutMs, message) {
  let timer: any = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function resolvePublicAddresses(hostname) {
  const bareHost = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (net.isIP(bareHost)) return [{ address: bareHost }];
  const results: any = await withTimeout(
    dns.lookup(bareHost, { all: true, verbatim: true }),
    DNS_LOOKUP_TIMEOUT_MS,
    'DNS lookup timed out',
  );
  return Array.isArray(results) ? results : [];
}

async function validateFormUrlSafety(rawUrl) {
  let parsed;
  try { parsed = new URL(rawUrl); } catch { return { ok: false, reason: 'invalid_url' }; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { ok: false, reason: 'unsupported_protocol' };
  if (parsed.username || parsed.password) return { ok: false, reason: 'url_credentials_not_allowed' };
  const hostname = parsed.hostname.toLowerCase();
  const bareHost = hostname.replace(/^\[|\]$/g, '');
  // v2.0.79: テスト用 SSRF bypass (env SALES_CLAW_ALLOW_LOCAL_FORM=1 設定時のみ)。
  // 127.0.0.1 / localhost / 10.x / 192.168.x への navigate を許可。
  // 本番環境ではこの env を設定しないこと (SSRF 攻撃可能になる)。
  if (process.env.SALES_CLAW_ALLOW_LOCAL_FORM === '1') {
    // skip localhost/private IP checks — caller-responsibility
    return { ok: true, hostname: bareHost, port: parsed.port || '', addresses: [{ address: bareHost }] };
  }
  if (bareHost === 'localhost' || bareHost.endsWith('.localhost')) return { ok: false, reason: 'localhost_not_allowed' };
  if (/^\d+$/.test(bareHost) || /^0x[0-9a-f]+$/i.test(bareHost)) return { ok: false, reason: 'ambiguous_ip_literal' };
  if (!bareHost.includes('.') && !bareHost.includes(':')) return { ok: false, reason: 'dotless_host_not_allowed' };

  let addresses;
  try {
    addresses = await resolvePublicAddresses(bareHost);
  } catch (error) {
    return { ok: false, reason: `dns_lookup_failed: ${error.message}` };
  }
  if (addresses.length === 0) return { ok: false, reason: 'dns_lookup_empty' };
  const blocked = addresses.find((entry: any) => isBlockedIpAddress(entry.address));
  if (blocked) return { ok: false, reason: `blocked_ip: ${blocked.address}` };

  return { ok: true, url: parsed.toString(), addresses: addresses.map((entry: any) => entry.address) };
}

async function assertSafeFormUrl(rawUrl) {
  const result: any = await validateFormUrlSafety(rawUrl);
  if (!result.ok) {
    throw new Error(`SSRF guard: 許可されていないURLです: ${rawUrl} (${result.reason})`);
  }
  return result.url;
}

// 1ページ読み込みで同一ホストのサブリソース (CSS/JS/画像) が 20-50 回 onBeforeRequest
// を叩き、その都度 dns.lookup していたのがロードを 1-3 秒遅らせていた。
// host:port 単位で検証結果を短 TTL キャッシュし、同一ホストの再検証を省く。
// TTL は 5s。コンタクトフォーム 1 ページのサブリソースは通常 2-3s で出揃うため
// この窓でも冗長な lookup は排除できる一方、5s なら DNS リバインディング
// (公開IP→private IP への差し替え) はほぼ不可能 (security-reviewer 指摘 HIGH 対応)。
const HOST_VALIDATION_TTL_MS = 5000;
const HOST_VALIDATION_CACHE_MAX = 512;
const _hostValidationCache = new Map(); // host:port -> { result:{ok,reason}, expiresAt }

async function validateRequestUrlCached(rawUrl) {
  let parsed;
  try { parsed = new URL(rawUrl); } catch { return { ok: false, reason: 'invalid_url' }; }
  // credentials は per-URL なのでキャッシュに依らず常に拒否
  if (parsed.username || parsed.password) return { ok: false, reason: 'url_credentials_not_allowed' };
  // zone-id (%eth0) を除去して validateFormUrlSafety と同じ正規化に揃え、port も鍵に含める。
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  const cacheKey = host + ':' + (parsed.port || '');
  const now = Date.now();
  const cached = _hostValidationCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.result;
  const result: any = await validateFormUrlSafety(rawUrl);
  const slim = { ok: result.ok, reason: result.reason };
  _hostValidationCache.set(cacheKey, { result: slim, expiresAt: now + HOST_VALIDATION_TTL_MS });
  if (_hostValidationCache.size > HOST_VALIDATION_CACHE_MAX) {
    for (const [k, v] of _hostValidationCache) { if (v.expiresAt <= now) _hostValidationCache.delete(k); }
    // 全件未期限でも cap 超過なら挿入順 (最古) から落として上限を厳守
    while (_hostValidationCache.size > HOST_VALIDATION_CACHE_MAX) {
      const oldest = _hostValidationCache.keys().next().value;
      if (oldest === undefined) break;
      _hostValidationCache.delete(oldest);
    }
  }
  return slim;
}

function isPathInsideDirectory(baseDir, targetPath) {
  const relative = path.relative(baseDir, targetPath);
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

// ── Field purpose inference ──────────────────────────────────────────────
//
// フィールドの label/placeholder/name/id から用途を推定する純関数。
// 判定優先度:
//   1) type === 'textarea'  → 'message'（本文系はほぼ textarea）
//   2) type === 'email'     → 'email'
//   3) type === 'tel'       → 'phone'
//   4) テキスト照合: label > placeholder > name > id の順で優先
//
// ラベルバリエーションをなるべく広くカバーする（和英混在・表記ゆれ対応）。
const PURPOSE_PATTERNS = [
  // kana 系は name 判定より先に除外（氏名と誤判定されないように）
  { purpose: '__kana__', patterns: [/kana/i, /furigana/i, /フリガナ/, /ふりがな/, /カナ/] },
  // message（本文系） — textarea で引っかからなかったケースの救済も兼ねる
  {
    purpose: 'message',
    patterns: [
      /お問い?合わせ内容/, /問い?合わせ内容/, /お問い?合せ内容/, /問い?合せ内容/,
      /ご質問/, /ご要望/, /ご相談内容/, /ご相談/, /ご用件/, /用件/,
      /メッセージ/, /ご意見/, /ご感想/,
      /詳細/, /本文/, /内容/, /備考/, /自由記述/, /コメント/,
      /inquiry/i, /message/i, /content/i, /comment/i, /details?/i, /body/i,
      /question/i, /remarks?/i, /note[s]?/i, /description/i,
    ],
  },
  // email
  {
    purpose: 'email',
    patterns: [/メール/, /メアド/, /e-?mail/i, /email/i, /mail(?!ing)/i, /e_mail/i],
  },
  // phone
  {
    purpose: 'phone',
    patterns: [
      /電話/, /TEL/i, /tel[-_]?no/i, /phone/i, /telephone/i, /contact[-_]?number/i,
    ],
  },
  // company
  {
    purpose: 'company',
    patterns: [
      /会社名/, /企業名/, /貴社名/, /御社名/, /法人名/, /団体名/, /事業者名/, /組織名/,
      /^会社$/, /company/i, /corporation/i, /organi[sz]ation/i, /corp\b/i, /firm\b/i,
    ],
  },
  // department
  {
    purpose: 'department',
    patterns: [/部署/, /所属/, /部門/, /department/i, /division/i, /section/i],
  },
  // title / 役職
  {
    purpose: 'title',
    patterns: [/役職/, /職位/, /肩書/, /ポジション/, /position/i, /job[-_]?title/i, /\btitle\b/i],
  },
  // address
  {
    purpose: 'address',
    patterns: [
      /住所/, /所在地/, /所在/, /市区町村/, /番地/, /ご住所/,
      /address/i, /addr\b/i, /street/i, /city/i, /prefecture/i,
    ],
  },
  // url / Webサイト
  {
    purpose: 'url',
    patterns: [
      /URL/i, /ウェブ?サイト/, /ホームページ/, /自社サイト/, /HP/,
      /website/i, /web[-_]?site/i, /homepage/i, /site[-_]?url/i,
    ],
  },
  // name（最後に判定 — 他分類より具体性が低いため）
  {
    purpose: 'name',
    patterns: [
      /お名前/, /氏名/, /担当者名/, /担当者/, /ご担当者/, /ご氏名/, /^名前$/,
      /\bname\b/i, /full[-_]?name/i, /your[-_]?name/i, /contact[-_]?name/i,
      /first[-_]?name/i, /last[-_]?name/i,
    ],
  },
];

function _matchPurpose(text) {
  if (!text) return null;
  const s = String(text);
  // kana 判定は最優先で潰す（name 系に到達させない）
  for (const { patterns } of PURPOSE_PATTERNS.filter((p: any) => p.purpose === '__kana__')) {
    if (patterns.some((re: any) => re.test(s))) return '__kana__';
  }
  for (const { purpose, patterns } of PURPOSE_PATTERNS) {
    if (purpose === '__kana__') continue;
    if (patterns.some((re: any) => re.test(s))) return purpose;
  }
  return null;
}

/**
 * フォームフィールドの type / label / placeholder / name / id から用途 (purpose) を推定する。
 * @param {{type?: string, label?: string, placeholder?: string, name?: string, id?: string}} field - 検出された 1 フィールドのメタ情報
 * @returns {('message'|'email'|'phone'|'url'|'company'|'department'|'title'|'address'|'name'|'unknown')} 推定された purpose（判定不可は 'unknown'）
 */
function inferFieldPurpose(field) {
  if (!field || typeof field !== 'object') return 'unknown';

  const type = String(field.type || '').toLowerCase();

  // type ベースの早期判定
  if (type === 'textarea') return 'message';
  if (type === 'email') return 'email';
  if (type === 'tel') return 'phone';
  if (type === 'url') return 'url';

  // label > placeholder > name > id の順で判定
  const candidates = [field.label, field.placeholder, field.name, field.id];
  for (const c of candidates) {
    const hit = _matchPurpose(c);
    if (hit && hit !== '__kana__') return hit;
    if (hit === '__kana__') {
      // kana なら name には分類しない。以降の候補も name に該当しても返さない。
      // ただし次の候補が email/phone/company 等の別カテゴリなら拾う。
      for (const rest of candidates.slice(candidates.indexOf(c) + 1)) {
        const h2 = _matchPurpose(rest);
        if (h2 && h2 !== '__kana__' && h2 !== 'name') return h2;
      }
      return 'unknown';
    }
  }
  return 'unknown';
}

/**
 * フォーム検出メタ情報から、次に取るべき推奨ステータス (proceed / proceed_then_await / skipped / error) を導出する。
 * @param {{hasCaptcha?: boolean, hasIframeForm?: boolean, iframeIsCrossOrigin?: boolean, fieldCount?: number, hasMessageField?: boolean}} [meta] - getFormStructure() が返す meta
 * @returns {{recommendedStatus: ('proceed'|'proceed_then_await'|'skipped'|'error'), recommendedReason: string}} 推奨ステータスと理由
 */
function recommendFormSessionStatus(meta: Record<string, any> = {}) {
  if (meta.hasCaptcha) {
    // 1.2.88+: CAPTCHA があってもフォーム入力自体は可能なので、入力 → スクショ →
    // awaiting_approval にする (人間が CAPTCHA 解いて送信)。フォーム項目が
    // 一つも取れていない場合だけ error フォールバック。
    if (meta.fieldCount > 0) {
      return {
        recommendedStatus: 'proceed_then_await',
        recommendedReason: 'CAPTCHA検出: 入力までは実施し、ss-{No}-input.png を残して awaiting_approval にしてください (人間が CAPTCHA 解いて送信)',
      };
    }
    return {
      recommendedStatus: 'error',
      recommendedReason: 'CAPTCHA検出 + フォーム項目 0: 入力不可なため error',
    };
  }
  if (meta.hasIframeForm && meta.iframeIsCrossOrigin && meta.fieldCount === 0) {
    return {
      recommendedStatus: 'error',
      recommendedReason: 'cross-origin iframe でフォーム項目を検出できないため入力不可',
    };
  }
  if (meta.fieldCount === 0 && !meta.hasIframeForm) {
    return {
      recommendedStatus: 'skipped',
      recommendedReason: 'フォーム項目が検出できない静的ページ（営業NG/対象外の可能性）',
    };
  }
  return {
    recommendedStatus: 'proceed',
    recommendedReason: 'フォーム項目を検出。通常フローで入力可能',
  };
}

/**
 * Electron WebContentsView を使った問い合わせフォームレビュー用セッション管理クラス。
 * SSRF ガード付きで URL を読み込み、フォーム構造解析・自動入力・スクリーンショットを提供する。
 */
class FormSessionManager {
  _getMainWindow: any;
  _sessions: Map<any, any>;
  _activeSessionId: any;
  /**
   * @param {() => (import('electron').BrowserWindow|null)} getMainWindow - メインウィンドウを返すゲッタ（破棄済みなら null）
   */
  constructor(getMainWindow: any) {
    this._getMainWindow = getMainWindow;
    // sessionId → { id, view, formUrl, companyNo, status, screenshotPath }
    this._sessions = new Map<any, any>();
    this._activeSessionId = null;
  }

  // ── Session lifecycle ────────────────────────────────────────────────

  async createSession(formUrl, companyNo) {
    const safeFormUrl: any = await assertSafeFormUrl(formUrl);

    let WebContentsView;
    try {
      ({ WebContentsView } = require('electron'));
    } catch {
      throw new Error('WebContentsView はElectronモードでのみ利用できます');
    }

    // セッション上限: 古いものから自動破棄
    if (this._sessions.size >= MAX_SESSIONS) {
      const oldest = this._sessions.keys().next().value;
      this.destroySession(oldest);
    }

    const id = crypto.randomUUID();
    const view = new WebContentsView({
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        partition: `form-session-${id}`,
      },
    });
    this._installRequestGuards(view, id);

    this._sessions.set(id, {
      id,
      view,
      formUrl: safeFormUrl,
      companyNo: String(companyNo),
      status: 'loading',
      screenshotPath: null,
      blockedUrl: null,
      blockedReason: null,
    });

    // v2.0.82: dock 呼びは dispatcher 側 (form-mcp-dispatcher.ts::navigate handler) で
    //   try-catch 化して呼ぶ。createSession 内で同期 showSession を呼ぶと、
    //   showSession 内 _positionView が Electron API 例外で throw した場合に
    //   createSession 全体が失敗扱いになる → "Error processing argument at index 0,
    //   conversion failure from undefined" で browser_navigate が連発 fail する
    //   (v0.81 実機回帰)。createSession は session 作成のみに専念させ、dock は
    //   呼び出し側 (dispatcher) の責任に分離。

    view.webContents.loadURL(safeFormUrl).catch((error) => {
      const session = this._sessions.get(id);
      if (session && session.status === 'loading') {
        session.status = 'load_failed';
        session.blockedReason = error.message;
      }
    });

    // Wait for DOM ready (with timeout)
    await this._waitForLoad(id, 20000);
    return id;
  }

  async _waitForLoad(sessionId, timeout = 20000) {
    const session = this._sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    return new Promise<void>((resolve) => {
      const onReady = () => {
        clearTimeout(timer);
        session.view.webContents.removeListener('dom-ready', onReady);
        if (session.status === 'loading') session.status = 'loaded';
        resolve();
      };

      const timer = setTimeout(() => {
        session.view.webContents.removeListener('dom-ready', onReady);
        if (session.status === 'loading') session.status = 'load_timeout';
        resolve(); // timeout はエラーにせず続行（部分ロードでも構造取得を試みる）
      }, timeout);

      if (!session.view.webContents.isLoading()) {
        onReady();
      } else {
        session.view.webContents.once('dom-ready', onReady);
      }
    });
  }

  destroySession(sessionId) {
    const session = this._sessions.get(sessionId);
    if (!session) return;

    this._removeFromWindow(sessionId);

    try { session.view.webContents.close(); } catch (_) {}

    this._sessions.delete(sessionId);
    if (this._activeSessionId === sessionId) this._activeSessionId = null;
  }

  // app quit / window-all-closed 時に呼ばれる包括的 cleanup。
  // mainWindow.close で WebContentsView が detach されず memory leak する経路を塞ぐ。
  destroyAllSessions() {
    const ids = Array.from(this._sessions.keys());
    let destroyed = 0;
    for (const id of ids) {
      try { this.destroySession(id); destroyed += 1; } catch (_) {}
    }
    return { ok: true, destroyed };
  }

  _installRequestGuards(view, sessionId) {
    const markBlocked = (url, reason) => {
      const session = this._sessions.get(sessionId);
      if (!session) return;
      session.status = 'blocked_url';
      session.blockedUrl = url;
      session.blockedReason = reason;
    };

    view.webContents.setWindowOpenHandler(({ url }) => {
      markBlocked(url, 'popup_blocked');
      return { action: 'deny' };
    });

    view.webContents.session.webRequest.onBeforeRequest(
      { urls: ['http://*/*', 'https://*/*'] },
      (details, callback) => {
        validateRequestUrlCached(details.url)
          .then((result) => {
            if (!result.ok) {
              markBlocked(details.url, result.reason);
              callback({ cancel: true });
              return;
            }
            callback({ cancel: false });
          })
          .catch((error) => {
            markBlocked(details.url, error.message);
            callback({ cancel: true });
          });
      },
    );
  }

  // ── Form inspection ─────────────────────────────────────────────────

  async getFormStructure(sessionId) {
    const session = this._sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    // v2.1.0 Bug 7 fix: 旧コードは template literal 内に TypeScript 型注釈
    //   ("const fields: unknown[]" / "el: any" / "o: any") を入れていたが、
    //   TS コンパイラは template literal 中身を変換しないため browser に
    //   SyntaxError として届く (real Electron E2E で発覚)。
    //   この文字列全体は browser 内で実行される pure JavaScript として扱う必要がある。
    const raw: any = await session.view.webContents.executeJavaScript(`
      (function () {
        var fields = [];
        var inputs = document.querySelectorAll('input, textarea, select');

        inputs.forEach(function (el) {
          if (['hidden', 'submit', 'button', 'reset', 'image'].indexOf(el.type) >= 0) return;
          if (el.offsetParent === null && el.type !== 'radio' && el.type !== 'checkbox') return;

          var label = '';
          if (el.id) {
            var lbl = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
            if (lbl) label = lbl.textContent.trim();
          }
          if (!label) {
            var parent = el.closest('.form-group, .form-field, .field, .input-wrap, li, p, div');
            if (parent) {
              var lbl2 = parent.querySelector('label, .label, .form-label');
              if (lbl2 && lbl2 !== el) label = lbl2.textContent.trim();
            }
          }

          var selector = el.id
            ? '#' + CSS.escape(el.id)
            : el.name
              ? '[name="' + el.name + '"]'
              : null;
          if (!selector) return;

          var field = {
            selector: selector,
            id: el.id || null,
            name: el.name || null,
            type: el.tagName === 'SELECT' ? 'select' : el.tagName === 'TEXTAREA' ? 'textarea' : (el.type || 'text'),
            label: label || el.placeholder || el.name || el.id || '',
            placeholder: el.placeholder || '',
            required: el.required,
          };

          if (el.tagName === 'SELECT') {
            field.options = Array.prototype.slice.call(el.options).map(function (o) {
              return { value: o.value, text: o.text.trim() };
            });
          }

          fields.push(field);
        });

        // CAPTCHA検出
        const captchaNodes = document.querySelectorAll(
          '.g-recaptcha, [data-sitekey], iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="turnstile"]'
        );
        const hasCaptcha = captchaNodes.length > 0;

        // iframe検出 + cross-origin判定
        const iframes = document.querySelectorAll('iframe');
        const hasIframeForm = iframes.length > 0;
        let iframeIsCrossOrigin = false;
        try {
          const origin = window.location.origin;
          for (const f of iframes) {
            const src = f.getAttribute('src') || '';
            if (!src) continue;
            try {
              const u = new URL(src, window.location.href);
              if (u.origin && u.origin !== origin) { iframeIsCrossOrigin = true; break; }
            } catch (_) {}
          }
        } catch (_) {}

        return { fields, hasCaptcha, hasIframeForm, iframeIsCrossOrigin };
      })()
    `);

    const rawFields = Array.isArray(raw && raw.fields) ? raw.fields : [];
    // サーバー側で用途ヒントを推定して付与する（CLIマッピング判断を支援）
    const fields = rawFields.map((f: any) => ({ ...f, purpose: inferFieldPurpose(f) }));
    const meta: any = {
      fieldCount: fields.length,
      hasCaptcha: !!(raw && raw.hasCaptcha),
      hasIframeForm: !!(raw && raw.hasIframeForm),
      iframeIsCrossOrigin: !!(raw && raw.iframeIsCrossOrigin),
      hasMessageField: fields.some((f: any) => f.purpose === 'message'),
    };

    // 推奨ステータスの判定（純粋に meta から導出）
    // - CAPTCHA検出 + フォーム項目あり → proceed_then_await (入力 → スクショ → awaiting_approval)
    // - CAPTCHA検出 + フォーム項目なし → error
    // - CAPTCHA なし + フォーム項目なし → skipped
    // - cross-origin iframe かつ項目検出不可 → error
    // - フォームなしの静的ページ → skipped（営業NGの可能性大）
    // - それ以外 → proceed
    const { recommendedStatus, recommendedReason } = recommendFormSessionStatus(meta);
    meta.recommendedStatus = recommendedStatus;
    meta.recommendedReason = recommendedReason;

    return { fields, meta };
  }

  // ── Form filling ─────────────────────────────────────────────────────

  async fillForm(sessionId, mappings) {
    const session = this._sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    // 全フィールドを 1 回の executeJavaScript でレンダラ側ループ処理する。
    // 旧実装はフィールド毎に IPC 往復していた (N フィールド = N 往復)。
    const items = (Array.isArray(mappings) ? mappings : [])
      .filter((m) => m && m.selector && m.value != null)
      .map((m) => ({ selector: String(m.selector), value: String(m.value), isSelect: m.type === 'select' }));

    if (items.length === 0) {
      session.status = 'filled';
      return [];
    }

    const script = `(function(){
      const items=${JSON.stringify(items)};
      const out=[];
      for(const it of items){
        try{
          const el=document.querySelector(it.selector);
          if(!el){out.push({selector:it.selector,ok:false,reason:'not_found'});continue;}
          if(it.isSelect){
            el.value=it.value;
            el.dispatchEvent(new Event('change',{bubbles:true}));
          }else{
            const proto=el.tagName==='TEXTAREA'?window.HTMLTextAreaElement.prototype:window.HTMLInputElement.prototype;
            const setter=Object.getOwnPropertyDescriptor(proto,'value')?.set;
            if(setter)setter.call(el,it.value);else el.value=it.value;
            el.dispatchEvent(new Event('focus',{bubbles:true}));
            el.dispatchEvent(new Event('input',{bubbles:true}));
            el.dispatchEvent(new Event('change',{bubbles:true}));
            el.dispatchEvent(new Event('blur',{bubbles:true}));
          }
          out.push({selector:it.selector,ok:true});
        }catch(e){out.push({selector:it.selector,ok:false,reason:String((e&&e.message)||e)});}
      }
      return out;
    })()`;

    let results: unknown[];
    try {
      results = await session.view.webContents.executeJavaScript(script);
    } catch (e) {
      results = items.map((it) => ({ selector: it.selector, ok: false, reason: e.message }));
    }

    session.status = 'filled';
    return Array.isArray(results) ? results : [];
  }

  // ── Screenshot ───────────────────────────────────────────────────────

  async captureScreenshot(sessionId, savePath) {
    const session = this._sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    const basename = path.basename(savePath);
    const suffixMatch = basename.match(/^ss-[a-zA-Z0-9_-]+-([a-zA-Z]+)\.png$/);
    if (!suffixMatch || !ALLOWED_SCREENSHOT_SUFFIXES.has(suffixMatch[1])) {
      throw new Error(`許可されていないスクリーンショット名: ${basename}`);
    }
    const normalizedPath = path.resolve(savePath);
    const screenshotDir = path.resolve(settings.getScreenshotDir());
    if (!isPathInsideDirectory(screenshotDir, normalizedPath)) {
      throw new Error(`パストラバーサル検出: screenshotDir 外への書き込みは禁止です`);
    }

    const dir = path.dirname(normalizedPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const image: any = await session.view.webContents.capturePage();
    fs.writeFileSync(normalizedPath, image.toPNG());
    session.screenshotPath = normalizedPath;

    return normalizedPath;
  }

  // ── View display ─────────────────────────────────────────────────────

  showSession(sessionId) {
    // v2.0.91: 旧 (~v0.90) は _positionView で winW*0.45 ベースの「右半分全面」に
    //   dock していたが、これは HTML slot 領域を完全に飛び越えて画面の右半分を
    //   占有する致命的バグ (実機: No.223 切替時に WebView が DXC コンタクトページで
    //   window 右半分を覆い、ダッシュボード UI が見えない状態)。
    //   新: HTML 側 `syncViewBounds` が POST /api/form-session/:id/set-bounds で
    //   slot bbox を渡してくるのを信頼する。それまでは picture-in-picture 風に
    //   画面外に park しておく (見えても 1x1 なので影響なし)。
    this._removeAllFromWindow(sessionId);
    this._activeSessionId = sessionId;
    const session = this._sessions.get(sessionId);
    const win = this._getMainWindow();
    if (session && session.view && win && !win.isDestroyed()) {
      try {
        const cv = win.contentView;
        if (!cv.children.includes(session.view)) cv.addChildView(session.view);
        // 画面外 park で初期化。HTML 側 syncViewBounds が即 setBounds してくれる。
        session.view.setBounds({ x: -10000, y: -10000, width: 1, height: 1 });
      } catch (_) { /* swallow — HTML side will retry via setViewBounds */ }
    }
  }

  /**
   * v2.0.86: HTML 側で計算した slot 要素の bbox (page coords) を受け取って
   * WebContentsView をその位置に正確に配置する。dashboard 側の `getBoundingClientRect()` +
   * `window.devicePixelRatio` 補正済の bounds を渡すこと。
   */
  setViewBounds(sessionId, bounds) {
    const session = this._sessions.get(sessionId);
    if (!session || !session.view) return { ok: false, reason: 'session_not_found' };
    const win = this._getMainWindow();
    if (!win || win.isDestroyed()) return { ok: false, reason: 'no_window' };
    try {
      // v2.0.92: park 用の負座標は通す。それ以外は window contentSize を越えないように
      //   hard cap。これで万一 HTML 側が誤った bounds (e.g. window 全幅) を送ってきても
      //   右半分占有のような UI 破壊を起こさない。
      const reqX = Number(bounds?.x);
      const reqY = Number(bounds?.y);
      const reqW = Number(bounds?.width);
      const reqH = Number(bounds?.height);
      const isPark = reqX <= -1000 || reqY <= -1000;
      let x: number, y: number, width: number, height: number;
      if (isPark) {
        this._removeFromWindow(sessionId);
        x = Math.floor(reqX || -10000);
        y = Math.floor(reqY || -10000);
        width = Math.max(1, Math.floor(reqW || 1));
        height = Math.max(1, Math.floor(reqH || 1));
        return { ok: true, detached: true, bounds: { x, y, width, height } };
      } else {
        // v2.0.93: 旧実装は _removeAllFromWindow で他 session を全て外していたため
        //   Phase B 並列 (3 セッション同時表示) で「結局 1 社ずつ」体験になっていた。
        //   今は keep-all で各セッションが個別の bbox に dock 可能。
        const cv = win.contentView;
        if (!cv.children.includes(session.view)) cv.addChildView(session.view);
        const [winW, winH] = win.getContentSize();
        x = Math.min(winW - 50, Math.max(0, Math.floor(reqX || 0)));
        y = Math.min(winH - 50, Math.max(0, Math.floor(reqY || 0)));
        const maxW = Math.max(50, winW - x);
        const maxH = Math.max(50, winH - y);
        width = Math.min(maxW, Math.max(50, Math.floor(reqW || 800)));
        height = Math.min(maxH, Math.max(50, Math.floor(reqH || 600)));
      }
      session.view.setBounds({ x, y, width, height });
      this._activeSessionId = sessionId;
      return { ok: true, bounds: { x, y, width, height } };
    } catch (e) {
      return { ok: false, reason: e && e.message ? e.message : String(e) };
    }
  }

  /**
   * v2.0.86: HTML 側のタブ切替で「操作中タブが non-active」の時に呼ぶ。
   * 現 session を mainWindow から detach して見えなくする。
   * destroy はしない (タブ戻ったら setViewBounds で復活)。
   */
  parkActiveView() {
    if (!this._activeSessionId) return { ok: true, parked: false };
    const session = this._sessions.get(this._activeSessionId);
    if (!session || !session.view) return { ok: true, parked: false };
    try {
      // WebContentsView は DOM の display:none に追従しないため、
      // 非表示タブでは contentView から外して確実に消す。
      this._removeFromWindow(this._activeSessionId);
      return { ok: true, parked: true, detached: true };
    } catch (e) {
      return { ok: false, reason: e && e.message ? e.message : String(e) };
    }
  }

  hideCurrentSession() {
    if (this._activeSessionId) {
      this._removeFromWindow(this._activeSessionId);
      this._activeSessionId = null;
    }
  }

  hideAllSessions() {
    const hidden = this._removeAllFromWindow(null);
    this._activeSessionId = null;
    return { ok: true, hidden };
  }

  // Called by electron-main on window resize
  onWindowResize() {
    // v2.0.91: resize 時に旧 _positionView (winW*0.45 右半分全面) を呼ぶと
    //   HTML slot を無視して dock が崩れる。HTML 側 resize listener が
    //   setViewBounds を呼ぶので main 側では何もしない。
  }

  // v2.0.91 で deprecate: 旧式 dock (winW*0.45 右半分占有) は HTML slot を
  // 無視して dashboard 上に WebView が覆いかぶさるバグの原因だった。
  // setViewBounds (HTML slot bbox 連動) に完全移行済。残置は意図的に呼ばない。
  // 残しているのは下位互換目的のみで、誰も呼ばない。
  // → 削除しても安全だが、外部から参照する古いコードがあれば落ちるので
  //   今は no-op 化しておく (型シグネチャは維持)。
  _positionView(_sessionId) {
    // intentionally no-op (v2.0.91+); use setViewBounds via HTML slot.
  }

  _removeFromWindow(sessionId) {
    const session = this._sessions.get(sessionId);
    if (!session) return;
    const win = this._getMainWindow();
    if (!win || win.isDestroyed()) return;
    try { win.contentView.removeChildView(session.view); } catch (_) {}
  }

  _removeAllFromWindow(keepSessionId) {
    let removed = 0;
    for (const [id] of this._sessions) {
      if (keepSessionId && id === keepSessionId) continue;
      this._removeFromWindow(id);
      removed += 1;
    }
    return removed;
  }

  // ── Query ────────────────────────────────────────────────────────────

  getSession(sessionId) {
    const s = this._sessions.get(sessionId);
    if (!s) return null;
    return {
      id: s.id,
      companyNo: s.companyNo,
      formUrl: s.formUrl,
      status: s.status,
      screenshotPath: s.screenshotPath,
      blockedUrl: s.blockedUrl,
      blockedReason: s.blockedReason,
      isActive: this._activeSessionId === s.id,
    };
  }

  listSessions() {
    return Array.from(this._sessions.values()).map((s: any) => ({
      id: s.id,
      companyNo: s.companyNo,
      formUrl: s.formUrl,
      status: s.status,
      blockedUrl: s.blockedUrl,
      blockedReason: s.blockedReason,
      isActive: this._activeSessionId === s.id,
    }));
  }

  get activeSessionId() {
    return this._activeSessionId;
  }
}

module.exports = { FormSessionManager, inferFieldPurpose, recommendFormSessionStatus };

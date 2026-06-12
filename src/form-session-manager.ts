'use strict';

const fs = require('fs');
const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const path = require('path');
const settings = require('./settings-manager');
const { PIERCE_RESOLVE_FN_SRC } = require('./injected/pierce-resolve');

// WebContentsView bounds for the form review pane (right 55% of content area)
const HEADER_HEIGHT = 56;
const PANEL_LEFT_RATIO = 0.45; // dashboard left panel takes 45%
const MAX_SESSIONS = 30;
const ALLOWED_SCREENSHOT_SUFFIXES = new Set(['input', 'confirm', 'sent', 'error']);
const DNS_LOOKUP_TIMEOUT_MS = 5000;
// v2.1.0: getFormStructure / fillForm の注入JS が遷移中フレームや重いページで返らない
//   ときの保険。CDP 系コマンド (cdp-bridge) の 15s ガードに揃える。
const FORM_INJECT_TIMEOUT_MS = 15000;

// v2.1.3: bot 判定 (reCAPTCHA / Turnstile 等) を抑制するためのステルス User-Agent。
//   既定の Electron UA は "...Chrome/<v> Electron/<v> Safari/537.36" のように
//   "Electron" / アプリ名トークンを含むため、サイト側に「自動化ブラウザ」と一発で
//   判別される。素の Windows Chrome 相当 (Electron/アプリ名トークン無し) に差し替える。
//   実エンジンの Chrome バージョン (process.versions.chrome) を使うので User-Agent と
//   navigator のバージョン整合が崩れない。
function buildStealthUserAgent(): string {
  const chromeFull = (process.versions && process.versions.chrome) || '131.0.0.0';
  const major = String(chromeFull).split('.')[0] || '131';
  return (
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
    'AppleWebKit/537.36 (KHTML, like Gecko) ' +
    `Chrome/${major}.0.0.0 Safari/537.36`
  );
}

const STEALTH_USER_AGENT = buildStealthUserAgent();

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
  // email 確認欄 (再入力)。email より先に判定しないと 'email' に飲み込まれ、
  //   AI が確認欄を埋め忘れて「必須項目を入力してください」になる
  {
    purpose: 'email-confirm',
    patterns: [
      /メール.*(確認|再入力)/, /(確認|再入力)(用)?.*メール/,
      /e-?mail.{0,12}(confirm|check|verif|re-?enter|again)/i,
      /(confirm|confirmation|verify|re-?enter).{0,12}e-?mail/i,
      /e?mail2\b/i, /e?mail[-_]?conf/i,
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
  if (type === 'email') {
    // type=email でも label/name が「確認/再入力」系なら email-confirm として区別する
    const confirmPatterns = PURPOSE_PATTERNS.find((p: any) => p.purpose === 'email-confirm');
    const texts = [field.label, field.placeholder, field.name, field.id];
    if (confirmPatterns && texts.some((t: any) => t && confirmPatterns.patterns.some((re: any) => re.test(String(t))))) {
      return 'email-confirm';
    }
    return 'email';
  }
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
  // v2.0.98: interactive な CAPTCHA (v2 チェックボックス/画像・hCaptcha) のみ人手が要る。
  //   不可視型 (reCAPTCHA v3 / v2-invisible / Turnstile managed) はページJSが送信時に
  //   トークンを自動付与するため、通常フローでそのまま送信できる → 要対応にしない。
  if (meta.hasCaptcha && meta.captchaInteractive) {
    // フォーム入力自体は可能なので、入力 → スクショ → awaiting_approval にする
    // (人間が CAPTCHA を解いて送信)。フォーム項目が 0 の場合だけ error フォールバック。
    if (meta.fieldCount > 0) {
      return {
        recommendedStatus: 'proceed_then_await',
        recommendedReason: 'interactive CAPTCHA検出: 入力までは実施し、ss-{No}-input.png を残して awaiting_approval にしてください (人間が CAPTCHA 解いて送信)',
      };
    }
    return {
      recommendedStatus: 'error',
      recommendedReason: 'interactive CAPTCHA検出 + フォーム項目 0: 入力不可なため error',
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

    // セッション上限: 古いものから自動破棄。ただし CAPTCHA 等で人間対応待ちの
    //   セッション / 現在アクティブなセッションは温存し、それ以外の最古を優先的に
    //   退避する。退避候補が無い (全て要対応/active) 場合のみ最古を破棄する。
    if (this._sessions.size >= MAX_SESSIONS) {
      let victim: string | null = null;
      for (const [sid, s] of this._sessions) {
        if ((s as any).captchaDetected) continue;
        if (this._activeSessionId === sid) continue;
        victim = sid;
        break;
      }
      this.destroySession(victim || this._sessions.keys().next().value);
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

    // v2.1.3: bot 判定抑制。loadURL より前に UA を差し替え、初回ナビゲーション
    //   (createSession 内 loadURL) から Electron 文字列を露出させない。
    try {
      view.webContents.setUserAgent(STEALTH_USER_AGENT);
    } catch (_) { /* setUserAgent 非対応環境は無視 (素の Electron UA で続行) */ }

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

    // v2.1.3: 一過性のネットワーク失敗 (接続リセット/一時タイムアウト/一時的な
    //   名前解決失敗) で会社が即 error に落ちるのを防ぐため、1 回だけ再試行する。
    //   ERR_ABORTED (リダイレクト由来) や SSRF ブロックは再試行しない。
    await this._loadWithRetry(id, safeFormUrl);
    return id;
  }

  async _loadWithRetry(sessionId, url, maxRetries = 1) {
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const session = this._sessions.get(sessionId);
      if (!session) return;
      session.status = 'loading';
      session.blockedReason = null;

      // 前試行で登録された dom-ready リスナーが残っていると、次試行の _waitForLoad が
      //   旧ナビゲーションの遅延 dom-ready を拾って status を誤って 'loaded' にし得る。
      //   各試行の loadURL 前に残留リスナーを除去してから新規待機を張る。
      try { session.view.webContents.removeAllListeners('dom-ready'); } catch (_) { /* no-op */ }

      session.view.webContents.loadURL(url).catch((error) => {
        const s = this._sessions.get(sessionId);
        if (s && s.status === 'loading') {
          s.status = 'load_failed';
          s.blockedReason = error.message;
        }
      });

      // Wait for DOM ready (with timeout)
      await this._waitForLoad(sessionId, 20000);

      const after = this._sessions.get(sessionId);
      if (!after) return;
      // load_failed かつ一過性エラーのときだけ再試行。それ以外は確定として抜ける。
      //   load_timeout は意図的に再試行しない: 20s 待った後の再試行は社あたり +20s 以上の
      //   遅延になり、かつ部分ロードでもフォーム構造抽出は試せるため (loaded 扱いで続行)。
      const transient = after.status === 'load_failed' && this._isTransientLoadError(after.blockedReason);
      if (!transient || attempt === maxRetries) return;
      await new Promise((r) => setTimeout(r, 800));
    }
  }

  _isTransientLoadError(reason) {
    const r = String(reason || '').toUpperCase();
    if (r.includes('ERR_ABORTED')) return false; // リダイレクト由来。再試行しない
    return (
      r.includes('ERR_CONNECTION_RESET') ||
      r.includes('ERR_CONNECTION_CLOSED') ||
      r.includes('ERR_CONNECTION_TIMED_OUT') ||
      r.includes('ERR_TIMED_OUT') ||
      r.includes('ERR_NETWORK_CHANGED') ||
      r.includes('ERR_SOCKET_NOT_CONNECTED') ||
      r.includes('ERR_EMPTY_RESPONSE') ||
      r.includes('ERR_NAME_NOT_RESOLVED')
    );
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

    // dom-ready 等の残留リスナーを掃除してから閉じる (大量処理時の zombie listener 防止)
    try { session.view.webContents.removeAllListeners(); } catch (_) {}
    try { session.view.webContents.close(); } catch (_) {}

    this._sessions.delete(sessionId);
    if (this._activeSessionId === sessionId) this._activeSessionId = null;
  }

  // v2.0.96: 指定 companyNo に紐づくセッションを全破棄する。
  //   端末アクション (awaiting_approval / submitted / skipped / error) を記録した時点で
  //   その社の WebContentsView は不要になるため呼ぶ。20 社キュー時でも常に処理中の
  //   1 ブラウザのみ生存させ、メモリ蓄積と MAX_SESSIONS の FIFO 退避衝突を防ぐ。
  //   送信 (submit) は formUrl から新規セッションを再生成するため破棄して問題ない。
  destroySessionsByCompanyNo(companyNo) {
    const target = String(companyNo);
    const ids: string[] = [];
    for (const [id, session] of this._sessions) {
      if (session && String(session.companyNo) === target) ids.push(id);
    }
    let destroyed = 0;
    for (const id of ids) {
      try { this.destroySession(id); destroyed += 1; } catch (_) {}
    }
    return { ok: true, destroyed };
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

    // v2.0.98: Playwright (playwright-core/injected) のフォーム理解アルゴリズムを移植。
    //   - アクセシブル名: aria-labelledby → aria-label → element.labels (for= と
    //     ラッピング <label> の両方を native にカバー) → title → placeholder の順。
    //   - 暗黙 role 推定 / Playwright 流の可視判定 (checkVisibility + bbox)。
    //   - open shadow DOM + 同一オリジン iframe を貫通して全フィールドを収集。
    //   - id/name 無しフィールドも data-sc-fid マーカーで取りこぼさない (fillForm 側の
    //     貫通リゾルバが解決する)。
    //   ※ この文字列全体は browser 内で実行される pure JavaScript。TS 型注釈・backtick
    //     ・${ } は使用不可。正規表現のバックスラッシュは template literal が \\ → \ に
    //     畳むため、source では二重 (例: /\\s+/g) で書くと runtime で /\s+/g になる。
    // v2.1.0: 注入JS が遷移中フレームや重い shadow ページで返らないと、executeJavaScript の
    //   Promise が settle せず MCP ツールが無期限沈黙 → AI が次へ進めず watchdog が 20 分後に
    //   error 化していた。15s で打ち切り「構造取得失敗」として AI に判断材料を返す。
    let raw: any = null;
    try {
      raw = await withTimeout(
        session.view.webContents.executeJavaScript(`
      (function () {
        function gcs(el){ try { var w = el.ownerDocument && el.ownerDocument.defaultView; return w ? w.getComputedStyle(el) : null; } catch(e){ return null; } }
        function isVisible(el){
          var s = gcs(el); if(!s) return true;
          if(s.display === 'contents'){ for(var c=el.firstElementChild;c;c=c.nextElementSibling){ if(isVisible(c)) return true; } return false; }
          if(typeof el.checkVisibility === 'function'){ try { if(!el.checkVisibility()) return false; } catch(e){} }
          if(s.visibility !== 'visible') return false;
          var r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0;
        }
        function rootOrDoc(el){ var n=el; while(n.parentNode) n=n.parentNode; return (n.nodeType===11 || n.nodeType===9) ? n : null; }
        function idRefs(el, attr){
          var ref = el.getAttribute(attr); if(!ref) return [];
          var root = rootOrDoc(el); if(!root) return [];
          var ids = ref.split(' '); var out = [];
          for(var i=0;i<ids.length;i++){ if(!ids[i]) continue; try { var f = root.querySelector('#' + CSS.escape(ids[i])); if(f && out.indexOf(f) < 0) out.push(f); } catch(e){} }
          return out;
        }
        function txt(el){ return (el.textContent || '').replace(/\\s+/g, ' ').trim(); }
        function accName(el){
          var llb = idRefs(el, 'aria-labelledby');
          if(llb.length){ var p=[]; for(var i=0;i<llb.length;i++) p.push(txt(llb[i])); var t=p.join(' ').trim(); if(t) return t; }
          var al = (el.getAttribute('aria-label') || '').trim(); if(al) return al;
          var tag = el.tagName.toUpperCase();
          if(tag==='INPUT' || tag==='TEXTAREA' || tag==='SELECT'){
            var labels = el.labels ? Array.prototype.slice.call(el.labels) : [];
            if(labels.length){ var lp=[]; for(var j=0;j<labels.length;j++) lp.push(txt(labels[j])); var lt=lp.join(' ').trim(); if(lt) return lt; }
            var title = (el.getAttribute('title') || '').trim(); if(title) return title;
            var it = (el.getAttribute('type') || '').toLowerCase();
            var textLike = (tag==='TEXTAREA') || (tag==='INPUT' && (it===''||it==='text'||it==='password'||it==='search'||it==='tel'||it==='email'||it==='url'));
            if(textLike){ var ph = (el.getAttribute('placeholder') || '').trim(); if(ph) return ph; }
          }
          var tfb = (el.getAttribute('title') || '').trim(); if(tfb) return tfb;
          return '';
        }
        function roleOf(el){
          var tag = el.tagName.toUpperCase();
          if(tag==='TEXTAREA') return 'textbox';
          if(tag==='SELECT') return (el.multiple || el.size > 1) ? 'listbox' : 'combobox';
          if(tag==='INPUT'){ var t=(el.type||'').toLowerCase();
            if(t==='hidden') return '';
            if(t==='checkbox') return 'checkbox'; if(t==='radio') return 'radio';
            if(t==='number') return 'spinbutton'; if(t==='range') return 'slider';
            if(t==='button'||t==='submit'||t==='reset'||t==='image'||t==='file') return 'button';
            if(t==='search') return el.hasAttribute('list') ? 'combobox' : 'searchbox';
            return 'textbox';
          }
          return '';
        }
        var GUID = /[0-9a-f]{8}-[0-9a-f]{4}/i;
        var fields = [];
        // v2.1.0 回帰修正: data-sc-fid は 1 セッション中ずっと安定させる。
        //   既存マーカーは温存して再利用し、未採番の要素にだけ window スコープの単調
        //   カウンタ (__scFidSeq) で新規付与する。
        //   旧 v2.0.98 は毎 snapshot で全マーカーを消去し FID=0 から採番し直していたため、
        //   AI が snapshot→入力→(確認/送信ボタン探しで)再 snapshot→click と往復する間に
        //   セレクタが揮発し、fillForm / click が not_found になって確認画面へ進めず
        //   form_fill のまま 20 分 watchdog で error 化する送信不能バグの主因だった。
        try { if(typeof window.__scFidSeq !== 'number') window.__scFidSeq = 0; } catch(e){}
        function scan(ctx, loc, depth){
          if(depth > 8) return; // fillForm search() と対称な再帰深さ防御 (stack overflow / 重いページでの暴走防止)
          var ctrls; try { ctrls = ctx.querySelectorAll('input, textarea, select'); } catch(e){ return; }
          Array.prototype.forEach.call(ctrls, function(el){
            try {
              var t = (el.type || '').toLowerCase();
              if(['hidden','submit','button','reset','image','file'].indexOf(t) >= 0) return;
              var vis = isVisible(el);
              if(!vis && t !== 'radio' && t !== 'checkbox') return;
              // 既存マーカーを再利用 (再 snapshot でも同じ値) → 無ければ単調採番で新規付与
              var fid = el.getAttribute('data-sc-fid');
              if(!fid){ try { fid = String(++window.__scFidSeq); el.setAttribute('data-sc-fid', fid); } catch(e){ fid = String(++window.__scFidSeq); } }
              // light DOM かつ clean な id があれば #id (最も安定)、それ以外は安定 data-sc-fid マーカー
              var fidSel = '[data-sc-fid="' + fid + '"]';
              var idSel = null;
              try { if(el.id && !GUID.test(el.id)) idSel = '#' + CSS.escape(el.id); } catch(e){ idSel = null; }
              var nameSel = null;
              try { var nm = el.getAttribute('name'); if(nm) nameSel = '[name="' + (window.CSS && CSS.escape ? CSS.escape(nm) : nm) + '"]'; } catch(e){ nameSel = null; }
              var sel = (loc === 'light' && idSel) ? idSel : fidSel;
              var field = {
                scFid: fid,
                selector: sel,
                fidSel: fidSel,           // 多層フォールバック用 (fillForm が sel→fidSel→idSel→nameSel で解決)
                idSel: idSel,
                nameSel: nameSel,
                id: el.id || null,
                name: el.getAttribute('name') || null,
                type: el.tagName === 'SELECT' ? 'select' : (el.tagName === 'TEXTAREA' ? 'textarea' : (el.type || 'text')),
                role: roleOf(el),
                label: accName(el) || el.getAttribute('name') || el.id || '',
                placeholder: el.getAttribute('placeholder') || '',
                // required 属性に加え aria-required="true" も必須として扱う
                //   (WordPress/CF7 等は required 属性を付けず aria-required や * 表記が多い)
                required: !!el.required || el.getAttribute('aria-required') === 'true',
                visible: vis,
                location: loc
              };
              // 入力制約をAIへ事前共有 (文字数超過・形式エラーを送信前に回避できる)
              try { var ml = el.getAttribute('maxlength'); if(ml && Number(ml) > 0) field.maxLength = Number(ml); } catch(e){}
              if(el.tagName === 'SELECT'){
                field.options = Array.prototype.slice.call(el.options).map(function(o){ return { value: o.value, text: (o.text || '').trim() }; });
                // 現在の選択値。空 (placeholder 選択中) なら AI が「選択必要」と判断できる
                field.value = el.value;
              }
              // ★ checkbox / radio は value 属性と現在のチェック状態を渡す。
              //   AI が「同意チェックボックスをチェックする」「どの選択肢を選ぶか」を
              //   一発で判断できるようにする (これが無いと再送信ループになる)。
              if(el.tagName === 'INPUT' && (t === 'checkbox' || t === 'radio')){
                field.value = el.getAttribute('value') || 'on';
                field.checked = !!el.checked;
              }
              fields.push(field);
            } catch(e){}
          });
          // open shadow roots
          var hosts; try { hosts = ctx.querySelectorAll('*'); } catch(e){ hosts = []; }
          for(var i=0;i<hosts.length;i++){ if(hosts[i].shadowRoot){ scan(hosts[i].shadowRoot, loc === 'light' ? 'shadow' : loc, depth + 1); } }
        }
        scan(document, 'light', 0);

        // ★ 送信/確認ボタン候補の収集。従来はフォーム項目しか返さず、AI が
        //   browser_evaluate でボタンを探す往復が発生していた (遅延 + 探索ミスで
        //   confirm_reached 未到達 stall の原因)。data-sc-fid マーカー付き selector を
        //   渡すので AI は snapshot → fill → click を最短 3 往復で完了できる。
        var buttons = [];
        var SUBMIT_TEXT_RE = /送信|確認|送る|申し?込|問い?合わせ|次へ|進む|同意して|登録|submit|confirm|send|next|proceed|continue|apply/i;
        function btnText(el){
          var s = '';
          try { s = el.innerText || el.textContent || el.value || el.getAttribute('aria-label') || el.getAttribute('alt') || ''; } catch(e){ s = ''; }
          return String(s).replace(/\\s+/g, ' ').trim().slice(0, 60);
        }
        function scanButtons(ctx, loc, depth){
          if(depth > 8) return;
          var els; try { els = ctx.querySelectorAll('button, input[type="submit"], input[type="button"], input[type="image"], [role="button"]'); } catch(e){ return; }
          Array.prototype.forEach.call(els, function(el){
            try {
              if(buttons.length >= 12) return;
              var tag = el.tagName.toUpperCase();
              var bt = (el.getAttribute('type') || '').toLowerCase();
              var isSubmitType = (tag === 'BUTTON' && (bt === '' || bt === 'submit')) || (tag === 'INPUT' && (bt === 'submit' || bt === 'image'));
              var label = btnText(el);
              if(!isSubmitType && !SUBMIT_TEXT_RE.test(label)) return;
              if(!isVisible(el)) return;
              var inForm = false; try { inForm = !!(el.form || (el.closest && el.closest('form'))); } catch(e){}
              var fid = el.getAttribute('data-sc-fid');
              if(!fid){ try { fid = String(++window.__scFidSeq); el.setAttribute('data-sc-fid', fid); } catch(e){ return; } }
              buttons.push({
                selector: '[data-sc-fid="' + fid + '"]',
                text: label,
                tag: tag.toLowerCase(),
                type: bt || null,
                isSubmitType: isSubmitType,
                inForm: inForm,
                location: loc
              });
            } catch(e){}
          });
          var bhosts; try { bhosts = ctx.querySelectorAll('*'); } catch(e){ bhosts = []; }
          for(var bi=0;bi<bhosts.length;bi++){ if(bhosts[bi].shadowRoot){ scanButtons(bhosts[bi].shadowRoot, loc === 'light' ? 'shadow' : loc, depth + 1); } }
        }
        scanButtons(document, 'light', 0);

        // 同一オリジン iframe 内も収集 (cross-origin は不可)
        var iframes = document.querySelectorAll('iframe');
        var iframeIsCrossOrigin = false;
        for(var k=0;k<iframes.length;k++){
          var src = iframes[k].getAttribute('src') || '';
          var fd = null;
          try { fd = iframes[k].contentDocument; } catch(e){ iframeIsCrossOrigin = true; }
          if(fd){ scan(fd, 'iframe', 0); scanButtons(fd, 'iframe', 0); }
          else if(src){ try { var u = new URL(src, window.location.href); if(u.origin && u.origin !== window.location.origin) iframeIsCrossOrigin = true; } catch(e){} }
        }

        // CAPTCHA 分類: 人間操作が必要 (interactive) か、ページJSが自動でトークンを
        //   付与する不可視型 (invisible: reCAPTCHA v3 / v2-invisible / Turnstile managed) か。
        //   不可視型はそのまま送信できるため「要対応」にしない (過剰検知の防止)。
        //   ※ CAPTCHA を解く/回避するコードは持たない。あくまで「人手が要るか」の分類のみ。
        function classifyCaptcha(){
          var grec = document.querySelector('.g-recaptcha');
          var hcap = document.querySelector('.h-captcha, iframe[src*="hcaptcha"]');
          var turnstile = document.querySelector('.cf-turnstile, iframe[src*="turnstile"]');
          var v3script = document.querySelector('script[src*="recaptcha/api.js?render="]');
          var badge = document.querySelector('.grecaptcha-badge');
          var generic = document.querySelector('[data-sitekey], iframe[src*="recaptcha"]');
          var present = !!(grec || hcap || turnstile || v3script || badge || generic);
          if(!present) return { present:false, interactive:false, kind:'none' };
          var interactive = false;
          if(grec){ var size=(grec.getAttribute('data-size')||'').toLowerCase(); if(size!=='invisible') interactive = true; }
          if(hcap) interactive = true;           // hCaptcha は基本チャレンジ型 (要人手)
          // v2.1.0 回帰修正: 汎用検出 ([data-sitekey] / iframe[src*=recaptcha]) だけが当たる
          //   ケースは reCAPTCHA v3 / invisible が大半。旧 v2.0.98 はこれを安全側で
          //   interactive=true (要対応) に倒していたが、その結果 v3 フォームまで
          //   awaiting_approval に落ち autoSendSafe=ON でも自動送信されなくなっていた。
          //   → 汎用のみは invisible 既定 (そのまま送信) に戻す。明示的な v2 チェックボックス
          //   (可視 .g-recaptcha で data-size!=='invisible') の痕跡があるときだけ interactive。
          //   ※ CAPTCHA を解く/回避するコードは一切持たない。あくまで「人手が要るか」の分類のみ。
          return { present:true, interactive:interactive, kind: interactive ? 'interactive' : 'invisible' };
        }
        var cap = classifyCaptcha();
        return {
          fields: fields,
          buttons: buttons,
          hasCaptcha: cap.present,
          captchaInteractive: cap.interactive,
          captchaKind: cap.kind,
          hasIframeForm: iframes.length > 0,
          iframeIsCrossOrigin: iframeIsCrossOrigin,
          shadowFieldCount: fields.filter(function(f){ return f.location === 'shadow'; }).length,
          iframeFieldCount: fields.filter(function(f){ return f.location === 'iframe'; }).length
        };
      })()
    `),
        FORM_INJECT_TIMEOUT_MS,
        'getFormStructure injected JS timed out',
      );
    } catch (e: any) {
      // 構造取得が固まった/失敗した → 空フィールド + error 推奨で AI に返す
      //   (無期限ハングで社単位 20 分喪失するより、即「取得失敗」を返す方が安全)
      return {
        fields: [],
        buttons: [],
        meta: {
          fieldCount: 0,
          hasCaptcha: false,
          captchaInteractive: false,
          captchaKind: 'none',
          hasIframeForm: false,
          iframeIsCrossOrigin: false,
          shadowFieldCount: 0,
          iframeFieldCount: 0,
          hasMessageField: false,
          structureError: String((e && e.message) || e),
          recommendedStatus: 'error',
          recommendedReason: 'フォーム構造の取得に失敗しました（ページ応答なし/タイムアウト）。手動確認が必要です。',
        },
      };
    }

    const rawFields = Array.isArray(raw && raw.fields) ? raw.fields : [];
    // サーバー側で用途ヒントを推定して付与する（CLIマッピング判断を支援）
    const fields = rawFields.map((f: any) => ({ ...f, purpose: inferFieldPurpose(f) }));
    // 送信ボタン候補: フォーム内 submit 型 > submit 型 > フォーム内テキスト一致 の順に
    //   並べ、先頭が「最有力の送信/確認ボタン」になるようにする (AI は通常先頭を使う)
    const rawButtons = Array.isArray(raw && raw.buttons) ? raw.buttons : [];
    const buttonScore = (b: any) => (b && b.isSubmitType ? 2 : 0) + (b && b.inForm ? 1 : 0);
    const buttons = rawButtons.slice().sort((a: any, b: any) => buttonScore(b) - buttonScore(a)).slice(0, 8);
    const meta: any = {
      fieldCount: fields.length,
      hasCaptcha: !!(raw && raw.hasCaptcha),
      captchaInteractive: !!(raw && raw.captchaInteractive),
      captchaKind: (raw && raw.captchaKind) || 'none',
      hasIframeForm: !!(raw && raw.hasIframeForm),
      iframeIsCrossOrigin: !!(raw && raw.iframeIsCrossOrigin),
      shadowFieldCount: (raw && raw.shadowFieldCount) || 0,
      iframeFieldCount: (raw && raw.iframeFieldCount) || 0,
      hasMessageField: fields.some((f: any) => f.purpose === 'message'),
      submitButtonCount: buttons.length,
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

    return { fields, buttons, meta };
  }

  // ── Form filling ─────────────────────────────────────────────────────

  async fillForm(sessionId, mappings) {
    const session = this._sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    // 全フィールドを 1 回の executeJavaScript でレンダラ側ループ処理する。
    // 旧実装はフィールド毎に IPC 往復していた (N フィールド = N 往復)。
    const items = (Array.isArray(mappings) ? mappings : [])
      .filter((m) => m && m.selector && m.value != null)
      .map((m) => ({
        selector: String(m.selector),
        // v2.1.0: data-sc-fid マーカーが SPA 再描画等で失効しても #id/[name] へ
        //   フォールバック解決できるよう、判っている代替セレクタも一緒に渡す。
        altSelectors: [m.fidSel, m.idSel, m.nameSel].filter((s) => typeof s === 'string' && s),
        value: String(m.value),
        isSelect: m.type === 'select',
      }));

    if (items.length === 0) {
      session.status = 'filled';
      return [];
    }

    // light DOM → open shadow DOM → 同一オリジン iframe を貫通して要素解決する。
    //   貫通リゾルバ resolve は src/injected/pierce-resolve.ts と単一ソース共有
    //   (click/type/select_option との非対称を防ぐ)。[data-sc-fid] マーカーで
    //   shadow/iframe 内も入力可能。native value setter は要素自身の realm を使う。
    const script = `(function(){
      var items=${JSON.stringify(items)};
      var resolve=${PIERCE_RESOLVE_FN_SRC};
      function resolveAny(it){
        var el=resolve(it.selector);
        if(el) return el;
        var alts=it.altSelectors||[];
        for(var a=0;a<alts.length;a++){ var r=resolve(alts[a]); if(r) return r; }
        return null;
      }
      // checkbox の値を「チェックする/しない」に解釈する。
      //   空 / 明示的な否定語 → false、それ以外(truthy) → チェック。
      //   getFormStructure は checkbox の value を 'on' 以上で渡すため、同意系
      //   チェックボックスは必ず truthy になりチェックされる。
      function wantChecked(v){
        var s=String(v==null?'':v).trim().toLowerCase();
        if(s===''||s==='false'||s==='0'||s==='no'||s==='off'||s==='unchecked'||s==='いいえ'||s==='しない') return false;
        return true;
      }
      var out=[];
      for(var idx=0; idx<items.length; idx++){
        var it=items[idx];
        try{
          var el=resolveAny(it);
          if(!el){out.push({selector:it.selector,ok:false,reason:'not_found'});continue;}
          var view=(el.ownerDocument&&el.ownerDocument.defaultView)||window;
          var tagU=(el.tagName||'').toUpperCase();
          var typeL=(el.type||'').toLowerCase();
          if(tagU==='INPUT' && (typeL==='checkbox' || typeL==='radio')){
            // ★ checkbox / radio: el.value 代入では state が変わらない。
            //   desired と異なるときだけ native click() でトグルし、フレームワーク
            //   (React/Vue 等) のイベントハンドラも確実に発火させる。click() が効かない
            //   実装向けに native checked setter + change/input をフォールバックで補う。
            // radio は「選びたい選択肢の要素」に対してのみ fillForm が呼ばれる前提なので
            //   常に選択(desired=true)。checkbox は値の真偽で判定する。
            var desired = (typeL==='radio') ? true : wantChecked(it.value);
            if(el.checked !== desired){
              try{ el.click(); }catch(e){}
            }
            if(el.checked !== desired){
              try{
                var cd=Object.getOwnPropertyDescriptor(view.HTMLInputElement.prototype,'checked');
                if(cd&&cd.set)cd.set.call(el,desired);else el.checked=desired;
              }catch(e){ el.checked=desired; }
              el.dispatchEvent(new view.Event('input',{bubbles:true}));
              el.dispatchEvent(new view.Event('change',{bubbles:true}));
            }
            out.push({selector:it.selector,ok:el.checked===desired,checked:el.checked});
          }else if(it.isSelect || tagU==='SELECT'){
            el.value=it.value;
            el.dispatchEvent(new view.Event('input',{bubbles:true}));
            el.dispatchEvent(new view.Event('change',{bubbles:true}));
            out.push({selector:it.selector,ok:String(el.value)===String(it.value)});
          }else{
            // 操作中タブで進行が見えるよう対象へスクロール (画面外要素の lazy 初期化対策も兼ねる)
            try{ el.scrollIntoView({block:'center',inline:'nearest'}); }catch(e){}
            var proto=tagU==='TEXTAREA'?view.HTMLTextAreaElement.prototype:view.HTMLInputElement.prototype;
            var desc=Object.getOwnPropertyDescriptor(proto,'value');
            var setter=desc&&desc.set;
            if(setter)setter.call(el,it.value);else el.value=it.value;
            el.dispatchEvent(new view.Event('focus',{bubbles:true}));
            el.dispatchEvent(new view.Event('input',{bubbles:true}));
            el.dispatchEvent(new view.Event('change',{bubbles:true}));
            el.dispatchEvent(new view.Event('blur',{bubbles:true}));
            // ★ 読み戻し検証: React 等のカスタム setter が値を捨てた / maxlength で
            //   切り詰められた場合に ok:false + applied を返す。旧実装は常に ok:true で
            //   「入力できたはずなのに必須エラー」の主因だった。
            var av=String(el.value==null?'':el.value);
            if(av===it.value){
              out.push({selector:it.selector,ok:true});
            }else{
              out.push({selector:it.selector,ok:false,reason:'value_mismatch',applied:av.slice(0,120),appliedLength:av.length,expectedLength:it.value.length});
            }
          }
        }catch(e){out.push({selector:it.selector,ok:false,reason:String((e&&e.message)||e)});}
      }
      return out;
    })()`;

    let results: unknown[];
    try {
      results = await withTimeout(
        session.view.webContents.executeJavaScript(script),
        FORM_INJECT_TIMEOUT_MS,
        'fillForm injected JS timed out',
      );
    } catch (e: any) {
      results = items.map((it) => ({ selector: it.selector, ok: false, reason: String((e && e.message) || e) }));
    }

    session.status = 'filled';
    return Array.isArray(results) ? results : [];
  }

  // ★ v2.1.4: 入力後のフォーム検証サマリ。「必須なのに未入力 / 未チェック /
  //   ラジオ未選択 / HTML5 制約違反 (形式エラー)」を送信ボタンを押す **前** に
  //   AI へ返す。これが無いと AI は送信 → サイト側エラー表示 → 原因分析 →
  //   再入力という遅い往復をしていた (「必須項目を入力してください」問題の根治)。
  //   検出は el.validity.valid (イベント非発火) を使い、ページ側の invalid
  //   ハンドラを誤爆させない。
  async getValidationSummary(sessionId) {
    const session = this._sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    const script = `(function(){
      function gcs(el){ try { var w = el.ownerDocument && el.ownerDocument.defaultView; return w ? w.getComputedStyle(el) : null; } catch(e){ return null; } }
      function isVisible(el){
        var s = gcs(el); if(!s) return true;
        if(typeof el.checkVisibility === 'function'){ try { if(!el.checkVisibility()) return false; } catch(e){} }
        if(s.visibility !== 'visible') return false;
        var r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0;
      }
      function labelOf(el){
        try {
          var al = (el.getAttribute('aria-label') || '').trim(); if(al) return al.slice(0, 60);
          var labels = el.labels ? Array.prototype.slice.call(el.labels) : [];
          if(labels.length){ var t = (labels[0].textContent || '').replace(/\\s+/g, ' ').trim(); if(t) return t.slice(0, 60); }
          return String(el.getAttribute('placeholder') || el.getAttribute('name') || el.id || '').slice(0, 60);
        } catch(e){ return ''; }
      }
      function selOf(el){
        try {
          var fid = el.getAttribute('data-sc-fid'); if(fid) return '[data-sc-fid="' + fid + '"]';
          if(el.id) return '#' + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id);
          var nm = el.getAttribute('name'); if(nm) return '[name="' + (window.CSS && CSS.escape ? CSS.escape(nm) : nm) + '"]';
        } catch(e){}
        return el.tagName ? el.tagName.toLowerCase() : '';
      }
      var problems = [];
      var radioGroups = {};
      var requiredTotal = 0;
      function scan(ctx, depth){
        if(depth > 8) return;
        var ctrls; try { ctrls = ctx.querySelectorAll('input, textarea, select'); } catch(e){ return; }
        Array.prototype.forEach.call(ctrls, function(el){
          try {
            var t = (el.type || '').toLowerCase();
            if(['hidden','submit','button','reset','image','file'].indexOf(t) >= 0) return;
            var req = !!el.required || el.getAttribute('aria-required') === 'true';
            var vis = isVisible(el);
            if(!vis && t !== 'radio' && t !== 'checkbox') return;
            if(t === 'radio'){
              var key = el.name || selOf(el);
              var g = radioGroups[key] || (radioGroups[key] = { required: false, checked: false, label: labelOf(el), selector: selOf(el) });
              if(req) g.required = true;
              if(el.checked) g.checked = true;
              return;
            }
            if(req) requiredTotal += 1;
            if(t === 'checkbox'){
              if(req && !el.checked) problems.push({ selector: selOf(el), label: labelOf(el), type: 'checkbox', reason: 'required_unchecked' });
              return;
            }
            var val = el.value == null ? '' : String(el.value);
            if(req && val.replace(/\\s+/g, '') === ''){
              problems.push({ selector: selOf(el), label: labelOf(el), type: t || el.tagName.toLowerCase(), reason: 'required_empty' });
              return;
            }
            if(el.willValidate && el.validity && !el.validity.valid){
              problems.push({ selector: selOf(el), label: labelOf(el), type: t || el.tagName.toLowerCase(), reason: 'invalid', validationMessage: String(el.validationMessage || '').slice(0, 120) });
            }
          } catch(e){}
        });
        var hosts; try { hosts = ctx.querySelectorAll('*'); } catch(e){ hosts = []; }
        for(var i=0;i<hosts.length;i++){ if(hosts[i].shadowRoot){ scan(hosts[i].shadowRoot, depth + 1); } }
      }
      scan(document, 0);
      var iframes = document.querySelectorAll('iframe');
      for(var k=0;k<iframes.length;k++){ try { var fd = iframes[k].contentDocument; if(fd) scan(fd, 0); } catch(e){} }
      for(var rk in radioGroups){
        var g2 = radioGroups[rk];
        if(g2.required){ requiredTotal += 1; if(!g2.checked) problems.push({ selector: g2.selector, label: g2.label, type: 'radio', reason: 'radio_group_unselected' }); }
      }
      return { ok: problems.length === 0, problems: problems.slice(0, 20), requiredTotal: requiredTotal };
    })()`;

    try {
      const result: any = await withTimeout(
        session.view.webContents.executeJavaScript(script),
        FORM_INJECT_TIMEOUT_MS,
        'getValidationSummary injected JS timed out',
      );
      return (result && typeof result === 'object') ? result : { ok: true, problems: [], requiredTotal: 0 };
    } catch (e: any) {
      // 検証はベストエフォート。失敗しても fill 自体は成立しているので
      //   ok:null (不明) として返し、AI 側は従来手順 (snapshot 再確認) に戻れる。
      return { ok: null, problems: [], requiredTotal: 0, error: String((e && e.message) || e) };
    }
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
      companyName: s.companyName || '',
      formUrl: s.formUrl,
      status: s.status,
      blockedUrl: s.blockedUrl,
      blockedReason: s.blockedReason,
      isActive: this._activeSessionId === s.id,
      // v2.0.97: CAPTCHA/要対応フラグ。snapshot で hasCaptcha を検出すると立つ。
      //   UI が「要対応」バナー/バッジを出し、退避時に温存するために使う。
      captchaDetected: !!s.captchaDetected,
      needsHuman: !!s.captchaDetected,
    }));
  }

  get activeSessionId() {
    return this._activeSessionId;
  }
}

module.exports = { FormSessionManager, inferFieldPurpose, recommendFormSessionStatus };

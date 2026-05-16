'use strict';

/**
 * 確認待ちカードの新デザイン (送信内容の確認パネル)。
 *
 * - dashboard.cjs の awaitingCompanies.map() の冒頭フックで
 *   `window.renderAwaitingCardOverride(c)` が呼ばれる
 * - 写真の通りのレイアウト (ヘッダ + 2カラム + フッタ) を返す
 * - スクリーンショットの拡大/縮小、編集UI(将来用)、AI実行ログを含む
 *
 * 呼び出し側: dashboard-server.cjs の buildPage() が <script> 内で展開する。
 */

const STYLE = [
  /* card frame */
  '.aw2-card{background:var(--bg-card);border:1px solid var(--border-subtle);border-radius:var(--radius-lg)!important;box-shadow:var(--shadow-ambient);margin-bottom:12px;overflow:hidden;color:var(--text-1)}',

  /* header — compact */
  '.aw2-head{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:10px 16px;border-bottom:1px solid var(--border-subtle);background:linear-gradient(135deg,rgba(37,99,235,.04) 0%,transparent 60%)}',
  '.aw2-head-left{display:flex;align-items:center;gap:10px;min-width:0;flex:1 1 auto}',
  '.aw2-head-icon{width:30px;height:30px;border-radius:8px;background:rgba(37,99,235,.12);color:var(--primary);display:flex;align-items:center;justify-content:center;flex-shrink:0}',
  '.aw2-head-icon .material-symbols-outlined{font-size:18px}',
  '.aw2-head-title{font-size:.92rem;font-weight:800;color:var(--text-1);margin:0;letter-spacing:.01em;line-height:1.2}',
  '.aw2-head-sub{font-size:.66rem;color:var(--text-2);margin:1px 0 0;line-height:1.2}',
  '.aw2-head-right{display:flex;align-items:center;gap:10px;flex-shrink:0}',
  '.aw2-acquired{display:flex;align-items:center;gap:5px;font-size:.68rem;color:var(--text-2);font-family:var(--font-mono)}',
  '.aw2-acquired .material-symbols-outlined{font-size:13px}',
  '.aw2-status{display:inline-flex;align-items:center;gap:5px;padding:4px 10px;border-radius:var(--radius-pill)!important;font-size:.68rem;font-weight:700;background:var(--success-dim);color:var(--success);border:1px solid rgba(5,150,105,.25)}',
  '.aw2-status.warn{background:var(--warning-dim);color:var(--warning);border-color:rgba(217,119,6,.25)}',
  '.aw2-status.err{background:var(--error-dim);color:var(--error);border-color:rgba(220,38,38,.25)}',
  '.aw2-status .material-symbols-outlined{font-size:13px}',

  /* body — compact */
  '.aw2-body{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:0;border-top:1px solid var(--border-subtle)}',
  '.aw2-body > section{padding:12px 16px}',
  '.aw2-body > section:first-child{border-right:1px solid var(--border-subtle)}',
  '.aw2-section-title{display:flex;align-items:center;gap:6px;font-size:.7rem;font-weight:700;color:var(--text-2);margin:0 0 8px;letter-spacing:.04em;text-transform:uppercase}',
  '.aw2-section-title .material-symbols-outlined{font-size:14px;color:var(--primary)}',

  /* screenshot viewer — compact */
  '.aw2-shot-frame{position:relative;width:100%;border:1px solid var(--border-default);border-radius:var(--radius-md)!important;background:var(--bg-deep);overflow:hidden;display:flex;align-items:center;justify-content:center;min-height:180px;max-height:380px}',
  '.aw2-shot-scroll{width:100%;height:100%;max-height:380px;overflow:auto;display:flex;align-items:flex-start;justify-content:center;padding:6px}',
  '.aw2-shot-img{display:block;max-width:100%;height:auto;transform-origin:top left;transition:transform .18s var(--ease-out-expo);cursor:zoom-in}',
  '.aw2-shot-empty{padding:28px 14px;font-size:.74rem;color:var(--text-3);text-align:center}',
  '.aw2-shot-tools{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:8px}',
  '.aw2-zoom{display:inline-flex;align-items:center;gap:1px;background:var(--bg-card);border:1px solid var(--border-default);border-radius:var(--radius-pill)!important;padding:2px 4px;box-shadow:var(--shadow-xs)}',
  '.aw2-zoom button{width:22px;height:22px;border:none;background:transparent;color:var(--text-2);font-size:.92rem;cursor:pointer;border-radius:50%!important;display:flex;align-items:center;justify-content:center;transition:background .12s}',
  '.aw2-zoom button:hover{background:var(--bg-hover);color:var(--text-1)}',
  '.aw2-zoom .aw2-zoom-val{min-width:40px;text-align:center;font-size:.7rem;font-weight:700;font-family:var(--font-mono);color:var(--text-1)}',
  '.aw2-open-tab{display:inline-flex;align-items:center;gap:4px;padding:4px 10px;font-size:.7rem;font-weight:600;border:1px solid var(--border-default);border-radius:var(--radius-md)!important;background:var(--bg-card);color:var(--text-1);cursor:pointer;transition:all .15s var(--ease-out-expo)}',
  '.aw2-open-tab:hover{background:var(--bg-raised);border-color:var(--border-strong)}',
  '.aw2-open-tab .material-symbols-outlined{font-size:13px}',

  /* timeline (used by sent card for contact history) — compact */
  '.aw2-log{margin-top:12px;border:1px solid var(--border-subtle);border-radius:var(--radius-md)!important;padding:10px 12px;background:var(--bg-surface)}',
  '.aw2-log-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px;position:relative}',
  '.aw2-log-list::before{content:"";position:absolute;left:8px;top:6px;bottom:6px;width:1px;background:var(--border-default)}',
  '.aw2-log-item{display:flex;align-items:center;gap:8px;font-size:.7rem;color:var(--text-1);position:relative}',
  '.aw2-log-dot{width:16px;height:16px;border-radius:50%!important;background:var(--success);color:#fff;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;z-index:1;border:2px solid var(--bg-surface)}',
  '.aw2-log-dot.pending{background:var(--bg-card);border-color:var(--border-default);color:var(--text-3)}',
  '.aw2-log-dot .material-symbols-outlined{font-size:11px}',
  '.aw2-log-label{flex:1 1 auto;font-weight:500}',
  '.aw2-log-time{font-size:.65rem;color:var(--text-3);font-family:var(--font-mono)}',

  /* summary — compact */
  '.aw2-fields{display:flex;flex-direction:column;gap:5px}',
  '.aw2-field{display:grid;grid-template-columns:150px minmax(0,1fr);align-items:center;gap:10px;padding:6px 10px;border:1px solid var(--border-subtle);border-radius:var(--radius-sm)!important;background:var(--bg-card);transition:background .15s,border-color .15s}',
  '.aw2-field:hover{background:var(--bg-surface);border-color:var(--border-default)}',
  '.aw2-field-label{display:flex;align-items:center;gap:6px;font-size:.7rem;font-weight:600;color:var(--text-2)}',
  '.aw2-field-label .material-symbols-outlined{font-size:14px;color:var(--text-3)}',
  '.aw2-field-value{font-size:.76rem;color:var(--text-1);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.aw2-field-value.muted{color:var(--text-3);font-style:italic}',
  '.aw2-field.tall{grid-template-columns:150px minmax(0,1fr);align-items:flex-start}',
  '.aw2-field.tall .aw2-field-value{white-space:pre-wrap;max-height:200px;overflow-y:auto;line-height:1.55;padding-right:4px;font-size:.74rem}',

  /* AI 分析詳細 — Phase Obs */
  '.aw2-insight-details{margin-top:10px;border:1px solid var(--border-subtle);border-radius:var(--radius-md)!important;background:var(--bg-surface);overflow:hidden}',
  '.aw2-insight-summary{display:flex;align-items:center;gap:6px;padding:8px 12px;cursor:pointer;font-size:.72rem;font-weight:700;color:var(--text-2);background:var(--bg-card);border-bottom:1px solid var(--border-subtle);user-select:none;list-style:none}',
  '.aw2-insight-summary::-webkit-details-marker{display:none}',
  '.aw2-insight-summary .material-symbols-outlined{font-size:14px;color:var(--primary)}',
  '.aw2-insight-summary:hover{background:var(--bg-raised)}',
  '.aw2-insight-pill{display:inline-flex;align-items:center;padding:1px 8px;border-radius:var(--radius-pill)!important;font-size:.62rem;font-weight:700;letter-spacing:.04em;text-transform:uppercase;margin-left:auto}',
  '.aw2-insight-ok{background:rgba(5,150,105,.18);color:#047857;border:1px solid rgba(5,150,105,.32)}',
  '.aw2-insight-warn{background:rgba(217,119,6,.18);color:#b45309;border:1px solid rgba(217,119,6,.32)}',
  '.aw2-insight-err{background:rgba(220,38,38,.18);color:#b91c1c;border:1px solid rgba(220,38,38,.32)}',
  '.aw2-insight-body{padding:10px 12px;display:flex;flex-direction:column;gap:6px}',
  '.aw2-insight-row{display:grid;grid-template-columns:90px minmax(0,1fr);gap:10px;align-items:flex-start;font-size:.72rem;line-height:1.45}',
  '.aw2-insight-key{color:var(--text-2);font-weight:600}',
  '.aw2-insight-val{color:var(--text-1);min-width:0;word-break:break-word}',
  '.aw2-insight-quotes{font-style:italic;color:var(--text-2);font-size:.7rem}',
  '.aw2-insight-failures{margin:0;padding:0 0 0 0;list-style:none;display:flex;flex-direction:column;gap:3px}',
  '.aw2-insight-failures li{font-size:.7rem}',
  '.aw2-insight-failures code{background:var(--bg-card);padding:1px 4px;border-radius:3px!important;font-size:.66rem;color:var(--text-1)}',

  /* footer — compact */
  '.aw2-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 16px;border-top:1px solid var(--border-subtle);background:var(--bg-surface)}',
  '.aw2-btn{display:inline-flex;align-items:center;gap:5px;padding:6px 14px;font-size:.74rem;font-weight:700;border-radius:var(--radius-sm)!important;cursor:pointer;border:1px solid transparent;transition:all .15s var(--ease-out-expo);font-family:var(--font-body)}',
  '.aw2-btn-cancel{background:var(--bg-card);color:var(--text-2);border-color:var(--border-default)}',
  '.aw2-btn-cancel:hover{background:var(--bg-raised);color:var(--text-1)}',
  '.aw2-btn-edit{background:var(--bg-card);color:var(--primary);border-color:rgba(37,99,235,.4)}',
  '.aw2-btn-edit:hover{background:var(--primary-glow);border-color:var(--primary)}',
  '.aw2-btn-edit .material-symbols-outlined{font-size:16px}',
  '.aw2-btn-send{background:var(--bg-surface);color:var(--text-1);border-color:var(--border-strong)}',
  '.aw2-btn-send:hover{background:var(--bg-hover);border-color:var(--text-2)}',
  '.aw2-btn-ai-send{background:linear-gradient(135deg,#7c3aed 0%,#2563eb 100%);color:#fff;border-color:transparent;box-shadow:0 2px 10px rgba(124,58,237,.32)}',
  '.aw2-btn-ai-send:hover{filter:brightness(1.05);box-shadow:0 4px 14px rgba(124,58,237,.42)}',
  '.aw2-btn-ai-send:disabled{opacity:.45;cursor:not-allowed!important;filter:grayscale(.5)}',
  '.aw2-btn-ai-send .material-symbols-outlined{font-size:16px}',
  '.aw2-btn-send .material-symbols-outlined{font-size:16px}',
  '.aw2-btn[disabled]{opacity:.45;cursor:not-allowed!important;pointer-events:none}',
  '.aw2-foot-right{display:flex;align-items:center;gap:8px}',
  '.aw2-form-url{font-size:.7rem;color:var(--text-3);font-family:var(--font-mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:38%}',

  /* responsive */
  '@media (max-width:960px){.aw2-body{grid-template-columns:1fr}.aw2-body > section:first-child{border-right:none;border-bottom:1px solid var(--border-subtle)}.aw2-field{grid-template-columns:1fr;gap:4px}.aw2-field-value{white-space:normal}}'
].join('\n');

const SCRIPT = `(function(){
  var STYLE_ID = 'aw2-card-style';
  var SETTINGS_CACHE = null;
  var SETTINGS_PROMISE = null;

  // i18n helper (uses the global I18N map injected by buildPage())
  function aw2T(key, fallback, params) {
    var text = fallback;
    try {
      if (typeof I18N === 'object' && I18N && typeof I18N[key] === 'string') text = I18N[key];
    } catch (_) {}
    if (params && typeof text === 'string') {
      Object.keys(params).forEach(function(k){
        text = text.replace('{' + k + '}', params[k]);
      });
    }
    return text;
  }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = ${JSON.stringify(STYLE)};
    document.head.appendChild(s);
  }

  function safeText(s) {
    s = (s == null ? '' : String(s));
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function jsArg(s) {
    return String(s == null ? '' : s).replace(/\\\\/g, '\\\\\\\\').replace(/'/g, "\\\\'");
  }

  function fmtDate(ms) {
    if (!ms) return '-';
    try {
      var lang = (typeof LANG === 'string' && LANG) ? LANG : 'ja';
      var tz = (typeof PREF_TZ === 'string' && PREF_TZ) ? PREF_TZ : undefined;
      return new Date(ms).toLocaleString(lang === 'ja' ? 'ja-JP' : undefined, tz ? { timeZone: tz } : undefined);
    } catch (_) {
      return new Date(ms).toLocaleString();
    }
  }

  function loadSettings() {
    if (SETTINGS_PROMISE) return SETTINGS_PROMISE;
    SETTINGS_PROMISE = fetch('/api/settings').then(function(r){ return r.ok ? r.json() : null; }).then(function(j){
      SETTINGS_CACHE = (j && j.settings) ? j.settings : (j || null);
      // Update placeholder fields once data lands
      document.querySelectorAll('.aw2-card[data-pending="1"]').forEach(function(card){
        var no = card.getAttribute('data-no');
        applySettingsToCard(card);
      });
      return SETTINGS_CACHE;
    }).catch(function(){ SETTINGS_CACHE = null; return null; });
    return SETTINGS_PROMISE;
  }

  function senderProfile() {
    if (!SETTINGS_CACHE) return null;
    var s = SETTINGS_CACHE;
    return s.companyProfile || (s.sender ? s.sender : null);
  }

  function applySettingsToCard(card) {
    var p = senderProfile();
    if (!p) return;
    var map = {
      'aw2-fld-contact': p.contactName || p.name || '',
      'aw2-fld-email': p.email || '',
      'aw2-fld-phone': p.phone || ''
    };
    Object.keys(map).forEach(function(cls){
      var el = card.querySelector('.' + cls);
      if (!el) return;
      var v = map[cls];
      if (v) {
        el.textContent = v;
        el.classList.remove('muted');
      }
    });
    card.removeAttribute('data-pending');
  }

  function renderField(iconName, label, value, opts) {
    opts = opts || {};
    var muted = !value;
    var displayed = value || (opts.placeholder || '—');
    var cls = 'aw2-field' + (opts.tall ? ' tall' : '');
    var valueClass = 'aw2-field-value' + (muted ? ' muted' : '') + (opts.valueClass ? ' ' + opts.valueClass : '');
    var content = opts.html ? value : safeText(displayed);
    return '<div class="' + cls + '">'
      + '<div class="aw2-field-label"><span class="material-symbols-outlined">' + iconName + '</span>' + safeText(label) + '</div>'
      + '<div class="' + valueClass + '">' + content + '</div>'
    + '</div>';
  }

  function logSteps(c) {
    var ts = c.awaitingAt || Date.now();
    var formatted = fmtDate(ts);
    return [
      { icon: 'language',         label: aw2T('awaitingCard.log.access', 'フォームページにアクセス'), time: formatted, done: !!c.hasInputScreenshot || !!c.hasAnyScreenshot },
      { icon: 'integration_instructions', label: aw2T('awaitingCard.log.parse', 'フォーム要素を認識'),  time: formatted, done: !!c.hasInputScreenshot || !!c.hasAnyScreenshot },
      { icon: 'edit_note',        label: aw2T('awaitingCard.log.fill', '情報を入力'),                  time: formatted, done: !!c.hasInputScreenshot || !!c.hasAnyScreenshot },
      { icon: 'photo_camera',     label: aw2T('awaitingCard.log.shot', 'スクリーンショット取得'),       time: formatted, done: !!c.hasInputScreenshot || !!c.hasConfirmScreenshot }
    ];
  }

  function statusInfo(c) {
    if (c.hasConfirmScreenshot) {
      return { kind: 'ok', icon: 'check_circle', label: aw2T('awaitingCard.status.sendable', 'この内容で送信可能です') };
    }
    if (c.hasInputScreenshot) {
      return { kind: 'warn', icon: 'pending_actions', label: aw2T('awaitingCard.status.partial', '入力スクリーンショット確認済み') };
    }
    return { kind: 'err', icon: 'error', label: aw2T('awaitingCard.status.noShot', 'スクリーンショット未取得') };
  }

  function screenshotSrc(c) {
    if (typeof DASHBOARD_SESSION_TOKEN !== 'string' || !DASHBOARD_SESSION_TOKEN) return null;
    var ver = Date.now();
    // API が返す *ScreenshotName を優先する。これは「実際にディスクにある
    // ファイル名」なので、has*Screenshot フラグだけで構築するとファイル名が
    // 食い違って 404 になる (例: confirm_reached が input.png を参照している
    // ケース) を回避する。
    var fname = (c.hasConfirmScreenshot && c.confirmScreenshotName)
      || (c.hasInputScreenshot && c.inputScreenshotName)
      || null;
    if (!fname) return null;
    return '/screenshots/' + encodeURIComponent(fname) + '?v=' + ver + '&session=' + encodeURIComponent(DASHBOARD_SESSION_TOKEN);
  }

  function renderLogList(c) {
    var steps = logSteps(c);
    var items = steps.map(function(s){
      var dotCls = s.done ? '' : 'pending';
      var icon = s.done ? 'check' : 'pending';
      return '<li class="aw2-log-item">'
        + '<span class="aw2-log-dot ' + dotCls + '"><span class="material-symbols-outlined">' + icon + '</span></span>'
        + '<span class="aw2-log-label">' + safeText(s.label) + '</span>'
        + '<span class="aw2-log-time">' + safeText(s.time) + '</span>'
      + '</li>';
    }).join('');
    return '<div class="aw2-log">'
      + '<div class="aw2-section-title"><span class="material-symbols-outlined">format_list_bulleted</span>' + safeText(aw2T('awaitingCard.logTitle', 'AI の実行ログ')) + '</div>'
      + '<ul class="aw2-log-list">' + items + '</ul>'
    + '</div>';
  }

  function renderShot(src) {
    if (!src) {
      return '<div class="aw2-shot-frame"><div class="aw2-shot-empty">' + safeText(aw2T('awaitingCard.shotEmpty', 'スクリーンショットがまだありません')) + '</div></div>';
    }
    return '<div class="aw2-shot-frame">'
      + '<div class="aw2-shot-scroll">'
      + '<img class="aw2-shot-img" src="' + safeText(src) + '" alt="' + safeText(aw2T('awaitingCard.shotAlt', '送信前スクリーンショット')) + '" data-zoom="1">'
      + '</div>'
    + '</div>';
  }

  function renderHeader(c, status, dateStr) {
    var no = c && (c.no != null ? c.no : c.companyNo);
    var noAttr = no != null ? safeText(String(no)) : '';
    return '<div class="aw2-head">'
      + '<div class="aw2-head-left">'
      + (noAttr
          ? '<label class="aw2-head-check" title="' + safeText(aw2T('awaitingCard.bulkCheckTitle', 'バルク操作の対象に含める')) + '" style="display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;cursor:pointer">'
              + '<input type="checkbox" class="awaiting-check" data-no="' + noAttr + '" style="width:16px;height:16px;cursor:pointer;accent-color:var(--primary)">'
            + '</label>'
          : '')
      + '<div class="aw2-head-icon"><span class="material-symbols-outlined">description</span></div>'
      + '<div>'
      + '<h3 class="aw2-head-title">' + safeText(aw2T('awaitingCard.title', '送信内容の確認')) + '</h3>'
      + '<p class="aw2-head-sub">' + safeText(aw2T('awaitingCard.subtitle', 'AI が入力した内容とスクリーンショットを確認してください')) + '</p>'
      + '</div>'
      + '</div>'
      + '<div class="aw2-head-right">'
      + '<span class="aw2-acquired"><span class="material-symbols-outlined">schedule</span>' + safeText(aw2T('awaitingCard.acquired', '取得日時:')) + '&nbsp;' + safeText(dateStr) + '</span>'
      + '<span class="aw2-status ' + (status.kind === 'ok' ? '' : (status.kind === 'warn' ? 'warn' : 'err')) + '"><span class="material-symbols-outlined">' + status.icon + '</span>' + safeText(status.label) + '</span>'
      + '</div>'
    + '</div>';
  }

  function renderLeft(c, src) {
    return '<section class="aw2-col-left">'
      + '<div class="aw2-section-title"><span class="material-symbols-outlined">image</span>' + safeText(aw2T('awaitingCard.shotTitle', 'スクリーンショットプレビュー')) + '</div>'
      + renderShot(src)
      + '<div class="aw2-shot-tools">'
      + '<div class="aw2-zoom" data-role="zoom">'
      +   '<button type="button" data-zoom-action="out" title="' + safeText(aw2T('awaitingCard.zoom.out', '縮小')) + '">−</button>'
      +   '<span class="aw2-zoom-val">100%</span>'
      +   '<button type="button" data-zoom-action="in" title="' + safeText(aw2T('awaitingCard.zoom.in', '拡大')) + '">+</button>'
      +   '<button type="button" data-zoom-action="reset" title="' + safeText(aw2T('awaitingCard.zoom.reset', 'リセット')) + '" style="font-size:.7rem;width:auto;padding:0 8px">100%</button>'
      + '</div>'
      + (src ? '<button type="button" class="aw2-open-tab" data-action="open-tab"><span class="material-symbols-outlined">open_in_new</span>' + safeText(aw2T('awaitingCard.openTab', '別タブで開く')) + '</button>' : '')
      + '</div>'
    + '</section>';
  }

  function renderRight(c) {
    var p = senderProfile();
    var industry = c.type || '';
    var defaultInquiry = aw2T('awaitingCard.field.defaultInquiry', 'サービスについて');
    var inquiryType = (p && (p.defaultInquiryType || p.inquiryType)) || (industry || defaultInquiry);
    var contactName = p ? (p.contactName || p.name || '') : '';
    var email = p ? (p.email || '') : '';
    var phone = p ? (p.phone || '') : '';
    var settingsLoadingPh = aw2T('awaitingCard.field.settingsLoading', '— (settings 取得中)');

    var fields = [
      renderField('help', aw2T('awaitingCard.field.inquiryType', 'お問い合わせ種別'), inquiryType, { valueClass: 'aw2-fld-inquiry' }),
      renderField('domain', aw2T('awaitingCard.field.company', '会社名'), c.name, { valueClass: 'aw2-fld-company' }),
      renderField('person', aw2T('awaitingCard.field.contact', '担当者名'), contactName, { valueClass: 'aw2-fld-contact', placeholder: settingsLoadingPh }),
      renderField('mail', aw2T('awaitingCard.field.email', 'メールアドレス'), email, { valueClass: 'aw2-fld-email', placeholder: settingsLoadingPh }),
      renderField('call', aw2T('awaitingCard.field.phone', '電話番号'), phone, { valueClass: 'aw2-fld-phone', placeholder: settingsLoadingPh })
    ].join('');

    var msg = c.sentMessage || '';
    var msgField = renderField('article', aw2T('awaitingCard.field.message', 'お問い合わせ内容'), msg, { tall: true, valueClass: 'aw2-fld-message' });

    // 1.2.100: sentMessage が template フォールバックの場合は警告バッジを表示。
    // CLI が details.sentMessage を渡してこなかった旧ログだと templateDraft を
    // 表示することになり、実フォーム入力との乖離が起きる (NEC ネクサ事案)。
    var draftWarning = '';
    if (c.sentMessageSource === 'template_draft_fallback') {
      draftWarning = '<div class="aw2-draft-warning" style="margin-top:8px;padding:8px 12px;background:rgba(245,158,11,.10);border:1px solid rgba(245,158,11,.35);border-radius:6px;color:#b45309;font-size:.7rem;line-height:1.55;display:flex;align-items:flex-start;gap:6px">'
        + '<span class="material-symbols-outlined" style="font-size:14px;flex-shrink:0;margin-top:1px">warning</span>'
        + '<span>' + safeText(aw2T('awaitingCard.draftWarning', '表示中の本文は Phase A の下書きであり、実際のフォーム入力本文と異なる可能性があります。スクリーンショットで実入力内容を必ず確認してください。')) + '</span>'
        + '</div>';
    }

    return '<section class="aw2-col-right">'
      + '<div class="aw2-section-title"><span class="material-symbols-outlined">checklist</span>' + safeText(aw2T('awaitingCard.summaryTitle', '入力内容のサマリー')) + '</div>'
      + '<div class="aw2-fields">' + fields + msgField + '</div>'
      + draftWarning
      + renderInsightPanel(c)
    + '</section>';
  }

  /**
   * Phase Obs: AI 分析詳細パネル。
   * c.analysisInsight に dashboard-server.cjs::extractAnalysisInsight() の
   * 出力が入っている前提。
   *   - llm: 業態判定 + フィット verdict + 信頼度 + 引用
   *   - gateFailures: sendability gate / quality gate の警告
   *   - skipReason: skipped の理由
   * データが何もない場合は空文字を返す (UI に空セクションを出さない)。
   */
  function renderInsightPanel(c) {
    var ai = c.analysisInsight;
    if (!ai || (!ai.llm && !ai.gateFailures && !ai.skipReason)) return '';

    var rows = [];
    if (ai.llm) {
      var llm = ai.llm;
      var industry = llm.industry
        ? (safeText(llm.industry.primary || '') + (llm.industry.sub_category ? ' > ' + safeText(llm.industry.sub_category) : ''))
        : '—';
      var verdictClass = llm.fitVerdict === 'send' ? 'aw2-insight-ok'
        : llm.fitVerdict === 'skip' ? 'aw2-insight-err'
        : 'aw2-insight-warn';
      var verdictLabel = llm.fitVerdict === 'send' ? '✓ ' + aw2T('awaitingCard.insight.send', '送信推奨')
        : llm.fitVerdict === 'skip' ? '✗ ' + aw2T('awaitingCard.insight.skip', '送信非推奨')
        : '? ' + aw2T('awaitingCard.insight.hold', '判定保留');
      var confidence = typeof llm.confidence === 'number' ? Math.round(llm.confidence * 100) + '%' : '—';
      var providerInfo = llm.providerUsed
        ? ' (' + safeText(llm.providerUsed) + (llm.elapsedMs ? ' ' + llm.elapsedMs + 'ms' : '') + ')'
        : '';

      rows.push(
        '<div class="aw2-insight-row"><span class="aw2-insight-key">' + safeText(aw2T('awaitingCard.insight.industry', '業態判定')) + '</span>'
        + '<span class="aw2-insight-val">' + industry + providerInfo + '</span></div>'
      );
      rows.push(
        '<div class="aw2-insight-row"><span class="aw2-insight-key">' + safeText(aw2T('awaitingCard.insight.fitScore', 'フィット度')) + '</span>'
        + '<span class="aw2-insight-val ' + verdictClass + '">' + verdictLabel + ' (' + safeText(aw2T('awaitingCard.insight.confidence', '信頼度')) + ' ' + confidence + ')</span></div>'
      );
      if (llm.fitReason) {
        rows.push(
          '<div class="aw2-insight-row"><span class="aw2-insight-key">' + safeText(aw2T('awaitingCard.insight.reason', '理由')) + '</span>'
          + '<span class="aw2-insight-val">' + safeText(llm.fitReason) + '</span></div>'
        );
      }
      if (llm.mainOfferings && llm.mainOfferings.length > 0) {
        rows.push(
          '<div class="aw2-insight-row"><span class="aw2-insight-key">' + safeText(aw2T('awaitingCard.insight.mainOfferings', '主力')) + '</span>'
          + '<span class="aw2-insight-val">' + llm.mainOfferings.map(safeText).join(' / ') + '</span></div>'
        );
      }
      if (llm.evidenceQuotes && llm.evidenceQuotes.length > 0) {
        var quotes = llm.evidenceQuotes.map(function(q){ return '「' + safeText(q) + '」'; }).join('<br>');
        rows.push(
          '<div class="aw2-insight-row"><span class="aw2-insight-key">' + safeText(aw2T('awaitingCard.insight.quotes', '原文引用')) + '</span>'
          + '<span class="aw2-insight-val aw2-insight-quotes">' + quotes + '</span></div>'
        );
      }
    }

    if (ai.gateFailures && ai.gateFailures.length > 0) {
      var failItems = ai.gateFailures.map(function(f){
        var sev = f.severity === 'fatal' ? '🔴'
          : f.severity === 'skip' ? '⛔'
          : f.severity === 'warn' ? '⚠️'
          : 'ℹ️';
        return '<li>' + sev + ' <code>' + safeText(f.name) + '</code>: ' + safeText(f.reason) + '</li>';
      }).join('');
      rows.push(
        '<div class="aw2-insight-row"><span class="aw2-insight-key">' + safeText(aw2T('awaitingCard.insight.qualityCheck', '品質チェック')) + '</span>'
        + '<span class="aw2-insight-val"><ul class="aw2-insight-failures">' + failItems + '</ul></span></div>'
      );
    }

    if (rows.length === 0) return '';

    return '<details class="aw2-insight-details" open>'
      + '<summary class="aw2-insight-summary">'
      + '<span class="material-symbols-outlined">psychology</span>' + safeText(aw2T('awaitingCard.insightTitle', 'AI 分析詳細'))
      + (ai.llm && ai.llm.fitVerdict ? ' <span class="aw2-insight-pill ' + (ai.llm.fitVerdict === 'send' ? 'aw2-insight-ok' : ai.llm.fitVerdict === 'skip' ? 'aw2-insight-err' : 'aw2-insight-warn') + '">' + safeText(ai.llm.fitVerdict) + '</span>' : '')
      + '</summary>'
      + '<div class="aw2-insight-body">' + rows.join('') + '</div>'
      + '</details>';
  }

  function renderFooter(c) {
    var nameArg = jsArg(c.name);
    var formUrl = c.formUrl ? safeText(c.formUrl) : '';
    var canSend = !!(c.hasInputScreenshot || c.hasConfirmScreenshot);
    // CAPTCHA / 営業NG など AI に submit させても通らないものは
    // captchaDetected フラグ等でフィルタする。それ以外は AI submit を提示。
    var aiSubmitDisabled = !!c.captchaDetected;
    var aiSubmitTitle = aiSubmitDisabled
      ? aw2T('awaitingCard.btn.aiSend.disabledCaptcha', 'CAPTCHA / 認証が要求されているため AI 送信できません。ブラウザで手動送信してください')
      : aw2T('awaitingCard.btn.aiSend.title', 'AI に再度フォームを開かせ、submit ボタンをクリックさせます (実送信)');
    return '<div class="aw2-foot">'
      + '<button type="button" class="aw2-btn aw2-btn-cancel" data-action="cancel">' + safeText(aw2T('awaitingCard.btn.cancel', 'キャンセル')) + '</button>'
      + '<div class="aw2-foot-right">'
      + (formUrl ? '<span class="aw2-form-url" title="' + formUrl + '">' + formUrl + '</span>' : '')
      + '<button type="button" class="aw2-btn aw2-btn-edit" data-action="edit"><span class="material-symbols-outlined">edit</span>' + safeText(aw2T('awaitingCard.btn.edit', '編集して修正')) + '</button>'
      // 送信フローは 2 ボタンに分離:
      //  1. ai-send: AI に実際に submit ボタンをクリックさせる (実送信)
      //  2. send: ユーザーがブラウザで手動送信したことを記録するだけ (実送信なし)
      + '<button type="button" class="aw2-btn aw2-btn-ai-send" data-action="ai-send"'
        + (aiSubmitDisabled ? ' disabled' : '')
        + ' title="' + safeText(aiSubmitTitle) + '">'
        + '<span class="material-symbols-outlined">smart_toy</span>' + safeText(aw2T('awaitingCard.btn.aiSend', 'AI に送信させる')) + '</button>'
      + '<button type="button" class="aw2-btn aw2-btn-send" data-action="send"'
        + (canSend ? '' : ' disabled')
        + ' title="' + safeText(aw2T('awaitingCard.btn.manualSend.title', 'ブラウザで自分で送信してから「送信済み」として記録します (実送信は行いません)')) + '">'
        + '<span class="material-symbols-outlined">check</span>' + safeText(aw2T('awaitingCard.btn.manualSend', '手動送信を記録')) + '</button>'
      + '</div>'
    + '</div>';
  }

  function renderCard(c) {
    ensureStyle();
    if (!SETTINGS_CACHE) loadSettings();

    var status = statusInfo(c);
    var dateStr = fmtDate(c.awaitingAt);
    var src = screenshotSrc(c);
    var pending = SETTINGS_CACHE ? '' : ' data-pending="1"';

    return '<div class="aw2-card awaiting-card" data-no="' + c.no + '" data-name="' + safeText(c.name) + '" data-state="' + safeText(c.lastAction || '') + '" data-has-input="' + (c.hasInputScreenshot ? '1' : '0') + '" data-has-confirm="' + (c.hasConfirmScreenshot ? '1' : '0') + '" data-has-any="' + (c.hasAnyScreenshot ? '1' : '0') + '" data-ready-approval="' + (c.readyForApproval ? '1' : '0') + '" data-form-url="' + safeText(c.formUrl || '') + '"' + pending + '>'
      + renderHeader(c, status, dateStr)
      + '<div class="aw2-body">'
      +   renderLeft(c, src)
      +   renderRight(c)
      + '</div>'
      + renderFooter(c)
    + '</div>';
  }

  // event delegation for buttons + zoom
  function bindGlobal() {
    if (window.__aw2Bound) return;
    window.__aw2Bound = true;

    document.addEventListener('click', function(ev){
      var card = ev.target.closest && ev.target.closest('.aw2-card');
      if (!card) return;
      var no = card.getAttribute('data-no');
      var name = card.getAttribute('data-name') || '';
      var actionEl = ev.target.closest('[data-action]');
      if (actionEl) {
        var action = actionEl.getAttribute('data-action');
        if (action === 'send') {
          ev.preventDefault();
          // Manual-send record: no real send. Confirm dialog to avoid mis-clicks.
          // Note: this file is wrapped in a template literal, so use \\n inside strings.
          var confirmed = confirm(aw2T('awaitingCard.confirm.manualSend', 'これは「実ブラウザで自分で送信ボタンを押した」という記録のみ残します。\\n実送信は行いません。\\n\\nブラウザのフォーム確認画面で送信済みですか？'));
          if (!confirmed) return;
          if (typeof window.approveCompany === 'function') window.approveCompany(parseInt(no, 10), name, 'sent');
        } else if (action === 'ai-send') {
          ev.preventDefault();
          // AI reopens the form and clicks submit (real send)
          var ok = confirm(aw2T('awaitingCard.confirm.aiSend', 'AI が {name} のフォームを再度開いて送信ボタンをクリックします。\\n所要時間は 1〜3 分程度です。実行しますか？', { name: (name || '#' + no) }));
          if (!ok) return;
          if (typeof window.aiSubmitForm === 'function') {
            window.aiSubmitForm(parseInt(no, 10), name, actionEl);
          } else if (typeof window.toast === 'function') {
            window.toast(aw2T('awaitingCard.aiSend.unavailable', 'AI 送信機能は 1.2.37+ で利用可能です。アップデート後に再度お試しください。'), 'warn');
          } else {
            alert(aw2T('awaitingCard.aiSend.unavailable', 'AI 送信機能は 1.2.37+ で利用可能です。アップデート後に再度お試しください。'));
          }
        } else if (action === 'cancel') {
          ev.preventDefault();
          if (typeof window.skipWithFeedback === 'function') window.skipWithFeedback(parseInt(no, 10), name);
        } else if (action === 'edit') {
          ev.preventDefault();
          if (typeof window.openAwaitingEditor === 'function') window.openAwaitingEditor(parseInt(no, 10), name, card);
          else if (typeof window.toast === 'function') window.toast(aw2T('awaitingCard.editComingSoon', '編集機能は近日対応'), 'info');
          else alert(aw2T('awaitingCard.editComingSoon', '編集機能は近日対応'));
        } else if (action === 'open-tab') {
          ev.preventDefault();
          var img = card.querySelector('.aw2-shot-img');
          if (img && img.src) window.open(img.src, '_blank');
        }
        return;
      }
      var zoomBtn = ev.target.closest('[data-zoom-action]');
      if (zoomBtn) {
        ev.preventDefault();
        var img = card.querySelector('.aw2-shot-img');
        if (!img) return;
        var current = parseInt(img.getAttribute('data-zoom') || '1', 10) || 1;
        var z = current;
        var which = zoomBtn.getAttribute('data-zoom-action');
        if (which === 'in') z = Math.min(4, Math.round((current + 0.25) * 100) / 100);
        else if (which === 'out') z = Math.max(0.5, Math.round((current - 0.25) * 100) / 100);
        else if (which === 'reset') z = 1;
        img.setAttribute('data-zoom', String(z));
        img.style.transform = 'scale(' + z + ')';
        var label = card.querySelector('.aw2-zoom-val');
        if (label) label.textContent = Math.round(z * 100) + '%';
        return;
      }
    }, false);
  }

  bindGlobal();
  ensureStyle();

  // expose render override consumed by dashboard.cjs
  window.renderAwaitingCardOverride = renderCard;

  // 「AI に送信させる」 → /api/ai-submit-final にディスパッチ。
  // 完了は live-monitor 経由で観測。ボタン側で busy 状態 (data-busy=1) を立てる。
  // 1.2.92 F3 fix: 同一カード内の他ボタン (キャンセル/編集/手動送信) も同時 disable
  // することでダブルクリック / 同時クリックの状態破損を防ぐ。
  window.aiSubmitForm = function (companyNo, companyName, btnEl) {
    if (btnEl) {
      btnEl.setAttribute('data-busy', '1');
      btnEl.disabled = true;
      // 1.2.94 U1: ボタンに spinner + ETA テキスト
      btnEl.dataset.originalText = btnEl.dataset.originalText || btnEl.innerHTML;
      btnEl.innerHTML = '<span style=\\'display:inline-block;width:12px;height:12px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:aw-spin 0.8s linear infinite;margin-right:6px;vertical-align:-2px\\'></span>' + safeText(aw2T('awaitingCard.aiSend.busy', '送信中... (約 1-3 分)'));
      // カード内の他ボタンも同時 disable
      var card = btnEl.closest('.aw2-card, .awaiting-card');
      if (card) {
        var allBtns = card.querySelectorAll('button');
        allBtns.forEach(function (b) { if (b !== btnEl) { b.setAttribute('data-busy-sibling', '1'); b.disabled = true; } });
      }
    }
    // ensure spinner CSS animation defined once
    if (!document.getElementById('aw-spin-style')) {
      var st = document.createElement('style');
      st.id = 'aw-spin-style';
      st.textContent = '@keyframes aw-spin{to{transform:rotate(360deg)}}';
      document.head.appendChild(st);
    }
    fetch('/api/ai-submit-final', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ companyNo: companyNo, companyName: companyName })
    }).then(function (r) {
      return r.json().then(function (j) { return { status: r.status, body: j }; }).catch(function () { return { status: r.status, body: null }; });
    }).then(function (resp) {
      if (resp && resp.body && resp.body.ok) {
        // 1.2.94 U1: progress feedback via toast
        if (typeof window.toast === 'function') {
          window.toast(aw2T('awaitingCard.toast.queued', 'AI 送信タスクをキューしました (1〜3 分で完了)。右下のライブモニタ または「CLI Activity」タブで進捗確認できます。'), 'success');
        } else {
          alert(aw2T('awaitingCard.alert.queuedAlt', 'AI 送信タスクをキューしました。\\n進捗は右下のライブモニタ または「CLI Activity」タブで確認してください。'));
        }
        // ライブモニタ FAB を自動 open (ユーザーの目線を進捗に向ける)
        try {
          var fab = document.getElementById('monitorFab');
          var panel = document.getElementById('monitorPanel');
          if (fab && (!panel || panel.style.display === 'none' || !panel.classList.contains('open'))) {
            fab.click();
          }
        } catch (_) {}
      } else {
        var msg = (resp && resp.body && resp.body.error) || ('HTTP ' + (resp && resp.status));
        var failPrefix = aw2T('awaitingCard.aiSend.failPrefix', 'AI 送信失敗: ');
        if (typeof window.toast === 'function') window.toast(failPrefix + msg, 'error');
        else alert(failPrefix + msg);
        if (btnEl) {
        btnEl.removeAttribute('data-busy'); btnEl.disabled = false;
        // 1.2.94 U1: 元のボタン文言復元
        if (btnEl.dataset.originalText) { btnEl.innerHTML = btnEl.dataset.originalText; delete btnEl.dataset.originalText; }
        var card2 = btnEl.closest('.aw2-card, .awaiting-card');
        if (card2) {
          card2.querySelectorAll('button[data-busy-sibling=\\'1\\']').forEach(function (b) {
            b.removeAttribute('data-busy-sibling'); b.disabled = false;
          });
        }
      }
      }
    }).catch(function (e) {
      var msg = (e && e.message) || String(e);
      var failPrefix2 = aw2T('awaitingCard.aiSend.failPrefix', 'AI 送信失敗: ');
      if (typeof window.toast === 'function') window.toast(failPrefix2 + msg, 'error');
      else alert(failPrefix2 + msg);
      if (btnEl) {
        btnEl.removeAttribute('data-busy'); btnEl.disabled = false;
        // 1.2.94 U1: 元のボタン文言復元
        if (btnEl.dataset.originalText) { btnEl.innerHTML = btnEl.dataset.originalText; delete btnEl.dataset.originalText; }
        var card2 = btnEl.closest('.aw2-card, .awaiting-card');
        if (card2) {
          card2.querySelectorAll('button[data-busy-sibling=\\'1\\']').forEach(function (b) {
            b.removeAttribute('data-busy-sibling'); b.disabled = false;
          });
        }
      }
    });
  };
})();`;

module.exports = function renderAwaitingCardRedesignScript() {
  return SCRIPT;
};

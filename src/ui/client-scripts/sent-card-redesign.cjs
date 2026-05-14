'use strict';

/**
 * 送信済みカードの新デザイン (送信済み内容の確認パネル)。
 *
 * - dashboard.cjs の sentCompanies.map() の冒頭フックで
 *   `window.renderSentCardOverride(c)` が呼ばれる
 * - 確認待ち redesign と同じ .aw2-* スタイルを再利用
 * - 「AI 実行ログ」の代わりに「連絡履歴 (contactHistory)」を時系列表示
 * - フッタは情報主体: フォームURL + 返信を記録(将来用stub) + 編集して再送(将来用stub)
 */

const RESEND_STYLE = [
  '.aw2-modal-overlay{position:fixed;inset:0;background:rgba(15,23,42,.55);backdrop-filter:blur(4px);z-index:9990;display:flex;align-items:center;justify-content:center;padding:24px;animation:aw2ModalFade .15s ease}',
  '.aw2-modal{background:var(--bg-card);color:var(--text-1);border:1px solid var(--border-default);border-radius:var(--radius-lg)!important;box-shadow:var(--shadow-modal);width:min(640px,100%);max-height:88vh;display:flex;flex-direction:column;overflow:hidden;animation:aw2ModalIn .2s var(--ease-out-expo)}',
  '@keyframes aw2ModalFade{from{opacity:0}to{opacity:1}}',
  '@keyframes aw2ModalIn{from{opacity:0;transform:translateY(8px) scale(.98)}to{opacity:1;transform:translateY(0) scale(1)}}',
  '.aw2-modal-head{display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:1px solid var(--border-subtle);background:linear-gradient(135deg,rgba(37,99,235,.06) 0%,transparent 70%)}',
  '.aw2-modal-icon{width:30px;height:30px;border-radius:8px;background:rgba(37,99,235,.12);color:var(--primary);display:flex;align-items:center;justify-content:center;flex-shrink:0}',
  '.aw2-modal-icon .material-symbols-outlined{font-size:18px}',
  '.aw2-modal-title{font-size:.92rem;font-weight:800;margin:0}',
  '.aw2-modal-sub{font-size:.7rem;color:var(--text-2);margin:1px 0 0}',
  '.aw2-modal-close{margin-left:auto;background:none;border:none;cursor:pointer;color:var(--text-3);padding:4px;border-radius:6px;display:flex;align-items:center;justify-content:center}',
  '.aw2-modal-close:hover{color:var(--text-1);background:var(--bg-hover)}',
  '.aw2-modal-body{padding:14px 18px;overflow-y:auto;display:flex;flex-direction:column;gap:10px}',
  '.aw2-modal-meta{font-size:.7rem;color:var(--text-2);display:flex;flex-wrap:wrap;gap:10px;background:var(--bg-surface);border:1px solid var(--border-subtle);border-radius:var(--radius-sm);padding:8px 10px}',
  '.aw2-modal-meta b{color:var(--text-1);font-weight:700}',
  '.aw2-modal-label{font-size:.7rem;font-weight:700;color:var(--text-2);text-transform:uppercase;letter-spacing:.05em;margin:6px 0 0}',
  '.aw2-modal textarea{width:100%;min-height:240px;padding:10px 12px;border:1px solid var(--border-default);border-radius:var(--radius-md)!important;background:var(--bg-deep);color:var(--text-1);font-size:.82rem;font-family:var(--font-body);line-height:1.65;resize:vertical;transition:border-color .15s,box-shadow .15s}',
  '.aw2-modal textarea:focus{outline:none;border-color:var(--primary);box-shadow:0 0 0 3px rgba(37,99,235,.15)}',
  '.aw2-modal-counter{font-size:.66rem;color:var(--text-3);text-align:right;font-family:var(--font-mono)}',
  '.aw2-modal-foot{display:flex;justify-content:flex-end;gap:8px;padding:12px 18px;border-top:1px solid var(--border-subtle);background:var(--bg-surface)}',
  '.aw2-modal-error{display:none;padding:8px 12px;background:var(--error-dim);color:var(--error);border:1px solid rgba(220,38,38,.25);border-radius:var(--radius-sm);font-size:.74rem}',
  '.aw2-modal-error.visible{display:block}',
  '.aw2-modal .aw2-btn-send[data-busy="1"]{opacity:.7;cursor:wait!important;pointer-events:none}'
].join('\n');

const SCRIPT = `(function(){
  function safeText(s) {
    s = (s == null ? '' : String(s));
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
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

  // settings cache shared by awaiting redesign — fall back to local fetch if not yet present
  var SETTINGS_CACHE = null;
  var SETTINGS_PROMISE = null;
  function loadSettings() {
    if (SETTINGS_PROMISE) return SETTINGS_PROMISE;
    SETTINGS_PROMISE = fetch('/api/settings').then(function(r){ return r.ok ? r.json() : null; }).then(function(j){
      SETTINGS_CACHE = (j && j.settings) ? j.settings : (j || null);
      document.querySelectorAll('.aw2-card.sent[data-pending="1"]').forEach(function(card){
        applySettingsToCard(card);
      });
      return SETTINGS_CACHE;
    }).catch(function(){ return null; });
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
    return '<div class="' + cls + '">'
      + '<div class="aw2-field-label"><span class="material-symbols-outlined">' + iconName + '</span>' + safeText(label) + '</div>'
      + '<div class="' + valueClass + '">' + safeText(displayed) + '</div>'
    + '</div>';
  }

  function screenshotSrc(c) {
    if (typeof DASHBOARD_SESSION_TOKEN !== 'string' || !DASHBOARD_SESSION_TOKEN) return null;
    var ver = Date.now();
    // API が返す *ScreenshotName を信頼する。confirmScreenshotName が
    // 'ss-213-input.png' のように input ファイルを指していても正しく開ける。
    // sent → confirm → input の優先で fall-back。
    var fname = (c.hasSentScreenshot && c.sentScreenshotName)
      || (c.hasConfirmScreenshot && c.confirmScreenshotName)
      || (c.hasInputScreenshot && c.inputScreenshotName)
      || null;
    if (!fname) return null;
    return '/screenshots/' + encodeURIComponent(fname) + '?v=' + ver + '&session=' + encodeURIComponent(DASHBOARD_SESSION_TOKEN);
  }

  function renderShot(src) {
    if (!src) {
      return '<div class="aw2-shot-frame"><div class="aw2-shot-empty">スクリーンショットがありません</div></div>';
    }
    return '<div class="aw2-shot-frame">'
      + '<div class="aw2-shot-scroll">'
      + '<img class="aw2-shot-img" src="' + safeText(src) + '" alt="送信時スクリーンショット" data-zoom="1">'
      + '</div>'
    + '</div>';
  }

  function statusInfo(c) {
    var history = Array.isArray(c.contactHistory) ? c.contactHistory : [];
    var latest = history.length ? history[history.length - 1] : null;
    var resp = latest ? String(latest.response || '') : '';
    if (/replied|返信あり/i.test(resp)) return { kind: 'ok', icon: 'mark_email_read', label: '返信あり' };
    if (/meeting|商談/i.test(resp)) return { kind: 'ok', icon: 'event_available', label: '商談設定' };
    if (resp) return { kind: 'warn', icon: 'forum', label: resp };
    return { kind: 'ok', icon: 'check_circle', label: '送信済み' };
  }

  function renderHistoryTimeline(c) {
    var history = Array.isArray(c.contactHistory) ? c.contactHistory : [];
    if (history.length === 0) {
      return '<div class="aw2-log">'
        + '<div class="aw2-section-title"><span class="material-symbols-outlined">timeline</span>連絡履歴</div>'
        + '<div style="font-size:.74rem;color:var(--text-3);padding:6px 4px">この企業への連絡は本件のみです。</div>'
      + '</div>';
    }
    var items = history.map(function(h){
      var resp = String(h.response || '').trim();
      var dot;
      var dotIcon = 'check';
      if (/replied|返信あり/i.test(resp)) { dot = ''; dotIcon = 'mark_email_read'; }
      else if (/meeting|商談/i.test(resp)) { dot = ''; dotIcon = 'event_available'; }
      else if (resp) { dot = ' pending'; dotIcon = 'pending'; }
      else { dot = ' pending'; dotIcon = 'schedule'; }
      var d = h.date ? fmtDate(h.date) : '-';
      var preview = h.message ? safeText(String(h.message).substring(0, 80)) : '';
      var respChip = resp ? '<span style="font-size:.62rem;font-weight:700;padding:1px 7px;border-radius:var(--radius-pill);background:var(--bg-raised);color:var(--text-2);margin-right:6px">' + safeText(resp) + '</span>' : '';
      return '<li class="aw2-log-item">'
        + '<span class="aw2-log-dot' + dot + '"><span class="material-symbols-outlined">' + dotIcon + '</span></span>'
        + '<span class="aw2-log-label" style="display:flex;flex-direction:column;gap:2px;min-width:0;flex:1 1 auto">'
        +   '<span style="display:flex;align-items:center;gap:6px;font-size:.74rem;font-weight:600">' + respChip + '<span style="color:var(--text-3);font-family:var(--font-mono);font-size:.7rem">' + safeText(d) + '</span></span>'
        +   (preview ? '<span style="font-size:.7rem;color:var(--text-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + preview + '</span>' : '')
        + '</span>'
      + '</li>';
    }).join('');
    return '<div class="aw2-log">'
      + '<div class="aw2-section-title"><span class="material-symbols-outlined">timeline</span>連絡履歴 (' + history.length + ')</div>'
      + '<ul class="aw2-log-list">' + items + '</ul>'
    + '</div>';
  }

  function renderHeader(c, status, dateStr) {
    var count = c.contactCount || 1;
    var countBadge = count >= 2
      ? '<span class="aw2-status warn" style="margin-left:6px"><span class="material-symbols-outlined">repeat</span>' + count + '回目の連絡</span>'
      : '';
    return '<div class="aw2-head">'
      + '<div class="aw2-head-left">'
      + '<div class="aw2-head-icon" style="background:var(--success-dim);color:var(--success)"><span class="material-symbols-outlined">mark_email_read</span></div>'
      + '<div>'
      + '<h3 class="aw2-head-title">送信済みの内容</h3>'
      + '<p class="aw2-head-sub">送信済みフォームの入力内容と連絡履歴を確認できます</p>'
      + '</div>'
      + '</div>'
      + '<div class="aw2-head-right">'
      + '<span class="aw2-acquired"><span class="material-symbols-outlined">schedule</span>送信日時:&nbsp;' + safeText(dateStr) + '</span>'
      + '<span class="aw2-status ' + (status.kind === 'ok' ? '' : (status.kind === 'warn' ? 'warn' : 'err')) + '"><span class="material-symbols-outlined">' + status.icon + '</span>' + safeText(status.label) + '</span>'
      + countBadge
      + '</div>'
    + '</div>';
  }

  function renderLeft(c, src) {
    return '<section class="aw2-col-left">'
      + '<div class="aw2-section-title"><span class="material-symbols-outlined">image</span>スクリーンショットプレビュー</div>'
      + renderShot(src)
      + '<div class="aw2-shot-tools">'
      + '<div class="aw2-zoom" data-role="zoom">'
      +   '<button type="button" data-zoom-action="out" title="縮小">−</button>'
      +   '<span class="aw2-zoom-val">100%</span>'
      +   '<button type="button" data-zoom-action="in" title="拡大">+</button>'
      +   '<button type="button" data-zoom-action="reset" title="リセット" style="font-size:.7rem;width:auto;padding:0 8px">100%</button>'
      + '</div>'
      + (src ? '<button type="button" class="aw2-open-tab" data-action="open-tab"><span class="material-symbols-outlined">open_in_new</span>別タブで開く</button>' : '')
      + '</div>'
      + renderHistoryTimeline(c)
    + '</section>';
  }

  function renderRight(c) {
    var p = senderProfile();
    var industry = c.type || '';
    var inquiryType = (p && (p.defaultInquiryType || p.inquiryType)) || (industry || 'サービスについて');
    var contactName = p ? (p.contactName || p.name || '') : '';
    var email = p ? (p.email || '') : '';
    var phone = p ? (p.phone || '') : '';

    var fields = [
      renderField('help', 'お問い合わせ種別', inquiryType, { valueClass: 'aw2-fld-inquiry' }),
      renderField('domain', '会社名', c.name, { valueClass: 'aw2-fld-company' }),
      renderField('person', '担当者名', contactName, { valueClass: 'aw2-fld-contact', placeholder: '— (settings 取得中)' }),
      renderField('mail', 'メールアドレス', email, { valueClass: 'aw2-fld-email', placeholder: '— (settings 取得中)' }),
      renderField('call', '電話番号', phone, { valueClass: 'aw2-fld-phone', placeholder: '— (settings 取得中)' })
    ].join('');

    var msg = c.sentMessage || '';
    var msgField = renderField('article', '送信した本文', msg, { tall: true, valueClass: 'aw2-fld-message' });

    return '<section class="aw2-col-right">'
      + '<div class="aw2-section-title"><span class="material-symbols-outlined">checklist</span>送信内容のサマリー</div>'
      + '<div class="aw2-fields">' + fields + msgField + '</div>'
    + '</section>';
  }

  function renderFooter(c) {
    var formUrl = c.formUrl ? safeText(c.formUrl) : '';
    return '<div class="aw2-foot">'
      + (formUrl ? '<a class="aw2-form-url" href="' + formUrl + '" target="_blank" rel="noopener" title="' + formUrl + '" style="text-decoration:none">' + formUrl + '</a>' : '<span></span>')
      + '<div class="aw2-foot-right">'
      + '<button type="button" class="aw2-btn aw2-btn-edit" data-action="record-reply"><span class="material-symbols-outlined">forum</span>返信を記録</button>'
      + '<button type="button" class="aw2-btn aw2-btn-edit" data-action="resend"><span class="material-symbols-outlined">replay</span>編集して再送</button>'
      + '</div>'
    + '</div>';
  }

  function renderCard(c) {
    if (!SETTINGS_CACHE) loadSettings();
    var status = statusInfo(c);
    var dateStr = fmtDate(c.sentAt);
    var src = screenshotSrc(c);
    var pending = SETTINGS_CACHE ? '' : ' data-pending="1"';

    return '<div class="aw2-card sent sent-card" data-no="' + c.no + '" data-name="' + safeText(c.name) + '" data-form-url="' + safeText(c.formUrl || '') + '" data-sn="' + safeText((c.name + ' ' + c.type + ' ' + (c.sentMessage || '') + ' ' + (c.formUrl || '')).toLowerCase()) + '" data-sc="' + (c.contactCount || 1) + '" data-type-exact="' + safeText(String(c.type || '').trim().toLowerCase()) + '"' + pending + '>'
      + renderHeader(c, status, dateStr)
      + '<div class="aw2-body">'
      +   renderLeft(c, src)
      +   renderRight(c)
      + '</div>'
      + renderFooter(c)
    + '</div>';
  }

  // ----- Resend modal -----
  var RESEND_STYLE_ID = 'aw2-resend-style';

  function ensureResendStyle() {
    if (document.getElementById(RESEND_STYLE_ID)) return;
    var s = document.createElement('style');
    s.id = RESEND_STYLE_ID;
    s.textContent = ${JSON.stringify(RESEND_STYLE)};
    document.head.appendChild(s);
  }

  function openResendModal(no, name, formUrl, existingMessage) {
    if (!no || !name) return;
    ensureResendStyle();

    var overlay = document.createElement('div');
    overlay.className = 'aw2-modal-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');

    overlay.innerHTML = ''
      + '<div class="aw2-modal" role="document">'
      +   '<div class="aw2-modal-head">'
      +     '<div class="aw2-modal-icon"><span class="material-symbols-outlined">edit_note</span></div>'
      +     '<div>'
      +       '<h3 class="aw2-modal-title">編集して再送</h3>'
      +       '<p class="aw2-modal-sub">本文を編集して再送下書きを記録します</p>'
      +     '</div>'
      +     '<button type="button" class="aw2-modal-close" aria-label="閉じる" data-resend-close="1"><span class="material-symbols-outlined">close</span></button>'
      +   '</div>'
      +   '<div class="aw2-modal-body">'
      +     '<div class="aw2-modal-meta"><span><b>送信先:</b> ' + safeText(name) + ' (No.' + no + ')</span>'
      +       (formUrl ? '<span><b>フォームURL:</b> ' + safeText(formUrl) + '</span>' : '')
      +     '</div>'
      +     '<div class="aw2-modal-error" data-resend-error="1"></div>'
      +     '<label class="aw2-modal-label" for="aw2-resend-textarea">本文</label>'
      +     '<textarea id="aw2-resend-textarea" data-resend-textarea="1" placeholder="送信する本文を入力してください"></textarea>'
      +     '<div class="aw2-modal-counter" data-resend-counter="1">0 文字</div>'
      +   '</div>'
      +   '<div class="aw2-modal-foot">'
      +     '<button type="button" class="aw2-btn aw2-btn-cancel" data-resend-cancel="1">キャンセル</button>'
      +     '<button type="button" class="aw2-btn aw2-btn-send" data-resend-submit="1"><span class="material-symbols-outlined">send</span>再送下書きを記録</button>'
      +   '</div>'
      + '</div>';

    document.body.appendChild(overlay);
    var ta = overlay.querySelector('[data-resend-textarea]');
    var counter = overlay.querySelector('[data-resend-counter]');
    var errorBox = overlay.querySelector('[data-resend-error]');
    var submitBtn = overlay.querySelector('[data-resend-submit]');
    if (ta) {
      ta.value = existingMessage || '';
      counter.textContent = ta.value.length + ' 文字';
      setTimeout(function(){ ta.focus(); }, 30);
      ta.addEventListener('input', function(){
        counter.textContent = ta.value.length + ' 文字';
      });
    }

    function closeModal() {
      try { overlay.remove(); } catch (_) {}
      document.removeEventListener('keydown', onKey, true);
    }
    function onKey(ev) {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        closeModal();
      }
      if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') {
        ev.preventDefault();
        submit();
      }
    }
    document.addEventListener('keydown', onKey, true);
    overlay.addEventListener('click', function(ev){
      if (ev.target === overlay) closeModal();
      else if (ev.target.closest && (ev.target.closest('[data-resend-close]') || ev.target.closest('[data-resend-cancel]'))) {
        closeModal();
      } else if (ev.target.closest && ev.target.closest('[data-resend-submit]')) {
        submit();
      }
    });

    function showError(msg) {
      if (!errorBox) return;
      errorBox.textContent = msg;
      errorBox.classList.add('visible');
    }
    function clearError() {
      if (!errorBox) return;
      errorBox.textContent = '';
      errorBox.classList.remove('visible');
    }

    function submit() {
      clearError();
      var msg = (ta && ta.value || '').trim();
      if (!msg) {
        showError('本文を入力してください');
        return;
      }
      if (msg.length > 32 * 1024) {
        showError('本文が長すぎます (32KB 以内)');
        return;
      }
      submitBtn.setAttribute('data-busy', '1');
      window.fetch('/api/resend-prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ no: no, name: name, message: msg, formUrl: formUrl || '' })
      }).then(function(r){
        return r.json().then(function(j){ return { ok: r.ok, body: j, status: r.status }; });
      }).then(function(result){
        if (!result.ok || !result.body || result.body.ok === false) {
          var em = (result.body && result.body.error) || ('HTTP ' + result.status);
          throw new Error(em);
        }
        if (typeof window.showToast === 'function') {
          window.showToast(result.body.message || '再送リクエストを記録しました', 'success');
        } else if (typeof window.toast === 'function') {
          window.toast(result.body.message || '再送リクエストを記録しました', 'success');
        }
        closeModal();
        if (typeof window.refreshDashboard === 'function') window.refreshDashboard();
        else if (typeof window.loadAndRender === 'function') window.loadAndRender();
        else if (typeof window.renderEverything === 'function') window.renderEverything();
        else {
          // fallback: bump activeTab to awaiting and reload data
          var awBtn = document.querySelector('[data-tab="awaiting"]');
          if (awBtn) awBtn.click();
          // poll: trigger refresh by clicking the dashboard tab and then awaiting again
          setTimeout(function(){ if (awBtn) awBtn.click(); }, 200);
        }
      }).catch(function(err){
        submitBtn.removeAttribute('data-busy');
        showError('再送リクエストの送信に失敗しました: ' + (err && err.message ? err.message : String(err)));
      });
    }
  }

  function bindGlobal() {
    if (window.__aw2SentBound) return;
    window.__aw2SentBound = true;

    document.addEventListener('click', function(ev){
      var card = ev.target.closest && ev.target.closest('.aw2-card.sent');
      if (!card) return;
      var actionEl = ev.target.closest('[data-action]');
      if (!actionEl) return;
      var action = actionEl.getAttribute('data-action');
      if (action === 'record-reply') {
        ev.preventDefault();
        if (typeof window.openReplyRecorder === 'function') {
          var no = parseInt(card.getAttribute('data-no'), 10);
          window.openReplyRecorder(no, card.getAttribute('data-name') || '');
        } else if (typeof window.toast === 'function') {
          window.toast('返信記録機能は近日対応', 'info');
        } else {
          alert('返信記録機能は近日対応');
        }
      } else if (action === 'resend') {
        ev.preventDefault();
        var no2 = parseInt(card.getAttribute('data-no'), 10);
        var name2 = card.getAttribute('data-name') || '';
        var formUrl = card.getAttribute('data-form-url') || '';
        var msgEl = card.querySelector('.aw2-fld-message');
        var existingMessage = msgEl ? (msgEl.textContent || '') : '';
        openResendModal(no2, name2, formUrl, existingMessage);
      }
    }, false);
  }

  bindGlobal();
  window.renderSentCardOverride = renderCard;
})();`;

module.exports = function renderSentCardRedesignScript() {
  return SCRIPT;
};

'use strict';

/**
 * 設定タブの新デザイン (写真リファレンスに準拠)。
 *
 * 既存のフォームフィールド ID / 保存ロジックには触れず、DOM 装飾と
 * 補助 UI (ステップインジケータ / 進捗ヘッダ / プレビューパネル / 保存して次へ)
 * だけを差し込む non-invasive アプローチ。
 */

const STYLE = [
  /* ---------- Layout shell ---------- */
  '.settings-layout.set2-active{background:var(--bg-base)!important;gap:14px;padding:14px;align-items:flex-start}',
  '.settings-main.set2-active{background:transparent!important;padding:0!important;max-height:none!important;display:flex;flex-direction:column;gap:14px;flex:1 1 auto;min-width:0}',

  /* ---------- Sidebar ---------- */
  '.settings-sidebar.set2-styled{width:248px!important;padding:14px 10px!important;background:var(--bg-card)!important;border:1px solid var(--border-subtle)!important;border-radius:var(--radius-lg)!important;box-shadow:var(--shadow-ambient);align-self:flex-start;display:flex;flex-direction:column;gap:0;flex-shrink:0;position:sticky;top:64px}',
  '.set2-side-title{font-size:.6rem;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:var(--text-3);padding:6px 12px;margin-bottom:4px}',
  '.settings-sidebar-btn{display:flex!important;align-items:center!important;gap:12px;padding:14px 14px!important;border:1px solid transparent;border-radius:var(--radius-md)!important;background:transparent;color:var(--text-1);text-align:left;cursor:pointer;transition:all .15s var(--ease-out-expo);width:100%;margin-bottom:8px;font-weight:600!important;text-transform:none!important;letter-spacing:0!important}',
  '.settings-sidebar-btn:hover{background:var(--bg-hover);border-color:transparent}',
  '.settings-sidebar-btn.active{background:var(--primary-glow);border-color:rgba(37,99,235,.18);color:var(--primary)}',
  '.settings-sidebar-btn.active .set2-side-icon{background:var(--primary);color:#fff}',
  '.set2-side-icon{width:32px;height:32px;border-radius:9px!important;background:var(--bg-raised);color:var(--text-2);display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:all .15s}',
  '.set2-side-icon .material-symbols-outlined{font-size:18px}',
  '.set2-side-text{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:1px}',
  '.set2-side-name{font-size:.78rem;font-weight:700;color:var(--text-1);line-height:1.2}',
  '.settings-sidebar-btn.active .set2-side-name{color:var(--primary)}',
  '.set2-side-sub{font-size:.66rem;color:var(--text-3);line-height:1.3;font-weight:500}',
  '.settings-sidebar-status{display:none!important}',
  '.settings-sidebar-label{display:none!important}',

  /* ---------- Hide legacy setup guide once redesign loads ---------- */
  '.set2-active .settings-setup-guide{display:none!important}',

  /* ---------- Sidebar footer hint (vertical card style, matches reference) ---------- */
  '.set2-side-spacer{flex:1 1 auto;min-height:24px}',
  '.set2-side-hint{margin:0 4px;padding:16px 16px 14px;background:var(--bg-surface);border:1px solid var(--primary-glow);border-radius:14px!important;display:flex;flex-direction:column;gap:10px}',
  '.set2-side-hint-head{display:flex;align-items:center;gap:8px}',
  '.set2-side-hint-icon{width:24px;height:24px;color:var(--primary);display:inline-flex;align-items:center;justify-content:center;flex-shrink:0}',
  '.set2-side-hint-icon .material-symbols-outlined{font-size:20px;font-variation-settings:"FILL" 1}',
  '.set2-side-hint-title{font-size:.86rem;font-weight:800;color:var(--primary);line-height:1.2}',
  '.set2-side-hint-desc{font-size:.72rem;color:var(--text-2);margin:0;line-height:1.65}',
  '.set2-side-hint-link{display:flex;align-items:center;justify-content:center;gap:6px;padding:9px 12px;background:var(--bg-card);border:1px solid var(--border-default);border-radius:10px!important;color:var(--primary);font-size:.76rem;font-weight:700;text-decoration:none;transition:all .15s var(--ease-out-expo);box-shadow:var(--shadow-xs)}',
  '.set2-side-hint-link:hover{background:var(--primary-glow);border-color:var(--primary);box-shadow:var(--shadow-ambient)}',
  '.set2-side-hint-link .material-symbols-outlined{font-size:14px}',

  /* ---------- Section header ---------- */
  '.set2-header{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;padding:20px 24px 18px;background:var(--bg-card);border:1px solid var(--border-subtle);border-radius:var(--radius-lg)!important;box-shadow:var(--shadow-ambient)}',
  '.set2-header-text h2{font-size:1.32rem;font-weight:800;margin:0 0 4px;color:var(--text-1);letter-spacing:.005em}',
  '.set2-header-text p{font-size:.78rem;color:var(--text-2);margin:0;line-height:1.6}',
  '.set2-progress{display:flex;flex-direction:column;align-items:flex-end;gap:6px;flex-shrink:0;min-width:200px}',
  '.set2-progress-label{font-size:.74rem;color:var(--text-2);font-weight:600}',
  '.set2-progress-label b{color:var(--primary);font-weight:800}',
  '.set2-progress-track{width:200px;height:6px;background:var(--bg-raised);border-radius:3px!important;overflow:hidden}',
  '.set2-progress-track span{display:block;height:100%;background:linear-gradient(90deg,var(--primary) 0%,#60a5fa 100%);width:0;transition:width .3s ease;border-radius:3px!important}',

  /* ---------- Step indicator (separate card under header) ---------- */
  '.set2-stepper{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:0;padding:18px 22px;background:var(--bg-card);border:1px solid var(--border-subtle);border-radius:var(--radius-lg)!important;box-shadow:var(--shadow-ambient);position:relative}',
  '.set2-step{display:flex;flex-direction:column;align-items:center;gap:6px;position:relative;padding:0 8px;cursor:pointer;text-align:center}',
  '.set2-step::before,.set2-step::after{content:"";position:absolute;top:14px;height:2px;background:var(--border-default);z-index:0}',
  '.set2-step::before{left:0;right:50%}',
  '.set2-step::after{left:50%;right:0}',
  '.set2-step:first-child::before{display:none}',
  '.set2-step:last-child::after{display:none}',
  '.set2-step.done::before,.set2-step.done::after,.set2-step.active::before{background:var(--primary)}',
  '.set2-step-dot{width:30px;height:30px;border-radius:50%!important;display:flex;align-items:center;justify-content:center;background:var(--bg-card);border:2px solid var(--border-default);color:var(--text-3);position:relative;z-index:1;transition:all .2s var(--ease-out-expo)}',
  '.set2-step-dot .material-symbols-outlined{font-size:15px}',
  '.set2-step.done .set2-step-dot{background:var(--primary);border-color:var(--primary);color:#fff}',
  '.set2-step.active .set2-step-dot{background:var(--primary);border-color:var(--primary);color:#fff;box-shadow:0 0 0 4px rgba(37,99,235,.15)}',
  '.set2-step-name{font-size:.72rem;font-weight:700;color:var(--text-3);line-height:1.2}',
  '.set2-step.active .set2-step-name,.set2-step.done .set2-step-name{color:var(--text-1)}',
  '.set2-step-sub{font-size:.62rem;color:var(--text-3);line-height:1.3}',

  /* ---------- Section body wrapper ---------- */
  '.set2-section-shell{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:14px;padding:0}',
  '.set2-section-shell.no-preview{grid-template-columns:minmax(0,1fr)}',
  '.set2-form-wrap{background:var(--bg-card);border:1px solid var(--border-subtle);border-radius:var(--radius-lg)!important;box-shadow:var(--shadow-ambient);padding:20px 24px;min-height:520px;display:flex;flex-direction:column}',
  '.set2-form-wrap > .settings-section{display:block!important;flex:1 1 auto}',
  '.set2-form-wrap .settings-section h3{display:none}',
  '.set2-form-wrap .save-bar{display:none!important}',
  '.set2-form-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px;padding-bottom:10px;border-bottom:1px solid var(--border-subtle)}',
  '.set2-form-title{font-size:.96rem;font-weight:800;color:var(--text-1);margin:0;letter-spacing:.01em}',
  '.set2-form-actions{display:flex;align-items:center;gap:6px}',
  '.set2-form-actions .btn-picker{padding:5px 11px;font-size:.72rem;font-weight:600}',

  /* ---------- Right preview column ---------- */
  '.set2-preview{position:sticky;top:14px;align-self:flex-start;background:var(--bg-card);border:1px solid var(--border-subtle);border-radius:var(--radius-lg)!important;box-shadow:var(--shadow-ambient);padding:14px 16px}',
  '.set2-preview h4{margin:0 0 10px;font-size:.78rem;font-weight:800;color:var(--text-2);letter-spacing:.05em;text-transform:uppercase}',
  '.set2-preview-name{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:.92rem;font-weight:800;color:var(--text-1);padding:8px 10px;background:var(--bg-surface);border-radius:var(--radius-sm);border:1px solid var(--border-subtle);margin-bottom:14px}',
  '.set2-preview-tag{font-size:.6rem;font-weight:700;background:var(--primary-glow);color:var(--primary);padding:2px 7px;border-radius:var(--radius-pill)!important}',
  '.set2-preview-list{display:flex;flex-direction:column;gap:7px;margin-bottom:14px}',
  '.set2-preview-row{display:flex;align-items:center;gap:8px;font-size:.74rem;color:var(--text-1);min-width:0}',
  '.set2-preview-row .material-symbols-outlined{font-size:14px;color:var(--text-3);flex-shrink:0}',
  '.set2-preview-row span:last-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}',
  '.set2-preview-row.muted{color:var(--text-3)}',
  '.set2-preview-section{margin-top:10px;padding-top:10px;border-top:1px dashed var(--border-default)}',
  '.set2-preview-section-title{font-size:.7rem;font-weight:700;color:var(--text-2);margin-bottom:5px;letter-spacing:.04em}',
  '.set2-preview-desc{font-size:.7rem;color:var(--text-2);line-height:1.55;background:var(--bg-surface);border:1px dashed var(--border-default);border-radius:var(--radius-sm);padding:8px 10px}',
  '.set2-preview-hint{display:flex;align-items:flex-start;gap:6px;margin-top:10px;padding:8px 10px;background:var(--primary-glow);border:1px dashed rgba(37,99,235,.3);border-radius:var(--radius-sm);font-size:.66rem;color:var(--primary);line-height:1.55}',
  '.set2-preview-hint .material-symbols-outlined{font-size:14px;flex-shrink:0;margin-top:1px}',

  /* ---------- Hint card + Save next bar ---------- */
  '.set2-bottom{display:flex;align-items:center;justify-content:space-between;gap:18px;padding:18px 22px 22px;flex-wrap:wrap}',
  '.set2-hint-card{display:flex;align-items:center;gap:10px;padding:10px 14px;background:var(--bg-card);border:1px solid var(--border-subtle);border-radius:var(--radius-md)!important;font-size:.74rem;color:var(--text-2);box-shadow:var(--shadow-xs);max-width:380px}',
  '.set2-hint-icon{width:28px;height:28px;border-radius:8px!important;background:var(--info-dim);color:var(--info);display:flex;align-items:center;justify-content:center;flex-shrink:0}',
  '.set2-hint-icon .material-symbols-outlined{font-size:16px}',
  '.set2-hint-body{display:flex;flex-direction:column;gap:2px}',
  '.set2-hint-title{font-size:.74rem;font-weight:700;color:var(--text-1);line-height:1.2}',
  '.set2-hint-link{font-size:.66rem;color:var(--primary);font-weight:700;text-decoration:none;display:inline-flex;align-items:center;gap:3px;margin-top:1px}',
  '.set2-hint-link:hover{text-decoration:underline}',
  '.set2-save-next{display:inline-flex;align-items:center;gap:7px;padding:11px 24px;font-size:.86rem;font-weight:800;background:var(--primary);color:#fff;border:none;border-radius:var(--radius-md)!important;cursor:pointer;box-shadow:var(--shadow-cta);transition:all .15s var(--ease-out-expo);font-family:var(--font-body)}',
  '.set2-save-next:hover{background:var(--primary-dim);box-shadow:0 6px 20px rgba(37,99,235,.4);transform:translateY(-1px)}',
  '.set2-save-next:disabled{opacity:.55;cursor:not-allowed!important;transform:none!important}',
  '.set2-save-next .material-symbols-outlined{font-size:18px}',

  /* hide legacy save-bar inside redesigned sections (we rebuild in bottom row) */
  '.set2-active .save-bar{display:none!important}',

  '@media (max-width:1100px){.set2-section-shell{grid-template-columns:minmax(0,1fr)}.set2-preview{position:static;order:-1}}',
  '@media (max-width:840px){.set2-stepper{grid-template-columns:repeat(5,minmax(56px,1fr));overflow-x:auto;padding:14px 12px}.set2-step-sub{display:none}.set2-header{flex-direction:column}.set2-progress{align-items:flex-start;width:100%}.set2-progress-track{width:100%}}'
].join('\n');

const SCRIPT = `(function(){
  if (window.__set2Init) return;
  window.__set2Init = true;

  var STYLE_ID = 'set2-style';
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = ${JSON.stringify(STYLE)};
    document.head.appendChild(s);
  }

  // i18n helper (uses the global I18N map injected by buildPage())
  function set2T(key, fallback) {
    try {
      if (typeof I18N === 'object' && I18N && I18N[key]) return I18N[key];
    } catch (_) {}
    return fallback;
  }

  // Section metadata (labels resolved via I18N at render time)
  var SECTIONS = [
    { id: 'companyProfile',    icon: 'apartment',     nameKey: 'settingsRedesign.section.companyProfile.name',    subKey: 'settingsRedesign.section.companyProfile.sub',    descKey: 'settingsRedesign.section.companyProfile.desc',    stepNameKey: 'settingsRedesign.section.companyProfile.name',     stepSubKey: 'settingsRedesign.section.companyProfile.stepSub',     inStepper: true },
    { id: 'valuePropositions', icon: 'lightbulb',     nameKey: 'settingsRedesign.section.valuePropositions.name', subKey: 'settingsRedesign.section.valuePropositions.sub', descKey: 'settingsRedesign.section.valuePropositions.desc', stepNameKey: 'settingsRedesign.section.valuePropositions.name',  stepSubKey: 'settingsRedesign.section.valuePropositions.stepSub',  inStepper: true },
    { id: 'targetList',        icon: 'groups',        nameKey: 'settingsRedesign.section.targetList.name',        subKey: 'settingsRedesign.section.targetList.sub',        descKey: 'settingsRedesign.section.targetList.desc',        stepNameKey: 'settingsRedesign.section.targetList.name',         stepSubKey: 'settingsRedesign.section.targetList.stepSub',         inStepper: true },
    { id: 'exclusionRules',    icon: 'block',         nameKey: 'settingsRedesign.section.exclusionRules.name',    subKey: 'settingsRedesign.section.exclusionRules.sub',    descKey: 'settingsRedesign.section.exclusionRules.desc',    stepNameKey: null,                                                stepSubKey: null,                                                  inStepper: false },
    { id: 'messageTemplates',  icon: 'edit_note',     nameKey: 'settingsRedesign.section.messageTemplates.name',  subKey: 'settingsRedesign.section.messageTemplates.sub',  descKey: 'settingsRedesign.section.messageTemplates.desc',  stepNameKey: 'settingsRedesign.section.messageTemplates.name',   stepSubKey: 'settingsRedesign.section.messageTemplates.stepSub',   inStepper: true },
    { id: 'preferences',       icon: 'tune',          nameKey: 'settingsRedesign.section.preferences.name',       subKey: 'settingsRedesign.section.preferences.sub',       descKey: 'settingsRedesign.section.preferences.desc',       stepNameKey: 'settingsRedesign.section.preferences.name',        stepSubKey: 'settingsRedesign.section.preferences.stepSub',        inStepper: true }
  ];
  // Expose translated accessor helpers
  function sectionName(s) { return set2T(s.nameKey, ''); }
  function sectionSub(s)  { return set2T(s.subKey, ''); }
  function sectionDesc(s) { return set2T(s.descKey, ''); }
  function sectionStepName(s) { return s.stepNameKey ? set2T(s.stepNameKey, '') : null; }
  function sectionStepSub(s)  { return s.stepSubKey  ? set2T(s.stepSubKey,  '') : null; }
  var SECTION_BY_ID = {};
  SECTIONS.forEach(function(s){ SECTION_BY_ID[s.id] = s; });
  var STEPPER = SECTIONS.filter(function(s){ return s.inStepper; });

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  // ---- Sidebar transform ----
  function decorateSidebar() {
    $$('.settings-sidebar-btn').forEach(function(btn){
      if (btn.dataset.set2Decorated === '1') return;
      var section = btn.getAttribute('data-section');
      var meta = SECTION_BY_ID[section];
      if (!meta) return;
      btn.dataset.set2Decorated = '1';

      var icon = document.createElement('div');
      icon.className = 'set2-side-icon';
      icon.innerHTML = '<span class="material-symbols-outlined">' + meta.icon + '</span>';

      var text = document.createElement('div');
      text.className = 'set2-side-text';
      var name = document.createElement('div');
      name.className = 'set2-side-name';
      name.textContent = sectionName(meta);
      var sub = document.createElement('div');
      sub.className = 'set2-side-sub';
      sub.textContent = sectionSub(meta);
      text.appendChild(name);
      text.appendChild(sub);

      btn.insertBefore(text, btn.firstChild);
      btn.insertBefore(icon, btn.firstChild);
    });
    // Add a "Settings menu" title at top of sidebar
    var sidebar = $('.settings-sidebar');
    if (sidebar && !sidebar.querySelector('.set2-side-title')) {
      var t = document.createElement('div');
      t.className = 'set2-side-title';
      t.textContent = set2T('settingsRedesign.menuTitle', '設定メニュー');
      sidebar.insertBefore(t, sidebar.firstChild);
    }
  }

  // ---- Section header / stepper / footer injection ----
  function activeSectionId() {
    var btn = document.querySelector('.settings-sidebar-btn.active');
    return btn ? (btn.getAttribute('data-section') || 'companyProfile') : 'companyProfile';
  }

  function isSectionDone(id) {
    var chip = document.getElementById('settingsSidebarStatus-' + id);
    return chip && chip.classList.contains('ready');
  }

  function computeProgress() {
    var done = 0, total = 0;
    STEPPER.forEach(function(s){
      total++;
      if (isSectionDone(s.id)) done++;
    });
    return { done: done, total: total, pct: total ? Math.round((done / total) * 100) : 0 };
  }

  function renderHeader(meta, prog) {
    return '<div class="set2-header">'
      + '<div class="set2-header-text">'
      + '<h2>' + escapeHtml(sectionName(meta)) + '</h2>'
      + '<p>' + escapeHtml(sectionDesc(meta)) + '</p>'
      + '</div>'
      + '<div class="set2-progress">'
      + '<div class="set2-progress-label">' + escapeHtml(set2T('settingsRedesign.progressLabel', '設定の完了率')) + ' <b>' + prog.pct + '%</b> (' + prog.done + '/' + prog.total + ')</div>'
      + '<div class="set2-progress-track"><span style="width:' + prog.pct + '%"></span></div>'
      + '</div>'
      + '</div>';
  }

  function renderStepper(activeId) {
    var activeIdx = -1;
    STEPPER.forEach(function(s, i){ if (s.id === activeId) activeIdx = i; });
    var html = '<div class="set2-stepper">';
    STEPPER.forEach(function(s, i){
      var cls = 'set2-step';
      if (i < activeIdx || isSectionDone(s.id)) cls += ' done';
      if (i === activeIdx) cls += ' active';
      var iconText = (i < activeIdx || (isSectionDone(s.id) && i !== activeIdx)) ? 'check' : (i + 1).toString();
      html += '<div class="' + cls + '" data-step-target="' + s.id + '">'
        +   '<div class="set2-step-dot">'
        +     (iconText === 'check' ? '<span class="material-symbols-outlined">check</span>' : '<span style="font-size:.78rem;font-weight:800">' + iconText + '</span>')
        +   '</div>'
        +   '<div class="set2-step-name">' + escapeHtml(sectionStepName(s) || '') + '</div>'
        +   '<div class="set2-step-sub">' + escapeHtml(sectionStepSub(s) || '') + '</div>'
        + '</div>';
    });
    html += '</div>';
    return html;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  function readFieldValue(name) {
    var el = document.getElementById('cp-' + name) || document.querySelector('[name="' + name + '"]');
    return el ? (el.value || '').trim() : '';
  }

  function renderPreviewForCompany() {
    var name = readFieldValue('companyName') || readFieldValue('cp-companyName') || (function(){
      var n = document.querySelector('#cp-companyName, [name=companyName]');
      return n ? n.value.trim() : '';
    })();
    var contactName = readFieldValue('contactName') || (function(){ var n = document.querySelector('#cp-contactName, [name=contactName]'); return n ? n.value.trim() : ''; })();
    var email = readFieldValue('email') || (function(){ var n = document.querySelector('#cp-email, [name=email]'); return n ? n.value.trim() : ''; })();
    var phone = readFieldValue('phone') || (function(){ var n = document.querySelector('#cp-phone, [name=phone]'); return n ? n.value.trim() : ''; })();
    var website = readFieldValue('website') || (function(){ var n = document.querySelector('#cp-website, [name=website]'); return n ? n.value.trim() : ''; })();
    var desc = readFieldValue('businessDescription') || (function(){ var n = document.querySelector('#cp-businessDescription, [name=businessDescription]'); return n ? n.value.trim() : ''; })();

    var html = '<aside class="set2-preview">'
      + '<h4>' + escapeHtml(set2T('settingsRedesign.preview.title', 'プレビュー')) + '</h4>'
      + '<div class="set2-preview-name"><span>' + escapeHtml(name || set2T('settingsRedesign.preview.namePlaceholder', '— 会社名 —')) + '</span><span class="set2-preview-tag">' + escapeHtml(set2T('settingsRedesign.preview.tag', 'プレビュー')) + '</span></div>'
      + '<div class="set2-preview-section-title">' + escapeHtml(set2T('settingsRedesign.preview.contactsTitle', '連絡先')) + '</div>'
      + '<div class="set2-preview-list">'
      +   '<div class="set2-preview-row' + (contactName ? '' : ' muted') + '"><span class="material-symbols-outlined">person</span><span>' + escapeHtml(contactName || set2T('settingsRedesign.preview.contactPlaceholder', '— 担当者名 —')) + '</span></div>'
      +   '<div class="set2-preview-row' + (email ? '' : ' muted') + '"><span class="material-symbols-outlined">mail</span><span>' + escapeHtml(email || set2T('settingsRedesign.preview.emailPlaceholder', '— メール —')) + '</span></div>'
      +   '<div class="set2-preview-row' + (phone ? '' : ' muted') + '"><span class="material-symbols-outlined">call</span><span>' + escapeHtml(phone || set2T('settingsRedesign.preview.phonePlaceholder', '— 電話 —')) + '</span></div>'
      +   '<div class="set2-preview-row' + (website ? '' : ' muted') + '"><span class="material-symbols-outlined">language</span><span>' + escapeHtml(website || set2T('settingsRedesign.preview.webPlaceholder', '— Web —')) + '</span></div>'
      + '</div>'
      + '<div class="set2-preview-section">'
      +   '<div class="set2-preview-section-title">' + escapeHtml(set2T('settingsRedesign.preview.companyTitle', '会社概要')) + '</div>'
      +   '<div class="set2-preview-desc">' + escapeHtml(desc || set2T('settingsRedesign.preview.descPlaceholder', 'AI が生成した会社プロフィールのプレビューがここに表示されます。')) + '</div>'
      + '</div>'
      + '<div class="set2-preview-hint"><span class="material-symbols-outlined">auto_awesome</span><span>' + escapeHtml(set2T('settingsRedesign.preview.autoHint', '入力内容に基づき、AI が最適な表現でプロフィールを自動生成します。')) + '</span></div>'
    + '</aside>';
    return html;
  }

  function renderBottom() {
    return '<div class="set2-bottom">'
      + '<div class="set2-hint-card">'
      +   '<div class="set2-hint-icon"><span class="material-symbols-outlined">tips_and_updates</span></div>'
      +   '<div class="set2-hint-body">'
      +     '<div class="set2-hint-title">' + escapeHtml(set2T('settingsRedesign.hint.title', '設定のヒント')) + '</div>'
      +     '<a href="https://github.com/joseikininsight-hue/sales-claw-ts#readme" target="_blank" rel="noopener" class="set2-hint-link">' + escapeHtml(set2T('settingsRedesign.hint.guide', '詳細ガイドを見る')) + ' <span class="material-symbols-outlined" style="font-size:12px">open_in_new</span></a>'
      +   '</div>'
      + '</div>'
      + '<button type="button" class="set2-save-next" data-set2-save-next="1"><span>' + escapeHtml(set2T('settingsRedesign.saveNext', '保存して次へ')) + '</span><span class="material-symbols-outlined">arrow_forward</span></button>'
    + '</div>';
  }

  function findActiveLegacySection() {
    return document.querySelector('.settings-section.active');
  }

  function unwrapPreviousShell(main) {
    // 以前 rebuildShell が wrap した section を元の位置に戻し、shell/wrap を片付ける。
    // 重要: rebuildShell は同じ id を持つ element を 2 つ作るため、getElementById ではなく
    // querySelectorAll で全候補を取得し、wrap 外側の placeholder と区別する。
    // 旧コードは getElementById で本物の section を取得して remove していたため画面から消えていた。
    $$('.set2-form-wrap', main).forEach(function(wrap){
      var sectionId = wrap.dataset.set2WrappedSection;
      if (!sectionId) return;
      var nestedSection = wrap.querySelector('.settings-section');
      var allWithId = Array.from(main.querySelectorAll('[id="sec-' + sectionId + '"]'));
      var placeholder = allWithId.find(function(el){ return el !== nestedSection && !el.closest('.set2-form-wrap'); });

      if (nestedSection) {
        // 本物 section を placeholder の位置に戻す (placeholder はその後 remove)
        if (placeholder && placeholder.parentNode) {
          placeholder.parentNode.insertBefore(nestedSection, placeholder);
          placeholder.remove();
        } else {
          main.appendChild(nestedSection); // fallback: 親が見つからなければ main 末尾へ
        }
      } else if (placeholder) {
        // legacy form: wrap の子要素が直接入っているケース
        while (wrap.firstChild) placeholder.appendChild(wrap.firstChild);
      }

      // 不要になった shell/wrap を削除
      var shell = wrap.closest('.set2-section-shell');
      if (shell) shell.remove(); else wrap.remove();
    });
  }

  function rebuildShell() {
    var main = document.getElementById('settingsMain');
    if (!main) return;
    main.classList.add('set2-active');
    var sidebar = document.querySelector('.settings-sidebar');
    if (sidebar) sidebar.classList.add('set2-styled');
    var layout = document.querySelector('.settings-layout');
    if (layout) layout.classList.add('set2-active');

    var activeId = activeSectionId();
    var meta = SECTION_BY_ID[activeId];
    if (!meta) return;
    var prog = computeProgress();

    // 1) Reverse any previous wrapping to make rebuild idempotent
    unwrapPreviousShell(main);

    // 2) remove previous redesign elements
    $$('.set2-header, .set2-stepper, .set2-section-shell, .set2-bottom, .set2-preview', main).forEach(function(el){ el.remove(); });

    // 3) header + stepper at top of main
    // (旧コードに parent-less な headerEl.outerHTML 代入が残っていたが、
    //  detached element に outerHTML を設定するとモダンブラウザは
    //  "This element has no parent node" を投げるので削除。
    //  下の hWrap.innerHTML が実際の挿入を担当する)
    var hWrap = document.createElement('div');
    hWrap.innerHTML = renderHeader(meta, prog) + renderStepper(activeId);
    var hChildren = Array.prototype.slice.call(hWrap.children);
    var firstChild = main.firstChild;
    hChildren.forEach(function(c){ main.insertBefore(c, firstChild); });

    // 4) wrap the active section into shell with preview (KEEP the .settings-section element intact)
    var section = findActiveLegacySection();
    if (section) {
      var shell = document.createElement('div');
      // ユーザ要望: プレビューパネルは廃止して全幅でフォーム表示する。常に no-preview。
      shell.className = 'set2-section-shell no-preview';
      var formWrap = document.createElement('div');
      formWrap.className = 'set2-form-wrap';
      formWrap.dataset.set2WrappedSection = activeId;
      // Insert a placeholder at the section's original position so unwrap can put it back
      var placeholder = document.createElement('div');
      placeholder.id = 'sec-' + activeId;
      placeholder.className = 'settings-section';
      placeholder.setAttribute('data-section', activeId);
      placeholder.style.display = 'none';
      section.parentNode.insertBefore(placeholder, section);
      // Move the entire <section> element into formWrap (preserves IDs/handlers)
      formWrap.appendChild(section);
      // Ensure the moved section stays "active" so legacy CSS keeps it visible
      section.classList.add('active');
      section.style.display = '';
      shell.appendChild(formWrap);
      // プレビューパネルは廃止 (フォーム領域を最大化)
      // place shell at the natural position (where placeholder is)
      placeholder.parentNode.insertBefore(shell, placeholder);
    }

    // 5) Sidebar hint card (move from main bottom to sidebar bottom)
    if (sidebar && !sidebar.querySelector('.set2-side-hint')) {
      var spacer = document.createElement('div');
      spacer.className = 'set2-side-spacer';
      var hint = document.createElement('div');
      hint.className = 'set2-side-hint';
      hint.innerHTML = '<div class="set2-side-hint-head">'
        +   '<span class="set2-side-hint-icon"><span class="material-symbols-outlined">lightbulb</span></span>'
        +   '<span class="set2-side-hint-title">' + escapeHtml(set2T('settingsRedesign.hint.title', '設定のヒント')) + '</span>'
        + '</div>'
        + '<p class="set2-side-hint-desc">' + escapeHtml(set2T('settingsRedesign.hint.desc', '各設定はAIがフォームを自動生成・最適化するために使用されます。')) + '</p>'
        + '<a class="set2-side-hint-link" href="https://github.com/joseikininsight-hue/sales-claw-ts#readme" target="_blank" rel="noopener">' + escapeHtml(set2T('settingsRedesign.hint.guide', '詳細ガイドを見る')) + ' <span class="material-symbols-outlined">open_in_new</span></a>';
      sidebar.appendChild(spacer);
      sidebar.appendChild(hint);
    }

    // 6) Bottom: "Save and continue" button (hint moved to sidebar)
    var bottom = document.createElement('div');
    bottom.className = 'set2-bottom';
    bottom.innerHTML = '<span></span><button type="button" class="set2-save-next" data-set2-save-next="1"><span>' + escapeHtml(set2T('settingsRedesign.saveNext', '保存して次へ')) + '</span><span class="material-symbols-outlined">arrow_forward</span></button>';
    main.appendChild(bottom);
  }

  // ---- Save & next ----
  function saveAndNext() {
    var activeId = activeSectionId();
    // find legacy save button within this section's original wrap
    var section = findActiveLegacySection();
    if (!section) return;
    var saveBtn = section.querySelector('.btn-save, [data-action="save-section"], button.save, button[onclick*="saveSection"]');
    if (saveBtn) {
      saveBtn.click();
    }
    // open next stepper section after a small delay
    setTimeout(function(){
      var idx = STEPPER.findIndex(function(s){ return s.id === activeId; });
      var next = idx >= 0 && idx < STEPPER.length - 1 ? STEPPER[idx + 1] : null;
      if (next && typeof window.openSettingsSection === 'function') {
        window.openSettingsSection(next.id);
      } else if (typeof window.showToast === 'function') {
        window.showToast(set2T('settingsRedesign.toast.saved', '保存しました'), 'success');
      }
    }, 250);
  }

  // ---- Live preview update for company profile ----
  function bindLivePreview() {
    document.addEventListener('input', function(ev){
      if (!document.getElementById('settingsMain') || !document.getElementById('settingsMain').classList.contains('set2-active')) return;
      if (activeSectionId() !== 'companyProfile') return;
      var el = ev.target;
      if (!el || !el.matches) return;
      var n = (el.id || el.name || '').replace(/^cp-/, '');
      if (['companyName','contactName','email','phone','website','businessDescription'].indexOf(n) === -1) return;
      var preview = document.querySelector('.set2-preview');
      if (!preview) return;
      var holder = document.createElement('div');
      holder.innerHTML = renderPreviewForCompany();
      preview.replaceWith(holder.firstChild);
    });
  }

  // ---- Watch for active section / settings tab changes ----
  function attachClickHandlers() {
    document.addEventListener('click', function(ev){
      // tab switch to settings
      var tabBtn = ev.target.closest && ev.target.closest('.tab-btn[data-tab="settings"]');
      if (tabBtn) {
        setTimeout(rebuildShell, 60);
      }
      // sidebar nav
      var sideBtn = ev.target.closest && ev.target.closest('.settings-sidebar-btn');
      if (sideBtn) {
        setTimeout(rebuildShell, 60);
      }
      // step navigation
      var step = ev.target.closest && ev.target.closest('[data-step-target]');
      if (step) {
        ev.preventDefault();
        var target = step.getAttribute('data-step-target');
        if (typeof window.openSettingsSection === 'function') window.openSettingsSection(target);
        setTimeout(rebuildShell, 60);
      }
      // save & next
      var saveNext = ev.target.closest && ev.target.closest('[data-set2-save-next]');
      if (saveNext) {
        ev.preventDefault();
        saveAndNext();
      }
    }, true);
  }

  // ---- Observe settings tab visibility ----
  function watchSettingsTab() {
    var tab = document.getElementById('tab-settings');
    if (!tab) return;
    var obs = new MutationObserver(function(){
      if (tab.classList.contains('active')) {
        decorateSidebar();
        rebuildShell();
      }
    });
    obs.observe(tab, { attributes: true, attributeFilter: ['class'] });
  }

  function init() {
    ensureStyle();
    decorateSidebar();
    attachClickHandlers();
    watchSettingsTab();
    bindLivePreview();
    // initial rebuild if settings tab is already active
    if (document.getElementById('tab-settings') && document.getElementById('tab-settings').classList.contains('active')) {
      setTimeout(rebuildShell, 100);
    }
    // also re-run after data load (settings often re-render)
    setTimeout(rebuildShell, 800);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();`;

module.exports = function renderSettingsRedesignScript() {
  return SCRIPT;
};

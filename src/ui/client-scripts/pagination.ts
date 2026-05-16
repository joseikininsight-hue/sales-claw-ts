'use strict';

/**
 * リスト系ビューにページネーションを後付けで噛ませる汎用クライアント。
 *
 * 対応コンテナ:
 *   - 企業一覧テーブル  (#companyBody  / tr)
 *   - 確認待ちカード    (#awaitingList / div.aw2-card)
 *   - 送信済みカード    (#sentList     / div.aw2-card)
 *   - Action Log テーブル (#logBody    / tr)
 *
 * 設計方針:
 *   - 既存 render コードに手を入れず、innerHTML 更新を MutationObserver で監視
 *   - フィルタで display:none された行は除外し「表示中の n 件」だけをページング
 *   - ページサイズは localStorage に永続化 (リスト単位)
 *   - 大きいデータセット (1000+) でも DOM 操作は単純な display 切替のみ
 *
 * パフォーマンス:
 *   - 1〜2K 件規模では CSS slice で十分体感快適
 *   - 1万件超は本格的に仮想化が必要 (このファイルの守備範囲外)。要に応じて
 *     vendor の virtual-scroll ライブラリを足してください。
 */

const STYLE = [
  '.pgn-bar{display:flex;align-items:center;justify-content:flex-start;gap:18px;padding:8px 12px;background:var(--bg-card);border:1px solid var(--border-subtle);border-top:none;border-radius:0 0 var(--radius-md) var(--radius-md);font-size:.74rem;color:var(--text-2);flex-wrap:wrap}',
  '.pgn-bar.standalone{border:1px solid var(--border-subtle);border-radius:var(--radius-md);margin-top:10px}',
  '.pgn-bar.empty{display:none}',
  '.pgn-summary{display:flex;align-items:center;gap:6px;font-family:var(--font-body);min-width:0}',
  '.pgn-summary b{color:var(--text-1);font-weight:700}',
  '.pgn-pages{display:flex;align-items:center;gap:3px;flex-wrap:wrap;justify-content:flex-start;flex:0 0 auto}',
  '.pgn-btn{display:inline-flex;align-items:center;justify-content:center;min-width:28px;height:28px;padding:0 8px;border:1px solid transparent;background:transparent;color:var(--text-2);font-size:.72rem;font-weight:600;font-family:var(--font-mono);cursor:pointer;border-radius:var(--radius-sm)!important;transition:all .12s var(--ease-out-expo)}',
  '.pgn-btn:hover:not([disabled]):not(.active){background:var(--bg-hover);color:var(--text-1)}',
  '.pgn-btn.active{background:var(--primary);color:#fff;font-weight:700}',
  '.pgn-btn[disabled]{opacity:.35;cursor:not-allowed!important}',
  '.pgn-btn.nav .material-symbols-outlined{font-size:16px}',
  '.pgn-ellipsis{display:inline-flex;align-items:center;justify-content:center;min-width:20px;height:28px;color:var(--text-3);font-family:var(--font-mono);font-size:.72rem;user-select:none}',
  '.pgn-size{display:flex;align-items:center;gap:6px;font-size:.7rem;color:var(--text-2);flex-shrink:0}',
  '.pgn-size select{height:28px;padding:0 8px;border:1px solid var(--border-default);border-radius:var(--radius-sm)!important;background:var(--bg-card);color:var(--text-1);font-size:.72rem;font-family:var(--font-body);cursor:pointer;outline:none}',
  '.pgn-size select:focus{border-color:var(--primary);box-shadow:0 0 0 3px rgba(37,99,235,.15)}',
  '.pgn-fader{position:relative}',
  '.pgn-hidden{display:none!important}',
  '@media (max-width: 720px){.pgn-bar{flex-direction:column;align-items:stretch}.pgn-summary,.pgn-size{justify-content:center}.pgn-pages{order:-1}}'
].join('\n');

const SCRIPT = `(function(){
  if (window.__paginationInit) return;
  window.__paginationInit = true;

  var STYLE_ID = 'sc-pagination-style';
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = ${JSON.stringify(STYLE)};
    document.head.appendChild(s);
  }

  // -------- targets --------
  var TARGETS = [
    { id: 'mt',       container: '#companyBody',  childTag: 'TR',  defaultSize: 20,  sizes: [20, 50, 100, 200], placement: 'tableFooter', tableSelector: '#mt' },
    { id: 'awaiting', container: '#awaitingList', childTag: 'DIV', defaultSize: 20,  sizes: [10, 20, 50, 100],  placement: 'after' },
    { id: 'sent',     container: '#sentList',     childTag: 'DIV', defaultSize: 20,  sizes: [10, 20, 50, 100],  placement: 'after' },
    { id: 'log',      container: '#logBody',      childTag: 'TR',  defaultSize: 100, sizes: [50, 100, 200, 500],placement: 'tableFooter', tableSelector: '#tab-logs table.main-table' }
  ];

  function fmtNum(n) {
    var locale = (typeof LANG !== 'undefined' && LANG === 'en') ? 'en-US' : 'ja-JP';
    return Number(n).toLocaleString(locale);
  }
  function pgnT(key, fallback, params) {
    var text = (typeof I18N === 'object' && I18N && typeof I18N[key] === 'string' && I18N[key])
      ? I18N[key]
      : fallback;
    if (params) {
      Object.keys(params).forEach(function(k){
        text = text.replace('{' + k + '}', params[k]);
      });
    }
    return text;
  }

  function readStored(key, fallback) {
    try {
      var v = parseInt(localStorage.getItem('pgn:' + key + ':size') || '', 10);
      return Number.isFinite(v) && v > 0 ? v : fallback;
    } catch (_) { return fallback; }
  }
  function writeStored(key, size) {
    try { localStorage.setItem('pgn:' + key + ':size', String(size)); } catch (_) {}
  }

  function setup(target) {
    var container = document.querySelector(target.container);
    if (!container) return;
    if (container.dataset.pgnInit === '1') return;
    container.dataset.pgnInit = '1';

    var state = {
      page: 1,
      size: readStored(target.id, target.defaultSize),
      total: 0,
      visibleTotal: 0
    };

    var bar = buildBar(target, state);
    placeBar(target, container, bar.root);

    function getVisibleChildren() {
      // gather direct children of expected tag, excluding already-display:none from filters
      var kids = Array.prototype.filter.call(container.children, function(el){
        if (el.tagName !== target.childTag) return false;
        // 1.2.89 fix: 空状態プレースホルダ (例: "確認待ちの企業はありません") は数えない
        if (el.dataset.pgnSkip === '1') return false;
        // also skip elements with empty-state classes commonly used for "no items" placeholders
        if (el.className && /\\b(text-muted|empty-state|pgn-skip)\\b/.test(el.className)) return false;
        if (el.dataset.pgnHidden === '1') return true; // we'll re-evaluate
        // skip rows hidden by external filter
        if (el.style.display === 'none' && el.dataset.pgnHidden !== '1') return false;
        return true;
      });
      return kids;
    }

    function applyPage() {
      var visible = getVisibleChildren();
      state.visibleTotal = visible.length;
      var totalPages = Math.max(1, Math.ceil(visible.length / state.size));
      if (state.page > totalPages) state.page = totalPages;
      if (state.page < 1) state.page = 1;
      var start = (state.page - 1) * state.size;
      var end = start + state.size;
      visible.forEach(function(el, idx) {
        var inPage = idx >= start && idx < end;
        if (inPage) {
          if (el.dataset.pgnHidden === '1') {
            el.dataset.pgnHidden = '';
            el.style.display = '';
          }
        } else {
          el.dataset.pgnHidden = '1';
          el.style.display = 'none';
        }
      });
      bar.update(state, totalPages);
    }

    // Expose for debugging / external triggers
    window.__pgnDebug = window.__pgnDebug || {};
    window.__pgnDebug[target.id] = { state: state, applyPage: applyPage, container: container, bar: bar };

    bar.onChangePage = function(p) {
      state.page = p;
      applyPage();
      // scroll the list into view
      try {
        var anchor = target.tableSelector ? document.querySelector(target.tableSelector) : container;
        if (anchor) {
          var rect = anchor.getBoundingClientRect();
          if (rect.top < 0 || rect.bottom > window.innerHeight) {
            anchor.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
        }
      } catch (_) {}
    };
    bar.onChangeSize = function(sz) {
      state.size = sz;
      state.page = 1;
      writeStored(target.id, sz);
      applyPage();
    };

    var deb = null;
    function schedule() {
      if (deb) clearTimeout(deb);
      deb = setTimeout(applyPage, 32);
    }

    var observer = new MutationObserver(function(mutations){
      // children replaced (innerHTML write) — re-paginate
      schedule();
    });
    observer.observe(container, { childList: true, subtree: false, attributes: false });

    // also watch for filter-driven display:none toggles via subtree attribute mutation
    var attrObs = new MutationObserver(function(mutations){
      // only re-paginate when display style changed and the change wasn't us
      var shouldUpdate = mutations.some(function(m){
        return m.type === 'attributes' && m.attributeName === 'style' && m.target && (m.target.dataset || {}).pgnHidden !== '1';
      });
      if (shouldUpdate) schedule();
    });
    attrObs.observe(container, { childList: false, subtree: true, attributes: true, attributeFilter: ['style'] });

    schedule();
  }

  // -------- bar builder --------
  function buildBar(target, state) {
    var root = document.createElement('div');
    root.className = 'pgn-bar';
    root.dataset.pgn = target.id;

    var summary = document.createElement('div');
    summary.className = 'pgn-summary';
    var pages = document.createElement('div');
    pages.className = 'pgn-pages';
    var size = document.createElement('div');
    size.className = 'pgn-size';
    var sizeLabelSpan = document.createElement('span');
    sizeLabelSpan.textContent = pgnT('pagination.size.label', '表示件数');
    size.appendChild(sizeLabelSpan);
    var sizeUnit = pgnT('pagination.size.unit', '件');
    var sel = document.createElement('select');
    target.sizes.forEach(function(n){
      var opt = document.createElement('option');
      opt.value = String(n);
      opt.textContent = sizeUnit ? (n + sizeUnit) : String(n);
      if (n === state.size) opt.selected = true;
      sel.appendChild(opt);
    });
    size.appendChild(sel);

    root.appendChild(summary);
    root.appendChild(pages);
    root.appendChild(size);

    sel.addEventListener('change', function() {
      var v = parseInt(sel.value, 10);
      if (Number.isFinite(v) && v > 0) {
        api.onChangeSize && api.onChangeSize(v);
      }
    });

    var api = {
      root: root,
      onChangePage: null,
      onChangeSize: null,
      update: function(st, totalPages) {
        if (st.visibleTotal === 0) {
          root.classList.add('empty');
          summary.textContent = '';
          pages.innerHTML = '';
          return;
        }
        root.classList.remove('empty');

        var start = (st.page - 1) * st.size + 1;
        var end = Math.min(st.visibleTotal, st.page * st.size);
        // Use HTML-escaped <b> wrappers in the localized summary.
        // The localized template uses {start}, {end}, {total} placeholders.
        var summaryTemplate = pgnT('pagination.summary', '全 {total} 件中 {start}–{end} を表示');
        summary.innerHTML = summaryTemplate
          .replace('{total}', '<b>' + fmtNum(st.visibleTotal) + '</b>')
          .replace('{start}', '<b>' + fmtNum(start) + '</b>')
          .replace('{end}', '<b>' + fmtNum(end) + '</b>');

        // render page numbers with ellipsis
        pages.innerHTML = '';
        var prev = mkBtn('chevron_left', pgnT('pagination.prev', '前へ'), { nav: true });
        prev.disabled = st.page <= 1;
        prev.addEventListener('click', function(){ if (st.page > 1) api.onChangePage(st.page - 1); });
        pages.appendChild(prev);

        var nums = computePageNums(st.page, totalPages);
        nums.forEach(function(n){
          if (n === '…') {
            var sp = document.createElement('span');
            sp.className = 'pgn-ellipsis';
            sp.textContent = '…';
            pages.appendChild(sp);
          } else {
            var b = mkBtn(String(n), String(n), { active: n === st.page });
            b.addEventListener('click', function(){ if (n !== st.page) api.onChangePage(n); });
            pages.appendChild(b);
          }
        });

        var next = mkBtn('chevron_right', pgnT('pagination.next', '次へ'), { nav: true });
        next.disabled = st.page >= totalPages;
        next.addEventListener('click', function(){ if (st.page < totalPages) api.onChangePage(st.page + 1); });
        pages.appendChild(next);
      }
    };
    return api;
  }

  function mkBtn(content, label, opts) {
    opts = opts || {};
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'pgn-btn' + (opts.nav ? ' nav' : '') + (opts.active ? ' active' : '');
    b.setAttribute('aria-label', label);
    if (opts.nav) {
      b.innerHTML = '<span class="material-symbols-outlined">' + content + '</span>';
    } else {
      b.textContent = content;
    }
    return b;
  }

  function computePageNums(current, total) {
    if (total <= 7) {
      var arr = [];
      for (var i = 1; i <= total; i++) arr.push(i);
      return arr;
    }
    var out = [1];
    if (current > 4) out.push('…');
    var start = Math.max(2, current - 1);
    var end = Math.min(total - 1, current + 1);
    for (var j = start; j <= end; j++) out.push(j);
    if (current < total - 3) out.push('…');
    out.push(total);
    return out;
  }

  function placeBar(target, container, bar) {
    if (target.placement === 'tableFooter' && target.tableSelector) {
      var table = document.querySelector(target.tableSelector);
      if (table && table.parentNode) {
        // insert after the table's outer wrapper
        var anchor = table.closest('.table-shell') || table;
        if (anchor.parentNode) {
          anchor.parentNode.insertBefore(bar, anchor.nextSibling);
          return;
        }
      }
    }
    // default: after the container
    if (container.parentNode) {
      container.parentNode.insertBefore(bar, container.nextSibling);
      bar.classList.add('standalone');
    }
  }

  function init() {
    ensureStyle();
    TARGETS.forEach(function(t){
      // wait until container exists
      var tries = 0;
      var iv = setInterval(function(){
        tries++;
        var c = document.querySelector(t.container);
        if (c) { clearInterval(iv); setup(t); }
        else if (tries > 20) clearInterval(iv);
      }, 200);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();`;

module.exports = function renderPaginationScript() {
  return SCRIPT;
};

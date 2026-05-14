'use strict';

/**
 * 企業リスト (#mt main-table) の列幅をドラッグで調整するクライアントスクリプト。
 *
 * - 各 thead th の右端に `.col-resizer` ハンドルを追加
 * - ドラッグで対応する <col> の width を更新
 * - localStorage('mt:colWidths:v1') に保存し、再読み込みで復元
 * - ダブルクリックで個別リセット
 *
 * 呼び出し側: dashboard-server.cjs の buildPage() が <script> 内で展開する。
 */

const STYLE = [
  '.main-table thead th{position:relative}',
  '.main-table thead th .col-resizer{position:absolute;top:0;right:-3px;width:6px;height:100%;cursor:col-resize;user-select:none;z-index:2;background:transparent;transition:background .12s}',
  '.main-table thead th .col-resizer:hover,.main-table thead th .col-resizer.dragging{background:var(--primary)}',
  'body.col-resizing,body.col-resizing *{cursor:col-resize!important;user-select:none!important}'
].join('\n');

const SCRIPT = `(function(){
  var STORAGE_KEY = 'mt:colWidths:v1';
  var MIN_WIDTH = 40;
  var STYLE_ID = 'mt-col-resizer-style';

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = ${JSON.stringify(STYLE)};
    document.head.appendChild(s);
  }

  function readSaved() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : null;
    } catch (_) {
      return null;
    }
  }

  function writeSaved(widths) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(widths));
    } catch (_) {}
  }

  function applySaved(cols) {
    var saved = readSaved();
    if (!saved || saved.length !== cols.length) return;
    for (var i = 0; i < cols.length; i++) {
      var w = saved[i];
      if (typeof w === 'number' && w > 0) {
        cols[i].style.width = w + 'px';
      }
    }
  }

  function snapshot(cols) {
    return cols.map(function (col) {
      var raw = col.style.width;
      if (!raw) return null;
      var n = parseFloat(raw);
      return isNaN(n) ? null : Math.round(n);
    });
  }

  function attachHandle(table, th, idx, cols) {
    if (th.querySelector(':scope > .col-resizer')) return;

    var handle = document.createElement('span');
    handle.className = 'col-resizer';
    handle.setAttribute('aria-hidden', 'true');
    handle.title = 'ドラッグで列幅を変更 / ダブルクリックでリセット';

    handle.addEventListener('mousedown', function (ev) {
      if (ev.button !== 0) return;
      ev.preventDefault();
      ev.stopPropagation();

      var startX = ev.clientX;
      var startWidth = th.getBoundingClientRect().width;

      handle.classList.add('dragging');
      document.body.classList.add('col-resizing');

      function onMove(e) {
        var delta = e.clientX - startX;
        var next = Math.max(MIN_WIDTH, Math.round(startWidth + delta));
        cols[idx].style.width = next + 'px';
      }
      function onUp() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        handle.classList.remove('dragging');
        document.body.classList.remove('col-resizing');
        writeSaved(snapshot(cols));
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    handle.addEventListener('dblclick', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      cols[idx].style.width = '';
      writeSaved(snapshot(cols));
    });

    th.appendChild(handle);
  }

  function init() {
    var table = document.getElementById('mt');
    if (!table) return;
    if (table.dataset.colResizerInit === '1') return;

    var colgroup = table.querySelector(':scope > colgroup');
    if (!colgroup) return;
    var cols = Array.prototype.slice.call(colgroup.querySelectorAll(':scope > col'));
    var ths = Array.prototype.slice.call(table.querySelectorAll(':scope > thead > tr > th'));
    if (cols.length === 0 || cols.length !== ths.length) return;

    table.dataset.colResizerInit = '1';
    ensureStyle();

    applySaved(cols);

    for (var i = 0; i < ths.length - 1; i++) {
      attachHandle(table, ths[i], i, cols);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();`;

module.exports = function renderColumnResizerScript() {
  return SCRIPT;
};

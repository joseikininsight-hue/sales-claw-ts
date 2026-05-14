'use strict';

/**
 * Launch Modal の AI プロバイダーアイコン視認性改善。
 *
 * 既定の .lp-icon は背景なし(透明)で、Codex のような単色黒系のロゴが
 * ダーク背景に同化して見えなかった問題を修正。
 *
 * - ライトモード: 各プロバイダーのブランドカラーをほんのりタイントした背景
 * - ダークモード: Codex (黒系ロゴ) は白系の panel + 微妙な発光、Claude/Gemini は dim 化
 *   ただしロゴ自体には触らないので Gemini のグラデや Claude のオレンジは維持
 */

const STYLE = [
  /* ---------- Light mode (default) ---------- */
  '.lp-icon{background:rgba(15,23,42,.045);border:1px solid rgba(15,23,42,.06);box-shadow:inset 0 1px 0 rgba(255,255,255,.4),0 1px 2px rgba(15,23,42,.04);transition:background .18s,box-shadow .18s,border-color .18s}',
  '.lp-icon[data-provider="claude"]{background:rgba(204,120,92,.10);border-color:rgba(204,120,92,.18)}',
  '.lp-icon[data-provider="codex"]{background:rgba(15,23,42,.06);border-color:rgba(15,23,42,.10)}',
  '.lp-icon[data-provider="gemini"]{background:rgba(66,133,244,.08);border-color:rgba(66,133,244,.16)}',
  '.lp-icon img{display:block}',

  /* hover / selected: stronger contrast */
  '.launch-provider-card:hover .lp-icon{background:#fff;border-color:rgba(15,23,42,.18);box-shadow:0 2px 6px rgba(15,23,42,.08)}',
  '.launch-provider-card.selected .lp-icon{background:#fff;border-color:rgba(15,23,42,.18);box-shadow:0 4px 10px rgba(15,23,42,.10)}',

  /* ---------- Dark mode override ---------- */
  '[data-theme="dark"] .lp-icon{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.10);box-shadow:inset 0 1px 0 rgba(255,255,255,.06)}',
  '[data-theme="dark"] .lp-icon[data-provider="claude"]{background:rgba(204,120,92,.18);border-color:rgba(204,120,92,.34)}',
  '[data-theme="dark"] .lp-icon[data-provider="gemini"]{background:rgba(96,165,250,.18);border-color:rgba(96,165,250,.32)}',
  /* Codex は黒のロゴなのでダークモードでは白系のパネルにして黒ロゴが映えるように */
  '[data-theme="dark"] .lp-icon[data-provider="codex"]{background:#f5f7fa;border-color:rgba(255,255,255,.18);box-shadow:0 0 0 2px rgba(255,255,255,.04),inset 0 1px 0 rgba(255,255,255,.6)}',
  '[data-theme="dark"] .launch-provider-card:hover .lp-icon{background:rgba(255,255,255,.12);border-color:rgba(255,255,255,.22);box-shadow:0 2px 8px rgba(0,0,0,.35)}',
  '[data-theme="dark"] .launch-provider-card:hover .lp-icon[data-provider="codex"]{background:#ffffff;border-color:rgba(255,255,255,.4)}',
  '[data-theme="dark"] .launch-provider-card.selected .lp-icon{background:rgba(255,255,255,.18);border-color:rgba(255,255,255,.3);box-shadow:0 4px 12px rgba(0,0,0,.4)}',
  '[data-theme="dark"] .launch-provider-card.selected .lp-icon[data-provider="codex"]{background:#ffffff;border-color:rgba(255,255,255,.5)}'
].join('\n');

const SCRIPT = `(function(){
  if (window.__providerIconFixInit) return;
  window.__providerIconFixInit = true;
  var s = document.createElement('style');
  s.id = 'provider-icon-fix';
  s.textContent = ${JSON.stringify(STYLE)};
  document.head.appendChild(s);
})();`;

module.exports = function renderProviderIconFixScript() {
  return SCRIPT;
};

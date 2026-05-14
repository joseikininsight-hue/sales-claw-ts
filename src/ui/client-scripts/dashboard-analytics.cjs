'use strict';

/**
 * Analytics extension script (theme toggle + refined analytics renderers).
 *
 * Loaded after renderDashboardScript() inside the same <script> block.
 * Wraps existing updateCharts() to feed new analytics sub-sections and
 * hooks the theme-toggle button wired up in the header.
 */

const SCRIPT = `
// ───── Theme toggle ──────────────────────────────────────────
function currentTheme(){
  return document.documentElement.getAttribute('data-theme') || 'light';
}
function applyTheme(theme){
  document.documentElement.setAttribute('data-theme', theme);
  try { localStorage.setItem('dashboardTheme', theme); } catch(_){}
  // update Chart.js defaults & repaint existing charts
  if (typeof Chart !== 'undefined') {
    const isDark = theme === 'dark';
    Chart.defaults.color = isDark ? '#94a3b8' : '#64748b';
    Chart.defaults.borderColor = isDark ? 'rgba(148,163,184,.08)' : 'rgba(15,23,42,.06)';
    [window._trendChart, window._statusDonut, window._dailyBars].forEach(ch => {
      if (!ch) return;
      try {
        // grid color re-apply
        if (ch.options && ch.options.scales) {
          if (ch.options.scales.y && ch.options.scales.y.grid) {
            ch.options.scales.y.grid.color = isDark ? 'rgba(148,163,184,.08)' : 'rgba(15,23,42,.04)';
          }
          if (ch.options.scales.x && ch.options.scales.x.grid) {
            ch.options.scales.x.grid.color = isDark ? 'rgba(148,163,184,.08)' : 'rgba(15,23,42,.04)';
          }
        }
        ch.update('none');
      } catch(_){}
    });
  }
  // repaint breakdown donut (SVG) — uses token-driven --bg-raised stroke
  if (typeof _lastAnalyticsStats !== 'undefined' && _lastAnalyticsStats) {
    try { renderBreakdownDonut(_lastAnalyticsStats); } catch(_){}
  }
}
function toggleTheme(){
  applyTheme(currentTheme() === 'dark' ? 'light' : 'dark');
}
window.toggleTheme = toggleTheme;

// ───── Analytics extras ──────────────────────────────────────
let _dailyBars = null;
let _lastAnalyticsStats = null;
window._dailyBars = null;

function initDailyBarsChart(labels, values){
  if (typeof Chart === 'undefined') return;
  const el = document.getElementById('dailyBarsChart');
  if (!el) return;
  if (_dailyBars) { _dailyBars.destroy(); _dailyBars = null; }
  const grad = el.getContext('2d').createLinearGradient(0, 0, 0, 170);
  grad.addColorStop(0, 'rgba(16,185,129,.9)');
  grad.addColorStop(1, 'rgba(16,185,129,.35)');
  _dailyBars = new Chart(el.getContext('2d'), {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [{
        label: '送信',
        data: values,
        backgroundColor: grad,
        borderRadius: 6,
        borderSkipped: false,
        maxBarThickness: 28
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { backgroundColor: '#1a1a1a', titleColor: '#fff', bodyColor: '#e5e7eb', padding: 9, cornerRadius: 4 }
      },
      scales: {
        y: { beginAtZero: true, border: { display: false }, grid: { color: 'rgba(15,23,42,.04)' }, ticks: { maxTicksLimit: 5, font: { size: 10 }, padding: 6 } },
        x: { border: { display: false }, grid: { display: false }, ticks: { font: { size: 10 } } }
      }
    }
  });
  window._dailyBars = _dailyBars;
}

function describeArc(cx, cy, r, startAngle, endAngle) {
  // Returns SVG arc path from startAngle to endAngle (deg, 0 = 3 o'clock).
  const rad = (a) => (a - 90) * Math.PI / 180;
  const x1 = cx + r * Math.cos(rad(startAngle));
  const y1 = cy + r * Math.sin(rad(startAngle));
  const x2 = cx + r * Math.cos(rad(endAngle));
  const y2 = cy + r * Math.sin(rad(endAngle));
  const large = endAngle - startAngle > 180 ? 1 : 0;
  return 'M ' + x1 + ',' + y1 + ' A ' + r + ',' + r + ' 0 ' + large + ' 1 ' + x2 + ',' + y2;
}

function renderBreakdownDonut(s){
  const svg = document.getElementById('breakdownDonutSvg');
  if (!svg) return;
  const total = Math.max(0, (s.approachable|0));
  const sent = s.submitted|0;
  const actionNeeded = (s.formFill|0) + (s.awaitingApproval|0);
  const awaiting = s.awaitingApproval|0;
  const errors = s.error|0;
  const excluded = s.excluded|0;
  const unprocessed = Math.max(0, total - sent - actionNeeded - errors - excluded);
  const segs = [
    { val: sent, color: '#10b981', lab: '送信済み' },
    { val: actionNeeded - awaiting, color: '#3b82f6', lab: '要対応' },
    { val: awaiting, color: '#f59e0b', lab: '確認待ち' },
    { val: errors, color: '#ef4444', lab: 'エラー' },
    { val: excluded, color: '#64748b', lab: '除外' },
    { val: unprocessed, color: 'var(--bg-raised)', lab: '未処理', muted: true }
  ];
  const sum = segs.reduce((a, b) => a + Math.max(0, b.val), 0) || 1;
  // clear existing dynamic paths (keep first child = track circle)
  while (svg.childNodes.length > 1) svg.removeChild(svg.lastChild);
  let angle = 0;
  const cx = 60, cy = 60, r = 46;
  segs.forEach((seg) => {
    const v = Math.max(0, seg.val);
    if (v <= 0) return;
    const sweep = (v / sum) * 360;
    if (sweep >= 359.99) {
      // full ring — draw circle instead of arc (avoid arc bug)
      const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      c.setAttribute('cx', cx); c.setAttribute('cy', cy); c.setAttribute('r', r);
      c.setAttribute('fill', 'none'); c.setAttribute('stroke', seg.color); c.setAttribute('stroke-width', '14');
      svg.appendChild(c);
    } else {
      const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      p.setAttribute('d', describeArc(cx, cy, r, angle, angle + sweep));
      p.setAttribute('fill', 'none');
      p.setAttribute('stroke', seg.color);
      p.setAttribute('stroke-width', '14');
      p.setAttribute('stroke-linecap', 'butt');
      svg.appendChild(p);
    }
    angle += sweep;
  });
  const tot = document.getElementById('breakdownTotal');
  if (tot) tot.textContent = total;
  // legend
  const leg = document.getElementById('breakdownLegend');
  if (leg) {
    leg.innerHTML = segs.map((seg) => {
      const v = Math.max(0, seg.val);
      const pct = sum > 0 ? Math.round(v / sum * 100) : 0;
      const dotColor = seg.muted ? 'var(--bg-raised);border:1.5px solid var(--border-default)' : seg.color;
      return '<div class="breakdown-legend-item">' +
        '<span class="dot" style="background:' + dotColor + '"></span>' +
        '<span class="lab">' + seg.lab + '</span>' +
        '<span class="val">' + v + '</span>' +
        '<span class="pct">(' + pct + '%)</span>' +
        '</div>';
    }).join('');
  }
}

function updatePipelineSegments(s){
  const bar = document.getElementById('analyticsPipeline');
  if (!bar) return;
  // Keep the primary #analyticsProgressBar span (width-driven). Remove any
  // secondary segments we previously injected and re-create.
  const segments = [
    { cls: 'seg-submitted', color: '#10b981', val: s.submitted|0 },
    { cls: 'seg-action',    color: '#3b82f6', val: (s.formFill|0) },
    { cls: 'seg-awaiting',  color: '#f59e0b', val: s.awaitingApproval|0 },
    { cls: 'seg-error',     color: '#ef4444', val: s.error|0 }
  ];
  const total = Math.max(1, (s.approachable|0));
  // Remove any previous additional segments (leave .analyticsProgressBar primary)
  Array.from(bar.querySelectorAll('span.pipe-seg-extra')).forEach((n) => n.remove());
  // Set primary bar to submitted ratio
  const primary = document.getElementById('analyticsProgressBar');
  if (primary) {
    const pct = total > 0 ? ((s.submitted|0) / total * 100) : 0;
    primary.style.width = pct + '%';
  }
  // Stacked minor segments to the right of submitted (for visual accent)
  let offset = total > 0 ? ((s.submitted|0) / total * 100) : 0;
  ['seg-action', 'seg-awaiting', 'seg-error'].forEach((cls, idx) => {
    const seg = segments[idx + 1];
    if (!seg || seg.val <= 0) return;
    const w = seg.val / total * 100;
    const span = document.createElement('span');
    span.className = 'pipe-seg-extra';
    span.style.position = 'absolute';
    span.style.top = '0';
    span.style.left = offset + '%';
    span.style.height = '100%';
    span.style.width = w + '%';
    span.style.background = seg.color;
    span.style.opacity = '.85';
    span.style.transition = 'width .6s var(--ease-out-expo),left .6s var(--ease-out-expo)';
    bar.appendChild(span);
    offset += w;
  });
}

function updateAnalyticsDonut(pct){
  const fill = document.getElementById('analyticsDonutFill');
  if (!fill) return;
  const circumference = 2 * Math.PI * 52; // ~326.73
  const clamped = Math.max(0, Math.min(100, pct));
  fill.style.strokeDashoffset = String(circumference * (1 - clamped / 100));
}

function renderRecentErrors(data){
  const host = document.getElementById('recentErrorsList');
  if (!host) return;
  const companies = (data && data.companies) || [];
  const items = [];
  // Prefer server-provided recentErrors when available
  if (Array.isArray(data && data.recentErrors) && data.recentErrors.length) {
    data.recentErrors.slice(0, 5).forEach((e) => {
      items.push({
        name: e.companyName || e.name || '(unknown)',
        reason: e.reason || e.detail || e.message || '',
        ts: e.ts || e.time || null
      });
    });
  } else {
    // Fallback: derive from companies list (lastAction = 'error')
    companies.forEach((c) => {
      if (c && c.lastAction === 'error') {
        items.push({
          name: c.name || c.companyName || '',
          reason: c.lastErrorDetail || c.lastActionDetail || c.errorReason || c.formUrl || '',
          ts: c.lastActionAt || c.sentAt || c.awaitingAt || null
        });
      }
    });
    items.sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0));
  }
  if (!items.length) {
    host.innerHTML = '<div class="recent-errors-empty">エラーはありません</div>';
    return;
  }
  host.innerHTML = items.slice(0, 5).map((it) => {
    const rel = it.ts ? relativeTimeJa(it.ts) : '';
    return '<div class="recent-error-item">' +
      '<span class="recent-error-dot"></span>' +
      '<div class="recent-error-body">' +
        '<div class="recent-error-name">' + esc(it.name) + '</div>' +
        '<div class="recent-error-reason">' + esc(it.reason) + '</div>' +
      '</div>' +
      '<div class="recent-error-time">' + esc(rel) + '</div>' +
    '</div>';
  }).join('');
}

function relativeTimeJa(ts){
  try {
    const t = typeof ts === 'string' ? new Date(ts).getTime() : Number(ts);
    if (!Number.isFinite(t) || t <= 0) return '';
    const diff = Date.now() - t;
    const m = Math.floor(diff / 60000);
    if (m < 1) return 'たった今';
    if (m < 60) return m + '分前';
    const h = Math.floor(m / 60);
    if (h < 24) return h + '時間前';
    const d = Math.floor(h / 24);
    return d + '日前';
  } catch(_) { return ''; }
}

function renderInsight(data){
  const host = document.getElementById('insightDesc');
  if (!host) return;
  const stats = (data && data.stats) || {};
  const trend = (data && data.trendData) || null;
  const sent = stats.submitted || 0;
  const errors = stats.error || 0;
  const approachable = stats.approachable || 0;
  let txt = '';
  if (trend && Array.isArray(trend.sent) && trend.sent.length >= 2) {
    const today = trend.sent[trend.sent.length - 1] || 0;
    const prev = trend.sent[trend.sent.length - 2] || 0;
    let delta = 0;
    if (prev > 0) delta = Math.round((today - prev) / prev * 100);
    if (today > prev && prev > 0) {
      txt = '送信率は前日比 <span class="pos">+' + delta + '%</span> 増加しました。';
    } else if (today < prev && prev > 0) {
      txt = '送信率は前日比 <span class="neg">' + delta + '%</span> 減少しました。';
    } else if (today > 0) {
      txt = '本日は <b>' + today + '</b> 件送信しました。';
    } else {
      txt = '本日はまだ送信がありません。';
    }
  } else {
    txt = '送信を開始すると集計結果が表示されます。';
  }
  if (errors > 0 && approachable > 0) {
    const rate = Math.round(errors / approachable * 100);
    txt += ' エラー率は <b>' + rate + '%</b> です。入力内容の見直しを推奨します。';
  }
  host.innerHTML = txt;
}

function computeDailyBars(trend){
  if (!trend || !Array.isArray(trend.labels)) {
    return { labels: ['6日前','5日前','4日前','3日前','2日前','昨日','今日'], values: [0,0,0,0,0,0,0] };
  }
  return { labels: trend.labels, values: trend.sent || [] };
}

function updateAnalyticsExtras(data){
  if (!data) return;
  ensureOpsQuickPanel();
  const stats = data.stats || {};
  _lastAnalyticsStats = stats;
  // 1. Donut progress
  const total = stats.approachable || 0;
  const done = stats.submitted || 0;
  const pct = total > 0 ? Math.round(done / total * 100) : 0;
  updateAnalyticsDonut(pct);
  // 2. Meta sum text
  const metaSum = document.getElementById('analyticsMetaSum');
  if (metaSum) metaSum.textContent = done + ' / ' + total + ' 完了 (' + pct + '%)';
  // 3. Pipeline segments (on top of existing width-driven primary)
  updatePipelineSegments(stats);
  // 4. Breakdown donut
  renderBreakdownDonut(stats);
  // 5. Daily bar chart
  const dailyBars = computeDailyBars(data.trendData || {});
  if (!_dailyBars) initDailyBarsChart(dailyBars.labels, dailyBars.values);
  else {
    _dailyBars.data.labels = dailyBars.labels;
    _dailyBars.data.datasets[0].data = dailyBars.values;
    _dailyBars.update('none');
  }
  // 6. Recent errors
  renderRecentErrors(data);
  // 7. Insight
  renderInsight(data);
}
window.updateAnalyticsExtras = updateAnalyticsExtras;

function showAllErrors(){
  const errTab = document.querySelector('.fb[data-f="error"]');
  if (errTab) errTab.click();
}
window.showAllErrors = showAllErrors;

// ───── P1 operations quick panel ────────────────────────────
let _opsQuickPanelMounted = false;

function ensureOpsQuickPanel(){
  const row = document.getElementById('analyticsRow');
  if (!row) return;
  if (_opsQuickPanelMounted && document.getElementById('analyticsOpsGrid')) return;
  if (document.getElementById('analyticsOpsGrid')) {
    _opsQuickPanelMounted = true;
    return;
  }
  const grid = document.createElement('div');
  grid.id = 'analyticsOpsGrid';
  grid.className = 'analytics-grid';
  grid.style.marginTop = '14px';
  grid.innerHTML =
    '<div class="analytics-sub-card">' +
      '<div class="analytics-sub-title">' +
        '<span>データ品質</span>' +
        '<button class="analytics-sub-action" onclick="loadTargetValidationResult()"><span class="material-symbols-outlined" style="font-size:15px;vertical-align:-3px">refresh</span> 結果</button>' +
        '<button class="analytics-sub-action" onclick="runTargetValidation()"><span class="material-symbols-outlined" style="font-size:15px;vertical-align:-3px">fact_check</span> 検証</button>' +
      '</div>' +
      '<div id="targetValidationStatus" class="recent-errors"><div class="recent-errors-empty">結果または検証を押してください</div></div>' +
    '</div>' +
    '<div class="analytics-sub-card">' +
      '<div class="analytics-sub-title">' +
        '<span>エラー回復</span>' +
        '<button class="analytics-sub-action" onclick="loadErrorRecoveryGroups()"><span class="material-symbols-outlined" style="font-size:15px;vertical-align:-3px">refresh</span> 更新</button>' +
      '</div>' +
      '<div id="errorRecoveryGroups" class="recent-errors"><div class="recent-errors-empty">更新を押すと分類します</div></div>' +
    '</div>' +
    '<div class="analytics-sub-card">' +
      '<div class="analytics-sub-title"><span>監査エクスポート</span></div>' +
      '<div style="display:flex;flex-wrap:wrap;gap:8px">' +
        '<button class="analytics-sub-action" onclick="downloadActionLogCsv()"><span class="material-symbols-outlined" style="font-size:15px;vertical-align:-3px">download</span> action-log CSV</button>' +
        '<button class="analytics-sub-action" onclick="downloadCompaniesCsv()"><span class="material-symbols-outlined" style="font-size:15px;vertical-align:-3px">download</span> companies CSV</button>' +
      '</div>' +
      '<div style="font-size:.72rem;color:var(--text-muted);line-height:1.5;margin-top:4px">Excel 直開き用 UTF-8 BOM 付き。数式注入はサーバー側でテキスト化します。</div>' +
    '</div>';
  row.appendChild(grid);
  _opsQuickPanelMounted = true;
}
window.ensureOpsQuickPanel = ensureOpsQuickPanel;

function renderMiniRow(title, detail, tone, actionHtml){
  const color = tone === 'bad' ? '#ef4444' : tone === 'warn' ? '#f59e0b' : tone === 'good' ? '#10b981' : '#94a3b8';
  return '<div class="recent-error-item" style="align-items:flex-start">' +
    '<span class="recent-error-dot" style="background:' + color + ';margin-top:6px"></span>' +
    '<div class="recent-error-body">' +
      '<div class="recent-error-name">' + esc(title) + '</div>' +
      '<div class="recent-error-reason">' + esc(detail || '') + '</div>' +
    '</div>' +
    (actionHtml || '') +
  '</div>';
}

function renderTargetValidationResult(data){
  const host = document.getElementById('targetValidationStatus');
  if (!host) return;
  if (!data || !data.ok) {
    host.innerHTML = '<div class="recent-errors-empty">検証結果を取得できません</div>';
    return;
  }
  const progress = data.progress || {};
  if (data.running) {
    host.innerHTML = renderMiniRow('検証中', (progress.done || 0) + ' / ' + (progress.total || 0) + ' 件', 'warn', '');
    clearTimeout(window._targetValidationTimer);
    window._targetValidationTimer = setTimeout(loadTargetValidationResult, 1800);
    return;
  }
  if (!data.hasResult) {
    host.innerHTML = '<div class="recent-errors-empty">まだ検証結果がありません</div>';
    return;
  }
  const issues = Array.isArray(data.issues) ? data.issues : [];
  const tone = issues.length ? 'bad' : 'good';
  let html = renderMiniRow(
    issues.length ? '要確認 ' + issues.length + ' 件' : '不整合なし',
    '検証済み ' + (data.checked || progress.done || 0) + ' / ' + (data.total || progress.total || 0) + ' 件',
    tone,
    ''
  );
  html += issues.slice(0, 5).map((it) => renderMiniRow(
    '#' + (it.no || '-') + ' ' + (it.name || ''),
    (it.severity || '') + ' / ' + (it.reason || ''),
    it.severity === 'high' ? 'bad' : 'warn',
    ''
  )).join('');
  host.innerHTML = html;
}

async function loadTargetValidationResult(){
  try {
    const res = await fetch('/api/target-list/validation-result');
    const data = await res.json();
    renderTargetValidationResult(data);
  } catch (e) {
    const host = document.getElementById('targetValidationStatus');
    if (host) host.innerHTML = '<div class="recent-errors-empty">' + esc(e.message) + '</div>';
  }
}
window.loadTargetValidationResult = loadTargetValidationResult;

async function runTargetValidation(){
  const host = document.getElementById('targetValidationStatus');
  if (host) host.innerHTML = renderMiniRow('検証を開始しています', '', 'warn', '');
  try {
    const res = await fetch('/api/target-list/validate', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
    renderTargetValidationResult({ ok: true, running: true, progress: { done: 0, total: data.total || 0 } });
    if (typeof showToast === 'function') showToast('データ品質検証を開始しました', 'success');
  } catch (e) {
    if (host) host.innerHTML = renderMiniRow('検証開始に失敗', e.message, 'bad', '');
    if (typeof showToast === 'function') showToast('データ品質検証に失敗: ' + e.message, 'error');
  }
}
window.runTargetValidation = runTargetValidation;

function renderErrorRecoveryGroups(data){
  const host = document.getElementById('errorRecoveryGroups');
  if (!host) return;
  if (!data || !data.ok) {
    host.innerHTML = '<div class="recent-errors-empty">エラー分類を取得できません</div>';
    return;
  }
  const groups = Array.isArray(data.groups) ? data.groups : [];
  window._errorRecoveryGroups = groups;
  if (!groups.length) {
    host.innerHTML = '<div class="recent-errors-empty">再試行対象のエラーはありません</div>';
    return;
  }
  host.innerHTML = groups.slice(0, 6).map((g) => {
    const nos = (g.companies || []).map((c) => c.no).filter(Boolean).join(',');
    const action = '<button class="analytics-sub-action" style="white-space:nowrap" onclick="retryErrorGroup(\\'' + esc(g.key) + '\\')">再試行</button>';
    return renderMiniRow(g.label + ' (' + g.count + ')', nos ? 'No: ' + nos : '', g.key === 'captcha' || g.key === 'unsupported' ? 'warn' : 'bad', action);
  }).join('');
}

async function loadErrorRecoveryGroups(){
  const host = document.getElementById('errorRecoveryGroups');
  if (host) host.innerHTML = '<div class="recent-errors-empty">分類中...</div>';
  try {
    const res = await fetch('/api/errors/grouped');
    const data = await res.json();
    renderErrorRecoveryGroups(data);
  } catch (e) {
    if (host) host.innerHTML = '<div class="recent-errors-empty">' + esc(e.message) + '</div>';
  }
}
window.loadErrorRecoveryGroups = loadErrorRecoveryGroups;

async function retryErrorGroup(key){
  const group = (window._errorRecoveryGroups || []).find((g) => g.key === key);
  const companyNos = group && Array.isArray(group.companies) ? group.companies.map((c) => c.no).filter(Boolean) : [];
  if (!companyNos.length) return;
  if (!confirm((group.label || key) + ' の ' + companyNos.length + ' 件を再試行しますか？')) return;
  try {
    const res = await fetch('/api/error/retry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ companyNos: companyNos })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
    if (typeof showToast === 'function') showToast('再試行キューに追加しました: ' + companyNos.length + ' 件', 'success');
    setTimeout(loadErrorRecoveryGroups, 1200);
  } catch (e) {
    if (typeof showToast === 'function') showToast('再試行に失敗: ' + e.message, 'error');
    else alert(e.message);
  }
}
window.retryErrorGroup = retryErrorGroup;

function downloadActionLogCsv(){
  window.location.href = withSessionQuery('/api/export/action-log.csv');
}
window.downloadActionLogCsv = downloadActionLogCsv;

function downloadCompaniesCsv(){
  window.location.href = withSessionQuery('/api/export/companies.csv');
}
window.downloadCompaniesCsv = downloadCompaniesCsv;

// ───── Wrap existing updateCharts to also feed the new sections ─────
(function(){
  const orig = typeof updateCharts === 'function' ? updateCharts : null;
  if (!orig) return;
  window.updateCharts = function(data){
    try { orig.call(this, data); } catch(e) { console.error('updateCharts orig err:', e); }
    try { updateAnalyticsExtras(data); } catch(e) { console.error('updateAnalyticsExtras err:', e); }
  };
})();

// On init, apply theme to Chart.js defaults so first render picks up right colors.
(function(){
  const t = currentTheme();
  if (typeof Chart !== 'undefined') {
    Chart.defaults.color = t === 'dark' ? '#94a3b8' : '#64748b';
  }
  // Hook theme-change for existing window-level changes (OS pref)
  try {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener && mq.addEventListener('change', (ev) => {
      if (!localStorage.getItem('dashboardTheme')) {
        applyTheme(ev.matches ? 'dark' : 'light');
      }
    });
  } catch(_){}
})();

// ───── Dashboard tab integration ─────────────────────────────
// The legacy dashboard script gates updateCharts() behind _analyticsOpen, which
// is only flipped when the 'companies' tab is active. Now that analytics lives
// in its own 'dashboard' tab, mark _analyticsOpen true whenever the user is on
// either tab and kick off initialization + a fresh render.
(function(){
  function markDashboardOpen(){
    // _analyticsOpen / _activeMainTab are declared as 'let' in the base
    // dashboard script; they share the same <script> block scope so we can
    // reassign directly — no 'window.' prefix needed.
    try { _analyticsOpen = true; } catch(_){}
    try { _activeMainTab = 'dashboard'; } catch(_){}
    if (typeof ensureAnalyticsInitialized === 'function') {
      try { ensureAnalyticsInitialized(); } catch(_){}
    }
    try { ensureOpsQuickPanel(); } catch(_){}
    if (typeof _latestDashboardData !== 'undefined' && _latestDashboardData && typeof updateCharts === 'function') {
      try { updateCharts(_latestDashboardData); } catch(_){}
    }
  }
  // Initial load — dashboard tab is now the default active tab.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(markDashboardOpen, 0));
  } else {
    setTimeout(markDashboardOpen, 0);
  }
  // Tab clicks — after the built-in handler toggles .active, ensure the
  // dashboard tab always runs analytics init/refresh.
  document.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest && e.target.closest('.tab-btn');
    if (!btn) return;
    const tab = btn.dataset && btn.dataset.tab;
    if (tab !== 'dashboard') return;
    setTimeout(markDashboardOpen, 0);
  }, false);
})();
`;

module.exports = function renderAnalyticsScript() {
  return SCRIPT;
};

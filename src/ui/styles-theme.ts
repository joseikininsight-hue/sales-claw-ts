'use strict';

/**
 * Theme extension (Dark mode + refined analytics + toolbar polish).
 *
 * Loaded by styles.cjs as an appendix. Keeps the legacy ":root" block
 * untouched while layering:
 *   - [data-theme="dark"] token overrides
 *   - ~ Pattern ② / ④ gradient button polish
 *   - New analytics layout (donut hero, stat cards, 3-col grid, insight)
 *   - Header theme-toggle button + wave decoration
 */

const THEME_CSS = `
/* =========================================================
   DARK THEME TOKENS  (Pattern ③/④ — deep navy + blue glow)
   ========================================================= */
[data-theme="dark"]{
  --primary:#3b82f6;--primary-dim:#2563eb;--primary-glow:rgba(59,130,246,.22);--on-primary:#ffffff;
  --text-1:#e8edf7;--text-2:#94a3b8;--text-3:#64748b;
  --bg-deep:#05080f;--bg-base:#0a0e17;--bg-surface:#0e1320;--bg-card:#121828;--bg-raised:#1a2238;--bg-hover:#232d44;
  --success:#10b981;--success-dim:rgba(16,185,129,.16);
  --warning:#f59e0b;--warning-dim:rgba(245,158,11,.16);
  --error:#ef4444;--error-dim:rgba(239,68,68,.18);
  --info:#a78bfa;--info-dim:rgba(167,139,250,.18);
  --neutral:#94a3b8;--neutral-dim:rgba(148,163,184,.16);
  --pipe-target:#818cf8;--pipe-form:#64748b;--pipe-filled:#3b82f6;--pipe-awaiting:#f59e0b;--pipe-submitted:#10b981;--pipe-error:#ef4444;--pipe-excluded:#4b5563;
  --border-subtle:rgba(148,163,184,.08);--border-default:rgba(148,163,184,.16);--border-strong:rgba(148,163,184,.28);
  --surface:var(--bg-base);--surface-low:var(--bg-deep);--surface-lowest:var(--bg-card);--surface-high:var(--bg-surface);--surface-container:var(--bg-raised);
  --on-surface:var(--text-1);--on-surface-variant:var(--text-2);--outline-variant:var(--border-subtle);--outline:var(--text-3);
  --error-container:var(--error-dim);--success-container:var(--success-dim);--warning-container:var(--warning-dim);--info-container:var(--info-dim);
  --secondary-container:rgba(167,139,250,.16);
  --shadow-xs:0 1px 2px rgba(0,0,0,.5);
  --shadow-ambient:0 1px 8px rgba(0,0,0,.35);
  --shadow-card:0 4px 20px rgba(0,0,0,.45),0 0 0 1px rgba(148,163,184,.04);
  --shadow-modal:0 24px 60px rgba(0,0,0,.7);
  --shadow-header:0 1px 12px rgba(0,0,0,.5);
  --shadow-cta:0 2px 18px rgba(59,130,246,.45);
  --glass-bg:rgba(10,14,23,.78);--glass-blur:blur(14px);--glass-border:rgba(148,163,184,.1);
}
[data-theme="dark"] body{background:var(--bg-base);color:var(--text-1)}
/* Tell the browser/OS to use dark-themed native controls (<select> popup,
   scrollbars, date pickers, autofill, focus rings). Without this the
   <select> dropdown list pops up in the OS's light style even though the
   surrounding page is dark. */
[data-theme="dark"]{color-scheme:dark}
[data-theme="light"]{color-scheme:light}
/* style the option list itself for browsers that respect option CSS
   (Chromium honors background/color on <option> in some recent versions) */
[data-theme="dark"] select{background:var(--bg-surface)!important;color:var(--text-1)!important;color-scheme:dark}
[data-theme="dark"] select option,[data-theme="dark"] select optgroup{background-color:#0e1320!important;color:#e8edf7!important;color-scheme:dark}
[data-theme="dark"] select option:checked,[data-theme="dark"] select option:hover{background-color:#2563eb!important;color:#fff!important}
[data-theme="dark"] select option:disabled{background-color:#0e1320!important;color:#64748b!important}
[data-theme="dark"] body.perf-mode{
  --glass-bg:#0a0e17;--glass-blur:none;--glass-border:rgba(148,163,184,.1);
  --shadow-ambient:0 1px 2px rgba(0,0,0,.45);
  --shadow-card:0 1px 3px rgba(0,0,0,.4),0 8px 18px rgba(0,0,0,.3);
  --shadow-modal:0 8px 24px rgba(0,0,0,.7);
}
[data-theme="dark"] ::-webkit-scrollbar-track{background:var(--bg-surface)}
[data-theme="dark"] ::-webkit-scrollbar-thumb{background:rgba(148,163,184,.2)}
[data-theme="dark"] ::-webkit-scrollbar-thumb:hover{background:rgba(148,163,184,.35)}

/* Surfaces that hardcoded white — rewire to tokens in dark only */
[data-theme="dark"] .main-table tbody tr{background:var(--bg-card)}
[data-theme="dark"] .main-table tbody tr:nth-child(even){background:var(--bg-surface)}
[data-theme="dark"] .main-table tbody td{color:var(--text-1);border-bottom-color:var(--border-subtle)}
[data-theme="dark"] .main-table thead th{background:var(--bg-surface);color:var(--text-3);border-bottom-color:var(--border-default)}
[data-theme="dark"] .main-table thead th[onclick]:hover{background:var(--bg-raised);color:var(--text-1)}
[data-theme="dark"] .main-table tbody tr:hover{background:rgba(59,130,246,.1)}
[data-theme="dark"] #tab-companies > div > div:last-child,
[data-theme="dark"] #tab-awaiting > div:first-child,
[data-theme="dark"] #tab-sent > div:first-child,
[data-theme="dark"] #tab-logs > div,
[data-theme="dark"] #tab-settings > div{background:var(--bg-card) !important;border-color:var(--border-subtle) !important}
[data-theme="dark"] .filter-bar{background:transparent;border-color:var(--border-subtle)}
[data-theme="dark"] .filter-field{background:transparent;border-color:var(--border-subtle)}
[data-theme="dark"] .settings-sidebar{background:var(--bg-surface);border-color:var(--border-subtle)}
[data-theme="dark"] .settings-main{background:var(--bg-card)}
[data-theme="dark"] .settings-callout{background:var(--bg-surface)}
[data-theme="dark"] .settings-group input,[data-theme="dark"] .settings-group textarea,[data-theme="dark"] .settings-group select{background:var(--bg-deep);color:var(--text-1);border-color:var(--border-default)}
[data-theme="dark"] .form-control,[data-theme="dark"] .form-control-sm{background:var(--bg-deep);color:var(--text-1);border-color:var(--border-default)}
[data-theme="dark"] .setup-check-card{background:var(--bg-card)}
[data-theme="dark"] .setup-check-card:hover{background:var(--bg-raised)}
[data-theme="dark"] .setup-status-chip{background:var(--bg-surface)}
[data-theme="dark"] .awaiting-card,[data-theme="dark"] .sent-card{background:var(--bg-card);border-color:var(--border-subtle)}
[data-theme="dark"] .stat-pill{background:var(--bg-raised);border-color:var(--border-subtle)}
[data-theme="dark"] .modal-panel{background:var(--bg-card);border-color:var(--border-default)}
[data-theme="dark"] .chart-panel{background:var(--bg-card);border-color:var(--border-subtle)}
[data-theme="dark"] .launch-provider-card{background:var(--bg-raised);border-color:var(--border-default)}
[data-theme="dark"] .launch-provider-card.selected.claude{background:linear-gradient(145deg,rgba(204,120,92,.15),var(--bg-raised))}
[data-theme="dark"] .launch-provider-card.selected.codex{background:linear-gradient(145deg,rgba(16,163,127,.15),var(--bg-raised))}
[data-theme="dark"] .launch-provider-card.selected.gemini{background:linear-gradient(145deg,rgba(66,133,244,.15),var(--bg-raised))}
[data-theme="dark"] .list-manager{background:var(--bg-surface)}
[data-theme="dark"] .list-manager .list-item{background:var(--bg-raised);border-color:var(--border-subtle)}
[data-theme="dark"] .obj-list-item{background:var(--bg-surface)}
[data-theme="dark"] .log-entry{background:var(--bg-surface)}
[data-theme="dark"] .log-entry:hover{background:var(--bg-raised)}
[data-theme="dark"] .preview-table th{background:var(--bg-surface);color:var(--text-2)}
[data-theme="dark"] .preview-table th,[data-theme="dark"] .preview-table td{border-color:var(--border-subtle)}
[data-theme="dark"] .save-bar{background:var(--bg-card);border-color:var(--border-subtle)}
[data-theme="dark"] #updateBanner{background:var(--primary-dim)}
[data-theme="dark"] .app-brand-mark{background:linear-gradient(145deg,#1a2238,#0e1a2e);border-color:rgba(59,130,246,.35);box-shadow:0 4px 16px rgba(59,130,246,.25)}
[data-theme="dark"] .app-brand-fallback{color:#60a5fa}
[data-theme="dark"] .app-build-chip{filter:brightness(1.15) saturate(.85)}
[data-theme="dark"] .btn{background:rgba(148,163,184,.05);color:var(--text-1);border-color:var(--border-default)}
[data-theme="dark"] .btn:hover{background:rgba(148,163,184,.12)}
[data-theme="dark"] .fb{color:var(--text-2);border-color:var(--border-default)}
[data-theme="dark"] .fb:not(.active):hover{background:var(--bg-raised);color:var(--text-1)}
[data-theme="dark"] .tab-btn:hover{background:rgba(59,130,246,.08)}
[data-theme="dark"] .tab-btn.active{background:rgba(59,130,246,.1)}

/* =========================================================
   THEME TOGGLE BUTTON (header)
   ========================================================= */
.theme-toggle{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;background:none;border:1px solid transparent;cursor:pointer;color:var(--text-3);transition:all .2s var(--ease-out-expo);border-radius:var(--radius-sm)!important;flex-shrink:0;position:relative;overflow:hidden}
.theme-toggle:hover{background:var(--bg-hover);color:var(--text-1);border-color:var(--border-default)}
.theme-toggle .ti{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:18px;transition:transform .4s var(--ease-spring),opacity .2s}
.theme-toggle .ti.sun{opacity:1;transform:rotate(0) scale(1)}
.theme-toggle .ti.moon{opacity:0;transform:rotate(-90deg) scale(.5)}
[data-theme="dark"] .theme-toggle .ti.sun{opacity:0;transform:rotate(90deg) scale(.5)}
[data-theme="dark"] .theme-toggle .ti.moon{opacity:1;transform:rotate(0) scale(1)}

/* =========================================================
   REFINED TOOLBAR (Pattern ② / ④ — gradient active + glow)
   ========================================================= */
.fb{border-radius:var(--radius-pill)!important;padding:6px 16px;font-weight:600;font-size:.7rem;letter-spacing:.02em;transition:all .2s var(--ease-out-expo);position:relative}
.fb.active{background:linear-gradient(135deg,#3b82f6,#6366f1);border-color:transparent;color:#fff;box-shadow:0 4px 14px rgba(59,130,246,.35),inset 0 1px 0 rgba(255,255,255,.18)}
.fb.active:hover{box-shadow:0 6px 18px rgba(59,130,246,.45),inset 0 1px 0 rgba(255,255,255,.22);transform:translateY(-1px)}
[data-theme="dark"] .fb.active{background:linear-gradient(135deg,#3b82f6,#818cf8);box-shadow:0 4px 18px rgba(59,130,246,.5),inset 0 1px 0 rgba(255,255,255,.15)}
/* v2.1.0: 操作ログのフィルタピル内に出す件数バッジ */
.lf-badge{display:inline-block;min-width:16px;margin-left:4px;padding:0 5px;font-size:.6rem;font-weight:700;line-height:1.5;border-radius:var(--radius-pill);background:rgba(100,116,139,.18);color:inherit;opacity:.85}
.fb.active .lf-badge{background:rgba(255,255,255,.28);color:#fff;opacity:1}
.fb-sent.active{background:linear-gradient(135deg,#10b981,#059669);box-shadow:0 4px 14px rgba(16,185,129,.35)}

.bulk-toolbar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:flex-end}
.bulk-toolbar .btn{border-radius:var(--radius-sm)!important;padding:5px 12px;font-size:.71rem;font-weight:600;letter-spacing:.01em;transition:all .18s var(--ease-out-expo)}
.bulk-toolbar .btn-primary{background:linear-gradient(135deg,#3b82f6,#6366f1);border-color:transparent;color:#fff;box-shadow:0 3px 12px rgba(59,130,246,.32),inset 0 1px 0 rgba(255,255,255,.18)}
.bulk-toolbar .btn-primary:hover{box-shadow:0 5px 18px rgba(59,130,246,.45),inset 0 1px 0 rgba(255,255,255,.22);transform:translateY(-1px)}
.bulk-toolbar .btn-outline-primary{background:rgba(59,130,246,.06);color:var(--primary);border-color:rgba(59,130,246,.28)}
.bulk-toolbar .btn-outline-primary:hover{background:rgba(59,130,246,.12);border-color:var(--primary);color:var(--primary)}
.bulk-toolbar .btn-outline-secondary{background:transparent;color:var(--text-2);border-color:var(--border-default)}
.bulk-toolbar .btn-outline-secondary:hover{background:var(--bg-hover);color:var(--text-1);border-color:var(--border-strong)}
.bulk-toolbar .btn-outline-danger{background:rgba(239,68,68,.04);color:var(--error);border-color:rgba(239,68,68,.3)}
.bulk-toolbar .btn-outline-danger:hover{background:var(--error-dim);border-color:var(--error)}
[data-theme="dark"] .bulk-toolbar .btn-primary{background:linear-gradient(135deg,#3b82f6,#818cf8);box-shadow:0 3px 16px rgba(59,130,246,.45)}
[data-theme="dark"] .bulk-toolbar .btn-outline-primary{background:rgba(59,130,246,.12);border-color:rgba(59,130,246,.35)}
[data-theme="dark"] .bulk-toolbar .btn-outline-danger{background:rgba(239,68,68,.1);border-color:rgba(239,68,68,.38)}

/* Filter bar polish */
.filter-bar{gap:8px;padding:9px 14px;border-radius:var(--radius-lg)!important}
.filter-field{height:34px;border-radius:var(--radius-pill)!important;padding:0 14px;gap:6px}
.filter-field:focus-within{border-color:var(--primary);box-shadow:0 0 0 3px var(--primary-glow)}
.filter-field select,.filter-field input{font-size:.74rem}
.filter-clear-btn{border-radius:var(--radius-pill)!important;padding:4px 12px;font-size:.68rem}

/* =========================================================
   ANALYTICS — HERO (donut + ratio + live)
   ========================================================= */
.analytics-hero{display:grid;grid-template-columns:auto 1fr auto;gap:22px;align-items:center;padding:2px 2px 14px 2px;border-bottom:1px solid var(--border-subtle);margin-bottom:16px}
.analytics-donut{position:relative;width:118px;height:118px;flex-shrink:0}
.analytics-donut svg{width:100%;height:100%;transform:rotate(-90deg);display:block}
.analytics-donut .donut-track{fill:none;stroke:var(--bg-raised);stroke-width:9}
.analytics-donut .donut-fill{fill:none;stroke:url(#donutGradient);stroke-width:9;stroke-linecap:round;transition:stroke-dashoffset .9s var(--ease-out-expo);filter:drop-shadow(0 0 6px rgba(59,130,246,.35))}
[data-theme="dark"] .analytics-donut .donut-fill{filter:drop-shadow(0 0 10px rgba(59,130,246,.55))}
.analytics-donut-center{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:0}
.analytics-donut-num{font-family:var(--font-mono);font-size:1.9rem;font-weight:700;color:var(--text-1);line-height:1;letter-spacing:-.03em}
.analytics-donut-suffix{font-size:.72rem;color:var(--text-3);font-family:var(--font-mono);font-weight:600;margin-top:3px}
.analytics-donut-label{font-size:.56rem;color:var(--text-3);font-weight:700;letter-spacing:.12em;text-transform:uppercase;margin-top:6px}

.analytics-hero-main{display:flex;flex-direction:column;gap:10px;min-width:0}
.analytics-hero-title{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
.analytics-hero-title .num{font-family:var(--font-mono);font-size:1.85rem;font-weight:700;color:var(--text-1);line-height:1;letter-spacing:-.03em}
.analytics-hero-title .ratio{font-family:var(--font-mono);font-size:.82rem;color:var(--text-3);font-weight:600}
.analytics-hero-title .lab{font-size:.62rem;font-weight:700;color:var(--text-2);letter-spacing:.1em;text-transform:uppercase;margin-left:2px}
.analytics-pipeline-bar{height:9px;background:var(--bg-raised);border-radius:999px;overflow:hidden;position:relative;border:1px solid var(--border-subtle)}
.analytics-pipeline-bar > span{position:absolute;top:0;left:0;height:100%;border-radius:999px;transition:width .6s var(--ease-out-expo);width:0}

.analytics-live{display:inline-flex;align-items:center;gap:6px;padding:4px 11px;background:var(--bg-surface);border:1px solid var(--border-default);border-radius:var(--radius-pill);font-size:.62rem;font-family:var(--font-mono);color:var(--text-2);font-weight:700;letter-spacing:.08em;flex-shrink:0}
.analytics-live-dot{width:6px;height:6px;border-radius:50%;background:var(--success);box-shadow:0 0 0 0 rgba(16,185,129,.6);animation:pulse 2s infinite}
.analytics-meta{display:flex;flex-direction:column;align-items:flex-end;gap:6px;flex-shrink:0}
.analytics-meta-sum{font-family:var(--font-mono);font-size:.7rem;color:var(--text-3);text-align:right;font-weight:600;white-space:nowrap}

/* =========================================================
   ANALYTICS — STAT CARDS ROW (7 icons+numbers)
   ========================================================= */
.stat-cards-row{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:10px;margin-bottom:18px}
.stat-card-v2{display:flex;flex-direction:column;padding:12px 13px;background:var(--bg-card);border:1px solid var(--border-subtle);border-radius:var(--radius-md);transition:all .2s var(--ease-out-expo);min-width:0;position:relative;overflow:hidden}
.stat-card-v2:hover{border-color:var(--border-default);box-shadow:var(--shadow-ambient);transform:translateY(-1px)}
.stat-card-v2-head{display:flex;align-items:center;gap:6px;margin-bottom:7px}
.stat-card-v2-icon{width:22px;height:22px;display:flex;align-items:center;justify-content:center;border-radius:var(--radius-sm);flex-shrink:0;background:color-mix(in srgb,var(--_c,var(--primary)) 12%,transparent);color:var(--_c,var(--primary))}
.stat-card-v2-icon .material-symbols-outlined{font-size:14px;font-variation-settings:'FILL' 0,'wght' 500}
.stat-card-v2-label{font-size:.58rem;font-weight:700;color:var(--text-2);letter-spacing:.06em;text-transform:uppercase;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.stat-card-v2-num{font-family:var(--font-mono);font-size:1.5rem;font-weight:700;line-height:1;letter-spacing:-.02em;color:var(--_c,var(--text-1))}
.stat-card-v2-note{font-size:.56rem;color:var(--text-3);margin-top:4px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

/* =========================================================
   ANALYTICS — TREND CHART PANEL
   ========================================================= */
.analytics-trend-panel{margin-bottom:14px}
.analytics-trend-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;gap:10px}
.analytics-trend-title{font-size:.74rem;font-weight:700;color:var(--text-1);letter-spacing:.02em}
.analytics-trend-legend{display:flex;gap:14px;font-size:.62rem;color:var(--text-3);align-items:center}
.analytics-trend-legend span.lg{display:inline-flex;align-items:center;gap:5px}
.analytics-trend-legend .dot{width:6px;height:6px;border-radius:50%;flex-shrink:0}
.analytics-trend-legend .dash{width:10px;height:0;border-top:1.5px dashed currentColor;flex-shrink:0}
.analytics-trend-range{font-size:.62rem;font-family:var(--font-mono);color:var(--text-2);padding:3px 10px;border:1px solid var(--border-default);border-radius:var(--radius-pill);background:var(--bg-surface);display:inline-flex;align-items:center;gap:5px}
.analytics-trend-range .material-symbols-outlined{font-size:12px}
.analytics-trend-body{height:200px;position:relative}

/* =========================================================
   ANALYTICS — 3-COLUMN GRID
   ========================================================= */
.analytics-grid{display:grid;grid-template-columns:1.05fr 1.1fr 1.35fr;gap:14px;margin-top:4px}
.analytics-sub-card{background:var(--bg-card);border:1px solid var(--border-subtle);border-radius:var(--radius-lg)!important;padding:16px 18px 18px;transition:all .25s var(--ease-out-expo);min-width:0;display:flex;flex-direction:column;gap:10px}
.analytics-sub-card:hover{box-shadow:var(--shadow-ambient);border-color:var(--border-default)}
.analytics-sub-title{font-size:.74rem;font-weight:700;color:var(--text-1);letter-spacing:.02em;display:flex;align-items:center;justify-content:space-between;gap:8px}
.analytics-sub-action{font-size:.64rem;font-weight:600;color:var(--primary);cursor:pointer;text-decoration:none;transition:color .15s;background:none;border:none;padding:0;font-family:inherit}
.analytics-sub-action:hover{color:var(--primary-dim);text-decoration:underline}

/* Breakdown donut + legend */
.breakdown-row{display:flex;gap:14px;align-items:center}
.breakdown-donut-wrap{position:relative;width:112px;height:112px;flex-shrink:0}
.breakdown-donut-wrap svg{width:100%;height:100%;transform:rotate(-90deg);display:block}
.breakdown-donut-center{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:0}
.breakdown-donut-total{font-family:var(--font-mono);font-size:1.35rem;font-weight:700;color:var(--text-1);line-height:1;letter-spacing:-.02em}
.breakdown-donut-total-lab{font-size:.58rem;color:var(--text-3);font-weight:600;margin-top:4px;letter-spacing:.06em;text-transform:uppercase}
.breakdown-legend{flex:1;display:flex;flex-direction:column;gap:7px;min-width:0}
.breakdown-legend-item{display:grid;grid-template-columns:10px 1fr auto auto;gap:9px;align-items:center;font-size:.72rem}
.breakdown-legend-item .dot{width:8px;height:8px;border-radius:50%;display:inline-block}
.breakdown-legend-item .lab{color:var(--text-2);font-weight:500;white-space:nowrap}
.breakdown-legend-item .val{font-family:var(--font-mono);font-weight:700;color:var(--text-1)}
.breakdown-legend-item .pct{font-family:var(--font-mono);font-size:.66rem;color:var(--text-3);min-width:40px;text-align:right}

/* Daily bar chart */
.daily-bars{height:170px;position:relative}

/* Recent errors list */
.recent-errors{display:flex;flex-direction:column;gap:4px;max-height:180px;overflow-y:auto}
.recent-error-item{display:grid;grid-template-columns:8px 1fr auto;gap:10px;align-items:center;padding:8px 6px;border-radius:var(--radius-sm);transition:background .15s;min-width:0;border-bottom:1px solid var(--border-subtle)}
.recent-error-item:last-child{border-bottom:none}
.recent-error-item:hover{background:var(--bg-hover)}
.recent-error-dot{width:7px;height:7px;border-radius:50%;background:var(--error);box-shadow:0 0 8px rgba(239,68,68,.4);flex-shrink:0}
.recent-error-body{display:flex;flex-direction:column;gap:2px;min-width:0}
.recent-error-name{font-size:.74rem;font-weight:600;color:var(--text-1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.recent-error-reason{font-size:.64rem;color:var(--text-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.recent-error-time{font-size:.62rem;font-family:var(--font-mono);color:var(--text-3);white-space:nowrap;text-align:right}
.recent-errors-empty{padding:28px 0;text-align:center;font-size:.72rem;color:var(--text-3)}

/* =========================================================
   ANALYTICS — INSIGHT CARD with WAVE decoration
   ========================================================= */
.insight-card{margin-top:14px;background:transparent;border:1px solid color-mix(in srgb,var(--border-subtle) 70%,transparent);border-radius:var(--radius-lg)!important;padding:18px 22px;display:grid;grid-template-columns:auto 1fr;gap:16px;align-items:center;position:relative;overflow:hidden;min-height:94px}
.insight-icon{width:42px;height:42px;border-radius:var(--radius-md);background:var(--info-dim);color:var(--info);display:flex;align-items:center;justify-content:center;flex-shrink:0;z-index:2}
.insight-icon .material-symbols-outlined{font-size:22px;font-variation-settings:'FILL' 1,'wght' 500}
.insight-body{display:flex;flex-direction:column;gap:4px;min-width:0;z-index:2;position:relative}
.insight-title{font-size:.82rem;font-weight:700;color:var(--text-1)}
.insight-desc{font-size:.72rem;color:var(--text-2);line-height:1.55}
.insight-desc b{color:var(--text-1);font-weight:700;font-family:var(--font-mono)}
.insight-desc .pos{color:var(--success);font-weight:700;font-family:var(--font-mono)}
.insight-desc .neg{color:var(--error);font-weight:700;font-family:var(--font-mono)}
.insight-wave{position:absolute;right:0;top:0;bottom:0;width:55%;pointer-events:none;opacity:.45;z-index:1}
[data-theme="dark"] .insight-wave{opacity:.8}

/* Header wave decoration — Pattern ④ only (dark theme).
 * NOTE: do NOT switch .app-header to position:relative here — the base style
 * has position:fixed (top:0) and the wave is positioned via ::after with
 * position:absolute, which resolves against the fixed header just fine.
 * Forcing relative breaks the sticky tab nav (#mainTabNav) underneath. */
.app-header::after{content:'';position:absolute;right:-4%;top:0;bottom:0;width:42%;pointer-events:none;opacity:0;transition:opacity .4s;background:radial-gradient(ellipse at right center,rgba(99,102,241,.25) 0%,rgba(59,130,246,.12) 45%,transparent 75%);z-index:-1}
[data-theme="dark"] .app-header::after{opacity:1}

/* =========================================================
   REFINED TABLE (light soft-shadow / dark gradient accent)
   ========================================================= */
.table-shell{background:var(--bg-card);border:1px solid var(--border-subtle);border-radius:var(--radius-lg);overflow:hidden;box-shadow:var(--shadow-ambient);transition:box-shadow .2s var(--ease-out-expo),border-color .2s}
.table-shell:hover{box-shadow:var(--shadow-card)}
.table-shell-scroll{overflow-x:auto;overflow-y:visible}
[data-theme="dark"] .table-shell{background:linear-gradient(180deg,#0e1423 0%,#121828 100%);border-color:var(--border-subtle);box-shadow:0 4px 20px rgba(0,0,0,.4),inset 0 0 0 1px rgba(148,163,184,.04)}
.main-table{background:transparent}
.main-table thead th{background:transparent;font-size:.6rem;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--text-3);padding:12px 14px;border-bottom:1px solid var(--border-subtle)}
[data-theme="dark"] .main-table thead th{color:var(--text-2);background:transparent;border-bottom-color:var(--border-default);letter-spacing:.12em}
[data-theme="dark"] .main-table thead th:first-of-type,
[data-theme="dark"] .main-table thead th:nth-of-type(2){color:var(--primary)}
.main-table tbody tr{background:transparent;transition:background .15s,box-shadow .15s}
.main-table tbody tr:nth-child(even){background:transparent}
.main-table tbody tr:hover{background:rgba(59,130,246,.04)}
[data-theme="dark"] .main-table tbody tr:hover{background:rgba(59,130,246,.09)}
.main-table tbody td{padding:13px 14px;height:auto;max-height:none;border-bottom:1px solid var(--border-subtle);vertical-align:middle;color:var(--text-1);font-size:.78rem}
[data-theme="dark"] .main-table tbody td{border-bottom-color:rgba(148,163,184,.06);color:var(--text-1)}
.main-table tbody tr:last-child td{border-bottom:none}
.main-table .chip-success{border-radius:var(--radius-pill)!important;padding:3px 11px;font-size:.66rem;letter-spacing:.02em}
.main-table .chip-error{border-radius:var(--radius-pill)!important;padding:3px 11px;font-size:.66rem;letter-spacing:.02em}
.main-table .chip-warning{border-radius:var(--radius-pill)!important;padding:3px 11px;font-size:.66rem;letter-spacing:.02em}
.main-table .chip-info,.main-table .chip-neutral,.main-table .chip-primary{border-radius:var(--radius-pill)!important;padding:3px 11px;font-size:.66rem;letter-spacing:.02em}
.main-table .furl{color:var(--primary);font-family:var(--font-mono);font-size:.74rem;max-width:200px}
[data-theme="dark"] .main-table .furl{color:#60a5fa}
.main-table .company-action-btn.btn-success{background:transparent;color:var(--success);border:1px solid transparent;box-shadow:none;font-weight:700}
.main-table .company-action-btn.btn-success:hover{background:var(--success-dim);border-color:rgba(5,150,105,.3)}
[data-theme="dark"] .main-table .company-action-btn.btn-success{color:#10b981}
[data-theme="dark"] .main-table .company-action-btn.btn-success:hover{background:rgba(16,185,129,.12);border-color:rgba(16,185,129,.35)}
.main-table .company-action-btn.btn-primary{background:rgba(59,130,246,.06);color:var(--primary);border:1px solid rgba(59,130,246,.3);box-shadow:none;font-weight:700}
.main-table .company-action-btn.btn-primary:hover{background:rgba(59,130,246,.14);border-color:var(--primary);box-shadow:0 2px 10px rgba(59,130,246,.25)}
[data-theme="dark"] .main-table .company-action-btn.btn-primary{background:rgba(59,130,246,.12);color:#60a5fa;border-color:rgba(59,130,246,.35)}
[data-theme="dark"] .main-table .company-action-btn.btn-primary:hover{background:linear-gradient(135deg,rgba(59,130,246,.22),rgba(129,140,248,.2));border-color:#60a5fa;color:#93bbfd}

/* Sent counter (e.g., "2x") styling */
.sent-count-badge{font-size:.56rem;font-family:var(--font-mono);color:var(--warning);font-weight:700;display:inline-block;margin-top:2px}
[data-theme="dark"] .sent-count-badge{color:#fbbf24}
.sent-timestamp{font-size:.7rem;font-family:var(--font-mono);color:var(--primary);font-weight:600;line-height:1.2}
[data-theme="dark"] .sent-timestamp{color:#60a5fa}

/* =========================================================
   HUD MODAL — Future-style bordered dialog (company add/edit)
   ========================================================= */
.hud-modal{position:relative;width:min(780px,100%);padding:0;overflow:hidden;animation:hudIn .24s var(--ease-out-expo);background:var(--bg-card);border:1px solid var(--border-default);border-radius:var(--radius-lg)!important;box-shadow:var(--shadow-modal)}
.hud-corner{position:absolute;width:18px;height:18px;pointer-events:none;z-index:3;border:0 solid var(--primary);opacity:.85}
.hud-corner-tl{top:10px;left:10px;border-top-width:2px;border-left-width:2px;border-top-left-radius:3px}
.hud-corner-tr{top:10px;right:10px;border-top-width:2px;border-right-width:2px;border-top-right-radius:3px}
.hud-corner-bl{bottom:10px;left:10px;border-bottom-width:2px;border-left-width:2px;border-bottom-left-radius:3px}
.hud-corner-br{bottom:10px;right:10px;border-bottom-width:2px;border-right-width:2px;border-bottom-right-radius:3px}
.hud-head{display:flex;align-items:center;gap:14px;padding:22px 26px 14px;border-bottom:none!important;position:relative;z-index:2;background:linear-gradient(180deg, color-mix(in srgb, var(--primary) 5%, transparent), transparent 80%)}
.hud-head-icon{position:relative;width:56px;height:62px;flex-shrink:0;color:var(--primary);filter:drop-shadow(0 4px 14px color-mix(in srgb, var(--primary) 28%, transparent))}
.hud-head-icon svg{position:absolute;inset:0;width:100%;height:100%}
.hud-head-sym{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);font-size:22px;color:var(--primary);font-variation-settings:'FILL' 0,'wght' 500 !important}
.hud-head-copy{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}
.hud-head-copy h3{margin:0!important;font-size:1.05rem!important;font-weight:800!important;color:var(--text-1)!important;letter-spacing:.01em!important;text-transform:none!important;line-height:1.2}
.hud-head-sub{font-size:.6rem;font-weight:800;letter-spacing:.2em;color:var(--text-3);font-family:var(--font-mono);text-transform:uppercase;line-height:1}
.hud-close{width:34px;height:34px;border-radius:var(--radius-sm)!important;display:inline-flex;align-items:center;justify-content:center;background:transparent;border:1px solid var(--border-default);color:var(--text-2);cursor:pointer;transition:all .15s var(--ease-out-expo);flex-shrink:0;padding:0;font-family:inherit;font-size:0}
.hud-close:hover{background:var(--bg-hover);color:var(--text-1);border-color:var(--border-strong)}
.hud-close .material-symbols-outlined{font-size:18px;font-variation-settings:'FILL' 0,'wght' 500}
.hud-scanline{position:relative;height:1px;margin:0 28px;background:linear-gradient(90deg, transparent, var(--border-default) 15%, var(--border-default) 85%, transparent);z-index:2;overflow:visible}
.hud-scanline::before{content:'';position:absolute;top:-1px;left:30%;width:40%;height:3px;background:linear-gradient(90deg, transparent, var(--primary) 50%, transparent);opacity:.7;border-radius:2px;filter:blur(.4px);animation:hudScan 3.4s ease-in-out infinite}
.hud-scanline-bottom{margin-top:4px;opacity:.55}
.hud-scanline-bottom::before{animation-delay:1.7s;width:22%;left:10%}
.hud-body{padding:18px 26px 14px!important;position:relative;z-index:2}
.hud-body .modal-grid{gap:14px 18px}
.hud-field{margin-bottom:0!important;padding-bottom:0!important;border-bottom:none!important}
.hud-field > label{display:inline-flex!important;align-items:center;gap:7px;font-size:.72rem!important;font-weight:700!important;text-transform:none!important;letter-spacing:.02em!important;color:var(--text-2)!important;margin-bottom:6px!important}
.hud-field > label .material-symbols-outlined{font-size:15px;color:var(--primary);opacity:.85;font-variation-settings:'FILL' 0,'wght' 500}
.hud-field input[type="text"],.hud-field textarea{background:var(--bg-surface)!important;border:1px solid var(--border-default)!important;padding:10px 13px!important;font-size:.82rem!important;border-radius:var(--radius-md)!important;transition:all .18s var(--ease-out-expo)!important;color:var(--text-1)!important;font-family:var(--font-body)}
.hud-field input[type="text"]::placeholder,.hud-field textarea::placeholder{color:var(--text-3)}
.hud-field input[type="text"]:focus,.hud-field textarea:focus{border-color:var(--primary)!important;background:var(--bg-card)!important;box-shadow:0 0 0 3px var(--primary-glow), inset 0 1px 0 color-mix(in srgb, var(--primary) 5%, transparent)!important;outline:none!important}
.hud-field textarea{min-height:82px;resize:vertical}
.hud-check{display:inline-flex!important;align-items:center;gap:10px;font-size:.78rem;font-weight:600;color:var(--text-1)!important;cursor:pointer;padding:6px 0;margin-top:8px;position:relative;user-select:none}
.hud-check input{position:absolute!important;opacity:0!important;pointer-events:none!important;width:0!important;height:0!important}
.hud-check-box{width:18px;height:18px;flex-shrink:0;border:1.5px solid var(--border-default);border-radius:4px;display:inline-flex;align-items:center;justify-content:center;background:var(--bg-surface);transition:all .18s var(--ease-out-expo);position:relative}
.hud-check input:checked + .hud-check-box{background:var(--primary);border-color:var(--primary);box-shadow:0 0 0 3px var(--primary-glow)}
.hud-check input:checked + .hud-check-box::after{content:'';width:5px;height:9px;border:solid #fff;border-width:0 2px 2px 0;transform:rotate(45deg) translate(-1px,-1px)}
.hud-check:hover .hud-check-box{border-color:var(--primary)}
.hud-actions{padding:14px 26px 22px!important;position:relative;z-index:2;border-top:none!important;background:linear-gradient(0deg, color-mix(in srgb, var(--primary) 4%, transparent), transparent 80%)}
.hud-btn-primary{background:linear-gradient(135deg, var(--primary), var(--primary-dim))!important;box-shadow:0 2px 14px color-mix(in srgb, var(--primary) 32%, transparent)!important;font-weight:700!important;padding:7px 18px!important}
.hud-btn-primary:hover{filter:brightness(1.08);box-shadow:0 2px 20px color-mix(in srgb, var(--primary) 50%, transparent)!important}

/* Dark mode amplification */
[data-theme="dark"] .hud-modal{border-color:rgba(59,130,246,.28);box-shadow:var(--shadow-modal), 0 0 40px rgba(59,130,246,.18), inset 0 0 60px rgba(59,130,246,.05)}
[data-theme="dark"] .hud-corner{opacity:1;box-shadow:0 0 10px rgba(59,130,246,.55)}
[data-theme="dark"] .hud-head-icon{filter:drop-shadow(0 0 16px rgba(59,130,246,.55))}
[data-theme="dark"] .hud-scanline::before{box-shadow:0 0 8px rgba(59,130,246,.7);opacity:.9}
[data-theme="dark"] .hud-field input[type="text"],[data-theme="dark"] .hud-field textarea{background:var(--bg-deep)!important;border-color:rgba(148,163,184,.18)!important}
[data-theme="dark"] .hud-field input[type="text"]:focus,[data-theme="dark"] .hud-field textarea:focus{background:var(--bg-raised)!important;box-shadow:0 0 0 3px rgba(59,130,246,.22), 0 0 14px rgba(59,130,246,.15)!important}
[data-theme="dark"] .hud-check-box{background:var(--bg-deep);border-color:rgba(148,163,184,.28)}
[data-theme="dark"] .hud-close{border-color:rgba(148,163,184,.22)}

@keyframes hudScan{0%{transform:translateX(-60%);opacity:0}30%{opacity:1}70%{opacity:1}100%{transform:translateX(60%);opacity:0}}
@keyframes hudIn{from{opacity:0;transform:scale(.96) translateY(14px)}to{opacity:1;transform:scale(1) translateY(0)}}

/* perf-mode disables the scanline animation */
body.perf-mode .hud-scanline::before{animation:none!important}

/* =========================================================
   LAUNCH MODAL — clean CLI-themed dialog (light + dark)
   ========================================================= */
.launch-modal-shell{position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(15,23,42,.55);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);z-index:10000;display:none;align-items:center;justify-content:center;padding:18px}
.launch-modal-shell.open,.launch-modal-shell[style*="display: flex"]{display:flex}
[data-theme="dark"] .launch-modal-shell{background:rgba(0,0,0,.65)}
.launch-modal-panel{position:relative;width:min(560px,100%);max-height:92vh;display:flex;flex-direction:column;background:#fff;border:1px solid var(--border-subtle);border-radius:20px;overflow:hidden;box-shadow:0 30px 80px rgba(15,23,42,.18);animation:launchIn .22s var(--ease-out-expo)}
[data-theme="dark"] .launch-modal-panel{background:#0d1117;border-color:rgba(148,163,184,.10);box-shadow:0 30px 80px rgba(0,0,0,.7)}

/* Head */
.launch-head{display:flex;align-items:center;gap:14px;padding:18px 20px}
.launch-head-icon{width:48px;height:48px;border-radius:12px;display:flex;align-items:center;justify-content:center;flex-shrink:0;background:linear-gradient(135deg,rgba(204,120,92,.16),rgba(232,147,90,.10));border:1px solid rgba(204,120,92,.18);overflow:hidden}
[data-theme="dark"] .launch-head-icon{background:linear-gradient(135deg,rgba(204,120,92,.32),rgba(232,147,90,.16));border-color:rgba(232,147,90,.28)}
.launch-head-icon img,.launch-head-icon svg{width:26px;height:26px;display:block}
.launch-head-copy{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.launch-head-title{font-size:1.05rem;font-weight:800;color:var(--text-1);line-height:1.3;letter-spacing:.005em}
.launch-head-sub{font-size:.74rem;color:var(--text-2);line-height:1.3}
.launch-close{width:32px;height:32px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;background:transparent;border:1px solid var(--border-default);color:var(--text-2);cursor:pointer;flex-shrink:0;padding:0;transition:all .15s var(--ease-out-expo);font-family:inherit}
.launch-close:hover{background:var(--bg-hover);color:var(--text-1);border-color:var(--border-strong)}
.launch-close .material-symbols-outlined{font-size:18px;font-variation-settings:'FILL' 0,'wght' 500}
[data-theme="dark"] .launch-close{border-color:rgba(148,163,184,.20)}
[data-theme="dark"] .launch-close:hover{background:rgba(148,163,184,.10)}

.launch-divider{height:1px;background:var(--border-subtle);margin:0 20px;flex-shrink:0}
[data-theme="dark"] .launch-divider{background:rgba(148,163,184,.10)}

/* Body */
.launch-body{padding:18px 20px 8px;overflow-y:auto;flex:1 1 auto;min-height:0}
.launch-section{margin-bottom:16px}
.launch-section:last-child{margin-bottom:8px}
.launch-section-label{font-size:.78rem;font-weight:700;color:var(--text-1);margin-bottom:10px;letter-spacing:.005em}

/* Provider cards */
.launch-providers{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
.launch-provider-card{flex:none;flex-direction:column;align-items:center;justify-content:center;padding:14px 10px 12px;border:1.5px solid var(--border-subtle);border-radius:14px;background:#fff;text-align:center;cursor:pointer;transition:all .18s var(--ease-out-expo);position:relative;min-width:0;gap:6px}
.launch-provider-card:hover{border-color:var(--border-default);transform:translateY(-1px);box-shadow:0 4px 14px rgba(15,23,42,.06)}
[data-theme="dark"] .launch-provider-card{background:#0a0e17;border-color:rgba(148,163,184,.10)}
[data-theme="dark"] .launch-provider-card:hover{background:#121828;border-color:rgba(148,163,184,.20)}
.launch-provider-card .lp-icon{width:42px;height:42px;border-radius:11px;display:flex;align-items:center;justify-content:center;background:var(--bg-surface);transition:all .18s var(--ease-out-expo)}
[data-theme="dark"] .launch-provider-card .lp-icon{background:rgba(148,163,184,.06)}
.launch-provider-card .lp-icon img{width:24px;height:24px}
.launch-provider-card .lp-name{font-size:.86rem;font-weight:800;color:var(--text-1);line-height:1.1;letter-spacing:.005em}
.launch-provider-card .lp-sub{font-size:.66rem;color:var(--text-3);line-height:1.1}
.launch-provider-card .lp-check{position:absolute;top:8px;right:8px;width:18px;height:18px;border-radius:50%;display:none;align-items:center;justify-content:center;font-size:11px;font-weight:800;color:#fff;box-shadow:0 1px 4px rgba(0,0,0,.18)}
.launch-provider-card.selected.claude{border-color:#CC785C;background:linear-gradient(145deg,rgba(204,120,92,.08),rgba(255,255,255,0))}
.launch-provider-card.selected.claude .lp-icon{background:linear-gradient(135deg,rgba(204,120,92,.18),rgba(232,147,90,.10))}
.launch-provider-card.selected.claude .lp-check{display:flex;background:#CC785C}
[data-theme="dark"] .launch-provider-card.selected.claude{border-color:#E8935A;background:linear-gradient(145deg,rgba(204,120,92,.20),rgba(0,0,0,0))}
[data-theme="dark"] .launch-provider-card.selected.claude .lp-icon{background:linear-gradient(135deg,rgba(232,147,90,.32),rgba(204,120,92,.18))}
.launch-provider-card.selected.codex{border-color:#10a37f;background:linear-gradient(145deg,rgba(16,163,127,.07),rgba(255,255,255,0))}
.launch-provider-card.selected.codex .lp-icon{background:linear-gradient(135deg,rgba(16,163,127,.16),rgba(16,163,127,.06))}
.launch-provider-card.selected.codex .lp-check{display:flex;background:#10a37f}
[data-theme="dark"] .launch-provider-card.selected.codex{background:linear-gradient(145deg,rgba(16,163,127,.18),rgba(0,0,0,0))}
.launch-provider-card.selected.gemini{border-color:#4285F4;background:linear-gradient(145deg,rgba(66,133,244,.07),rgba(255,255,255,0))}
.launch-provider-card.selected.gemini .lp-icon{background:linear-gradient(135deg,rgba(66,133,244,.16),rgba(66,133,244,.06))}
.launch-provider-card.selected.gemini .lp-check{display:flex;background:#4285F4}
[data-theme="dark"] .launch-provider-card.selected.gemini{background:linear-gradient(145deg,rgba(66,133,244,.18),rgba(0,0,0,0))}

/* Mode cards */
.launch-modes{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.launch-mode-card{position:relative;padding:14px 14px 12px;background:#fff;border:1.5px solid var(--border-subtle);border-radius:14px;cursor:pointer;transition:all .18s var(--ease-out-expo);text-align:left}
[data-theme="dark"] .launch-mode-card{background:#0a0e17;border-color:rgba(148,163,184,.10)}
.launch-mode-card:hover{border-color:var(--border-default);transform:translateY(-1px);box-shadow:0 4px 14px rgba(15,23,42,.06)}
[data-theme="dark"] .launch-mode-card:hover{background:#121828;border-color:rgba(148,163,184,.20)}
.launch-mode-card .launch-mode-tag{position:absolute;top:9px;right:9px;font-size:.56rem;font-weight:800;letter-spacing:.06em;padding:2px 8px;border-radius:14px;color:#fff;background:#9a9a96}
.launch-mode-card.recommended .launch-mode-tag{background:#CC785C}
.launch-mode-card.danger .launch-mode-tag{background:#dc2626}
.launch-mode-card.dev .launch-mode-tag{background:#64748b}
.launch-mode-card .launch-mode-icon{width:34px;height:34px;border-radius:10px;display:flex;align-items:center;justify-content:center;margin-bottom:9px}
.launch-mode-card.recommended .launch-mode-icon{background:rgba(204,120,92,.12);color:#CC785C}
.launch-mode-card.danger .launch-mode-icon{background:rgba(220,38,38,.10);color:#dc2626}
.launch-mode-card.dev .launch-mode-icon{background:rgba(100,116,139,.12);color:#64748b}
[data-theme="dark"] .launch-mode-card.recommended .launch-mode-icon{background:rgba(232,147,90,.18);color:#E8935A}
[data-theme="dark"] .launch-mode-card.danger .launch-mode-icon{background:rgba(239,68,68,.18);color:#ef4444}
[data-theme="dark"] .launch-mode-card.dev .launch-mode-icon{background:rgba(148,163,184,.14);color:#cbd5e1}
.launch-mode-card .launch-mode-title{font-size:.84rem;font-weight:800;color:var(--text-1);margin-bottom:3px;letter-spacing:.005em}
.launch-mode-card .launch-mode-desc{font-size:.7rem;color:var(--text-2);line-height:1.45}
.launch-mode-card .launch-mode-check{display:none;position:absolute;top:9px;right:9px;width:20px;height:20px;border-radius:50%;background:#CC785C;color:#fff;align-items:center;justify-content:center}
.launch-mode-card.danger .launch-mode-check{background:#dc2626}
.launch-mode-card.dev .launch-mode-check{background:#64748b}
.launch-mode-card .launch-mode-check .material-symbols-outlined{font-size:13px;font-variation-settings:'FILL' 0,'wght' 700}
.launch-mode-card.recommended.selected{border-color:#CC785C;background:linear-gradient(145deg,rgba(204,120,92,.08),rgba(255,255,255,0))}
[data-theme="dark"] .launch-mode-card.recommended.selected{background:linear-gradient(145deg,rgba(204,120,92,.20),rgba(0,0,0,0))}
.launch-mode-card.danger.selected{border-color:#dc2626;background:linear-gradient(145deg,rgba(220,38,38,.06),rgba(255,255,255,0))}
[data-theme="dark"] .launch-mode-card.danger.selected{background:linear-gradient(145deg,rgba(239,68,68,.18),rgba(0,0,0,0))}
.launch-mode-card.dev.selected{border-color:#64748b;background:linear-gradient(145deg,rgba(100,116,139,.06),rgba(255,255,255,0))}
[data-theme="dark"] .launch-mode-card.dev.selected{background:linear-gradient(145deg,rgba(148,163,184,.10),rgba(0,0,0,0))}
.launch-mode-card.selected .launch-mode-tag{display:none}

/* Policy select + note */
.launch-policy-select{position:relative}
.launch-policy-select select{appearance:none;-webkit-appearance:none;width:100%;padding:11px 38px 11px 14px;font-size:.82rem;font-weight:600;color:var(--text-1);background:#fff;border:1.5px solid var(--border-default);border-radius:12px;cursor:pointer;font-family:inherit;transition:all .15s}
.launch-policy-select select option{color:var(--text-1);background:var(--bg-card)}
[data-theme="dark"] .launch-policy-select select{background:#0a0e17;border-color:rgba(148,163,184,.18);color:var(--text-1)}
[data-theme="dark"] .launch-policy-select select option{background:#0d1117;color:var(--text-1)}
.launch-policy-select select:focus{outline:none;border-color:#CC785C;box-shadow:0 0 0 3px rgba(204,120,92,.15)}
.launch-policy-arrow{position:absolute;right:12px;top:50%;transform:translateY(-50%);pointer-events:none;color:var(--text-3);font-size:20px;font-variation-settings:'FILL' 0,'wght' 500}
.launch-policy-note{display:flex;align-items:center;gap:7px;margin-top:9px;font-size:.72rem;color:var(--text-2);line-height:1.5}
.launch-policy-note .material-symbols-outlined{font-size:15px;color:var(--text-3);font-variation-settings:'FILL' 0,'wght' 500;flex-shrink:0}

/* Diagnostics */
.launch-diag{background:var(--bg-surface);border:1px solid var(--border-subtle);border-radius:12px;padding:11px 14px}
[data-theme="dark"] .launch-diag{background:#080b12;border-color:rgba(148,163,184,.10)}
.launch-diag-head{display:flex;align-items:center;justify-content:space-between;cursor:pointer;user-select:none}
.launch-diag-head-left{display:flex;align-items:center;gap:8px}
.launch-diag-badge{font-size:.58rem;font-weight:700;padding:1px 7px;border-radius:10px;background:rgba(5,150,105,.12);color:var(--success)}
.launch-diag-arrow{font-size:.72rem;color:var(--text-3);transition:transform .2s}
.launch-diag-arrow.open{transform:rotate(180deg)}
.launch-diag-body{font-size:.72rem;color:var(--text-2);line-height:1.55;max-height:220px;overflow-y:auto;margin-top:8px}

/* Footer */
.launch-foot{display:flex;align-items:center;justify-content:space-between;padding:14px 20px 18px;border-top:1px solid var(--border-subtle);background:var(--bg-surface);flex-shrink:0;gap:10px;flex-wrap:wrap}
[data-theme="dark"] .launch-foot{background:#080b12;border-top-color:rgba(148,163,184,.08)}
.launch-advanced-link{display:inline-flex;align-items:center;gap:6px;background:transparent;border:none;font-size:.78rem;font-weight:600;color:var(--text-2);cursor:pointer;padding:6px 8px;border-radius:8px;transition:all .15s;font-family:inherit}
.launch-advanced-link:hover{background:var(--bg-hover);color:var(--text-1)}
.launch-advanced-link .material-symbols-outlined{font-size:16px;color:var(--text-3);font-variation-settings:'FILL' 0,'wght' 500}
.launch-foot-actions{display:flex;align-items:center;gap:8px}
.launch-cancel{background:transparent;border:1px solid var(--border-default);color:var(--text-2);padding:9px 16px;font-size:.76rem;font-weight:600;cursor:pointer;border-radius:10px;transition:all .15s;font-family:inherit}
.launch-cancel:hover{background:var(--bg-hover);color:var(--text-1)}
[data-theme="dark"] .launch-cancel{border-color:rgba(148,163,184,.20)}
.launch-external{background:transparent;border:1px solid var(--border-default);color:var(--text-2);padding:9px 14px;font-size:.74rem;font-weight:600;cursor:pointer;border-radius:10px;transition:all .15s;font-family:inherit}
.launch-external:hover{background:var(--bg-hover);color:var(--text-1)}
[data-theme="dark"] .launch-external{border-color:rgba(148,163,184,.20)}
.launch-confirm-btn{display:inline-flex;align-items:center;gap:6px;background:linear-gradient(135deg,#CC785C,#E8935A);border:none;color:#fff;padding:10px 22px;font-size:.85rem;font-weight:700;cursor:pointer;border-radius:11px;letter-spacing:.02em;box-shadow:0 4px 14px rgba(204,120,92,.32);transition:all .18s var(--ease-out-expo);font-family:inherit}
.launch-confirm-btn:hover{transform:translateY(-1px);box-shadow:0 6px 20px rgba(204,120,92,.42)}
.launch-confirm-btn .material-symbols-outlined{font-size:18px;font-variation-settings:'FILL' 1,'wght' 600}

@keyframes launchIn{from{opacity:0;transform:scale(.96) translateY(14px)}to{opacity:1;transform:scale(1) translateY(0)}}

@media (max-width:520px){
  .launch-providers{grid-template-columns:1fr}
  .launch-modes{grid-template-columns:1fr}
  .launch-foot{flex-direction:column;align-items:stretch}
  .launch-foot-actions{justify-content:flex-end}
}

/* perf-mode disables animations */
body.perf-mode .launch-modal-panel{animation:none!important}

/* =========================================================
   UNIFIED FILTER BAR — pills + dropdowns + search in one row
   ========================================================= */
.filter-bar-unified{padding:8px 10px;gap:8px;flex-wrap:wrap;margin-top:8px}
.filter-bar-unified .filter-pills{display:inline-flex;align-items:center;flex-wrap:wrap;gap:4px;flex-shrink:0}
.filter-bar-unified .filter-pills .fb{padding:4px 12px;font-size:.7rem;border-radius:var(--radius-pill)!important;line-height:1.4}
.filter-bar-divider{display:inline-block;width:1px;align-self:stretch;background:var(--border-default);margin:2px 4px;flex-shrink:0;opacity:.7}
@media (max-width:720px){.filter-bar-divider{display:none}.filter-bar-unified .filter-pills{order:-1;width:100%}}

/* =========================================================
   RESPONSIVE FALLBACKS
   ========================================================= */
@media (max-width:1200px){.stat-cards-row{grid-template-columns:repeat(4,1fr)}.analytics-grid{grid-template-columns:1fr 1fr}.analytics-grid .analytics-sub-card:nth-child(3){grid-column:1/-1}}
@media (max-width:720px){.stat-cards-row{grid-template-columns:repeat(2,1fr)}.analytics-grid{grid-template-columns:1fr}.insight-card{grid-template-columns:1fr}.insight-wave{display:none}.analytics-hero{grid-template-columns:auto 1fr;gap:14px}.analytics-meta{display:none}}
`;

module.exports = THEME_CSS;

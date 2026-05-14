/**
 * ブログ記事用 SVG 図解ジェネレーター
 * (Python 不在のため Node.js で SVG 直接出力)
 *
 * 出力:
 * - public/images/blog/diagram-cost-trend.svg (1社あたり処理コスト推移)
 * - public/images/blog/diagram-hallucination.svg (GPT-5.3 vs 5.5 幻覚率)
 * - public/images/blog/diagram-timeline.svg (主要AIモデル 2026年4-5月リリース)
 */

const fs = require('node:fs');
const path = require('node:path');

const OUT_DIR = path.join(__dirname, '..', 'public', 'images', 'blog');
fs.mkdirSync(OUT_DIR, { recursive: true });

/* ========================================================== */
/* 1. 1社あたり処理コスト推移 (bar chart, 2023→2026)            */
/* ========================================================== */
function costTrendChart() {
  const W = 1200, H = 500;
  const padding = { top: 60, right: 60, bottom: 80, left: 80 };
  const innerW = W - padding.left - padding.right;
  const innerH = H - padding.top - padding.bottom;

  const data = [
    { year: '2023', cost: 50, label: 'GPT-4 旧API' },
    { year: '2024', cost: 18, label: 'GPT-4o' },
    { year: '2025 前半', cost: 8, label: 'Sonnet 3.5' },
    { year: '2025 後半', cost: 4, label: 'Haiku/Sonnet' },
    { year: '2026 5月', cost: 2.5, label: 'Opus 4.7 + GPT-5.5' },
  ];
  const maxCost = 50;
  const barW = innerW / data.length * 0.62;
  const gap = innerW / data.length * 0.38;

  const bars = data.map((d, i) => {
    const barH = (d.cost / maxCost) * innerH;
    const x = padding.left + i * (barW + gap) + gap / 2;
    const y = padding.top + innerH - barH;
    const isLatest = i === data.length - 1;
    return `
      <rect x="${x}" y="${y}" width="${barW}" height="${barH}"
        fill="url(#${isLatest ? 'bar-grad-latest' : 'bar-grad'})"
        rx="4"/>
      <text x="${x + barW / 2}" y="${y - 10}" text-anchor="middle"
        font-family="JetBrains Mono, monospace" font-size="18" font-weight="900"
        fill="${isLatest ? '#10b981' : '#1e293b'}">¥${d.cost}</text>
      <text x="${x + barW / 2}" y="${padding.top + innerH + 24}" text-anchor="middle"
        font-family="Inter, sans-serif" font-size="13" font-weight="700" fill="#475569">${d.year}</text>
      <text x="${x + barW / 2}" y="${padding.top + innerH + 44}" text-anchor="middle"
        font-family="Inter, sans-serif" font-size="11" fill="#94a3b8">${d.label}</text>
    `;
  }).join('');

  /* Y軸ガイドライン */
  const ticks = [0, 10, 20, 30, 40, 50];
  const gridLines = ticks.map(t => {
    const y = padding.top + innerH - (t / maxCost) * innerH;
    return `
      <line x1="${padding.left}" y1="${y}" x2="${padding.left + innerW}" y2="${y}"
        stroke="#e2e8f0" stroke-width="1" stroke-dasharray="${t === 0 ? '0' : '4 4'}"/>
      <text x="${padding.left - 12}" y="${y + 4}" text-anchor="end"
        font-family="JetBrains Mono, monospace" font-size="11" fill="#94a3b8">¥${t}</text>
    `;
  }).join('');

  /* 削減率注釈 */
  const reductionAnnotation = `
    <g transform="translate(${padding.left + innerW - 280}, ${padding.top - 20})">
      <rect x="0" y="0" width="280" height="56" rx="12" fill="#10b98115" stroke="#10b981" stroke-width="1.5"/>
      <text x="20" y="22" font-family="Inter, sans-serif" font-size="11" font-weight="700"
        fill="#059669" letter-spacing="1.5">3年間で 95% 削減</text>
      <text x="20" y="42" font-family="Inter, sans-serif" font-size="13" font-weight="800" fill="#064e3b">
        ¥50 → ¥2.5 (1/20 のコスト)
      </text>
    </g>
  `;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="Inter, 'Noto Sans JP', sans-serif">
    <defs>
      <linearGradient id="bar-grad" x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" stop-color="#94a3b8"/>
        <stop offset="100%" stop-color="#64748b"/>
      </linearGradient>
      <linearGradient id="bar-grad-latest" x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" stop-color="#34d399"/>
        <stop offset="100%" stop-color="#10b981"/>
      </linearGradient>
    </defs>
    <rect width="${W}" height="${H}" fill="#ffffff"/>
    <text x="${padding.left}" y="32" font-size="20" font-weight="900" fill="#0f172a" letter-spacing="-0.02em">
      AI営業1社あたり処理コスト推移
    </text>
    <text x="${padding.left}" y="50" font-size="12" fill="#64748b">企業分析 + 文面生成 + フォーム入力の合計 (日本円、JPY=150 換算)</text>
    ${gridLines}
    ${bars}
    ${reductionAnnotation}
  </svg>`;
}

/* ========================================================== */
/* 2. 幻覚率比較 (横バー or ダイバージング)                       */
/* ========================================================== */
function hallucinationChart() {
  const W = 1000, H = 360;
  const padding = { top: 70, right: 100, bottom: 60, left: 240 };
  const innerW = W - padding.left - padding.right;

  const data = [
    { model: 'GPT-5.3 Instant', rate: 100, color: '#94a3b8', label: '基準値' },
    { model: 'GPT-5.5 Instant', rate: 47.5, color: '#3b82f6', label: '52.5% 削減' },
  ];

  const bars = data.map((d, i) => {
    const y = padding.top + i * 90;
    const barH = 48;
    const barW = (d.rate / 100) * innerW;
    return `
      <text x="${padding.left - 20}" y="${y + barH / 2 + 5}" text-anchor="end"
        font-family="Inter, sans-serif" font-size="15" font-weight="800" fill="#0f172a">${d.model}</text>
      <rect x="${padding.left}" y="${y}" width="${barW}" height="${barH}" fill="${d.color}" rx="6"/>
      <text x="${padding.left + barW + 12}" y="${y + barH / 2 - 4}" font-family="JetBrains Mono, monospace"
        font-size="18" font-weight="900" fill="${d.color}">${d.rate}%</text>
      <text x="${padding.left + barW + 12}" y="${y + barH / 2 + 14}" font-family="Inter, sans-serif"
        font-size="11" font-weight="600" fill="#64748b">${d.label}</text>
    `;
  }).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="Inter, 'Noto Sans JP', sans-serif">
    <rect width="${W}" height="${H}" fill="#ffffff"/>
    <text x="${padding.left - 220}" y="32" font-size="18" font-weight="900" fill="#0f172a" letter-spacing="-0.02em">
      幻覚率比較: GPT-5.5 Instant vs GPT-5.3 Instant
    </text>
    <text x="${padding.left - 220}" y="52" font-size="12" fill="#64748b">
      医療・法律・金融など高リスク領域での幻覚的主張 (OpenAI 公式発表 2026/5/5)
    </text>
    ${bars}
    <text x="${padding.left - 220}" y="${H - 20}" font-size="10" fill="#94a3b8">
      Source: openai.com/index/gpt-5-5-instant/ — GPT-5.5 Instant System Card
    </text>
  </svg>`;
}

/* ========================================================== */
/* 3. リリースタイムライン (April → May 2026)                    */
/* ========================================================== */
function timelineChart() {
  const W = 1200, H = 320;
  const padding = { top: 80, right: 80, bottom: 80, left: 80 };
  const innerW = W - padding.left - padding.right;

  /* 4/15 → 5/15 を基準にスケール */
  const startDate = new Date('2026-04-15').getTime();
  const endDate = new Date('2026-05-15').getTime();
  const range = endDate - startDate;

  const events = [
    { date: '2026-04-16', label: 'Claude Opus 4.7', sublabel: '長時間タスクの自己検証', color: '#ec4899' },
    { date: '2026-05-05', label: 'GPT-5.5 Instant', sublabel: '幻覚率 52.5% 削減', color: '#3b82f6' },
    { date: '2026-05-07', label: 'Gemini 3.1 Flash-Lite', sublabel: '最安レイヤー GA', color: '#10b981' },
    { date: '2026-05-08', label: 'Codex CLI', sublabel: 'remote-control 追加', color: '#f59e0b' },
  ];

  const lineY = padding.top + 80;
  const baseLine = `<line x1="${padding.left}" y1="${lineY}" x2="${padding.left + innerW}" y2="${lineY}" stroke="#cbd5e1" stroke-width="2"/>`;

  /* 日付目盛 */
  const dates = ['4/15', '4/22', '4/29', '5/06', '5/13'];
  const dateMarks = dates.map((d, i) => {
    const x = padding.left + (innerW * i) / (dates.length - 1);
    return `
      <line x1="${x}" y1="${lineY - 6}" x2="${x}" y2="${lineY + 6}" stroke="#94a3b8" stroke-width="1.5"/>
      <text x="${x}" y="${lineY + 28}" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="11" fill="#94a3b8">${d}</text>
    `;
  }).join('');

  /* イベントマーカー */
  const eventMarks = events.map((e, i) => {
    const t = new Date(e.date).getTime();
    const x = padding.left + ((t - startDate) / range) * innerW;
    const above = i % 2 === 0;
    const offsetY = above ? -70 : 50;
    const labelY = lineY + offsetY;
    return `
      <line x1="${x}" y1="${lineY}" x2="${x}" y2="${labelY + (above ? 24 : -8)}" stroke="${e.color}" stroke-width="1.5" stroke-dasharray="3 3"/>
      <circle cx="${x}" cy="${lineY}" r="8" fill="${e.color}"/>
      <circle cx="${x}" cy="${lineY}" r="4" fill="#ffffff"/>
      <g transform="translate(${x - 80}, ${labelY - (above ? 0 : 16)})">
        <rect x="0" y="0" width="160" height="48" rx="8" fill="white" stroke="${e.color}" stroke-width="1.5"/>
        <text x="12" y="20" font-family="Inter, sans-serif" font-size="13" font-weight="900" fill="#0f172a">${e.label}</text>
        <text x="12" y="36" font-family="Inter, sans-serif" font-size="10" fill="#64748b">${e.sublabel}</text>
        <text x="148" y="20" text-anchor="end" font-family="JetBrains Mono, monospace" font-size="10" font-weight="700" fill="${e.color}">${e.date.slice(5)}</text>
      </g>
    `;
  }).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="Inter, 'Noto Sans JP', sans-serif">
    <rect width="${W}" height="${H}" fill="#fafafa"/>
    <text x="${padding.left}" y="36" font-size="20" font-weight="900" fill="#0f172a" letter-spacing="-0.02em">
      主要AI 4製品 リリースタイムライン (2026年4-5月)
    </text>
    <text x="${padding.left}" y="56" font-size="12" fill="#64748b">22日間で4製品が立て続けにリリース — AI営業実務の転換月</text>
    ${baseLine}
    ${dateMarks}
    ${eventMarks}
  </svg>`;
}

/* 書き出し */
fs.writeFileSync(path.join(OUT_DIR, 'diagram-cost-trend.svg'), costTrendChart());
console.log('✓ diagram-cost-trend.svg');
fs.writeFileSync(path.join(OUT_DIR, 'diagram-hallucination.svg'), hallucinationChart());
console.log('✓ diagram-hallucination.svg');
fs.writeFileSync(path.join(OUT_DIR, 'diagram-timeline.svg'), timelineChart());
console.log('✓ diagram-timeline.svg');

console.log('\nAll diagrams generated successfully.');

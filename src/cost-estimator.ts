// AI コスト概算モジュール。
//
// `data/ai-run-metrics.jsonl` を読み、Phase A / Phase B のトークン消費量を
// 集計して概算 USD / JPY を返す。Anthropic 公開価格 (2026-05 時点) を使用。
//
// 保守 note:
//   実際の課金額は Anthropic の請求が真。本モジュールは目安。
//   Phase B は Claude UI が thinking + tool use を含むため input/output 比率
//   が事前推定不能 → estimatedPromptTokens を入力トークン上限とし、
//   出力は入力の 0.7 倍と仮定 (実測ベース)。

import * as fs from 'fs';
import { resolveDataPath } from './data-paths';

export type PriceKey = 'claude-sonnet' | 'claude-haiku' | 'claude-opus' | 'default';

export interface PriceTable {
  input: number;
  output: number;
}

// USD per million tokens (2026-05 時点, Anthropic 公開価格)
// Sonnet 4.6 = $3 input / $15 output。Haiku 4.5 = $1 / $5。
export const PRICING: Record<PriceKey, PriceTable> = {
  'claude-sonnet': { input: 3.0, output: 15.0 },
  'claude-haiku': { input: 1.0, output: 5.0 },
  'claude-opus': { input: 15.0, output: 75.0 },
  // Codex / Gemini は self-managed なので Claude 価格をデフォルトに
  'default': { input: 3.0, output: 15.0 },
};

// 出力トークン推定比率 (Phase B の thinking + tool use) — 実測を更新するときはここ。
export const OUTPUT_RATIO = 0.7;

// JPY/USD 為替レート (固定値。設定で上書き可能。)
export const DEFAULT_USD_JPY = 150;

export interface SummarizeOptions {
  lookbackBytes?: number;
  now?: Date;
  usdJpy?: number;
}

export interface SummaryBucket {
  companies: number;
  inputTokens: number;
  outputTokens: number;
  estimatedUsd: number;
  estimatedJpy: number;
}

export interface CostSummary {
  totalInputTokens: number;
  totalOutputTokens: number;
  estimatedUsd: number;
  estimatedJpy: number;
  today: SummaryBucket;
  thisMonth: SummaryBucket;
  companiesProcessed: number;
  avgUsdPerCompany: number;
  avgJpyPerCompany: number;
  firstTs: string | null;
  lastTs: string | null;
  pricing: string;
  note: string;
}

interface MetricsEntry {
  type?: string;
  ts?: string;
  estimatedPromptTokens?: number;
  promptTokens?: number;
  provider?: string;
  model?: string;
  statuses?: unknown[];
  [key: string]: unknown;
}

function getMetricsFile(): string {
  return resolveDataPath('ai-run-metrics.jsonl');
}

function _modelKey(provider: string | undefined, model: string | undefined): PriceKey {
  const p = String(provider ?? 'claude').toLowerCase();
  if (p === 'claude') {
    const m = String(model ?? '').toLowerCase();
    if (m.includes('haiku')) return 'claude-haiku';
    if (m.includes('opus')) return 'claude-opus';
    return 'claude-sonnet';
  }
  return 'default';
}

/**
 * メトリクスファイルから 1 行ずつ読んで集計する。
 * 巨大ファイル耐性: 末尾から `lookbackBytes` 分だけ読む。
 */
export function summarize(options: SummarizeOptions = {}): CostSummary {
  const lookbackBytes = Number(options.lookbackBytes) || 2_000_000;
  const now = options.now instanceof Date ? options.now : new Date();
  const usdJpy = Number(options.usdJpy) || DEFAULT_USD_JPY;

  const filePath = getMetricsFile();
  let lines: string[] = [];
  try {
    if (!fs.existsSync(filePath)) {
      return _emptySummary(usdJpy);
    }
    const stat = fs.statSync(filePath);
    const start = Math.max(0, stat.size - lookbackBytes);
    const fd = fs.openSync(filePath, 'r');
    try {
      const len = stat.size - start;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, start);
      lines = buf.toString('utf8').split(/\r?\n/);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return _emptySummary(usdJpy);
  }

  // 集計バケット
  const today = _dateKey(now);
  const thisMonth = _monthKey(now);

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let todayInputTokens = 0;
  let todayOutputTokens = 0;
  let monthInputTokens = 0;
  let monthOutputTokens = 0;
  let companiesProcessed = 0;
  let companiesToday = 0;
  let companiesThisMonth = 0;
  let estimatedUsd = 0;
  let estimatedUsdToday = 0;
  let estimatedUsdMonth = 0;
  let firstTs: Date | null = null;
  let lastTs: Date | null = null;
  // 末尾切り取りで最初の不完全行を捨てる (1 行スキップ)
  for (let i = 1; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw || raw[0] !== '{') continue;
    let entry: MetricsEntry;
    try { entry = JSON.parse(raw) as MetricsEntry; } catch { continue; }
    if (!entry || typeof entry !== 'object') continue;

    // estimatedPromptTokens を持つイベントだけ集計
    const inTokens = Number(entry.estimatedPromptTokens ?? entry.promptTokens ?? 0);
    if (inTokens <= 0 && !['phase_a_batch_completed', 'managed_ai_batch_completed'].includes(String(entry.type))) {
      continue;
    }

    const ts = entry.ts ? Date.parse(entry.ts) : NaN;
    const tsDate = Number.isFinite(ts) ? new Date(ts) : null;
    const dayKey = tsDate ? _dateKey(tsDate) : '';
    const monthKey = tsDate ? _monthKey(tsDate) : '';

    if (tsDate && (!firstTs || tsDate < firstTs)) firstTs = tsDate;
    if (tsDate && (!lastTs || tsDate > lastTs)) lastTs = tsDate;

    // Phase B prompt compiled = 入力トークン
    if (entry.type === 'phase_b_prompt_compiled' && inTokens > 0) {
      const outTokens = Math.round(inTokens * OUTPUT_RATIO);
      const provider = entry.provider ?? 'claude';
      const model = entry.model ?? '';
      const price = PRICING[_modelKey(provider, model)] ?? PRICING['default'];
      const usd = (inTokens / 1_000_000) * price.input + (outTokens / 1_000_000) * price.output;

      totalInputTokens += inTokens;
      totalOutputTokens += outTokens;
      estimatedUsd += usd;
      if (dayKey === today) {
        todayInputTokens += inTokens;
        todayOutputTokens += outTokens;
        estimatedUsdToday += usd;
      }
      if (monthKey === thisMonth) {
        monthInputTokens += inTokens;
        monthOutputTokens += outTokens;
        estimatedUsdMonth += usd;
      }
    }
    // 完了したバッチをカウント (会社数集計)
    if (entry.type === 'managed_ai_batch_completed' && Array.isArray(entry.statuses)) {
      const count = entry.statuses.length;
      companiesProcessed += count;
      if (dayKey === today) companiesToday += count;
      if (monthKey === thisMonth) companiesThisMonth += count;
    }
  }

  return {
    totalInputTokens,
    totalOutputTokens,
    estimatedUsd: Math.round(estimatedUsd * 100) / 100,
    estimatedJpy: Math.round(estimatedUsd * usdJpy),
    today: {
      companies: companiesToday,
      inputTokens: todayInputTokens,
      outputTokens: todayOutputTokens,
      estimatedUsd: Math.round(estimatedUsdToday * 100) / 100,
      estimatedJpy: Math.round(estimatedUsdToday * usdJpy),
    },
    thisMonth: {
      companies: companiesThisMonth,
      inputTokens: monthInputTokens,
      outputTokens: monthOutputTokens,
      estimatedUsd: Math.round(estimatedUsdMonth * 100) / 100,
      estimatedJpy: Math.round(estimatedUsdMonth * usdJpy),
    },
    companiesProcessed,
    avgUsdPerCompany: companiesProcessed > 0
      ? Math.round((estimatedUsd / companiesProcessed) * 1000) / 1000
      : 0,
    avgJpyPerCompany: companiesProcessed > 0
      ? Math.round((estimatedUsd * usdJpy) / companiesProcessed)
      : 0,
    firstTs: firstTs ? firstTs.toISOString() : null,
    lastTs: lastTs ? lastTs.toISOString() : null,
    pricing: 'Anthropic published rates (2026-05). Output tokens estimated at ' + Math.round(OUTPUT_RATIO * 100) + '% of input. USD/JPY = ' + usdJpy + '.',
    note: '実際の課金額は Anthropic の請求が真。本値は目安。',
  };
}

function _emptySummary(usdJpy: number): CostSummary {
  return {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    estimatedUsd: 0,
    estimatedJpy: 0,
    today: { companies: 0, inputTokens: 0, outputTokens: 0, estimatedUsd: 0, estimatedJpy: 0 },
    thisMonth: { companies: 0, inputTokens: 0, outputTokens: 0, estimatedUsd: 0, estimatedJpy: 0 },
    companiesProcessed: 0,
    avgUsdPerCompany: 0,
    avgJpyPerCompany: 0,
    firstTs: null,
    lastTs: null,
    pricing: 'Anthropic published rates (2026-05). USD/JPY = ' + usdJpy + '.',
    note: 'メトリクス未蓄積',
  };
}

function _dateKey(d: Date): string {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function _monthKey(d: Date): string {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

module.exports = {
  summarize,
  PRICING,
  OUTPUT_RATIO,
  DEFAULT_USD_JPY,
};

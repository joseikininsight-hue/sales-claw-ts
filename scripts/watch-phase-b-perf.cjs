'use strict';

/**
 * Phase B パフォーマンス経過観察スクリプト
 *
 * 使い方:
 *   node scripts/watch-phase-b-perf.cjs
 *
 * 何をするか:
 *   - %APPDATA%/sales-claw-ts/runtime/data/ai-run-metrics.jsonl と
 *     dashboard-diagnostics.jsonl をリアルタイム監視
 *   - managed_ai_batch_completed イベントを観測 → 1 batch あたりの
 *     社数と所要時間を集計
 *   - parallelTabs ごとに統計を出力 (env 値別の比較)
 *   - submitted/error/skipped の分布も表示
 *
 * v2.0.26 のタブ並列化が **本当に速くなったか** を運用中に検証するための
 * スクリプト。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

function dataDir() {
  if (process.env.SALES_CLAW_USER_DATA_DIR) return path.join(process.env.SALES_CLAW_USER_DATA_DIR, 'data');
  if (process.platform === 'win32' && process.env.APPDATA) {
    return path.join(process.env.APPDATA, 'sales-claw-ts', 'runtime', 'data');
  }
  return path.join(os.homedir(), '.sales-claw', 'data');
}

const DATA_DIR = dataDir();
const METRICS_FILE = path.join(DATA_DIR, 'ai-run-metrics.jsonl');
const DIAG_FILE = path.join(DATA_DIR, 'dashboard-diagnostics.jsonl');

console.log('Watching:');
console.log('  ', METRICS_FILE);
console.log('  ', DIAG_FILE);
console.log('');

function readLines(file, fromPos) {
  if (!fs.existsSync(file)) return { lines: [], pos: fromPos };
  const stat = fs.statSync(file);
  if (stat.size <= fromPos) return { lines: [], pos: fromPos };
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(stat.size - fromPos);
  fs.readSync(fd, buf, 0, buf.length, fromPos);
  fs.closeSync(fd);
  const text = buf.toString('utf8');
  return { lines: text.split('\n').filter(Boolean), pos: stat.size };
}

const stats = {
  byParallelTabs: {}, // { '1': { batches, companies, totalDurationMs, submitted, error, skipped } }
  promptCompiled: 0,
  batchDispatched: 0,
  batchCompleted: 0,
};

function recordCompleted(ev) {
  const tabs = ev.parallelTabs ?? '?';
  if (!stats.byParallelTabs[tabs]) {
    stats.byParallelTabs[tabs] = {
      batches: 0, companies: 0, totalDurationMs: 0,
      submitted: 0, error: 0, skipped: 0, awaiting_approval: 0,
    };
  }
  const slot = stats.byParallelTabs[tabs];
  slot.batches += 1;
  slot.companies += ev.companyCount || 0;
  slot.totalDurationMs += ev.durationMs || 0;
  (ev.statuses || []).forEach(s => {
    const a = s && s.action;
    if (a && slot[a] !== undefined) slot[a] += 1;
  });
}

const promptParallelTabsByBatchId = new Map();

function processEvent(ev, source) {
  if (!ev || !ev.type) return;
  if (source === 'metrics') {
    if (ev.type === 'phase_b_prompt_compiled') {
      stats.promptCompiled += 1;
      console.log('[prompt] companies=' + ev.companyCount + ' tokens=' + ev.estimatedPromptTokens + ' parallelTabs=' + ev.parallelTabs);
    }
    if (ev.type === 'managed_ai_batch_dispatch' && ev.batchId) {
      // parallelTabs は phase_b_prompt_compiled 側で取れるが、dispatch 直前の値を使う近似:
      // ここでは記録だけ
      stats.batchDispatched += 1;
    }
    if (ev.type === 'managed_ai_batch_completed') {
      stats.batchCompleted += 1;
      const slot = recordCompleted(ev);
      const tabs = ev.parallelTabs ?? '?';
      const avgSec = ev.companyCount ? Math.round((ev.durationMs || 0) / ev.companyCount / 1000) : 0;
      console.log('[completed] batchId=' + ev.batchId + ' companies=' + ev.companyCount + ' duration=' + Math.round((ev.durationMs||0)/1000) + 's avg=' + avgSec + 's/co parallelTabs=' + tabs);
    }
  }
}

function dumpSummary() {
  console.log('\n=== summary so far ===');
  console.log('prompts compiled:', stats.promptCompiled);
  console.log('batches dispatched:', stats.batchDispatched);
  console.log('batches completed:', stats.batchCompleted);
  console.log('\nby parallelTabs:');
  Object.entries(stats.byParallelTabs).forEach(([tabs, s]) => {
    const avgSec = s.companies ? Math.round(s.totalDurationMs / s.companies / 1000) : 0;
    console.log('  tabs=' + tabs + ': ' + s.batches + ' batches / ' + s.companies + ' companies / avg ' + avgSec + 's per company');
    console.log('     submitted=' + s.submitted + ' awaiting=' + s.awaiting_approval + ' error=' + s.error + ' skipped=' + s.skipped);
  });
  console.log('======================\n');
}

let metricsPos = fs.existsSync(METRICS_FILE) ? fs.statSync(METRICS_FILE).size : 0;
let diagPos = fs.existsSync(DIAG_FILE) ? fs.statSync(DIAG_FILE).size : 0;

console.log('Tailing from current EOF. Trigger Phase B and watch.\n');

const POLL_MS = 2000;
setInterval(() => {
  const { lines: m, pos: nm } = readLines(METRICS_FILE, metricsPos);
  metricsPos = nm;
  m.forEach(line => { try { processEvent(JSON.parse(line), 'metrics'); } catch (_) {} });

  const { lines: d, pos: nd } = readLines(DIAG_FILE, diagPos);
  diagPos = nd;
  d.forEach(line => { try { processEvent(JSON.parse(line), 'diag'); } catch (_) {} });
}, POLL_MS);

// Periodic summary
setInterval(dumpSummary, 30000);

process.on('SIGINT', () => {
  dumpSummary();
  process.exit(0);
});

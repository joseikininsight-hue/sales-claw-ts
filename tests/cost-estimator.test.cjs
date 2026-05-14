'use strict';

/**
 * Unit tests for src/cost-estimator.cjs
 *
 * Coverage targets:
 *   - summarize() with no metrics file → empty summary
 *   - summarize() reads JSONL, sums input/output tokens, USD/JPY conversion
 *   - today / thisMonth filtering by `now` injection
 *   - usdJpy override
 *   - PRICING constant & _modelKey routing (sonnet/haiku/opus/default)
 *   - managed_ai_batch_completed counts companies via statuses[].length
 *   - corrupt JSONL lines skipped
 *   - lookbackBytes truncates head (skips first incomplete line)
 *
 * Run: node tests/cost-estimator.test.cjs
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'sales-claw-cost-estimator-test-'));
process.env.SALES_CLAW_USER_DATA_DIR = sandbox;

function freshRequire(modulePath) {
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];
  return require(modulePath);
}

freshRequire('../src/settings-manager');
freshRequire('../src/data-paths');
const cost = freshRequire('../src/cost-estimator');

let passed = 0;
let failed = 0;
const failures = [];

function assertEq(name, actual, expected) {
  if (actual === expected) { passed += 1; return; }
  failed += 1;
  failures.push({ name, actual, expected });
}
function assertOk(name, value) { assertEq(name, !!value, true); }
function assertClose(name, actual, expected, tolerance) {
  if (typeof actual === 'number' && Math.abs(actual - expected) <= tolerance) { passed += 1; return; }
  failed += 1;
  failures.push({ name, actual, expected: `${expected} ± ${tolerance}` });
}

const dataDir = path.join(sandbox, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const metricsFile = path.join(dataDir, 'ai-run-metrics.jsonl');

function resetMetrics() {
  try { fs.unlinkSync(metricsFile); } catch (_) {}
}

// ─────────────────────────────────────────────────────────────
// 1. No metrics file → empty summary
// ─────────────────────────────────────────────────────────────
{
  resetMetrics();
  const s = cost.summarize();
  assertEq('totalInputTokens = 0', s.totalInputTokens, 0);
  assertEq('totalOutputTokens = 0', s.totalOutputTokens, 0);
  assertEq('estimatedUsd = 0', s.estimatedUsd, 0);
  assertEq('estimatedJpy = 0', s.estimatedJpy, 0);
  assertEq('today.companies = 0', s.today.companies, 0);
  assertEq('thisMonth.companies = 0', s.thisMonth.companies, 0);
  assertEq('companiesProcessed = 0', s.companiesProcessed, 0);
  assertEq('avgUsdPerCompany = 0', s.avgUsdPerCompany, 0);
  assertEq('firstTs null', s.firstTs, null);
  assertEq('lastTs null', s.lastTs, null);
  assertOk('note = メトリクス未蓄積', s.note.includes('メトリクス未蓄積'));
  assertOk('pricing mentions USD/JPY', s.pricing.includes('USD/JPY'));
}

// ─────────────────────────────────────────────────────────────
// 2. Single phase_b_prompt_compiled entry → sonnet pricing
// ─────────────────────────────────────────────────────────────
{
  resetMetrics();
  const now = new Date('2026-05-10T12:00:00Z');
  const entries = [
    { type: 'phase_b_prompt_compiled', ts: now.toISOString(), provider: 'claude', model: 'claude-sonnet-4-6', estimatedPromptTokens: 1_000_000 },
  ];
  // Write a leading dummy line because summarize() skips the first line (i=1)
  fs.writeFileSync(metricsFile, 'IGNORED-FIRST-LINE\n' + entries.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf-8');

  const s = cost.summarize({ now });
  // 1M input @ $3 + 0.7M output @ $15 = $3 + $10.5 = $13.5
  assertClose('totalInputTokens = 1M', s.totalInputTokens, 1_000_000, 0);
  assertClose('totalOutputTokens = 700K', s.totalOutputTokens, 700_000, 0);
  assertClose('estimatedUsd ~= 13.5', s.estimatedUsd, 13.5, 0.01);
  assertEq('estimatedJpy = 13.5 * 150 = 2025', s.estimatedJpy, 2025);
  assertOk('today reflects same numbers', s.today.estimatedUsd === s.estimatedUsd);
  assertOk('thisMonth reflects same numbers', s.thisMonth.estimatedUsd === s.estimatedUsd);
  assertEq('firstTs ISO matches', s.firstTs, now.toISOString());
  assertEq('lastTs ISO matches', s.lastTs, now.toISOString());
}

// ─────────────────────────────────────────────────────────────
// 3. Custom usdJpy override
// ─────────────────────────────────────────────────────────────
{
  // Reuse same data
  const now = new Date('2026-05-10T12:00:00Z');
  const s = cost.summarize({ now, usdJpy: 200 });
  assertEq('estimatedJpy with usdJpy=200 = 13.5 * 200 = 2700', s.estimatedJpy, 2700);
  assertOk('pricing string mentions 200', s.pricing.includes('200'));
}

// ─────────────────────────────────────────────────────────────
// 4. Haiku pricing routing
// ─────────────────────────────────────────────────────────────
{
  resetMetrics();
  const now = new Date('2026-05-10T12:00:00Z');
  fs.writeFileSync(metricsFile, 'SKIP\n' + JSON.stringify({
    type: 'phase_b_prompt_compiled', ts: now.toISOString(), provider: 'claude', model: 'claude-haiku-4-5', estimatedPromptTokens: 1_000_000,
  }) + '\n', 'utf-8');
  const s = cost.summarize({ now });
  // 1M input @ $1 + 0.7M output @ $5 = $1 + $3.5 = $4.5
  assertClose('haiku estimatedUsd ~= 4.5', s.estimatedUsd, 4.5, 0.01);
}

// ─────────────────────────────────────────────────────────────
// 5. Opus pricing routing
// ─────────────────────────────────────────────────────────────
{
  resetMetrics();
  const now = new Date('2026-05-10T12:00:00Z');
  fs.writeFileSync(metricsFile, 'SKIP\n' + JSON.stringify({
    type: 'phase_b_prompt_compiled', ts: now.toISOString(), provider: 'claude', model: 'claude-opus-4-7', estimatedPromptTokens: 1_000_000,
  }) + '\n', 'utf-8');
  const s = cost.summarize({ now });
  // 1M @ $15 + 0.7M @ $75 = $15 + $52.5 = $67.5
  assertClose('opus estimatedUsd ~= 67.5', s.estimatedUsd, 67.5, 0.01);
}

// ─────────────────────────────────────────────────────────────
// 6. Default (non-claude provider) routes to default pricing
// ─────────────────────────────────────────────────────────────
{
  resetMetrics();
  const now = new Date('2026-05-10T12:00:00Z');
  fs.writeFileSync(metricsFile, 'SKIP\n' + JSON.stringify({
    type: 'phase_b_prompt_compiled', ts: now.toISOString(), provider: 'codex', model: 'gpt-5.4', estimatedPromptTokens: 1_000_000,
  }) + '\n', 'utf-8');
  const s = cost.summarize({ now });
  // default = sonnet rates: $3 + $10.5 = $13.5
  assertClose('codex routes to default = 13.5', s.estimatedUsd, 13.5, 0.01);
}

// ─────────────────────────────────────────────────────────────
// 7. today vs thisMonth filtering
// ─────────────────────────────────────────────────────────────
{
  resetMetrics();
  const now = new Date('2026-05-10T12:00:00Z');
  const yesterday = new Date('2026-05-09T12:00:00Z');
  const lastMonth = new Date('2026-04-15T12:00:00Z');
  const entries = [
    { type: 'phase_b_prompt_compiled', ts: now.toISOString(), provider: 'claude', model: 'sonnet', estimatedPromptTokens: 100_000 },
    { type: 'phase_b_prompt_compiled', ts: yesterday.toISOString(), provider: 'claude', model: 'sonnet', estimatedPromptTokens: 100_000 },
    { type: 'phase_b_prompt_compiled', ts: lastMonth.toISOString(), provider: 'claude', model: 'sonnet', estimatedPromptTokens: 100_000 },
  ];
  fs.writeFileSync(metricsFile, 'SKIP\n' + entries.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf-8');
  const s = cost.summarize({ now });
  // today only includes today's: 100K input + 70K output → 100K * 3/1M + 70K * 15/1M = 0.3 + 1.05 = 1.35
  assertClose('today.estimatedUsd ~= 1.35', s.today.estimatedUsd, 1.35, 0.01);
  // thisMonth includes today + yesterday (both May 2026): 200K + 140K → 0.6 + 2.10 = 2.70
  assertClose('thisMonth.estimatedUsd ~= 2.70', s.thisMonth.estimatedUsd, 2.70, 0.01);
  // total includes all three: 300K + 210K → 0.9 + 3.15 = 4.05
  assertClose('total estimatedUsd ~= 4.05', s.estimatedUsd, 4.05, 0.01);
}

// ─────────────────────────────────────────────────────────────
// 8. managed_ai_batch_completed counts companies
// ─────────────────────────────────────────────────────────────
{
  resetMetrics();
  const now = new Date('2026-05-10T12:00:00Z');
  const yesterday = new Date('2026-05-09T12:00:00Z');
  const lastMonth = new Date('2026-04-15T12:00:00Z');
  const entries = [
    { type: 'managed_ai_batch_completed', ts: now.toISOString(), statuses: ['ok', 'ok', 'ok'] },
    { type: 'managed_ai_batch_completed', ts: yesterday.toISOString(), statuses: ['ok', 'fail'] },
    { type: 'managed_ai_batch_completed', ts: lastMonth.toISOString(), statuses: ['ok'] },
    // Cost entry to make avg meaningful
    { type: 'phase_b_prompt_compiled', ts: now.toISOString(), provider: 'claude', model: 'sonnet', estimatedPromptTokens: 1_000_000 },
  ];
  fs.writeFileSync(metricsFile, 'SKIP\n' + entries.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf-8');
  const s = cost.summarize({ now });
  assertEq('today.companies = 3', s.today.companies, 3);
  assertEq('thisMonth.companies = 5 (3 today + 2 yesterday)', s.thisMonth.companies, 5);
  assertEq('companiesProcessed = 6 (all)', s.companiesProcessed, 6);
  assertOk('avgUsdPerCompany > 0', s.avgUsdPerCompany > 0);
  assertOk('avgJpyPerCompany > 0', s.avgJpyPerCompany > 0);
  // 13.5 / 6 = 2.25
  assertClose('avgUsdPerCompany ~= 2.25', s.avgUsdPerCompany, 2.25, 0.01);
  // 13.5 * 150 / 6 = 337.5 → rounded
  assertClose('avgJpyPerCompany ~= 338', s.avgJpyPerCompany, 338, 1);
}

// ─────────────────────────────────────────────────────────────
// 9. Corrupt / non-JSON lines are skipped
// ─────────────────────────────────────────────────────────────
{
  resetMetrics();
  const now = new Date('2026-05-10T12:00:00Z');
  const lines = [
    'SKIP',
    '{not json',
    'plain text line',
    JSON.stringify({ type: 'phase_b_prompt_compiled', ts: now.toISOString(), provider: 'claude', model: 'sonnet', estimatedPromptTokens: 100_000 }),
    '',                           // blank line
    'null',                       // valid JSON but not object — line[0] !== '{' so skipped
    JSON.stringify(null),         // same — starts with 'n'
    JSON.stringify({ /* no token fields */ type: 'something_else' }),  // skipped (inTokens<=0 + type not in whitelist)
  ];
  fs.writeFileSync(metricsFile, lines.join('\n') + '\n', 'utf-8');
  const s = cost.summarize({ now });
  assertClose('only valid sonnet entry counted (~1.35)', s.estimatedUsd, (100_000 / 1e6) * 3 + (70_000 / 1e6) * 15, 0.01);
}

// ─────────────────────────────────────────────────────────────
// 10. promptTokens fallback (alternate field name)
// ─────────────────────────────────────────────────────────────
{
  resetMetrics();
  const now = new Date('2026-05-10T12:00:00Z');
  fs.writeFileSync(metricsFile, 'SKIP\n' + JSON.stringify({
    type: 'phase_b_prompt_compiled', ts: now.toISOString(), provider: 'claude', model: 'sonnet', promptTokens: 500_000,
  }) + '\n', 'utf-8');
  const s = cost.summarize({ now });
  // 500K @ $3 + 350K @ $15 = 1.5 + 5.25 = 6.75
  assertClose('promptTokens fallback works', s.estimatedUsd, 6.75, 0.01);
}

// ─────────────────────────────────────────────────────────────
// 11. PRICING / OUTPUT_RATIO / DEFAULT_USD_JPY exposure
// ─────────────────────────────────────────────────────────────
{
  assertEq('PRICING claude-sonnet input = 3', cost.PRICING['claude-sonnet'].input, 3.0);
  assertEq('PRICING claude-sonnet output = 15', cost.PRICING['claude-sonnet'].output, 15.0);
  assertEq('PRICING claude-haiku input = 1', cost.PRICING['claude-haiku'].input, 1.0);
  assertEq('PRICING claude-opus output = 75', cost.PRICING['claude-opus'].output, 75.0);
  assertEq('OUTPUT_RATIO = 0.7', cost.OUTPUT_RATIO, 0.7);
  assertEq('DEFAULT_USD_JPY = 150', cost.DEFAULT_USD_JPY, 150);
}

// ─────────────────────────────────────────────────────────────
// 12. lookbackBytes truncation: first line of buffer is intentionally skipped
// ─────────────────────────────────────────────────────────────
{
  resetMetrics();
  const now = new Date('2026-05-10T12:00:00Z');
  const entry = JSON.stringify({ type: 'phase_b_prompt_compiled', ts: now.toISOString(), provider: 'claude', model: 'sonnet', estimatedPromptTokens: 100_000 });
  // 5 entries; lookbackBytes small enough to slice mid-file
  const lines = ['SKIP', entry, entry, entry, entry, entry];
  fs.writeFileSync(metricsFile, lines.join('\n') + '\n', 'utf-8');

  const sFull = cost.summarize({ now, lookbackBytes: 1_000_000 });
  // Full read: 5 entries × 100K input → 500K input
  assertEq('full read totalInputTokens = 500K', sFull.totalInputTokens, 500_000);

  // Truncate to last ~150 bytes (1 entry)
  const sSmall = cost.summarize({ now, lookbackBytes: 200 });
  // Should have at most a few entries; first line of partial buffer is dropped
  assertOk('truncated read totalInputTokens < 500K', sSmall.totalInputTokens < 500_000);
}

// ─────────────────────────────────────────────────────────────
// 13. Invalid ts = NaN doesn't crash & doesn't update firstTs/lastTs
// ─────────────────────────────────────────────────────────────
{
  resetMetrics();
  const now = new Date('2026-05-10T12:00:00Z');
  fs.writeFileSync(metricsFile, 'SKIP\n' + JSON.stringify({
    type: 'phase_b_prompt_compiled', ts: 'not-a-date', provider: 'claude', model: 'sonnet', estimatedPromptTokens: 100_000,
  }) + '\n', 'utf-8');
  const s = cost.summarize({ now });
  assertEq('totalInputTokens still counted with bad ts', s.totalInputTokens, 100_000);
  assertEq('firstTs null when ts invalid', s.firstTs, null);
  assertEq('lastTs null when ts invalid', s.lastTs, null);
  // Today / month not incremented since dayKey/monthKey are ''
  assertEq('today.inputTokens = 0 with bad ts', s.today.inputTokens, 0);
  assertEq('thisMonth.inputTokens = 0 with bad ts', s.thisMonth.inputTokens, 0);
}

// ─────────────────────────────────────────────────────────────
// 14. fs read error path → empty summary (simulate by replacing file with directory)
// ─────────────────────────────────────────────────────────────
{
  resetMetrics();
  // Create a directory at the metrics-file path → openSync will throw
  fs.mkdirSync(metricsFile);
  try {
    const s = cost.summarize();
    // catch-all returns _emptySummary
    assertEq('fs error path returns 0 totalInputTokens', s.totalInputTokens, 0);
    assertOk('fs error path note exists', typeof s.note === 'string');
  } finally {
    try { fs.rmdirSync(metricsFile); } catch (_) {}
  }
}

// ─────────────────────────────────────────────────────────────
// Cleanup
// ─────────────────────────────────────────────────────────────
try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch (_) {}

// ─────────────────────────────────────────────────────────────
// Output
// ─────────────────────────────────────────────────────────────
console.log('');
console.log(`PASSED: ${passed}`);
console.log(`FAILED: ${failed}`);
if (failed > 0) {
  for (const f of failures) {
    console.log(`  FAIL: ${f.name}`);
    console.log(`    actual:   ${typeof f.actual === 'string' ? f.actual : JSON.stringify(f.actual)}`);
    console.log(`    expected: ${typeof f.expected === 'string' ? f.expected : JSON.stringify(f.expected)}`);
  }
  process.exitCode = 1;
} else {
  console.log('all cost-estimator tests passed.');
}

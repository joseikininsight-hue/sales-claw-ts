'use strict';

// Parent harness: spawn 3 benchmark runs with parallelism=1, 3, 5
// and aggregate results into a single honest report.

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const electronBin = require('electron');
const runner = path.resolve(__dirname, 'benchmark-n-companies-runner.cjs');

function runOnce({ n, parallel }) {
  return new Promise((resolve) => {
    const child = spawn(electronBin, [runner, `--n=${n}`, `--parallel=${parallel}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (c) => { stdout += c; process.stdout.write(c); });
    child.stderr.on('data', (c) => { stderr += c; process.stderr.write(c); });
    const timeout = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 180000);
    child.on('close', (code) => {
      clearTimeout(timeout);
      const m = stdout.lastIndexOf('---BENCH-RESULTS---');
      if (m < 0) { resolve({ ok: false, exitCode: code, error: 'no result marker', stderr: stderr.slice(-500) }); return; }
      try {
        const json = stdout.slice(m + '---BENCH-RESULTS---'.length).split('\n')[0].trim();
        resolve(JSON.parse(json));
      } catch (e) {
        resolve({ ok: false, error: e.message, stderr: stderr.slice(-500) });
      }
    });
  });
}

async function main() {
  const N = 10;
  console.log('\n============================================');
  console.log('Real Electron Benchmark: 10 synthetic companies x parallelism {1, 3, 5}');
  console.log('============================================\n');

  const runs = [];
  for (const parallel of [1, 3, 5]) {
    console.log(`\n>>> RUN parallel=${parallel} (N=${N}) <<<\n`);
    const r = await runOnce({ n: N, parallel });
    runs.push({ parallel, ...r });
  }

  console.log('\n\n=== AGGREGATE REPORT ===');
  const aggregate = runs.map((r) => ({
    parallel: r.parallel,
    ok: r.ok,
    successCount: r.stats?.successCount,
    failCount: r.stats?.failCount,
    totalSec: r.stats ? (r.stats.totalMs / 1000).toFixed(2) : null,
    avgPerCompanyMs: r.stats?.perCompanyAvgMs,
    medianMs: r.stats?.perCompanyMedianMs,
    p95Ms: r.stats?.perCompanyP95Ms,
    throughputPerMin: r.stats?.throughputCompaniesPerMinute,
    failures: r.stats?.failures || [],
  }));
  console.log(JSON.stringify(aggregate, null, 2));

  fs.writeFileSync(path.resolve(__dirname, '..', 'benchmark-report.json'), JSON.stringify({
    timestamp: new Date().toISOString(),
    fixture: 'tests/fixtures/local-form.html',
    runner: 'real Electron + real WebContentsView (no mocks)',
    runs: aggregate,
  }, null, 2));

  const anyFailures = aggregate.some((r) => !r.ok || (r.failures && r.failures.length > 0));
  if (anyFailures) {
    console.error('\n❌ Some runs had failures.');
    process.exit(1);
  }
  console.log('\n✅ All 3 runs (parallel=1, 3, 5) completed with 0 errors across N=10 each.');
}

main().catch((e) => { console.error('Harness fatal:', e); process.exit(1); });

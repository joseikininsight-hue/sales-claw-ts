'use strict';

/**
 * Baseline performance measurement for hot paths in Sales Claw.
 * Run before AND after caching changes to verify wins.
 *
 * Usage: node tests/perf-baseline.cjs
 */

const settings = require('../dist-ts/src/settings-manager');

function bench(label, iters, fn) {
  // warm
  for (let i = 0; i < Math.min(50, iters); i++) fn();
  const start = process.hrtime.bigint();
  for (let i = 0; i < iters; i++) fn();
  const elapsedNs = Number(process.hrtime.bigint() - start);
  const perCallUs = elapsedNs / iters / 1000;
  console.log(`  ${label.padEnd(40)} ${iters} iters, ${perCallUs.toFixed(2)} µs/call (${(elapsedNs / 1e6).toFixed(1)} ms total)`);
  return perCallUs;
}

console.log('=== settings-manager hot paths ===');
console.log('');
bench('getAll()', 1000, () => settings.getAll());
bench('getSection("preferences")', 1000, () => settings.getSection('preferences'));
bench('getPort()', 1000, () => settings.getPort());
bench('getHost()', 1000, () => settings.getHost());
bench('getSender()', 1000, () => settings.getSender());
bench('getStrengths()', 1000, () => settings.getStrengths());
bench('getExcludeStatuses()', 1000, () => settings.getExcludeStatuses());

console.log('');
console.log('=== combined: simulate one page render reading 6 fields ===');
bench('6 getter chain', 200, () => {
  settings.getPort();
  settings.getHost();
  settings.getSender();
  settings.getStrengths();
  settings.getExcludeStatuses();
  settings.getSection('preferences');
});

'use strict';

// Glob-based unit test runner.
//
// Replaces the hand-maintained 51-file list that used to live in
//   package.json scripts.test:unit. That list silently drifted: 21 test
//   files under tests/ were never run in CI (orphans), 13 of which passed
//   and were simply lost coverage. This runner auto-discovers every
//   tests/**/*.test.cjs so adding a test file is enough to wire it into CI.
//
// Two explicit exclusion sets keep the default `npm run test:unit` fast and
//   deterministic. Everything else runs.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const TESTS_DIR = __dirname;
const REPO_ROOT = path.resolve(TESTS_DIR, '..');

function latestSourceMtime(target) {
  if (!fs.existsSync(target)) return 0;
  const stat = fs.statSync(target);
  if (stat.isFile()) return stat.mtimeMs;
  let latest = 0;
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    latest = Math.max(latest, latestSourceMtime(path.join(target, entry.name)));
  }
  return latest;
}

function assertFreshBuild() {
  const stampPath = path.join(REPO_ROOT, 'dist-ts', '.build-stamp.json');
  if (!fs.existsSync(stampPath)) {
    throw new Error('dist-ts build stamp is missing; run npm run build before unit tests');
  }
  const stamp = JSON.parse(fs.readFileSync(stampPath, 'utf8'));
  const sourceMax = Math.max(
    latestSourceMtime(path.join(REPO_ROOT, 'src')),
    latestSourceMtime(path.join(REPO_ROOT, 'electron-main.ts')),
  );
  if (!Number.isFinite(stamp.sourceMaxMtimeMs) || stamp.sourceMaxMtimeMs < sourceMax) {
    throw new Error('dist-ts is older than src; run npm run build before unit tests');
  }
}

// Quarantine is intentionally empty. A stale test must be repaired or moved to
// E2E_SPECIAL with a concrete runtime requirement; it must not be hidden here.
const QUARANTINE = new Map();

// ── E2E / special: need the Electron binary, mutate the real user home, or
//    are benchmarks. Run via dedicated scripts, not the default unit pass.
const E2E_SPECIAL = new Set([
  'electron-real-form.test.cjs',     // spawns real Electron (require('electron'))
  'real-managed-home-purge.test.cjs', // mutates %APPDATA%\sales-claw-ts real managed home
  'benchmark-n-companies.test.cjs',   // performance benchmark, not pass/fail
]);

function collectTests(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'fixtures') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectTests(full));
    else if (entry.name.endsWith('.test.cjs')) out.push(full);
  }
  return out;
}

function relName(full) {
  return path.relative(TESTS_DIR, full).split(path.sep).join('/');
}

function main() {
  assertFreshBuild();
  const all = collectTests(TESTS_DIR).sort();
  const toRun = [];
  const skippedE2e = [];
  for (const full of all) {
    const base = path.basename(full);
    const rel = relName(full);
    if (QUARANTINE.has(base) || QUARANTINE.has(rel)) continue;
    if (E2E_SPECIAL.has(base) || E2E_SPECIAL.has(rel)) { skippedE2e.push(rel); continue; }
    toRun.push(full);
  }

  console.log(`[run-unit] discovered ${all.length} test files`);
  console.log(`[run-unit] running ${toRun.length}, quarantined ${QUARANTINE.size}, e2e/special ${skippedE2e.length}`);

  const failures = [];
  const runtimeSkipped = [];
  for (const full of toRun) {
    const rel = relName(full);
    const res = spawnSync(process.execPath, [full], { encoding: 'utf8', cwd: path.resolve(TESTS_DIR, '..') });
    if (res.status === 0) {
      const output = String((res.stdout || '') + (res.stderr || ''));
      if (/^\s*SKIP(?:PED)?(?:\s|:)/mi.test(output)) {
        console.log(`  SKIP  ${rel}`);
        runtimeSkipped.push(rel);
      } else {
        console.log(`  PASS  ${rel}`);
      }
    } else {
      console.error(`  FAIL  ${rel} (exit ${res.status})`);
      const tail = String((res.stdout || '') + (res.stderr || '')).split(/\r?\n/).filter(Boolean).slice(-8);
      tail.forEach((l) => console.error('        | ' + l));
      failures.push(rel);
    }
  }

  console.log('');
  if (QUARANTINE.size) {
    console.log('[run-unit] quarantined (stale — must be fixed in the noted phase):');
    for (const [name, reason] of QUARANTINE) console.log(`  - ${name}: ${reason}`);
  }
  if (skippedE2e.length) {
    console.log('[run-unit] e2e/special (run via npm run test:e2e):');
    skippedE2e.forEach((n) => console.log(`  - ${n}`));
  }
  if (runtimeSkipped.length) {
    console.log('[run-unit] runtime-skipped:');
    runtimeSkipped.forEach((n) => console.log(`  - ${n}`));
  }

  console.log('');
  if (failures.length) {
    console.error(`[run-unit] FAILED: ${failures.length}/${toRun.length} test files failed`);
    process.exit(1);
  }
  console.log(`[run-unit] OK: ${toRun.length - runtimeSkipped.length} passed, ${runtimeSkipped.length} skipped`);
}

main();

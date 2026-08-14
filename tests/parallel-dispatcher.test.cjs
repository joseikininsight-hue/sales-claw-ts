'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const dispatcher = require('../dist-ts/src/ai-runtime/parallel-dispatcher');

function describe(n, f) { console.log('\n=== ' + n + ' ==='); f(); }
let testChain = Promise.resolve();
function it(n, f) {
  testChain = testChain.then(async () => {
    try { await f(); console.log('  OK  ' + n); }
    catch (e) { console.error('  FAIL ' + n + ' — ' + e.message); process.exitCode = 1; }
  });
}

describe('_splitIntoGroups (v2.1.9: groupSize 単位のチャンク分割)', () => {
  // 旧仕様 (N グループへのラウンドロビン) は 50 社 → 25社×2 の巨大グループを生み、
  // グループ単位 timeout と矛盾して全滅した (2026-08-14)。新仕様は連続 groupSize 社
  // ずつのチャンク列で、ワークキューの投入単位になる。
  it('chunks 5 items into groups of 3', () => {
    const groups = dispatcher._splitIntoGroups([1, 2, 3, 4, 5], 3);
    assert.equal(groups.length, 2);
    assert.deepEqual(groups[0], [1, 2, 3]);
    assert.deepEqual(groups[1], [4, 5]);
  });

  it('50 items with groupSize 3 never exceed 3 per group', () => {
    const big = Array.from({ length: 50 }, (_, i) => i);
    const groups = dispatcher._splitIntoGroups(big, 3);
    assert.equal(groups.length, 17);
    assert.ok(groups.every((g) => g.length <= 3));
    assert.equal(groups.flat().length, 50);
  });

  it('groupSize 1 yields one group per item', () => {
    const groups = dispatcher._splitIntoGroups([1, 2, 3, 4], 1);
    assert.equal(groups.length, 4);
    assert.deepEqual(groups[0], [1]);
  });

  it('returns empty array for empty input', () => {
    const groups = dispatcher._splitIntoGroups([], 3);
    assert.equal(groups.length, 0);
  });
});

describe('runParallelBatch (no companies)', () => {
  it('returns ok:false when companies array is empty', async () => {
    const r = await dispatcher.runParallelBatch([], { providerId: 'claude' });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'no companies');
  });
});

describe('concurrency clamping', () => {
  it('defaults to practical Claude Max limits', () => {
    assert.equal(dispatcher.DEFAULT_CONCURRENCY, 2);
    assert.equal(dispatcher.DEFAULT_TIMEOUT_MS, 15 * 60 * 1000);
    assert.equal(dispatcher.DEFAULT_STAGGER_MS, 30 * 1000);
  });

  it('MAX_GROUP_SIZE keeps per-process work bounded for 50-company batches', () => {
    // v2.1.9: concurrency cap (3) は runParallelBatch 側の worker 数で決まる。
    // 分割はグループサイズ固定で、どのグループも timeout 内に完了できる粒度を保つ。
    const big = Array.from({ length: 50 }, (_, i) => i);
    const groups = dispatcher._splitIntoGroups(big, 3);
    assert.ok(groups.every((g) => g.length <= 3));
    assert.equal(groups.flat().length, 50);
  });
});

function createFastExitCtx(options = {}) {
  const terminalNos = new Set((options.terminalNos || []).map(String));
  const marked = [];
  const fastExitCommand = process.platform === 'win32'
    ? { executable: 'cmd.exe', args: ['/d', '/s', '/c', 'exit /b 0'] }
    : { executable: process.execPath, args: ['-e', 'process.exit(0)'] };
  const ctx = {
    providerId: 'claude',
    projectRoot: path.join(__dirname, '..'),
    buildPromptText: () => 'test prompt',
    writePromptFile: () => path.join(__dirname, 'fake-prompt.md'),
    buildHeadlessArgs: () => ({
      args: fastExitCommand.args,
      effectiveMode: 'test',
    }),
    buildCliCommandSpec: (exe, args) => ({ command: exe, args }),
    resolveExecutable: async () => fastExitCommand.executable,
    buildBaseEnv: () => ({ ...process.env }),
    appendDiagnosticEvent: () => {},
    emitLog: () => {},
    createLogFile: () => '',
    appendLog: () => {},
    hasCompanyTerminalLogSince: (companyNo) => terminalNos.has(String(companyNo)),
    markCompaniesFailed: (companies, reason) => {
      marked.push({ companies: companies.map((c) => c.no), reason });
    },
  };
  return { ctx, marked };
}

describe('slot completion verification', () => {
  it('treats exit 0 as failure when no terminal company log exists', async () => {
    const { ctx, marked } = createFastExitCtx();
    const result = await dispatcher.runParallelBatch([{ no: 101, companyName: 'A' }], ctx, {
      concurrency: 1,
      timeoutMs: 2000,
      staggerMs: 0,
    });
    assert.equal(result.ok, false);
    assert.equal(result.failedCompanies, 1);
    assert.deepEqual(result.slots[0].missingCompanyNos, [101]);
    assert.deepEqual(marked[0].companies, [101]);
  });

  it('accepts exit 0 when every company has a terminal log', async () => {
    const { ctx, marked } = createFastExitCtx({ terminalNos: [101] });
    const result = await dispatcher.runParallelBatch([{ no: 101, companyName: 'A' }], ctx, {
      concurrency: 1,
      timeoutMs: 2000,
      staggerMs: 0,
    });
    assert.equal(result.ok, true);
    assert.equal(result.succeededCompanies, 1);
    assert.equal(result.failedCompanies, 0);
    assert.equal(marked.length, 0);
  });

  it('honors explicit staggerMs=0 for tests and manual override', async () => {
    const { ctx } = createFastExitCtx({ terminalNos: [101, 102] });
    const started = Date.now();
    const result = await dispatcher.runParallelBatch([
      { no: 101, companyName: 'A' },
      { no: 102, companyName: 'B' },
    ], ctx, {
      concurrency: 2,
      timeoutMs: 2000,
      staggerMs: 0,
    });
    assert.equal(result.ok, true);
    assert.equal(result.staggerMs, 0);
    assert.ok(Date.now() - started < 5000, 'staggerMs=0 should not wait for the default 30 seconds');
  });
});

testChain.then(() => {
  console.log('\nall parallel-dispatcher tests passed.');
}).catch((e) => {
  console.error('parallel-dispatcher test harness failed:', e && e.stack || e);
  process.exitCode = 1;
});

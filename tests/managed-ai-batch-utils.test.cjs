'use strict';

const assert = require('node:assert/strict');
const utils = require('../dist-ts/src/ai-runtime/batch-utils');

function describe(n, f) { console.log('\n=== ' + n + ' ==='); f(); }
function it(n, f) {
  try { f(); console.log('  OK  ' + n); }
  catch (e) { console.error('  FAIL ' + n + ' - ' + e.message); process.exitCode = 1; }
}

describe('hasClaudePasteBanner', () => {
  it('detects both Claude paste banner variants', () => {
    assert.equal(utils.hasClaudePasteBanner('[Pasted text #1 +49 lines]'), true);
    assert.equal(utils.hasClaudePasteBanner('paste again to expand'), true);
  });

  it('strips ANSI escape sequences before matching', () => {
    assert.equal(utils.hasClaudePasteBanner('[33m[Pasted text #1 +49 lines][0m'), true);
  });

  it('does not match unrelated PTY output', () => {
    assert.equal(utils.hasClaudePasteBanner('Type your message and press Enter'), false);
    assert.equal(utils.hasClaudePasteBanner('message_draft completed'), false);
  });

  it('handles null / undefined / non-string inputs gracefully', () => {
    assert.equal(utils.hasClaudePasteBanner(null), false);
    assert.equal(utils.hasClaudePasteBanner(undefined), false);
    assert.equal(utils.hasClaudePasteBanner(0), false);
    assert.equal(utils.hasClaudePasteBanner(''), false);
  });
});

describe('chunkManagedAiCompanies', () => {
  const sample = [
    { no: 1, name: 'A' }, { no: 2, name: 'B' }, { no: 3, name: 'C' },
    { no: 4, name: 'D' }, { no: 5, name: 'E' }, { no: 6, name: 'F' }, { no: 7, name: 'G' },
  ];

  it('chunks list by default chunkSize=3', () => {
    const result = utils.chunkManagedAiCompanies(sample);
    assert.equal(result.length, 3);
    assert.equal(result[0].length, 3);
    assert.equal(result[1].length, 3);
    assert.equal(result[2].length, 1);
    assert.equal(result[2][0].no, 7);
  });

  it('chunks list with custom size', () => {
    const result = utils.chunkManagedAiCompanies(sample, 2);
    assert.equal(result.length, 4);
    assert.deepEqual(result.map((c) => c.length), [2, 2, 2, 1]);
  });

  it('returns single chunk when size >= length', () => {
    const result = utils.chunkManagedAiCompanies(sample, 100);
    assert.equal(result.length, 1);
    assert.equal(result[0].length, 7);
  });

  it('coerces invalid chunkSize (0, NaN, non-numeric) to default 3', () => {
    // 0 / NaN / non-numeric → Number(x)||3 → 3, then Math.max(1,3)=3
    assert.equal(utils.chunkManagedAiCompanies(sample, 0).length, 3);
    assert.equal(utils.chunkManagedAiCompanies(sample, NaN).length, 3);
    assert.equal(utils.chunkManagedAiCompanies(sample, 'abc').length, 3);
  });

  it('clamps negative chunkSize to 1', () => {
    // Number(-5)||3 → -5 (truthy), Math.max(1,-5) → 1, so 7 items become 7 chunks
    assert.equal(utils.chunkManagedAiCompanies(sample, -5).length, 7);
  });

  it('chunks one-per-bucket when chunkSize=1', () => {
    assert.equal(utils.chunkManagedAiCompanies(sample, 1).length, 7);
  });

  it('handles empty / non-array input', () => {
    assert.deepEqual(utils.chunkManagedAiCompanies([]), []);
    assert.deepEqual(utils.chunkManagedAiCompanies(null), []);
    assert.deepEqual(utils.chunkManagedAiCompanies(undefined), []);
    assert.deepEqual(utils.chunkManagedAiCompanies('not-array'), []);
  });
});

describe('buildManagedAiBatchOptionsSubset', () => {
  it('subsets phaseAByCompany Map by company.no', () => {
    const phaseAByCompany = new Map([
      ['1', { sites: ['a'] }],
      ['2', { sites: ['b'] }],
      ['3', { sites: ['c'] }],
    ]);
    const baseOptions = {
      phaseAByCompany,
      phaseASuccesses: [{ companyNo: 1 }, { companyNo: 2 }, { companyNo: 3 }],
      phaseAFailures: [{ companyNo: 2, error: 'x' }],
      otherKey: 'preserved',
    };
    const subset = utils.buildManagedAiBatchOptionsSubset(baseOptions, [{ no: 1 }, { no: 3 }]);
    assert.equal(subset.phaseAByCompany.size, 2);
    assert.equal(subset.phaseAByCompany.has('1'), true);
    assert.equal(subset.phaseAByCompany.has('3'), true);
    assert.equal(subset.phaseAByCompany.has('2'), false);
    assert.equal(subset.phaseASuccesses.length, 2);
    assert.equal(subset.phaseAFailures.length, 0);
    assert.equal(subset.otherKey, 'preserved');
  });

  it('handles missing phaseAByCompany / phaseASuccesses / phaseAFailures', () => {
    const subset = utils.buildManagedAiBatchOptionsSubset({}, [{ no: 1 }]);
    assert.ok(subset.phaseAByCompany instanceof Map);
    assert.equal(subset.phaseAByCompany.size, 0);
    assert.deepEqual(subset.phaseASuccesses, []);
    assert.deepEqual(subset.phaseAFailures, []);
  });

  it('ignores non-Map phaseAByCompany without throwing', () => {
    const subset = utils.buildManagedAiBatchOptionsSubset({ phaseAByCompany: { 1: 'x' } }, [{ no: 1 }]);
    assert.equal(subset.phaseAByCompany.size, 0);
  });

  it('handles empty inputs', () => {
    const subset = utils.buildManagedAiBatchOptionsSubset();
    assert.ok(subset.phaseAByCompany instanceof Map);
    assert.deepEqual(subset.phaseASuccesses, []);
    assert.deepEqual(subset.phaseAFailures, []);
  });
});

describe('createManagedAiBatchController', () => {
  it('returns initial controller state with normalized fields', () => {
    const controller = utils.createManagedAiBatchController('claude', true);
    assert.equal(controller.providerId, 'claude');
    assert.equal(controller.autoSendSafe, true);
    assert.deepEqual(controller.pending, []);
    assert.equal(controller.activeBatch, null);
    assert.equal(controller.batchCounter, 0);
    assert.equal(controller.pollTimer, null);
  });

  it('coerces autoSendSafe to boolean', () => {
    assert.equal(utils.createManagedAiBatchController('codex', 'truthy').autoSendSafe, true);
    assert.equal(utils.createManagedAiBatchController('gemini', 0).autoSendSafe, false);
    assert.equal(utils.createManagedAiBatchController('claude', null).autoSendSafe, false);
    assert.equal(utils.createManagedAiBatchController('claude', undefined).autoSendSafe, false);
  });
});

describe('parseEventTimestampMs', () => {
  it('returns 0 for falsy input', () => {
    assert.equal(utils.parseEventTimestampMs(null), 0);
    assert.equal(utils.parseEventTimestampMs(undefined), 0);
    assert.equal(utils.parseEventTimestampMs(''), 0);
    assert.equal(utils.parseEventTimestampMs(0), 0);
  });

  it('passes through finite numbers', () => {
    assert.equal(utils.parseEventTimestampMs(1700000000000), 1700000000000);
    assert.equal(utils.parseEventTimestampMs(42), 42);
  });

  it('parses ISO date strings', () => {
    const iso = '2026-01-01T00:00:00.000Z';
    assert.equal(utils.parseEventTimestampMs(iso), Date.parse(iso));
  });

  it('returns 0 for unparseable strings', () => {
    assert.equal(utils.parseEventTimestampMs('not a date'), 0);
    assert.equal(utils.parseEventTimestampMs('xyz'), 0);
  });

  it('handles non-finite numbers via string fallback', () => {
    assert.equal(utils.parseEventTimestampMs(Infinity), 0);
    assert.equal(utils.parseEventTimestampMs(NaN), 0);
  });
});

describe('stripAnsiCodes', () => {
  it('removes CSI sequences', () => {
    assert.equal(utils.stripAnsiCodes('[33mhello[0m world'), 'hello world');
    assert.equal(utils.stripAnsiCodes('[1;31mERROR[m'), 'ERROR');
  });

  it('removes single ESC + final byte sequences', () => {
    assert.equal(utils.stripAnsiCodes('Mfoo'), 'foo');
  });

  it('removes 8-bit CSI (0x9b)', () => {
    assert.equal(utils.stripAnsiCodes('31mhi0m'), 'hi');
  });

  it('returns empty string for null / undefined', () => {
    assert.equal(utils.stripAnsiCodes(null), '');
    assert.equal(utils.stripAnsiCodes(undefined), '');
  });

  it('passes plain strings through untouched', () => {
    assert.equal(utils.stripAnsiCodes('plain text'), 'plain text');
  });

  it('coerces numbers / objects via String()', () => {
    assert.equal(utils.stripAnsiCodes(42), '42');
  });
});

console.log('\nall managed AI batch utils tests passed.');

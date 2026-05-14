'use strict';

const assert = require('node:assert/strict');
const simpleApi = require('../dist-ts/src/routes/simple-api');

function describe(n, f) { console.log('\n=== ' + n + ' ==='); f(); }
function it(n, f) {
  try { f(); console.log('  OK  ' + n); }
  catch (e) { console.error('  FAIL ' + n + ' - ' + e.message); process.exitCode = 1; }
}

describe('csvCell', () => {
  it('escapes CSV structure and guards Excel formulas', () => {
    assert.equal(simpleApi._test.csvCell('hello'), 'hello');
    assert.equal(simpleApi._test.csvCell('a,b'), '"a,b"');
    assert.equal(simpleApi._test.csvCell('"quoted"'), '"""quoted"""');
    assert.equal(simpleApi._test.csvCell('=HYPERLINK("http://bad")'), '"\'=HYPERLINK(""http://bad"")"');
    assert.equal(simpleApi._test.csvCell('+SUM(A1:A2)'), "'+SUM(A1:A2)");
    assert.equal(simpleApi._test.csvCell('-10'), "'-10");
    assert.equal(simpleApi._test.csvCell('@cmd'), "'@cmd");
  });
});

describe('normalizeValidationTargets', () => {
  it('accepts companyName from dashboard data and drops nameless rows', () => {
    const rows = simpleApi._test.normalizeValidationTargets({
      companies: [
        { no: 1, companyName: '株式会社A', url: 'https://a.example', formUrl: 'https://a.example/contact' },
        { no: 2, name: '株式会社B', url: 'https://b.example' },
        { no: 3, url: 'https://nameless.example' },
      ],
    });
    assert.deepEqual(rows, [
      { no: 1, name: '株式会社A', url: 'https://a.example', formUrl: 'https://a.example/contact' },
      { no: 2, name: '株式会社B', url: 'https://b.example', formUrl: '' },
    ]);
  });
});

console.log('\nall simple-api P1 tests passed.');

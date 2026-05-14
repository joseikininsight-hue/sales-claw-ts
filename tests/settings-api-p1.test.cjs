'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function describe(n, f) { console.log('\n=== ' + n + ' ==='); f(); }
function it(n, f) {
  try { f(); console.log('  OK  ' + n); }
  catch (e) { console.error('  FAIL ' + n + ' - ' + e.message); process.exitCode = 1; }
}

describe('settings target-list import', () => {
  it('defers full data-quality validation instead of running it during import', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'settings-api.ts'), 'utf8');
    assert.match(source, /validationDeferred:\s*true/);
    assert.match(source, /target-list-validation-deferred/);
    assert.doesNotMatch(source, /require\(['"]\.\.\/target-list-validator\.cjs['"]\)/);
  });
});

console.log('\nall settings-api P1 tests passed.');

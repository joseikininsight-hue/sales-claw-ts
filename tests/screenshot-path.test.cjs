'use strict';

// Unit tests for the /screenshots/ static-serving path guard.
//
// Covers the path-traversal payloads called out in the refactoring plan
//   (../, ..%2f, absolute path, UNC path) plus null byte, non-.png, and the
//   sibling-directory prefix bypass (screenshots-evil/).

const assert = require('node:assert/strict');
const path = require('node:path');

const { isSafeScreenshotRelative, resolveScreenshotPath } = require('../dist-ts/src/screenshot-path');

function describe(n, f) { console.log('\n=== ' + n + ' ==='); return f(); }
function it(n, f) {
  try { f(); console.log('  OK  ' + n); }
  catch (e) { console.error('  FAIL ' + n + ' - ' + e.message); process.exitCode = 1; }
}

const SS_DIR = process.platform === 'win32' ? 'C:\\sales-claw\\screenshots' : '/var/sales-claw/screenshots';

function main() {
  describe('isSafeScreenshotRelative', () => {
    it('accepts a normal ss-{No}-{suffix}.png name', () => {
      assert.equal(isSafeScreenshotRelative('ss-185-input.png'), true);
    });
    it('rejects empty / non-string', () => {
      assert.equal(isSafeScreenshotRelative(''), false);
      assert.equal(isSafeScreenshotRelative(null), false);
      assert.equal(isSafeScreenshotRelative(undefined), false);
      assert.equal(isSafeScreenshotRelative(42), false);
    });
    it('rejects parent-dir traversal (..)', () => {
      assert.equal(isSafeScreenshotRelative('../secret.png'), false);
      assert.equal(isSafeScreenshotRelative('a/../../b.png'), false);
    });
    it('rejects NUL byte', () => {
      assert.equal(isSafeScreenshotRelative('ss-1-input.png\0.txt'), false);
    });
    it('rejects non-.png extensions (arbitrary file read)', () => {
      assert.equal(isSafeScreenshotRelative('settings.json'), false);
      assert.equal(isSafeScreenshotRelative('ss-1-input.png.exe'), false);
    });
  });

  describe('resolveScreenshotPath — valid', () => {
    it('resolves a normal path under the screenshot dir', () => {
      const out = resolveScreenshotPath('/screenshots/ss-185-input.png', SS_DIR);
      assert.equal(out, path.resolve(SS_DIR, 'ss-185-input.png'));
    });
    it('returns null for a non-/screenshots/ pathname', () => {
      assert.equal(resolveScreenshotPath('/assets/x.png', SS_DIR), null);
    });
  });

  describe('resolveScreenshotPath — traversal payloads are rejected', () => {
    it('rejects ../ traversal', () => {
      assert.equal(resolveScreenshotPath('/screenshots/../secret.png', SS_DIR), null);
    });
    it('rejects URL-encoded ..%2f traversal', () => {
      // ..%2f decodes to ../ → caught by the `..` check
      assert.equal(resolveScreenshotPath('/screenshots/..%2f..%2fsecret.png', SS_DIR), null);
    });
    it('rejects malformed percent-encoding', () => {
      assert.equal(resolveScreenshotPath('/screenshots/%E0%A4%A.png', SS_DIR), null);
    });
    it('rejects an absolute path payload', () => {
      const abs = process.platform === 'win32' ? '/screenshots/C:/Windows/win.png' : '/screenshots//etc/passwd.png';
      assert.equal(resolveScreenshotPath(abs, SS_DIR), null);
    });
    it('rejects a UNC path payload', () => {
      assert.equal(resolveScreenshotPath('/screenshots/%5C%5Cserver%5Cshare%5Cx.png', SS_DIR), null);
    });
    it('rejects non-.png', () => {
      assert.equal(resolveScreenshotPath('/screenshots/ss-1-input.txt', SS_DIR), null);
    });
    it('rejects sibling-directory prefix bypass (screenshots-evil)', () => {
      // path.resolve(SS_DIR, '../screenshots-evil/x.png') would start with the
      //   string SS_DIR only without the path.sep boundary check; '..' guard
      //   already rejects this, but assert the boundary holds regardless.
      assert.equal(resolveScreenshotPath('/screenshots/../screenshots-evil/x.png', SS_DIR), null);
    });
  });

  console.log('\nall screenshot-path tests passed.');
}

main();

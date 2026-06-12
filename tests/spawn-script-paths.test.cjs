'use strict';

// Smoke test: every script path that runtime code resolves via
//   path.join(..., 'scripts', '<file>') MUST exist on disk.
//
// Regression guard for the v2.1.x incident where commit 8cc882d renamed
//   scripts/managed-pty-viewer.cjs → .ts but dashboard-server.ts still
//   spawned the .cjs path → the two viewer endpoints threw at runtime
//   (the .ts is excluded from tsc, so no compiled .cjs was ever produced).
//
// This scans the TypeScript sources for `'scripts', '<file>'` literals and
//   asserts each referenced file is present, so the same class of bug
//   (code references a script path that is not on disk) fails CI immediately.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const SRC_DIR = path.join(REPO_ROOT, 'src');
const SCRIPTS_DIR = path.join(REPO_ROOT, 'scripts');

function describe(n, f) { console.log('\n=== ' + n + ' ==='); return f(); }
function it(n, f) {
  try { f(); console.log('  OK  ' + n); }
  catch (e) { console.error('  FAIL ' + n + ' - ' + e.message); process.exitCode = 1; }
}

// Recursively collect .ts source files (skip compiled output / node_modules).
function collectTsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectTsFiles(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

// Match path.join(..., 'scripts', '<file>.<ext>') — the runtime spawn-target idiom.
//   Captures the filename literal that follows a 'scripts' segment.
const SCRIPTS_SEGMENT_RE = /['"]scripts['"]\s*,\s*['"]([^'"]+\.(?:cjs|js|mjs|py|ps1))['"]/g;

function main() {
  describe('spawn script paths exist on disk', () => {
    it('the fixed viewer script is present as .cjs (not .ts)', () => {
      assert.ok(
        fs.existsSync(path.join(SCRIPTS_DIR, 'managed-pty-viewer.cjs')),
        'scripts/managed-pty-viewer.cjs must exist (dashboard-server spawns it via node)',
      );
      assert.ok(
        !fs.existsSync(path.join(SCRIPTS_DIR, 'managed-pty-viewer.ts')),
        'scripts/managed-pty-viewer.ts must NOT exist (tsc excludes scripts/, so a .ts here is never compiled and the .cjs spawn target would be missing)',
      );
    });

    const tsFiles = collectTsFiles(SRC_DIR);
    const references = new Map(); // referencedFile -> [sourceFile:line, ...]
    for (const file of tsFiles) {
      const text = fs.readFileSync(file, 'utf8');
      const lines = text.split(/\r?\n/);
      lines.forEach((line, idx) => {
        let m;
        SCRIPTS_SEGMENT_RE.lastIndex = 0;
        while ((m = SCRIPTS_SEGMENT_RE.exec(line)) !== null) {
          const ref = m[1];
          const where = path.relative(REPO_ROOT, file) + ':' + (idx + 1);
          if (!references.has(ref)) references.set(ref, []);
          references.get(ref).push(where);
        }
      });
    }

    it('found at least the known runtime script references', () => {
      // Sanity: the scan must actually find references (guards against a
      //   broken regex silently passing the existence checks below).
      assert.ok(
        references.has('managed-pty-viewer.cjs'),
        'expected to find a managed-pty-viewer.cjs reference in src/**',
      );
    });

    for (const [ref, locations] of references) {
      it(`scripts/${ref} exists (referenced at ${locations.join(', ')})`, () => {
        assert.ok(
          fs.existsSync(path.join(SCRIPTS_DIR, ref)),
          `src code references scripts/${ref} but the file is missing on disk (referenced at ${locations.join(', ')})`,
        );
      });
    }
  });

  console.log('\nall spawn-script-paths tests passed.');
}

main();

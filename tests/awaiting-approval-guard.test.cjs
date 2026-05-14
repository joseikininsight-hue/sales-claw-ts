'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function describe(n, f) { console.log('\n=== ' + n + ' ==='); f(); }
function it(n, f) {
  try { f(); console.log('  OK  ' + n); }
  catch (e) { console.error('  FAIL ' + n + ' - ' + e.message); process.exitCode = 1; }
}

const ROOT = path.join(__dirname, '..');

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.claude') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(cjs|js|ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe('awaiting_approval guard', () => {
  it('does not directly log awaiting_approval from server code', () => {
    const offenders = [];
    for (const file of walk(path.join(ROOT, 'src'))) {
      const source = fs.readFileSync(file, 'utf8');
      const directAwaitingLog = /\b(?:actionLogger\.)?logAction\s*\([\s\S]{0,220}['"]awaiting_approval['"]/g;
      let match;
      while ((match = directAwaitingLog.exec(source))) {
        offenders.push(path.relative(ROOT, file) + ': ' + match[0].replace(/\s+/g, ' ').slice(0, 180));
      }
    }
    assert.deepEqual(offenders, []);
  });

  it('resend prepare records a pending resend instead of returning to awaiting', () => {
    const source = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'simple-api.ts'), 'utf8');
    const start = source.indexOf('async function handleResendPrepare');
    const end = source.indexOf('// POST /api/cli-log', start);
    assert.ok(start > 0 && end > start, 'handleResendPrepare block not found');
    const block = source.slice(start, end);
    assert.match(block, /resend_requested/);
    assert.doesNotMatch(block, /logAction\s*\([\s\S]{0,180}['"]awaiting_approval['"]/);
  });

  it('managed AI prompts explicitly guard awaiting approval and CAPTCHA handling', () => {
    const source = fs.readFileSync(path.join(ROOT, 'src', 'dashboard-server.ts'), 'utf8');
    assert.match(source, /awaiting_approval はフォーム入力済み \+ ss-\{No\}-input\.png 作成済みの場合だけ許可/);
    // 1.2.91+: CAPTCHA → fill+await 仕様 (旧 error 仕様から変更)
    assert.match(source, /CAPTCHA を見つけたら停止せず/);
    assert.match(source, /awaiting_approval \(人間が CAPTCHA 解いて送信\)/);
  });
});

console.log('\nall awaiting approval guard tests passed.');

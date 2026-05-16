// 言語自動判定のスナップショットテスト (Phase 2)
//
// 実行方法:
//   npx tsx src/__tests__/language-detector.test.ts
//
// 既存テストと同じ node:assert/strict を使う最小実装。

import assert from 'node:assert/strict';
import { detectLanguage } from '../language-detector';

function it(name: string, fn: () => void): void {
  try {
    fn();
    console.log('  OK  ' + name);
  } catch (e: any) {
    console.error('  FAIL ' + name + ' — ' + (e && e.message ? e.message : String(e)));
    process.exitCode = 1;
  }
}

console.log('=== detectLanguage ===');

it('detects ja from <html lang="ja">', () => {
  const r = detectLanguage('<html lang="ja"><body>Hello</body></html>');
  assert.equal(r.language, 'ja');
  assert.equal(r.source, 'html-lang');
  assert.ok(r.confidence >= 0.8);
});

it('detects en from <html lang="en">', () => {
  const r = detectLanguage('<html lang="en"><body>Hello world</body></html>');
  assert.equal(r.language, 'en');
  assert.equal(r.source, 'html-lang');
  assert.ok(r.confidence >= 0.8);
});

it('detects ja by CJK ratio when no lang attribute', () => {
  const r = detectLanguage(
    '<html><body>こんにちは、本日はお問い合わせいただきありがとうございます。</body></html>'
  );
  assert.equal(r.language, 'ja');
  assert.equal(r.source, 'cjk-ratio');
});

it('falls back for ASCII-only without lang attribute', () => {
  const r = detectLanguage('<html><body>Hello world this is a test page</body></html>');
  // CJK 比率 0 → デフォルト 'en' フォールバック
  assert.equal(r.language, 'en');
  assert.equal(r.source, 'default');
  assert.ok(r.confidence <= 0.4);
});

it('returns default for empty input', () => {
  const r = detectLanguage('');
  assert.equal(r.language, 'en');
  assert.equal(r.source, 'default');
  assert.ok(Math.abs(r.confidence - 0.3) < 1e-9);
});

if (process.exitCode && process.exitCode !== 0) {
  console.error('\nsome language-detector tests failed.');
} else {
  console.log('\nall language-detector tests passed.');
}

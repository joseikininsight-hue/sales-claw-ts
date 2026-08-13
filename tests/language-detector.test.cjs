'use strict';

const assert = require('node:assert/strict');
const { detectLanguage } = require('../dist-ts/src/language-detector');

assert.deepEqual(
  detectLanguage('<html lang="ja"><body>Hello</body></html>'),
  { language: 'ja', confidence: 0.9, source: 'html-lang' },
);
assert.deepEqual(
  detectLanguage('<html lang="en"><body>Hello world</body></html>'),
  { language: 'en', confidence: 0.9, source: 'html-lang' },
);

const ja = detectLanguage('<html><body>こんにちは、本日はお問い合わせいただきありがとうございます。</body></html>');
assert.equal(ja.language, 'ja');
assert.equal(ja.source, 'cjk-ratio');

const ascii = detectLanguage('<html><body>Hello world this is a test page</body></html>');
assert.equal(ascii.language, 'en');
assert.equal(ascii.source, 'default');
assert.ok(ascii.confidence <= 0.4);

assert.deepEqual(
  detectLanguage(''),
  { language: 'en', confidence: 0.3, source: 'default' },
);

console.log('language-detector tests passed');

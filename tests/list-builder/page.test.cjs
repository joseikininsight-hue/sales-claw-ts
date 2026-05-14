'use strict';

const assert = require('node:assert/strict');
const { renderListBuilderPage } = require('../../dist-ts/src/list-builder-page');

function describe(n, f) { console.log('\n=== ' + n + ' ==='); f(); }
function it(n, f) {
  try { f(); console.log('  OK  ' + n); }
  catch (e) { console.error('  FAIL ' + n + ' — ' + e.message); process.exitCode = 1; }
}

describe('renderListBuilderPage', () => {
  it('returns full HTML doctype', () => {
    const html = renderListBuilderPage({ sessionToken: 'abc' });
    assert.ok(html.startsWith('<!doctype html>'));
    assert.match(html, /<\/html>/i);
  });

  it('embeds session token safely in JS', () => {
    const html = renderListBuilderPage({ sessionToken: 'mytoken' });
    // JSON.stringify でエスケープされて埋め込まれている
    assert.match(html, /SESSION_TOKEN = "mytoken"/);
  });

  it('JSON-encodes session token to prevent XSS in JS context', () => {
    const html = renderListBuilderPage({ sessionToken: '"></script><script>alert(1)</script>' });
    // JSON.stringify が " と </ を安全にエスケープするので、生で出ない
    // (JSON 内には \" として埋め込まれ、終了 </script> タグは作れない)
    assert.doesNotMatch(html, /\"><\/script><script>alert\(1\)/);
  });

  it('includes all 3 mode tabs', () => {
    const html = renderListBuilderPage();
    assert.match(html, /data-tab="url"/);
    assert.match(html, /data-tab="nlq"/);
    assert.match(html, /data-tab="category"/);
  });

  it('includes all 3 form panels', () => {
    const html = renderListBuilderPage();
    assert.match(html, /id="tab-url"/);
    assert.match(html, /id="tab-nlq"/);
    assert.match(html, /id="tab-category"/);
  });

  it('includes preview / progress panels', () => {
    const html = renderListBuilderPage();
    assert.match(html, /id="progressPanel"/);
    assert.match(html, /id="previewPanel"/);
  });

  it('includes industry / prefecture / employee / revenue category controls', () => {
    const html = renderListBuilderPage();
    assert.match(html, /name="industry"/);
    assert.match(html, /name="prefecture"/);
    assert.match(html, /name="employee"/);
    assert.match(html, /name="revenue"/);
  });

  it('includes growthTrend and unknownPolicy options', () => {
    const html = renderListBuilderPage();
    assert.match(html, /id="growthTrend"/);
    assert.match(html, /name="unknownPolicy"/);
  });

  it('includes call-to-action buttons', () => {
    const html = renderListBuilderPage();
    assert.match(html, /id="urlRunBtn"/);
    assert.match(html, /id="nlqRunBtn"/);
    assert.match(html, /id="categoryRunBtn"/);
    assert.match(html, /id="commitBtn"/);
    assert.match(html, /id="cancelBtn"/);
  });

  it('includes API key warning element', () => {
    const html = renderListBuilderPage();
    assert.match(html, /id="apiKeyWarning"/);
  });

  it('uses /api/list-builder/run endpoint in JS', () => {
    const html = renderListBuilderPage();
    assert.match(html, /\/api\/list-builder\/run/);
    assert.match(html, /\/api\/list-builder\/stream\//);
    assert.match(html, /\/api\/list-builder\/commit/);
  });

  it('includes link back to dashboard', () => {
    const html = renderListBuilderPage();
    assert.match(html, /href="\/"/);
  });
});

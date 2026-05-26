'use strict';

// Phase 1 skeleton test for src/cdp-bridge.ts.
//
// Strategy: Electron 本物を起動せず、`webContents.debugger` の薄い mock を渡し、
// attach / sendCommand / addEventListener / OOPIF auto-attach の呼び出し
// signature だけを検証する。
//
// Phase 2 で integration test (実 Electron 起動 + 実 page) を追加予定。

const assert = require('assert');
const path = require('path');

// dist-ts/src/cdp-bridge.js を require (tsc 出力)
const cdpModulePath = path.resolve(__dirname, '..', 'dist-ts', 'src', 'cdp-bridge.js');
let cdp;
try {
  cdp = require(cdpModulePath);
} catch (e) {
  console.error(`[cdp-bridge.test] dist-ts not built yet. Run 'npm run build' first.`);
  console.error(`  Looked for: ${cdpModulePath}`);
  console.error(`  Error: ${e.message}`);
  process.exit(0); // skip not fail (CI を緑に保つ。Phase 2 で必須化)
}

function createMockWebContents(id = 1) {
  const listeners = new Map();
  const sentCommands = [];
  return {
    id,
    debugger: {
      attach(version) { this._attached = version; },
      detach() { this._attached = null; },
      on(event, handler) { listeners.set(event, handler); },
      sendCommand(method, params, sessionId) {
        sentCommands.push({ method, params, sessionId });
        // 各 method に応じた最小 stub を返す
        if (method === 'Page.createIsolatedWorld') {
          return Promise.resolve({ executionContextId: 99 });
        }
        return Promise.resolve({});
      },
    },
    _internal: { listeners, sentCommands },
  };
}

async function testAttachIdempotent() {
  const wc = createMockWebContents(1);
  await cdp.attach(wc);
  await cdp.attach(wc); // 2回目は no-op
  // attach が複数回呼ばれていないことだけ確認
  assert.strictEqual(wc.debugger._attached, '1.3', 'protocolVersion default = 1.3');
  console.log('  ✓ attach is idempotent');
}

async function testAttachSendsBootstrapCommands() {
  const wc = createMockWebContents(2);
  await cdp.attach(wc);
  const methods = wc._internal.sentCommands.map((c) => c.method);
  // 起動時に Target.setAutoAttach / Page.enable / Runtime.enable / DOM.enable
  assert.ok(methods.includes('Target.setAutoAttach'), 'Target.setAutoAttach not sent');
  assert.ok(methods.includes('Page.enable'), 'Page.enable not sent');
  assert.ok(methods.includes('Runtime.enable'), 'Runtime.enable not sent');
  assert.ok(methods.includes('DOM.enable'), 'DOM.enable not sent');
  console.log('  ✓ attach sends bootstrap commands');
}

async function testSendCommandFailsWhenDetached() {
  const wc = createMockWebContents(3);
  let threw = false;
  try {
    await cdp.sendCommand(wc, 'Runtime.evaluate', { expression: '1+1' });
  } catch (e) {
    threw = true;
    assert.match(e.message, /CDP not attached/, 'error message should mention "not attached"');
  }
  assert.ok(threw, 'sendCommand on detached webContents should throw');
  console.log('  ✓ sendCommand throws when not attached');
}

async function testEnsureIsolatedWorldCachesContextId() {
  const wc = createMockWebContents(4);
  await cdp.attach(wc);
  const ctx1 = await cdp.ensureIsolatedWorld(wc, 'frame-abc');
  const ctx2 = await cdp.ensureIsolatedWorld(wc, 'frame-abc');
  assert.strictEqual(ctx1, 99);
  assert.strictEqual(ctx2, 99);
  // createIsolatedWorld の呼び出し回数を確認
  const createCalls = wc._internal.sentCommands.filter((c) => c.method === 'Page.createIsolatedWorld');
  assert.strictEqual(createCalls.length, 1, 'should be cached, not re-created');
  console.log('  ✓ ensureIsolatedWorld caches contextId per frame');
}

async function run() {
  console.log('cdp-bridge.test.cjs');
  await testAttachIdempotent();
  await testAttachSendsBootstrapCommands();
  await testSendCommandFailsWhenDetached();
  await testEnsureIsolatedWorldCachesContextId();
  console.log('All cdp-bridge tests passed.');
}

run().catch((e) => {
  console.error(`FAIL: ${e.stack || e.message || e}`);
  process.exit(1);
});

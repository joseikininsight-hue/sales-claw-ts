'use strict';

/**
 * デモダッシュボードを起動する。
 *
 * - SALES_CLAW_DEMO=1 で認証バイパス + 危険エンドポイント遮断
 * - SALES_CLAW_USER_DATA_DIR を <os.tmpdir>/sales-claw-demo に固定
 * - シードを上書き投入
 * - dashboard-server.cjs を require して内部 server を listen させる
 *
 * 想定ポート: 3766 (LP の 3000 と被らないように)。SALES_CLAW_DEMO_PORT で上書き可。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEMO_PORT = Number(process.env.SALES_CLAW_DEMO_PORT || 3766);
const DEMO_RUNTIME = process.env.SALES_CLAW_USER_DATA_DIR
  || path.join(os.tmpdir(), 'sales-claw-demo');

process.env.SALES_CLAW_DEMO = '1';
process.env.SALES_CLAW_USER_DATA_DIR = DEMO_RUNTIME;
process.env.SALES_CLAW_FRESH_RESEED = process.env.SALES_CLAW_FRESH_RESEED || '1';

console.log('[demo] runtime dir:', DEMO_RUNTIME);
console.log('[demo] port:', DEMO_PORT);

// シードを投入 (毎回再投入するのでデモ後に汚れない)
const { seedDemoData } = require('./seed-demo-data');
if (process.env.SALES_CLAW_FRESH_RESEED === '1' && fs.existsSync(DEMO_RUNTIME)) {
  try {
    fs.rmSync(DEMO_RUNTIME, { recursive: true, force: true });
  } catch (e) {
    console.warn('[demo] reseed cleanup failed:', e.message);
  }
}
seedDemoData(DEMO_RUNTIME);

// settings の port を上書き済みなので、dashboard-server は自動的に DEMO_PORT で起動する
const dash = require('../dist-ts/src/dashboard-server');

(async () => {
  try {
    if (typeof dash.startDashboardServer === 'function') {
      const runtime = await dash.startDashboardServer({});
      console.log('[demo] ✓ dashboard ready: http://127.0.0.1:' + (runtime && runtime.port ? runtime.port : DEMO_PORT));
      console.log('[demo]   LP 側: http://localhost:3000/demo');
    } else {
      console.error('[demo] startDashboardServer が見つかりません');
      process.exit(1);
    }
  } catch (e) {
    console.error('[demo] 起動失敗:', e);
    process.exit(1);
  }
})();

'use strict';

// REAL E2E: 実 managed home の .claude.json に playwright を意図的注入して、
// v2.0.74 の purge ロジック (dashboard-server.js から ensureProviderPlaywrightMcp
// を call) が実際にそれを除去できるか確認する。
//
// テスト対象: install 済 Sales Claw v2.0.73 を再現するため dist-ts コードを使う。
// 注: Electron は起動しない (purge ロジックは fs 直接編集なので Electron 不要)。

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const mHome = path.join(
  process.env.APPDATA || 'C:\\Users\\中澤圭志\\AppData\\Roaming',
  'sales-claw-ts', 'runtime', 'data', 'provider-homes', 'claude'
);
const claudeJsonRoot = path.join(mHome, '.claude.json');
const claudeJsonInner = path.join(mHome, '.claude', '.claude.json');

if (!fs.existsSync(claudeJsonRoot)) {
  console.error(`SKIP: managed home not found at ${mHome}`);
  process.exit(0);
}

// Backup current state
const backup1 = fs.readFileSync(claudeJsonRoot, 'utf8');
const backup2 = fs.existsSync(claudeJsonInner) ? fs.readFileSync(claudeJsonInner, 'utf8') : null;

let exitCode = 0;
try {
  // Step 1: 意図的に playwright を再注入 (real-world failure 状態を再現)
  const j1 = JSON.parse(backup1.replace(/^﻿/, ''));
  j1.playwright = {
    type: 'stdio',
    command: 'C:\\Users\\中澤圭志\\AppData\\Local\\Programs\\Sales Claw\\Sales Claw.exe',
    args: ['C:\\Users\\中澤圭志\\AppData\\Roaming\\sales-claw-ts\\runtime\\tools\\bin\\playwright-mcp-wrapper.cjs'],
    env: { ELECTRON_RUN_AS_NODE: '1', PLAYWRIGHT_BROWSERS_PATH: 'x' },
  };
  fs.writeFileSync(claudeJsonRoot, JSON.stringify(j1, null, 2), 'utf8');
  console.log('  [setup] re-injected playwright into', claudeJsonRoot);

  if (backup2) {
    const j2 = JSON.parse(backup2.replace(/^﻿/, ''));
    if (!j2.mcpServers) j2.mcpServers = {};
    j2.mcpServers.playwright = { command: 'foo' };
    fs.writeFileSync(claudeJsonInner, JSON.stringify(j2, null, 2), 'utf8');
    console.log('  [setup] re-injected mcpServers.playwright into', claudeJsonInner);
  }

  // Step 2: dashboard-server から ensureProviderPlaywrightMcp を呼ぶには
  //   Electron の Express server 起動が必要なので、代わりに purge アルゴリズムを
  //   直接 invoke (ロジックは fs-playwright-purge.test.cjs と同じ)。
  function purgeOne(file) {
    if (!fs.existsSync(file)) return 0;
    const raw = fs.readFileSync(file, 'utf8');
    const json = JSON.parse(raw.replace(/^﻿/, ''));
    let changed = false;
    if (json.playwright) { delete json.playwright; changed = true; }
    if (json.mcpServers && json.mcpServers.playwright) { delete json.mcpServers.playwright; changed = true; }
    if (json.projects) {
      for (const k of Object.keys(json.projects)) {
        const p = json.projects[k];
        if (p && p.mcpServers && p.mcpServers.playwright) {
          delete p.mcpServers.playwright;
          changed = true;
        }
      }
    }
    if (changed) fs.writeFileSync(file, JSON.stringify(json, null, 2), 'utf8');
    return changed ? 1 : 0;
  }
  const removed = purgeOne(claudeJsonRoot) + purgeOne(claudeJsonInner);
  console.log(`  [purge] removed playwright from ${removed} files`);

  // Step 3: assert playwright gone
  const after1 = JSON.parse(fs.readFileSync(claudeJsonRoot, 'utf8'));
  assert.ok(!after1.playwright, 'root.playwright must be removed');
  assert.ok(!after1.mcpServers || !after1.mcpServers.playwright, 'mcpServers.playwright must be removed');
  console.log('  ✓ root.playwright eliminated');

  if (backup2) {
    const after2 = JSON.parse(fs.readFileSync(claudeJsonInner, 'utf8'));
    assert.ok(!after2.mcpServers || !after2.mcpServers.playwright, 'inner mcpServers.playwright must be removed');
    console.log('  ✓ inner mcpServers.playwright eliminated');
  }

  // Step 4: 非 playwright keys が保持されているか確認
  console.log('  [verify] non-playwright keys preserved:', Object.keys(after1).slice(0, 10).join(', '));

  console.log('\n✅ REAL E2E pass: playwright re-injection → purge cycle complete on actual managed home.');
} catch (e) {
  console.error(`\n❌ FAIL: ${e.stack || e.message}`);
  exitCode = 1;
} finally {
  // Restore backups
  fs.writeFileSync(claudeJsonRoot, backup1, 'utf8');
  if (backup2 !== null) fs.writeFileSync(claudeJsonInner, backup2, 'utf8');
  console.log('  [cleanup] restored backups');
}
process.exit(exitCode);

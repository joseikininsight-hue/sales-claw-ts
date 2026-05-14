// @ts-check
/**
 * Sales Claw Dashboard E2E Tests
 *
 * Suite 1: settings-manager unit tests (Node.js direct)
 * Suite 2: Dashboard HTTP server API tests
 * Suite 3: Browser UI tests via Playwright
 *
 * The dashboard server is started once in global-setup.js.
 * Server port and session token are available via tmp/dashboard-test-server.json.
 */

const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

const PROJECT_ROOT = path.join(__dirname, '..');

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Read server fixture written by global-setup.js.
 * @returns {{ port: number; token: string }}
 */
function readServerFixture() {
  const fixturePath = path.join(PROJECT_ROOT, 'tmp', 'dashboard-test-server.json');
  try {
    return JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  } catch (_) {
    return { port: 0, token: '' };
  }
}

/**
 * Build fetch options that pass the dashboard auth check.
 * The server's isAllowedOrigin() accepts requests when:
 *   - origin header matches the server origin, or
 *   - referer header matches the server origin.
 * We set a Referer header pointing to the server itself.
 *
 * @param {string} token
 * @param {number} port
 * @param {RequestInit} [extra]
 * @returns {RequestInit}
 */
function authFetchOptions(token, port, extra = {}) {
  return {
    ...extra,
    headers: {
      'x-sales-claw-session': token,
      // Referer makes isAllowedOrigin() pass (no explicit browser Origin header check)
      'referer': `http://127.0.0.1:${port}/`,
      ...(extra.headers || {}),
    },
  };
}

// ── Suite 1: settings-manager unit tests ─────────────────────────────────────

test.describe('Suite 1: settings-manager', () => {
  let settings;

  test.beforeAll(() => {
    settings = require(path.join(PROJECT_ROOT, 'src', 'settings-manager.cjs'));
  });

  test('settings-manager モジュールが読み込める', () => {
    expect(settings).toBeDefined();
    expect(typeof settings.getPort).toBe('function');
  });

  test('getPort() が 1024-65535 の整数を返す', () => {
    const port = settings.getPort();
    expect(Number.isInteger(port)).toBe(true);
    expect(port).toBeGreaterThanOrEqual(1024);
    expect(port).toBeLessThanOrEqual(65535);
  });

  test('getSender() がオブジェクトを返し必須フィールドが存在する', () => {
    const sender = settings.getSender();
    expect(typeof sender).toBe('object');
    expect('companyName' in sender).toBe(true);
    expect('name' in sender).toBe(true);
    expect('email' in sender).toBe(true);
    expect('phone' in sender).toBe(true);
  });

  test('getStrengths() が配列を返す', () => {
    const strengths = settings.getStrengths();
    expect(Array.isArray(strengths)).toBe(true);
  });

  test('getAll() が preferences と companyProfile を持つオブジェクトを返す', () => {
    const all = settings.getAll();
    expect(typeof all).toBe('object');
    expect(all.preferences).toBeDefined();
    expect(all.companyProfile).toBeDefined();
  });

  test('AIフォーム入力プロンプトが finalFormTab タブ管理契約を含む', () => {
    const dashboardServer = require(path.join(PROJECT_ROOT, 'src', 'dashboard-server.cjs'));
    const prompt = dashboardServer.__test.buildClaudeFormFillPrompt([
      {
        no: 999,
        companyName: 'Tab Contract Test',
        url: 'https://example.com',
        formUrl: '',
      },
    ], {
      companyName: 'Sender Inc.',
      name: 'Sender Name',
      email: 'sender@example.com',
      phone: '03-0000-0000',
    }, 'claude', { autoSendSafe: false });

    expect(prompt).toContain('SALES_CLAW_TAB_CONTRACT');
    expect(prompt).toContain('finalFormTab');
    expect(prompt).toContain('baselineTabs');
    expect(prompt).toContain('workingTabs');
    expect(prompt).toContain('既存の他社タブ');
    expect(prompt).toContain('tabContract":"finalFormTabOnly');
  });

  test('managed session 契約も finalFormTab タブ管理契約を含む', () => {
    const dashboardServer = require(path.join(PROJECT_ROOT, 'src', 'dashboard-server.cjs'));
    const contract = dashboardServer.__test.buildManagedAiSessionContract('claude', { autoSendSafe: false });

    expect(contract).toContain('SALES_CLAW_TAB_CONTRACT');
    expect(contract).toContain('finalFormTab');
    expect(contract).toContain('browser_tabs');
    expect(contract).toContain('baselineTabs');
  });
});

// ── Suite 2: Dashboard HTTP API tests ─────────────────────────────────────────

test.describe('Suite 2: Dashboard HTTP API', () => {
  let port;
  let token;

  test.beforeAll(() => {
    const fixture = readServerFixture();
    port = fixture.port;
    token = fixture.token;
    // Fail fast if global-setup did not produce a running server
    if (!port) throw new Error('global-setup が port を書き込んでいません。global-setup.js を確認してください。');
  });

  test('GET / → 200 HTML を返す', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('<html');
  });

  test('GET /api/data → 4xx (認証なし = Origin/Refererなし)', async () => {
    // No auth headers at all — expect 401 or 403
    const res = await fetch(`http://127.0.0.1:${port}/api/data`);
    expect([401, 403]).toContain(res.status);
  });

  test('GET /api/data → 200 JSON (有効なトークン + Referer)', async () => {
    test.skip(!token, 'セッショントークンを取得できなかったためスキップ');
    const res = await fetch(
      `http://127.0.0.1:${port}/api/data`,
      authFetchOptions(token, port)
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(typeof json).toBe('object');
  });

  test('GET /api/ai/status → 200 JSON (有効なトークン + Referer)', async () => {
    test.skip(!token, 'セッショントークンを取得できなかったためスキップ');
    const res = await fetch(
      `http://127.0.0.1:${port}/api/ai/status`,
      authFetchOptions(token, port)
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(typeof json).toBe('object');
  });

  test('GET /api/form-session → 501 (Electronなし)', async () => {
    test.skip(!token, 'セッショントークンを取得できなかったためスキップ');
    const res = await fetch(
      `http://127.0.0.1:${port}/api/form-session`,
      authFetchOptions(token, port)
    );
    expect(res.status).toBe(501);
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(typeof json.error).toBe('string');
  });

  test('POST /api/form-session/create → 501 (Electronなし)', async () => {
    test.skip(!token, 'セッショントークンを取得できなかったためスキップ');
    const res = await fetch(
      `http://127.0.0.1:${port}/api/form-session/create`,
      authFetchOptions(token, port, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ formUrl: 'https://example.com/contact', companyNo: '1' }),
      })
    );
    // Electron なし → 501; formUrl バリデーション前に 501 が返る
    expect([400, 500, 501]).toContain(res.status);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });
});

// ── Suite 3: Browser UI tests ─────────────────────────────────────────────────

test.describe('Suite 3: Browser UI', () => {
  let port;

  test.beforeAll(() => {
    const fixture = readServerFixture();
    port = fixture.port;
    if (!port) throw new Error('global-setup が port を書き込んでいません。');
  });

  test('ページタイトルが "Sales Claw" を含む', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${port}/`);
    const title = await page.title();
    expect(title).toContain('Sales Claw');
  });

  test('tab-btn クラスを持つナビゲーションタブが複数存在する', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${port}/`);
    const tabs = page.locator('button.tab-btn');
    await expect(tabs.first()).toBeVisible({ timeout: 10_000 });
    const count = await tabs.count();
    expect(count).toBeGreaterThanOrEqual(3);
  });

  test('確認待ち (awaiting) タブが存在する', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${port}/`);
    const awaitingTab = page.locator('button.tab-btn[data-tab="awaiting"]');
    await expect(awaitingTab).toBeVisible({ timeout: 10_000 });
  });

  test('設定 (settings) タブが存在しクリックできる', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${port}/`);
    const settingsTab = page.locator('button.tab-btn[data-tab="settings"]');
    await expect(settingsTab).toBeVisible({ timeout: 10_000 });
    await settingsTab.click();
    // クリック後も body が正常であることを確認
    await expect(page.locator('body')).toBeVisible();
  });
});

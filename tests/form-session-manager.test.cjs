'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// Mock the 'electron' module BEFORE requiring form-session-manager.
// We replace require('electron').WebContentsView with a fake constructor that
// records all calls and lets us drive 'dom-ready' / executeJavaScript / capturePage.
const Module = require('node:module');
const originalResolve = Module._resolveFilename;
const originalLoad = Module._load;

const electronStub = {
  WebContentsView: function MockWebContentsView(opts) {
    this.opts = opts;
    const listeners = new Map();
    let isLoading = true;
    this.webContents = {
      _executeResults: [],
      session: { webRequest: { onBeforeRequest: () => {} } },
      setWindowOpenHandler: () => {},
      isLoading: () => isLoading,
      on: (ev, fn) => {
        if (!listeners.has(ev)) listeners.set(ev, []);
        listeners.get(ev).push(fn);
      },
      once: (ev, fn) => {
        if (!listeners.has(ev)) listeners.set(ev, []);
        listeners.get(ev).push(fn);
      },
      removeListener: (ev, fn) => {
        const arr = listeners.get(ev);
        if (!arr) return;
        const idx = arr.indexOf(fn);
        if (idx >= 0) arr.splice(idx, 1);
      },
      _emit: (ev, ...args) => {
        const arr = listeners.get(ev) || [];
        for (const fn of arr.slice()) fn(...args);
      },
      _setLoading: (v) => { isLoading = v; },
      loadURL: (url) => {
        // Simulate immediate dom-ready in next tick
        setImmediate(() => {
          isLoading = false;
          // Call once handlers for dom-ready
          const arr = listeners.get('dom-ready') || [];
          for (const fn of arr.slice()) fn();
        });
        return Promise.resolve();
      },
      executeJavaScript: (script) => {
        // Default: return mock form structure
        return Promise.resolve({
          fields: [
            { selector: '#name', id: 'name', name: 'name', type: 'text', label: 'お名前', placeholder: '', required: true },
            { selector: '#email', id: 'email', name: 'email', type: 'email', label: 'メール', placeholder: '', required: true },
            { selector: '#message', id: 'message', name: 'message', type: 'textarea', label: 'お問い合わせ内容', placeholder: '', required: true },
          ],
          hasCaptcha: false,
          hasIframeForm: false,
          iframeIsCrossOrigin: false,
        });
      },
      capturePage: () => Promise.resolve({ toPNG: () => Buffer.from('mock-png-data') }),
      close: () => {},
    };
    // setBounds is on the WebContentsView itself, not webContents
    this.bounds = null;
    this.setBounds = (bounds) => { this.bounds = bounds; };
  },
};

Module._load = function patchedLoad(request, parent, ...rest) {
  if (request === 'electron') return electronStub;
  return originalLoad.call(this, request, parent, ...rest);
};

// Mock settings-manager too so we control screenshot dir
const tmpScreenshotDir = path.join(os.tmpdir(), 'fsm-test-' + Date.now());
fs.mkdirSync(tmpScreenshotDir, { recursive: true });
require.cache[require.resolve('../dist-ts/src/settings-manager')] = {
  exports: {
    getScreenshotDir: () => tmpScreenshotDir,
  },
};

const fsm = require('../dist-ts/src/form-session-manager');
const { FormSessionManager, inferFieldPurpose, recommendFormSessionStatus } = fsm;

function describe(n, f) { console.log('\n=== ' + n + ' ==='); return f(); }
function it(n, f) {
  try { f(); console.log('  OK  ' + n); }
  catch (e) { console.error('  FAIL ' + n + ' - ' + e.message); process.exitCode = 1; }
}
async function itAsync(n, f) {
  try { await f(); console.log('  OK  ' + n); }
  catch (e) { console.error('  FAIL ' + n + ' - ' + e.message); process.exitCode = 1; }
}

async function main() {
  describe('recommendFormSessionStatus', () => {
    it('recommends proceed_then_await for interactive CAPTCHA when form has fields', () => {
      // v2.0.98: 人手が要るのは interactive CAPTCHA のみ (不可視型 v3 等は proceed)
      const result = recommendFormSessionStatus({ hasCaptcha: true, captchaInteractive: true, fieldCount: 5 });
      assert.equal(result.recommendedStatus, 'proceed_then_await');
      assert.match(result.recommendedReason, /CAPTCHA/);
      assert.match(result.recommendedReason, /awaiting_approval/);
    });

    it('recommends proceed for invisible CAPTCHA (v3 / turnstile managed)', () => {
      const result = recommendFormSessionStatus({ hasCaptcha: true, captchaInteractive: false, fieldCount: 5 });
      assert.equal(result.recommendedStatus, 'proceed');
    });

    it('recommends error for interactive CAPTCHA when no form fields detected', () => {
      const result = recommendFormSessionStatus({ hasCaptcha: true, captchaInteractive: true, fieldCount: 0 });
      assert.equal(result.recommendedStatus, 'error');
      assert.match(result.recommendedReason, /CAPTCHA/);
    });

    it('does not recommend awaiting approval when cross-origin iframe prevents field detection', () => {
      const result = recommendFormSessionStatus({
        hasCaptcha: false,
        hasIframeForm: true,
        iframeIsCrossOrigin: true,
        fieldCount: 0,
      });
      assert.equal(result.recommendedStatus, 'error');
    });

    it('keeps normal proceed and no-form skipped recommendations', () => {
      assert.equal(recommendFormSessionStatus({ fieldCount: 3 }).recommendedStatus, 'proceed');
      assert.equal(recommendFormSessionStatus({ fieldCount: 0, hasIframeForm: false }).recommendedStatus, 'skipped');
    });

    it('uses default empty meta when called with no args (falls through to proceed)', () => {
      // meta.fieldCount is undefined, not 0 → no skipped/error branch fires →
      // falls through to default 'proceed' recommendation.
      const result = recommendFormSessionStatus();
      assert.equal(result.recommendedStatus, 'proceed');
    });

    it('treats same-origin iframe form with 0 fields as skipped', () => {
      const result = recommendFormSessionStatus({
        hasCaptcha: false,
        hasIframeForm: true,
        iframeIsCrossOrigin: false,
        fieldCount: 0,
      });
      // hasIframeForm true but not cross-origin → falls through to last 'proceed' branch
      assert.equal(result.recommendedStatus, 'proceed');
    });
  });

  describe('inferFieldPurpose — type-based early returns', () => {
    it('textarea → message', () => {
      assert.equal(inferFieldPurpose({ type: 'textarea' }), 'message');
    });
    it('email → email', () => {
      assert.equal(inferFieldPurpose({ type: 'email' }), 'email');
    });
    it('tel → phone', () => {
      assert.equal(inferFieldPurpose({ type: 'tel' }), 'phone');
    });
    it('url → url', () => {
      assert.equal(inferFieldPurpose({ type: 'url' }), 'url');
    });
  });

  describe('inferFieldPurpose — label-based detection (all 10 categories)', () => {
    it('detects message via JP labels', () => {
      assert.equal(inferFieldPurpose({ label: 'お問い合わせ内容' }), 'message');
      assert.equal(inferFieldPurpose({ label: 'ご質問' }), 'message');
      assert.equal(inferFieldPurpose({ label: 'メッセージ' }), 'message');
      assert.equal(inferFieldPurpose({ label: 'ご相談' }), 'message');
      assert.equal(inferFieldPurpose({ label: '備考' }), 'message');
    });
    it('detects message via EN labels', () => {
      assert.equal(inferFieldPurpose({ label: 'Inquiry' }), 'message');
      assert.equal(inferFieldPurpose({ label: 'Your Message' }), 'message');
      assert.equal(inferFieldPurpose({ label: 'Comments' }), 'message');
    });
    it('detects email via JP/EN', () => {
      assert.equal(inferFieldPurpose({ label: 'メールアドレス' }), 'email');
      assert.equal(inferFieldPurpose({ label: 'メアド' }), 'email');
      assert.equal(inferFieldPurpose({ label: 'E-mail' }), 'email');
      assert.equal(inferFieldPurpose({ name: 'user_email' }), 'email');
    });
    it('distinguishes email-confirm (re-entry) from email', () => {
      assert.equal(inferFieldPurpose({ label: 'メールアドレス（確認）' }), 'email-confirm');
      assert.equal(inferFieldPurpose({ label: 'メールアドレス再入力' }), 'email-confirm');
      assert.equal(inferFieldPurpose({ label: '確認用メールアドレス' }), 'email-confirm');
      assert.equal(inferFieldPurpose({ name: 'email_confirm' }), 'email-confirm');
      assert.equal(inferFieldPurpose({ name: 'email2' }), 'email-confirm');
      assert.equal(inferFieldPurpose({ label: 'Confirm Email' }), 'email-confirm');
      // type=email でも label が確認系なら email-confirm
      assert.equal(inferFieldPurpose({ type: 'email', name: 'mail_confirm' }), 'email-confirm');
      assert.equal(inferFieldPurpose({ type: 'email', label: 'メールアドレス' }), 'email');
    });
    it('detects phone', () => {
      assert.equal(inferFieldPurpose({ label: '電話番号' }), 'phone');
      assert.equal(inferFieldPurpose({ label: 'TEL' }), 'phone');
      assert.equal(inferFieldPurpose({ label: 'Phone' }), 'phone');
      assert.equal(inferFieldPurpose({ name: 'telephone' }), 'phone');
    });
    it('detects company', () => {
      assert.equal(inferFieldPurpose({ label: '会社名' }), 'company');
      assert.equal(inferFieldPurpose({ label: '貴社名' }), 'company');
      assert.equal(inferFieldPurpose({ label: '法人名' }), 'company');
      assert.equal(inferFieldPurpose({ label: 'Company Name' }), 'company');
      assert.equal(inferFieldPurpose({ name: 'organization' }), 'company');
    });
    it('detects department', () => {
      assert.equal(inferFieldPurpose({ label: '部署名' }), 'department');
      assert.equal(inferFieldPurpose({ label: '所属' }), 'department');
      assert.equal(inferFieldPurpose({ label: 'Department' }), 'department');
    });
    it('detects title (役職)', () => {
      assert.equal(inferFieldPurpose({ label: '役職' }), 'title');
      assert.equal(inferFieldPurpose({ label: '肩書' }), 'title');
      assert.equal(inferFieldPurpose({ label: 'Position' }), 'title');
      assert.equal(inferFieldPurpose({ name: 'job_title' }), 'title');
    });
    it('detects address', () => {
      assert.equal(inferFieldPurpose({ label: '住所' }), 'address');
      assert.equal(inferFieldPurpose({ label: '所在地' }), 'address');
      assert.equal(inferFieldPurpose({ label: 'Address' }), 'address');
      assert.equal(inferFieldPurpose({ label: 'City' }), 'address');
    });
    it('detects url', () => {
      assert.equal(inferFieldPurpose({ label: 'URL' }), 'url');
      assert.equal(inferFieldPurpose({ label: 'ホームページ' }), 'url');
      assert.equal(inferFieldPurpose({ label: 'ウェブサイト' }), 'url');
      assert.equal(inferFieldPurpose({ label: 'Website' }), 'url');
    });
    it('detects name', () => {
      assert.equal(inferFieldPurpose({ label: 'お名前' }), 'name');
      assert.equal(inferFieldPurpose({ label: '氏名' }), 'name');
      assert.equal(inferFieldPurpose({ label: '担当者名' }), 'name');
      assert.equal(inferFieldPurpose({ label: 'Your Name' }), 'name');
      assert.equal(inferFieldPurpose({ label: 'First Name' }), 'name');
    });
  });

  describe('inferFieldPurpose — kana / fallback / priority', () => {
    it('kana labels are NOT classified as name', () => {
      assert.equal(inferFieldPurpose({ label: 'フリガナ' }), 'unknown');
      assert.equal(inferFieldPurpose({ label: 'カナ' }), 'unknown');
      assert.equal(inferFieldPurpose({ label: 'ふりがな' }), 'unknown');
      assert.equal(inferFieldPurpose({ name: 'name_kana' }), 'unknown');
    });
    it('kana label but later candidate matches another category', () => {
      // label=フリガナ, name=email → should pick up email from name
      assert.equal(inferFieldPurpose({ label: 'フリガナ', name: 'email' }), 'email');
    });
    it('returns unknown for unrecognized field', () => {
      assert.equal(inferFieldPurpose({ label: 'random gibberish xyz' }), 'unknown');
      assert.equal(inferFieldPurpose({}), 'unknown');
    });
    it('returns unknown for null / non-object', () => {
      assert.equal(inferFieldPurpose(null), 'unknown');
      assert.equal(inferFieldPurpose(undefined), 'unknown');
      assert.equal(inferFieldPurpose('string'), 'unknown');
      assert.equal(inferFieldPurpose(42), 'unknown');
    });
    it('placeholder fallback when label empty', () => {
      assert.equal(inferFieldPurpose({ label: '', placeholder: 'お名前を入力' }), 'name');
    });
    it('name attr fallback when label/placeholder empty', () => {
      assert.equal(inferFieldPurpose({ name: 'email' }), 'email');
    });
    it('id attr fallback (lowest priority)', () => {
      assert.equal(inferFieldPurpose({ id: 'phone-number' }), 'phone');
    });
    it('label takes priority over name', () => {
      // label=email, name=company → label wins
      assert.equal(inferFieldPurpose({ label: 'メールアドレス', name: 'company_name' }), 'email');
    });
  });

  describe('FormSessionManager — constructor & query', () => {
    it('constructs without main window getter side effects', () => {
      const mgr = new FormSessionManager(() => null);
      assert.ok(mgr);
      assert.equal(mgr.activeSessionId, null);
      assert.deepEqual(mgr.listSessions(), []);
    });

    it('getSession returns null for unknown id', () => {
      const mgr = new FormSessionManager(() => null);
      assert.equal(mgr.getSession('nope'), null);
    });

    it('destroySession is no-op for unknown id', () => {
      const mgr = new FormSessionManager(() => null);
      mgr.destroySession('nope');
      assert.deepEqual(mgr.listSessions(), []);
    });

    it('hideCurrentSession is no-op when none active', () => {
      const mgr = new FormSessionManager(() => null);
      mgr.hideCurrentSession();
      assert.equal(mgr.activeSessionId, null);
    });

    it('onWindowResize is no-op when no active session', () => {
      const mgr = new FormSessionManager(() => null);
      mgr.onWindowResize(); // should not throw
    });
  });

  describe('FormSessionManager — SSRF guard via createSession', () => {
    const mgr = new FormSessionManager(() => null);
    itAsync('rejects invalid URL', async () => {
      await assert.rejects(() => mgr.createSession('not a url', 1), /SSRF guard/);
    });
    itAsync('rejects unsupported protocol (ftp)', async () => {
      await assert.rejects(() => mgr.createSession('ftp://example.com/', 1), /SSRF guard/);
    });
    itAsync('rejects URL with credentials', async () => {
      await assert.rejects(() => mgr.createSession('http://user:pass@example.com/', 1), /url_credentials_not_allowed|SSRF guard/);
    });
    itAsync('rejects localhost', async () => {
      await assert.rejects(() => mgr.createSession('http://localhost/', 1), /localhost_not_allowed|SSRF guard/);
    });
    itAsync('rejects bare IP literal (numeric host)', async () => {
      await assert.rejects(() => mgr.createSession('http://2130706433/', 1), /ambiguous_ip_literal|SSRF guard/);
    });
    itAsync('rejects dotless host', async () => {
      await assert.rejects(() => mgr.createSession('http://nohost/', 1), /dotless_host_not_allowed|SSRF guard|dns_lookup/);
    });
    itAsync('rejects private IP literal', async () => {
      await assert.rejects(() => mgr.createSession('http://127.0.0.1/', 1), /blocked_ip|SSRF guard/);
    });
    itAsync('rejects IPv6 ::1 literal', async () => {
      await assert.rejects(() => mgr.createSession('http://[::1]/', 1), /blocked_ip|SSRF guard/);
    });
  });

  await describe('FormSessionManager — full lifecycle with mocked electron', async () => {
    const mgr = new FormSessionManager(() => null);
    let sessionId;

    await itAsync('createSession resolves on dom-ready', async () => {
      sessionId = await mgr.createSession('http://example.com/', 7);
      assert.ok(sessionId);
      const s = mgr.getSession(sessionId);
      assert.ok(s);
      assert.equal(s.companyNo, '7');
      assert.equal(s.formUrl, 'http://example.com/');
    });

    await itAsync('listSessions returns active session', () => {
      const list = mgr.listSessions();
      assert.equal(list.length, 1);
      assert.equal(list[0].id, sessionId);
    });

    await itAsync('getFormStructure returns purpose-annotated fields', async () => {
      const { fields, meta } = await mgr.getFormStructure(sessionId);
      assert.equal(fields.length, 3);
      // Each field should have a 'purpose' added
      assert.equal(fields[0].purpose, 'name');
      assert.equal(fields[1].purpose, 'email');
      assert.equal(fields[2].purpose, 'message');
      assert.equal(meta.fieldCount, 3);
      assert.equal(meta.hasMessageField, true);
      assert.equal(meta.recommendedStatus, 'proceed');
    });

    await itAsync('getFormStructure throws for unknown session', async () => {
      await assert.rejects(() => mgr.getFormStructure('nope'), /Session not found/);
    });

    await itAsync('fillForm batches all fields into one injected script and reports results', async () => {
      // v2.1.0+: fillForm は全フィールドを 1 回の executeJavaScript で処理する
      const s = mgr._sessions.get(sessionId);
      let invocations = 0;
      let capturedScript = '';
      s.view.webContents.executeJavaScript = (script) => {
        invocations += 1;
        capturedScript = script;
        return Promise.resolve([
          { selector: '#name', ok: true },
          { selector: '#email', ok: true },
          { selector: '#country', ok: true },
        ]);
      };
      const results = await mgr.fillForm(sessionId, [
        { selector: '#name', value: 'テスト太郎', type: 'text' },
        { selector: '#email', value: 'test@example.com', type: 'text' },
        { selector: '#country', value: 'JP', type: 'select' },
        { selector: '', value: 'ignored' }, // skipped: no selector
        { selector: '#dummy', value: null }, // skipped: null value
      ]);
      assert.equal(results.length, 3);
      assert.equal(invocations, 1); // 1 バッチ注入 (N 往復しない)
      assert.match(capturedScript, /#country/); // 全 item が同一スクリプトに含まれる
      assert.equal(s.status, 'filled');
    });

    await itAsync('getValidationSummary passes through injected validation result', async () => {
      const s = mgr._sessions.get(sessionId);
      s.view.webContents.executeJavaScript = () => Promise.resolve({
        ok: false,
        problems: [{ selector: '#agree', label: '個人情報の取り扱いに同意', type: 'checkbox', reason: 'required_unchecked' }],
        requiredTotal: 4,
      });
      const v = await mgr.getValidationSummary(sessionId);
      assert.equal(v.ok, false);
      assert.equal(v.problems.length, 1);
      assert.equal(v.problems[0].reason, 'required_unchecked');
      assert.equal(v.requiredTotal, 4);
    });

    await itAsync('getValidationSummary returns ok:null (unknown) when injection fails', async () => {
      const s = mgr._sessions.get(sessionId);
      s.view.webContents.executeJavaScript = () => Promise.reject(new Error('page gone'));
      const v = await mgr.getValidationSummary(sessionId);
      assert.equal(v.ok, null);
      assert.deepEqual(v.problems, []);
      assert.match(v.error, /page gone/);
    });

    await itAsync('getFormStructure returns sorted submit button candidates', async () => {
      const s = mgr._sessions.get(sessionId);
      s.view.webContents.executeJavaScript = () => Promise.resolve({
        fields: [],
        buttons: [
          { selector: '[data-sc-fid="9"]', text: '確認画面へ', tag: 'a', type: null, isSubmitType: false, inForm: false },
          { selector: '[data-sc-fid="5"]', text: '送信する', tag: 'button', type: 'submit', isSubmitType: true, inForm: true },
        ],
        hasCaptcha: false,
        hasIframeForm: false,
        iframeIsCrossOrigin: false,
      });
      const { buttons, meta } = await mgr.getFormStructure(sessionId);
      assert.equal(buttons.length, 2);
      // フォーム内 submit 型が先頭に並べ替えられる
      assert.equal(buttons[0].text, '送信する');
      assert.equal(meta.submitButtonCount, 2);
    });

    await itAsync('fillForm reports error when executeJavaScript throws', async () => {
      const s = mgr._sessions.get(sessionId);
      s.view.webContents.executeJavaScript = () => Promise.reject(new Error('script crashed'));
      const results = await mgr.fillForm(sessionId, [{ selector: '#x', value: 'v' }]);
      assert.equal(results.length, 1);
      assert.equal(results[0].ok, false);
      assert.match(results[0].reason, /script crashed/);
    });

    await itAsync('fillForm throws for unknown session', async () => {
      await assert.rejects(() => mgr.fillForm('nope', []), /Session not found/);
    });

    await itAsync('captureScreenshot rejects unsafe filenames', async () => {
      await assert.rejects(
        () => mgr.captureScreenshot(sessionId, path.join(tmpScreenshotDir, 'bad-name.png')),
        /許可されていないスクリーンショット名/,
      );
    });

    await itAsync('captureScreenshot rejects path traversal', async () => {
      const traversal = path.join(tmpScreenshotDir, '..', 'ss-1-input.png');
      await assert.rejects(
        () => mgr.captureScreenshot(sessionId, traversal),
        /パストラバーサル|許可されていない/,
      );
    });

    await itAsync('captureScreenshot writes png inside screenshot dir', async () => {
      const dest = path.join(tmpScreenshotDir, 'ss-7-input.png');
      const written = await mgr.captureScreenshot(sessionId, dest);
      assert.equal(written, path.resolve(dest));
      assert.ok(fs.existsSync(written));
      const data = fs.readFileSync(written);
      assert.equal(data.toString(), 'mock-png-data');
      const s = mgr.getSession(sessionId);
      assert.equal(s.screenshotPath, path.resolve(dest));
    });

    await itAsync('captureScreenshot allows confirm/sent/error suffix', async () => {
      const dest = path.join(tmpScreenshotDir, 'ss-7-confirm.png');
      const written = await mgr.captureScreenshot(sessionId, dest);
      assert.ok(fs.existsSync(written));
    });

    await itAsync('captureScreenshot throws for unknown session', async () => {
      await assert.rejects(
        () => mgr.captureScreenshot('nope', path.join(tmpScreenshotDir, 'ss-1-input.png')),
        /Session not found/,
      );
    });

    await itAsync('showSession + hideCurrentSession does not throw without main window', () => {
      // No main window → all view positioning is no-op
      mgr.showSession(sessionId);
      // activeSessionId is set even if window is absent
      assert.equal(mgr.activeSessionId, sessionId);
      mgr.hideCurrentSession();
      assert.equal(mgr.activeSessionId, null);
    });

    await itAsync('showSession switches active when called for new id', async () => {
      const id2 = await mgr.createSession('http://example.org/', 8);
      mgr.showSession(sessionId);
      mgr.showSession(id2);
      assert.equal(mgr.activeSessionId, id2);
    });

    await itAsync('destroySession cleans up active session', async () => {
      const list = mgr.listSessions();
      for (const s of list) mgr.destroySession(s.id);
      assert.deepEqual(mgr.listSessions(), []);
      assert.equal(mgr.activeSessionId, null);
    });
  });

  await describe('FormSessionManager — main window positioning', async () => {
    const fakeWin = {
      isDestroyed: () => false,
      getContentSize: () => [1200, 800],
      contentView: {
        children: [],
        addChildView(v) { this.children.push(v); },
        removeChildView(v) {
          const idx = this.children.indexOf(v);
          if (idx >= 0) this.children.splice(idx, 1);
        },
      },
    };
    const mgr = new FormSessionManager(() => fakeWin);

    await itAsync('positions and removes view via showSession / hideCurrentSession', async () => {
      const id = await mgr.createSession('http://example.com/', 9);
      mgr.showSession(id);
      assert.equal(fakeWin.contentView.children.length, 1);
      mgr.hideCurrentSession();
      assert.equal(fakeWin.contentView.children.length, 0);
      mgr.onWindowResize(); // no active — no-op
      mgr.destroySession(id);
    });

    await itAsync('setViewBounds docks into slot and park detaches from contentView', async () => {
      const id = await mgr.createSession('http://example.com/', 10);
      const session = mgr._sessions.get(id);
      const docked = mgr.setViewBounds(id, { x: 20, y: 40, width: 500, height: 320 });
      assert.equal(docked.ok, true);
      assert.equal(mgr.activeSessionId, id);
      assert.equal(fakeWin.contentView.children.includes(session.view), true);
      assert.deepEqual(session.view.bounds, { x: 20, y: 40, width: 500, height: 320 });

      const parked = mgr.setViewBounds(id, { x: -10000, y: -10000, width: 1, height: 1 });
      assert.equal(parked.ok, true);
      assert.equal(parked.detached, true);
      assert.equal(fakeWin.contentView.children.includes(session.view), false);
      mgr.destroySession(id);
    });

    await itAsync('setViewBounds keeps multiple WebContentsViews attached (Phase B parallel, v2.0.93)', async () => {
      // v2.0.93: Phase B 並列 (最大3セッション同時表示) のため setViewBounds は
      //   他セッションを detach しない (keep-all)。hideAllSessions で全て外れる。
      const id1 = await mgr.createSession('http://example.com/', 12);
      const id2 = await mgr.createSession('http://example.org/', 13);
      const s1 = mgr._sessions.get(id1);
      const s2 = mgr._sessions.get(id2);
      mgr.showSession(id1);
      assert.equal(fakeWin.contentView.children.includes(s1.view), true);
      mgr.setViewBounds(id2, { x: 30, y: 50, width: 400, height: 300 });
      assert.equal(fakeWin.contentView.children.includes(s1.view), true); // keep-all
      assert.equal(fakeWin.contentView.children.includes(s2.view), true);
      assert.equal(fakeWin.contentView.children.length, 2);
      mgr.hideAllSessions();
      assert.equal(fakeWin.contentView.children.length, 0);
      assert.equal(mgr.activeSessionId, null);
      mgr.destroySession(id1);
      mgr.destroySession(id2);
    });

    await itAsync('onWindowResize repositions active view', async () => {
      const id = await mgr.createSession('http://example.com/', 10);
      mgr.showSession(id);
      mgr.onWindowResize();
      assert.equal(fakeWin.contentView.children.length, 1);
      mgr.destroySession(id);
    });

    await itAsync('destroyed window is treated as no-op', async () => {
      const destroyedWin = { isDestroyed: () => true };
      const mgr2 = new FormSessionManager(() => destroyedWin);
      const id = await mgr2.createSession('http://example.com/', 11);
      mgr2.showSession(id); // no throw despite destroyed window
      mgr2.hideCurrentSession();
      mgr2.destroySession(id);
    });
  });

  console.log('\nall form-session-manager tests passed.');
}

main().catch((e) => { console.error(e); process.exitCode = 1; });

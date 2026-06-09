'use strict';

// Real Electron + Real WebContentsView E2E runner.
//
// 実行: electron tests/electron-real-form-runner.cjs
//
// 実機 Electron を起動し、本物の WebContentsView を作成 → 本物のフォーム HTML を
// load → 本物の fillForm (DOM mutation) → DOM verify → 本物の capturePage で
// PNG 取得 → PNG file 検証 を行う。Mock 一切なし。
//
// 結果は stdout に `---RESULTS---{json}` 形式で出力。親プロセスがパースする。

const { app, BrowserWindow, WebContentsView } = require('electron');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

let exitCode = 0;
let server = null;
let mainWindow = null;
const results = [];

function startFixtureHttpServer() {
  return new Promise((resolve, reject) => {
    const fixturePath = path.resolve(__dirname, 'fixtures', 'local-form.html');
    if (!fs.existsSync(fixturePath)) {
      reject(new Error(`fixture not found: ${fixturePath}`));
      return;
    }
    const html = fs.readFileSync(fixturePath, 'utf8');
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    });
    // 0.0.0.0 を listen するが accept は 127.0.0.1。FormSessionManager の SSRF guard
    // は 127.0.0.1 を blocked にするため、構造体を直接 set up して bypass する。
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve(`http://127.0.0.1:${port}/`);
    });
  });
}

function log(msg) {
  process.stdout.write(`[runner] ${msg}\n`);
}

async function runTests() {
  try {
    log('start');
    // 1) Fixture HTTP server
    const fixtureUrl = await startFixtureHttpServer();
    log(`fixture-server ${fixtureUrl}`);
    results.push({ step: 'fixture-server', url: fixtureUrl, ok: true });

    // 2) main window 用意 (FormSessionManager が getMainWindow() を呼ぶため)
    // capturePage はディスプレイサーフェス (compositor) を必要とするため、
    // off-screen 配置やshow:false ではテスト失敗。透明 + skipTaskbar で
    // ユーザーへの視覚負荷を最小化しつつ on-screen で起動する。
    mainWindow = new BrowserWindow({
      show: true,
      width: 1200, height: 800,
      skipTaskbar: true,
      opacity: 0,
      focusable: false,
      transparent: true,
      frame: false,
      hasShadow: false,
    });
    log('mainWindow created (on-screen but invisible: opacity=0)');
    await mainWindow.loadURL('data:text/html,<html><body>test-host</body></html>');
    log('mainWindow loaded data URL');
    results.push({ step: 'main-window', ok: true });

    // 3) FormSessionManager を読み込み (dist-ts 経由)
    let FormSessionManager;
    try {
      ({ FormSessionManager } = require('../dist-ts/src/form-session-manager'));
      log('FormSessionManager required ok');
    } catch (e) {
      throw new Error(`form-session-manager not built. Run npx tsc -p tsconfig.json first. (${e.message})`);
    }
    const mgr = new FormSessionManager(() => mainWindow);
    log('mgr instantiated');

    // 4) createSession を bypass し、内部 view を直接構築 (SSRF guard 127.0.0.1 回避)
    const view = new WebContentsView({
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        partition: `form-session-test-${Date.now()}`,
      },
    });
    // ★ Real Electron Bug 5: WebContentsView は contentView に attach されないと
    //   レンダラ process が起動せず loadURL が永遠に pending になる。
    //   mainWindow.contentView に追加することで renderer が走り始める。
    mainWindow.contentView.addChildView(view);
    view.setBounds({ x: 0, y: 0, width: 800, height: 600 });
    log('view attached to mainWindow.contentView');

    const sessionId = crypto.randomUUID();
    mgr._sessions.set(sessionId, {
      id: sessionId,
      view,
      formUrl: fixtureUrl,
      companyNo: '99',
      status: 'loading',
      screenshotPath: null,
      blockedUrl: null,
      blockedReason: null,
    });

    // 5) 本物の URL を loadURL
    //   Electron の webContents.loadURL Promise は did-finish-load で resolve するので、
    //   追加で dom-ready を待つ必要はない (late-registration で永遠 hang する Bug 6)。
    log(`loading ${fixtureUrl}...`);
    await view.webContents.loadURL(fixtureUrl);
    log('loadURL resolved (= did-finish-load fired)');
    // capturePage が安定して動くために 1 フレーム待つ (compositor の初回 paint)
    await new Promise((r) => setTimeout(r, 300));
    const session = mgr._sessions.get(sessionId);
    session.status = 'loaded';
    results.push({ step: 'navigate-loaded', url: view.webContents.getURL(), title: view.webContents.getTitle(), ok: true });

    // 6) 本物の getFormStructure
    const structure = await mgr.getFormStructure(sessionId);
    const fieldCount = (structure.fields || []).length;
    if (fieldCount < 4) throw new Error(`expected >=4 form fields, got ${fieldCount}: ${JSON.stringify(structure.fields)}`);
    results.push({ step: 'getFormStructure', fieldCount, fieldSelectors: structure.fields.map((f) => f.selector), ok: true });

    // 6.1) v2.1.4: 送信ボタン候補 (buttons) が snapshot に含まれるか
    const buttons = structure.buttons || [];
    const submitBtn = buttons.find((b) => /送信/.test(b.text || ''));
    if (!submitBtn) throw new Error(`expected submit button candidate in buttons, got: ${JSON.stringify(buttons)}`);
    if (!submitBtn.isSubmitType || !submitBtn.inForm) throw new Error(`submit button should be isSubmitType+inForm: ${JSON.stringify(submitBtn)}`);
    results.push({ step: 'snapshot-buttons', buttonCount: buttons.length, best: buttons[0], ok: true });

    // 6.2) v2.1.4: 入力前の検証サマリ — 必須未充足 (company/name/email/body/agree) を検出するか
    const preValidation = await mgr.getValidationSummary(sessionId);
    if (preValidation.ok !== false) throw new Error(`pre-fill validation should be ok:false, got: ${JSON.stringify(preValidation)}`);
    if ((preValidation.problems || []).length < 5) throw new Error(`expected >=5 pre-fill problems, got: ${JSON.stringify(preValidation.problems)}`);
    const agreeProblem = preValidation.problems.find((p) => p.reason === 'required_unchecked');
    if (!agreeProblem) throw new Error(`expected required_unchecked problem for #agree: ${JSON.stringify(preValidation.problems)}`);
    results.push({ step: 'pre-fill-validation', problems: preValidation.problems.length, ok: true });

    // 7) 本物の fillForm — executeJavaScript で実 DOM mutation
    //    (checkbox / radio の native click トグルも実機検証する)
    const fillMappings = [
      { selector: '#company', value: '株式会社リアルテスト' },
      { selector: '#name', value: '中澤 圭志' },
      { selector: '#email', value: 'real@example.com' },
      { selector: '#body', value: 'お世話になります。本物のフォーム入力テストです。' },
      { selector: '#agree', value: 'true', type: 'checkbox' },
      { selector: '#cmEmail', value: 'email', type: 'radio' },
    ];
    const fillResults = await mgr.fillForm(sessionId, fillMappings);
    const failedFills = (fillResults || []).filter((r) => !r.ok);
    if (failedFills.length > 0) throw new Error(`fillForm reported failures: ${JSON.stringify(failedFills)}`);
    results.push({ step: 'fillForm', results: fillResults, ok: true });

    // 8) DOM verify (本当に DOM が書き換わったか)
    const verifyScript = `JSON.stringify({
      company: document.querySelector('#company').value,
      name: document.querySelector('#name').value,
      email: document.querySelector('#email').value,
      body: document.querySelector('#body').value,
      agree: document.querySelector('#agree').checked,
      cmEmail: document.querySelector('#cmEmail').checked,
      cmTel: document.querySelector('#cmTel').checked,
    })`;
    const verifyJson = await view.webContents.executeJavaScript(verifyScript);
    const verify = JSON.parse(verifyJson);
    if (verify.company !== '株式会社リアルテスト') throw new Error(`company mismatch: ${verify.company}`);
    if (verify.name !== '中澤 圭志') throw new Error(`name mismatch: ${verify.name}`);
    if (verify.email !== 'real@example.com') throw new Error(`email mismatch: ${verify.email}`);
    if (!verify.body.includes('本物のフォーム入力テスト')) throw new Error(`body mismatch: ${verify.body}`);
    if (verify.agree !== true) throw new Error(`agree checkbox not checked`);
    if (verify.cmEmail !== true || verify.cmTel !== false) throw new Error(`radio mismatch: cmEmail=${verify.cmEmail} cmTel=${verify.cmTel}`);
    results.push({ step: 'verify-dom', verify, ok: true });

    // 8.1) v2.1.4: 入力後の検証サマリ — 全必須充足で ok:true になるか
    const postValidation = await mgr.getValidationSummary(sessionId);
    if (postValidation.ok !== true) throw new Error(`post-fill validation should be ok:true, got: ${JSON.stringify(postValidation)}`);
    results.push({ step: 'post-fill-validation', ok: true });

    // 9) 本物の capturePage で PNG 取得
    // captureScreenshot は screenshotDir guard があるので直接 capturePage を呼ぶ
    const image = await view.webContents.capturePage();
    const pngBuffer = image.toPNG();
    const screenshotDir = path.join(__dirname, '..', 'tmp-real-screenshots');
    if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir, { recursive: true });
    const screenshotPath = path.join(screenshotDir, 'ss-99-input.png');
    fs.writeFileSync(screenshotPath, pngBuffer);

    // PNG validity check (magic bytes)
    if (pngBuffer.length < 1000) throw new Error(`PNG too small: ${pngBuffer.length} bytes`);
    if (pngBuffer[0] !== 0x89 || pngBuffer[1] !== 0x50 || pngBuffer[2] !== 0x4E || pngBuffer[3] !== 0x47) {
      throw new Error('not a valid PNG (magic bytes mismatch)');
    }
    results.push({ step: 'capturePage', size: pngBuffer.length, path: screenshotPath, validPng: true, ok: true });

    // 10) form-mcp-dispatcher 経由 (real IPC server + real MCP server child)
    //   ★ Bug 8 注意: dispatcher の getScreenshotDir() と
    //   form-session-manager の settings.getScreenshotDir() が一致しないと
    //   captureScreenshot の path traversal guard で弾かれる。
    //   テストでは settings.getScreenshotDir() を使う。
    const settings = require('../dist-ts/src/settings-manager');
    const realScreenshotDir = settings.getScreenshotDir();
    if (!fs.existsSync(realScreenshotDir)) fs.mkdirSync(realScreenshotDir, { recursive: true });
    log(`real screenshotDir: ${realScreenshotDir}`);

    const { createIpcServer } = require('../dist-ts/src/ipc-server');
    const dispatcher = require('../dist-ts/src/form-mcp-dispatcher');
    const ipcServer = createIpcServer();
    dispatcher.registerHandlers(ipcServer, {
      formSessionManager: mgr,
      getScreenshotDir: () => realScreenshotDir,
    });
    await ipcServer.start();
    results.push({ step: 'ipc-server-start', pipePath: ipcServer.pipePath, ok: true });

    // 11) dispatcher を pipe 経由で MCP server から呼ぶ
    const { spawn } = require('child_process');
    const mcpServerPath = path.resolve(__dirname, '..', 'src', 'mcp-servers', 'sales-claw-form', 'server.cjs');
    const child = spawn(process.execPath, [mcpServerPath], {
      env: { ...process.env, SALES_CLAW_FORM_IPC_PIPE: ipcServer.pipePath, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdoutBuf = '';
    const pending = new Map();
    let nextId = 1;
    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString('utf8');
      let nl;
      while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id != null && pending.has(msg.id)) {
            const p = pending.get(msg.id);
            pending.delete(msg.id);
            if (msg.error) p.reject(new Error(`MCP error: ${msg.error.message}`));
            else p.resolve(msg.result);
          }
        } catch (_) { /* ignore */ }
      }
    });
    function rpc(method, params) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
        setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`rpc ${method} timeout`)); } }, 8000);
      });
    }

    await new Promise((r) => setTimeout(r, 500));
    await rpc('initialize', {});

    // tools/call: browser_take_screenshot (既存の real session を sessionId で指定)
    const screenshotResult = await rpc('tools/call', {
      name: 'browser_take_screenshot',
      arguments: { sessionId, suffix: 'confirm' },
    });
    if (screenshotResult.isError) throw new Error(`screenshot via MCP failed: ${screenshotResult.content[0].text}`);
    const ssPath = JSON.parse(screenshotResult.content[0].text).path;
    if (!fs.existsSync(ssPath)) throw new Error(`screenshot file not on disk: ${ssPath}`);
    results.push({ step: 'mcp-roundtrip-screenshot', path: ssPath, ok: true });

    // tools/call: browser_fill_form で別の値を入れて DOM verify
    const refillResult = await rpc('tools/call', {
      name: 'browser_fill_form',
      arguments: {
        sessionId,
        mappings: [{ selector: '#company', value: 'MCP経由テスト株式会社' }],
      },
    });
    if (refillResult.isError) throw new Error(`fill via MCP failed: ${refillResult.content[0].text}`);
    const afterMcpFill = await view.webContents.executeJavaScript(`document.querySelector('#company').value`);
    if (afterMcpFill !== 'MCP経由テスト株式会社') {
      throw new Error(`MCP fill DOM mismatch: ${afterMcpFill}`);
    }
    results.push({ step: 'mcp-roundtrip-fill-verify', companyAfter: afterMcpFill, ok: true });

    // cleanup
    child.kill();
    await ipcServer.stop();

    // 12) destroySession
    mgr.destroySession(sessionId);
    results.push({ step: 'destroySession', ok: true });

    console.log('---RESULTS---' + JSON.stringify({ ok: true, results }));
  } catch (e) {
    console.error('FAIL:', e.message);
    console.error(e.stack || '(no stack)');
    console.log('---RESULTS---' + JSON.stringify({
      ok: false,
      error: e.message,
      stack: (e.stack || '').split('\n').slice(0, 6).join('\n'),
      results,
    }));
    exitCode = 1;
  } finally {
    if (server) { try { server.close(); } catch (_) {} }
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
    setTimeout(() => app.exit(exitCode), 300);
  }
}

app.whenReady().then(runTests).catch((e) => {
  console.error('App ready handler crashed:', e);
  app.exit(2);
});
app.on('window-all-closed', (e) => { e.preventDefault(); /* keep app alive until app.exit */ });

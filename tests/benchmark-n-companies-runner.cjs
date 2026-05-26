'use strict';

// Real Electron benchmark: N 合成企業を fixture form 経由で順次/並列処理し、
// 1 社あたりの所要時間とエラー件数を実測する。
//
// 実行: electron tests/benchmark-n-companies-runner.cjs --n=10 --parallel=3
//
// 各「企業」につき以下を実行:
//   1. WebContentsView 作成 + attach
//   2. fixture form を navigate
//   3. getFormStructure (DOM スキャン)
//   4. fillForm (4 フィールド)
//   5. DOM verify
//   6. capturePage → PNG ディスク書込
//   7. destroySession
//
// 失敗があれば error counter に加算、最後に詳細レポート JSON を出力。

const { app, BrowserWindow, WebContentsView } = require('electron');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// arg parse
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)=(.*)$/);
  return m ? [m[1], m[2]] : [a, true];
}));
const N = Number(args.n || 10);
const PARALLEL = Number(args.parallel || 3);

let server = null;
let mainWindow = null;
let mgr = null;
let realScreenshotDir = '';
const companyResults = [];
let exitCode = 0;

function log(msg) { process.stdout.write(`[bench] ${msg}\n`); }

function startFixtureHttpServer() {
  return new Promise((resolve) => {
    const html = fs.readFileSync(path.resolve(__dirname, 'fixtures', 'local-form.html'), 'utf8');
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    });
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}/`));
  });
}

// 1 社分の処理
async function processCompany(companyNo, fixtureUrl) {
  const start = Date.now();
  const result = { companyNo, ok: false, errors: [], steps: {} };
  let sessionId = null;
  let view = null;

  try {
    view = new WebContentsView({
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        partition: `bench-session-${companyNo}-${Date.now()}`,
      },
    });
    mainWindow.contentView.addChildView(view);
    view.setBounds({ x: 0, y: 0, width: 800, height: 600 });
    result.steps.attach = Date.now() - start;

    sessionId = crypto.randomUUID();
    mgr._sessions.set(sessionId, {
      id: sessionId, view, formUrl: fixtureUrl, companyNo: String(companyNo),
      status: 'loading', screenshotPath: null, blockedUrl: null, blockedReason: null,
    });

    const t0 = Date.now();
    await view.webContents.loadURL(fixtureUrl);
    result.steps.navigate = Date.now() - t0;

    const t1 = Date.now();
    const structure = await mgr.getFormStructure(sessionId);
    if (!structure.fields || structure.fields.length < 4) {
      throw new Error(`field detection failed: ${(structure.fields || []).length} fields`);
    }
    result.steps.snapshot = Date.now() - t1;
    result.fieldCount = structure.fields.length;

    const t2 = Date.now();
    const fillResults = await mgr.fillForm(sessionId, [
      { selector: '#company', value: `合成企業No.${companyNo}` },
      { selector: '#name', value: '中澤 圭志' },
      { selector: '#email', value: `bench${companyNo}@example.com` },
      { selector: '#body', value: `合成ベンチ用本文 No.${companyNo}` },
    ]);
    const failedFills = fillResults.filter((r) => !r.ok);
    if (failedFills.length > 0) throw new Error(`fillForm partial failure: ${JSON.stringify(failedFills)}`);
    result.steps.fill = Date.now() - t2;

    // DOM verify
    const t3 = Date.now();
    const verify = await view.webContents.executeJavaScript(
      `document.querySelector('#company').value`,
    );
    if (verify !== `合成企業No.${companyNo}`) {
      throw new Error(`DOM verify mismatch: '${verify}'`);
    }
    result.steps.verify = Date.now() - t3;

    // capturePage
    const t4 = Date.now();
    const image = await view.webContents.capturePage();
    const png = image.toPNG();
    if (png.length < 1000) throw new Error(`PNG too small: ${png.length}`);
    if (png[0] !== 0x89 || png[1] !== 0x50) throw new Error('PNG magic invalid');
    const ssPath = path.join(realScreenshotDir, `ss-${companyNo}-input.png`);
    fs.writeFileSync(ssPath, png);
    result.steps.screenshot = Date.now() - t4;
    result.screenshotSize = png.length;
    result.screenshotPath = ssPath;

    result.ok = true;
    result.totalMs = Date.now() - start;
  } catch (e) {
    result.ok = false;
    result.errors.push({ message: e.message, stack: (e.stack || '').split('\n').slice(0, 3).join('\n') });
    result.totalMs = Date.now() - start;
  } finally {
    try {
      if (view) mainWindow.contentView.removeChildView(view);
    } catch (_) {}
    try { if (sessionId) mgr.destroySession(sessionId); } catch (_) {}
  }

  companyResults.push(result);
  return result;
}

// 並列実行 worker pool
async function runWorkerPool(items, concurrency, workFn) {
  const queue = items.slice();
  const workers = [];
  for (let i = 0; i < concurrency; i++) {
    workers.push((async () => {
      while (queue.length > 0) {
        const item = queue.shift();
        if (item == null) break;
        await workFn(item);
      }
    })());
  }
  await Promise.all(workers);
}

async function runBench() {
  try {
    const fixtureUrl = await startFixtureHttpServer();
    log(`fixture-server ${fixtureUrl}`);

    mainWindow = new BrowserWindow({
      show: true, width: 1200, height: 800,
      skipTaskbar: true, opacity: 0, focusable: false, transparent: true, frame: false, hasShadow: false,
    });
    await mainWindow.loadURL('data:text/html,<html><body>bench-host</body></html>');
    log('mainWindow ready');

    const { FormSessionManager } = require('../dist-ts/src/form-session-manager');
    mgr = new FormSessionManager(() => mainWindow);

    const settings = require('../dist-ts/src/settings-manager');
    realScreenshotDir = settings.getScreenshotDir();
    if (!fs.existsSync(realScreenshotDir)) fs.mkdirSync(realScreenshotDir, { recursive: true });
    log(`screenshotDir: ${realScreenshotDir}`);

    log(`starting benchmark: N=${N}, parallel=${PARALLEL}`);
    const benchStart = Date.now();

    const companyNos = Array.from({ length: N }, (_, i) => 1000 + i);
    await runWorkerPool(companyNos, PARALLEL, (no) => processCompany(no, fixtureUrl));

    const totalMs = Date.now() - benchStart;
    const successCount = companyResults.filter((r) => r.ok).length;
    const failCount = N - successCount;
    const successRate = successCount / N;

    // 集計
    const successResults = companyResults.filter((r) => r.ok);
    const totalMsList = successResults.map((r) => r.totalMs).sort((a, b) => a - b);
    const navMsList = successResults.map((r) => r.steps.navigate || 0).sort((a, b) => a - b);
    const fillMsList = successResults.map((r) => r.steps.fill || 0).sort((a, b) => a - b);
    const ssMsList = successResults.map((r) => r.steps.screenshot || 0).sort((a, b) => a - b);
    const pct = (arr, p) => arr.length === 0 ? 0 : arr[Math.min(arr.length - 1, Math.floor(arr.length * p))];
    const avg = (arr) => arr.length === 0 ? 0 : Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
    const stats = {
      N, PARALLEL,
      totalMs,
      successCount, failCount, successRate,
      perCompanyAvgMs: avg(totalMsList),
      perCompanyMedianMs: pct(totalMsList, 0.5),
      perCompanyP95Ms: pct(totalMsList, 0.95),
      throughputCompaniesPerMinute: Math.round((N / totalMs) * 60000 * 10) / 10,
      stepBreakdown: {
        navigateAvgMs: avg(navMsList),
        fillAvgMs: avg(fillMsList),
        screenshotAvgMs: avg(ssMsList),
      },
      failures: companyResults.filter((r) => !r.ok).map((r) => ({
        companyNo: r.companyNo, errors: r.errors,
      })),
    };

    console.log('---BENCH-RESULTS---' + JSON.stringify({ ok: failCount === 0, stats, companyResults }));
  } catch (e) {
    console.error('FATAL:', e.stack || e.message);
    console.log('---BENCH-RESULTS---' + JSON.stringify({
      ok: false, fatalError: e.message,
      partialResults: companyResults,
    }));
    exitCode = 1;
  } finally {
    if (server) try { server.close(); } catch (_) {}
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
    setTimeout(() => app.exit(exitCode), 300);
  }
}

app.whenReady().then(runBench).catch((e) => { console.error('App init fail:', e); app.exit(2); });
app.on('window-all-closed', (e) => { e.preventDefault(); });

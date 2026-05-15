'use strict';

/**
 * テスト用ダミー問い合わせフォームサーバ (port 4567)
 *
 * 目的: parallelTabs=1 vs =2 の wall-clock を測るため、実フォーム navigation
 * + 入力 + submit のレイテンシを再現する。
 *
 * - GET  /form/:id     2 秒のレイテンシ後に HTML フォームを返す (ナビ待ちを模擬)
 * - POST /submit/:id   1.5 秒のレイテンシ後に「送信ありがとうございました」HTML
 *
 * 起動: node scripts/dummy-form-server.cjs
 */

const http = require('http');

const NAV_LATENCY_MS = 2000;
const SUBMIT_LATENCY_MS = 1500;

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

const server = http.createServer(async (req, res) => {
  const url = req.url || '';
  const formMatch = url.match(/^\/form\/(\w+)$/);
  const submitMatch = url.match(/^\/submit\/(\w+)$/);

  if (formMatch && req.method === 'GET') {
    await delay(NAV_LATENCY_MS);
    const id = formMatch[1];
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><head><title>Form ${id}</title></head><body>
      <h1>お問い合わせ #${id}</h1>
      <form action="/submit/${id}" method="POST">
        <label>会社名 <input type="text" name="company" id="company" required></label><br>
        <label>担当者 <input type="text" name="name" id="name" required></label><br>
        <label>メール <input type="email" name="email" id="email" required></label><br>
        <label>本文 <textarea name="message" id="message" rows="4" required></textarea></label><br>
        <button type="submit">送信</button>
      </form>
    </body></html>`);
    return;
  }

  if (submitMatch && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      await delay(SUBMIT_LATENCY_MS);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><body><h1>送信完了</h1><p>ID ${submitMatch[1]}: ${body.length} bytes</p></body></html>`);
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

const PORT = Number(process.env.PORT) || 4567;
server.listen(PORT, '127.0.0.1', () => {
  console.log(`[dummy-form] ready on http://127.0.0.1:${PORT}`);
  console.log(`  forms:  GET  /form/a, /form/b, ...  (${NAV_LATENCY_MS}ms latency)`);
  console.log(`  submit: POST /submit/a, /submit/b, ... (${SUBMIT_LATENCY_MS}ms latency)`);
});

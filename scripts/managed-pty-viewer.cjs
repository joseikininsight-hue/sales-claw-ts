'use strict';

const WebSocket = require('ws');

function getArg(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return '';
  return process.argv[index + 1] || '';
}

const url = getArg('--url');
const provider = getArg('--provider') || 'AI';

if (!url) {
  console.error('[Sales Claw] Missing --url for PTY viewer.');
  process.exit(1);
}

const ws = new WebSocket(url);
let stdinAttached = false;
let stdoutClosed = false;

function write(text) {
  if (stdoutClosed) return;
  try {
    process.stdout.write(text);
  } catch (_) {
    // noop
  }
}

process.stdout.on('error', (error) => {
  if (error && error.code === 'EPIPE') {
    stdoutClosed = true;
    try {
      ws.close();
    } catch (_) {
      // noop
    }
    process.exit(0);
  }
});

function attachStdin() {
  if (stdinAttached || !process.stdin.isTTY) return;
  stdinAttached = true;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', (chunk) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({
      type: 'input',
      data: chunk.toString('utf8'),
    }));
  });
}

function sendResize() {
  if (ws.readyState !== WebSocket.OPEN) return;
  const cols = Math.max(2, Number(process.stdout.columns) || 120);
  const rows = Math.max(1, Number(process.stdout.rows) || 30);
  ws.send(JSON.stringify({ type: 'resize', cols, rows }));
}

ws.on('open', () => {
  write(`\r\n[Sales Claw] ${provider} managed session viewer attached.\r\n`);
  write('[Sales Claw] This window mirrors the same AI session used for queued work.\r\n\r\n');
  attachStdin();
  sendResize();
});

ws.on('message', (raw) => {
  try {
    const msg = JSON.parse(String(raw));
    if (msg.type === 'output' && typeof msg.data === 'string') {
      write(msg.data);
      return;
    }
    if (msg.type === 'connected') {
      write(`[Sales Claw] PTY ${msg.running ? 'connected' : 'ready'} (${msg.provider || provider})\r\n`);
      return;
    }
    if (msg.type === 'exit') {
      write(`\r\n[Sales Claw] AI session exited (code: ${msg.code}).\r\n`);
      return;
    }
  } catch (_) {
    write(String(raw));
  }
});

ws.on('close', () => {
  write('\r\n[Sales Claw] Viewer disconnected.\r\n');
  process.exit(0);
});

ws.on('error', (error) => {
  console.error(`\r\n[Sales Claw] Viewer error: ${error.message}`);
  process.exit(1);
});

process.on('SIGWINCH', sendResize);
process.on('SIGINT', () => {
  try {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'input', data: '\u0003' }));
    }
  } catch (_) {
    // noop
  }
});

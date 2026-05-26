'use strict';

// sales-claw-form MCP server entry point.
//
// Phase 1 skeleton (v2.1.0-pre).
// 設計: docs/architecture/in-app-form-fill.md §2, §3.
//
// MCP protocol: minimal JSON-RPC 2.0 over stdio.
// 公式 @modelcontextprotocol/sdk は Phase 2 で導入予定 (今は dependencies に未追加)。
//
// 起動経路: Claude CLI が `claude mcp add` で登録された command を spawn。
// 我々の場合は `bin/sales-claw-form-mcp.cjs` がこの server.cjs を require する。

const { IpcClient } = require('./ipc-client.cjs');

// Phase 2 tools (15個 全実装)。
const TOOLS = [
  require('./tools/navigate.cjs'),
  require('./tools/snapshot.cjs'),
  require('./tools/screenshot.cjs'),
  require('./tools/fill_form.cjs'),
  require('./tools/click.cjs'),
  require('./tools/type.cjs'),
  require('./tools/select_option.cjs'),
  require('./tools/tabs.cjs'),
  require('./tools/evaluate.cjs'),
  require('./tools/wait_for.cjs'),
  require('./tools/press_key.cjs'),
  require('./tools/handle_dialog.cjs'),
  require('./tools/file_upload.cjs'),
  require('./tools/drag.cjs'),
  require('./tools/hover.cjs'),
];

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = {
  name: 'sales-claw-form',
  version: '0.1.0-phase1',
};

let ipcClient = null;

function log(msg) {
  // stderr に書いて Claude CLI 側に届ける (stdout は MCP プロトコルで占有)
  process.stderr.write(`[sales-claw-form-mcp] ${msg}\n`);
}

function send(message) {
  const json = JSON.stringify(message);
  process.stdout.write(json + '\n');
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message, data) {
  send({ jsonrpc: '2.0', id, error: { code, message, data } });
}

async function handleInitialize(id, params) {
  // protocol negotiation: 我々が分かるのは PROTOCOL_VERSION
  reply(id, {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: { tools: {} },
    serverInfo: SERVER_INFO,
  });
}

async function handleToolsList(id) {
  reply(id, {
    tools: TOOLS.map((t) => ({
      name: t.SCHEMA.name,
      description: t.SCHEMA.description,
      inputSchema: t.SCHEMA.inputSchema,
    })),
  });
}

async function handleToolsCall(id, params) {
  const name = params && params.name;
  const args = (params && params.arguments) || {};
  const tool = TOOLS.find((t) => t.SCHEMA.name === name);
  if (!tool) {
    replyError(id, -32601, `Unknown tool: ${name}`);
    return;
  }
  if (!ipcClient) {
    replyError(id, -32000, 'IPC client not initialized — Sales Claw が起動していない可能性があります');
    return;
  }
  try {
    const result = await tool.execute(args, ipcClient);
    reply(id, {
      content: [{ type: 'text', text: JSON.stringify(result) }],
      isError: false,
    });
  } catch (e) {
    reply(id, {
      content: [{ type: 'text', text: `Error: ${e.message || String(e)}` }],
      isError: true,
    });
  }
}

async function dispatch(message) {
  if (!message || typeof message !== 'object') return;
  const { id, method, params } = message;
  switch (method) {
    case 'initialize':
      return handleInitialize(id, params);
    case 'initialized':
    case 'notifications/initialized':
      return; // notification, no reply
    case 'tools/list':
      return handleToolsList(id);
    case 'tools/call':
      return handleToolsCall(id, params);
    case 'ping':
      return reply(id, {});
    default:
      if (id != null) replyError(id, -32601, `Method not found: ${method}`);
  }
}

function startStdioLoop() {
  let buffer = '';
  process.stdin.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); }
      catch (e) {
        log(`Invalid JSON-RPC frame: ${e.message}`);
        continue;
      }
      Promise.resolve(dispatch(msg)).catch((e) => {
        log(`Dispatch error: ${e.message || e}`);
      });
    }
  });
  process.stdin.on('end', () => process.exit(0));
}

async function main() {
  const pipePath = process.env.SALES_CLAW_FORM_IPC_PIPE;
  if (!pipePath) {
    log('SALES_CLAW_FORM_IPC_PIPE 未設定。Electron 起動後に Claude CLI を再起動してください。');
    // それでも stdio loop は開始する。tools/list は返せるが tools/call は失敗。
  } else {
    ipcClient = new IpcClient(pipePath);
    try {
      await ipcClient.connect();
      log(`Connected to Electron via ${pipePath}`);
    } catch (e) {
      log(`Failed to connect to Electron IPC: ${e.message}. Tools will fail until reconnected.`);
    }
  }
  startStdioLoop();
}

main().catch((e) => {
  log(`Fatal: ${e.message || e}`);
  process.exit(1);
});

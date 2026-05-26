'use strict';

// browser_navigate tool — Phase 1 skeleton (1/3).
//
// CDP マッピング: Page.navigate + Page.loadEventFired 待ち
// 詳細: docs/architecture/in-app-form-fill.md §2.1 #1

const SCHEMA = {
  name: 'browser_navigate',
  description: 'Navigate the active form session to a URL. If sessionId is omitted, a new session is created.',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Target URL (https://). SSRF guard applied.' },
      sessionId: { type: 'string', description: 'Existing session ID. If omitted, a new session is created.' },
      waitUntil: {
        type: 'string',
        enum: ['load', 'domcontentloaded', 'networkidle'],
        description: 'When to consider navigation complete. Default: load',
      },
    },
    required: ['url'],
  },
};

function validateArgs(args) {
  if (!args || typeof args !== 'object') throw new Error('args must be an object');
  if (typeof args.url !== 'string' || args.url.length === 0) {
    throw new Error('url is required (string)');
  }
  if (args.sessionId != null && typeof args.sessionId !== 'string') {
    throw new Error('sessionId must be a string');
  }
  if (args.waitUntil != null && !['load', 'domcontentloaded', 'networkidle'].includes(args.waitUntil)) {
    throw new Error(`waitUntil must be one of: load, domcontentloaded, networkidle`);
  }
  return {
    url: args.url,
    sessionId: args.sessionId,
    waitUntil: args.waitUntil || 'load',
  };
}

async function execute(args, ipcClient) {
  const validated = validateArgs(args);
  // Electron 側に「navigate」op を委譲。引数はそのまま渡す。
  // Electron 側 (Phase 2 で実装) は FormSessionManager.createSession or
  // FormSessionManager.navigate を呼び出して結果を返す。
  const result = await ipcClient.request('navigate', validated);
  return result;
}

module.exports = { SCHEMA, execute };

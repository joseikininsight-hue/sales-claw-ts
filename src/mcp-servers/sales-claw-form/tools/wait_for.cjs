'use strict';

// browser_wait_for tool — Phase 2. Polling-based wait for selector / text.
// 詳細: docs/architecture/in-app-form-fill.md §2.1 #10

const SCHEMA = {
  name: 'browser_wait_for',
  description: 'Wait until a selector or text appears. Polls every 200ms.',
  inputSchema: {
    type: 'object',
    properties: {
      sessionId: { type: 'string' },
      selector: { type: 'string', description: 'CSS selector to wait for (mutually exclusive with text)' },
      text: { type: 'string', description: 'Text to find in document.body.innerText' },
      timeout: { type: 'number', description: 'ms. Default 15000, max 60000.' },
    },
    required: ['sessionId'],
  },
};

function validateArgs(args) {
  if (!args || typeof args !== 'object') throw new Error('args must be an object');
  if (typeof args.sessionId !== 'string') throw new Error('sessionId required');
  if (!args.selector && !args.text) throw new Error('selector or text required');
  if (args.selector && args.text) throw new Error('selector and text are mutually exclusive');
  if (args.selector != null && typeof args.selector !== 'string') throw new Error('selector must be string');
  if (args.text != null && typeof args.text !== 'string') throw new Error('text must be string');
  const timeout = args.timeout == null ? 15000 : Number(args.timeout);
  if (!Number.isFinite(timeout) || timeout < 100 || timeout > 60000) {
    throw new Error('timeout must be 100-60000ms');
  }
  return { sessionId: args.sessionId, selector: args.selector, text: args.text, timeout };
}

async function execute(args, ipcClient) {
  return ipcClient.request('wait_for', validateArgs(args));
}

module.exports = { SCHEMA, execute };

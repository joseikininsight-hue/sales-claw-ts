'use strict';

// browser_type tool — Phase 2.
// 詳細: docs/architecture/in-app-form-fill.md §2.1 #4

const SCHEMA = {
  name: 'browser_type',
  description: 'Type text into an input by CSS selector. Focuses then dispatches keystrokes.',
  inputSchema: {
    type: 'object',
    properties: {
      sessionId: { type: 'string' },
      selector: { type: 'string' },
      text: { type: 'string' },
      delay: { type: 'number', description: 'Delay between keystrokes in ms. Default: 0 (instant)' },
    },
    required: ['sessionId', 'selector', 'text'],
  },
};

function validateArgs(args) {
  if (!args || typeof args !== 'object') throw new Error('args must be an object');
  if (typeof args.sessionId !== 'string') throw new Error('sessionId required');
  if (typeof args.selector !== 'string' || !args.selector) throw new Error('selector required');
  if (typeof args.text !== 'string') throw new Error('text required (string)');
  const delay = args.delay == null ? 0 : Number(args.delay);
  if (!Number.isFinite(delay) || delay < 0 || delay > 1000) {
    throw new Error('delay must be 0-1000ms');
  }
  return { sessionId: args.sessionId, selector: args.selector, text: args.text, delay };
}

async function execute(args, ipcClient) {
  return ipcClient.request('type', validateArgs(args));
}

module.exports = { SCHEMA, execute };

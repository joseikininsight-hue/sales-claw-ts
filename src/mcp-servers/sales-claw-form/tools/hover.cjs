'use strict';

// browser_hover tool — Phase 2.
// 詳細: docs/architecture/in-app-form-fill.md §2.1 #15

const SCHEMA = {
  name: 'browser_hover',
  description: 'Move the mouse over an element by CSS selector (triggers :hover / mouseover events).',
  inputSchema: {
    type: 'object',
    properties: {
      sessionId: { type: 'string' },
      selector: { type: 'string' },
    },
    required: ['sessionId', 'selector'],
  },
};

function validateArgs(args) {
  if (!args || typeof args !== 'object') throw new Error('args must be an object');
  if (typeof args.sessionId !== 'string') throw new Error('sessionId required');
  if (typeof args.selector !== 'string' || !args.selector) throw new Error('selector required');
  return { sessionId: args.sessionId, selector: args.selector };
}

async function execute(args, ipcClient) {
  return ipcClient.request('hover', validateArgs(args));
}

module.exports = { SCHEMA, execute };

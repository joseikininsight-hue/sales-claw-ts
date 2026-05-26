'use strict';

// browser_click tool — Phase 2.
// 詳細: docs/architecture/in-app-form-fill.md §2.1 #5

const SCHEMA = {
  name: 'browser_click',
  description: 'Click an element by CSS selector.',
  inputSchema: {
    type: 'object',
    properties: {
      sessionId: { type: 'string' },
      selector: { type: 'string' },
      button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Default: left' },
      clickCount: { type: 'number', description: 'Default: 1' },
    },
    required: ['sessionId', 'selector'],
  },
};

function validateArgs(args) {
  if (!args || typeof args !== 'object') throw new Error('args must be an object');
  if (typeof args.sessionId !== 'string') throw new Error('sessionId required');
  if (typeof args.selector !== 'string' || !args.selector) throw new Error('selector required');
  const button = args.button || 'left';
  if (!['left', 'right', 'middle'].includes(button)) throw new Error('invalid button');
  const clickCount = args.clickCount == null ? 1 : Number(args.clickCount);
  if (!Number.isFinite(clickCount) || clickCount < 1 || clickCount > 3) {
    throw new Error('clickCount must be 1-3');
  }
  return { sessionId: args.sessionId, selector: args.selector, button, clickCount };
}

async function execute(args, ipcClient) {
  return ipcClient.request('click', validateArgs(args));
}

module.exports = { SCHEMA, execute };

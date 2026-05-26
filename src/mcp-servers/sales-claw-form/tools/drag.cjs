'use strict';

// browser_drag tool — Phase 2.
// 詳細: docs/architecture/in-app-form-fill.md §2.1 #14

const SCHEMA = {
  name: 'browser_drag',
  description: 'Drag from source element to target element (mouse press, move, release).',
  inputSchema: {
    type: 'object',
    properties: {
      sessionId: { type: 'string' },
      sourceSelector: { type: 'string' },
      targetSelector: { type: 'string' },
    },
    required: ['sessionId', 'sourceSelector', 'targetSelector'],
  },
};

function validateArgs(args) {
  if (!args || typeof args !== 'object') throw new Error('args must be an object');
  if (typeof args.sessionId !== 'string') throw new Error('sessionId required');
  if (typeof args.sourceSelector !== 'string' || !args.sourceSelector) throw new Error('sourceSelector required');
  if (typeof args.targetSelector !== 'string' || !args.targetSelector) throw new Error('targetSelector required');
  return { sessionId: args.sessionId, sourceSelector: args.sourceSelector, targetSelector: args.targetSelector };
}

async function execute(args, ipcClient) {
  return ipcClient.request('drag', validateArgs(args));
}

module.exports = { SCHEMA, execute };

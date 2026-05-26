'use strict';

// browser_select_option tool — Phase 2.
// 詳細: docs/architecture/in-app-form-fill.md §2.1 #6

const SCHEMA = {
  name: 'browser_select_option',
  description: 'Select <option> values in a <select>. For multi-select, pass multiple values.',
  inputSchema: {
    type: 'object',
    properties: {
      sessionId: { type: 'string' },
      selector: { type: 'string' },
      values: {
        type: 'array',
        items: { type: 'string' },
        description: 'Option value(s) to select. Matched against option.value, then option.label as fallback.',
      },
    },
    required: ['sessionId', 'selector', 'values'],
  },
};

function validateArgs(args) {
  if (!args || typeof args !== 'object') throw new Error('args must be an object');
  if (typeof args.sessionId !== 'string') throw new Error('sessionId required');
  if (typeof args.selector !== 'string' || !args.selector) throw new Error('selector required');
  if (!Array.isArray(args.values) || args.values.length === 0) {
    throw new Error('values must be a non-empty array of strings');
  }
  for (const v of args.values) {
    if (typeof v !== 'string') throw new Error('each value must be a string');
  }
  return { sessionId: args.sessionId, selector: args.selector, values: args.values };
}

async function execute(args, ipcClient) {
  return ipcClient.request('select_option', validateArgs(args));
}

module.exports = { SCHEMA, execute };

'use strict';

// browser_snapshot tool — Phase 1 skeleton (2/3).
//
// 返り値: { tree, fields, captcha, iframes }
// CDP マッピング: Accessibility.getFullAXTree + 既存 getFormStructure (Runtime.evaluate)
// 詳細: docs/architecture/in-app-form-fill.md §2.1 #2, §2.2

const SCHEMA = {
  name: 'browser_snapshot',
  description: 'Capture the current form page as a structured snapshot (a11y tree + form fields + captcha detection).',
  inputSchema: {
    type: 'object',
    properties: {
      sessionId: { type: 'string', description: 'Required. Session ID returned by browser_navigate or browser_tabs.' },
      mode: {
        type: 'string',
        enum: ['a11y', 'dom-lite'],
        description: 'Snapshot mode. a11y returns the accessibility tree; dom-lite returns a flat form-field summary. Default: a11y',
      },
    },
    required: ['sessionId'],
  },
};

function validateArgs(args) {
  if (!args || typeof args !== 'object') throw new Error('args must be an object');
  if (typeof args.sessionId !== 'string' || args.sessionId.length === 0) {
    throw new Error('sessionId is required (string)');
  }
  if (args.mode != null && !['a11y', 'dom-lite'].includes(args.mode)) {
    throw new Error('mode must be one of: a11y, dom-lite');
  }
  return {
    sessionId: args.sessionId,
    mode: args.mode || 'a11y',
  };
}

async function execute(args, ipcClient) {
  const validated = validateArgs(args);
  const result = await ipcClient.request('snapshot', validated);
  return result;
}

module.exports = { SCHEMA, execute };

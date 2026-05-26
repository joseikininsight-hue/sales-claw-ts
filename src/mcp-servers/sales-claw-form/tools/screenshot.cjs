'use strict';

// browser_take_screenshot tool — Phase 1 skeleton (3/3).
//
// CDP マッピング: 既存 FormSessionManager.captureScreenshot
//   (webContents.capturePage()), fullPage 時は Page.captureScreenshot {captureBeyondViewport:true}
// 詳細: docs/architecture/in-app-form-fill.md §2.1 #7

const SCHEMA = {
  name: 'browser_take_screenshot',
  description: 'Save a PNG screenshot of the current form session to screenshots/ss-{companyNo}-{suffix}.png.',
  inputSchema: {
    type: 'object',
    properties: {
      sessionId: { type: 'string', description: 'Required. Session ID.' },
      suffix: {
        type: 'string',
        enum: ['input', 'confirm', 'sent', 'error'],
        description: 'Required. Used to compose the filename ss-{No}-{suffix}.png',
      },
      fullPage: {
        type: 'boolean',
        description: 'If true, capture the full scrollable page. Default: false (viewport only).',
      },
    },
    required: ['sessionId', 'suffix'],
  },
};

const ALLOWED_SUFFIXES = new Set(['input', 'confirm', 'sent', 'error']);

function validateArgs(args) {
  if (!args || typeof args !== 'object') throw new Error('args must be an object');
  if (typeof args.sessionId !== 'string' || args.sessionId.length === 0) {
    throw new Error('sessionId is required (string)');
  }
  if (!ALLOWED_SUFFIXES.has(args.suffix)) {
    throw new Error('suffix must be one of: input, confirm, sent, error');
  }
  return {
    sessionId: args.sessionId,
    suffix: args.suffix,
    fullPage: Boolean(args.fullPage),
  };
}

async function execute(args, ipcClient) {
  const validated = validateArgs(args);
  const result = await ipcClient.request('screenshot', validated);
  return result;
}

module.exports = { SCHEMA, execute };

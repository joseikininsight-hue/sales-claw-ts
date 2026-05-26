'use strict';

// browser_handle_dialog tool — Phase 2.
// 詳細: docs/architecture/in-app-form-fill.md §2.1 #12
// JS alert/confirm/prompt/beforeunload を処理。前段で javascriptDialogOpening listener 必要。

const SCHEMA = {
  name: 'browser_handle_dialog',
  description: 'Accept or dismiss a pending JavaScript dialog (alert/confirm/prompt).',
  inputSchema: {
    type: 'object',
    properties: {
      sessionId: { type: 'string' },
      accept: { type: 'boolean' },
      promptText: { type: 'string', description: 'Text for prompt() dialogs when accept=true' },
    },
    required: ['sessionId', 'accept'],
  },
};

function validateArgs(args) {
  if (!args || typeof args !== 'object') throw new Error('args must be an object');
  if (typeof args.sessionId !== 'string') throw new Error('sessionId required');
  if (typeof args.accept !== 'boolean') throw new Error('accept (boolean) required');
  if (args.promptText != null && typeof args.promptText !== 'string') throw new Error('promptText must be string');
  return { sessionId: args.sessionId, accept: args.accept, promptText: args.promptText };
}

async function execute(args, ipcClient) {
  return ipcClient.request('handle_dialog', validateArgs(args));
}

module.exports = { SCHEMA, execute };

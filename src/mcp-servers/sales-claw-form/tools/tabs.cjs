'use strict';

// browser_tabs tool — Phase 2. Manage form sessions as tabs.
// 詳細: docs/architecture/in-app-form-fill.md §2.1 #8

const SCHEMA = {
  name: 'browser_tabs',
  description: 'List/create/close/select form sessions. Each session = one company\'s tab.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'new', 'close', 'select'], description: 'Default: list' },
      sessionId: { type: 'string', description: 'Required for close/select' },
      url: { type: 'string', description: 'Required for new' },
      companyNo: { type: 'number', description: 'Required for new' },
    },
  },
};

function validateArgs(args) {
  args = args || {};
  const action = args.action || 'list';
  if (!['list', 'new', 'close', 'select'].includes(action)) throw new Error('invalid action');
  if (action === 'new') {
    if (typeof args.url !== 'string' || !args.url) throw new Error('url required for new');
    if (!Number.isFinite(Number(args.companyNo))) throw new Error('companyNo required for new');
  }
  if ((action === 'close' || action === 'select') && typeof args.sessionId !== 'string') {
    throw new Error('sessionId required for close/select');
  }
  return {
    action,
    sessionId: args.sessionId,
    url: args.url,
    companyNo: args.companyNo != null ? Number(args.companyNo) : undefined,
  };
}

async function execute(args, ipcClient) {
  return ipcClient.request('tabs', validateArgs(args));
}

module.exports = { SCHEMA, execute };

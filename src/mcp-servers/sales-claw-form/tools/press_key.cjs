'use strict';

// browser_press_key tool — Phase 2.
// 詳細: docs/architecture/in-app-form-fill.md §2.1 #11

const SCHEMA = {
  name: 'browser_press_key',
  description: 'Press a single key (with optional modifiers). E.g. Enter, Tab, Escape.',
  inputSchema: {
    type: 'object',
    properties: {
      sessionId: { type: 'string' },
      key: { type: 'string', description: 'Key name (Enter, Tab, Escape, ArrowDown, etc.) or printable character' },
      modifiers: {
        type: 'array',
        items: { type: 'string', enum: ['Shift', 'Control', 'Alt', 'Meta'] },
      },
    },
    required: ['sessionId', 'key'],
  },
};

const VALID_MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta']);

function validateArgs(args) {
  if (!args || typeof args !== 'object') throw new Error('args must be an object');
  if (typeof args.sessionId !== 'string') throw new Error('sessionId required');
  if (typeof args.key !== 'string' || !args.key) throw new Error('key required');
  const modifiers = Array.isArray(args.modifiers) ? args.modifiers : [];
  for (const m of modifiers) {
    if (!VALID_MODIFIERS.has(m)) throw new Error(`invalid modifier: ${m}`);
  }
  return { sessionId: args.sessionId, key: args.key, modifiers };
}

async function execute(args, ipcClient) {
  return ipcClient.request('press_key', validateArgs(args));
}

module.exports = { SCHEMA, execute };

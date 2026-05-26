'use strict';

// browser_file_upload tool — Phase 2.
// 詳細: docs/architecture/in-app-form-fill.md §2.1 #13

const path = require('path');
const fs = require('fs');

const SCHEMA = {
  name: 'browser_file_upload',
  description: 'Set files on a <input type="file"> by absolute file paths.',
  inputSchema: {
    type: 'object',
    properties: {
      sessionId: { type: 'string' },
      selector: { type: 'string', description: 'CSS selector for <input type="file">' },
      paths: { type: 'array', items: { type: 'string' }, description: 'Absolute file paths' },
    },
    required: ['sessionId', 'selector', 'paths'],
  },
};

function validateArgs(args) {
  if (!args || typeof args !== 'object') throw new Error('args must be an object');
  if (typeof args.sessionId !== 'string') throw new Error('sessionId required');
  if (typeof args.selector !== 'string' || !args.selector) throw new Error('selector required');
  if (!Array.isArray(args.paths) || args.paths.length === 0) throw new Error('paths required (non-empty array)');
  for (const p of args.paths) {
    if (typeof p !== 'string' || !path.isAbsolute(p)) {
      throw new Error(`each path must be an absolute string: ${p}`);
    }
    if (!fs.existsSync(p)) throw new Error(`file does not exist: ${p}`);
  }
  return { sessionId: args.sessionId, selector: args.selector, paths: args.paths };
}

async function execute(args, ipcClient) {
  return ipcClient.request('file_upload', validateArgs(args));
}

module.exports = { SCHEMA, execute };

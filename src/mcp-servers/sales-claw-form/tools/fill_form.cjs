'use strict';

// browser_fill_form tool — Phase 2.
// 詳細: docs/architecture/in-app-form-fill.md §2.1 #3

const SCHEMA = {
  name: 'browser_fill_form',
  description: 'Fill multiple form fields in one call. Each mapping is {selector, value, type?}. For checkbox pass value "true" to check / "false" to uncheck; for radio pass the selector of the option to select. Returns { results, validation }: results report per-field ok (ok:false with reason value_mismatch means the page rejected/truncated the value — retry via browser_type); validation lists required fields still empty/unchecked and HTML5 constraint violations (validation.problems MUST be empty before clicking submit, fix them first to avoid the site\'s "required field" error page).',
  inputSchema: {
    type: 'object',
    properties: {
      sessionId: { type: 'string' },
      mappings: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            selector: { type: 'string' },
            value: { type: 'string' },
            type: { type: 'string', enum: ['text', 'select', 'checkbox', 'radio'], description: 'Input kind hint' },
          },
          required: ['selector', 'value'],
        },
      },
    },
    required: ['sessionId', 'mappings'],
  },
};

function validateArgs(args) {
  if (!args || typeof args !== 'object') throw new Error('args must be an object');
  if (typeof args.sessionId !== 'string') throw new Error('sessionId required');
  if (!Array.isArray(args.mappings) || args.mappings.length === 0) {
    throw new Error('mappings must be a non-empty array');
  }
  for (const m of args.mappings) {
    if (!m || typeof m.selector !== 'string' || typeof m.value !== 'string') {
      throw new Error('each mapping requires {selector:string, value:string}');
    }
    if (m.type != null && !['text', 'select', 'checkbox', 'radio'].includes(m.type)) {
      throw new Error('mapping.type must be text/select/checkbox/radio');
    }
  }
  return { sessionId: args.sessionId, mappings: args.mappings };
}

async function execute(args, ipcClient) {
  const v = validateArgs(args);
  return ipcClient.request('fill_form', v);
}

module.exports = { SCHEMA, execute };

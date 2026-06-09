'use strict';

// browser_snapshot tool — Phase 1 skeleton (2/3).
//
// 返り値: { tree, fields, captcha, iframes }
// CDP マッピング: Accessibility.getFullAXTree + 既存 getFormStructure (Runtime.evaluate)
// 詳細: docs/architecture/in-app-form-fill.md §2.1 #2, §2.2

const SCHEMA = {
  name: 'browser_snapshot',
  description: 'Capture the current form page as a structured snapshot. Returns { fields, buttons, meta }: fields = form inputs with selector/label/purpose/required/maxLength (checkbox/radio also carry value+checked, select carries options+current value); buttons = submit/confirm button candidates sorted best-first (use buttons[0].selector with browser_click — no need to hunt for the button via browser_evaluate); meta = captcha/iframe/recommendedStatus hints.',
  inputSchema: {
    type: 'object',
    properties: {
      sessionId: { type: 'string', description: 'Required. Session ID returned by browser_navigate or browser_tabs.' },
      mode: {
        type: 'string',
        enum: ['a11y', 'dom-lite'],
        description: 'Snapshot mode. dom-lite returns a flat form-field summary (fast, recommended for form filling); a11y is reserved for the full accessibility tree. Default: dom-lite',
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
    // 既定を dom-lite に統一。dispatcher は実際に dom-lite (フィールド一覧) を返すため、
    // 'a11y' を既定にすると「a11y ツリーを受け取ったはず」と誤認した CLI が冗長な
    // 2 回目 snapshot を撃つ原因になっていた。
    mode: args.mode || 'dom-lite',
  };
}

async function execute(args, ipcClient) {
  const validated = validateArgs(args);
  const result = await ipcClient.request('snapshot', validated);
  return result;
}

module.exports = { SCHEMA, execute };

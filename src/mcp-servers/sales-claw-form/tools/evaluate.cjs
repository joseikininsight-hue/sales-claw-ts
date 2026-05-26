'use strict';

// browser_evaluate tool — Phase 2. Run JS in isolated world.
// 詳細: docs/architecture/in-app-form-fill.md §2.1 #9, §2.3 (isolated world)
// セキュリティ: §1.3 — 4KB 上限、document.cookie / localStorage 直読み禁止 allowlist

const SCHEMA = {
  name: 'browser_evaluate',
  description: 'Evaluate a JavaScript expression in an isolated world. Returns the value (returnByValue).',
  inputSchema: {
    type: 'object',
    properties: {
      sessionId: { type: 'string' },
      expression: { type: 'string', description: 'Max 4096 chars. document.cookie / localStorage access forbidden.' },
      awaitPromise: { type: 'boolean', description: 'If the expression returns a Promise, await it. Default: false' },
    },
    required: ['sessionId', 'expression'],
  },
};

const MAX_EXPRESSION_BYTES = 4096;
// Phase 2 セキュリティ allowlist: 機密情報露出を防ぐため、これらの API への
// 直接アクセスを expression レベルで禁止。Electron 側 isolated world でも
// 二重に防御するが、tool 入口で reject すれば LLM へのフィードバックが明確。
const FORBIDDEN_API_PATTERNS = [
  /\bdocument\s*\.\s*cookie\b/,
  /\blocalStorage\b/,
  /\bsessionStorage\b/,
  /\bindexedDB\b/,
  /\bnavigator\s*\.\s*credentials\b/,
];

function validateArgs(args) {
  if (!args || typeof args !== 'object') throw new Error('args must be an object');
  if (typeof args.sessionId !== 'string') throw new Error('sessionId required');
  if (typeof args.expression !== 'string' || !args.expression) throw new Error('expression required');
  if (Buffer.byteLength(args.expression, 'utf8') > MAX_EXPRESSION_BYTES) {
    throw new Error(`expression too long (max ${MAX_EXPRESSION_BYTES} bytes)`);
  }
  for (const pattern of FORBIDDEN_API_PATTERNS) {
    if (pattern.test(args.expression)) {
      throw new Error(`expression contains forbidden API access (cookie/storage/credentials)`);
    }
  }
  return {
    sessionId: args.sessionId,
    expression: args.expression,
    awaitPromise: Boolean(args.awaitPromise),
  };
}

async function execute(args, ipcClient) {
  return ipcClient.request('evaluate', validateArgs(args));
}

module.exports = { SCHEMA, execute };

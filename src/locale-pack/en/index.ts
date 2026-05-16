// 英語ロケールパック
//
// 英語圏 (US/EU 等) の企業サイトを相手にするためのキーワード辞書・除外フレーズ・
// フォーム探索ヒントを束ねる。Phase 3 で cliPrompts / llmPrompts /
// messageTemplates を追加。

// eslint-disable-next-line @typescript-eslint/no-require-imports
const formFinderHints = require('./form-finder-hints');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const sendabilityExclusions = require('./sendability-exclusions');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const keywordDict = require('./keyword-dict');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const complianceRules = require('./compliance-rules');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const cliPrompts = require('./cli-prompts');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const llmPrompts = require('./llm-prompts');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const messageTemplates = require('./message-templates');

module.exports = {
  formFinderHints,
  sendabilityExclusions,
  keywordDict,
  complianceRules,
  cliPrompts,
  llmPrompts,
  messageTemplates,
};

export {};

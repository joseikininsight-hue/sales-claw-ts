'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sales-claw-characterization-'));
process.env.SALES_CLAW_USER_DATA_DIR = runtimeRoot;
process.env.SALES_CLAW_DASHBOARD_URL = 'http://127.0.0.1:3765';

fs.mkdirSync(path.join(runtimeRoot, 'data'), { recursive: true });
const sample = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'sample-settings.json'), 'utf8'));
sample.preferences = { ...(sample.preferences || {}), dashboardPort: 3765, parallelTabs: 1 };
sample.formFill = { mode: 'internal' };
fs.writeFileSync(path.join(runtimeRoot, 'data', 'settings.json'), JSON.stringify(sample, null, 2));

const settings = require('../dist-ts/src/settings-manager');
const dashboard = require('../dist-ts/src/dashboard-server');
const messageBuilder = require('../dist-ts/src/message-builder');
const { normalizeCharacterizationText } = require('../dist-ts/src/characterization-normalizers');
const expected = require('./snapshots/characterization-hashes.json');

function hash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function normalizedHash(value) {
  return hash(normalizeCharacterizationText(value, { roots: [ROOT, runtimeRoot] }));
}

const companies = [
  { no: 1, companyName: '固定テスト株式会社', type: 'IT', url: 'https://example.test', formUrl: 'https://example.test/contact' },
  { no: 2, companyName: '第二固定株式会社', type: '製造', url: 'https://two.example.test', formUrl: 'https://two.example.test/contact' },
  { no: 3, companyName: '第三固定株式会社', type: '物流', url: 'https://three.example.test', formUrl: 'https://three.example.test/contact' },
];
const sender = settings.getSender();
const actual = { prompts: {} };

for (const mode of ['internal', 'playwright']) {
  settings.updateSection('formFill', { mode });
  for (const tabs of [1, 3]) {
    settings.updateSection('preferences', { ...settings.getSection('preferences'), parallelTabs: tabs });
    for (const autoSendSafe of [false, true]) {
      const key = `${mode}-tabs${tabs}-auto${autoSendSafe}`;
      const selected = companies.slice(0, tabs);
      const prompt = dashboard.buildClaudeFormFillPrompt(selected, sender, 'claude', { autoSendSafe });
      const contract = dashboard.buildManagedAiSessionContract('claude', { autoSendSafe });
      const normalized = normalizeCharacterizationText(prompt + '\n---CONTRACT---\n' + contract, {
        roots: [ROOT, runtimeRoot],
      });
      actual.prompts[key] = hash(normalized);
      if (process.env.DUMP_CHARACTERIZATION_DIR) {
        fs.mkdirSync(process.env.DUMP_CHARACTERIZATION_DIR, { recursive: true });
        fs.writeFileSync(path.join(process.env.DUMP_CHARACTERIZATION_DIR, key + '.txt'), normalized);
      }
    }
  }
}

settings.updateSection('formFill', { mode: 'internal' });
settings.updateSection('preferences', { ...settings.getSection('preferences'), parallelTabs: 1 });
actual.page = normalizedHash(dashboard._test.buildPage());

const analysis = {
  companyName: '固定テスト株式会社',
  companyUrl: 'https://example.test',
  companyType: 'IT',
  businessAreas: [
    { label: '業務システム', key: 'business-systems', confidence: 0.9 },
    { label: 'クラウド基盤', key: 'cloud', confidence: 0.8 },
  ],
  focusAreas: ['クラウド移行', '業務効率化'],
  gaps: [
    {
      strength: { label: '開発パートナー体制', key: 'delivery' },
      area: '開発体制',
      description: '開発パートナー拡充',
      relevance: 'high',
    },
  ],
  relevantPatterns: [],
  companyPhrases: ['クラウド移行を一気通貫で支援'],
  metaDescription: '業務システムとクラウド基盤を提供',
  siteTextExcerpt: '固定された会社サイト本文です。',
};
actual.messagePrompt = normalizedHash(messageBuilder.buildMessagePrompt(analysis));
actual.messageFallback = normalizedHash(messageBuilder.buildCustomMessage(analysis));

const tokenA = normalizeCharacterizationText('token=' + 'a'.repeat(48));
const tokenB = normalizeCharacterizationText('token=' + 'b'.repeat(48));
assert.equal(tokenA, tokenB, 'session token changes must normalize away');
assert.equal(
  normalizeCharacterizationText('content=A'),
  'content=A',
  'real content must remain visible to the golden hash',
);
assert.notEqual(
  normalizeCharacterizationText('content=A'),
  normalizeCharacterizationText('content=B'),
  'real content changes must alter the normalized output',
);

if (process.env.PRINT_CHARACTERIZATION === '1') {
  console.log(JSON.stringify(actual, null, 2));
} else {
  assert.deepEqual(actual, expected);
  console.log('characterization hashes match');
}

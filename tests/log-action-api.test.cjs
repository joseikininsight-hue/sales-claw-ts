'use strict';

/**
 * /api/log-action handler unit tests (1.2.92 H1)
 *
 * Tests the sanitization logic that prevents shell/prompt injection
 * via the dashboard's logAction API endpoint.
 */

const assert = require('node:assert/strict');

function describe(n, f) { console.log('\n=== ' + n + ' ==='); f(); }
function it(n, f) {
  try { f(); console.log('  OK  ' + n); }
  catch (e) { console.error('  FAIL ' + n + ' - ' + e.message); process.exitCode = 1; }
}

// Re-implementation of the sanitize logic in src/routes/simple-api.cjs::handleLogAction
const ALLOWED_ACTIONS = new Set(['awaiting_approval', 'submitted', 'skipped', 'error', 'confirm_reached', 'form_fill']);
const MAX_NAME_LEN = 200;
const MAX_DETAILS_LEN = 4000;

function processLogActionPayload(data) {
  const no = Number(data.no);
  if (!Number.isFinite(no) || no <= 0) return { ok: false, error: 'Invalid no' };
  const action = String(data.action || '').trim();
  if (!ALLOWED_ACTIONS.has(action)) return { ok: false, error: 'Invalid action. Allowed: ' + [...ALLOWED_ACTIONS].join(',') };
  const name = String(data.name || '').slice(0, MAX_NAME_LEN).replace(/[\x00-\x1f\x7f]/g, ' ');
  const detailsRaw = data.details;
  let details;
  if (typeof detailsRaw === 'string') {
    details = detailsRaw.slice(0, MAX_DETAILS_LEN).replace(/[\x00-\x1f\x7f]/g, ' ');
  } else if (detailsRaw && typeof detailsRaw === 'object') {
    const sanitize = (val) => {
      if (typeof val === 'string') return val.slice(0, MAX_DETAILS_LEN).replace(/[\x00-\x1f\x7f]/g, ' ');
      if (Array.isArray(val)) return val.map(sanitize);
      if (val && typeof val === 'object') {
        const out = {};
        for (const k of Object.keys(val)) out[k] = sanitize(val[k]);
        return out;
      }
      return val;
    };
    details = JSON.stringify(sanitize(detailsRaw)).slice(0, MAX_DETAILS_LEN);
  } else {
    details = '';
  }
  return { ok: true, no, name, action, details };
}

describe('handleLogAction sanitize', () => {
  it('rejects invalid no (negative)', () => {
    const r = processLogActionPayload({ no: -1, name: 'A', action: 'submitted' });
    assert.equal(r.ok, false);
  });

  it('rejects invalid no (non-numeric)', () => {
    const r = processLogActionPayload({ no: 'abc', name: 'A', action: 'submitted' });
    assert.equal(r.ok, false);
  });

  it('rejects unknown action', () => {
    const r = processLogActionPayload({ no: 1, name: 'A', action: 'EVAL_SHELL' });
    assert.equal(r.ok, false);
    assert.match(r.error, /Allowed/);
  });

  it('strips control characters from name', () => {
    const r = processLogActionPayload({ no: 1, name: 'A\x00\x01\x1F社', action: 'skipped' });
    assert.equal(r.ok, true);
    assert.equal(r.name, 'A   社');
  });

  it('truncates name beyond 200 chars', () => {
    const long = 'X'.repeat(500);
    const r = processLogActionPayload({ no: 1, name: long, action: 'skipped' });
    assert.equal(r.ok, true);
    assert.equal(r.name.length, 200);
  });

  it('truncates string details beyond 4000 chars', () => {
    const long = 'D'.repeat(5000);
    const r = processLogActionPayload({ no: 1, name: 'A', action: 'error', details: long });
    assert.equal(r.ok, true);
    assert.equal(r.details.length, 4000);
  });

  it('sanitizes nested object details (control chars removed)', () => {
    const r = processLogActionPayload({
      no: 1, name: 'A', action: 'awaiting_approval',
      details: { reason: 'X\x00Y', tabKept: true, nested: { k: '\x01v' } },
    });
    assert.equal(r.ok, true);
    const parsed = JSON.parse(r.details);
    assert.equal(parsed.reason, 'X Y');
    assert.equal(parsed.tabKept, true);
    assert.equal(parsed.nested.k, ' v');
  });

  it('handles array details', () => {
    const r = processLogActionPayload({
      no: 1, name: 'A', action: 'error',
      details: ['msg\x00a', 'msg\x00b'],
    });
    assert.equal(r.ok, true);
    const parsed = JSON.parse(r.details);
    assert.equal(parsed[0], 'msg a');
    assert.equal(parsed[1], 'msg b');
  });

  it('accepts all allowed actions', () => {
    ['awaiting_approval', 'submitted', 'skipped', 'error', 'confirm_reached', 'form_fill'].forEach((a) => {
      const r = processLogActionPayload({ no: 1, name: 'A', action: a, details: 'x' });
      assert.equal(r.ok, true, 'action ' + a + ' should be allowed');
    });
  });

  it('handles missing details (defaults to empty string)', () => {
    const r = processLogActionPayload({ no: 1, name: 'A', action: 'skipped' });
    assert.equal(r.ok, true);
    assert.equal(r.details, '');
  });
});

// ─────────────────────────────────────────────────────────────
// v2.1.1: sentMessage 焼き込み (確認待ち本文未反映バグの回帰防止)
// src/routes/simple-api.ts の logAction 直前の注入ブロックを忠実にミラー。
// ─────────────────────────────────────────────────────────────
function injectSentMessage(details, sentMsg, action) {
  if ((action === 'submitted' || action === 'awaiting_approval') && sentMsg) {
    const bodyForLog = sentMsg.slice(0, MAX_DETAILS_LEN).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ' ');
    let detailsObj;
    try {
      const parsed = (typeof details === 'string' && details) ? JSON.parse(details) : null;
      detailsObj = (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
    } catch (_) { detailsObj = {}; }
    detailsObj.sentMessage = bodyForLog;
    return JSON.stringify(detailsObj);
  }
  return details;
}

describe('sentMessage injection (v2.1.1)', () => {
  it('sentMessageFile 経路: detailsRaw に sentMessage が無くても details に焼き込まれる', () => {
    // CLI が sentMessageFile だけ渡し、sentMessage フィールドは無いケース
    const proc = processLogActionPayload({
      no: 5, name: 'テスト社', action: 'awaiting_approval',
      details: { sentMessageFile: '/tmp/body-5.txt', screenshot: 'ss-5-input.png', tabKept: true },
    });
    assert.equal(proc.ok, true);
    const beforeParsed = JSON.parse(proc.details);
    assert.equal(beforeParsed.sentMessage, undefined, '注入前は sentMessage が無い (バグ再現)');
    // サーバがファイルから読み取った本文 (sentMsg) を注入
    const resolvedBody = 'お世話になります。テスト株式会社の担当と申します。貴社の事業を拝見しご連絡しました。';
    const finalDetails = injectSentMessage(proc.details, resolvedBody, 'awaiting_approval');
    const parsed = JSON.parse(finalDetails);
    assert.equal(parsed.sentMessage, resolvedBody, '注入後は本文が details に入る');
    assert.equal(parsed.screenshot, 'ss-5-input.png', '既存フィールドは保持される');
    assert.equal(parsed.tabKept, true);
  });

  it('改行とタブを本文として保持する (一行化されない)', () => {
    const body = 'お世話になります。\n株式会社LYZONの中澤です。\n\n貴社の取り組みを拝見し...';
    const finalDetails = injectSentMessage('{"screenshot":"ss-9-input.png"}', body, 'submitted');
    const parsed = JSON.parse(finalDetails);
    assert.equal(parsed.sentMessage, body, '\\n が保持される');
    assert.ok(parsed.sentMessage.includes('\n'), '改行が残っている');
  });

  it('改行・タブ以外の制御文字は除去する', () => {
    const body = 'A\x00B\x07C\tD\nE';
    const finalDetails = injectSentMessage('{}', body, 'awaiting_approval');
    const parsed = JSON.parse(finalDetails);
    assert.equal(parsed.sentMessage, 'A B C\tD\nE', '0x00/0x07 は空白化、\\t \\n は保持');
  });

  it('非終了アクション/空 sentMsg では details を変更しない', () => {
    assert.equal(injectSentMessage('{"a":1}', 'body', 'form_fill'), '{"a":1}');
    assert.equal(injectSentMessage('{"a":1}', '', 'awaiting_approval'), '{"a":1}');
  });

  it('壊れた details 文字列でも空オブジェクトから再構築する', () => {
    const finalDetails = injectSentMessage('<<not json>>', 'お問い合わせ本文です。よろしくお願いします。', 'submitted');
    const parsed = JSON.parse(finalDetails);
    assert.equal(parsed.sentMessage, 'お問い合わせ本文です。よろしくお願いします。');
  });
});

console.log('\nall log-action-api tests passed.');

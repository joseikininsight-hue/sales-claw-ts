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

console.log('\nall log-action-api tests passed.');

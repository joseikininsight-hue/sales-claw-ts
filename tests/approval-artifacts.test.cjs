'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function describe(n, f) { console.log('\n=== ' + n + ' ==='); f(); }
function it(n, f) {
  try { f(); console.log('  OK  ' + n); }
  catch (e) { console.error('  FAIL ' + n + ' - ' + e.message); process.exitCode = 1; }
}

const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sales-claw-artifacts-'));
process.env.SALES_CLAW_USER_DATA_DIR = runtimeRoot;

const artifacts = require('../dist-ts/src/approval-artifacts');

function touch(filePath, date) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  fs.utimesSync(filePath, date, date);
}

describe('approval artifact freshness', () => {
  it('does not accept stale expected screenshot files when log context exists', () => {
    const companyNo = 777;
    const screenshotPath = path.join(runtimeRoot, 'screenshots', 'ss-' + companyNo + '-input.png');
    const now = new Date('2026-05-05T12:00:00.000Z');
    const stale = new Date(now.getTime() - 3 * 60 * 60 * 1000);
    touch(screenshotPath, stale);

    const formFillLog = { companyNo, action: 'form_fill', timestamp: now.toISOString(), details: '入力完了' };
    const awaitingLog = { companyNo, action: 'awaiting_approval', timestamp: now.toISOString(), details: 'ブラウザタブにフォーム入力済み状態で残っています' };
    const staleStatus = artifacts.getExpectedApprovalArtifacts(companyNo, {
      logs: [formFillLog, awaitingLog],
      formFillLog,
      awaitingLog,
    });
    assert.equal(staleStatus.exists.input, false);

    touch(screenshotPath, now);
    const freshStatus = artifacts.getExpectedApprovalArtifacts(companyNo, {
      logs: [formFillLog, awaitingLog],
      formFillLog,
      awaitingLog,
    });
    assert.equal(freshStatus.exists.input, true);
    assert.equal(freshStatus.readyForManualApproval, true);
  });
});

console.log('\nall approval-artifacts tests passed.');

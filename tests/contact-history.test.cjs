'use strict';

/**
 * Unit tests for src/contact-history.cjs
 *
 * Coverage targets:
 *   - recordContact (first / second / Nth)
 *   - getHistory (existing / missing / clone)
 *   - getContactCount
 *   - getLastMessage
 *   - getAllHistorySummary
 *   - recordResponse (existing / wrong contactNo / wrong companyNo)
 *   - removeHistory (existing / missing)
 *   - JSON corruption fallback (returns {})
 *   - signature-based cache reload
 *
 * Run: node tests/contact-history.test.cjs
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'sales-claw-contact-history-test-'));
process.env.SALES_CLAW_USER_DATA_DIR = sandbox;

function freshRequire(modulePath) {
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];
  return require(modulePath);
}

freshRequire('../dist-ts/src/settings-manager');
freshRequire('../dist-ts/src/data-paths');
const history = freshRequire('../dist-ts/src/contact-history');

let passed = 0;
let failed = 0;
const failures = [];

function assertEq(name, actual, expected) {
  if (actual === expected) { passed += 1; return; }
  failed += 1;
  failures.push({ name, actual, expected });
}
function assertOk(name, value) { assertEq(name, !!value, true); }
function assertNot(name, value) { assertEq(name, !value, true); }
function assertDeep(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passed += 1; return; }
  failed += 1;
  failures.push({ name, actual: a, expected: e });
}

const dataDir = path.join(sandbox, 'data');
const histFile = path.join(dataDir, 'contact-history.json');

function resetHistFile() {
  // Write empty {} + bump mtime forward so the in-module cache (keyed by
  // filePath + mtime/size) is invalidated. Plain unlink would leave the
  // cache returning stale data on the next read because both the saved
  // signature and the new "missing-file" signature are null.
  try { fs.mkdirSync(dataDir, { recursive: true }); } catch (_) {}
  fs.writeFileSync(histFile, '{}', 'utf-8');
  resetHistFile._tick = (resetHistFile._tick || 0) + 1;
  const ts = new Date(Date.now() + resetHistFile._tick * 60000);
  fs.utimesSync(histFile, ts, ts);
}

// ─────────────────────────────────────────────────────────────
// 1. recordContact: first contact returns 1, file created
// ─────────────────────────────────────────────────────────────
{
  resetHistFile();
  const n = history.recordContact(1, 'テスト株式会社', {
    message: '初回ご連絡',
    formUrl: 'https://example.com/contact',
  });
  assertEq('first recordContact returns 1', n, 1);
  assertOk('contact-history.json created', fs.existsSync(histFile));

  const raw = JSON.parse(fs.readFileSync(histFile, 'utf-8'));
  assertOk('history keyed by companyNo string', !!raw['1']);
  assertEq('companyName persisted', raw['1'].companyName, 'テスト株式会社');
  assertEq('contacts has 1 entry', raw['1'].contacts.length, 1);
  assertEq('first contactNo = 1', raw['1'].contacts[0].contactNo, 1);
  assertEq('default method = web_form', raw['1'].contacts[0].method, 'web_form');
  assertEq('default response = null', raw['1'].contacts[0].response, null);
}

// ─────────────────────────────────────────────────────────────
// 2. recordContact: second / third
// ─────────────────────────────────────────────────────────────
{
  const n2 = history.recordContact(1, 'テスト株式会社', { message: '2回目', method: 'email' });
  assertEq('second recordContact returns 2', n2, 2);
  const n3 = history.recordContact(1, 'テスト株式会社', { message: '3回目' });
  assertEq('third recordContact returns 3', n3, 3);
  const h = history.getHistory(1);
  assertEq('total contacts = 3', h.contacts.length, 3);
  assertEq('second method respected', h.contacts[1].method, 'email');
}

// ─────────────────────────────────────────────────────────────
// 3. recordContact uses provided timestamp
// ─────────────────────────────────────────────────────────────
{
  resetHistFile();
  const ts = '2026-05-01T10:00:00.000Z';
  history.recordContact(2, 'TS社', { message: 'x', timestamp: ts });
  const h = history.getHistory(2);
  assertEq('timestamp preserved', h.contacts[0].date, ts);
}
{
  // sentAt fallback
  const sentAt = '2026-05-02T10:00:00.000Z';
  history.recordContact(3, 'Sent社', { message: 'y', sentAt });
  const h = history.getHistory(3);
  assertEq('sentAt used when timestamp absent', h.contacts[0].date, sentAt);
}
{
  // Neither timestamp nor sentAt → ISO of now
  history.recordContact(4, 'Now社', { message: 'z' });
  const h = history.getHistory(4);
  assertOk('ISO date generated when neither set', /^\d{4}-\d{2}-\d{2}T/.test(h.contacts[0].date));
}

// ─────────────────────────────────────────────────────────────
// 4. recordContact preserves all optional fields
// ─────────────────────────────────────────────────────────────
{
  resetHistFile();
  history.recordContact(10, 'Full社', {
    message: 'full',
    formUrl: 'https://example.com/form',
    method: 'web_form',
    notes: 'メモ',
    screenshot: 'screenshots/ss-10-input.png',
    sourceAction: 'awaiting_approval',
    sourceActionAt: '2026-05-01T00:00:00Z',
    status: 'submitted',
  });
  const h = history.getHistory(10);
  const c = h.contacts[0];
  assertEq('formUrl', c.formUrl, 'https://example.com/form');
  assertEq('notes', c.notes, 'メモ');
  assertEq('screenshot', c.screenshot, 'screenshots/ss-10-input.png');
  assertEq('sourceAction', c.sourceAction, 'awaiting_approval');
  assertEq('sourceActionAt', c.sourceActionAt, '2026-05-01T00:00:00Z');
  assertEq('status', c.status, 'submitted');
}

// ─────────────────────────────────────────────────────────────
// 5. getHistory: missing companyNo → null
// ─────────────────────────────────────────────────────────────
{
  const none = history.getHistory(99999);
  assertEq('missing company returns null', none, null);
}

// ─────────────────────────────────────────────────────────────
// 6. getHistory returns deep clone
// ─────────────────────────────────────────────────────────────
{
  const h1 = history.getHistory(10);
  h1.contacts[0].message = 'mutated';
  const h2 = history.getHistory(10);
  assertNot('mutation does not affect cache', h2.contacts[0].message === 'mutated');
}

// ─────────────────────────────────────────────────────────────
// 7. getContactCount
// ─────────────────────────────────────────────────────────────
{
  assertEq('contact count for company 10 = 1', history.getContactCount(10), 1);
  assertEq('contact count for missing = 0', history.getContactCount(99999), 0);
}

// ─────────────────────────────────────────────────────────────
// 8. getLastMessage
// ─────────────────────────────────────────────────────────────
{
  resetHistFile();
  // missing
  assertEq('getLastMessage missing = null', history.getLastMessage(1), null);

  history.recordContact(1, 'X', { message: 'first' });
  assertEq('getLastMessage = first after 1 contact', history.getLastMessage(1), 'first');
  history.recordContact(1, 'X', { message: 'second' });
  assertEq('getLastMessage = second after 2 contacts', history.getLastMessage(1), 'second');
  history.recordContact(1, 'X', { message: 'third' });
  assertEq('getLastMessage = third after 3 contacts', history.getLastMessage(1), 'third');
}

// ─────────────────────────────────────────────────────────────
// 9. getAllHistorySummary
// ─────────────────────────────────────────────────────────────
{
  resetHistFile();
  history.recordContact(1, 'A社', { message: 'a1' });
  history.recordContact(1, 'A社', { message: 'a2' });
  history.recordContact(2, 'B社', { message: 'b1' });
  history.recordContact(3, 'C社', { message: 'c1' });

  const summary = history.getAllHistorySummary();
  assertEq('summary has 3 companies', summary.length, 3);
  const a = summary.find(s => s.companyNo === 1);
  assertEq('A社 contactCount = 2', a.contactCount, 2);
  assertEq('A社 lastContactNo = 2', a.lastContactNo, 2);
  assertOk('A社 lastDate is set', !!a.lastDate);
  const b = summary.find(s => s.companyNo === 2);
  assertEq('B社 contactCount = 1', b.contactCount, 1);
}

// ─────────────────────────────────────────────────────────────
// 10. getAllHistorySummary on empty
// ─────────────────────────────────────────────────────────────
{
  resetHistFile();
  const summary = history.getAllHistorySummary();
  assertDeep('empty summary = []', summary, []);
}

// ─────────────────────────────────────────────────────────────
// 11. recordResponse: success
// ─────────────────────────────────────────────────────────────
{
  resetHistFile();
  history.recordContact(1, 'R社', { message: 'init' });
  const ok = history.recordResponse(1, 1, '返信あり', 'メモ追記');
  assertEq('recordResponse returns true on success', ok, true);
  const h = history.getHistory(1);
  assertEq('contact response set', h.contacts[0].response, '返信あり');
  assertEq('contact notes set', h.contacts[0].notes, 'メモ追記');
  assertOk('responseDate set', !!h.contacts[0].responseDate);
}

// ─────────────────────────────────────────────────────────────
// 12. recordResponse: notes default to existing notes when not provided
// ─────────────────────────────────────────────────────────────
{
  resetHistFile();
  history.recordContact(1, 'R社', { message: 'init', notes: '既存メモ' });
  history.recordResponse(1, 1, '返信あり');
  const h = history.getHistory(1);
  assertEq('existing notes preserved when notes arg omitted', h.contacts[0].notes, '既存メモ');
}

// ─────────────────────────────────────────────────────────────
// 13. recordResponse: missing company → false
// ─────────────────────────────────────────────────────────────
{
  const ok = history.recordResponse(99999, 1, 'X');
  assertEq('recordResponse missing company = false', ok, false);
}

// ─────────────────────────────────────────────────────────────
// 14. recordResponse: missing contactNo → false
// ─────────────────────────────────────────────────────────────
{
  resetHistFile();
  history.recordContact(1, 'R社', { message: 'init' });
  const ok = history.recordResponse(1, 99, 'X');
  assertEq('recordResponse wrong contactNo = false', ok, false);
}

// ─────────────────────────────────────────────────────────────
// 15. removeHistory: success
// ─────────────────────────────────────────────────────────────
{
  resetHistFile();
  history.recordContact(1, 'D社', { message: 'd' });
  const ok = history.removeHistory(1);
  assertEq('removeHistory returns true', ok, true);
  assertEq('history is gone', history.getHistory(1), null);
}

// ─────────────────────────────────────────────────────────────
// 16. removeHistory: missing → false
// ─────────────────────────────────────────────────────────────
{
  const ok = history.removeHistory(99999);
  assertEq('removeHistory on missing returns false', ok, false);
}

// ─────────────────────────────────────────────────────────────
// 17. JSON corruption: .bak から復元、無ければ {} フォールバック (#3 根本原因5)
// ─────────────────────────────────────────────────────────────
{
  // 17a: 正常書き込みで .bak が育っている状態で破損 → .bak から自動復元する
  resetHistFile();
  history.recordContact(7, 'BakSrc', { message: 'pre-corrupt' });
  history.recordContact(7, 'BakSrc', { message: 'second' }); // 直前の正常値が .bak に退避
  fs.writeFileSync(histFile, '<<broken json>>', 'utf-8');     // 本体を破損
  const restored = history.getAllHistorySummary();
  assertEq(
    'corrupt JSON restored from .bak (company present)',
    restored.some((e) => String(e.companyNo) === '7'),
    true,
  );

  // 17b: .bak が無ければ破損時は {} フォールバック (.corrupt へ退避してから空)
  resetHistFile();
  try { fs.unlinkSync(histFile + '.bak'); } catch (_) {}
  fs.writeFileSync(histFile, '<<broken json>>', 'utf-8');
  const summary = history.getAllHistorySummary();
  assertDeep('corrupt JSON without .bak yields empty summary', summary, []);
  // recording should still work (append on empty {})
  const n = history.recordContact(5, 'PostCorrupt', { message: 'after corrupt' });
  assertEq('recordContact works after corruption returns 1', n, 1);
}

// ─────────────────────────────────────────────────────────────
// 18. Cache invalidation via signature change
// ─────────────────────────────────────────────────────────────
{
  resetHistFile();
  history.recordContact(1, 'CacheTest', { message: 'm1' });
  // External overwrite
  const external = {
    '1': { companyNo: 1, companyName: 'CacheTest', contacts: [
      { contactNo: 1, date: '2026-05-01T00:00:00Z', message: 'm1', formUrl: '', method: 'web_form', response: null, notes: '', screenshot: '', sourceAction: '', sourceActionAt: '', status: '' },
      { contactNo: 2, date: '2026-05-02T00:00:00Z', message: 'm-external', formUrl: '', method: 'email', response: null, notes: '', screenshot: '', sourceAction: '', sourceActionAt: '', status: '' },
    ] },
    '2': { companyNo: 2, companyName: 'NewExternal', contacts: [
      { contactNo: 1, date: '2026-05-03T00:00:00Z', message: 'ext', formUrl: '', method: 'web_form', response: null, notes: '', screenshot: '', sourceAction: '', sourceActionAt: '', status: '' },
    ] },
  };
  fs.writeFileSync(histFile, JSON.stringify(external, null, 2), 'utf-8');
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(histFile, future, future);

  const last = history.getLastMessage(1);
  assertEq('external write reflected', last, 'm-external');
  const summary = history.getAllHistorySummary();
  assertEq('external company visible', summary.length, 2);
}

// ─────────────────────────────────────────────────────────────
// 19. recordResponse cleanup post-corruption (defensive path)
// ─────────────────────────────────────────────────────────────
{
  resetHistFile();
  fs.writeFileSync(histFile, 'garbage{', 'utf-8');
  const ok = history.recordResponse(1, 1, 'X');
  assertEq('recordResponse on corrupt-then-empty file = false', ok, false);
}

// ─────────────────────────────────────────────────────────────
// Cleanup
// ─────────────────────────────────────────────────────────────
try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch (_) {}

// ─────────────────────────────────────────────────────────────
// Output
// ─────────────────────────────────────────────────────────────
console.log('');
console.log(`PASSED: ${passed}`);
console.log(`FAILED: ${failed}`);
if (failed > 0) {
  for (const f of failures) {
    console.log(`  FAIL: ${f.name}`);
    console.log(`    actual:   ${typeof f.actual === 'string' ? f.actual : JSON.stringify(f.actual)}`);
    console.log(`    expected: ${typeof f.expected === 'string' ? f.expected : JSON.stringify(f.expected)}`);
  }
  process.exitCode = 1;
} else {
  console.log('all contact-history tests passed.');
}

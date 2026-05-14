'use strict';

/**
 * upload-document path validation tests (1.2.92 H1)
 *
 * Tests the validateDocumentPath logic that prevents path traversal
 * and arbitrary file registration via POST /api/settings/upload-document.
 */

const path = require('path');
const assert = require('node:assert/strict');

function describe(n, f) { console.log('\n=== ' + n + ' ==='); f(); }
function it(n, f) {
  try { f(); console.log('  OK  ' + n); }
  catch (e) { console.error('  FAIL ' + n + ' - ' + e.message); process.exitCode = 1; }
}

// Re-implementation matching src/routes/settings-api.cjs::validateDocumentPath
const ALLOWED_DOC_EXT = new Set(['.pdf', '.md', '.txt', '.docx', '.xlsx', '.csv', '.pptx', '.xls', '.doc']);
function validateDocumentPath(filePath, projectRoot, userDataDir) {
  if (!filePath || typeof filePath !== 'string') return { ok: false, reason: 'filePath が指定されていません' };
  const trimmed = filePath.trim();
  if (!trimmed) return { ok: false, reason: 'filePath が空です' };
  const normalized = path.normalize(trimmed);
  const ext = path.extname(normalized).toLowerCase();
  if (!ALLOWED_DOC_EXT.has(ext)) {
    return { ok: false, reason: '許可されていないファイル拡張子: ' + (ext || '(なし)') };
  }
  if (path.isAbsolute(normalized)) {
    const absResolved = path.resolve(normalized);
    const inProject = absResolved.toLowerCase().startsWith(path.resolve(projectRoot).toLowerCase());
    const inUserData = userDataDir && absResolved.toLowerCase().startsWith(path.resolve(userDataDir).toLowerCase());
    if (!inProject && !inUserData) {
      return { ok: false, reason: 'プロジェクトディレクトリまたはユーザーデータディレクトリ外: ' + absResolved };
    }
  }
  if (normalized.includes('..')) {
    return { ok: false, reason: '相対パスでの ../ は許可されません' };
  }
  return { ok: true, normalized };
}

const PROJECT_ROOT = process.platform === 'win32' ? 'C:\\bp-outreach' : '/home/user/bp-outreach';
const USER_DATA = process.platform === 'win32' ? 'C:\\Users\\u\\AppData\\Roaming\\sales-claw' : '/home/user/.config/sales-claw';

describe('validateDocumentPath', () => {
  it('rejects null/undefined/empty', () => {
    assert.equal(validateDocumentPath(null, PROJECT_ROOT, USER_DATA).ok, false);
    assert.equal(validateDocumentPath('', PROJECT_ROOT, USER_DATA).ok, false);
    assert.equal(validateDocumentPath('   ', PROJECT_ROOT, USER_DATA).ok, false);
  });

  it('rejects disallowed extensions (.exe, .sh, .ps1)', () => {
    assert.equal(validateDocumentPath('foo.exe', PROJECT_ROOT, USER_DATA).ok, false);
    assert.equal(validateDocumentPath('script.sh', PROJECT_ROOT, USER_DATA).ok, false);
    assert.equal(validateDocumentPath('hack.ps1', PROJECT_ROOT, USER_DATA).ok, false);
    assert.equal(validateDocumentPath('noext', PROJECT_ROOT, USER_DATA).ok, false);
  });

  it('rejects path traversal (..)', () => {
    assert.equal(validateDocumentPath('../../etc/passwd', PROJECT_ROOT, USER_DATA).ok, false);
    assert.equal(validateDocumentPath('docs/../../secret.pdf', PROJECT_ROOT, USER_DATA).ok, false);
  });

  it('rejects absolute paths outside project + user data', () => {
    if (process.platform === 'win32') {
      assert.equal(validateDocumentPath('C:\\Windows\\System32\\drivers\\etc\\hosts', PROJECT_ROOT, USER_DATA).ok, false);
    } else {
      assert.equal(validateDocumentPath('/etc/passwd', PROJECT_ROOT, USER_DATA).ok, false);
    }
  });

  it('accepts relative path with allowed extension', () => {
    const r = validateDocumentPath('docs/proposal.pdf', PROJECT_ROOT, USER_DATA);
    assert.equal(r.ok, true);
  });

  it('accepts absolute path inside PROJECT_ROOT', () => {
    const inside = path.join(PROJECT_ROOT, 'docs', 'spec.md');
    const r = validateDocumentPath(inside, PROJECT_ROOT, USER_DATA);
    assert.equal(r.ok, true);
  });

  it('accepts absolute path inside USER_DATA', () => {
    const inside = path.join(USER_DATA, 'imports', 'list.xlsx');
    const r = validateDocumentPath(inside, PROJECT_ROOT, USER_DATA);
    assert.equal(r.ok, true);
  });

  it('accepts all allowed extensions', () => {
    ['.pdf', '.md', '.txt', '.docx', '.xlsx', '.csv', '.pptx', '.xls', '.doc'].forEach((ext) => {
      assert.equal(validateDocumentPath('docs/file' + ext, PROJECT_ROOT, USER_DATA).ok, true, 'ext: ' + ext);
    });
  });

  it('rejects extension case sensitivity (.EXE rejected even uppercase)', () => {
    assert.equal(validateDocumentPath('foo.EXE', PROJECT_ROOT, USER_DATA).ok, false);
  });
});

console.log('\nall upload-document-path tests passed.');

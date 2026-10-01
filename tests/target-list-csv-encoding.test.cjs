'use strict';

// v2.2.0: CSV の文字コード判定 (BOM 無し UTF-8 / BOM 付き UTF-8 / Shift_JIS)。
// 旧実装は SheetJS に Buffer をそのまま渡しており、BOM 無し UTF-8 の日本語が
// Latin-1 として解釈されて全件文字化けしていた。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sales-claw-csv-enc-'));
process.env.SALES_CLAW_USER_DATA_DIR = runtimeRoot;

const { decodeCsvBuffer } = require('../dist-ts/src/target-list');
const XLSX = require('xlsx');

const text = 'No.,Company\n1,株式会社アルファ技研\n2,ベータ商事\n';

function firstCompany(decoded) {
  const wb = XLSX.read(decoded, { type: 'string', raw: false, defval: '' });
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });
  return rows[1][1];
}

// UTF-8 (BOM 無し) — Google スプレッドシート / Mac の既定
assert.equal(firstCompany(decodeCsvBuffer(Buffer.from(text, 'utf8'))), '株式会社アルファ技研');
console.log('  OK  UTF-8 without BOM');

// UTF-8 (BOM 付き) — Excel の「CSV UTF-8」
assert.equal(firstCompany(decodeCsvBuffer(Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(text, 'utf8')]))), '株式会社アルファ技研');
console.log('  OK  UTF-8 with BOM');

// Shift_JIS — Excel 日本語版の「CSV (コンマ区切り)」。「株式」= 0x8A94 0x8EAE
const sjis = Buffer.concat([
  Buffer.from('No.,Company\n1,', 'ascii'),
  Buffer.from([0x8A, 0x94, 0x8E, 0xAE]),
  Buffer.from('\n', 'ascii'),
]);
assert.equal(firstCompany(decodeCsvBuffer(sjis)), '株式');
console.log('  OK  Shift_JIS');

// UTF-16LE (BOM FF FE) — Excel の「Unicode テキスト」をリネームしたもの
assert.equal(firstCompany(decodeCsvBuffer(Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(text, 'utf16le')]))), '株式会社アルファ技研');
console.log('  OK  UTF-16LE with BOM');

console.log('all target-list csv encoding tests passed.');

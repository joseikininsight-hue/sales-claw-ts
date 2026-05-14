// title 文字列内のリテラル \n (バックスラッシュ + n の 2 文字) を空白に置換する
// 単発スクリプト。
const fs = require('fs');
const file = process.argv[2] || 'components/sections/scroll-animations.tsx';
let c = fs.readFileSync(file, 'utf8');

// title: '〜\n〜' を含む行のみマッチ。リテラルの改行 (実際の \n) はファイル中の
// JS 文字列リテラルの '\\n' (バックスラッシュ+n) で表されるので、ソース上は 2 文字。
// JS 正規表現で 2 文字をマッチさせるには /\\n/ と書く (バックスラッシュ自体をエスケープ)。
const re = /(title: '[^']*?)\\n([^']*?')/g;

const before = (c.match(re) || []).length;
c = c.replace(re, '$1 $2');
// 二重に出現しているケースも処理 (例: 'A\nB\nC' のような 3 行)
const re2 = /(title: '[^']*?)\\n([^']*?')/g;
let pass = 0;
while (re2.test(c) && pass < 5) {
  c = c.replace(re2, '$1 $2');
  pass++;
}

fs.writeFileSync(file, c, 'utf8');
const after = (c.match(re) || []).length;
console.log(`replaced ${before} title \\n occurrences (${pass} additional passes), remaining: ${after}`);

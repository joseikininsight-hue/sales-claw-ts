#!/usr/bin/env node
// アイコンファイルを生成するスクリプト
// 使い方: node assets/generate-icons.js
//
// 本番用は icon.png (1024x1024) を用意してこのスクリプトで変換する
// 依存: npm install -g electron-icon-builder  または  npm install sharp

const fs = require('fs');
const path = require('path');

console.log('アイコン生成スクリプト');
console.log('=====================');
console.log('');
console.log('本番用アイコンを用意する場合:');
console.log('  1. 1024x1024 の PNG ファイルを assets/icon-source.png に置く');
console.log('  2. 以下を実行:');
console.log('     npx electron-icon-builder --input=assets/icon-source.png --output=assets');
console.log('');
console.log('生成が必要なファイル:');
console.log('  assets/icon.ico   (Windows 用)');
console.log('  assets/icon.icns  (macOS 用)');
console.log('  assets/icon.png   (Linux / トレイ用, 512x512 推奨)');
console.log('  assets/tray.png   (トレイ用, 16x16 または 22x22)');
console.log('');

// プレースホルダー PNG (1x1 透明) を生成（ビルドエラー回避用）
const placeholder1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

const files = ['icon.png', 'tray.png'];
files.forEach(f => {
  const p = path.join(__dirname, f);
  if (!fs.existsSync(p)) {
    fs.writeFileSync(p, placeholder1x1);
    console.log(`プレースホルダーを作成: ${f}`);
  } else {
    console.log(`スキップ（既存）: ${f}`);
  }
});

console.log('\n.ico / .icns は electron-icon-builder で生成してください。');

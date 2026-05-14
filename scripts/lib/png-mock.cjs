'use strict';

/**
 * 外部依存なしで「フォーム入力済み風スクリーンショット PNG」を生成する。
 * Node の zlib 標準だけで PNG (8bit RGB) を構築。
 *
 * 描画はテキストなしの矩形のみ (canvas 不使用)。
 * ヘッダー帯・カード・フォームフィールド・ボタンを矩形で構成し、
 * 「フォームに値が入っている」印象を与えるレイアウトにする。
 */

const zlib = require('zlib');

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      const m = -(crc & 1);
      crc = (crc >>> 1) ^ (0xEDB88320 & m);
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function rawRgbToPng(raw, width, height) {
  // raw は 各行の先頭に filter byte (=0) が入った RGB バッファ
  const compressed = zlib.deflateSync(raw);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8]  = 8;  // bit depth
  ihdr[9]  = 2;  // color type: RGB
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function makeFormMockPng(opts = {}) {
  const width  = opts.width  || 1200;
  const height = opts.height || 720;
  const accent = opts.accent || [37, 99, 235]; // blue

  const stride = width * 3;
  const rowLen = stride + 1;
  const raw = Buffer.alloc(rowLen * height);

  function fillRect(x0, y0, w, h, color) {
    const x1 = Math.max(0, Math.min(width,  x0));
    const y1 = Math.max(0, Math.min(height, y0));
    const x2 = Math.max(0, Math.min(width,  x0 + w));
    const y2 = Math.max(0, Math.min(height, y0 + h));
    for (let y = y1; y < y2; y++) {
      const rowOffset = y * rowLen + 1;
      for (let x = x1; x < x2; x++) {
        const o = rowOffset + x * 3;
        raw[o]     = color[0];
        raw[o + 1] = color[1];
        raw[o + 2] = color[2];
      }
    }
  }

  function fillGradientV(x0, y0, w, h, c1, c2) {
    for (let y = 0; y < h; y++) {
      const t = h <= 1 ? 0 : y / (h - 1);
      const r = Math.round(c1[0] + (c2[0] - c1[0]) * t);
      const g = Math.round(c1[1] + (c2[1] - c1[1]) * t);
      const b = Math.round(c1[2] + (c2[2] - c1[2]) * t);
      fillRect(x0, y0 + y, w, 1, [r, g, b]);
    }
  }

  // 背景全体: 薄い青グレー
  fillRect(0, 0, width, height, [241, 245, 252]);

  // ブラウザバー (上部)
  fillRect(0, 0, width, 36, [232, 236, 244]);
  fillRect(20, 12, 12, 12, [239, 90, 90]);
  fillRect(40, 12, 12, 12, [240, 196, 88]);
  fillRect(60, 12, 12, 12, [98,  200, 100]);
  // URL バー
  fillRect(110, 8, width - 220, 20, [255, 255, 255]);
  fillRect(120, 14, 280, 8, [203, 213, 225]);

  // ヘッダー帯 (グラデーション)
  fillGradientV(0, 36, width, 110, accent, [
    Math.max(0, accent[0] - 30),
    Math.max(0, accent[1] - 30),
    Math.max(0, accent[2] - 30),
  ]);
  // ロゴ風白い四角
  fillRect(60, 70, 44, 44, [255, 255, 255]);
  fillRect(72, 82, 20, 20, accent);
  // ヘッダーのタイトル風バー
  fillRect(120, 78, 240, 14, [255, 255, 255]);
  fillRect(120, 102, 360, 8, [191, 219, 254]);

  // メインカード
  const cardX = 80;
  const cardY = 180;
  const cardW = width - 160;
  const cardH = height - 220;
  fillRect(cardX - 4, cardY - 4, cardW + 8, cardH + 8, [226, 232, 240]); // shadow ring
  fillRect(cardX, cardY, cardW, cardH, [255, 255, 255]);

  // カード上部の見出し帯
  fillRect(cardX, cardY, cardW, 56, [248, 250, 252]);
  fillRect(cardX + 28, cardY + 18, 220, 18, [30, 41, 59]);
  fillRect(cardX + 28, cardY + 42, 360, 8, [148, 163, 184]);

  // 入力フォームの各行 (ラベル + フィールド + 入力済み値)
  const fields = [
    { labelW: 120, valueRatio: 0.55 },
    { labelW: 160, valueRatio: 0.42 },
    { labelW: 140, valueRatio: 0.68 },
    { labelW: 160, valueRatio: 0.50 },
    { labelW: 180, valueRatio: 0.78 }, // 本文 (長め)
  ];
  let cursorY = cardY + 90;
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    const isTextarea = i === fields.length - 1;
    const fieldH = isTextarea ? 110 : 38;

    // label
    fillRect(cardX + 32, cursorY,       f.labelW, 12, [71, 85, 105]);
    // field background
    fillRect(cardX + 32, cursorY + 22,  cardW - 64, fieldH, [248, 250, 252]);
    // field border
    fillRect(cardX + 32, cursorY + 22,  cardW - 64, 1,      [203, 213, 225]);
    fillRect(cardX + 32, cursorY + 22 + fieldH - 1, cardW - 64, 1, [203, 213, 225]);
    fillRect(cardX + 32, cursorY + 22,  1, fieldH, [203, 213, 225]);
    fillRect(cardX + cardW - 33, cursorY + 22, 1, fieldH, [203, 213, 225]);
    // 入力済み値 (灰色のテキスト風バー)
    if (isTextarea) {
      fillRect(cardX + 44, cursorY + 36,  (cardW - 100) * 0.92, 10, [100, 116, 139]);
      fillRect(cardX + 44, cursorY + 56,  (cardW - 100) * 0.88, 10, [100, 116, 139]);
      fillRect(cardX + 44, cursorY + 76,  (cardW - 100) * 0.74, 10, [100, 116, 139]);
      fillRect(cardX + 44, cursorY + 96,  (cardW - 100) * 0.45, 10, [100, 116, 139]);
    } else {
      fillRect(cardX + 44, cursorY + 36, (cardW - 100) * f.valueRatio, 10, [51, 65, 85]);
    }

    cursorY += fieldH + 36;
  }

  // 送信ボタン
  const btnW = 200;
  const btnH = 46;
  const btnX = cardX + cardW - btnW - 32;
  const btnY = cardY + cardH - btnH - 28;
  fillRect(btnX, btnY, btnW, btnH, accent);
  fillRect(btnX + 50, btnY + 18, btnW - 100, 10, [255, 255, 255]);

  // チェック OK バッジ (右上)
  fillRect(cardX + cardW - 92, cardY + 14, 60, 28, [187, 247, 208]);
  fillRect(cardX + cardW - 80, cardY + 22, 6,  6,  [21, 128, 61]);
  fillRect(cardX + cardW - 70, cardY + 22, 26, 6,  [21, 128, 61]);

  return rawRgbToPng(raw, width, height);
}

module.exports = { makeFormMockPng };

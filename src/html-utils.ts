// サーバ側 HTML 文字列ユーティリティ (単一ソース)。
//
// 注: ブラウザに出荷される <script> 文字列内に埋め込まれるクライアント側の
//   同名関数 (list-builder-page.ts:540, ui/client-scripts/* 等) は Node module を
//   import できないため、ここには集約しない (意図的に別物)。
//
// decodeHtml / stripTags はファイル間で実装がドリフトしている
//   (例: official-site-resolver の decodeHtml は数値実体 &#x..; / &#..; も復号するが
//    form-url-resolver 版は復号しない)。統一は「全箇所で数値実体を復号してよいか」の
//   挙動判断を伴うため、本ユーティリティへの集約は別コミットで行う (P2-8 残)。

/**
 * HTML 特殊文字をエスケープする (テキストを HTML 本文/属性に安全に埋める)。
 * & < > " ' を実体参照に変換。null/undefined は空文字。
 */
export function escapeHtml(s: unknown): string {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

module.exports = { escapeHtml };

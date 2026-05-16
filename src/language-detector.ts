// 言語自動判定 (Phase 2)
//
// 入力 HTML から対象サイトの言語を判定する。判定優先順位:
//   1. <html lang="..."> 属性 (confidence 0.9)
//   2. <meta http-equiv="content-language" content="..."> (confidence 0.9)
//   3. 本文の CJK (漢字・かな) 文字比率が 10% 以上 → 'ja' (confidence 0.7)
//   4. フォールバック → 'en' (confidence 0.3, source: 'default')
//
// Phase 3 で company-analyzer / form-finder / sendability-gate から呼び出される
// 想定。本ファイルは pure function のみで I/O を持たない。

import type { LanguageDetectionResult, Locale } from './types/locale';

const HTML_LANG_RE = /<html\b[^>]*\blang\s*=\s*["']([^"']+)["']/i;
const META_CONTENT_LANG_RE =
  /<meta\b[^>]*\bhttp-equiv\s*=\s*["']content-language["'][^>]*\bcontent\s*=\s*["']([^"']+)["']/i;

// 1 文字単位で CJK Unified Ideographs / Hiragana / Katakana を判定する。
// 中国語・韓国語混在の場合も「非英語」として 'ja' に倒す (Phase 2 では ja/en 2 値のみ)。
function isCjkChar(ch: string): boolean {
  const code = ch.charCodeAt(0);
  // CJK Unified Ideographs (主に漢字)
  if (code >= 0x4e00 && code <= 0x9fff) return true;
  // Hiragana
  if (code >= 0x3040 && code <= 0x309f) return true;
  // Katakana
  if (code >= 0x30a0 && code <= 0x30ff) return true;
  // CJK Symbols and Punctuation
  if (code >= 0x3000 && code <= 0x303f) return true;
  return false;
}

function normalizeLangTag(tag: string): Locale | 'other' {
  const lower = tag.toLowerCase().trim();
  if (lower.startsWith('ja')) return 'ja';
  if (lower.startsWith('en')) return 'en';
  return 'other';
}

function stripHtmlForBody(html: string): string {
  // <script> / <style> を除去してから tag を剥がす。CJK 比率は body 相当のテキストで計る。
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
}

export function detectLanguage(html: string): LanguageDetectionResult {
  const safe = typeof html === 'string' ? html : '';

  // 1. <html lang="...">
  const htmlLangMatch = HTML_LANG_RE.exec(safe);
  if (htmlLangMatch && htmlLangMatch[1]) {
    const lang = normalizeLangTag(htmlLangMatch[1]);
    if (lang !== 'other') {
      return { language: lang, confidence: 0.9, source: 'html-lang' };
    }
  }

  // 2. <meta http-equiv="content-language">
  const metaMatch = META_CONTENT_LANG_RE.exec(safe);
  if (metaMatch && metaMatch[1]) {
    const lang = normalizeLangTag(metaMatch[1]);
    if (lang !== 'other') {
      return { language: lang, confidence: 0.9, source: 'meta-content-language' };
    }
  }

  // 3. CJK 比率
  const text = stripHtmlForBody(safe).replace(/\s+/g, '');
  if (text.length > 0) {
    let cjk = 0;
    for (const ch of text) {
      if (isCjkChar(ch)) cjk += 1;
    }
    const ratio = cjk / text.length;
    if (ratio > 0.1) {
      return { language: 'ja', confidence: 0.7, source: 'cjk-ratio' };
    }
  }

  // 4. フォールバック
  return { language: 'en', confidence: 0.3, source: 'default' };
}

module.exports = { detectLanguage };

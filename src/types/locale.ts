// Locale Pack — Phase 2 基盤
//
// Sales Claw は日本語企業を主な対象として開発されたが、英語圏 (US/EU) や
// 多言語サイトにも対応するため、ロケール固有のキーワード辞書・除外フレーズ・
// フォーム探索ヒントを Locale Pack として分離する。
//
// 本ファイルは Locale 関連の型定義のみを保持し、実装は src/locale-pack/* に置く。

export type Locale = 'ja' | 'en';

export type Country = 'ja-jp' | 'en-us' | 'en-eu' | 'other';

export interface LanguageDetectionResult {
  /** 判定された言語。判定不能なら 'other'。 */
  language: Locale | 'other';
  /** 信頼度 0-1。html lang 優先、CJK 比率、デフォルトの順で下がる。 */
  confidence: number;
  /** 判定根拠。デバッグ・ログ用。 */
  source: 'html-lang' | 'meta-content-language' | 'cjk-ratio' | 'default';
}

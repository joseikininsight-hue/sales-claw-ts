'use strict';

/**
 * Onboarding Wizard renderer.
 *
 * 初回起動 (settings.json に _onboardedAt が無い) のときに dashboard が
 * 自動でこのページに飛ばす 5 ステップウィザード。
 *
 * Steps:
 *   1. ようこそ + 利用規約 (OSS なので自己責任) の同意
 *   2. 自社情報 (companyProfile)
 *   3. 自社の強み (valuePropositions.strengths)
 *   4. ターゲットリスト (Excel/CSV ドラッグ&ドロップ、スキップ可)
 *   5. AI 認証 (Claude / Codex / Gemini ログイン状態確認)
 *   完了 → settings.json に書き込み + _onboardedAt を ISO で記録 → 通常ダッシュボード
 *
 * 状態は localStorage + サーバ側 data/onboarding-progress.json に保存して
 * リロードでも続きから再開できる。
 *
 * 2.0.2: デザインを写真通りに刷新 (horizontal stepper + 汎用 preset 拡充
 * + 詳細利用規約 + AI provider 公式 SVG アイコン)
 */

/**
 * 汎用テンプレート的に使える強みプリセット (18種)。
 * 業種に偏らないよう IT / 営業 / コンサル / 製造 / 専門サービス を網羅。
 * ユーザーは「自社の強み」として 1〜2 個チェックする想定。
 */
const PRESET_STRENGTHS = [
  // IT / Web / Tech 系
  { key: 'web_app',     label: 'Web アプリ開発',       detail: 'フロントエンド / バックエンド / API の業務系 Web 開発',           keywords: ['webアプリ', 'システム開発', 'フロントエンド', 'バックエンド', 'api', 'react', 'vue'] },
  { key: 'cloud',       label: 'クラウド構築・運用',   detail: 'AWS / Azure / GCP のインフラ設計・構築・SRE',                    keywords: ['aws', 'azure', 'gcp', 'クラウド', 'インフラ', 'sre', 'kubernetes'] },
  { key: 'ai',          label: 'AI / 機械学習',         detail: '生成AI 活用・RAG・チャットボット・推論基盤',                       keywords: ['ai', '人工知能', '機械学習', 'チャットボット', '生成ai', 'rag', 'llm'] },
  { key: 'data',        label: 'データ分析・BI 基盤',  detail: 'DWH 構築・データパイプライン・ダッシュボード設計',                 keywords: ['データ分析', 'bi', 'dwh', 'etl', 'データ基盤', 'tableau', 'looker'] },
  { key: 'mobile',      label: 'モバイルアプリ開発',   detail: 'iOS / Android ネイティブ・React Native / Flutter',                keywords: ['ios', 'android', 'モバイル', 'アプリ開発', 'flutter', 'react native'] },
  { key: 'security',    label: 'セキュリティ',          detail: '脆弱性診断・SOC 運用・ゼロトラスト設計',                          keywords: ['セキュリティ', '脆弱性診断', 'soc', 'penetration', 'csirt'] },
  { key: 'cms',         label: 'CMS / Web 制作',        detail: 'WordPress / Sitecore / HubSpot 等の構築・運用',                  keywords: ['cms', 'wordpress', 'sitecore', 'コンテンツ管理', 'ウェブサイト構築'] },
  { key: 'design',      label: 'UI / UX デザイン',      detail: '戦略フェーズからデザインまで一貫対応',                            keywords: ['デザイン', 'ui', 'ux', 'クリエイティブ', 'ブランディング'] },

  // 営業 / マーケティング 系
  { key: 'marketing',   label: 'デジタルマーケティング', detail: 'SEO / 広告運用 / MA / CRM 戦略支援',                              keywords: ['マーケティング', 'seo', '広告', 'ma', 'crm', 'リード獲得'] },
  { key: 'sales_ops',   label: '営業代行・SDR',         detail: 'インサイドセールス / アポ獲得 / 商談化支援',                       keywords: ['営業代行', 'sdr', 'インサイドセールス', 'アポイント', '商談'] },
  { key: 'pr_branding', label: 'PR・ブランディング',    detail: '広報戦略・メディア露出・コーポレートブランド構築',                  keywords: ['pr', '広報', 'ブランディング', 'メディア戦略', '広告宣伝'] },
  { key: 'research',    label: '市場調査・リサーチ',    detail: '定量定性調査・競合分析・カスタマーインサイト',                      keywords: ['市場調査', 'リサーチ', '競合分析', 'インサイト', 'マーケティングリサーチ'] },

  // コンサル / 経営 系
  { key: 'biz_consult', label: '経営・業務コンサル',    detail: '事業戦略・業務改善・DX 推進支援',                                 keywords: ['コンサル', '経営', '業務改善', 'dx', '戦略立案', 'kpi'] },
  { key: 'hr',          label: '人事・採用支援',        detail: '採用代行・人事制度設計・タレントマネジメント',                      keywords: ['人事', '採用', 'rpo', 'タレント', 'hr', '組織開発'] },
  { key: 'finance',     label: '会計・税務・財務',      detail: '記帳代行・税務申告・財務戦略・IPO 準備',                           keywords: ['会計', '税務', '財務', '経理', 'ipo', '監査'] },
  { key: 'legal',       label: '法務・契約サポート',    detail: '契約レビュー・法務 DD・知財・コンプライアンス',                    keywords: ['法務', '契約', '知財', 'コンプライアンス', '弁護士', 'dd'] },

  // 製造 / 物流 / 専門 系
  { key: 'bpo',         label: 'BPO・アウトソーシング', detail: '事務代行・コールセンター運営・バックオフィス全般',                  keywords: ['bpo', 'アウトソーシング', 'コールセンター', '事務代行', 'バックオフィス'] },
  { key: 'logistics',   label: '物流・サプライチェーン', detail: '倉庫運営・配送最適化・SCM 改善',                                 keywords: ['物流', '配送', '倉庫', '在庫管理', 'scm', 'サプライチェーン'] },
];

/**
 * 利用規約 (本文)。OSS 利用にあたって押さえるべき責任分界を 12 項目で網羅する。
 * 「上記内容を理解し、自己責任で使用」のチェックで合意とする。
 */
const TERMS_BULLETS = [
  '送信先企業の問い合わせフォーム利用規約 / 営業お断り表記の遵守',
  '特定電子メール法 / 個人情報保護法 / GDPR など適用法令の遵守',
  '誤送信・不適切な文面・誤った相手への送信に起因する損害',
  'AI が生成した文面の内容責任 (誤情報・名誉毀損・著作権侵害含む)',
  'AI プロバイダ (Anthropic / OpenAI / Google) への料金・利用規約の遵守',
  'スパム的送信・大量連投・なりすまし送信の禁止',
  'リスト取得経路の合法性 (公開情報か、適法に入手したか)',
  '本ソフトウェアは「現状有姿 (AS IS)」で提供、保証なし (MIT)',
  'Windows SmartScreen / Antivirus による警告 (本ビルドはコード署名なし)',
  '送信履歴・スクリーンショット・ログは全てローカルに残るためバックアップ責任',
  '送信先からの返信・連絡対応・クレーム処理はユーザー側で行う',
  '紛争が生じた場合の準拠法は日本法、合意管轄は東京地方裁判所',
];

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * ウィザード HTML 全体をレンダリング。dashboard-server.cjs の通常パスから
 * 横取りされて返される。CSS / JS は自己完結 inline。
 *
 * @param {object} ctx
 * @param {string} [ctx.sessionToken] dashboard session token (API 呼び出し用)
 * @param {object} [ctx.savedProgress] data/onboarding-progress.json の内容
 * @returns {string} HTML
 */
function renderOnboardingPage(ctx: { sessionToken?: string; savedProgress?: Record<string, unknown> | null; preferredLanguage?: 'ja' | 'en' } = {}) {
  const sessionToken = ctx.sessionToken || '';
  const savedProgress = ctx.savedProgress || null;
  const preferredLanguage = ctx.preferredLanguage === 'en' ? 'en' : 'ja';
  const presetJson = JSON.stringify(PRESET_STRENGTHS);
  const termsJson = JSON.stringify(TERMS_BULLETS);
  const progressJson = JSON.stringify(savedProgress || {});

  return `<!doctype html>
<html lang="${preferredLanguage}" data-theme="light">
<head>
<meta charset="utf-8">
<title>${preferredLanguage === 'ja' ? 'Sales Claw — 初回セットアップ' : 'Sales Claw — Initial Setup'}</title>
<meta name="viewport" content="width=1200">
<style>
:root {
  --bg: #ffffff;
  --bg-soft: #f7f8fb;
  --bg-card: #ffffff;
  --border: #e5e8ef;
  --border-strong: #cdd2db;
  --text-1: #0f172a;
  --text-2: #475569;
  --text-3: #94a3b8;
  --primary: #2563eb;
  --primary-hover: #1d4ed8;
  --primary-soft: #eff6ff;
  --success: #16a34a;
  --danger: #dc2626;
  --warning: #ea580c;
  --warning-soft: #fff8ec;
  --info-soft: #fffbe6;
  --shadow-card: 0 1px 3px rgba(15, 23, 42, .04), 0 1px 2px rgba(15, 23, 42, .03);
  --radius: 14px;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  font-family: 'Segoe UI', 'Noto Sans JP', system-ui, -apple-system, sans-serif;
  background: var(--bg);
  color: var(--text-1);
  min-height: 100vh;
  font-size: 14px;
  -webkit-font-smoothing: antialiased;
}

/* ─── Title bar (mimics screenshot) ─── */
.wiz-titlebar {
  height: 42px;
  background: var(--bg);
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  padding: 0 18px;
  gap: 10px;
  font-size: 13px;
  color: var(--text-2);
}
.wiz-titlebar .icon { width: 18px; height: 18px; display: inline-flex; align-items: center; justify-content: center; color: var(--primary); }

/* ─── Outer shell ─── */
.wiz-shell {
  max-width: 1100px;
  margin: 0 auto;
  padding: 28px 32px 40px;
}
.wiz-subtitle {
  font-size: 14px;
  color: var(--text-2);
  margin-bottom: 36px;
}

/* ─── Stepper (写真通り: 円 + 接続線) ─── */
.wiz-stepper {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 0;
  margin-bottom: 32px;
  position: relative;
}
.wiz-step {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  position: relative;
}
.wiz-step .wiz-step-circle {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: 2px solid var(--border-strong);
  background: #fff;
  color: var(--text-3);
  font-weight: 600;
  font-size: 14px;
  display: grid;
  place-items: center;
  position: relative;
  z-index: 2;
  transition: all .15s;
}
.wiz-step .wiz-step-label {
  font-size: 13px;
  color: var(--text-3);
  font-weight: 500;
}
.wiz-step.active .wiz-step-circle {
  border-color: var(--primary);
  color: var(--primary);
  background: #fff;
}
.wiz-step.active .wiz-step-label {
  color: var(--primary);
  font-weight: 700;
}
.wiz-step.done .wiz-step-circle {
  border-color: var(--primary);
  background: var(--primary);
  color: #fff;
}
.wiz-step.done .wiz-step-circle::before { content: '✓'; font-size: 16px; }
.wiz-step.done .wiz-step-circle span { display: none; }
.wiz-step.done .wiz-step-label { color: var(--text-2); }
/* 接続線: 各 step の circle の右端から次の circle の左端まで */
.wiz-step:not(:last-child)::after {
  content: '';
  position: absolute;
  top: 17px;
  left: calc(50% + 22px);
  right: calc(-50% + 22px);
  height: 2px;
  background: var(--border-strong);
  z-index: 1;
}
.wiz-step.done:not(:last-child)::after { background: var(--primary); }

/* ─── Card ─── */
.wiz-card {
  background: var(--bg-card);
  border-radius: var(--radius);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-card);
  padding: 36px 40px;
  min-height: 420px;
}

/* ─── Step 1 (Welcome) layout ─── */
.welcome-grid {
  display: grid;
  grid-template-columns: 88px 1fr;
  gap: 24px;
  align-items: start;
  margin-bottom: 24px;
}
.welcome-emoji {
  font-size: 64px;
  line-height: 1;
  margin-top: 4px;
}
.welcome-content h2 {
  margin: 0 0 12px;
  font-size: 22px;
  font-weight: 700;
}
.welcome-content .lead {
  margin: 0;
  color: var(--text-2);
  font-size: 14px;
  line-height: 1.75;
}

/* ─── Info blocks (warning + folder) ─── */
.info-block {
  display: grid;
  grid-template-columns: 32px 1fr;
  gap: 16px;
  align-items: start;
  margin-top: 24px;
}
.info-block .ib-icon {
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  font-size: 22px;
  margin-top: 2px;
}
.info-block h3 {
  margin: 0 0 10px;
  font-size: 16px;
  font-weight: 700;
}
.info-block .ib-body {
  font-size: 13.5px;
  color: var(--text-2);
  line-height: 1.7;
}
.info-block ul.terms {
  margin: 8px 0 0;
  padding: 0;
  list-style: none;
  font-size: 13.5px;
  color: var(--text-2);
  line-height: 1.85;
}
.info-block ul.terms li {
  position: relative;
  padding-left: 18px;
}
.info-block ul.terms li::before {
  content: '•';
  position: absolute;
  left: 4px;
  color: var(--text-3);
}
.info-block code {
  font-family: 'Cascadia Mono', 'Consolas', 'Monaco', monospace;
  font-size: 12.5px;
  background: var(--bg-soft);
  padding: 1px 6px;
  border-radius: 4px;
  color: var(--text-1);
}

/* ─── Divider ─── */
.divider {
  border: 0;
  border-top: 1px solid var(--border);
  margin: 24px 0;
}

/* ─── Terms checkbox ─── */
.terms-check {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 14px;
  color: var(--text-1);
  padding: 4px 0;
}
.terms-check input { display: none; }
.terms-check .box {
  width: 22px;
  height: 22px;
  border: 2px solid var(--border-strong);
  border-radius: 5px;
  display: grid;
  place-items: center;
  background: #fff;
  flex-shrink: 0;
  transition: all .12s;
}
.terms-check input:checked + .box {
  background: var(--primary);
  border-color: var(--primary);
}
.terms-check input:checked + .box::after {
  content: '';
  width: 6px;
  height: 11px;
  border: solid #fff;
  border-width: 0 2.5px 2.5px 0;
  transform: rotate(45deg);
  margin-top: -2px;
}

/* ─── Actions footer ─── */
.wiz-actions {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 36px;
}
.wiz-actions-right { display: flex; gap: 12px; align-items: center; }
.btn {
  padding: 12px 28px;
  border-radius: 10px;
  border: 1px solid transparent;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: all .12s;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-family: inherit;
  min-width: 110px;
  justify-content: center;
}
.btn-primary { background: var(--primary); color: #fff; }
.btn-primary:hover { background: var(--primary-hover); }
.btn-primary:disabled { background: #cbd5e1; cursor: not-allowed; }
.btn-secondary { background: var(--bg-soft); border-color: var(--border); color: var(--text-1); }
.btn-secondary:hover { background: #eef2f7; }
.btn-link { background: transparent; border-color: transparent; color: var(--primary); padding: 10px 8px; font-weight: 500; min-width: 0; }
.btn-link:hover { text-decoration: underline; }

/* ─── Fields (step 2) ─── */
.field { display: flex; flex-direction: column; gap: 8px; margin-bottom: 18px; }
.field-row { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.field-row .field { margin-bottom: 0; }
.field label {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-1);
  display: flex;
  align-items: center;
  gap: 6px;
}
.field .req { color: var(--danger); font-weight: 700; }
.field input, .field textarea, .field select {
  padding: 11px 14px;
  border-radius: 8px;
  border: 1px solid var(--border-strong);
  font-size: 14px;
  background: #fff;
  transition: border-color .12s, box-shadow .12s;
  font-family: inherit;
  color: var(--text-1);
}
.field input:focus, .field textarea:focus, .field select:focus {
  outline: none;
  border-color: var(--primary);
  box-shadow: 0 0 0 3px rgba(37, 99, 235, .15);
}
.field textarea { min-height: 64px; resize: vertical; }
.field .hint { font-size: 12px; color: var(--text-3); }
.field.error input, .field.error textarea, .field.error select { border-color: var(--danger); }
.field .err { font-size: 12px; color: var(--danger); font-weight: 500; }

/* ─── Strengths grid (step 3) ─── */
.preset-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 12px;
  margin: 16px 0 24px;
}
.preset-card {
  padding: 14px 16px;
  border-radius: 12px;
  border: 2px solid var(--border);
  background: #fff;
  cursor: pointer;
  transition: all .12s;
  position: relative;
}
.preset-card:hover { border-color: var(--border-strong); transform: translateY(-1px); }
.preset-card.selected {
  border-color: var(--primary);
  background: var(--primary-soft);
}
.preset-card.selected::before {
  content: '✓';
  position: absolute;
  top: 12px;
  right: 14px;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: var(--primary);
  color: #fff;
  display: grid;
  place-items: center;
  font-size: 14px;
  font-weight: 700;
}
.preset-card .label { font-weight: 700; font-size: 14px; color: var(--text-1); padding-right: 32px; }
.preset-card .detail { font-size: 12px; color: var(--text-2); margin-top: 6px; line-height: 1.55; }
.preset-section {
  font-size: 12px;
  font-weight: 700;
  color: var(--text-3);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin: 24px 0 4px;
}

.custom-strength {
  border: 1px dashed var(--border-strong);
  border-radius: 12px;
  padding: 14px;
  background: var(--bg-soft);
  margin-bottom: 12px;
}

/* ─── Dropzone (step 4) ─── */
.dropzone {
  border: 2px dashed var(--border-strong);
  border-radius: 14px;
  padding: 56px 24px;
  text-align: center;
  cursor: pointer;
  transition: all .15s;
  background: var(--bg-soft);
}
.dropzone:hover, .dropzone.over { border-color: var(--primary); background: var(--primary-soft); }
.dropzone .ico { font-size: 36px; margin-bottom: 8px; }
.dropzone .main-text { font-weight: 600; font-size: 15px; }
.dropzone .sub-text { font-size: 12px; color: var(--text-3); margin-top: 6px; }
.target-summary {
  margin-top: 16px;
  padding: 16px 18px;
  border-radius: 12px;
  background: #f0fdf4;
  border: 1px solid #86efac;
  color: #166534;
  font-size: 13.5px;
}

/* ─── AI cards (step 5, with SVG icons) ─── */
.ai-providers { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; margin: 20px 0 28px; }
.ai-card {
  padding: 22px 16px 18px;
  border-radius: 14px;
  border: 2px solid var(--border);
  background: #fff;
  cursor: pointer;
  transition: all .12s;
  text-align: center;
  position: relative;
}
.ai-card:hover { border-color: var(--border-strong); transform: translateY(-1px); }
.ai-card.selected { border-color: var(--primary); background: var(--primary-soft); }
.ai-card.selected::before {
  content: '✓';
  position: absolute;
  top: 10px;
  right: 12px;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: var(--primary);
  color: #fff;
  display: grid;
  place-items: center;
  font-size: 14px;
  font-weight: 700;
}
.ai-card .ai-icon-wrap {
  width: 56px;
  height: 56px;
  margin: 0 auto 12px;
  border-radius: 14px;
  display: grid;
  place-items: center;
  background: rgba(15,23,42,.045);
  border: 1px solid rgba(15,23,42,.06);
}
.ai-card[data-ai="claude"] .ai-icon-wrap { background: rgba(204,120,92,.10); border-color: rgba(204,120,92,.18); }
.ai-card[data-ai="codex"]  .ai-icon-wrap { background: rgba(15,23,42,.06);    border-color: rgba(15,23,42,.10); }
.ai-card[data-ai="gemini"] .ai-icon-wrap { background: rgba(66,133,244,.08);  border-color: rgba(66,133,244,.16); }
.ai-card .ai-icon-wrap img { display: block; width: 34px; height: 34px; }
.ai-card .name { font-weight: 700; font-size: 15px; color: var(--text-1); }
.ai-card .vendor { font-size: 12px; color: var(--text-3); margin-top: 2px; }
.ai-card .status {
  margin-top: 10px;
  font-size: 11.5px;
  padding: 3px 10px;
  border-radius: 100px;
  display: inline-block;
  font-weight: 600;
}
.ai-card .status.ok      { background: #dcfce7; color: #166534; }
.ai-card .status.bad     { background: #fee2e2; color: #991b1b; }
.ai-card .status.unknown { background: #f1f5f9; color: var(--text-2); }
.ai-card .status .dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  margin-right: 4px;
  vertical-align: middle;
}
.ai-card .status.ok .dot      { background: #16a34a; }
.ai-card .status.bad .dot     { background: #dc2626; }
.ai-card .status.unknown .dot { background: var(--text-3); }

/* ─── Notice boxes ─── */
.notice {
  padding: 14px 16px;
  border-radius: 12px;
  font-size: 13px;
  line-height: 1.65;
  margin-top: 16px;
}
.notice.info { background: var(--primary-soft); border: 1px solid #93c5fd; color: #1d4ed8; }
.notice.ok   { background: #f0fdf4; border: 1px solid #86efac; color: #166534; }
.notice.warn { background: var(--warning-soft); border: 1px solid #f5d99a; color: #92590e; }
.notice strong { display: block; margin-bottom: 4px; }
.notice a { color: inherit; text-decoration: underline; }

.errors {
  background: #fef2f2;
  border: 1px solid #fca5a5;
  color: #b91c1c;
  padding: 12px 14px;
  border-radius: 10px;
  margin-bottom: 16px;
  font-size: 12.5px;
}
.errors ul { margin: 4px 0 0 18px; padding: 0; }

.spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid var(--border); border-top-color: var(--primary); border-radius: 50%; animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
<div class="wiz-titlebar">
  <span class="icon">
    <!-- 小さなロゴ的 svg -->
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M3 12c0-4.97 4.03-9 9-9 4.06 0 7.5 2.69 8.62 6.4"/>
      <path d="M21 12c0 4.97-4.03 9-9 9-4.06 0-7.5-2.69-8.62-6.4"/>
    </svg>
  </span>
  <span>${preferredLanguage === 'ja' ? 'Sales Claw — 初回セットアップ' : 'Sales Claw — Initial Setup'}</span>
</div>

<div class="wiz-shell">
  <div class="wiz-subtitle">${preferredLanguage === 'ja' ? '5 ステップで完了。後からでも <strong style="color: var(--text-1);">設定</strong> タブで変更できます。' : 'Complete in 5 steps. You can change everything later from the <strong style="color: var(--text-1);">Settings</strong> tab.'}</div>
  <div class="wiz-stepper" id="stepper"></div>
  <div class="wiz-card" id="cardHost"></div>
  <div class="wiz-actions" id="actionsHost"></div>
</div>

<script>
(function () {
  const SESSION_TOKEN = ${JSON.stringify(sessionToken)};
  const PRESETS = ${presetJson};
  const TERMS = ${termsJson};
  const SAVED = ${progressJson};
  // v2.0.33: 既存 settings.preferences.language を初期値に
  const PREFERRED_LANGUAGE = ${JSON.stringify(preferredLanguage || 'ja')};

  // ---- state ----
  const state = Object.assign({
    step: 1,
    // v2.0.33: 言語選択 (ja|en) を Step 1 で決定 → 以降の wizard / dashboard で採用
    language: (typeof PREFERRED_LANGUAGE === 'string' && PREFERRED_LANGUAGE) || 'ja',
    termsAgreed: false,
    companyProfile: {
      companyName: '',
      contactName: '',
      contactNameKana: '',
      department: '',
      contactTitle: '',
      email: '',
      phone: '',
      mobile: '',
      website: '',
      address: '',
    },
    selectedPresetKeys: [],
    customStrengths: [],
    targetList: null,
    targetListMeta: null,
    aiProvider: 'claude',
    aiAuthStatus: { claude: null, codex: null, gemini: null },
    bypassAi: false,
    errors: [],
  }, SAVED || {});

  // ---- helpers ----
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  function fetchJson(url, opts) {
    const o = Object.assign({}, opts);
    o.headers = Object.assign({ 'Content-Type': 'application/json' }, o.headers || {});
    if (SESSION_TOKEN) o.headers['x-sales-claw-session'] = SESSION_TOKEN;
    return fetch(url, o).then(async (r) => {
      const text = await r.text();
      try { return { status: r.status, ok: r.ok, body: JSON.parse(text) }; }
      catch { return { status: r.status, ok: r.ok, body: text }; }
    });
  }

  function persistProgress() {
    fetchJson('/api/onboarding/progress', {
      method: 'POST',
      body: JSON.stringify({
        step: state.step,
        termsAgreed: state.termsAgreed,
        companyProfile: state.companyProfile,
        selectedPresetKeys: state.selectedPresetKeys,
        customStrengths: state.customStrengths,
        targetListMeta: state.targetListMeta,
        aiProvider: state.aiProvider,
        bypassAi: state.bypassAi,
      })
    }).catch(() => {});
  }

  // ---- stepper (v2.0.33: i18n) ----
  const STEPS_JA = [
    { n: 1, label: 'ようこそ' },
    { n: 2, label: '自社情報' },
    { n: 3, label: '強み' },
    { n: 4, label: 'ターゲット' },
    { n: 5, label: 'AI 連携' },
  ];
  const STEPS_EN = [
    { n: 1, label: 'Welcome' },
    { n: 2, label: 'Company' },
    { n: 3, label: 'Strengths' },
    { n: 4, label: 'Targets' },
    { n: 5, label: 'AI Setup' },
  ];

  function renderStepper() {
    const STEPS = (state.language || 'ja') === 'en' ? STEPS_EN : STEPS_JA;
    $('#stepper').innerHTML = STEPS.map((s) => {
      const cls = state.step === s.n ? 'active' : (state.step > s.n ? 'done' : '');
      return '<div class="wiz-step ' + cls + '">' +
        '<div class="wiz-step-circle"><span>' + s.n + '</span></div>' +
        '<div class="wiz-step-label">' + esc(s.label) + '</div>' +
        '</div>';
    }).join('');
  }

  function setStep(n) {
    state.step = Math.max(1, Math.min(5, n));
    state.errors = [];
    persistProgress();
    render();
    window.scrollTo(0, 0);
  }

  // ---- step 1: welcome + terms ----
  function renderStep1() {
    const termsList = TERMS.map((t) => '<li>' + esc(t) + '</li>').join('');
    // v2.0.33: 言語選択カードを最上部に表示。state.language === 'en' なら英語表示。
    const lang = state.language || 'ja';
    const isJa = lang === 'ja';
    return [
      // ─── Language picker (always at top of Step 1) ───
      '<div class="lang-picker" style="display:flex;gap:12px;margin-bottom:20px;padding:16px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px">',
      '  <button type="button" id="langJa" class="lang-card' + (isJa ? ' selected' : '') + '" style="flex:1;padding:16px;background:' + (isJa ? '#eff6ff' : '#fff') + ';border:2px solid ' + (isJa ? '#2563eb' : '#e2e8f0') + ';border-radius:10px;cursor:pointer;text-align:center;transition:all .15s">',
      '    <div style="font-size:32px;margin-bottom:6px">🇯🇵</div>',
      '    <div style="font-weight:700;font-size:14px">日本語</div>',
      '    <div style="font-size:11px;color:#64748b;margin-top:2px">Japanese</div>',
      '  </button>',
      '  <button type="button" id="langEn" class="lang-card' + (!isJa ? ' selected' : '') + '" style="flex:1;padding:16px;background:' + (!isJa ? '#eff6ff' : '#fff') + ';border:2px solid ' + (!isJa ? '#2563eb' : '#e2e8f0') + ';border-radius:10px;cursor:pointer;text-align:center;transition:all .15s">',
      '    <div style="font-size:32px;margin-bottom:6px">🇺🇸</div>',
      '    <div style="font-weight:700;font-size:14px">English</div>',
      '    <div style="font-size:11px;color:#64748b;margin-top:2px">英語</div>',
      '  </button>',
      '</div>',

      '<div class="welcome-grid">',
      '  <div class="welcome-emoji">👋</div>',
      '  <div class="welcome-content">',
      isJa ? '    <h2>Sales Claw へようこそ</h2>' : '    <h2>Welcome to Sales Claw</h2>',
      isJa
        ? '    <p class="lead">企業の問い合わせフォーム経由で営業アプローチを自動化するツールです。<br>       Claude / Codex / Gemini CLI と連携してフォーム入力までを実行します。</p>'
        : '    <p class="lead">A tool that automates B2B outreach via corporate contact forms.<br>       It integrates with Claude / Codex / Gemini CLI to fill forms automatically.</p>',
      '  </div>',
      '</div>',

      '<div class="info-block">',
      '  <div class="ib-icon">⚠️</div>',
      '  <div>',
      isJa ? '    <h3>利用前のご確認 (OSS / 自己責任)</h3>' : '    <h3>Before you start (OSS / Use at your own risk)</h3>',
      isJa
        ? '    <div class="ib-body">本ソフトウェアは MIT ライセンスのオープンソースです。以下の責任はすべてユーザー側にあります。</div>'
        : '    <div class="ib-body">This software is open source under the MIT license. The following responsibilities lie entirely with the user.</div>',
      '    <ul class="terms">', termsList, '</ul>',
      '  </div>',
      '</div>',

      '<div class="info-block">',
      '  <div class="ib-icon">📁</div>',
      '  <div>',
      isJa ? '    <h3>データの保存場所</h3>' : '    <h3>Where data is stored</h3>',
      '    <div class="ib-body">',
      isJa
        ? '      本アプリの設定 / ログ / スクリーンショットはすべて<strong>ローカル</strong>に保存されます。<br>      <code>%APPDATA%\\\\sales-claw\\\\runtime\\\\data\\\\</code> 配下にあります。'
        : '      All settings / logs / screenshots are stored <strong>locally</strong>.<br>      Located under <code>%APPDATA%\\\\sales-claw\\\\runtime\\\\data\\\\</code>.',
      '    </div>',
      '  </div>',
      '</div>',

      '<hr class="divider">',

      '<label class="terms-check">',
      '  <input type="checkbox" id="termsCheck"' + (state.termsAgreed ? ' checked' : '') + '>',
      '  <span class="box"></span>',
      isJa
        ? '  <span>上記内容を理解し、自己責任でこのツールを使用することに同意します</span>'
        : '  <span>I have read and understood the above and agree to use this tool at my own risk.</span>',
      '</label>',
    ].join('\\n');
  }

  function renderStep1Actions() {
    const isJa = (state.language || 'ja') === 'ja';
    return [
      '<button class="btn btn-secondary" data-action="cancel">' + (isJa ? 'キャンセル' : 'Cancel') + '</button>',
      '<div class="wiz-actions-right">',
      '  <button class="btn btn-primary" id="step1Next"' + (state.termsAgreed ? '' : ' disabled') + '>' + (isJa ? '次へ' : 'Next') + '</button>',
      '</div>',
    ].join('');
  }

  function bindStep1() {
    // v2.0.33: 言語選択ボタン → preferences 更新 → 完全リロード
    // (wiz-titlebar / subtitle / html lang は server-rendered なのでリロード必要。
    //  state は /api/onboarding/progress に persist されてるので復元される)
    const setLang = async (lang) => {
      state.language = lang;
      try {
        await fetch('/api/settings/preferences', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ language: lang }),
        });
      } catch (_) { /* 失敗しても in-memory state は更新する */ }
      persistProgress();
      // 完全リロードで全 UI 要素が新言語で再描画される
      location.reload();
    };
    const langJa = $('#langJa');
    const langEn = $('#langEn');
    if (langJa) langJa.addEventListener('click', () => setLang('ja'));
    if (langEn) langEn.addEventListener('click', () => setLang('en'));

    $('#termsCheck').addEventListener('change', (e) => {
      state.termsAgreed = e.target.checked;
      $('#step1Next').disabled = !state.termsAgreed;
      persistProgress();
    });
    $('#step1Next').addEventListener('click', () => setStep(2));
    const cancel = document.querySelector('[data-action="cancel"]');
    if (cancel) cancel.addEventListener('click', cancelWizard);
  }

  // ---- step 2: company profile ----
  const PROFILE_FIELDS_JA = [
    { key: 'companyName',     label: '会社名',        required: true,  hint: '株式会社 ○○' },
    { key: 'contactName',     label: '担当者名',      required: true,  hint: '山田 太郎' },
    { key: 'contactNameKana', label: '担当者名カナ',  required: false, hint: 'ヤマダ タロウ' },
    { key: 'department',      label: '部署',          required: false },
    { key: 'contactTitle',    label: '役職',          required: false },
    { key: 'email',           label: 'メールアドレス', required: true,  hint: 'name@company.co.jp' },
    { key: 'phone',           label: '電話番号',      required: true,  hint: '03-0000-0000' },
    { key: 'mobile',          label: '携帯番号',      required: false },
    { key: 'website',         label: '自社 Web サイト', required: false, hint: 'https://www.example.com/' },
    { key: 'address',         label: '住所',          required: true,  fullWidth: true, hint: '東京都千代田区...' },
  ];
  const PROFILE_FIELDS_EN = [
    { key: 'companyName',     label: 'Company name',   required: true,  hint: 'Acme, Inc.' },
    { key: 'contactName',     label: 'Contact name',   required: true,  hint: 'Taro Yamada' },
    { key: 'contactNameKana', label: 'Name (Kana)',    required: false, hint: 'optional — used by JP forms' },
    { key: 'department',      label: 'Department',     required: false },
    { key: 'contactTitle',    label: 'Job title',      required: false },
    { key: 'email',           label: 'Email',          required: true,  hint: 'name@company.com' },
    { key: 'phone',           label: 'Phone',          required: true,  hint: '+1 555 0100' },
    { key: 'mobile',          label: 'Mobile',         required: false },
    { key: 'website',         label: 'Company website', required: false, hint: 'https://www.example.com/' },
    { key: 'address',         label: 'Address',        required: true,  fullWidth: true, hint: '1 Market St, San Francisco, CA' },
  ];

  function renderStep2() {
    const isJa = (state.language || 'ja') === 'ja';
    const PROFILE_FIELDS = isJa ? PROFILE_FIELDS_JA : PROFILE_FIELDS_EN;
    const errMap = {};
    state.errors.forEach((e) => { errMap[e.field] = e.message || e.code; });
    const errBox = state.errors.length === 0 ? '' :
      '<div class="errors"><strong>' + (isJa ? '入力エラー' : 'Input error') + '</strong><ul>' +
      state.errors.map((e) => '<li>' + esc(e.message || e.code) + '</li>').join('') +
      '</ul></div>';

    let rowsHtml = '';
    let buf = [];
    PROFILE_FIELDS.forEach((f) => {
      const v = state.companyProfile[f.key] || '';
      const err = errMap[f.key];
      const errCls = err ? ' error' : '';
      const html = '<div class="field' + errCls + '">' +
        '<label>' + esc(f.label) + (f.required ? '<span class="req">*</span>' : '') + '</label>' +
        '<input data-field="' + f.key + '" type="text" value="' + esc(v) + '" placeholder="' + esc(f.hint || '') + '">' +
        (err ? '<span class="err">' + esc(err) + '</span>' : '') +
        '</div>';
      if (f.fullWidth) {
        if (buf.length) { rowsHtml += '<div class="field-row">' + buf.join('') + '</div>'; buf = []; }
        rowsHtml += html;
      } else {
        buf.push(html);
        if (buf.length === 2) { rowsHtml += '<div class="field-row">' + buf.join('') + '</div>'; buf = []; }
      }
    });
    if (buf.length) rowsHtml += '<div class="field-row">' + buf.join('') + (buf.length === 1 ? '<div></div>' : '') + '</div>';

    return [
      '<div class="welcome-grid" style="grid-template-columns: 64px 1fr; align-items: center; margin-bottom: 8px;">',
      '  <div style="font-size: 40px;">🏢</div>',
      '  <div>',
      isJa
        ? '    <h2 style="margin: 0 0 4px;">自社情報</h2>'
        : '    <h2 style="margin: 0 0 4px;">Company profile</h2>',
      isJa
        ? '    <p class="lead" style="margin: 0;">送信先フォームに自動入力される情報です。<span class="req" style="color: var(--danger);">*</span> は必須項目。</p>'
        : '    <p class="lead" style="margin: 0;">This information is auto-filled into the recipient contact forms. <span class="req" style="color: var(--danger);">*</span> means required.</p>',
      '  </div>',
      '</div>',
      '<hr class="divider">',
      errBox,
      rowsHtml,
    ].join('');
  }

  function renderStep2Actions() {
    const isJa = (state.language || 'ja') === 'ja';
    return [
      '<button class="btn btn-secondary" data-action="back">' + (isJa ? '戻る' : 'Back') + '</button>',
      '<div class="wiz-actions-right">',
      '  <button class="btn btn-primary" data-action="next">' + (isJa ? '次へ' : 'Next') + '</button>',
      '</div>',
    ].join('');
  }

  function bindStep2() {
    const isJa = (state.language || 'ja') === 'ja';
    document.querySelectorAll('[data-field]').forEach((el) => {
      el.addEventListener('input', (e) => {
        state.companyProfile[el.dataset.field] = e.target.value;
        persistProgress();
      });
    });
    document.querySelector('[data-action="back"]').addEventListener('click', () => setStep(1));
    document.querySelector('[data-action="next"]').addEventListener('click', async () => {
      const r = await fetchJson('/api/onboarding/validate', {
        method: 'POST',
        body: JSON.stringify({ step: 'companyProfile', companyProfile: state.companyProfile })
      });
      if (r.body && r.body.errors && r.body.errors.length === 0) setStep(3);
      else { state.errors = (r.body && r.body.errors) || [{ message: isJa ? 'サーバ検証に失敗しました' : 'Server-side validation failed' }]; render(); }
    });
  }

  // ---- step 3: strengths ----
  // English translations of the 18 PRESET_STRENGTHS labels/details (parallel to PRESET_STRENGTHS order).
  const PRESET_STRENGTHS_EN = {
    web_app:     { label: 'Web app development',         detail: 'Frontend / backend / API for business web apps' },
    cloud:       { label: 'Cloud build & operate',       detail: 'AWS / Azure / GCP infrastructure design and SRE' },
    ai:          { label: 'AI / Machine learning',       detail: 'Generative AI, RAG, chatbots, inference platforms' },
    data:        { label: 'Data analytics / BI',         detail: 'DWH, data pipelines, dashboard design' },
    mobile:      { label: 'Mobile app development',      detail: 'iOS / Android native, React Native / Flutter' },
    security:    { label: 'Security',                    detail: 'Vulnerability assessment, SOC ops, zero-trust design' },
    cms:         { label: 'CMS / Web production',        detail: 'WordPress / Sitecore / HubSpot build & operate' },
    design:      { label: 'UI / UX design',              detail: 'End-to-end from strategy through visual design' },
    marketing:   { label: 'Digital marketing',           detail: 'SEO / paid ads / MA / CRM strategy' },
    sales_ops:   { label: 'Sales outsourcing / SDR',     detail: 'Inside sales, appointment setting, deal qualification' },
    pr_branding: { label: 'PR & branding',               detail: 'PR strategy, media exposure, corporate brand' },
    research:    { label: 'Market research',             detail: 'Quant/qual research, competitive analysis, customer insight' },
    biz_consult: { label: 'Management & ops consulting', detail: 'Business strategy, process improvement, DX support' },
    hr:          { label: 'HR & talent acquisition',     detail: 'RPO, HR system design, talent management' },
    finance:     { label: 'Accounting / tax / finance',  detail: 'Bookkeeping, tax filing, financial strategy, IPO prep' },
    legal:       { label: 'Legal & contracts',           detail: 'Contract review, legal DD, IP, compliance' },
    bpo:         { label: 'BPO / Outsourcing',           detail: 'Admin work, contact center, full back-office' },
    logistics:   { label: 'Logistics / Supply chain',    detail: 'Warehouse ops, delivery optimization, SCM improvement' },
  };

  function renderStep3() {
    const isJa = (state.language || 'ja') === 'ja';
    const errBox = state.errors.length === 0 ? '' :
      '<div class="errors"><strong>' + (isJa ? '選択エラー' : 'Selection error') + '</strong><ul>' +
      state.errors.map((e) => '<li>' + esc(e.message || e.code) + '</li>').join('') +
      '</ul></div>';

    // セクション分類: index 0-7 = IT/Tech、 8-11 = 営業/マーケ、 12-15 = コンサル/専門、 16-17 = BPO/物流
    const sectionRanges = isJa ? [
      { name: 'IT / テクノロジー',         start: 0,  end: 8 },
      { name: '営業 / マーケティング',     start: 8,  end: 12 },
      { name: 'コンサルティング / 専門',   start: 12, end: 16 },
      { name: 'BPO / 物流',                start: 16, end: 18 },
    ] : [
      { name: 'IT / Technology',           start: 0,  end: 8 },
      { name: 'Sales / Marketing',         start: 8,  end: 12 },
      { name: 'Consulting / Specialized',  start: 12, end: 16 },
      { name: 'BPO / Logistics',           start: 16, end: 18 },
    ];
    let presetSectionsHtml = '';
    sectionRanges.forEach((sec) => {
      const cards = PRESETS.slice(sec.start, sec.end).map((p) => {
        const sel = state.selectedPresetKeys.indexOf(p.key) >= 0 ? ' selected' : '';
        const en = PRESET_STRENGTHS_EN[p.key];
        const label = isJa || !en ? p.label : en.label;
        const detail = isJa || !en ? p.detail : en.detail;
        return '<div class="preset-card' + sel + '" data-key="' + esc(p.key) + '">' +
          '<div class="label">' + esc(label) + '</div>' +
          '<div class="detail">' + esc(detail) + '</div></div>';
      }).join('');
      presetSectionsHtml += '<div class="preset-section">' + esc(sec.name) + '</div><div class="preset-grid">' + cards + '</div>';
    });

    const customs = state.customStrengths.map((s, i) => [
      '<div class="custom-strength">',
      '  <div class="field-row">',
      '    <div class="field"><label>' + (isJa ? 'ラベル' : 'Label') + '<span class="req">*</span></label>',
      '      <input data-custom="label" data-idx="' + i + '" type="text" value="' + esc(s.label || '') + '" placeholder="' + (isJa ? '例: 越境 EC 構築' : 'e.g. Cross-border e-commerce build') + '">',
      '    </div>',
      '    <div class="field"><label>' + (isJa ? 'キーワード (カンマ区切り)' : 'Keywords (comma-separated)') + '</label>',
      '      <input data-custom="keywords" data-idx="' + i + '" type="text" value="' + esc((s.keywords || []).join(',')) + '">',
      '    </div>',
      '  </div>',
      '  <div class="field"><label>' + (isJa ? '詳細' : 'Detail') + '<span class="req">*</span></label>',
      '    <textarea data-custom="detail" data-idx="' + i + '">' + esc(s.detail || '') + '</textarea>',
      '  </div>',
      '  <button class="btn btn-link" data-custom-remove="' + i + '" style="padding:4px 8px;font-size:11px;color:var(--danger)">' + (isJa ? '削除' : 'Remove') + '</button>',
      '</div>',
    ].join('')).join('');

    return [
      '<div class="welcome-grid" style="grid-template-columns: 64px 1fr; align-items: center; margin-bottom: 8px;">',
      '  <div style="font-size: 40px;">💪</div>',
      '  <div>',
      isJa
        ? '    <h2 style="margin: 0 0 4px;">自社の強み</h2>'
        : '    <h2 style="margin: 0 0 4px;">Your strengths</h2>',
      isJa
        ? '    <p class="lead" style="margin: 0;">フォーム送信時に相手企業のニーズに応じて 1〜2 個を選んで文面に反映します。<strong>最低 1 つ必須</strong>。</p>'
        : '    <p class="lead" style="margin: 0;">When sending, 1-2 of these will be selected based on the recipient&#39;s needs and woven into the message. <strong>At least one is required.</strong></p>',
      '  </div>',
      '</div>',
      '<hr class="divider">',
      errBox,
      presetSectionsHtml,
      '<div style="display:flex;justify-content:space-between;align-items:center;margin: 24px 0 8px;">',
      '  <div class="preset-section" style="margin: 0;">' + (isJa ? 'カスタム強み (任意)' : 'Custom strengths (optional)') + '</div>',
      '  <button class="btn btn-link" id="addCustom">+ ' + (isJa ? '追加' : 'Add') + '</button>',
      '</div>',
      customs,
    ].join('');
  }

  function renderStep3Actions() {
    const isJa = (state.language || 'ja') === 'ja';
    return [
      '<button class="btn btn-secondary" data-action="back">' + (isJa ? '戻る' : 'Back') + '</button>',
      '<div class="wiz-actions-right">',
      '  <button class="btn btn-primary" data-action="next">' + (isJa ? '次へ' : 'Next') + '</button>',
      '</div>',
    ].join('');
  }

  function bindStep3() {
    document.querySelectorAll('.preset-card').forEach((el) => {
      el.addEventListener('click', () => {
        const k = el.dataset.key;
        const i = state.selectedPresetKeys.indexOf(k);
        if (i >= 0) state.selectedPresetKeys.splice(i, 1);
        else state.selectedPresetKeys.push(k);
        persistProgress();
        render();
      });
    });
    const addBtn = $('#addCustom');
    if (addBtn) addBtn.addEventListener('click', () => {
      state.customStrengths.push({ label: '', detail: '', keywords: [] });
      persistProgress();
      render();
    });
    document.querySelectorAll('[data-custom]').forEach((el) => {
      el.addEventListener('input', (e) => {
        const idx = Number(el.dataset.idx);
        const f = el.dataset.custom;
        if (!state.customStrengths[idx]) return;
        if (f === 'keywords') {
          state.customStrengths[idx].keywords = e.target.value.split(',').map((s) => s.trim()).filter(Boolean);
        } else {
          state.customStrengths[idx][f] = e.target.value;
        }
        persistProgress();
      });
    });
    document.querySelectorAll('[data-custom-remove]').forEach((el) => {
      el.addEventListener('click', () => {
        state.customStrengths.splice(Number(el.dataset.customRemove), 1);
        persistProgress();
        render();
      });
    });
    document.querySelector('[data-action="back"]').addEventListener('click', () => setStep(2));
    document.querySelector('[data-action="next"]').addEventListener('click', async () => {
      const isJa = (state.language || 'ja') === 'ja';
      const merged = mergeStrengths();
      const r = await fetchJson('/api/onboarding/validate', {
        method: 'POST',
        body: JSON.stringify({ step: 'strengths', strengths: merged })
      });
      if (r.body && r.body.errors && r.body.errors.length === 0) setStep(4);
      else { state.errors = (r.body && r.body.errors) || [{ message: isJa ? 'サーバ検証に失敗しました' : 'Server-side validation failed' }]; render(); }
    });
  }

  function mergeStrengths() {
    const presetSelected = PRESETS.filter((p) => state.selectedPresetKeys.indexOf(p.key) >= 0);
    return presetSelected.concat(state.customStrengths.filter((s) => s && s.label && s.detail));
  }

  // ---- step 4: target list (optional) ----
  function renderStep4() {
    const isJa = (state.language || 'ja') === 'ja';
    const errBox = state.errors.length === 0 ? '' :
      '<div class="errors"><ul>' + state.errors.map((e) => '<li>' + esc(e.message) + '</li>').join('') + '</ul></div>';
    const loadedCount = state.targetList ? state.targetList.length : (state.targetListMeta && state.targetListMeta.count) || 0;
    const summary = state.targetListMeta
      ? (isJa
          ? '<div class="target-summary">✓ <strong>' + esc(state.targetListMeta.fileName) + '</strong> を読み込みました — 会社 ' + loadedCount + ' 件</div>'
          : '<div class="target-summary">✓ Loaded <strong>' + esc(state.targetListMeta.fileName) + '</strong> — ' + loadedCount + ' compan' + (loadedCount === 1 ? 'y' : 'ies') + '</div>')
      : '';
    return [
      '<div class="welcome-grid" style="grid-template-columns: 64px 1fr; align-items: center; margin-bottom: 8px;">',
      '  <div style="font-size: 40px;">📋</div>',
      '  <div>',
      isJa
        ? '    <h2 style="margin: 0 0 4px;">ターゲットリスト <span style="color: var(--text-3); font-weight: 500; font-size: 14px;">(任意)</span></h2>'
        : '    <h2 style="margin: 0 0 4px;">Target list <span style="color: var(--text-3); font-weight: 500; font-size: 14px;">(optional)</span></h2>',
      isJa
        ? '    <p class="lead" style="margin: 0;">アプローチしたい会社の Excel/CSV をドラッグ&ドロップ。後でも追加可能です。<br>必須カラム: <code>会社名</code> / 推奨: <code>URL</code> <code>フォームURL</code></p>'
        : '    <p class="lead" style="margin: 0;">Drag &amp; drop an Excel/CSV file of companies you want to reach out to. You can also add this later.<br>Required column: <code>Company name</code> / recommended: <code>URL</code> <code>Form URL</code></p>',
      '  </div>',
      '</div>',
      '<hr class="divider">',
      errBox,
      '<div class="dropzone" id="dropzone">',
      '  <input type="file" id="fileInput" accept=".xlsx,.xls,.csv" hidden>',
      '  <div class="ico">📂</div>',
      '  <div class="main-text">' + (isJa ? 'クリック または ドラッグ&ドロップ' : 'Click or drag &amp; drop') + '</div>',
      '  <div class="sub-text">' + (isJa ? '.xlsx / .xls / .csv 対応' : 'Supports .xlsx / .xls / .csv') + '</div>',
      '</div>',
      summary,
    ].join('');
  }

  function renderStep4Actions() {
    const isJa = (state.language || 'ja') === 'ja';
    return [
      '<button class="btn btn-secondary" data-action="back">' + (isJa ? '戻る' : 'Back') + '</button>',
      '<div class="wiz-actions-right">',
      '  <button class="btn btn-link" data-action="skip">' + (isJa ? 'スキップ' : 'Skip') + '</button>',
      '  <button class="btn btn-primary" data-action="next">' + (isJa ? '次へ' : 'Next') + '</button>',
      '</div>',
    ].join('');
  }

  function bindStep4() {
    const dz = $('#dropzone');
    const fi = $('#fileInput');
    dz.addEventListener('click', () => fi.click());
    dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('over'); });
    dz.addEventListener('dragleave', () => dz.classList.remove('over'));
    dz.addEventListener('drop', (e) => { e.preventDefault(); dz.classList.remove('over'); if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); });
    fi.addEventListener('change', (e) => { if (e.target.files[0]) handleFile(e.target.files[0]); });
    document.querySelector('[data-action="back"]').addEventListener('click', () => setStep(3));
    document.querySelector('[data-action="skip"]').addEventListener('click', () => { state.targetList = null; state.targetListMeta = null; setStep(5); });
    document.querySelector('[data-action="next"]').addEventListener('click', () => setStep(5));
  }

  function handleFile(file) {
    const isJa = (state.language || 'ja') === 'ja';
    const reader = new FileReader();
    reader.onload = function () {
      const bytes = new Uint8Array(reader.result);
      let binary = '';
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      const contentBase64 = btoa(binary);
      fetchJson('/api/onboarding/import-targets', {
        method: 'POST',
        body: JSON.stringify({ fileName: file.name, contentBase64 })
      }).then((r) => {
        if (r.body && r.body.ok) {
          state.targetList = r.body.targets;
          state.targetListMeta = { fileName: file.name, count: r.body.count || r.body.targets.length, targetPath: r.body.targetPath || '' };
          state.errors = [];
          persistProgress();
        } else {
          state.errors = [{ message: (r.body && r.body.error) || (isJa ? 'ファイル読み込みに失敗しました' : 'Failed to read the file') }];
        }
        render();
      });
    };
    reader.onerror = function () {
      state.errors = [{ message: isJa ? 'ファイル読み込みに失敗しました' : 'Failed to read the file' }];
      render();
    };
    reader.readAsArrayBuffer(file);
  }

  // ---- step 5: AI auth ----
  const AI_PROVIDERS_JA = [
    { id: 'claude', name: 'Claude',    vendor: 'Anthropic', icon: '/assets/vendor/ai-icons/claude-code.svg',  desc: 'Claude Code CLI を使って分析・送信' },
    { id: 'codex',  name: 'Codex',     vendor: 'OpenAI',    icon: '/assets/vendor/ai-icons/codex-openai.svg', desc: 'OpenAI Codex CLI を使って分析・送信' },
    { id: 'gemini', name: 'Gemini',    vendor: 'Google',    icon: '/assets/vendor/ai-icons/gemini-cli.svg',   desc: 'Google Gemini CLI を使って分析・送信' },
  ];
  const AI_PROVIDERS_EN = [
    { id: 'claude', name: 'Claude',    vendor: 'Anthropic', icon: '/assets/vendor/ai-icons/claude-code.svg',  desc: 'Use Claude Code CLI to analyze and send' },
    { id: 'codex',  name: 'Codex',     vendor: 'OpenAI',    icon: '/assets/vendor/ai-icons/codex-openai.svg', desc: 'Use OpenAI Codex CLI to analyze and send' },
    { id: 'gemini', name: 'Gemini',    vendor: 'Google',    icon: '/assets/vendor/ai-icons/gemini-cli.svg',   desc: 'Use Google Gemini CLI to analyze and send' },
  ];

  function aiStatusBadge(provider) {
    const isJa = (state.language || 'ja') === 'ja';
    const status = state.aiAuthStatus && state.aiAuthStatus[provider];
    if (!status) return '<span class="status unknown"><span class="dot"></span>' + (isJa ? '未確認' : 'Not checked') + '</span>';
    if (status.checking) return '<span class="status unknown"><span class="spinner" style="width:9px;height:9px;border-width:1.5px;vertical-align:middle"></span> ' + (isJa ? '確認中…' : 'Checking…') + '</span>';
    if (status.installed && status.loggedIn) return '<span class="status ok"><span class="dot"></span>' + (isJa ? '接続済' : 'Connected') + '</span>';
    if (status.installed) return '<span class="status bad"><span class="dot"></span>' + (isJa ? '未ログイン' : 'Not signed in') + '</span>';
    return '<span class="status bad"><span class="dot"></span>' + (isJa ? '未インストール' : 'Not installed') + '</span>';
  }

  function renderStep5() {
    const isJa = (state.language || 'ja') === 'ja';
    const AI_PROVIDERS = isJa ? AI_PROVIDERS_JA : AI_PROVIDERS_EN;
    const errBox = state.errors.length === 0 ? '' :
      '<div class="errors"><ul>' + state.errors.map((e) => '<li>' + esc(e.message) + '</li>').join('') + '</ul></div>';
    const cards = AI_PROVIDERS.map((p) => {
      const sel = state.aiProvider === p.id ? ' selected' : '';
      return [
        '<div class="ai-card' + sel + '" data-ai="' + esc(p.id) + '">',
        '  <div class="ai-icon-wrap"><img src="' + esc(p.icon) + '" alt="' + esc(p.name) + '" width="34" height="34" onerror="this.style.display=\\'none\\'"></div>',
        '  <div class="name">' + esc(p.name) + '</div>',
        '  <div class="vendor">' + esc(p.vendor) + '</div>',
        '  <div>' + aiStatusBadge(p.id) + '</div>',
        '</div>',
      ].join('');
    }).join('');

    const selectedProvider = AI_PROVIDERS.find((p) => p.id === state.aiProvider) || AI_PROVIDERS[0];
    const status = state.aiAuthStatus && state.aiAuthStatus[state.aiProvider];
    let actionHint = '';
    if (status && status.installed === false) {
      actionHint =
        '<div class="notice warn"><strong>' + esc(selectedProvider.name) + (isJa ? ' CLI が未インストールです' : ' CLI is not installed') + '</strong>' +
        (isJa
          ? 'ターミナルで以下のコマンドでインストールしてから「認証状態を再確認」してください:<br>'
          : 'Install it from a terminal with the command below, then click &quot;Re-check status&quot;:<br>') +
        '<code style="display:block;margin-top:8px;padding:8px;background:#fff;border:1px solid var(--border);border-radius:6px;font-family:monospace;">' +
        (state.aiProvider === 'claude' ? 'npm install -g @anthropic-ai/claude-code' :
         state.aiProvider === 'codex' ? 'npm install -g @openai/codex' :
         'npm install -g @google/gemini-cli') +
        '</code></div>';
    } else if (status && status.installed && !status.loggedIn) {
      actionHint =
        '<div class="notice info"><strong>' + esc(selectedProvider.name) + (isJa ? ' CLI に未ログインです' : ' CLI is not signed in') + '</strong>' +
        (isJa
          ? 'ダッシュボードの「AI を起動」→ ターミナルで <code>/login</code> (または各 CLI のログイン手順) を実行してください。'
          : 'From the dashboard click &quot;Start AI&quot;, then run <code>/login</code> in the terminal (or follow that CLI&#39;s sign-in flow).') +
        (state.aiProvider === 'claude'
          ? (isJa
              ? '<br>Claude は <a href="https://claude.ai/login" target="_blank" rel="noopener">claude.ai/login</a> 経由のブラウザ認証です。'
              : '<br>Claude uses browser-based auth via <a href="https://claude.ai/login" target="_blank" rel="noopener">claude.ai/login</a>.')
          : '') +
        '</div>';
    } else if (status && status.installed && status.loggedIn) {
      actionHint =
        '<div class="notice ok"><strong>✓ ' + esc(selectedProvider.name) + (isJa ? ' 連携 OK' : ' is ready') + '</strong>' +
        (isJa ? 'セットアップを完了できます。' : 'You can complete setup now.') +
        '</div>';
    } else {
      actionHint = '<div class="notice info"><strong>' +
        (isJa ? '認証状態を確認中…' : 'Checking auth status…') +
        '</strong>' +
        (isJa ? '「認証状態を再確認」ボタンで再度チェックできます。' : 'Use the &quot;Re-check status&quot; button to retry.') +
        '</div>';
    }

    return [
      '<div class="welcome-grid" style="grid-template-columns: 64px 1fr; align-items: center; margin-bottom: 8px;">',
      '  <div style="font-size: 40px;">🤖</div>',
      '  <div>',
      isJa
        ? '    <h2 style="margin: 0 0 4px;">AI 連携</h2>'
        : '    <h2 style="margin: 0 0 4px;">AI integration</h2>',
      isJa
        ? '    <p class="lead" style="margin: 0;">フォーム解析と入力を担当する AI CLI を選びます。Sales Claw 自体には課金機能はなく、各 AI プロバイダの料金体系に従います。</p>'
        : '    <p class="lead" style="margin: 0;">Choose the AI CLI that will analyze and fill forms. Sales Claw itself does not bill; each AI provider charges per their own pricing.</p>',
      '  </div>',
      '</div>',
      '<hr class="divider">',
      errBox,
      '<div class="ai-providers">' + cards + '</div>',
      actionHint,
      '<button class="btn btn-secondary" id="recheckAi" style="margin-top: 14px;">',
      '  <span class="spinner" id="recheckSpinner" style="display:none"></span>',
      '  ' + (isJa ? '認証状態を再確認' : 'Re-check status'),
      '</button>',
      '<label class="terms-check" style="margin-top: 24px;">',
      '  <input type="checkbox" id="bypassAi"' + (state.bypassAi ? ' checked' : '') + '>',
      '  <span class="box"></span>',
      isJa
        ? '  <span>後で設定する (AI 連携なしで完了する) — フォーム入力機能は使えません</span>'
        : '  <span>Configure later (finish without AI integration) — form filling will not be available</span>',
      '</label>',
    ].join('');
  }

  function renderStep5Actions() {
    const isJa = (state.language || 'ja') === 'ja';
    return [
      '<button class="btn btn-secondary" data-action="back">' + (isJa ? '戻る' : 'Back') + '</button>',
      '<div class="wiz-actions-right">',
      '  <button class="btn btn-primary" data-action="finish">' + (isJa ? 'セットアップ完了' : 'Finish setup') + '</button>',
      '</div>',
    ].join('');
  }

  function bindStep5() {
    document.querySelectorAll('.ai-card').forEach((el) => {
      el.addEventListener('click', () => { state.aiProvider = el.dataset.ai; persistProgress(); render(); if (!state.aiAuthStatus[state.aiProvider]) setTimeout(() => checkAiAuth(state.aiProvider), 80); });
    });
    async function checkAiAuth(provider) {
      const target = provider || state.aiProvider;
      state.aiAuthStatus[target] = { checking: true };
      const spinner = $('#recheckSpinner');
      if (spinner) spinner.style.display = 'inline-block';
      render();
      try {
        const r = await fetchJson('/api/onboarding/check-ai?provider=' + encodeURIComponent(target));
        state.aiAuthStatus[target] = (r.body && r.body.status) || { installed: false, loggedIn: false };
      } catch (_) {
        state.aiAuthStatus[target] = { installed: false, loggedIn: false, error: 'check failed' };
      }
      render();
    }
    const recheckBtn = $('#recheckAi');
    if (recheckBtn) recheckBtn.addEventListener('click', () => checkAiAuth(state.aiProvider));
    const bypassEl = $('#bypassAi');
    if (bypassEl) bypassEl.addEventListener('change', (e) => { state.bypassAi = e.target.checked; persistProgress(); });
    document.querySelector('[data-action="back"]').addEventListener('click', () => setStep(4));
    document.querySelector('[data-action="finish"]').addEventListener('click', finish);
    // 初回または provider 切替時に未確認なら自動チェック
    if (!state.aiAuthStatus[state.aiProvider]) {
      setTimeout(() => checkAiAuth(state.aiProvider), 120);
    }
  }

  async function finish() {
    const isJa = (state.language || 'ja') === 'ja';
    const payload = {
      companyProfile: state.companyProfile,
      valuePropositions: { strengths: mergeStrengths() },
      targetList: state.targetList,
      aiProvider: state.aiProvider,
      aiAuthStatus: state.aiAuthStatus[state.aiProvider] || null,
      bypassAi: state.bypassAi,
    };
    const r = await fetchJson('/api/onboarding/complete', { method: 'POST', body: JSON.stringify(payload) });
    if (r.body && r.body.ok) {
      window.location.href = '/' + (SESSION_TOKEN ? '?session=' + encodeURIComponent(SESSION_TOKEN) : '');
    } else {
      state.errors = (r.body && r.body.errors) || [{ message: isJa ? 'セットアップに失敗しました。もう一度お試しください。' : 'Setup failed. Please try again.' }];
      render();
    }
  }

  function cancelWizard() {
    const isJa = (state.language || 'ja') === 'ja';
    const msg = isJa
      ? 'セットアップをキャンセルしますか? 入力した内容は保存されています。再起動時に続きから再開できます。'
      : 'Cancel setup? Your progress has been saved and will resume next time you start.';
    if (confirm(msg)) {
      window.location.href = '/' + (SESSION_TOKEN ? '?session=' + encodeURIComponent(SESSION_TOKEN) : '');
    }
  }

  // ---- main render ----
  function render() {
    renderStepper();
    const host = $('#cardHost');
    const actions = $('#actionsHost');
    const card = { 1: renderStep1, 2: renderStep2, 3: renderStep3, 4: renderStep4, 5: renderStep5 };
    const acts = { 1: renderStep1Actions, 2: renderStep2Actions, 3: renderStep3Actions, 4: renderStep4Actions, 5: renderStep5Actions };
    const binds = { 1: bindStep1, 2: bindStep2, 3: bindStep3, 4: bindStep4, 5: bindStep5 };
    host.innerHTML = card[state.step]();
    actions.innerHTML = acts[state.step]();
    binds[state.step]();
  }

  render();
})();
</script>
</body>
</html>`;
}

module.exports = {
  renderOnboardingPage,
  PRESET_STRENGTHS,
  TERMS_BULLETS,
};

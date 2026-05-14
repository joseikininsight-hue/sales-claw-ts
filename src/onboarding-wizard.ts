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
 */

const PRESET_STRENGTHS = [
  { key: 'cms', label: 'CMS 構築', detail: 'Sitecore / WordPress / HubSpot 等のサイト構築・運用', keywords: ['cms', 'wordpress', 'sitecore', 'コンテンツ管理', 'ウェブサイト構築'] },
  { key: 'web_app', label: 'Web アプリ開発', detail: 'フロントエンド / バックエンド / API の業務系 Web 開発', keywords: ['webアプリ', 'システム開発', 'フロントエンド', 'バックエンド', 'api'] },
  { key: 'ai', label: 'AI 開発', detail: 'RAG・チャットボット・生成 AI 活用案件', keywords: ['ai', '人工知能', '機械学習', 'チャットボット', '生成ai', 'rag'] },
  { key: 'cloud', label: 'クラウド構築', detail: 'AWS / Azure / GCP のインフラ設計・運用', keywords: ['aws', 'azure', 'gcp', 'クラウド', 'インフラ'] },
  { key: 'design', label: 'UI/UX デザイン', detail: '戦略からデザイン・実装までの一貫体制', keywords: ['デザイン', 'ui', 'ux', 'クリエイティブ', 'ブランディング'] },
  { key: 'integration', label: 'システム連携', detail: 'CRM / MA / 基幹システムとの API 連携・SSO', keywords: ['連携', 'api', 'crm', 'salesforce', 'マーケティングオートメーション'] },
  { key: 'mobile', label: 'モバイルアプリ開発', detail: 'iOS / Android ネイティブ・React Native', keywords: ['ios', 'android', 'モバイル', 'アプリ開発'] },
  { key: 'data', label: 'データ分析・基盤', detail: 'DWH 構築・BI ダッシュボード・ETL パイプライン', keywords: ['データ分析', 'bi', 'dwh', 'etl', 'データ基盤'] },
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
function renderOnboardingPage(ctx: { sessionToken?: string; savedProgress?: Record<string, unknown> | null } = {}) {
  const sessionToken = ctx.sessionToken || '';
  const savedProgress = ctx.savedProgress || null;
  const presetJson = JSON.stringify(PRESET_STRENGTHS);
  const progressJson = JSON.stringify(savedProgress || {});

  return `<!doctype html>
<html lang="ja" data-theme="light">
<head>
<meta charset="utf-8">
<title>Sales Claw — 初回セットアップ</title>
<meta name="viewport" content="width=1200">
<style>
:root {
  --bg: #f7f8fb;
  --bg-card: #ffffff;
  --border: #e5e8ef;
  --border-strong: #cdd2db;
  --text-1: #111827;
  --text-2: #4b5563;
  --text-3: #9ca3af;
  --primary: #2563eb;
  --primary-hover: #1d4ed8;
  --success: #16a34a;
  --danger: #dc2626;
  --warning: #ea580c;
  --shadow: 0 6px 24px rgba(15, 23, 42, .08);
  --radius: 12px;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  font-family: 'Segoe UI', 'Noto Sans JP', system-ui, -apple-system, sans-serif;
  background: var(--bg);
  color: var(--text-1);
  min-height: 100vh;
  font-size: 14px;
}
.wiz-shell {
  max-width: 920px;
  margin: 0 auto;
  padding: 32px 24px 64px;
}
.wiz-header {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 24px;
}
.wiz-logo {
  width: 40px;
  height: 40px;
  border-radius: 10px;
  background: linear-gradient(135deg, #2563eb, #4f46e5);
  display: grid;
  place-items: center;
  color: #fff;
  font-weight: 700;
  font-size: 16px;
}
.wiz-title-block h1 {
  margin: 0;
  font-size: 18px;
  font-weight: 700;
}
.wiz-title-block .sub {
  margin: 0;
  font-size: 12px;
  color: var(--text-3);
}
.wiz-stepper {
  display: flex;
  gap: 8px;
  margin-bottom: 24px;
}
.wiz-step-pill {
  flex: 1;
  padding: 12px 14px;
  border-radius: 10px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  color: var(--text-3);
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  font-weight: 600;
  transition: all .15s;
}
.wiz-step-pill .num {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--border);
  color: #fff;
  display: grid;
  place-items: center;
  font-size: 11px;
  font-weight: 700;
}
.wiz-step-pill.active { color: var(--text-1); border-color: var(--primary); box-shadow: 0 0 0 2px rgba(37, 99, 235, .12); }
.wiz-step-pill.active .num { background: var(--primary); }
.wiz-step-pill.done { color: var(--text-2); border-color: var(--success); }
.wiz-step-pill.done .num { background: var(--success); }
.wiz-step-pill.done .num::before { content: '✓'; }
.wiz-step-pill.done .num span { display: none; }
.wiz-card {
  background: var(--bg-card);
  border-radius: var(--radius);
  border: 1px solid var(--border);
  box-shadow: var(--shadow);
  padding: 32px;
  min-height: 420px;
}
.wiz-card h2 {
  margin: 0 0 8px;
  font-size: 22px;
  font-weight: 700;
}
.wiz-card .sub {
  margin: 0 0 24px;
  color: var(--text-2);
  font-size: 13px;
}
.wiz-actions {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 32px;
  padding-top: 24px;
  border-top: 1px solid var(--border);
}
.btn {
  padding: 10px 20px;
  border-radius: 8px;
  border: 1px solid transparent;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: all .12s;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.btn-primary { background: var(--primary); color: #fff; }
.btn-primary:hover { background: var(--primary-hover); }
.btn-primary:disabled { background: var(--text-3); cursor: not-allowed; }
.btn-secondary { background: transparent; border-color: var(--border-strong); color: var(--text-1); }
.btn-secondary:hover { background: var(--bg); }
.btn-link { background: transparent; border-color: transparent; color: var(--primary); padding: 10px 8px; }
.btn-link:hover { text-decoration: underline; }
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 16px;
}
.field-row { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.field-row .field { margin-bottom: 0; }
.field label {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-2);
  display: flex;
  align-items: center;
  gap: 6px;
}
.field .req { color: var(--danger); }
.field input, .field textarea, .field select {
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid var(--border-strong);
  font-size: 13px;
  background: #fff;
  transition: border-color .12s, box-shadow .12s;
  font-family: inherit;
}
.field input:focus, .field textarea:focus, .field select:focus {
  outline: none;
  border-color: var(--primary);
  box-shadow: 0 0 0 3px rgba(37, 99, 235, .12);
}
.field textarea { min-height: 64px; resize: vertical; }
.field .hint { font-size: 11px; color: var(--text-3); }
.field.error input, .field.error textarea, .field.error select { border-color: var(--danger); }
.field .err { font-size: 11px; color: var(--danger); }
.notice {
  padding: 14px 16px;
  border-radius: 10px;
  background: #fff8ec;
  border: 1px solid #f5d99a;
  color: #92590e;
  margin-bottom: 24px;
  font-size: 13px;
  line-height: 1.6;
}
.notice.danger { background: #fef2f2; border-color: #fca5a5; color: #b91c1c; }
.notice.info { background: #eff6ff; border-color: #93c5fd; color: #1d4ed8; }
.notice.ok { background: #f0fdf4; border-color: #86efac; color: #166534; }
.notice strong { display: block; margin-bottom: 4px; font-size: 13px; }
.terms-list {
  margin: 12px 0 4px 16px;
  padding: 0;
  font-size: 13px;
  color: var(--text-2);
  line-height: 1.7;
}
.checkbox {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin-top: 16px;
  cursor: pointer;
  font-size: 13px;
}
.checkbox input { margin-top: 3px; }
.preset-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 10px;
  margin: 16px 0 24px;
}
.preset-card {
  padding: 14px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--bg-card);
  cursor: pointer;
  transition: all .12s;
}
.preset-card:hover { border-color: var(--border-strong); }
.preset-card.selected {
  border-color: var(--primary);
  background: #f0f6ff;
  box-shadow: 0 0 0 2px rgba(37, 99, 235, .12);
}
.preset-card .label { font-weight: 600; font-size: 13px; }
.preset-card .detail { font-size: 11px; color: var(--text-3); margin-top: 4px; line-height: 1.5; }
.custom-strength {
  border: 1px dashed var(--border-strong);
  border-radius: 10px;
  padding: 12px;
  background: var(--bg);
  margin-bottom: 12px;
}
.dropzone {
  border: 2px dashed var(--border-strong);
  border-radius: 12px;
  padding: 48px 24px;
  text-align: center;
  cursor: pointer;
  transition: all .15s;
  background: var(--bg);
}
.dropzone:hover, .dropzone.over { border-color: var(--primary); background: #f0f6ff; }
.dropzone .ico { font-size: 32px; margin-bottom: 8px; }
.dropzone .main-text { font-weight: 600; }
.dropzone .sub-text { font-size: 12px; color: var(--text-3); margin-top: 4px; }
.target-summary { margin-top: 16px; padding: 14px; border-radius: 10px; background: #f0fdf4; border: 1px solid #86efac; color: #166534; font-size: 13px; }
.ai-providers { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin: 16px 0 24px; }
.ai-card {
  padding: 16px;
  border-radius: 10px;
  border: 2px solid var(--border);
  background: var(--bg-card);
  cursor: pointer;
  transition: all .12s;
  text-align: center;
}
.ai-card:hover { border-color: var(--border-strong); }
.ai-card.selected { border-color: var(--primary); background: #f0f6ff; }
.ai-card .name { font-weight: 700; font-size: 14px; }
.ai-card .vendor { font-size: 11px; color: var(--text-3); margin-top: 2px; }
.ai-card .status { margin-top: 8px; font-size: 11px; padding: 2px 6px; border-radius: 6px; display: inline-block; }
.ai-card .status.ok { background: #dcfce7; color: #166534; }
.ai-card .status.bad { background: #fee2e2; color: #991b1b; }
.ai-card .status.unknown { background: #f3f4f6; color: var(--text-2); }
.errors {
  background: #fef2f2;
  border: 1px solid #fca5a5;
  color: #b91c1c;
  padding: 12px 14px;
  border-radius: 8px;
  margin-bottom: 16px;
  font-size: 12px;
}
.errors ul { margin: 4px 0 0 18px; padding: 0; }
.spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid var(--border); border-top-color: var(--primary); border-radius: 50%; animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
<div class="wiz-shell">
  <div class="wiz-header">
    <div class="wiz-logo">SC</div>
    <div class="wiz-title-block">
      <h1>Sales Claw — 初回セットアップ</h1>
      <p class="sub">5 ステップで完了。後からでも 設定 タブで変更できます。</p>
    </div>
  </div>
  <div class="wiz-stepper" id="stepper"></div>
  <div class="wiz-card" id="cardHost"></div>
</div>

<script>
(function () {
  const SESSION_TOKEN = ${JSON.stringify(sessionToken)};
  const PRESETS = ${presetJson};
  const SAVED = ${progressJson};

  // ---- state ----
  const state = Object.assign({
    step: 1,
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
    aiAuthStatus: null,
    bypassAi: false,
    errors: [],
  }, SAVED || {});

  // ---- helpers ----
  const $ = (sel, root) => (root || document).querySelector(sel);
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

  // ---- stepper ----
  const STEPS = [
    { n: 1, label: 'ようこそ' },
    { n: 2, label: '自社情報' },
    { n: 3, label: '強み' },
    { n: 4, label: 'ターゲット' },
    { n: 5, label: 'AI 連携' },
  ];

  function renderStepper() {
    $('#stepper').innerHTML = STEPS.map((s) => {
      const cls = state.step === s.n ? 'active' : (state.step > s.n ? 'done' : '');
      return '<div class="wiz-step-pill ' + cls + '"><span class="num"><span>' + s.n + '</span></span>' + esc(s.label) + '</div>';
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
    return \`
      <h2>👋 Sales Claw へようこそ</h2>
      <p class="sub">企業の問い合わせフォーム経由で営業アプローチを自動化するツールです。Claude / Codex / Gemini CLI と連携してフォーム入力までを実行します。</p>

      <div class="notice danger">
        <strong>⚠ 利用前のご確認 (OSS / 自己責任)</strong>
        本ソフトウェアは MIT ライセンスのオープンソースです。以下の責任はすべてユーザー側にあります。
        <ul class="terms-list">
          <li>送信先企業の問い合わせフォーム利用規約 / 営業お断り表記の遵守</li>
          <li>特定電子メール法 / 個人情報保護法など適用法令の遵守</li>
          <li>誤送信・不適切な文面・誤った相手への送信に起因する損害</li>
          <li>Claude API / Anthropic への支払い (本アプリの料金には含まれません)</li>
          <li>Windows SmartScreen / Antivirus による警告 (本ビルドはコード署名されていません)</li>
        </ul>
      </div>

      <div class="notice info">
        <strong>📁 データの保存場所</strong>
        本アプリの設定 / ログ / スクリーンショットはすべてローカルに保存されます。<br>
        <code>%APPDATA%\\\\sales-claw\\\\runtime\\\\data\\\\</code> 配下にあります。
      </div>

      <label class="checkbox">
        <input type="checkbox" id="termsCheck" \${state.termsAgreed ? 'checked' : ''}>
        <span>上記内容を理解し、自己責任でこのツールを使用することに同意します</span>
      </label>

      <div class="wiz-actions">
        <span></span>
        <button class="btn btn-primary" id="step1Next" \${state.termsAgreed ? '' : 'disabled'}>次へ →</button>
      </div>
    \`;
  }

  function bindStep1() {
    $('#termsCheck').addEventListener('change', (e) => {
      state.termsAgreed = e.target.checked;
      $('#step1Next').disabled = !state.termsAgreed;
      persistProgress();
    });
    $('#step1Next').addEventListener('click', () => setStep(2));
  }

  // ---- step 2: company profile ----
  const PROFILE_FIELDS = [
    { key: 'companyName', label: '会社名', required: true, hint: '株式会社 ○○' },
    { key: 'contactName', label: '担当者名', required: true, hint: '山田 太郎' },
    { key: 'contactNameKana', label: '担当者名カナ', required: false, hint: 'ヤマダ タロウ' },
    { key: 'department', label: '部署', required: false },
    { key: 'contactTitle', label: '役職', required: false },
    { key: 'email', label: 'メールアドレス', required: true, hint: 'name@company.co.jp' },
    { key: 'phone', label: '電話番号', required: true, hint: '03-0000-0000' },
    { key: 'mobile', label: '携帯番号', required: false },
    { key: 'website', label: '自社 Web サイト', required: false, hint: 'https://www.example.com/' },
    { key: 'address', label: '住所', required: true, fullWidth: true },
  ];

  function renderStep2() {
    const errMap = {};
    state.errors.forEach((e) => { errMap[e.field] = e.message || e.code; });
    const errBox = state.errors.length === 0 ? '' :
      '<div class="errors"><strong>入力エラー</strong><ul>' +
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
        (f.hint ? '<span class="hint">' + esc(f.hint) + '</span>' : '') +
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

    return \`
      <h2>🏢 自社情報</h2>
      <p class="sub">送信先フォームに自動入力される情報です。* は必須項目。</p>
      \${errBox}
      \${rowsHtml}
      <div class="wiz-actions">
        <button class="btn btn-secondary" data-action="back">← 戻る</button>
        <button class="btn btn-primary" data-action="next">次へ →</button>
      </div>
    \`;
  }

  function bindStep2() {
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
      else { state.errors = (r.body && r.body.errors) || [{ message: 'サーバ検証に失敗しました' }]; render(); }
    });
  }

  // ---- step 3: strengths ----
  function renderStep3() {
    const errBox = state.errors.length === 0 ? '' :
      '<div class="errors"><strong>選択エラー</strong><ul>' +
      state.errors.map((e) => '<li>' + esc(e.message || e.code) + '</li>').join('') +
      '</ul></div>';
    const presetCards = PRESETS.map((p) => {
      const sel = state.selectedPresetKeys.indexOf(p.key) >= 0 ? ' selected' : '';
      return '<div class="preset-card' + sel + '" data-key="' + esc(p.key) + '">' +
        '<div class="label">' + esc(p.label) + '</div>' +
        '<div class="detail">' + esc(p.detail) + '</div></div>';
    }).join('');
    const customs = state.customStrengths.map((s, i) => \`
      <div class="custom-strength">
        <div class="field-row">
          <div class="field"><label>ラベル<span class="req">*</span></label>
            <input data-custom="label" data-idx="\${i}" type="text" value="\${esc(s.label || '')}" placeholder="例: 越境 EC 構築">
          </div>
          <div class="field"><label>キーワード (カンマ区切り)</label>
            <input data-custom="keywords" data-idx="\${i}" type="text" value="\${esc((s.keywords || []).join(','))}">
          </div>
        </div>
        <div class="field"><label>詳細<span class="req">*</span></label>
          <textarea data-custom="detail" data-idx="\${i}">\${esc(s.detail || '')}</textarea>
        </div>
        <button class="btn btn-link" data-custom-remove="\${i}" style="padding:4px 8px;font-size:11px">削除</button>
      </div>
    \`).join('');

    return \`
      <h2>💪 自社の強み</h2>
      <p class="sub">フォーム入力時、相手企業のニーズに応じてここから 1〜2 個を選んで文面に反映します。最低 1 つ必須。</p>
      \${errBox}
      <div><strong style="font-size:12px;color:#374151">プリセットから選ぶ</strong></div>
      <div class="preset-grid">\${presetCards}</div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <strong style="font-size:12px;color:#374151">カスタム強み</strong>
        <button class="btn btn-link" id="addCustom">+ 追加</button>
      </div>
      \${customs}
      <div class="wiz-actions">
        <button class="btn btn-secondary" data-action="back">← 戻る</button>
        <button class="btn btn-primary" data-action="next">次へ →</button>
      </div>
    \`;
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
      const merged = mergeStrengths();
      const r = await fetchJson('/api/onboarding/validate', {
        method: 'POST',
        body: JSON.stringify({ step: 'strengths', strengths: merged })
      });
      if (r.body && r.body.errors && r.body.errors.length === 0) setStep(4);
      else { state.errors = (r.body && r.body.errors) || [{ message: 'サーバ検証に失敗しました' }]; render(); }
    });
  }

  function mergeStrengths() {
    const presetSelected = PRESETS.filter((p) => state.selectedPresetKeys.indexOf(p.key) >= 0);
    return presetSelected.concat(state.customStrengths.filter((s) => s && s.label && s.detail));
  }

  // ---- step 4: target list (optional) ----
  function renderStep4() {
    const errBox = state.errors.length === 0 ? '' :
      '<div class="errors"><ul>' + state.errors.map((e) => '<li>' + esc(e.message) + '</li>').join('') + '</ul></div>';
    const loadedCount = state.targetList ? state.targetList.length : (state.targetListMeta && state.targetListMeta.count) || 0;
    const summary = state.targetListMeta ? \`
      <div class="target-summary">
        ✓ <strong>\${state.targetListMeta.fileName}</strong> を読み込みました — 会社 \${loadedCount} 件
      </div>
    \` : '';
    return \`
      <h2>📋 ターゲットリスト (任意)</h2>
      <p class="sub">アプローチしたい会社の Excel/CSV をドラッグ&ドロップしてください。後でも追加可能です。<br>
      必須カラム: <code>会社名</code>, 推奨: <code>URL</code> <code>フォームURL</code></p>
      \${errBox}
      <div class="dropzone" id="dropzone">
        <input type="file" id="fileInput" accept=".xlsx,.xls,.csv" hidden>
        <div class="ico">📂</div>
        <div class="main-text">クリック または ドラッグ&ドロップ</div>
        <div class="sub-text">.xlsx / .xls / .csv 対応</div>
      </div>
      \${summary}
      <div class="wiz-actions">
        <button class="btn btn-secondary" data-action="back">← 戻る</button>
        <div>
          <button class="btn btn-link" data-action="skip">スキップ</button>
          <button class="btn btn-primary" data-action="next">次へ →</button>
        </div>
      </div>
    \`;
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
    const reader = new FileReader();
    reader.onload = function () {
      // ArrayBuffer → base64
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
          state.errors = [{ message: (r.body && r.body.error) || 'ファイル読み込みに失敗しました' }];
        }
        render();
      });
    };
    reader.onerror = function () {
      state.errors = [{ message: 'ファイル読み込みに失敗しました' }];
      render();
    };
    reader.readAsArrayBuffer(file);
  }

  // ---- step 5: AI auth ----
  function renderStep5() {
    const errBox = state.errors.length === 0 ? '' :
      '<div class="errors"><ul>' + state.errors.map((e) => '<li>' + esc(e.message) + '</li>').join('') + '</ul></div>';
    const aiCard = (id, name, vendor) => {
      const sel = state.aiProvider === id ? ' selected' : '';
      const status = state.aiAuthStatus && state.aiAuthStatus.provider === id ? state.aiAuthStatus : null;
      let badge = '<span class="status unknown">未確認</span>';
      if (status) {
        if (status.installed && status.loggedIn) badge = '<span class="status ok">✓ 接続済</span>';
        else if (status.installed) badge = '<span class="status bad">未ログイン</span>';
        else badge = '<span class="status bad">未インストール</span>';
      }
      return \`<div class="ai-card\${sel}" data-ai="\${id}">
        <div class="name">\${esc(name)}</div>
        <div class="vendor">\${esc(vendor)}</div>
        <div>\${badge}</div>
      </div>\`;
    };
    return \`
      <h2>🤖 AI 連携</h2>
      <p class="sub">フォーム解析と入力を担当する AI CLI を選びます。Sales Claw 自体には課金機能はなく、各 AI プロバイダの料金体系に従います。</p>
      \${errBox}
      <div class="ai-providers">
        \${aiCard('claude', 'Claude', 'Anthropic')}
        \${aiCard('codex', 'Codex', 'OpenAI')}
        \${aiCard('gemini', 'Gemini', 'Google')}
      </div>

      <div class="notice info">
        <strong>📝 ログイン方法</strong>
        選択した CLI が「未ログイン」の場合、ダッシュボードの「AI を起動」→ ターミナルで <code>/login</code> を入力してください。<br>
        Claude の場合は <a href="https://claude.ai/login" target="_blank">claude.ai/login</a> 経由のブラウザ認証になります。<br>
        セットアップ完了後でも変更できます。
      </div>

      <button class="btn btn-secondary" id="recheckAi">
        <span class="spinner" id="recheckSpinner" style="display:none"></span>
        認証状態を確認
      </button>

      <label class="checkbox" style="margin-top:24px">
        <input type="checkbox" id="bypassAi" \${state.bypassAi ? 'checked' : ''}>
        <span>後で設定する (AI 連携なしで完了する) — フォーム入力機能は使えません</span>
      </label>

      <div class="wiz-actions">
        <button class="btn btn-secondary" data-action="back">← 戻る</button>
        <button class="btn btn-primary" data-action="finish">セットアップ完了 ✓</button>
      </div>
    \`;
  }

  function bindStep5() {
    document.querySelectorAll('.ai-card').forEach((el) => {
      el.addEventListener('click', () => { state.aiProvider = el.dataset.ai; persistProgress(); render(); });
    });
    async function checkAiAuth() {
      const spinner = $('#recheckSpinner');
      if (spinner) spinner.style.display = 'inline-block';
      const r = await fetchJson('/api/onboarding/check-ai?provider=' + encodeURIComponent(state.aiProvider));
      if (spinner) spinner.style.display = 'none';
      state.aiAuthStatus = (r.body && r.body.status) || null;
      render();
    }
    $('#recheckAi').addEventListener('click', checkAiAuth);
    $('#bypassAi').addEventListener('change', (e) => { state.bypassAi = e.target.checked; persistProgress(); });
    document.querySelector('[data-action="back"]').addEventListener('click', () => setStep(4));
    document.querySelector('[data-action="finish"]').addEventListener('click', finish);
    if (!state.aiAuthStatus || state.aiAuthStatus.provider !== state.aiProvider) {
      setTimeout(checkAiAuth, 120);
    }
  }

  async function finish() {
    const payload = {
      companyProfile: state.companyProfile,
      valuePropositions: { strengths: mergeStrengths() },
      targetList: state.targetList,
      aiProvider: state.aiProvider,
      aiAuthStatus: state.aiAuthStatus,
      bypassAi: state.bypassAi,
    };
    const r = await fetchJson('/api/onboarding/complete', { method: 'POST', body: JSON.stringify(payload) });
    if (r.body && r.body.ok) {
      window.location.href = '/' + (SESSION_TOKEN ? '?session=' + encodeURIComponent(SESSION_TOKEN) : '');
    } else {
      state.errors = (r.body && r.body.errors) || [{ message: 'セットアップに失敗しました。もう一度お試しください。' }];
      render();
    }
  }

  // ---- main render ----
  function render() {
    renderStepper();
    const host = $('#cardHost');
    const fns = { 1: renderStep1, 2: renderStep2, 3: renderStep3, 4: renderStep4, 5: renderStep5 };
    const binds = { 1: bindStep1, 2: bindStep2, 3: bindStep3, 4: bindStep4, 5: bindStep5 };
    host.innerHTML = fns[state.step]();
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
};

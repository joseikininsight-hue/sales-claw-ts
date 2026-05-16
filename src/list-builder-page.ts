'use strict';

/**
 * List Builder UI ページレンダラ
 *
 * 要件§16 (docs/list-builder-requirements.md v2.0) に基づく:
 *   - 3 タブ: URL / 自然言語 / カテゴリ
 *   - 進捗 SSE 表示
 *   - プレビュー (適合度・信頼度・取得元・重複状態) → commit
 *
 * このファイルは単一の HTML を文字列として返す関数を提供する。
 * dashboard-server.cjs の GET /list-builder で呼ばれる。
 *
 * v2.0.32+: bilingual 対応 (lang: 'ja' | 'en'). 未指定時は 'ja'。
 */

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// JSON.stringify した文字列を <script> タグ内に安全に埋めるためのエスケープ。
// JSON.stringify 単体では </script> を分割しないため、終了タグ偽装が可能。
// </ を <\/ に置換することでスクリプトタグの早期終端を防ぐ。
function safeJsonEmbed(value) {
  return JSON.stringify(value || '').replace(/<\//g, '<\\/');
}

function renderListBuilderPage({ sessionToken, lang }: { sessionToken?: string; lang?: 'ja' | 'en' } = {}) {
  const safeToken = sessionToken || '';
  const _lang: 'ja' | 'en' = lang === 'en' ? 'en' : 'ja';
  // サーバ側で使うバイリンガル選択ヘルパ
  const T = (ja: string, en: string) => (_lang === 'ja' ? ja : en);
  const htmlLang = _lang === 'ja' ? 'ja' : 'en';

  // ---- 業種ラベル (両言語) ----
  const industryItems: Array<[string, string]> = _lang === 'ja'
    ? [['SaaS','SaaS'],['SIer','SIer'],['製造','製造'],['小売','小売'],['金融','金融'],['ヘルスケア','ヘルスケア'],['物流','物流'],['不動産','不動産'],['建設','建設'],['広告/マーケ','広告/マーケ'],['コンサル','コンサル'],['その他','その他']]
    : [['SaaS','SaaS'],['SIer','SIer'],['製造','Manufacturing'],['小売','Retail'],['金融','Finance'],['ヘルスケア','Healthcare'],['物流','Logistics'],['不動産','Real Estate'],['建設','Construction'],['広告/マーケ','Advertising/Marketing'],['コンサル','Consulting'],['その他','Other']];

  // ---- 都道府県 (en では英訳付き) ----
  const prefectureItems: Array<[string, string]> = _lang === 'ja'
    ? [['東京都','東京都'],['大阪府','大阪府'],['愛知県','愛知県'],['神奈川県','神奈川県'],['福岡県','福岡県'],['北海道','北海道'],['京都府','京都府'],['兵庫県','兵庫県'],['埼玉県','埼玉県'],['千葉県','千葉県']]
    : [['東京都','Tokyo'],['大阪府','Osaka'],['愛知県','Aichi'],['神奈川県','Kanagawa'],['福岡県','Fukuoka'],['北海道','Hokkaido'],['京都府','Kyoto'],['兵庫県','Hyogo'],['埼玉県','Saitama'],['千葉県','Chiba']];

  // ---- 売上規模 ----
  const revenueItems: Array<[string, string]> = _lang === 'ja'
    ? [['under_100m','1億未満'],['100m-1b','1〜10億'],['1b-10b','10〜100億'],['10b-100b','100〜1000億'],['over_100b','1000億超']]
    : [['under_100m','< 100M JPY'],['100m-1b','100M–1B JPY'],['1b-10b','1B–10B JPY'],['10b-100b','10B–100B JPY'],['over_100b','> 100B JPY']];

  return `<!doctype html>
<html lang="${htmlLang}">
<head>
<meta charset="utf-8">
<title>${T('リスト作成 — Sales Claw', 'List Builder — Sales Claw')}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root {
    --bg: #0d1117;
    --panel: #161b22;
    --panel-2: #21262d;
    --text: #e6edf3;
    --text-2: #8b949e;
    --accent: #2f81f7;
    --success: #3fb950;
    --warn: #f0883e;
    --danger: #f85149;
    --border: #30363d;
  }
  * { box-sizing: border-box; }
  body {
    background: var(--bg); color: var(--text); margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Hiragino Kaku Gothic ProN', 'Noto Sans JP', sans-serif;
    font-size: 14px; line-height: 1.5;
  }
  header {
    background: var(--panel); border-bottom: 1px solid var(--border);
    padding: 12px 24px; display: flex; align-items: center; justify-content: space-between;
  }
  header h1 { margin: 0; font-size: 16px; font-weight: 600; }
  header a { color: var(--accent); text-decoration: none; font-size: 13px; }
  main { max-width: 1200px; margin: 24px auto; padding: 0 16px; }
  .tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--border); margin-bottom: 16px; }
  .tab {
    background: transparent; border: none; color: var(--text-2);
    padding: 10px 16px; cursor: pointer; font-size: 14px;
    border-bottom: 2px solid transparent;
  }
  .tab.active { color: var(--accent); border-bottom-color: var(--accent); }
  .tab:hover { color: var(--text); }
  .panel { background: var(--panel); border: 1px solid var(--border); border-radius: 6px; padding: 16px; }
  .panel + .panel { margin-top: 16px; }
  label { display: block; font-size: 12px; color: var(--text-2); margin-bottom: 6px; }
  textarea, input[type="text"], input[type="number"], select {
    background: var(--bg); color: var(--text); border: 1px solid var(--border);
    border-radius: 4px; padding: 8px 12px; width: 100%; font-size: 14px;
    font-family: inherit;
  }
  textarea { min-height: 100px; resize: vertical; }
  button.primary {
    background: var(--accent); color: white; border: none; border-radius: 4px;
    padding: 8px 20px; font-size: 14px; cursor: pointer; font-weight: 500;
  }
  button.primary:hover { opacity: 0.9; }
  button.primary:disabled { opacity: 0.5; cursor: not-allowed; }
  button.secondary {
    background: var(--panel-2); color: var(--text); border: 1px solid var(--border);
    border-radius: 4px; padding: 6px 14px; font-size: 13px; cursor: pointer;
  }
  .row { display: flex; gap: 12px; align-items: center; }
  .row + .row { margin-top: 8px; }
  .row .col { flex: 1; }
  .pill {
    display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 11px;
    background: var(--panel-2); color: var(--text-2); margin-right: 4px;
  }
  .pill.success { background: rgba(63, 185, 80, 0.15); color: var(--success); }
  .pill.warn { background: rgba(240, 136, 62, 0.15); color: var(--warn); }
  .pill.danger { background: rgba(248, 81, 73, 0.15); color: var(--danger); }
  .pill.jp-only { background: rgba(47, 129, 247, 0.15); color: var(--accent); }
  .progress-bar {
    background: var(--panel-2); height: 8px; border-radius: 4px; overflow: hidden;
    margin: 8px 0;
  }
  .progress-bar > div {
    background: var(--accent); height: 100%; transition: width 0.3s;
  }
  .candidate {
    background: var(--panel-2); border: 1px solid var(--border); border-radius: 4px;
    padding: 12px; margin-bottom: 8px; display: flex; gap: 12px; align-items: flex-start;
  }
  .candidate input[type="checkbox"] { margin-top: 4px; }
  .candidate .body { flex: 1; }
  .candidate .name { font-weight: 600; margin-bottom: 4px; }
  .candidate .meta { font-size: 12px; color: var(--text-2); }
  .lock-banner {
    background: rgba(240, 136, 62, 0.1); border: 1px solid var(--warn); color: var(--warn);
    padding: 12px; border-radius: 4px; margin-bottom: 16px;
  }
  .checklist { display: flex; flex-wrap: wrap; gap: 12px; }
  .checklist label {
    display: inline-flex; align-items: center; gap: 4px; color: var(--text);
    font-size: 13px; cursor: pointer;
    background: var(--panel-2); padding: 6px 10px; border-radius: 4px;
  }
  .hidden { display: none; }
  .stats { display: flex; gap: 16px; margin-bottom: 12px; font-size: 13px; }
  .stats .stat { color: var(--text-2); }
  .stats .stat strong { color: var(--text); margin-right: 4px; }
  .small { font-size: 11px; color: var(--text-2); }
  .stage-display { font-size: 12px; color: var(--text-2); margin-top: 4px; }
  .empty-state { color: var(--text-2); text-align: center; padding: 24px; }
</style>
</head>
<body>
<header>
  <h1>${T('リスト作成', 'List Builder')}</h1>
  <a href="/">${T('← ダッシュボードに戻る', '← Back to dashboard')}</a>
</header>
<main>

<div id="apiKeyWarning" class="lock-banner hidden">
  <strong>${T('注意:', 'Notice:')}</strong>
  ${T(
    'SerpApi キーが未設定のため、自然言語モード・カテゴリモードはロックされています。「Settings」タブから API キーを設定してください。',
    'SerpApi key is not configured. Natural-language and Category modes are locked. Set the key under the Settings tab.'
  )}
</div>

<div class="tabs">
  <button class="tab active" data-tab="cli">${T('AI に依頼 (CLI)', 'Ask AI (CLI)')}</button>
  <button class="tab" data-tab="url">${T('URL指定', 'From URL')}</button>
  <button class="tab" data-tab="nlq">${T('自然言語', 'Natural language')}</button>
  <button class="tab" data-tab="category">${T('カテゴリ', 'Category')} <span class="pill jp-only">${T('日本のみ', 'JP only')}</span></button>
</div>

<!-- ===== CLI Agent モード (推奨・追加 API キー不要) ===== -->
<div class="panel" id="tab-cli">
  <div style="background:#0a3a5c;color:#cce4ff;padding:10px 14px;border-radius:8px;margin-bottom:14px;font-size:13px;line-height:1.5;">
    💡 ${T(
      '<strong>起動中の Claude / Codex / Gemini CLI</strong> に企業を探してもらいます。SerpApi や法人番号 API のキーは不要。CLI が公開情報をもとに JSON で返します。実行前に「AI を起動」で CLI を起動しておいてください。',
      'Ask the <strong>running Claude / Codex / Gemini CLI</strong> to find companies. No SerpApi or Houjin-Bangou API key needed — the CLI returns JSON based on public information. Launch the CLI via "Launch AI" before running.'
    )}
  </div>
  <label>${T('探したい企業の条件（自由文）', 'Free-text criteria for the companies you want')}</label>
  <textarea id="cliInput" placeholder="${T('例) 東京都内のSIer企業で従業員50〜300人、自社プロダクトを持っている会社', 'e.g. SIer firms in Tokyo with 50–300 employees that own their own product')}" style="min-height:80px;"></textarea>
  <div class="row" style="margin-top: 12px;">
    <div class="col">
      <label>${T('取得件数', 'Count')}</label>
      <select id="cliLimit">
        <option value="10">${T('10 社', '10 companies')}</option>
        <option value="30" selected>${T('30 社', '30 companies')}</option>
        <option value="50">${T('50 社', '50 companies')}</option>
        <option value="100">${T('100 社', '100 companies')}</option>
      </select>
    </div>
    <div class="col">
      <label>${T('使用する CLI', 'CLI to use')}</label>
      <select id="cliProvider">
        <option value="claude" selected>Claude Code</option>
        <option value="codex">Codex</option>
        <option value="gemini">Gemini</option>
      </select>
    </div>
  </div>
  <div class="row" style="margin-top: 12px;">
    <button class="primary" id="cliRunBtn">${T('AI に依頼して収集開始', 'Ask AI to start collecting')}</button>
    <span style="margin-left:12px;color:var(--text-2);font-size:12px;">
      ${T('所要時間目安: 30社で 1〜3 分', 'Typical time: 1–3 min for 30 companies')}
    </span>
  </div>
</div>

<!-- ===== URL モード ===== -->
<div class="panel hidden" id="tab-url">
  <label>${T('企業一覧が載っているページのURL（複数行可）', 'Company-list page URLs (one per line)')}</label>
  <textarea id="urlInput" placeholder="https://example.com/ranking-2026
https://example.com/dx-companies"></textarea>
  <div class="row" style="margin-top: 12px;">
    <div class="col">
      <label>${T('最大ページ数', 'Max pages')}</label>
      <input type="number" id="urlMaxPages" value="10" min="1" max="50">
    </div>
    <div class="col">
      <label>${T('最大企業数', 'Max companies')}</label>
      <input type="number" id="urlMaxCompanies" value="100" min="1" max="500">
    </div>
  </div>
  <div class="row" style="margin-top: 12px;">
    <button class="primary" id="urlRunBtn">${T('スキャン開始', 'Start scan')}</button>
  </div>
</div>

<!-- ===== NLQ モード ===== -->
<div class="panel hidden" id="tab-nlq">
  <label>${T('自由文クエリ（例: 都内のSaaS企業で自社プロダクト持ち）', 'Free-text query (e.g. SaaS firms in Tokyo with their own product)')}</label>
  <textarea id="nlqInput" placeholder="${T('都内のSaaS企業で自社プロダクトを持っている会社', 'SaaS firms in Tokyo that own their own product')}"></textarea>
  <div class="row" style="margin-top: 12px;">
    <div class="col">
      <label>${T('取得件数', 'Count')}</label>
      <input type="number" id="nlqLimit" value="50" min="1" max="500">
    </div>
  </div>
  <div class="row" style="margin-top: 12px;">
    <button class="primary" id="nlqRunBtn">${T('検索開始', 'Start search')}</button>
  </div>
</div>

<!-- ===== カテゴリモード ===== -->
<div class="panel hidden" id="tab-category">
  <div style="background:rgba(47,129,247,0.08);border:1px solid var(--accent);color:var(--accent);padding:8px 12px;border-radius:6px;margin-bottom:12px;font-size:12px;">
    <span class="pill jp-only">${T('日本のみ', 'JP only')}</span>
    ${T(
      'このモードは日本の公的データソース（国税庁法人番号 API / gBizINFO / EDINET）を利用します。',
      'This mode uses Japan-only public data sources (Houjin-Bangou API / gBizINFO / EDINET).'
    )}
  </div>

  <label>${T('業種（複数選択）', 'Industry (multi-select)')}</label>
  <div class="checklist" id="industryList">
    ${industryItems.map(([v, l]) => `<label><input type="checkbox" value="${escapeHtml(v)}" name="industry"> ${escapeHtml(l)}</label>`).join('')}
  </div>

  <label style="margin-top: 12px;">${T('都道府県（複数選択、空=全国）', 'Prefecture (multi-select, empty = nationwide)')}</label>
  <div class="checklist" id="prefectureList">
    ${prefectureItems.map(([v, l]) => `<label><input type="checkbox" value="${escapeHtml(v)}" name="prefecture"> ${escapeHtml(l)}</label>`).join('')}
  </div>

  <label style="margin-top: 12px;">${T('従業員数', 'Employee count')}</label>
  <div class="checklist" id="employeeList">
    ${['1-10','11-50','51-100','101-300','301-1000','1001-5000','5001+']
      .map((e) => `<label><input type="checkbox" value="${escapeHtml(e)}" name="employee"> ${escapeHtml(e)}</label>`).join('')}
  </div>

  <label style="margin-top: 12px;">${T('売上規模', 'Revenue band')}</label>
  <div class="checklist" id="revenueList">
    ${revenueItems.map(([v, l]) => `<label><input type="checkbox" value="${escapeHtml(v)}" name="revenue"> ${escapeHtml(l)}</label>`).join('')}
  </div>

  <label style="margin-top: 12px;">${T('売上推移 ※上場企業のみ厳密判定 / 非上場は判定不能扱い', 'Revenue trend (strict for listed companies only; unlisted is treated as undecidable)')}</label>
  <div>
    <select id="growthTrend">
      <option value="any">${T('全て', 'Any')}</option>
      <option value="growing">${T('成長中', 'Growing')}</option>
      <option value="stable">${T('安定', 'Stable')}</option>
      <option value="declining">${T('減少', 'Declining')}</option>
    </select>
  </div>

  <label style="margin-top: 12px;">${T('キーワード（カンマ区切り）', 'Keywords (comma-separated)')}</label>
  <input type="text" id="keywords" placeholder="${T('自社プロダクト, 受託開発', 'own product, contract development')}">

  <label style="margin-top: 12px;">${T('取得件数', 'Count')}</label>
  <select id="categoryLimit">
    <option value="10">10</option>
    <option value="30">30</option>
    <option value="50" selected>50</option>
    <option value="100">100</option>
    <option value="200">200</option>
    <option value="500">500</option>
  </select>

  <label style="margin-top: 12px;">${T('条件未確認企業の扱い', 'Policy for companies with unverified fields')}</label>
  <div>
    <label><input type="radio" name="unknownPolicy" value="strict"> ${T('厳格（除外）', 'Strict (exclude)')}</label>
    <label><input type="radio" name="unknownPolicy" value="standard" checked> ${T('標準（要確認として残す）', 'Standard (keep as needs review)')}</label>
    <label><input type="radio" name="unknownPolicy" value="broad"> ${T('広め（含めるが信頼度低）', 'Broad (include with low confidence)')}</label>
  </div>

  <div class="row" style="margin-top: 12px;">
    <button class="primary" id="categoryRunBtn">${T('検索開始', 'Start search')}</button>
  </div>
</div>

<!-- ===== 進捗 ===== -->
<div class="panel hidden" id="progressPanel">
  <h3 style="margin: 0 0 8px;">${T('進捗', 'Progress')}</h3>
  <div class="progress-bar"><div id="progressFill" style="width: 0%"></div></div>
  <div class="stage-display">
    <span id="progressStage">${T('準備中…', 'Preparing…')}</span>
    <span id="progressCounts" style="margin-left: 12px;"></span>
  </div>
  <div id="loosenedConditions" class="small" style="margin-top: 8px;"></div>
  <div style="margin-top: 8px;">
    <button class="secondary" id="cancelBtn">${T('キャンセル', 'Cancel')}</button>
  </div>
</div>

<!-- ===== プレビュー ===== -->
<div class="panel hidden" id="previewPanel">
  <h3 style="margin: 0 0 8px;">${T('プレビュー', 'Preview')}</h3>
  <div class="stats">
    <span class="stat"><strong id="statTotal">0</strong>${T('件', ' total')}</span>
    <span class="stat"><strong id="statNew">0</strong>${T('新規', ' new')}</span>
    <span class="stat"><strong id="statDup">0</strong>${T('重複（自動除外）', ' duplicate (auto-excluded)')}</span>
    <span class="stat"><strong id="statReview">0</strong>${T('要確認', ' needs review')}</span>
    <span class="stat"><strong id="statBlocked">0</strong>${T('取得失敗', ' blocked')}</span>
  </div>
  <div id="candidateList"></div>
  <div class="row" style="margin-top: 12px;">
    <button class="primary" id="commitBtn">${T('選択分をリストに追加', 'Add selected to list')}</button>
    <button class="secondary" id="selectAllBtn">${T('全件選択', 'Select all')}</button>
    <button class="secondary" id="deselectAllBtn">${T('選択解除', 'Deselect all')}</button>
  </div>
  <div id="commitResult" class="small" style="margin-top: 8px;"></div>
</div>

</main>

<script>
(function() {
  'use strict';

  const SESSION_TOKEN = ${safeJsonEmbed(safeToken)};
  const LANG = ${safeJsonEmbed(_lang)};
  // クライアント側バイリンガル選択ヘルパ。サーバ静的部分と同じ規約。
  function L(ja, en) { return LANG === 'ja' ? ja : en; }
  const headers = SESSION_TOKEN ? { 'X-Session-Token': SESSION_TOKEN } : {};
  let currentRunId = null;
  let currentEventSource = null;
  let currentCandidates = [];

  // タブ切替
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      const target = tab.dataset.tab;
      ['cli', 'url', 'nlq', 'category'].forEach((m) => {
        document.getElementById('tab-' + m).classList.toggle('hidden', m !== target);
      });
    });
  });

  // API キー状態を確認
  async function checkApiKeys() {
    try {
      const r = await fetch('/api/list-builder/api-key-status', { headers });
      const data = await r.json();
      if (!data.ok) return;
      const hasSerpApi = !!data.apiKeys.serpApi;
      document.getElementById('apiKeyWarning').classList.toggle('hidden', hasSerpApi);
      document.getElementById('nlqRunBtn').disabled = !hasSerpApi;
      document.getElementById('categoryRunBtn').disabled = !hasSerpApi;
    } catch (e) {
      console.warn('failed to check api keys', e);
    }
  }
  checkApiKeys();

  function getCheckedValues(name) {
    return Array.from(document.querySelectorAll('input[name="' + name + '"]:checked')).map((el) => el.value);
  }

  function getRadioValue(name) {
    const el = document.querySelector('input[name="' + name + '"]:checked');
    return el ? el.value : '';
  }

  // run 実行
  async function startRun(mode, payload) {
    document.getElementById('progressPanel').classList.remove('hidden');
    document.getElementById('previewPanel').classList.add('hidden');
    document.getElementById('progressStage').textContent = L('開始中…', 'starting...');
    document.getElementById('progressFill').style.width = '0%';
    document.getElementById('progressCounts').textContent = '';
    document.getElementById('loosenedConditions').textContent = '';

    let resp;
    try {
      resp = await fetch('/api/list-builder/run', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
        body: JSON.stringify({ mode, payload }),
      });
    } catch (e) {
      document.getElementById('progressStage').textContent = L('エラー: ', 'Error: ') + e.message;
      return;
    }
    const data = await resp.json();
    if (!data.ok) {
      document.getElementById('progressStage').textContent = L('エラー: ', 'Error: ') + (data.error || 'unknown');
      return;
    }
    currentRunId = data.runId;
    subscribeStream(currentRunId);
  }

  // SSE 購読
  function subscribeStream(runId) {
    if (currentEventSource) { try { currentEventSource.close(); } catch (_) {} }
    let url = '/api/list-builder/stream/' + encodeURIComponent(runId);
    if (SESSION_TOKEN) url += '?session=' + encodeURIComponent(SESSION_TOKEN);
    currentEventSource = new EventSource(url);

    currentEventSource.addEventListener('progress', (e) => {
      const d = JSON.parse(e.data);
      const pct = d.total > 0 ? Math.round((d.completed / d.total) * 100) : 0;
      document.getElementById('progressFill').style.width = pct + '%';
      document.getElementById('progressStage').textContent = L('ステージ: ', 'Stage: ') + d.stage;
      document.getElementById('progressCounts').textContent = (d.completed || 0) + ' / ' + (d.total || 0);
      if (Array.isArray(d.loosenedConditions) && d.loosenedConditions.length > 0) {
        // textContent で挿入することで XSS を防ぐ (description はサーバ生成だが将来の混入を予防)
        document.getElementById('loosenedConditions').textContent = L('緩和: ', 'Loosened: ') +
          d.loosenedConditions.map((c) => String(c.description || '') + ' (' + Number(c.matched || 0) + L('件)', ')')).join(' → ');
      }
    });
    currentEventSource.addEventListener('result', (e) => {
      const d = JSON.parse(e.data);
      currentCandidates = d.records || [];
      renderPreview();
    });
    currentEventSource.addEventListener('done', () => {
      try { currentEventSource.close(); } catch (_) {}
      currentEventSource = null;
      // 結果が result 経由で来なかった場合は GET で取得
      if (currentCandidates.length === 0 && currentRunId) {
        fetch('/api/list-builder/runs/' + encodeURIComponent(currentRunId), { headers })
          .then((r) => r.json())
          .then((data) => {
            if (data.ok) { currentCandidates = data.candidates || []; renderPreview(); }
          });
      }
    });
    currentEventSource.addEventListener('error', () => {
      try { currentEventSource.close(); } catch (_) {}
    });
  }

  // プレビュー表示
  function renderPreview() {
    document.getElementById('progressPanel').classList.add('hidden');
    document.getElementById('previewPanel').classList.remove('hidden');

    let stats = { total: currentCandidates.length, new: 0, dup: 0, review: 0, blocked: 0 };
    currentCandidates.forEach((c) => {
      if (c.collectionStatus === 'blocked') stats.blocked++;
      else if (c.dedupeDecision === 'duplicate' || c.dedupeDecision === 'suppressed') stats.dup++;
      else if (c.dedupeDecision === 'needs_review') stats.review++;
      else stats.new++;
    });
    document.getElementById('statTotal').textContent = stats.total;
    document.getElementById('statNew').textContent = stats.new;
    document.getElementById('statDup').textContent = stats.dup;
    document.getElementById('statReview').textContent = stats.review;
    document.getElementById('statBlocked').textContent = stats.blocked;

    const list = document.getElementById('candidateList');
    if (currentCandidates.length === 0) {
      list.innerHTML = '<div class="empty-state">' + L('取得結果がありません', 'No results') + '</div>';
      return;
    }
    list.innerHTML = currentCandidates.map((c, idx) => {
      const id = c.id || ('cand_' + idx);
      const dec = c.dedupeDecision || 'unique';
      const checked = (dec === 'unique' || dec === 'needs_review') ? 'checked' : '';
      const dis = (dec === 'duplicate' || dec === 'suppressed' || c.collectionStatus === 'blocked') ? 'disabled' : '';
      const pillClass = dec === 'unique' ? 'success' : (dec === 'needs_review' ? 'warn' : 'danger');
      const pillText = dec === 'unique' ? L('新規', 'New')
        : (dec === 'needs_review' ? L('要確認', 'Review')
          : L('重複除外', 'Excluded'));
      const fitScoreText = typeof c.fitScore === 'number' ? (L('適合度 ', 'Fit ') + c.fitScore + '/100') : '';
      const reasons = Array.isArray(c.fitReasons) ? c.fitReasons.slice(0, 3).join(' / ') : '';
      const flags = Array.isArray(c.riskFlags) ? c.riskFlags : [];
      return [
        '<div class="candidate">',
        '<input type="checkbox" data-record-id="', escapeAttr(id), '" ', checked, ' ', dis, '>',
        '<div class="body">',
        '<div class="name">', escapeHtml(c.companyName || c.officialName || L('(名前なし)', '(no name)')), '</div>',
        '<div class="meta">',
        '<span class="pill ', pillClass, '">', pillText, '</span>',
        c.industry ? '<span class="pill">' + escapeHtml(c.industry) + '</span>' : '',
        c.prefecture ? '<span class="pill">' + escapeHtml(c.prefecture) + '</span>' : '',
        c.url ? '<a href="' + escapeHref(c.url) + '" target="_blank" rel="noopener noreferrer">' + L('サイト', 'Site') + '</a> ' : '',
        c.formUrl ? '<a href="' + escapeHref(c.formUrl) + '" target="_blank" rel="noopener noreferrer">' + L('フォーム', 'Form') + '</a> ' : '',
        '</div>',
        fitScoreText ? '<div class="meta">' + escapeHtml(fitScoreText) + (reasons ? ' — ' + escapeHtml(reasons) : '') + '</div>' : '',
        flags.length ? '<div class="meta">' + L('注意: ', 'Warning: ') + flags.map(escapeHtml).join(', ') + '</div>' : '',
        '</div>',
        '</div>',
      ].join('');
    }).join('');
  }

  function escapeAttr(s) {
    const str = String(s == null ? '' : s);
    // 危険スキームを弾く (orchestrator が拾った formUrl などにバッドな値が混入した場合の防御)
    if (/^\s*javascript:/i.test(str) || /^\s*vbscript:/i.test(str) || /^\s*data:/i.test(str)) return '#';
    return str.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function escapeHref(s) {
    const str = String(s == null ? '' : s);
    if (!/^https?:/i.test(str)) return '#';
    return str.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // commit
  document.getElementById('commitBtn').addEventListener('click', async () => {
    if (!currentRunId) return;
    const checked = Array.from(document.querySelectorAll('#candidateList input[type="checkbox"]:checked'));
    const recordIds = checked.map((el) => el.dataset.recordId);
    if (recordIds.length === 0) {
      document.getElementById('commitResult').textContent = L('選択された候補がありません', 'No candidates selected');
      return;
    }
    const r = await fetch('/api/list-builder/commit', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
      body: JSON.stringify({ runId: currentRunId, recordIds }),
    });
    const data = await r.json();
    if (data.ok) {
      const span = document.createElement('span');
      span.style.color = 'var(--success)';
      span.textContent = L(
        data.appended + '件を追加しました。重複: ' + (data.skippedDuplicate || 0) + '件、要確認: ' + (data.flaggedSimilar || 0) + '件',
        'Added ' + data.appended + '. Duplicates: ' + (data.skippedDuplicate || 0) + ', needs review: ' + (data.flaggedSimilar || 0)
      );
      const target = document.getElementById('commitResult');
      target.innerHTML = '';
      target.appendChild(span);
    } else {
      document.getElementById('commitResult').textContent = L('エラー: ', 'Error: ') + (data.error || 'unknown');
    }
  });

  document.getElementById('selectAllBtn').addEventListener('click', () => {
    document.querySelectorAll('#candidateList input[type="checkbox"]:not(:disabled)')
      .forEach((el) => { el.checked = true; });
  });
  document.getElementById('deselectAllBtn').addEventListener('click', () => {
    document.querySelectorAll('#candidateList input[type="checkbox"]')
      .forEach((el) => { el.checked = false; });
  });

  // cancel
  document.getElementById('cancelBtn').addEventListener('click', async () => {
    if (!currentRunId) return;
    const cancelBtn = document.getElementById('cancelBtn');
    cancelBtn.disabled = true;
    document.getElementById('progressStage').textContent = L('キャンセル中…', 'Cancelling…');
    try {
      await fetch('/api/list-builder/runs/' + encodeURIComponent(currentRunId) + '/cancel', {
        method: 'POST', headers,
      });
    } catch (_) {}
    if (currentEventSource) { try { currentEventSource.close(); } catch (_) {} currentEventSource = null; }
    // SSE done が来なくても 1 秒後に UI をリセットする保険
    setTimeout(() => {
      document.getElementById('progressPanel').classList.add('hidden');
      cancelBtn.disabled = false;
    }, 1000);
  });

  // === ボタンハンドラ ===
  // CLI Agent モード — 起動中の Claude/Codex/Gemini に直接依頼
  document.getElementById('cliRunBtn').addEventListener('click', async () => {
    const query = document.getElementById('cliInput').value.trim();
    if (!query) { alert(L('条件を入力してください', 'Please enter criteria')); return; }
    const limit = parseInt(document.getElementById('cliLimit').value, 10) || 30;
    const provider = document.getElementById('cliProvider').value || 'claude';
    document.getElementById('progressPanel').classList.remove('hidden');
    document.getElementById('previewPanel').classList.add('hidden');
    document.getElementById('progressStage').textContent = provider + L(' CLI に依頼を送っています…', ' CLI: sending request…');
    document.getElementById('progressFill').style.width = '15%';
    document.getElementById('progressCounts').textContent = '';
    document.getElementById('loosenedConditions').textContent = '';
    let resp;
    try {
      resp = await fetch('/api/list-builder/cli-run', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
        body: JSON.stringify({ query, limit, provider }),
      });
    } catch (e) {
      document.getElementById('progressStage').textContent = L('エラー: ', 'Error: ') + e.message; return;
    }
    const data = await resp.json();
    if (!data.ok) {
      document.getElementById('progressStage').textContent = L('エラー: ', 'Error: ') + (data.error || 'unknown'); return;
    }
    currentRunId = data.runId;
    subscribeStream(currentRunId);
  });

  document.getElementById('urlRunBtn').addEventListener('click', () => {
    const urls = document.getElementById('urlInput').value
      .split(/[\\n,]/).map((s) => s.trim()).filter((s) => s.length > 0);
    if (urls.length === 0) { alert(L('URLを入力してください', 'Please enter a URL')); return; }
    const maxPages = parseInt(document.getElementById('urlMaxPages').value, 10);
    const maxCompanies = parseInt(document.getElementById('urlMaxCompanies').value, 10);
    startRun('url', { urls, maxPages, maxCompanies });
  });

  document.getElementById('nlqRunBtn').addEventListener('click', () => {
    const query = document.getElementById('nlqInput').value.trim();
    if (!query) { alert(L('クエリを入力してください', 'Please enter a query')); return; }
    const limit = parseInt(document.getElementById('nlqLimit').value, 10);
    startRun('nlq', { query, limit });
  });

  document.getElementById('categoryRunBtn').addEventListener('click', () => {
    const industries = getCheckedValues('industry');
    const prefectures = getCheckedValues('prefecture');
    const employeeRanges = getCheckedValues('employee');
    const revenueRanges = getCheckedValues('revenue');
    const growthTrend = document.getElementById('growthTrend').value;
    const keywords = document.getElementById('keywords').value
      .split(',').map((s) => s.trim()).filter((s) => s.length > 0);
    const limit = parseInt(document.getElementById('categoryLimit').value, 10);
    const unknownFieldPolicy = getRadioValue('unknownPolicy') || 'standard';
    if (industries.length === 0 && prefectures.length === 0 && keywords.length === 0) {
      if (!confirm(L('業種・地域・キーワードが未指定です。続行しますか？', 'No industry, region, or keyword specified. Continue?'))) return;
    }
    startRun('category', {
      industries, prefectures, employeeRanges, revenueRanges,
      growthTrend, keywords, limit, unknownFieldPolicy,
    });
  });

})();
</script>
</body>
</html>`;
}

module.exports = {
  renderListBuilderPage,
};

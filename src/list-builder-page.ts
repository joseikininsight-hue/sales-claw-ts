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

function renderListBuilderPage({ sessionToken }: { sessionToken?: string } = {}) {
  const safeToken = sessionToken || '';

  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>リスト作成 — Sales Claw</title>
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
  <h1>リスト作成</h1>
  <a href="/">← ダッシュボードに戻る</a>
</header>
<main>

<div id="apiKeyWarning" class="lock-banner hidden">
  <strong>注意:</strong> SerpApi キーが未設定のため、自然言語モード・カテゴリモードはロックされています。
  「Settings」タブから API キーを設定してください。
</div>

<div class="tabs">
  <button class="tab active" data-tab="cli">AI に依頼 (CLI)</button>
  <button class="tab" data-tab="url">URL指定</button>
  <button class="tab" data-tab="nlq">自然言語</button>
  <button class="tab" data-tab="category">カテゴリ</button>
</div>

<!-- ===== CLI Agent モード (推奨・追加 API キー不要) ===== -->
<div class="panel" id="tab-cli">
  <div style="background:#0a3a5c;color:#cce4ff;padding:10px 14px;border-radius:8px;margin-bottom:14px;font-size:13px;line-height:1.5;">
    💡 <strong>起動中の Claude / Codex / Gemini CLI</strong> に企業を探してもらいます。
    SerpApi や法人番号 API のキーは不要。CLI が公開情報をもとに JSON で返します。
    実行前に「AI を起動」で CLI を起動しておいてください。
  </div>
  <label>探したい企業の条件（自由文）</label>
  <textarea id="cliInput" placeholder="例) 東京都内のSIer企業で従業員50〜300人、自社プロダクトを持っている会社" style="min-height:80px;"></textarea>
  <div class="row" style="margin-top: 12px;">
    <div class="col">
      <label>取得件数</label>
      <select id="cliLimit">
        <option value="10">10 社</option>
        <option value="30" selected>30 社</option>
        <option value="50">50 社</option>
        <option value="100">100 社</option>
      </select>
    </div>
    <div class="col">
      <label>使用する CLI</label>
      <select id="cliProvider">
        <option value="claude" selected>Claude Code</option>
        <option value="codex">Codex</option>
        <option value="gemini">Gemini</option>
      </select>
    </div>
  </div>
  <div class="row" style="margin-top: 12px;">
    <button class="primary" id="cliRunBtn">AI に依頼して収集開始</button>
    <span style="margin-left:12px;color:var(--text-2);font-size:12px;">
      所要時間目安: 30社で 1〜3 分
    </span>
  </div>
</div>

<!-- ===== URL モード ===== -->
<div class="panel hidden" id="tab-url">
  <label>企業一覧が載っているページのURL（複数行可）</label>
  <textarea id="urlInput" placeholder="https://example.com/ranking-2026
https://example.com/dx-companies"></textarea>
  <div class="row" style="margin-top: 12px;">
    <div class="col">
      <label>最大ページ数</label>
      <input type="number" id="urlMaxPages" value="10" min="1" max="50">
    </div>
    <div class="col">
      <label>最大企業数</label>
      <input type="number" id="urlMaxCompanies" value="100" min="1" max="500">
    </div>
  </div>
  <div class="row" style="margin-top: 12px;">
    <button class="primary" id="urlRunBtn">スキャン開始</button>
  </div>
</div>

<!-- ===== NLQ モード ===== -->
<div class="panel hidden" id="tab-nlq">
  <label>自由文クエリ（例: 都内のSaaS企業で自社プロダクト持ち）</label>
  <textarea id="nlqInput" placeholder="都内のSaaS企業で自社プロダクトを持っている会社"></textarea>
  <div class="row" style="margin-top: 12px;">
    <div class="col">
      <label>取得件数</label>
      <input type="number" id="nlqLimit" value="50" min="1" max="500">
    </div>
  </div>
  <div class="row" style="margin-top: 12px;">
    <button class="primary" id="nlqRunBtn">検索開始</button>
  </div>
</div>

<!-- ===== カテゴリモード ===== -->
<div class="panel hidden" id="tab-category">
  <label>業種（複数選択）</label>
  <div class="checklist" id="industryList">
    ${['SaaS','SIer','製造','小売','金融','ヘルスケア','物流','不動産','建設','広告/マーケ','コンサル','その他']
      .map((i) => `<label><input type="checkbox" value="${escapeHtml(i)}" name="industry"> ${escapeHtml(i)}</label>`).join('')}
  </div>

  <label style="margin-top: 12px;">都道府県（複数選択、空=全国）</label>
  <div class="checklist" id="prefectureList">
    ${['東京都','大阪府','愛知県','神奈川県','福岡県','北海道','京都府','兵庫県','埼玉県','千葉県']
      .map((p) => `<label><input type="checkbox" value="${escapeHtml(p)}" name="prefecture"> ${escapeHtml(p)}</label>`).join('')}
  </div>

  <label style="margin-top: 12px;">従業員数</label>
  <div class="checklist" id="employeeList">
    ${['1-10','11-50','51-100','101-300','301-1000','1001-5000','5001+']
      .map((e) => `<label><input type="checkbox" value="${escapeHtml(e)}" name="employee"> ${escapeHtml(e)}</label>`).join('')}
  </div>

  <label style="margin-top: 12px;">売上規模</label>
  <div class="checklist" id="revenueList">
    ${[['under_100m','1億未満'],['100m-1b','1〜10億'],['1b-10b','10〜100億'],['10b-100b','100〜1000億'],['over_100b','1000億超']]
      .map(([v,l]) => `<label><input type="checkbox" value="${escapeHtml(v)}" name="revenue"> ${escapeHtml(l)}</label>`).join('')}
  </div>

  <label style="margin-top: 12px;">売上推移 ※上場企業のみ厳密判定 / 非上場は判定不能扱い</label>
  <div>
    <select id="growthTrend">
      <option value="any">全て</option>
      <option value="growing">成長中</option>
      <option value="stable">安定</option>
      <option value="declining">減少</option>
    </select>
  </div>

  <label style="margin-top: 12px;">キーワード（カンマ区切り）</label>
  <input type="text" id="keywords" placeholder="自社プロダクト, 受託開発">

  <label style="margin-top: 12px;">取得件数</label>
  <select id="categoryLimit">
    <option value="10">10</option>
    <option value="30">30</option>
    <option value="50" selected>50</option>
    <option value="100">100</option>
    <option value="200">200</option>
    <option value="500">500</option>
  </select>

  <label style="margin-top: 12px;">条件未確認企業の扱い</label>
  <div>
    <label><input type="radio" name="unknownPolicy" value="strict"> 厳格（除外）</label>
    <label><input type="radio" name="unknownPolicy" value="standard" checked> 標準（要確認として残す）</label>
    <label><input type="radio" name="unknownPolicy" value="broad"> 広め（含めるが信頼度低）</label>
  </div>

  <div class="row" style="margin-top: 12px;">
    <button class="primary" id="categoryRunBtn">検索開始</button>
  </div>
</div>

<!-- ===== 進捗 ===== -->
<div class="panel hidden" id="progressPanel">
  <h3 style="margin: 0 0 8px;">進捗</h3>
  <div class="progress-bar"><div id="progressFill" style="width: 0%"></div></div>
  <div class="stage-display">
    <span id="progressStage">準備中…</span>
    <span id="progressCounts" style="margin-left: 12px;"></span>
  </div>
  <div id="loosenedConditions" class="small" style="margin-top: 8px;"></div>
  <div style="margin-top: 8px;">
    <button class="secondary" id="cancelBtn">キャンセル</button>
  </div>
</div>

<!-- ===== プレビュー ===== -->
<div class="panel hidden" id="previewPanel">
  <h3 style="margin: 0 0 8px;">プレビュー</h3>
  <div class="stats">
    <span class="stat"><strong id="statTotal">0</strong>件</span>
    <span class="stat"><strong id="statNew">0</strong>新規</span>
    <span class="stat"><strong id="statDup">0</strong>重複（自動除外）</span>
    <span class="stat"><strong id="statReview">0</strong>要確認</span>
    <span class="stat"><strong id="statBlocked">0</strong>取得失敗</span>
  </div>
  <div id="candidateList"></div>
  <div class="row" style="margin-top: 12px;">
    <button class="primary" id="commitBtn">選択分をリストに追加</button>
    <button class="secondary" id="selectAllBtn">全件選択</button>
    <button class="secondary" id="deselectAllBtn">選択解除</button>
  </div>
  <div id="commitResult" class="small" style="margin-top: 8px;"></div>
</div>

</main>

<script>
(function() {
  'use strict';

  const SESSION_TOKEN = ${safeJsonEmbed(safeToken)};
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
      ['url', 'nlq', 'category'].forEach((m) => {
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
    document.getElementById('progressStage').textContent = 'starting...';
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
      document.getElementById('progressStage').textContent = 'エラー: ' + e.message;
      return;
    }
    const data = await resp.json();
    if (!data.ok) {
      document.getElementById('progressStage').textContent = 'エラー: ' + (data.error || 'unknown');
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
      document.getElementById('progressStage').textContent = 'Stage: ' + d.stage;
      document.getElementById('progressCounts').textContent = (d.completed || 0) + ' / ' + (d.total || 0);
      if (Array.isArray(d.loosenedConditions) && d.loosenedConditions.length > 0) {
        // textContent で挿入することで XSS を防ぐ (description はサーバ生成だが将来の混入を予防)
        document.getElementById('loosenedConditions').textContent = '緩和: ' +
          d.loosenedConditions.map((c) => String(c.description || '') + ' (' + Number(c.matched || 0) + '件)').join(' → ');
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
      list.innerHTML = '<div class="empty-state">取得結果がありません</div>';
      return;
    }
    list.innerHTML = currentCandidates.map((c, idx) => {
      const id = c.id || ('cand_' + idx);
      const dec = c.dedupeDecision || 'unique';
      const checked = (dec === 'unique' || dec === 'needs_review') ? 'checked' : '';
      const dis = (dec === 'duplicate' || dec === 'suppressed' || c.collectionStatus === 'blocked') ? 'disabled' : '';
      const pillClass = dec === 'unique' ? 'success' : (dec === 'needs_review' ? 'warn' : 'danger');
      const pillText = dec === 'unique' ? '新規' : (dec === 'needs_review' ? '要確認' : '重複除外');
      const fitScoreText = typeof c.fitScore === 'number' ? ('適合度 ' + c.fitScore + '/100') : '';
      const reasons = Array.isArray(c.fitReasons) ? c.fitReasons.slice(0, 3).join(' / ') : '';
      const flags = Array.isArray(c.riskFlags) ? c.riskFlags : [];
      return [
        '<div class="candidate">',
        '<input type="checkbox" data-record-id="', escapeAttr(id), '" ', checked, ' ', dis, '>',
        '<div class="body">',
        '<div class="name">', escapeHtml(c.companyName || c.officialName || '(no name)'), '</div>',
        '<div class="meta">',
        '<span class="pill ', pillClass, '">', pillText, '</span>',
        c.industry ? '<span class="pill">' + escapeHtml(c.industry) + '</span>' : '',
        c.prefecture ? '<span class="pill">' + escapeHtml(c.prefecture) + '</span>' : '',
        c.url ? '<a href="' + escapeHref(c.url) + '" target="_blank" rel="noopener noreferrer">サイト</a> ' : '',
        c.formUrl ? '<a href="' + escapeHref(c.formUrl) + '" target="_blank" rel="noopener noreferrer">フォーム</a> ' : '',
        '</div>',
        fitScoreText ? '<div class="meta">' + escapeHtml(fitScoreText) + (reasons ? ' — ' + escapeHtml(reasons) : '') + '</div>' : '',
        flags.length ? '<div class="meta">注意: ' + flags.map(escapeHtml).join(', ') + '</div>' : '',
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
      document.getElementById('commitResult').textContent = '選択された候補がありません';
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
      span.textContent = data.appended + '件を追加しました。重複: ' +
        (data.skippedDuplicate || 0) + '件、要確認: ' + (data.flaggedSimilar || 0) + '件';
      const target = document.getElementById('commitResult');
      target.innerHTML = '';
      target.appendChild(span);
    } else {
      document.getElementById('commitResult').textContent = 'エラー: ' + (data.error || 'unknown');
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
    document.getElementById('progressStage').textContent = 'キャンセル中…';
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
    if (!query) { alert('条件を入力してください'); return; }
    const limit = parseInt(document.getElementById('cliLimit').value, 10) || 30;
    const provider = document.getElementById('cliProvider').value || 'claude';
    document.getElementById('progressPanel').classList.remove('hidden');
    document.getElementById('previewPanel').classList.add('hidden');
    document.getElementById('progressStage').textContent = provider + ' CLI に依頼を送っています…';
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
      document.getElementById('progressStage').textContent = 'エラー: ' + e.message; return;
    }
    const data = await resp.json();
    if (!data.ok) {
      document.getElementById('progressStage').textContent = 'エラー: ' + (data.error || 'unknown'); return;
    }
    currentRunId = data.runId;
    subscribeStream(currentRunId);
  });

  document.getElementById('urlRunBtn').addEventListener('click', () => {
    const urls = document.getElementById('urlInput').value
      .split(/[\\n,]/).map((s) => s.trim()).filter((s) => s.length > 0);
    if (urls.length === 0) { alert('URLを入力してください'); return; }
    const maxPages = parseInt(document.getElementById('urlMaxPages').value, 10);
    const maxCompanies = parseInt(document.getElementById('urlMaxCompanies').value, 10);
    startRun('url', { urls, maxPages, maxCompanies });
  });

  document.getElementById('nlqRunBtn').addEventListener('click', () => {
    const query = document.getElementById('nlqInput').value.trim();
    if (!query) { alert('クエリを入力してください'); return; }
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
      if (!confirm('業種・地域・キーワードが未指定です。続行しますか？')) return;
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

'use strict';

/**
 * CLI Activity タブ内蔵ターミナル + 認証エラー時のアシスト UI。
 *
 * - Claude / Codex / Gemini ボタンクリックで POST /api/launch-ai
 * - 既存 WebSocket (/terminal) に接続し、PTY 出力を xterm.js に流す
 * - 「Please run /login」「API Error: 401」など認証失敗パターンを検出して
 *   親切な案内バナーを自動表示し、「/login を実行」ボタンで自動入力する
 * - dashboard-server.cjs の buildPage() が <script> 内で展開する
 */

const STYLE = [
  '.cli-term-card{background:var(--bg-card);border:1px solid var(--border-subtle);border-radius:var(--radius-lg)!important;box-shadow:var(--shadow-ambient);margin-bottom:12px;overflow:hidden;color:var(--text-1)}',
  '.cli-term-head{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;padding:10px 14px;border-bottom:1px solid var(--border-subtle);background:linear-gradient(135deg,rgba(37,99,235,.05) 0%,transparent 60%)}',
  '.cli-term-title{display:flex;align-items:center;gap:8px;font-size:.78rem;font-weight:700;color:var(--text-1);letter-spacing:.02em}',
  '.cli-term-badge{display:inline-flex;align-items:center;padding:2px 8px;border-radius:var(--radius-pill)!important;background:var(--primary-glow);color:var(--primary);font-size:.62rem;font-weight:700;letter-spacing:.04em;text-transform:uppercase}',
  '.cli-term-status-dot{width:8px;height:8px;border-radius:50%;display:inline-block;background:var(--text-3)}',
  '.cli-term-status-dot.on{background:var(--success);box-shadow:0 0 0 0 rgba(5,150,105,.5);animation:cliPulse 2s infinite}',
  '.cli-term-status-dot.err{background:var(--error)}',
  '@keyframes cliPulse{0%{box-shadow:0 0 0 0 rgba(5,150,105,.5)}70%{box-shadow:0 0 0 6px rgba(5,150,105,0)}100%{box-shadow:0 0 0 0 rgba(5,150,105,0)}}',
  '.cli-term-launchers{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
  '.cli-term-launch{display:inline-flex;align-items:center;gap:6px;padding:6px 12px;font-size:.74rem;font-weight:700;border:1px solid var(--border-default);border-radius:var(--radius-md)!important;background:var(--bg-card);color:var(--text-1);cursor:pointer;transition:all .15s var(--ease-out-expo)}',
  '.cli-term-launch:hover{background:var(--bg-raised);border-color:var(--border-strong);transform:translateY(-1px);box-shadow:var(--shadow-xs)}',
  '.cli-term-launch.claude:hover{border-color:#CC785C;background:#fff7f3}',
  '.cli-term-launch.codex:hover{border-color:#10a37f;background:#f0fdf8}',
  '.cli-term-launch.gemini:hover{border-color:#4285F4;background:#f0f4ff}',
  '.cli-term-launch[disabled]{opacity:.5;cursor:not-allowed!important;pointer-events:none}',
  '.cli-term-launch.active{background:var(--primary);color:#fff;border-color:var(--primary);box-shadow:var(--shadow-cta)}',
  '.cli-term-launch-icon{width:16px;height:16px;flex-shrink:0}',
  '.cli-term-stop{display:inline-flex;align-items:center;gap:5px;padding:6px 12px;font-size:.74rem;font-weight:700;border:1px solid rgba(220,38,38,.4);border-radius:var(--radius-md)!important;background:var(--bg-card);color:var(--error);cursor:pointer;transition:all .15s var(--ease-out-expo)}',
  '.cli-term-stop:hover:not([disabled]){background:var(--error-dim);border-color:var(--error)}',
  '.cli-term-stop[disabled]{opacity:.4;cursor:not-allowed!important}',
  '.cli-term-empty{padding:36px 24px;text-align:center;background:var(--bg-surface)}',
  '.cli-term-empty-illust{display:flex;justify-content:center;margin-bottom:8px}',
  '.cli-term-empty-title{font-size:.86rem;font-weight:700;margin:0 0 6px;color:var(--text-1)}',
  '.cli-term-empty-sub{font-size:.74rem;color:var(--text-2);margin:0 0 4px;line-height:1.6}',
  '.cli-term-empty-hint{font-size:.68rem;color:var(--text-3);margin:0;font-style:italic}',
  '.cli-term-host{height:460px;min-height:200px;max-height:80vh;background:#0b0e14;padding:8px;position:relative;cursor:text}',
  '.cli-term-host .xterm{height:100%;padding:0 4px}',
  '.cli-term-host .xterm-viewport{background-color:transparent!important}',
  '.cli-term-host .xterm-helper-textarea{z-index:5!important}',
  '.cli-term-host .xterm-screen{cursor:text}',
  '.cli-term-host:focus-within{outline:1px solid var(--primary);outline-offset:-1px}',
  /* drag handle to resize the terminal vertically */
  '.cli-term-resize{position:absolute;left:0;right:0;bottom:-1px;height:8px;cursor:ns-resize;z-index:20;display:flex;align-items:center;justify-content:center;transition:background .12s}',
  '.cli-term-resize::before{content:"";width:48px;height:3px;border-radius:2px;background:rgba(255,255,255,.18);transition:background .12s}',
  '.cli-term-resize:hover::before,.cli-term-resize.dragging::before{background:var(--primary)}',
  '.cli-term-resize:hover,.cli-term-resize.dragging{background:rgba(37,99,235,.08)}',
  'body.cli-term-resizing{cursor:ns-resize!important;user-select:none!important}',
  '.cli-term-auth-help{display:flex;gap:14px;padding:14px 18px;background:linear-gradient(135deg,rgba(217,119,6,.08) 0%,rgba(217,119,6,.02) 70%);border-bottom:1px solid rgba(217,119,6,.25);animation:cliFade .18s ease}',
  '@keyframes cliFade{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:translateY(0)}}',
  '.cli-term-auth-help-icon{width:36px;height:36px;border-radius:10px;background:var(--warning-dim);color:var(--warning);display:flex;align-items:center;justify-content:center;flex-shrink:0}',
  '.cli-term-auth-help-body{flex:1;min-width:0}',
  '.cli-term-auth-help-body h4{margin:0 0 4px;font-size:.86rem;font-weight:800;color:var(--warning)}',
  '.cli-term-auth-help-body p{margin:0 0 8px;font-size:.74rem;color:var(--text-2);line-height:1.6}',
  '.cli-term-auth-help-steps{margin:6px 0 10px;padding-left:22px;font-size:.72rem;color:var(--text-1);line-height:1.7}',
  '.cli-term-auth-help-steps li{margin-bottom:2px}',
  '.cli-term-auth-help-steps code{font-family:var(--font-mono);background:var(--bg-raised);padding:1px 6px;border-radius:4px;font-size:.7rem;color:var(--primary)}',
  '.cli-term-auth-help-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
  '.cli-term-auth-help-btn{display:inline-flex;align-items:center;gap:5px;padding:5px 12px;font-size:.74rem;font-weight:700;border:1px solid var(--border-default);border-radius:var(--radius-md)!important;background:var(--bg-card);color:var(--text-1);cursor:pointer;text-decoration:none;transition:all .15s var(--ease-out-expo)}',
  '.cli-term-auth-help-btn:hover{background:var(--bg-raised);border-color:var(--border-strong)}',
  '.cli-term-auth-help-btn.primary{background:var(--primary);color:#fff;border-color:var(--primary);box-shadow:var(--shadow-cta)}',
  '.cli-term-auth-help-btn.primary:hover{background:var(--primary-dim);border-color:var(--primary-dim)}',
  '.cli-term-auth-help-btn.link{color:var(--primary);text-decoration:none}',
  '.cli-term-auth-help-btn.link:hover{background:var(--primary-glow)}'
].join('\n');

const SCRIPT = `(function(){
  if (window.__cliTerminalInit) return;
  window.__cliTerminalInit = true;

  var STYLE_ID = 'cli-terminal-style';
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = ${JSON.stringify(STYLE)};
    document.head.appendChild(s);
  }
  ensureStyle();

  // ---- DOM refs (available after DOMContentLoaded) ----
  var refs = {};
  function bindRefs() {
    refs.card     = document.getElementById('cliTerminalCard');
    refs.empty    = document.getElementById('cliTermEmpty');
    refs.host     = document.getElementById('cliTermHost');
    refs.badge    = document.getElementById('cliTermProviderBadge');
    refs.statusDot= document.getElementById('cliTermStatusDot');
    refs.stop     = refs.card && refs.card.querySelector('[data-cli-stop]');
    refs.help     = document.getElementById('cliTermAuthHelp');
    refs.helpTitle= document.getElementById('cliTermAuthHelpTitle');
    refs.helpDesc = document.getElementById('cliTermAuthHelpDesc');
    refs.launchers= refs.card ? refs.card.querySelectorAll('[data-cli-launch]') : [];
  }

  // ---- xterm runtime ----
  var term = null;
  var fitAddon = null;
  var ws = null;
  var currentProvider = null;
  var helpDismissed = false;
  var streamBuffer = '';
  var launchInFlight = false;
  var launchAbortController = null;
  var launchAbortReason = null;
  var launchTimeoutTimer = null;
  // server 側 MANAGED_AI_LAUNCH_LOCK_STALE_MS (130s) と揃える。
  // server LAUNCH_TIMEOUT_MS (120s) より長くして、サーバが先に timeout を
  // 検出して 200 + 構造化エラーを返すのを許す (client がタイムアウトすると
  // overlay が「ローディング中」のまま固まる)。
  var LAUNCH_REQUEST_TIMEOUT_MS = 130000;

  var PROVIDER_LABELS = {
    claude: 'Claude',
    codex:  'Codex',
    gemini: 'Gemini'
  };

  function ensureTerm() {
    if (term) return term;
    if (!refs.host) return null;
    if (typeof window.Terminal !== 'function') {
      // xterm.js not loaded yet — defer a tick
      return null;
    }
    // v2.0.52: VS Code 同等品質の Terminal 設定。
    //   - fontFamily: VS Code 既定 ("Cascadia Code" → "Menlo" → fallback)。
    //   - fontSize 13.5 / lineHeight 1.15: ASCII と日本語の高さ揃え、表示崩れ抑制。
    //   - allowProposedApi: unicode11 / web-links が proposed API を使うため必須。
    //   - cursorStyle 'bar' + cursorWidth 2: VS Code 同等の細いカーソル。
    //   - drawBoldTextInBrightColors: false: 太字を「色」で表現しない → 表示崩れ防止。
    //   - scrollOnUserInput: ユーザー入力で下までスクロール (Claude の paste banner 時に上に戻る問題対策)
    //   - rightClickSelectsWord: VS Code 同等の選択挙動。
    //   - macOptionIsMeta: false (Win/Linux 中心なので影響なし)。
    //   - windowsMode (Windows): ConPTY との改行整合。windows-pty wrap 不要だが文字幅計算で安定。
    term = new window.Terminal({
      cursorBlink: true,
      cursorStyle: 'bar',
      cursorWidth: 2,
      fontFamily: '"Cascadia Code","JetBrains Mono","Fira Code","Menlo","Consolas",ui-monospace,monospace',
      fontSize: 13.5,
      lineHeight: 1.15,
      letterSpacing: 0,
      scrollback: 10000,
      convertEol: true,
      allowProposedApi: true,
      drawBoldTextInBrightColors: false,
      rightClickSelectsWord: true,
      scrollOnUserInput: true,
      windowsMode: (navigator.platform || '').toLowerCase().indexOf('win') === 0,
      theme: {
        background: '#0b0e14',
        foreground: '#e6edf3',
        cursor: '#58a6ff',
        cursorAccent: '#0b0e14',
        selectionBackground: 'rgba(88,166,255,.35)',
        black:'#0b0e14',red:'#ff7b72',green:'#7ee787',yellow:'#f2cc60',
        blue:'#79c0ff',magenta:'#d2a8ff',cyan:'#a5d6ff',white:'#c9d1d9',
        brightBlack:'#6e7681',brightRed:'#ffa198',brightGreen:'#56d364',
        brightYellow:'#e3b341',brightBlue:'#79c0ff',brightMagenta:'#d2a8ff',
        brightCyan:'#a5d6ff',brightWhite:'#f0f6fc'
      }
    });

    if (window.FitAddon && window.FitAddon.FitAddon) {
      try {
        fitAddon = new window.FitAddon.FitAddon();
        term.loadAddon(fitAddon);
      } catch (_) {}
    }

    // v2.0.52: web-links addon を追加。URL に hover で下線、Ctrl+Click で外部ブラウザ起動。
    if (window.WebLinksAddon && window.WebLinksAddon.WebLinksAddon) {
      try {
        var webLinks = new window.WebLinksAddon.WebLinksAddon(function(event, uri) {
          // Sales Claw は Electron なので window.open は外部ブラウザに引き渡される
          try { window.open(uri, '_blank', 'noopener,noreferrer'); } catch (_) {}
        });
        term.loadAddon(webLinks);
      } catch (e) { console.warn('[cli-terminal] WebLinksAddon load failed:', e && e.message || e); }
    }

    // v2.0.52: search addon (Ctrl+F でターミナル内検索)
    var searchAddon = null;
    if (window.SearchAddon && window.SearchAddon.SearchAddon) {
      try {
        searchAddon = new window.SearchAddon.SearchAddon();
        term.loadAddon(searchAddon);
      } catch (e) { console.warn('[cli-terminal] SearchAddon load failed:', e && e.message || e); }
    }

    // v2.0.52: unicode11 addon (絵文字・全角文字幅を正しく計算 → 表示崩れ防止)
    if (window.Unicode11Addon && window.Unicode11Addon.Unicode11Addon) {
      try {
        term.loadAddon(new window.Unicode11Addon.Unicode11Addon());
        if (term.unicode && typeof term.unicode === 'object') {
          term.unicode.activeVersion = '11';
        }
      } catch (e) { console.warn('[cli-terminal] Unicode11Addon load failed:', e && e.message || e); }
    }

    term.open(refs.host);

    // v2.0.52: コピペ品質改善。
    //   - 選択直後に Ctrl+C で clipboard コピー、空選択時は SIGINT を PTY へ送る。
    //   - Ctrl+V / Ctrl+Shift+V で clipboard 貼り付け (xterm の bracketed paste で安全)。
    //   - 右クリックで「コピーがあればコピー、無ければ貼り付け」(VS Code/Windows Terminal 互換)
    term.attachCustomKeyEventHandler(function(ev) {
      // Ctrl+C
      if (ev.type === 'keydown' && (ev.ctrlKey || ev.metaKey) && (ev.key === 'c' || ev.key === 'C')) {
        var sel = term.getSelection();
        if (sel && sel.length > 0) {
          try { navigator.clipboard.writeText(sel); } catch (_) {}
          term.clearSelection();
          return false; // PTY に Ctrl+C は送らない
        }
        return true; // 空選択なら通常通り SIGINT 送信
      }
      // Ctrl+V / Ctrl+Shift+V → paste
      if (ev.type === 'keydown' && (ev.ctrlKey || ev.metaKey) && (ev.key === 'v' || ev.key === 'V')) {
        try {
          navigator.clipboard.readText().then(function(text) {
            if (text && ws && ws.readyState === 1) {
              ws.send(JSON.stringify({ type: 'input', data: text }));
            }
          });
        } catch (_) {}
        return false;
      }
      // Ctrl+F → 検索 (将来用、現状は browser native の find はターミナルに効かないので何もしない)
      if (ev.type === 'keydown' && (ev.ctrlKey || ev.metaKey) && (ev.key === 'f' || ev.key === 'F')) {
        if (searchAddon && typeof searchAddon.findNext === 'function') {
          var q = window.prompt('ターミナル内検索:');
          if (q) {
            try { searchAddon.findNext(q, { caseSensitive: false, regex: false, wholeWord: false }); } catch (_) {}
          }
          return false;
        }
      }
      return true;
    });
    // 右クリック: 選択ありならコピー、無ければ paste
    refs.host.addEventListener('contextmenu', function(ev) {
      ev.preventDefault();
      var sel = term.getSelection();
      if (sel && sel.length > 0) {
        try { navigator.clipboard.writeText(sel); } catch (_) {}
        term.clearSelection();
      } else {
        try {
          navigator.clipboard.readText().then(function(text) {
            if (text && ws && ws.readyState === 1) {
              ws.send(JSON.stringify({ type: 'input', data: text }));
            }
          });
        } catch (_) {}
      }
    });

    // Restore saved height
    try {
      var savedH = parseInt(localStorage.getItem('cli-term:height') || '', 10);
      if (Number.isFinite(savedH) && savedH >= 200 && savedH <= window.innerHeight * 0.85) {
        refs.host.style.height = savedH + 'px';
      }
    } catch(_){}

    // Insert drag-resize handle (south edge)
    if (!refs.host.querySelector('.cli-term-resize')) {
      var grip = document.createElement('div');
      grip.className = 'cli-term-resize';
      grip.title = 'ドラッグで高さを変更';
      refs.host.appendChild(grip);
      grip.addEventListener('mousedown', function(ev){
        if (ev.button !== 0) return;
        ev.preventDefault();
        ev.stopPropagation();
        var startY = ev.clientY;
        var startH = refs.host.getBoundingClientRect().height;
        grip.classList.add('dragging');
        document.body.classList.add('cli-term-resizing');
        function onMove(e){
          var dy = e.clientY - startY;
          var next = Math.max(200, Math.min(window.innerHeight * 0.85, startH + dy));
          refs.host.style.height = next + 'px';
          try { fitAddon && fitAddon.fit(); } catch(_){}
        }
        function onUp(){
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          grip.classList.remove('dragging');
          document.body.classList.remove('cli-term-resizing');
          try {
            var h = Math.round(refs.host.getBoundingClientRect().height);
            localStorage.setItem('cli-term:height', String(h));
          } catch(_){}
          try { fitAddon && fitAddon.fit(); } catch(_){}
          if (ws && ws.readyState === 1) {
            try { ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows })); } catch(_){}
          }
        }
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
    }

    // Re-fit several times to handle delayed layout (vendor fonts, panel toggle, etc.)
    [40, 120, 360, 800].forEach(function(ms){
      setTimeout(function(){
        try {
          fitAddon && fitAddon.fit();
          if (ws && ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
          }
        } catch(_){}
      }, ms);
    });

    // Click-anywhere to focus the terminal — fixes "can't type" for new users
    refs.host.addEventListener('mousedown', function(){
      setTimeout(function(){ try { term.focus(); } catch(_){} }, 0);
    });
    // Window-level resize re-fit
    window.addEventListener('resize', function(){
      try { fitAddon && fitAddon.fit(); } catch(_){}
    });

    term.onData(function(data) {
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'input', data: data }));
      }
    });
    term.onResize(function(size) {
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'resize', cols: size.cols, rows: size.rows }));
      }
    });

    // v2.0.52: リサイズ debounce。コンテナのサイズ変動が連続で来た時に
    //   fit() を毎回呼ぶと描画が乱れる (1 フレーム内に複数 fit が走るとカーソル
    //   位置がズレることがある)。次フレームに 1 回だけ fit する。
    var roPending = null;
    var ro = new ResizeObserver(function(){
      if (roPending) return;
      roPending = requestAnimationFrame(function() {
        roPending = null;
        try {
          if (fitAddon) {
            fitAddon.fit();
            if (ws && ws.readyState === 1) {
              ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
            }
          }
        } catch(_){}
      });
    });
    ro.observe(refs.host);

    return term;
  }

  function setStatus(state, label) {
    if (!refs.statusDot) return;
    refs.statusDot.classList.remove('on','off','err');
    refs.statusDot.classList.add(state || 'off');
    refs.statusDot.title = label || '';
  }

  function showProviderBadge(provider) {
    if (!refs.badge) return;
    if (!provider) { refs.badge.style.display = 'none'; return; }
    refs.badge.textContent = PROVIDER_LABELS[provider] || provider;
    refs.badge.style.display = 'inline-flex';
  }

  function setLauncherActive(provider) {
    if (!refs.launchers) return;
    refs.launchers.forEach(function(b){
      b.classList.toggle('active', b.getAttribute('data-cli-launch') === provider);
    });
    if (refs.stop) refs.stop.disabled = !provider;
  }

  // ---- Setup-needs detection (AI CLI / Playwright / Chromium not ready) ----
  // Pattern matches the server's "未準備" / "未インストール" error responses.
  var SETUP_PATTERNS = [
    new RegExp('AI CLI を準備', ''),
    new RegExp('未準備です', ''),
    new RegExp('未インストールです', ''),
    new RegExp('Playwright MCP / Chromium', ''),
    new RegExp('install Chromium first', 'i'),
    new RegExp('Cannot find module', 'i')
  ];
  var setupBannerShown = false;
  var setupInstallInProgress = false;
  function ensureSetupBanner() {
    if (document.getElementById('cliTermSetupHelp')) return;
    if (!refs.card) return;
    var html = '<div id="cliTermSetupHelp" class="cli-term-setup-help" style="display:none">'
      + '<div class="cli-term-setup-icon"><span class="material-symbols-outlined">construction</span></div>'
      + '<div class="cli-term-setup-body">'
      +   '<h4 id="cliTermSetupTitle">AI CLI / Playwright の準備が必要です</h4>'
      +   '<p id="cliTermSetupDesc">Sales Claw のフォーム入力には Playwright MCP と Chromium が必要です。下のボタンで自動インストールします (~2 分)。</p>'
      +   '<div class="cli-term-setup-stages" id="cliTermSetupStages" style="display:none">'
      +     '<div class="cli-term-setup-stage" data-stage="probe"><span class="cli-term-setup-stage-icon">⏳</span><span class="cli-term-setup-stage-label">準備状態の確認</span></div>'
      +     '<div class="cli-term-setup-stage" data-stage="cli_install"><span class="cli-term-setup-stage-icon">⏳</span><span class="cli-term-setup-stage-label">AI CLI のインストール</span></div>'
      +     '<div class="cli-term-setup-stage" data-stage="browser_install"><span class="cli-term-setup-stage-icon">⏳</span><span class="cli-term-setup-stage-label">Chromium のダウンロード</span></div>'
      +     '<div class="cli-term-setup-stage" data-stage="verify"><span class="cli-term-setup-stage-icon">⏳</span><span class="cli-term-setup-stage-label">動作確認</span></div>'
      +   '</div>'
      +   '<div class="cli-term-setup-progress" id="cliTermSetupProgress" style="display:none"><div class="cli-term-setup-progress-bar" id="cliTermSetupProgressBar"></div></div>'
      +   '<div class="cli-term-setup-actions">'
      +     '<button type="button" class="cli-term-setup-btn primary" data-cli-action="install-cli"><span class="material-symbols-outlined">download</span><span data-setup-btn-label>AI CLI を準備</span></button>'
      +     '<button type="button" class="cli-term-setup-btn" data-cli-action="dismiss-setup">後で</button>'
      +   '</div>'
      +   '<div class="cli-term-setup-status" id="cliTermSetupStatus" style="display:none"></div>'
      + '</div>'
      + '</div>';
    var holder = document.createElement('div');
    holder.innerHTML = html;
    var head = refs.card.querySelector('.cli-term-head');
    if (head && head.nextSibling) refs.card.insertBefore(holder.firstChild, head.nextSibling);
    else refs.card.appendChild(holder.firstChild);

    // CSS for setup banner (info-blue, like auth-help but distinct)
    if (!document.getElementById('cli-term-setup-style')) {
      var s = document.createElement('style');
      s.id = 'cli-term-setup-style';
      s.textContent = [
        '.cli-term-setup-help{display:flex;gap:14px;padding:14px 18px;background:linear-gradient(135deg,rgba(37,99,235,.08) 0%,rgba(37,99,235,.02) 70%);border-bottom:1px solid rgba(37,99,235,.25);animation:cliFade .18s ease}',
        '.cli-term-setup-icon{width:36px;height:36px;border-radius:10px;background:var(--primary-glow);color:var(--primary);display:flex;align-items:center;justify-content:center;flex-shrink:0}',
        '.cli-term-setup-body{flex:1;min-width:0}',
        '.cli-term-setup-body h4{margin:0 0 4px;font-size:.86rem;font-weight:800;color:var(--primary)}',
        '.cli-term-setup-body p{margin:0 0 10px;font-size:.74rem;color:var(--text-2);line-height:1.6}',
        '.cli-term-setup-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
        '.cli-term-setup-btn{display:inline-flex;align-items:center;gap:5px;padding:6px 14px;font-size:.74rem;font-weight:700;border:1px solid var(--border-default);border-radius:var(--radius-md)!important;background:var(--bg-card);color:var(--text-1);cursor:pointer;transition:all .15s var(--ease-out-expo)}',
        '.cli-term-setup-btn:hover{background:var(--bg-raised);border-color:var(--border-strong)}',
        '.cli-term-setup-btn.primary{background:var(--primary);color:#fff;border-color:var(--primary);box-shadow:var(--shadow-cta)}',
        '.cli-term-setup-btn.primary:hover{background:var(--primary-dim);border-color:var(--primary-dim)}',
        '.cli-term-setup-btn[disabled]{opacity:.5;cursor:not-allowed!important}',
        '.cli-term-setup-status{margin-top:10px;padding:8px 10px;font-size:.7rem;background:var(--bg-surface);border-radius:var(--radius-sm);color:var(--text-2);font-family:var(--font-mono);white-space:pre-wrap}',
        '.cli-term-setup-stages{margin:10px 0;display:flex;flex-direction:column;gap:5px}',
        '.cli-term-setup-stage{display:flex;align-items:center;gap:8px;font-size:.74rem;color:var(--text-2);padding:4px 8px;border-radius:var(--radius-sm);transition:all .2s}',
        '.cli-term-setup-stage.active{background:rgba(37,99,235,.08);color:var(--primary);font-weight:600}',
        '.cli-term-setup-stage.done{color:var(--success,#10b981)}',
        '.cli-term-setup-stage.error{color:var(--error,#ef4444)}',
        '.cli-term-setup-stage-icon{display:inline-flex;width:18px;text-align:center;font-size:.85rem}',
        '.cli-term-setup-progress{margin:6px 0 10px;height:6px;background:var(--bg-surface);border-radius:3px;overflow:hidden}',
        '.cli-term-setup-progress-bar{height:100%;background:linear-gradient(90deg,var(--primary),var(--primary-dim));width:0;transition:width .25s}'
      ].join('\\n');
      document.head.appendChild(s);
    }
  }
  function showSetupBanner(title, desc) {
    if (setupBannerShown) return;
    ensureSetupBanner();
    var box = document.getElementById('cliTermSetupHelp');
    if (!box) return;
    if (title) { var t = document.getElementById('cliTermSetupTitle'); if (t) t.textContent = title; }
    if (desc) { var d = document.getElementById('cliTermSetupDesc'); if (d) d.textContent = desc; }
    box.style.display = 'flex';
    setupBannerShown = true;
  }
  function hideSetupBanner() {
    var box = document.getElementById('cliTermSetupHelp');
    if (box) box.style.display = 'none';
    setupBannerShown = false;
  }
  function setSetupStatus(text, isError) {
    var s = document.getElementById('cliTermSetupStatus');
    if (!s) return;
    s.style.display = text ? 'block' : 'none';
    s.textContent = text || '';
    s.style.color = isError ? 'var(--error)' : 'var(--text-2)';
  }
  function detectSetupNeeded(chunk) {
    if (typeof chunk !== 'string' || !chunk) return;
    if (setupBannerShown) return;
    for (var i = 0; i < SETUP_PATTERNS.length; i++) {
      if (SETUP_PATTERNS[i].test(chunk)) {
        showSetupBanner();
        return;
      }
    }
  }
  function setStageState(stage, state, message) {
    var el = document.querySelector('[data-stage="' + stage + '"]');
    if (!el) return;
    el.classList.remove('active', 'done', 'error');
    if (state) el.classList.add(state);
    var icon = el.querySelector('.cli-term-setup-stage-icon');
    if (icon) {
      if (state === 'done') icon.textContent = '✅';
      else if (state === 'error') icon.textContent = '⚠️';
      else if (state === 'active') icon.textContent = '🔄';
      else icon.textContent = '⏳';
    }
    if (message) {
      var label = el.querySelector('.cli-term-setup-stage-label');
      if (label) label.textContent = message;
    }
  }
  function setProgressBar(percent) {
    var bar = document.getElementById('cliTermSetupProgressBar');
    if (bar) bar.style.width = Math.max(0, Math.min(100, Number(percent) || 0)) + '%';
  }
  function showStages() {
    var s = document.getElementById('cliTermSetupStages');
    var p = document.getElementById('cliTermSetupProgress');
    if (s) s.style.display = 'flex';
    if (p) p.style.display = 'block';
  }
  function resetStages() {
    ['probe', 'cli_install', 'browser_install', 'verify'].forEach(function(s) {
      setStageState(s, '', null);
    });
    setProgressBar(0);
  }
  var STAGE_LABEL = {
    probe: '準備状態の確認',
    cli_install: 'AI CLI のインストール',
    browser_install: 'Chromium のダウンロード',
    verify: '動作確認',
  };
  var STAGE_WEIGHT = { probe: 5, cli_install: 45, browser_install: 45, verify: 5 };
  function overallProgress(stage, stageProgress) {
    var stages = ['probe', 'cli_install', 'browser_install', 'verify'];
    var total = 0;
    for (var i = 0; i < stages.length; i++) {
      var s = stages[i];
      if (s === stage) { total += (STAGE_WEIGHT[s] * (stageProgress || 0) / 100); break; }
      total += STAGE_WEIGHT[s];
    }
    return total;
  }

  async function runInstallCli() {
    if (setupInstallInProgress) return;
    setupInstallInProgress = true;
    var btn = document.querySelector('[data-cli-action="install-cli"]');
    var label = btn && btn.querySelector('[data-setup-btn-label]');
    if (btn) btn.setAttribute('disabled', 'true');
    if (label) label.textContent = 'インストール中...';
    showStages();
    resetStages();
    setSetupStatus('Sales Claw の内蔵 npm で Playwright + Chromium を準備しています...', false);

    // SSE 進捗ストリームを試す
    var provider = currentProvider || 'claude';
    var es;
    var resolved = false;
    function finalizeOk(detail) {
      if (resolved) return;
      resolved = true;
      try { if (es) es.close(); } catch (_) {}
      ['probe','cli_install','browser_install','verify'].forEach(function(s) { setStageState(s, 'done', null); });
      setProgressBar(100);
      var msg = (detail && detail.reused) ? '既に準備済みでした (再インストール不要)' : '準備完了しました。AI CLI を起動できます。';
      setSetupStatus(msg, false);
      if (label) label.textContent = '完了';
      setTimeout(hideSetupBanner, 2500);
      setupInstallInProgress = false;
    }
    function finalizeError(err, hint) {
      if (resolved) return;
      resolved = true;
      try { if (es) es.close(); } catch (_) {}
      var full = err + (hint ? '\\n' + hint : '');
      setSetupStatus('インストール失敗: ' + full, true);
      if (label) label.textContent = '再試行';
      if (btn) btn.removeAttribute('disabled');
      setupInstallInProgress = false;
    }
    try {
      // EventSource は SSE 専用。Cookie/session は same-origin で自動付与。
      es = new EventSource('/api/install-ai-cli/stream?provider=' + encodeURIComponent(provider));

      es.addEventListener('progress', function(ev) {
        try {
          var data = JSON.parse(ev.data);
          var stage = data.stage;
          var prog = Number(data.progress) || 0;
          var msg = data.message || STAGE_LABEL[stage] || stage;
          if (stage === 'error') {
            finalizeError(msg, '');
            return;
          }
          // mark previous stages done
          var stages = ['probe','cli_install','browser_install','verify'];
          var idx = stages.indexOf(stage);
          for (var i = 0; i < idx; i++) setStageState(stages[i], 'done', null);
          // current stage
          setStageState(stage, prog >= 100 ? 'done' : 'active', msg);
          setProgressBar(overallProgress(stage, prog));
          setSetupStatus(msg, false);
        } catch (_) {}
      });
      es.addEventListener('done', function(ev) {
        try {
          var data = JSON.parse(ev.data);
          if (data.ok) finalizeOk(data);
          else finalizeError(data.error || 'インストールに失敗しました', data.hint || '');
        } catch (e) {
          finalizeError(String(e && e.message || e));
        }
      });
      es.onerror = function() {
        // SSE が使えない / ネットワーク切断
        if (!resolved) {
          finalizeError('進捗ストリームが切断されました。少し待ってから再試行してください。');
        }
      };
    } catch (e) {
      // EventSource 不可 → 同期 POST へフォールバック
      try {
        var res = await window.fetch('/api/install-ai-cli', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider: provider })
        });
        var json = await res.json().catch(function(){ return null; });
        if (!res.ok || (json && json.ok === false)) {
          finalizeError((json && (json.error || json.message)) || ('HTTP ' + res.status));
        } else {
          finalizeOk(json);
        }
      } catch (e2) {
        finalizeError(String(e2 && e2.message || e2));
      }
    }
  }

  // ---- Auth-error detection ----
  // Pattern matches Claude Code and similar CLIs
  var AUTH_PATTERNS = [
    { re: new RegExp('Please run \\\\/login', 'i'),         title: 'Claude のログインが必要です',          desc: 'Claude Code がログイン期限切れを検出しました。下のボタンで自動入力できます。' },
    { re: new RegExp('API Error:\\\\s*401', 'i'),           title: 'API 認証エラー (401)',                 desc: 'API キー / OAuth トークンが無効か期限切れです。再ログインしてください。' },
    { re: new RegExp('authentication_error', 'i'),          title: '認証エラー',                            desc: 'CLI の認証に失敗しました。再ログインで解消します。' },
    { re: new RegExp('Invalid (?:API key|credentials?)', 'i'),title: '認証情報が無効です',                  desc: '保存されている認証情報が無効です。再ログインしてください。' },
    { re: new RegExp('token (?:has )?expired', 'i'),        title: 'トークン期限切れ',                      desc: 'OAuth トークンが期限切れです。再ログインで延長されます。' }
  ];
  // Patterns that indicate successful login → clear buffer + dismiss banner.
  var AUTH_SUCCESS_PATTERNS = [
    new RegExp('Login successful', 'i'),
    new RegExp('Logged in (?:as|to)', 'i'),
    new RegExp('Authenticated successfully', 'i'),
    new RegExp('已成功登录', 'i')
  ];

  function detectAuthError(chunk) {
    if (typeof chunk !== 'string' || !chunk) return;
    // 1) success first — wipe stale error text from buffer & hide banner
    for (var s = 0; s < AUTH_SUCCESS_PATTERNS.length; s++) {
      if (AUTH_SUCCESS_PATTERNS[s].test(chunk)) {
        streamBuffer = '';
        helpDismissed = true;
        hideAuthHelp();
        return;
      }
    }
    if (helpDismissed) return;
    // 2) error: only check the new chunk to avoid re-firing on stale buffer text
    for (var i = 0; i < AUTH_PATTERNS.length; i++) {
      var p = AUTH_PATTERNS[i];
      if (p.re.test(chunk)) {
        showAuthHelp(p.title, p.desc);
        return;
      }
    }
    // 3) fallback for multi-line patterns split across chunks: keep small tail buffer
    streamBuffer = (streamBuffer + chunk).slice(-2000);
    for (var j = 0; j < AUTH_PATTERNS.length; j++) {
      if (AUTH_PATTERNS[j].re.test(streamBuffer)) {
        // only show if pattern straddles the join boundary (not already in chunk alone)
        if (!AUTH_PATTERNS[j].re.test(chunk)) {
          showAuthHelp(AUTH_PATTERNS[j].title, AUTH_PATTERNS[j].desc);
        }
        return;
      }
    }
  }

  function showAuthHelp(title, desc) {
    if (!refs.help) return;
    if (refs.help.style.display !== 'none') return;
    if (refs.helpTitle && title) refs.helpTitle.textContent = title;
    if (refs.helpDesc && desc) refs.helpDesc.textContent = desc;
    refs.help.style.display = 'flex';
  }
  function hideAuthHelp() {
    if (refs.help) refs.help.style.display = 'none';
    helpDismissed = true;
  }

  // ---- WebSocket connection ----
  function connectWs() {
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return ws;
    var url;
    try {
      url = (typeof createSessionWebSocket === 'function')
        ? null  // use the helper directly below
        : null;
    } catch (_) {}
    try {
      ws = (typeof createSessionWebSocket === 'function')
        ? createSessionWebSocket('/terminal')
        : new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/terminal');
    } catch (e) {
      return null;
    }

    ws.addEventListener('open', function(){
      setStatus('on', 'WebSocket connected');
      try {
        if (term && fitAddon) {
          fitAddon.fit();
          ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
        }
      } catch(_){}
    });
    ws.addEventListener('close', function(){
      setStatus('off', 'WebSocket disconnected');
      setLauncherActive(null);
      currentProvider = null;
    });
    ws.addEventListener('error', function(){
      setStatus('err', 'WebSocket error');
    });
    ws.addEventListener('message', function(ev){
      try {
        var payload = JSON.parse(ev.data);
        var data = payload.data || payload.text || '';
        if (payload.type === 'data' || payload.type === 'pty' || (typeof data === 'string' && data)) {
          if (data) {
            // Lazy-attach: a PTY is producing output but our term hasn't
            // been instantiated yet. This happens when the user clicks the
            // header "AI を起動" while CLI Activity tab is open — the WS
            // handshake fired connected/running:false earlier, then Claude
            // got launched, and now data arrives. Reveal the host and
            // create the terminal on the fly.
            if (!term) {
              if (refs.empty) refs.empty.style.display = 'none';
              if (refs.host) refs.host.style.display = 'block';
              ensureTerm();
              setStatus('on', 'attached');
              if (!currentProvider) currentProvider = 'claude';
              setLauncherActive(currentProvider);
              showProviderBadge(currentProvider);
              if (term) {
                term.writeln('\\r\\n\\x1b[2m[実行中の ' + (PROVIDER_LABELS[currentProvider] || currentProvider) + ' セッションに自動接続しました]\\x1b[0m\\r\\n');
              }
            }
            if (term) {
              term.write(data);
              term.scrollToBottom();
              detectAuthError(data);
              detectSetupNeeded(data);
            }
          }
        } else if (payload.type === 'connected') {
          if (payload.running && payload.provider) {
            // PTY is already running (likely launched via header "AI を起動").
            // Reveal the terminal host and pipe further output here so the
            // user sees the same session in this panel.
            currentProvider = payload.provider;
            setLauncherActive(payload.provider);
            showProviderBadge(payload.provider);
            setStatus('on', payload.provider + ' running (attached)');
            if (refs.empty) refs.empty.style.display = 'none';
            if (refs.host) refs.host.style.display = 'block';
            ensureTerm();
            // Ask the server to resend buffered scrollback if it supports it.
            try {
              if (term && fitAddon) {
                fitAddon.fit();
                ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
                ws.send(JSON.stringify({ type: 'request-replay' }));
              }
            } catch(_){}
            if (term) {
              term.writeln('\\r\\n\\x1b[2m[既に実行中の ' + (PROVIDER_LABELS[payload.provider] || payload.provider) + ' セッションに接続しました]\\x1b[0m\\r\\n');
            }
          }
        } else if (payload.type === 'exit' || payload.type === 'closed') {
          setStatus('off', 'PTY exited');
          setLauncherActive(null);
          currentProvider = null;
          showProviderBadge(null);
          if (term) term.writeln('\\r\\n\\x1b[2m[session ended]\\x1b[0m');
        }
      } catch (_) {
        // raw text fallback
        if (term && typeof ev.data === 'string') {
          term.write(ev.data);
          term.scrollToBottom();
          detectAuthError(ev.data);
        }
      }
    });
    return ws;
  }

  // ---- Launch / stop ----
  function clearLaunchRequestState(controller) {
    if (!controller || launchAbortController === controller) {
      launchAbortController = null;
      launchAbortReason = null;
      if (launchTimeoutTimer) clearTimeout(launchTimeoutTimer);
      launchTimeoutTimer = null;
      launchInFlight = false;
    }
  }

  function cancelPendingLaunch(reason) {
    launchAbortReason = reason || 'cancelled';
    launchInFlight = false;
    if (launchTimeoutTimer) clearTimeout(launchTimeoutTimer);
    launchTimeoutTimer = null;
    if (launchAbortController) {
      try { launchAbortController.abort(); } catch (_) {}
    }
  }

  async function requestStopAi() {
    try {
      await window.fetch('/api/stop-ai', { method: 'POST' });
    } catch (_) {}
  }

  async function launch(provider) {
    if (!provider) return;
    if (launchInFlight) {
      if (term) term.writeln('\\r\\n\\x1b[2m[launch already in progress]\\x1b[0m');
      return;
    }
    launchInFlight = true;
    if (refs.empty) refs.empty.style.display = 'none';
    if (refs.host) refs.host.style.display = 'block';
    helpDismissed = false;
    streamBuffer = '';
    ensureTerm();
    if (!term) {
      // xterm not loaded yet — wait briefly and retry
      launchInFlight = false;
      setTimeout(function(){ launch(provider); }, 120);
      return;
    }
    showProviderBadge(provider);
    setLauncherActive(provider);
    setStatus('on', 'launching ' + provider);
    term.focus();
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    launchAbortController = controller;
    launchAbortReason = null;
    if (controller) {
      launchTimeoutTimer = setTimeout(function(){
        if (launchAbortController === controller) {
          cancelPendingLaunch('timeout');
        }
      }, LAUNCH_REQUEST_TIMEOUT_MS);
    }
    try {
      var res = await window.fetch('/api/launch-ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: provider, mode: 'default' }),
        signal: controller ? controller.signal : undefined
      });
      var json = await res.json().catch(function(){ return null; });
      if (!res.ok || (json && json.ok === false)) {
        var msg = (json && (json.error || json.message)) || ('HTTP ' + res.status);
        // 構造化エラー (cli_not_installed / cli_too_old) は親切な手順案内 + コピーボタン付きの
        // モーダルで通知する。生エラー文字列だけだと非エンジニアには不親切。
        var reason = json && json.reason;
        var cmd = json && (json.installCommand || json.updateCommand);
        if (reason === 'cli_not_installed' || reason === 'cli_too_old') {
          showCliSetupHelp({
            reason: reason,
            providerLabel: (json && json.providerLabel) || provider,
            command: cmd || '',
            installedVersion: json && json.installedVersion,
            minVersion: json && json.minVersion,
          });
          if (term) term.writeln('\\r\\n\\x1b[33m[setup required] ' + msg.split('\\n')[0] + '\\x1b[0m');
        } else if (reason === 'launch_cancelled') {
          if (term) term.writeln('\\r\\n\\x1b[2m[launch cancelled]\\x1b[0m');
        } else {
          if (term) term.writeln('\\r\\n\\x1b[31m[launch failed] ' + msg + '\\x1b[0m');
        }
        setStatus(reason === 'launch_cancelled' ? 'off' : 'err', reason === 'cli_too_old' ? 'cli too old' : reason === 'cli_not_installed' ? 'cli not installed' : reason === 'launch_cancelled' ? 'launch cancelled' : 'launch failed');
        setLauncherActive(null);
        return;
      }
      currentProvider = provider;
      connectWs();
      // v2.0.50: Claude のスラッシュコマンドメニュー (/add-dir, /login, ...) を
      // ユーザーが誤って確定する事故防止のためのヒント。term が準備できていれば
      // 起動直後に banner を出す (Claude welcome 表示の上書きにはならない位置)。
      if (term && provider === 'claude') {
        try {
          term.writeln('\\r\\n\\x1b[36m[操作ヒント]\\x1b[0m \\x1b[2m'
            + '"/" でコマンドメニューが開きます (例: \\x1b[0m\\x1b[2m/login)。'
            + '誤って表示された候補 (例: /add-dir) を取り消すには \\x1b[1mESC\\x1b[0m'
            + '\\x1b[2m か \\x1b[1mBackspace\\x1b[0m\\x1b[2m を押してください。\\x1b[0m');
        } catch (_) {}
      }
    } catch (e) {
      if (e && e.name === 'AbortError') {
        var reasonText = launchAbortReason === 'timeout' ? 'launch timed out' : 'launch cancelled';
        if (term) term.writeln('\\r\\n\\x1b[2m[' + reasonText + ']\\x1b[0m');
        if (launchAbortReason === 'timeout') await requestStopAi();
        setStatus('off', reasonText);
      } else {
        if (term) term.writeln('\\r\\n\\x1b[31m[launch failed] ' + (e && e.message || e) + '\\x1b[0m');
        setStatus('err', 'launch failed');
      }
      setLauncherActive(null);
    } finally {
      clearLaunchRequestState(controller);
    }
  }

  async function stop() {
    cancelPendingLaunch('stop');
    await requestStopAi();
    try { if (ws) ws.close(); } catch(_){}
    setLauncherActive(null);
    setStatus('off', 'stopped');
    showProviderBadge(null);
    currentProvider = null;
    if (term) term.writeln('\\r\\n\\x1b[2m[stop requested]\\x1b[0m');
  }

  // CLI 未インストール / 古い時に表示するセットアップ案内モーダル。
  // エンジニアでないユーザでもコピペできるよう、コマンドはコピーボタン付きで出す。
  function escHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  function showCliSetupHelp(info) {
    try {
      var existing = document.getElementById('cli-setup-help-modal');
      if (existing) existing.remove();
      var overlay = document.createElement('div');
      overlay.id = 'cli-setup-help-modal';
      overlay.style.cssText = 'position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45);backdrop-filter:blur(2px);';
      var box = document.createElement('div');
      box.style.cssText = 'background:var(--bg-card,#fff);color:var(--text-1,#111);border:1px solid var(--border-default,#e5e7eb);border-radius:14px;padding:22px 24px;max-width:560px;width:92%;box-shadow:0 12px 32px rgba(0,0,0,.18);font-family:system-ui,sans-serif;';
      var isInstall = info.reason === 'cli_not_installed';
      var title = isInstall
        ? (info.providerLabel + ' CLI をインストールする必要があります')
        : (info.providerLabel + ' CLI を更新する必要があります');
      var subtitle = isInstall
        ? '次のコマンドを PowerShell (または Command Prompt) で実行してください。'
        : ('現在: ' + (info.installedVersion || '不明') + ' → 推奨: ' + (info.minVersion || '最新版') + '+。次のコマンドで更新してください。');
      var cmd = info.command || '';
      box.innerHTML =
        '<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;">' +
          '<div style="font-size:22px;">' + (isInstall ? '🛠️' : '⏫') + '</div>' +
          '<h3 style="margin:0;font-size:16px;font-weight:700;">' + escHtml(title) + '</h3>' +
        '</div>' +
        '<p style="margin:0 0 10px;font-size:13px;line-height:1.6;color:var(--text-2,#555);">' + escHtml(subtitle) + '</p>' +
        '<div style="display:flex;gap:8px;align-items:stretch;margin:14px 0;">' +
          '<code id="cli-setup-cmd" style="flex:1;background:var(--bg-input,#0b0f1a);color:#e8edf7;padding:10px 12px;border-radius:8px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;overflow-x:auto;white-space:nowrap;">' + escHtml(cmd) + '</code>' +
          '<button type="button" id="cli-setup-copy" style="padding:8px 14px;border-radius:8px;border:1px solid var(--border-default,#e5e7eb);background:var(--bg-card,#fff);color:var(--text-1,#111);cursor:pointer;font-size:13px;">コピー</button>' +
        '</div>' +
        '<details style="margin:10px 0;font-size:12px;color:var(--text-2,#555);">' +
          '<summary style="cursor:pointer;">PowerShell が分からない場合</summary>' +
          '<ol style="margin:8px 0 0 18px;padding:0;line-height:1.7;">' +
            '<li>Windows キー + R → <code>powershell</code> と入力 → Enter</li>' +
            '<li>上記のコマンドを貼り付けて Enter</li>' +
            '<li>完了したらこの画面に戻って再度起動ボタンを押してください</li>' +
          '</ol>' +
        '</details>' +
        '<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px;">' +
          '<button type="button" id="cli-setup-close" style="padding:8px 16px;border-radius:8px;border:1px solid var(--border-default,#e5e7eb);background:var(--bg-card,#fff);color:var(--text-1,#111);cursor:pointer;font-size:13px;">閉じる</button>' +
        '</div>';
      overlay.appendChild(box);
      document.body.appendChild(overlay);
      var copyBtn = box.querySelector('#cli-setup-copy');
      if (copyBtn) {
        copyBtn.addEventListener('click', function () {
          try {
            navigator.clipboard.writeText(cmd).then(function () {
              copyBtn.textContent = 'コピー済';
              setTimeout(function () { copyBtn.textContent = 'コピー'; }, 1500);
            }, function () { copyBtn.textContent = 'コピー失敗'; });
          } catch (_) {
            copyBtn.textContent = 'コピー失敗';
          }
        });
      }
      var closeBtn = box.querySelector('#cli-setup-close');
      if (closeBtn) closeBtn.addEventListener('click', function () { overlay.remove(); });
      overlay.addEventListener('click', function (ev) { if (ev.target === overlay) overlay.remove(); });
    } catch (e) {
      console.warn('[cli-setup-help] render failed:', e && e.message || e);
    }
  }

  function typeLogin() {
    if (!ws || ws.readyState !== 1) {
      // Re-launch claude first
      launch('claude').then(function(){
        setTimeout(function(){ typeLoginNow(); }, 800);
      });
      return;
    }
    typeLoginNow();
  }
  function typeLoginNow() {
    if (!ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify({ type: 'input', data: '/login\\r' }));
    if (term) term.focus();
    hideAuthHelp();
  }

  // ---- Event delegation ----
  function bindEvents() {
    if (!refs.card) return;
    refs.card.addEventListener('click', function(ev){
      var launchBtn = ev.target.closest && ev.target.closest('[data-cli-launch]');
      if (launchBtn) {
        ev.preventDefault();
        launch(launchBtn.getAttribute('data-cli-launch'));
        return;
      }
      var stopBtn = ev.target.closest && ev.target.closest('[data-cli-stop]');
      if (stopBtn && !stopBtn.disabled) {
        ev.preventDefault();
        stop();
        return;
      }
      var actionEl = ev.target.closest && ev.target.closest('[data-cli-action]');
      if (actionEl) {
        var action = actionEl.getAttribute('data-cli-action');
        if (action === 'type-login') {
          ev.preventDefault();
          typeLogin();
        } else if (action === 'dismiss-help') {
          ev.preventDefault();
          hideAuthHelp();
        } else if (action === 'install-cli') {
          ev.preventDefault();
          runInstallCli();
        } else if (action === 'dismiss-setup') {
          ev.preventDefault();
          hideSetupBanner();
        }
      }
    });
  }

  function init() {
    bindRefs();
    if (!refs.card) return;
    setStatus('off', 'idle');
    bindEvents();

    // Detect existing running session — server sends {type:'connected', running:true, provider} once we connect
    // Lazily connect to surface that state.
    setTimeout(connectWs, 200);

    // Proactive setup probe: if Playwright/Chromium isn't ready, surface
    // the AI CLI 準備 banner before the user even tries to launch.
    setTimeout(function(){
      try {
        window.fetch('/api/ai/setup-diagnostics').then(function(r){
          if (!r || !r.ok) return null;
          return r.json();
        }).then(function(j){
          if (!j) return;
          var pkg = j.playwrightPackage || {};
          if (!pkg.available || !pkg.browserInstalled) {
            showSetupBanner();
          }
        }).catch(function(){});
      } catch(_){}
    }, 1500);

    // CLI Activity タブが visible になるたびに fit + resize 送信。
    // タブが非表示の状態で xterm.open() するとサイズが 0 で fit が
    // 機能せず、表示後にカーソル位置が崩れる。
    var logsTab = document.getElementById('tab-logs');
    if (logsTab) {
      var lastActive = logsTab.classList.contains('active');
      var tabObs = new MutationObserver(function(){
        var nowActive = logsTab.classList.contains('active');
        if (nowActive && !lastActive) {
          // Just became visible — refit several times to handle layout settle
          [40, 200, 600].forEach(function(ms){
            setTimeout(function(){
              if (!term || !fitAddon) return;
              try {
                fitAddon.fit();
                if (ws && ws.readyState === 1) {
                  ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
                }
                term.scrollToBottom();
                term.focus();
              } catch(_){}
            }, ms);
          });
        }
        lastActive = nowActive;
      });
      tabObs.observe(logsTab, { attributes: true, attributeFilter: ['class'] });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();`;

module.exports = function renderCliTerminalScript() {
  return SCRIPT;
};

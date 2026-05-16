'use strict';

// サブエージェントが並列実行するスタンドアロン企業分析 + メッセージ生成スクリプト
// Usage: node src/parallel-analysis.cjs '{"no":1,"companyName":"...","url":"...","type":"..."}'
//
// MCP不使用。直接 Playwright または HTTP フェッチで企業サイトを分析し、
// message-builder.cjs でメッセージを生成する。
// 結果は stdout に JSON で出力。副作用として action-log.json と live-monitor.json を更新する。

const path = require('path');
const { log, thinking } = require('./cli-logger');
const { updateLiveMonitor } = require('./live-monitor');
const { resolveContactFormUrl } = require('./form-url-resolver');
const { resolveOfficialSiteByCompanyName } = require('./official-site-resolver');
const { resolveDataPath } = require('./data-paths');

/**
 * Provider 別の HOME ディレクトリを返す。Programmatic Credit 認証 (subscription
 * token) の読み込み先となる。dashboard-server.ts::getManagedProviderHome と
 * 同じパス規約。parallel-analysis.cjs は独立した Node プロセスなので、
 * dashboard-server の関数を直接 require できず、同じロジックを再実装する。
 */
function resolveProviderHomeDir(providerId: string): string {
  const safe = typeof providerId === 'string' && providerId.trim()
    ? providerId.trim().toLowerCase()
    : 'claude';
  // dashboard-server の normalizeProviderId と同じ allowlist
  const normalized = ['claude', 'codex', 'gemini'].includes(safe) ? safe : 'claude';
  return resolveDataPath(path.join('provider-homes', normalized));
}

/**
 * action-logger.cjs を遅延 require で取得する。失敗時は no-op スタブを返す。
 * @returns {{ logAction: (no: number, name: string, action: string, details?: string) => void }}
 */
function loadActionLogger() {
  try {
    return require('./action-logger');
  } catch (_) {
    return { logAction: () => {} };
  }
}

/**
 * message-builder.cjs を require で取得する。
 * @returns {*} message-builder モジュール
 */
function loadMessageBuilder() {
  return require('./message-builder');
}

/**
 * URL 未設定は「分析ワーカーの失敗」ではなく、入力データ不足による正常スキップ。
 * sendability-gate 側では siteText_sufficient を fatal/error として返すが、
 * Phase A の集計では skipped にしないと「全件失敗」と誤表示される。
 *
 * @param {AnalysisResult} analysis
 * @param {SendabilityResult} gateResult
 * @returns {boolean}
 */
function isUrlMissingGateSkip(analysis, gateResult) {
  if (!analysis || analysis.urlMissing !== true) return false;
  const failures = Array.isArray(gateResult && gateResult.failures) ? gateResult.failures : [];
  const fatalFailures = failures.filter((failure: any) => failure && failure.severity === 'fatal');
  return fatalFailures.length > 0
    && fatalFailures.every((failure: any) => failure.name === 'siteText_sufficient');
}

/**
 * @typedef {Object} BusinessArea
 * @property {string} key
 * @property {string} label
 * @property {Array<string>} words
 * @property {number} matchCount
 * @property {number} confidence
 */

/**
 * @typedef {Object} GapEntry
 * @property {*} strength
 * @property {'absent'|'weak'} gap
 * @property {'high'|'medium'|'low'} relevance
 */

/**
 * @typedef {Object} AnalysisResult
 * @property {string} companyName
 * @property {string} companyType
 * @property {string} companyUrl
 * @property {Array<BusinessArea>} businessAreas
 * @property {Array<GapEntry>} gaps
 * @property {Array<string>} focusAreas
 * @property {Array<Object>} relevantPatterns
 * @property {number} siteTextLength
 * @property {string} siteTextExcerpt
 * @property {Array<string>} [companyPhrases]
 * @property {string} [analysisMode]
 * @property {boolean} [urlMissing]
 * @property {string} [metaDescription]
 * @property {string} [notes]
 * @property {string} [resolvedFormUrl]
 * @property {string} [formResolutionMethod]
 * @property {string} [formType]
 * @property {Object} [llm]
 * @property {boolean} [llmRequestedSkip]
 */

/**
 * CLI 実行ファイル (claude/codex/gemini) を PATH から探す。
 * Sales Claw のメインプロセスとは違って、parallel-analysis.cjs は別プロセス
 * で動いているので resolveClaudeExecutable には頼れない。`where`/`which` で
 * 見つける。見つからなければ null。
 *
 * セキュリティ HIGH-2 mitigation:
 * `where claude` は PATH の先頭から探す。攻撃者が PATH に
 * `C:\Users\Public\claude.exe` 等の悪意あるバイナリを置くと乗っ取られる。
 * 信頼できる install 先 (npm global / .local/bin) のみ許可する allowlist を
 * 適用し、それ以外は拒否する。
 */
const TRUSTED_CLI_PATH_PATTERNS = [
  /\\Programs\\Sales Claw\\/i,           // Sales Claw 同梱版
  /\\AppData\\Roaming\\npm\\/i,          // npm global
  /\\AppData\\Local\\Programs\\nodejs\\/i,
  /\\Program Files\\nodejs\\/i,
  /\\\.local\\bin\\/i,                   // claude self-update install dir
  /\\sales-claw\\runtime\\/i,            // toolchain
  /\\\.sales-claw\\tools\\/i,
  /\\AppData\\Local\\OpenAI\\Codex\\bin\\/i,
  /\/usr\/local\/bin\//,
  /\/opt\/homebrew\/bin\//,
  /\/home\/[^/]+\/\.local\/bin\//,
];

/**
 * 与えられたパスが信頼できる CLI インストール先 (allowlist) に該当するか判定する。
 * @param {string} p 絶対パス
 * @returns {boolean}
 */
function isTrustedCliPath(p) {
  if (!p || typeof p !== 'string') return false;
  return TRUSTED_CLI_PATH_PATTERNS.some((re: any) => re.test(p));
}

/**
 * claude/codex/gemini の実行可能ファイルを where/which で探し、allowlist で検証する。
 * @param {string} providerId 'claude' | 'codex' | 'gemini'
 * @returns {Promise<string|null>} 信頼できる実行ファイルパス、見つからなければ null
 */
async function resolveCliExecutable(providerId) {
  const { execFile } = require('child_process');
  const { promisify } = require('util');
  const execFileP = promisify(execFile);
  const cmdName = providerId === 'codex' ? 'codex' : providerId === 'gemini' ? 'gemini' : 'claude';
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const { stdout } = await execFileP(cmd, [cmdName], { timeout: 3000 });
    const lines = String(stdout || '').split(/\r?\n/).map((s: any) => s.trim()).filter(Boolean);
    // allowlist filter (PATH injection 防御)
    const trusted = lines.filter(isTrustedCliPath);
    if (trusted.length === 0) return null;
    // .exe を優先 (headless mode で安定)
    for (const line of trusted) {
      if (process.platform === 'win32' && line.toLowerCase().endsWith('.exe')) return line;
    }
    return trusted[0] || null;
  } catch (_) {
    return null;
  }
}

/**
 * URL の安全性をチェックする (SSRF 防止: プライベートIP・非 HTTP(S) を拒否)。
 * @param {string} rawUrl 検証対象 URL
 * @returns {boolean} 安全なら true、危険なら false
 */
// URL安全性チェック（SSRF防止: プライベートIP・非HTTP(S)をブロック）
function isSafeUrl(rawUrl) {
  let parsed;
  try { parsed = new URL(rawUrl); } catch { return false; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const hostname = parsed.hostname.toLowerCase();
  // 標準的なプライベートIP/ループバック
  const bareHost = hostname.replace(/^\[|\]$/g, '');
  if (/^(localhost|127\.|0\.|::1|169\.254\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|fc[0-9a-f]{2}:|fd[0-9a-f]{2}:|fe80:|::ffff:)/.test(bareHost)) return false;
  // 10進数IP (例: 2130706433 = 127.0.0.1) と16進数IP (例: 0x7f000001)
  if (/^\d+$/.test(hostname) || /^0x[0-9a-f]+$/i.test(hostname)) return false;
  // ドットなしホスト名（ローカル解決リスク）
  if (!hostname.includes('.') && !hostname.includes(':')) return false;
  return true;
}

/**
 * HTTP fetch + キーワード辞書で企業サイトを軽量分析し、業務領域・ギャップ・注力領域を抽出する。
 * @param {string} url 企業公式サイト URL
 * @param {string} companyName 会社名
 * @param {string} companyType 企業タイプ (任意)
 * @returns {Promise<AnalysisResult>}
 */
// HTTP ベースの軽量サイト分析（Playwright 不使用）
async function analyzeCompanyLite(url, companyName, companyType) {
  // Cache hit check: 同じ会社の分析を 30 日以内に実行済みなら、HTTP fetch も
  // LLM 呼び出しもしないで即返す。Programmatic Credit 枠の無駄遣いを防ぐ。
  //
  // disable 条件:
  //   - env SALES_CLAW_DISABLE_ANALYSIS_CACHE=1  (デバッグ用 bypass)
  //   - url が空 (キャッシュキーが弱すぎる)
  try {
    if (process.env.SALES_CLAW_DISABLE_ANALYSIS_CACHE !== '1' && url) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const analysisCache = require('./analysis-cache');
      const cached = analysisCache.getCachedAnalysis(url, companyName || '');
      if (cached && typeof cached === 'object') {
        // hit を示すフラグだけ立てて返す (下流が「再分析だった」かを判定できるよう)
        return { ...cached, _fromCache: true, _cacheHitAt: new Date().toISOString() };
      }
    }
  } catch (_) { /* キャッシュ失敗で本処理は止めない */ }

  const https = require('https');
  const http = require('http');
  // Phase 3: 言語検出 + locale 別 Accept-Language を切り替えるためのユーティリティ
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { detectLanguage } = require('./language-detector');

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  /**
   * URL の TLD から優先言語を推定し、Accept-Language ヘッダ値を返す。
   * - .co.jp / .jp / .ne.jp / .or.jp など → 日本語優先
   * - 他 (.com / .io / .co.uk / .ai / .org 等) → 英語優先
   * 推定が外れたサイトでも detectLanguage() で再判定するため過信しない。
   */
  function pickAcceptLanguageForUrl(targetUrl: string): string {
    // v2.0.36: 既存日本語ユーザー保護。messageTemplates.language が明示 'ja'
    // または preferences.language === 'ja' (= 日本市場のみターゲット) の場合、
    // 全サイト ja 優先で取得して旧 v2.0.34 以前と完全互換にする。
    // (default 'auto' の場合のみ TLD で動的に判定する。これは英語ユーザーが
    // .com の英語企業を分析するときに英語版を取りやすくするため。)
    try {
      const settings = require('./settings-manager');
      const msgLang = settings.getSection('messageTemplates')?.language;
      const uiLang = settings.getSection('preferences')?.language;
      if (msgLang === 'ja' || (msgLang !== 'en' && uiLang === 'ja')) {
        return 'ja,en-US;q=0.9,en;q=0.8';
      }
    } catch (_) { /* settings 読み込み失敗は default 挙動 */ }
    try {
      const host = new URL(targetUrl).hostname.toLowerCase();
      // Japanese TLDs / co.jp / ne.jp / or.jp / ac.jp / go.jp / lg.jp / ed.jp
      if (
        /\.jp$/.test(host) ||
        /\.(co|ne|or|ac|go|lg|ed)\.jp$/.test(host)
      ) {
        return 'ja,en-US;q=0.5';
      }
      // gTLD / 他国コード TLD は英語優先
      return 'en,ja;q=0.5';
    } catch (_) {
      return 'ja,en-US;q=0.9,en;q=0.8';
    }
  }

  // DNS rebinding対策: 解決済みIPがプライベート範囲でないか検証
  function isPrivateIP(ip) {
    return /^(127\.|0\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1|fc|fd|fe80|::ffff:)/.test(ip);
  }
  function safeLookup(hostname, options, callback) {
    const dns = require('dns');
    dns.lookup(hostname, options, (err, address, family) => {
      if (err) return callback(err);
      if (isPrivateIP(address)) return callback(new Error('DNS resolved to private IP: ' + address));
      callback(null, address, family);
    });
  }

  // 1.2.89 fix: 大手企業サイト (Akamai / Cloudflare で UA 検証あり) への anti-bot 対応。
  // 旧 UA は "Mozilla/5.0 (...) AppleWebKit/537.36" で途中切れ → 弾かれる。
  // 完全な Chrome UA + Accept-* ヘッダ + gzip/br 解凍 で大手サイトも取得可能にする
  const zlib = require('zlib');
  const FULL_CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
  // Phase 3: Accept-Language は URL TLD から動的に決める。
  // BROWSER_HEADERS は Accept-Language を含まないテンプレートにし、
  // fetchText() が targetUrl ごとに pickAcceptLanguageForUrl() で上書きする。
  const BROWSER_HEADERS_BASE = {
    'User-Agent': FULL_CHROME_UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Sec-Ch-Ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
  };

  /**
   * Content-Encoding に応じてレスポンスボディを UTF-8 文字列にデコードする。
   * @param {Buffer} buffer 圧縮済みレスポンスボディ
   * @param {string} encoding 'gzip' | 'deflate' | 'br' など Content-Encoding 値
   * @returns {string} UTF-8 デコード済み本文
   */
  function decodeBody(buffer, encoding) {
    try {
      switch ((encoding || '').toLowerCase()) {
        case 'gzip': return zlib.gunzipSync(buffer).toString('utf8');
        case 'deflate': return zlib.inflateSync(buffer).toString('utf8');
        case 'br': return zlib.brotliDecompressSync(buffer).toString('utf8');
        default: return buffer.toString('utf8');
      }
    } catch (_) {
      // Decode 失敗時は plain UTF-8 として fallback
      try { return buffer.toString('utf8'); } catch (_) { return ''; }
    }
  }

  /**
   * https/http で targetUrl を取得し、Content-Encoding を解凍して本文を返す。
   * @param {string} targetUrl 取得対象 URL
   * @param {number} [redirects=3] リダイレクト残回数
   * @returns {Promise<string>} HTML 本文または空文字、レート制限時は '__RATE_LIMITED__'
   */
  function fetchText(targetUrl, redirects = 3) {
    if (!isSafeUrl(targetUrl)) { return Promise.resolve(''); }
    return new Promise<unknown>((resolve) => {
      if (redirects <= 0) { resolve(''); return; }
      const mod = targetUrl.startsWith('https') ? https : http;
      // Phase 3: TLD ベースの Accept-Language を毎リクエスト合成する
      const headers = {
        ...BROWSER_HEADERS_BASE,
        'Accept-Language': pickAcceptLanguageForUrl(targetUrl),
      };
      const req = mod.get(targetUrl, { timeout: 15000, lookup: safeLookup, headers }, (res) => {
        // レート制限検知: 429/503 → 空文字を返す（バックオフはcaller側）
        if (res.statusCode === 429 || res.statusCode === 503) {
          res.resume();
          resolve('__RATE_LIMITED__');
          return;
        }
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const next = new URL(res.headers.location, targetUrl).href;
          if (!isSafeUrl(next)) { res.resume(); resolve(''); return; }
          resolve(fetchText(next, redirects - 1));
          return;
        }
        // Buffer モードで受け取り、Content-Encoding に応じて解凍
        const encoding = res.headers['content-encoding'];
        const chunks: any[] = [];
        let totalLen = 0;
        res.on('data', (chunk) => {
          chunks.push(chunk);
          totalLen += chunk.length;
          if (totalLen > 500000) res.destroy(); // 500KB 上限 (圧縮後)
        });
        res.on('end', () => {
          try {
            const buf = Buffer.concat(chunks);
            resolve(decodeBody(buf, encoding));
          } catch (_) {
            resolve('');
          }
        });
        res.on('error', () => resolve(''));
      });
      req.on('error', () => resolve(''));
      req.on('timeout', () => { req.destroy(); resolve(''); });
    });
  }

  /**
   * fetchText を最大 3 回リトライ。429/503 を受けたら指数バックオフで待つ。
   * @param {string} targetUrl 取得対象 URL
   * @returns {Promise<string>} HTML 本文、最終的に取得できなければ空文字
   */
  // バックオフ付きfetch（最大3回リトライ — レート制限対応）
  async function fetchTextWithBackoff(targetUrl) {
    const maxAttempts = 3;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) {
        const delayMs = 1000 * Math.pow(2, attempt);
        log('[WARN] Rate limited by ' + targetUrl + ', retrying in ' + delayMs + 'ms', 'warn');
        await sleep(delayMs);
      }
      const result: any = await fetchText(targetUrl);
      if (result !== '__RATE_LIMITED__') return result;
    }
    log('[WARN] Rate limit persists after retries, giving up: ' + targetUrl, 'warn');
    return '';
  }

  /**
   * Anti-bot サイト向けの Playwright (chromium headless) fallback fetch。
   * @param {string} targetUrl 取得対象 URL
   * @returns {Promise<string>} レンダリング後の HTML、失敗時は空文字
   */
  // 1.2.89: anti-bot サイト (Akamai/Cloudflare Turnstile 等) で HTTP fetch が
  // 通らない場合の Playwright fallback。chromium 起動 → page.goto → page.content。
  // 30 秒 timeout。失敗時は空文字を返す。
  async function fetchTextWithPlaywright(targetUrl) {
    if (!isSafeUrl(targetUrl)) return '';
    let chromium: any = null;
    try { chromium = require('playwright').chromium; } catch (e) {
      // playwright module 不在 (ライブラリ未 install) の場合
      throw new Error('playwright module not available: ' + e.message);
    }
    let browser: any = null;
    let context: any = null;
    try {
      browser = await chromium.launch({ headless: true });
      context = await browser.newContext({
        userAgent: FULL_CHROME_UA,
        locale: 'ja-JP',
        extraHTTPHeaders: {
          'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
        },
      });
      const page: any = await context.newPage();
      await page.goto(targetUrl, { timeout: 30000, waitUntil: 'domcontentloaded' });
      // anti-bot challenge は domcontentloaded 後に追加 JS で解除されることが多い
      await page.waitForTimeout(2000);
      const html: any = await page.content();
      return html || '';
    } catch (e) {
      throw e;
    } finally {
      try { if (context) await context.close(); } catch (_) {}
      try { if (browser) await browser.close(); } catch (_) {}
    }
  }

  /**
   * HTML から script/style/タグを除去し、空白正規化したテキストを最大 8000 字で返す。
   * @param {string} html 生 HTML
   * @returns {string} プレーンテキスト
   */
  function extractText(html) {
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 8000);
  }

  /**
   * HTML から meta description / 見出し / 関連サブページリンクを抽出する。
   * @param {string} html 生 HTML
   * @returns {{ metaDescription: string, headings: Array<string>, subpageLinks: Array<string> }}
   */
  // HTMLから構造化情報を抽出（タグ除去前に実行）
  function extractStructuredContent(html) {
    const metaDesc = (
      html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']{10,})/i) ||
      html.match(/<meta[^>]+content=["']([^"']{10,})["'][^>]+property=["']og:description["']/i) ||
      html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']{10,})/i) ||
      html.match(/<meta[^>]+content=["']([^"']{10,})["'][^>]+name=["']description["']/i) ||
      []
    )[1] || '';

    const headings: any[] = [];
    for (const m of html.matchAll(/<h[123][^>]*>([\s\S]*?)<\/h[123]>/gi)) {
      const text = m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (text.length > 3 && text.length < 80) headings.push(text);
    }

    // サービス・会社紹介ページのリンクを抽出
    const subpageLinks: any[] = [];
    for (const m of html.matchAll(/href=["'](https?:\/\/[^"'#?]+)/gi)) {
      const href = m[1];
      if (/service|サービス|事業|about|会社|solution|strength|feature/i.test(href)) {
        subpageLinks.push(href);
      }
    }

    return {
      metaDescription: metaDesc.trim().slice(0, 200),
      headings: [...new Set(headings)].slice(0, 10),
      subpageLinks: [...new Set(subpageLinks)].slice(0, 3),
    };
  }

  let topHtml: any = await fetchTextWithBackoff(url);
  let siteText = extractText(topHtml);

  // 1.2.89: HTTP fetch で取れない (Akamai/Cloudflare 等の anti-bot で 403/200 だが空)
  // 場合は Playwright (headless chromium) で fallback。Phase A subprocess なので
  // 重いが、ADK 等の大手企業を確実に取得できる。siteText が 200 字未満なら try。
  if (siteText.length < 200) {
    try {
      log('[INFO] HTTP fetch returned ' + siteText.length + ' chars, trying Playwright fallback for ' + url, 'info');
      const pwHtml: any = await fetchTextWithPlaywright(url);
      if (pwHtml && pwHtml.length > topHtml.length) {
        topHtml = pwHtml;
        siteText = extractText(topHtml);
        log('[INFO] Playwright fallback succeeded: ' + siteText.length + ' chars', 'info');
      }
    } catch (e) {
      log('[WARN] Playwright fallback failed: ' + (e.message || e), 'warn');
    }
  }
  const structured = extractStructuredContent(topHtml);

  // サービスページを1枚追加取得（CVRに効く具体情報を増やす）
  let subpageText = '';
  for (const subUrl of structured.subpageLinks.slice(0, 2)) {
    if (!isSafeUrl(subUrl)) continue;
    try {
      const subHtml: any = await fetchTextWithBackoff(subUrl);
      const sub = extractText(subHtml).slice(0, 3000);
      if (sub.length > 200) { subpageText = sub; break; }
    } catch (_) {}
  }

  const combinedText = (siteText + '\n' + subpageText).slice(0, 10000);
  const siteTextExcerpt = combinedText.slice(0, 2000);
  const settings = require('./settings-manager');
  const strengths = settings.getStrengths();

  // 事業領域の抽出（キーワード密度スコアで信頼度を付ける）
  const areaChecks = [
    { key: 'si', label: 'システム開発・SIer', words: ['システム開発', 'システムインテグレーション', 'si事業', '受託開発', 'SIer'] },
    { key: 'infra', label: 'インフラ・クラウド', words: ['インフラ', 'ネットワーク', 'クラウド基盤', 'AWS', 'Azure', 'GCP'] },
    { key: 'consulting', label: 'コンサルティング', words: ['コンサルティング', 'コンサル', '経営支援', '業務改善', '戦略'] },
    { key: 'erp', label: 'ERP・基幹系', words: ['ERP', 'SAP', '基幹システム', '会計システム', '業務システム'] },
    { key: 'security', label: 'セキュリティ', words: ['セキュリティ', 'サイバー', '脆弱性', 'SOC', 'CSIRT'] },
    { key: 'data', label: 'データ分析・BI', words: ['データ分析', 'BI', 'データ活用', '可視化', 'ダッシュボード', 'データドリブン'] },
    { key: 'dx', label: 'DX推進', words: ['DX', 'デジタルトランスフォーメーション', 'デジタル変革', 'DX推進'] },
    { key: 'ai_ml', label: 'AI・機械学習', words: ['AI', '人工知能', '機械学習', 'ディープラーニング', '生成AI', 'LLM'] },
    { key: 'web', label: 'Web制作・開発', words: ['Web制作', 'ホームページ制作', 'Webサイト', 'サイト構築', 'フロントエンド'] },
    { key: 'saas', label: 'SaaS・プロダクト', words: ['SaaS', 'プロダクト', 'サブスクリプション', '自社サービス', 'クラウドサービス'] },
    { key: 'bpo', label: 'BPO・アウトソーシング', words: ['BPO', 'アウトソーシング', '業務代行', '委託'] },
    { key: 'hr', label: '人材・SES', words: ['人材', '派遣', 'エンジニア派遣', 'SES', '技術者派遣'] },
    { key: 'marketing', label: 'マーケティング', words: ['マーケティング', '広告', 'SEO', 'SEM', 'CRM', 'MA'] },
  ];
  const combinedLower = combinedText.toLowerCase();
  const businessAreas = areaChecks
    .map((c: any) => {
      const count = c.words.filter((w: any) => combinedLower.includes(w.toLowerCase())).length;
      return count > 0 ? { ...c, matchCount: count, confidence: Math.min(count / 2, 1.0) } : null;
    })
    .filter(Boolean)
    .sort((a: any, b: any) => b.matchCount - a.matchCount);

  // ギャップ分析（自社強みのキーワードが相手サイトに少ない = 補完余地あり）
  const gaps = strengths.map((s: any) => {
    const keywords = (s.keywords || []).concat([s.label]);
    const matchCount = keywords.filter((k: any) => combinedLower.includes(String(k).toLowerCase())).length;
    if (matchCount === 0) return { strength: s, gap: 'absent', relevance: 'high' };
    if (matchCount < keywords.length * 0.3) return { strength: s, gap: 'weak', relevance: 'medium' };
    return null;
  }).filter(Boolean);

  // 注力領域
  const focusAreas: any[] = [];
  if (/パートナー|協業|提携|アライアンス/.test(combinedText)) focusAreas.push('パートナーを募集中');
  if (/新サービス|リリース|ローンチ|プレスリリース/.test(combinedText)) focusAreas.push('新サービス展開中');
  if (/DX|デジタル変革|デジタルトランスフォーメーション/.test(combinedText)) focusAreas.push('DX推進を強化中');
  if (/採用強化|積極採用|エンジニア募集/.test(combinedText)) focusAreas.push('採用強化中');

  // 関連パターン
  const allPatterns = settings.getSuccessPatterns();
  const relevantPatterns = allPatterns.filter((p: any) => {
    const pType = String(p.type || '').toLowerCase();
    return companyType && pType.includes(companyType.toLowerCase());
  });

  // Phase 3: 取得した HTML から言語自動判定。
  // topHtml が空なら 'other'/'default' に倒れるが、それでも detectLanguage の
  // フォールバック (en, confidence 0.3) を使う。下流の Locale 切替は
  // dashboard-server / message-builder 側で「auto かつ confidence>=0.5」のとき
  // に採用するなどの判断ができるよう、source / confidence を持たせる。
  let detectedLanguage: { language: 'ja' | 'en' | 'other'; confidence: number; source: string } | null = null;
  try {
    const det = detectLanguage(topHtml || '');
    detectedLanguage = det;
  } catch (_) {
    detectedLanguage = null;
  }

  const analysisResult = {
    companyName,
    companyType: companyType || '',
    companyUrl: url || '',
    businessAreas: businessAreas.slice(0, 6),
    gaps: gaps.slice(0, 5),
    focusAreas,
    relevantPatterns: relevantPatterns.slice(0, 3),
    siteTextLength: combinedText.length,
    siteTextExcerpt,
    companyPhrases: structured.headings,
    metaDescription: structured.metaDescription,
    analysisMode: 'lite',
    detectedLanguage,
  };

  // キャッシュへ書き込み: 次回の同じ会社分析を 0 token で済ませる
  try {
    if (process.env.SALES_CLAW_DISABLE_ANALYSIS_CACHE !== '1' && url) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const analysisCache = require('./analysis-cache');
      analysisCache.setCachedAnalysis(url, companyName || '', analysisResult);
    }
  } catch (_) { /* キャッシュ失敗で本処理は止めない */ }

  return analysisResult;
}

/**
 * サブプロセスのエントリーポイント。stdin の company JSON を受けて分析+メッセージ生成し stdout に結果を出力する。
 * @returns {Promise<void>}
 */
async function main() {
  const input = process.argv[2];
  if (!input) {
    process.stderr.write('Usage: node parallel-analysis.cjs \'{"no":1,"companyName":"...","url":"..."}\'\n');
    process.exit(1);
  }

  let company;
  try {
    company = JSON.parse(input);
  } catch (e) {
    process.stderr.write('Invalid JSON input: ' + e.message + '\n');
    process.exit(1);
  }

  const { no, companyName, url, type: companyType, formUrl } = company;
  const actionLogger = loadActionLogger();
  const messageBuilder = loadMessageBuilder();

  try {
    // Step 0: URL 解決
    // target list に URL が無い会社でも、会社名から公式サイトを探索して Phase A の
    // サイト分析へ進める。Phase B に探索を委ねると、Sendability Gate が先に止まり
    // 「URL未設定」だけで全件 skip になってしまうため、入口で解決する。
    let effectiveUrl = String(url || '').trim();
    let siteResolution: any = null;
    const hadInputUrl = !!effectiveUrl;

    if (!effectiveUrl && formUrl && isSafeUrl(formUrl)) {
      try {
        const formOrigin = new URL(formUrl).origin + '/';
        effectiveUrl = formOrigin;
        siteResolution = {
          ok: true,
          url: effectiveUrl,
          method: 'form-url-origin',
          provider: 'target-list',
          confidence: 0.65,
        };
      } catch (_) {
        // formUrl が URL として扱えない場合は会社名検索へ進む
      }
    }

    if (!effectiveUrl) {
      thinking(`[No.${no}] ${companyName}: URL未設定 — 会社名から公式サイト探索中`);
      updateLiveMonitor(no, {
        companyNo: no,
        companyName,
        status: 'analyzing',
        step: '公式サイト探索中',
        currentUrl: '',
      });
      try {
        siteResolution = await resolveOfficialSiteByCompanyName(companyName);
        if (siteResolution && siteResolution.ok && siteResolution.url) {
          effectiveUrl = siteResolution.url;
          log(`[No.${no}] ${companyName}: 公式サイト解決 ${effectiveUrl} (${siteResolution.query || siteResolution.method})`, 'step');
        } else {
          const resolutionError = siteResolution && siteResolution.error ? siteResolution.error : 'official-site-not-found';
          log(`[No.${no}] ${companyName}: 公式サイト未解決 (${resolutionError})`, 'warn');
        }
      } catch (e) {
        siteResolution = { ok: false, error: e && e.message ? e.message : String(e || 'unknown') };
        log(`[No.${no}] ${companyName}: 公式サイト探索エラー (${siteResolution.error})`, 'warn');
      }
    }

    if (siteResolution) {
      actionLogger.logAction(no, companyName, 'site_discovery', JSON.stringify({
        ok: !!siteResolution.ok,
        url: siteResolution.url || '',
        method: siteResolution.method || '',
        provider: siteResolution.provider || '',
        query: siteResolution.query || '',
        confidence: siteResolution.confidence || 0,
        error: siteResolution.error || '',
        candidates: Array.isArray(siteResolution.candidates)
          ? siteResolution.candidates.slice(0, 3).map((candidate: any) => ({
              title: candidate.title,
              url: candidate.url,
              score: candidate.score,
              verification: candidate.verification && {
                ok: candidate.verification.ok,
                score: candidate.verification.score,
                reason: candidate.verification.reason,
                matchedVariant: candidate.verification.matchedVariant,
              },
            }))
          : [],
      }));
    }

    const urlMissing = !effectiveUrl;

    // Step 1: サイト分析
    thinking(`[No.${no}] ${companyName}: サイト分析開始${urlMissing ? ' (公式サイト未解決)' : ''}`);
    updateLiveMonitor(no, {
      companyNo: no,
      companyName,
      status: 'analyzing',
      step: urlMissing ? '公式サイト未解決' : 'サイト分析中',
      currentUrl: effectiveUrl || '',
    });

    const analysis: any = urlMissing
      ? {
          companyName,
          companyType: companyType || '',
          companyUrl: '',
          businessAreas: [],
          gaps: [],
          focusAreas: [],
          relevantPatterns: [],
          siteTextLength: 0,
          siteTextExcerpt: '',
          analysisMode: 'url_missing',
          urlMissing: true,
          siteResolutionError: siteResolution && siteResolution.error ? siteResolution.error : 'official-site-not-found',
        }
      : await Promise.race([
          analyzeCompanyLite(effectiveUrl, companyName, companyType),
          new Promise<unknown>((resolve) => setTimeout(() => resolve({
            companyName, companyType: companyType || '', companyUrl: effectiveUrl || '', businessAreas: [], gaps: [],
            focusAreas: [], relevantPatterns: [], siteTextLength: 0, siteTextExcerpt: '', analysisMode: 'timeout',
          }), 60000)),
        ]);
    if (siteResolution) {
      analysis.resolvedFromCompanyName = !hadInputUrl && siteResolution.method !== 'form-url-origin';
      analysis.siteResolutionMethod = siteResolution.method || '';
      analysis.siteResolutionProvider = siteResolution.provider || '';
      analysis.siteResolutionQuery = siteResolution.query || '';
      analysis.siteResolutionConfidence = siteResolution.confidence || 0;
      analysis.siteResolutionTitle = siteResolution.title || '';
      analysis.siteResolutionError = siteResolution.error || analysis.siteResolutionError || '';
    }
    if (effectiveUrl && !analysis.companyUrl) analysis.companyUrl = effectiveUrl;
    actionLogger.logAction(no, companyName, 'site_analysis', JSON.stringify(analysis));
    log(`[No.${no}] ${companyName}: サイト分析完了 (${analysis.businessAreas.length}領域検出, ${analysis.gaps.length}ギャップ)`, 'step');

    // Step 1.2: LLM 解析 (Phase A-1, feature flag で制御)
    // useLLMAnalyzer=true の時のみ CLI を呼ぶ。失敗時は従来のキーワード辞書結果を使う。
    try {
      const settingsForLLM = require('./settings-manager');
      const ic = settingsForLLM.getIdealCustomer();
      if (ic.useLLMAnalyzer && analysis.siteTextLength >= 200) {
        const llmAnalyzer = require('./llm-site-analyzer');
        const provider = process.env.SALES_CLAW_AI_PROVIDER || settingsForLLM.getAiProvider() || 'claude';
        const executablePath: any = await resolveCliExecutable(provider);
        if (executablePath) {
          thinking(`[No.${no}] ${companyName}: ${provider} CLI 起動中... (${executablePath.split(/[\\/]/).pop()})`);
          // Phase A は Haiku ($1/MTok input) を使い、Programmatic Credit 枠の消費を Sonnet 比 1/10 に抑える。
          // 設定で上書き可: preferences.aiModelsByPhase['site-analysis'][provider]
          const phaseModel = typeof settingsForLLM.getAiModelForPhase === 'function'
            ? settingsForLLM.getAiModelForPhase('site-analysis', provider)
            : '';
          const providerHomeDir = resolveProviderHomeDir(provider);
          const llmStartedAt = Date.now();
          const llmResult: any = await llmAnalyzer.analyzeSiteWithCli({
            rawText: analysis.siteTextExcerpt + '\n' + (analysis.metaDescription || ''),
            companyName,
            companyType: companyType || '',
            idealCustomer: ic,
            providerId: provider,
            executablePath,
            timeoutMs: 120000,
            model: phaseModel,
            providerHomeDir,
          });
          const llmElapsedSec = Math.round((Date.now() - llmStartedAt) / 1000);
          if (llmResult.ok) {
            analysis.llm = {
              industry: llmResult.industry,
              mainOfferings: llmResult.mainOfferings,
              targetClients: llmResult.targetClients,
              internalCapabilities: llmResult.internalCapabilities,
              evidenceQuotes: llmResult.evidenceQuotes,
              confidence: llmResult.confidence,
              fitVerdict: llmResult.fitVerdict,
              fitReason: llmResult.fitReason,
              elapsedMs: llmResult.elapsedMs,
              providerUsed: provider,
            };
            log(`[No.${no}] ${companyName}: LLM 解析完了 (${llmResult.industry.primary} > ${llmResult.industry.sub_category} / verdict=${llmResult.fitVerdict} / conf=${llmResult.confidence.toFixed(2)} / ${llmResult.elapsedMs}ms)`, 'step');
            // H4 mitigation: LLM verdict=skip でも sendability-gate を飛ばさず通過させる。
            // gate の no_sales_block / competitor / dealBreaker などはルールベースで
            // 独立した判定のため、LLM 判定と合わせて failures を記録する方が UI で
            // 「skip された理由」が明確になる。flag だけ立てて gate 後に判定する。
            analysis.llmRequestedSkip = (llmResult.fitVerdict === 'skip');
          } else {
            log(`[No.${no}] ${companyName}: LLM 解析失敗 (${llmResult.error} / ${llmElapsedSec}秒) → キーワード辞書フォールバック`, 'warn');
            log(`[No.${no}] ${companyName}: ヒント: Claude Pro レート上限の可能性。並列度を 1 に下げるか SALES_CLAW_PHASE_A_CONCURRENCY=1 で再起動してください`, 'warn');
          }
        } else {
          log(`[No.${no}] ${companyName}: ${provider} CLI が見つからず LLM 解析スキップ (PATH を確認してください)`, 'warn');
        }
      }
    } catch (e) {
      log(`[No.${no}] ${companyName}: LLM 解析でエラー (${e && e.message || e}) → 続行`, 'warn');
    }

    let resolvedFormUrl = formUrl || '';
    let formResolutionMethod = resolvedFormUrl ? 'preset' : 'none';
    // 初期値は 'unknown' としておき、下流で null チェック漏れが起きないようにする
    let resolvedFormType = resolvedFormUrl ? 'contact_form' : 'unknown';
    if (!resolvedFormUrl && effectiveUrl) {
      thinking(`[No.${no}] ${companyName}: フォームURL探索中`);
      updateLiveMonitor(no, {
        companyNo: no,
        companyName,
        status: 'analyzing',
        step: 'フォームURL探索中',
        currentUrl: effectiveUrl || '',
      });
      const resolved: any = await resolveContactFormUrl(effectiveUrl);
      if (resolved && resolved.found && resolved.formUrl) {
        formResolutionMethod = resolved.method || 'resolved';
        resolvedFormType = resolved.formType || 'contact_form';
        // 発見したページに <form> が存在しない場合（メール/電話のみ）は formUrl を採用しない
        // → 下流の email_only/phone_only 分岐で skipped になる
        if (resolved.hasForm === false && (resolvedFormType === 'email_only' || resolvedFormType === 'phone_only')) {
          log(`[No.${no}] ${companyName}: 問い合わせページ発見もフォームなし (${resolvedFormType}) → skipped 対象`, 'warn');
        } else {
          resolvedFormUrl = resolved.formUrl;
          log(`[No.${no}] ${companyName}: フォームURL解決 ${resolvedFormUrl}`, 'step');
        }
      } else {
        formResolutionMethod = resolved && resolved.reason ? resolved.reason : 'unresolved';
        resolvedFormType = (resolved && resolved.formType) || 'not_found';
        log(`[No.${no}] ${companyName}: フォームURL未解決 (${formResolutionMethod}, type=${resolvedFormType})`, 'warn');
      }
    }

    if (resolvedFormUrl) {
      analysis.resolvedFormUrl = resolvedFormUrl;
      analysis.formResolutionMethod = formResolutionMethod;
      analysis.formType = resolvedFormType;
    } else if (resolvedFormType) {
      analysis.formType = resolvedFormType;
    }

    // formType に応じた早期リターン分岐:
    //   email_only → skipped (メールのみ = フォームなし)
    //   phone_only → skipped (電話のみ = フォームなし)
    //   not_found  → 従来の error 経路を維持（下流でメッセージ生成失敗時に拾う）
    if (!resolvedFormUrl && (resolvedFormType === 'email_only' || resolvedFormType === 'phone_only')) {
      const skipReason = resolvedFormType === 'email_only'
        ? 'メール問い合わせのみ: フォームなし'
        : '電話問い合わせのみ: フォームなし';
      log(`[No.${no}] ${companyName}: ${skipReason}`, 'warn');
      actionLogger.logAction(no, companyName, 'skipped', skipReason);
      updateLiveMonitor(no, {
        companyNo: no,
        companyName,
        status: 'skipped',
        step: skipReason,
      });
      const result = { ok: false, no, companyName, skipped: true, reason: skipReason, formType: resolvedFormType };
      process.stdout.write(JSON.stringify(result) + '\n');
      process.exit(0);
    }

    // Step 1.5: Sendability Gate (Phase 0)
    // 「サイトを読まずに / 不適合先に / 営業お断りなのに 送信してしまう」
    // 構造的な事故を止めるための事前ゲート。LLM 不要、純粋ルール判定。
    // 7 項目のうち fatal/skip があれば skipped/error で早期リターンする。
    const sendabilityGate = require('./sendability-gate');
    const settingsForGate = require('./settings-manager');
    let idealCustomer: any = null;
    let protectedGroups: any[] = [];
    try { idealCustomer = settingsForGate.getIdealCustomer(); } catch (_) { /* settings unavailable → safe defaults */ }
    try { protectedGroups = settingsForGate.getProtectedGroups ? settingsForGate.getProtectedGroups() : []; } catch (_) {}
    // analysis に notes を補完 (target list の備考欄を gate に渡す)
    if (company && company.notes && !analysis.notes) analysis.notes = company.notes;
    const gateResult = sendabilityGate.evaluate({ analysis, idealCustomer, protectedGroups });
    if (!gateResult.ok) {
      const urlMissingSkip = isUrlMissingGateSkip(analysis, gateResult);

      if (urlMissingSkip) {
        // URL未設定で Phase A のサイト解決に失敗 → Phase B (CLI) に WebSearch 探索を委ねる。
        // skipped で終わらせずに続行する。analysis.urlMissing=true マーカーが Phase B
        // プロンプトに渡り、CLI が WebSearch で公式サイトを特定してから入力する。
        log(`[No.${no}] ${companyName}: URL未設定 — Phase B (CLI) に公式サイト探索を委ねます`, 'warn');
        updateLiveMonitor(no, {
          companyNo: no,
          companyName,
          status: 'analyzing',
          step: 'Phase B: CLI が公式サイト探索中',
        });
        // 後続のメッセージ生成では urlMissing=true でプレースホルダーが生成される
      } else {
        const action = gateResult.action;
        const reason = gateResult.reason || 'sendability gate failed';
        log(`[No.${no}] ${companyName}: sendability gate ${action} → ${reason}`, action === 'skip' ? 'warn' : 'error');
        actionLogger.logAction(no, companyName, action === 'skip' ? 'skipped' : 'error', reason);
        updateLiveMonitor(no, {
          companyNo: no,
          companyName,
          status: action === 'skip' ? 'skipped' : 'error',
          step: action === 'skip' ? 'ゲート判定: 営業対象外' : 'ゲート判定: 取得失敗',
        });
        const result = {
          ok: false,
          no,
          companyName,
          skipped: action === 'skip',
          reason,
          gateFailures: gateResult.failures,
        };
        process.stdout.write(JSON.stringify(result) + '\n');
        process.exit(0);
      }
    }
    // gate に warn/info があれば log するが、送信は続行
    if (Array.isArray(gateResult.failures) && gateResult.failures.length > 0) {
      log(`[No.${no}] ${companyName}: gate warnings: ${gateResult.reason}`, 'warn');
    }

    // H4 mitigation: LLM が skip 判定していた場合、sendability-gate も
    // 通過確認 (warn 以下なら通過済) してから skipped として記録する。
    // gate 警告も理由に含めることで UI に「LLM 判定 + ルール判定」両方が出る。
    if (analysis.llmRequestedSkip) {
      const llmReason = (analysis.llm && analysis.llm.fitReason) || '理由不明';
      const gateMsg = Array.isArray(gateResult.failures) && gateResult.failures.length > 0
        ? ` / gate: ${gateResult.reason}`
        : '';
      const reason = `LLM フィット判定: skip — ${llmReason}${gateMsg}`;
      log(`[No.${no}] ${companyName}: ${reason}`, 'warn');
      actionLogger.logAction(no, companyName, 'skipped', reason);
      updateLiveMonitor(no, {
        companyNo: no,
        companyName,
        status: 'skipped',
        step: 'LLM 判定: 営業対象外',
      });
      const result = {
        ok: false,
        no,
        companyName,
        skipped: true,
        reason,
        llm: analysis.llm,
        gateFailures: gateResult.failures || [],
        skipKind: 'llm_fit_skip',
      };
      process.stdout.write(JSON.stringify(result) + '\n');
      process.exit(0);
    }

    // Step 2: メッセージ生成
    thinking(`[No.${no}] ${companyName}: メッセージ生成中`);
    updateLiveMonitor(no, {
      companyNo: no,
      companyName,
      status: 'drafting',
      step: 'メッセージ生成中',
    });

    // Phase 3: テンプレ fallback の locale 解決 (LLM 経路と同じロジック)
    let templateLocale: 'ja' | 'en' = 'ja';
    try {
      const settingsForTemplateLocale = require('./settings-manager');
      const messageTemplatesForLocale = (typeof settingsForTemplateLocale.getSection === 'function'
        ? settingsForTemplateLocale.getSection('messageTemplates')
        : null) || {};
      const langOverride = messageTemplatesForLocale.language;
      if (langOverride === 'ja' || langOverride === 'en') {
        templateLocale = langOverride;
      } else {
        const det = analysis && analysis.detectedLanguage;
        if (det && (det.language === 'en' || det.language === 'ja') && (det.confidence || 0) >= 0.5) {
          templateLocale = det.language;
        }
      }
    } catch (_) { /* templateLocale は ja のまま */ }

    const templateDraft = messageBuilder.buildCustomMessage(analysis, templateLocale);
    const { prompt: messagePrompt } = messageBuilder.buildMessagePrompt(analysis);

    // Step 2.5: LLM メッセージ生成 (Phase B, feature flag で制御)
    // useLLMMessageGenerator=true の時、CLI で本文を生成し、品質ゲート 8 項目で
    // 検証する。pass したら採用、reject なら template にフォールバック。
    let finalDraft = templateDraft;
    let qualityCheckResult: any = null;
    let llmMessageMeta: any = null;
    try {
      const settingsForB = require('./settings-manager');
      const ic = settingsForB.getIdealCustomer();
      // useLLMMessageGenerator は idealCustomer 配下に置く (analyzer と一緒)
      const valueProps = settingsForB.getSection('valuePropositions');
      const useLLMGen = !!(valueProps.useLLMMessageGenerator || (ic && ic.useLLMMessageGenerator));
      if (useLLMGen && analysis && analysis.siteTextLength >= 200) {
        const llmGen = require('./llm-message-generator');
        const messageQualityGate = require('./message-quality-gate');
        const provider = process.env.SALES_CLAW_AI_PROVIDER || settingsForB.getAiProvider() || 'claude';
        const executablePath: any = await resolveCliExecutable(provider);
        if (executablePath) {
          thinking(`[No.${no}] ${companyName}: LLM メッセージ生成中 (${provider})`);
          updateLiveMonitor(no, {
            companyNo: no,
            companyName,
            status: 'drafting',
            step: `LLM メッセージ生成中 (${provider})`,
          });
          const sender = settingsForB.getSender();
          const strengths = settingsForB.getStrengths();
          const styleConfig = (settingsForB.getMessageStyle && settingsForB.getMessageStyle()) || {};
          const ownContext = {
            ...sender,
            strengths,
          };
          const targetProfile = {
            companyName,
            companyType: companyType || '',
            siteTextExcerpt: analysis.siteTextExcerpt,
            ...(analysis.llm || {}),
          };
          // Phase B はメッセージ文章品質が重要なので Sonnet を既定にする。
          // 設定で上書き可: preferences.aiModelsByPhase['message-generation'][provider]
          const phaseModel = typeof settingsForB.getAiModelForPhase === 'function'
            ? settingsForB.getAiModelForPhase('message-generation', provider)
            : '';
          const providerHomeDir = resolveProviderHomeDir(provider);
          // Phase 3: locale 解決
          // - messageTemplates.language === 'ja' | 'en' なら明示固定
          // - 'auto' (default) なら analysis.detectedLanguage を採用 (confidence>=0.5)
          // - それ以外は 'ja' に倒す (既存ユーザー互換)
          const messageTemplatesForLocale = (typeof settingsForB.getSection === 'function'
            ? settingsForB.getSection('messageTemplates')
            : null) || {};
          const langOverride = messageTemplatesForLocale.language;
          let resolvedLocale: 'ja' | 'en' = 'ja';
          if (langOverride === 'ja' || langOverride === 'en') {
            resolvedLocale = langOverride;
          } else {
            const det = analysis && analysis.detectedLanguage;
            if (det && (det.language === 'en' || det.language === 'ja') && (det.confidence || 0) >= 0.5) {
              resolvedLocale = det.language;
            }
          }
          const llmGenResult: any = await llmGen.generateMessageWithCli({
            targetProfile,
            ownContext,
            idealCustomer: ic,
            style: styleConfig,
            providerId: provider,
            executablePath,
            timeoutMs: 60000,
            model: phaseModel,
            providerHomeDir,
            locale: resolvedLocale,
          });
          if (llmGenResult.ok) {
            llmMessageMeta = {
              elapsedMs: llmGenResult.elapsedMs,
              providerUsed: provider,
              charCount: llmGenResult.message.length,
            };
            log(`[No.${no}] ${companyName}: LLM メッセージ生成完了 (${llmGenResult.message.length}字, ${llmGenResult.elapsedMs}ms)`, 'step');
            // 8 項目品質ゲート
            qualityCheckResult = messageQualityGate.evaluate({
              message: llmGenResult.message,
              targetProfile,
              ownContext,
              idealCustomer: ic,
              style: styleConfig,
              protectedPartners: Array.isArray(valueProps.protectedPartners) ? valueProps.protectedPartners : [],
            });
            if (qualityCheckResult.ok) {
              finalDraft = llmGenResult.message;
              if (qualityCheckResult.failures && qualityCheckResult.failures.length > 0) {
                log(`[No.${no}] ${companyName}: 品質ゲート warn: ${qualityCheckResult.reason}`, 'warn');
              } else {
                log(`[No.${no}] ${companyName}: 品質ゲート 全項目 pass`, 'step');
              }
            } else {
              log(`[No.${no}] ${companyName}: 品質ゲート reject (${qualityCheckResult.reason}) → テンプレ fallback`, 'warn');
            }
          } else {
            log(`[No.${no}] ${companyName}: LLM メッセージ生成失敗 (${llmGenResult.error}) → テンプレ fallback`, 'warn');
          }
        }
      }
    } catch (e) {
      log(`[No.${no}] ${companyName}: LLM メッセージ生成でエラー (${e && e.message || e}) → テンプレ fallback`, 'warn');
    }

    const MIN_MESSAGE_LENGTH = 50;
    if (finalDraft.trim().length < MIN_MESSAGE_LENGTH) {
      const warnMsg = `メッセージが短すぎます (${finalDraft.trim().length}文字 < ${MIN_MESSAGE_LENGTH}文字)。設定の会社プロフィール・提供価値を確認してください`;
      log(`[No.${no}] ${companyName}: ${warnMsg}`, 'warn');
      actionLogger.logAction(no, companyName, 'error', warnMsg);
      updateLiveMonitor(no, {
        companyNo: no,
        companyName,
        status: 'error',
        step: 'メッセージ生成エラー: 文字数不足',
      });
      const result = { ok: false, no, companyName, error: warnMsg };
      process.stdout.write(JSON.stringify(result) + '\n');
      process.exit(0);
    }

    // Step 2.6: Post-generation Quality Gate (LLM / テンプレ共通)
    // 旧実装は LLM 生成時だけ品質ゲートを通していたため、テンプレ fallback や
    // 通常テンプレ生成の本文には P5 (設定値矛盾チェック) が掛からなかった。
    // ここで最終採用本文を必ず検証し、fatal があれば message_draft に進ませない。
    try {
      const settingsForFinalGate = require('./settings-manager');
      const messageQualityGate = require('./message-quality-gate');
      const ic = settingsForFinalGate.getIdealCustomer();
      const valueProps = settingsForFinalGate.getSection('valuePropositions') || {};
      const profile = settingsForFinalGate.getSection('companyProfile') || {};
      const sender = settingsForFinalGate.getSender();
      const templates = settingsForFinalGate.getSection('messageTemplates') || {};
      const styleConfig = {
        ...((settingsForFinalGate.getMessageStyle && settingsForFinalGate.getMessageStyle()) || {}),
        cta: templates.cta || '',
        signatureTemplate: templates.signatureTemplate || '',
      };
      const ownContext = {
        ...sender,
        contactName: sender.name || profile.contactName || '',
        companyName: sender.companyName || profile.companyName || '',
        companyProfile: profile,
      };
      const targetProfile = {
        companyName,
        companyType: companyType || '',
        siteTextExcerpt: analysis.siteTextExcerpt || '',
        ...(analysis.llm || {}),
      };
      const finalQualityCheck = messageQualityGate.evaluate({
        message: finalDraft,
        targetProfile,
        ownContext,
        idealCustomer: ic,
        style: styleConfig,
        protectedPartners: Array.isArray(valueProps.protectedPartners) ? valueProps.protectedPartners : [],
      });
      qualityCheckResult = finalQualityCheck;
      if (!finalQualityCheck.ok) {
        const reason = `メッセージ品質ゲート reject: ${finalQualityCheck.reason}`;
        log(`[No.${no}] ${companyName}: ${reason}`, 'error');
        actionLogger.logAction(no, companyName, 'error', reason);
        updateLiveMonitor(no, {
          companyNo: no,
          companyName,
          status: 'error',
          step: 'メッセージ品質ゲートで停止',
        });
        const result = {
          ok: false,
          no,
          companyName,
          error: reason,
          qualityCheckResult: finalQualityCheck,
          skipKind: 'message_quality_reject',
        };
        process.stdout.write(JSON.stringify(result) + '\n');
        process.exit(0);
      }
      if (Array.isArray(finalQualityCheck.failures) && finalQualityCheck.failures.length > 0) {
        log(`[No.${no}] ${companyName}: 最終品質ゲート warn: ${finalQualityCheck.reason}`, 'warn');
      }
    } catch (e) {
      const reason = `メッセージ品質ゲート実行エラー: ${e && e.message || e}`;
      log(`[No.${no}] ${companyName}: ${reason}`, 'error');
      actionLogger.logAction(no, companyName, 'error', reason);
      updateLiveMonitor(no, {
        companyNo: no,
        companyName,
        status: 'error',
        step: 'メッセージ品質ゲート実行エラー',
      });
      const result = { ok: false, no, companyName, error: reason, skipKind: 'message_quality_gate_error' };
      process.stdout.write(JSON.stringify(result) + '\n');
      process.exit(0);
    }

    actionLogger.logAction(no, companyName, 'message_draft', finalDraft);
    log(`[No.${no}] ${companyName}: プロンプト+メッセージ生成完了 (${finalDraft.length}文字、${llmMessageMeta ? 'LLM' : 'template'})`, 'step');

    // Step 3: 分析完了
    updateLiveMonitor(no, {
      companyNo: no,
      companyName,
      status: 'draft_ready',
      step: '分析+メッセージ完了（フォーム入力待ち）',
    });

    const result = {
      ok: true,
      no,
      companyName,
      analysis,
      // Phase B: LLM 生成があればそれを採用、なければ templateDraft
      message: finalDraft,
      messagePrompt,
      templateDraft,            // テンプレ版も常に保持 (UI で比較可能)
      llmMessageMeta,           // LLM 生成のメタ (provider, elapsed, charCount)
      qualityCheckResult,       // 8 項目品質ゲート結果 (failures 含む)
      gateWarnings: gateResult.failures || [],
      formUrl: resolvedFormUrl || formUrl || '',
      formResolutionMethod,
      siteUrl: effectiveUrl || url || '',
    };
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exit(0);
  } catch (e) {
    log(`[No.${no}] ${companyName}: 分析エラー — ${e.message}`, 'error');
    updateLiveMonitor(no, {
      companyNo: no,
      companyName,
      status: 'error',
      step: '分析エラー: ' + e.message,
    });
    const result = { ok: false, no, companyName, error: e.message };
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exit(0);
  }
}

if (require.main === module) {
  main();
}

module.exports = { analyzeCompanyLite, isUrlMissingGateSkip };

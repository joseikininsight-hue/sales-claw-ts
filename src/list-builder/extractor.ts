'use strict';

// Extractor — 公開 Web ページから HTML を取得し、コンプライアンスチェックする
//
// 要件§3 Stage 2:
//   - Playwright/cheerio で公開ページを取得
//   - CAPTCHA / 403 / 429 / login 検出時は停止
//   - 個人情報フィールドはデフォルトで取得しない (compliance-precheck と連携)
//
// 入力: { url, options?: { fetcherKind, timeoutMs, ... } }
// 出力: {
//   ok, html, statusCode, headers, finalUrl,
//   blocked, blockReason?, riskFlags[], formType, formUrl?
// }
//
// 設計:
//   - HTTP fetcher は SSRF 対策付き (target-list-validator 既存パターン流用)
//   - Playwright 統合は Phase 7 のオーケストレータが任意で fetcher を差し替える
//   - 純粋関数として opts.fetcher を受け取れる (テスト用 DI)

const { URL } = require('url');

const compliancePrecheck = require('./compliance-precheck');
const urlNormalizer = require('./url-normalizer');
const httpClient = require('./official-clients/http-client');
const scraplingClient = require('./scrapling-client');
const settings = require('../settings-manager');

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024; // 2MB
const DEFAULT_MAX_ROBOTS_BYTES = 256 * 1024;
const DEFAULT_USER_AGENT = 'SalesClaw/1.0 ListBuilder';

// 公開 Web へのアクセスは ALLOW LIST が無いため、http-client.request を直接使うのではなく
// 専用の defaultHttpFetch を提供する。SSRF 対策 (private host チェック + DNS lookup) は
// http-client.cjs の関数を再利用し、二重実装を避ける。
const isPrivateHost = httpClient.isPrivateHost;
const isPrivateAddress = httpClient.isPrivateAddress;

// HTTP GET で HTML を取得（SSRF対策・タイムアウト・リダイレクト追従）
//
// 公開 Web 全体が対象なので allow-list ベースの http-client.request は使えず、
// 別途 http/https モジュールで実装する。ただし SSRF 検査だけは httpClient と同じ
// ロジック (isPrivateHost) を共有する。
function defaultHttpFetch(targetUrl, opts: Record<string, any> = {}) {
  const http = require('http');
  const https = require('https');
  const dns = require('dns');
  // private IP に解決するホストを DNS レイヤで弾く
  const publicLookup = (hostname, options, callback) => {
    dns.lookup(hostname, options, (err, address, family) => {
      if (err) return callback(err);
      if (isPrivateAddress(address)) {
        const blocked: any = new Error('private address blocked');
        blocked.code = 'EPRIVATEADDR';
        return callback(blocked);
      }
      callback(null, address, family);
    });
  };

  return new Promise<any>((resolve) => {
    let parsed;
    try { parsed = new URL(targetUrl); }
    catch { return resolve({ ok: false, error: 'invalid URL' }); }
    if (!/^https?:$/.test(parsed.protocol)) {
      return resolve({ ok: false, error: 'unsupported scheme' });
    }
    if (isPrivateHost(parsed.hostname)) {
      return resolve({ ok: false, error: 'private host blocked', blocked: true });
    }
    const redirectDepth = Number(opts.redirectDepth) || 0;
    const maxRedirects = opts.maxRedirects ?? 3;
    if (redirectDepth > maxRedirects) {
      return resolve({ ok: false, error: 'too many redirects' });
    }

    const lib = parsed.protocol === 'https:' ? https : http;
    let aborted = false;
    let settled = false;
    let body = '';
    let req: any = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      aborted = true;
      try { req && req.destroy(); } catch (_) {}
      finish({ ok: false, error: 'timeout' });
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    req = lib.get(parsed, {
      headers: {
        'User-Agent': opts.userAgent || DEFAULT_USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'ja,en;q=0.5',
      },
      lookup: publicLookup,
    }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        settled = true;
        clearTimeout(timer);
        try { req.destroy(); } catch (_) {}
        const next = new URL(res.headers.location, targetUrl).toString();
        return resolve(defaultHttpFetch(next, { ...opts, redirectDepth: redirectDepth + 1 }));
      }
      const maxBody = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
      res.setEncoding('utf-8');
      res.on('data', (chunk) => {
        if (aborted || settled) return;
        body += chunk;
        if (body.length > maxBody) {
          aborted = true;
          try { req.destroy(); } catch (_) {}
          finish({
            ok: status < 400,
            html: body.slice(0, maxBody),
            statusCode: status,
            headers: res.headers,
            finalUrl: targetUrl,
            truncated: true,
          });
        }
      });
      res.on('end', () => {
        if (aborted) return;
        finish({
          ok: status < 400,
          html: body,
          statusCode: status,
          headers: res.headers,
          finalUrl: targetUrl,
        });
      });
    });
    req.on('error', (e) => {
      if (!settled) finish({ ok: false, error: e.message, code: e.code });
    });
  });
}

// メイン: 1 つの URL を取得 + コンプライアンスチェック
//
// 戻り値:
//   {
//     ok: boolean,
//     html?: string,
//     statusCode?: number,
//     finalUrl?: string,
//     blocked: boolean,
//     blockReason?: string,
//     riskFlags: string[],
//     formType: FormType,
//     error?: string
//   }
async function extract(url, opts: Record<string, any> = {}) {
  const fetcher = opts.fetcher || defaultHttpFetch;
  const lbConfig = settings.getListBuilderConfig?.() || {};
  const respectRobotsTxt = opts.respectRobotsTxt !== undefined
    ? opts.respectRobotsTxt !== false
    : lbConfig.respectRobotsTxt !== false;
  if (respectRobotsTxt && !opts.skipRobots) {
    const robots: any = await checkRobotsAllowed(url, fetcher, opts);
    if (!robots.allowed) {
      return {
        ok: false,
        error: robots.reason || 'robots.txt disallowed',
        blocked: true,
        blockReason: 'robots_disallowed',
        riskFlags: ['robots_disallowed'],
        formType: 'unknown',
      };
    }
  }

  // ---- Scrapling 補助フェッチャ ----
  // settings.listBuilder.scraplingMcpEnabled=true かつ Scrapling が利用可能な場合、
  // 通常 fetcher ではなく Scrapling 経由で取得を試みる。失敗時は通常 fetcher にフォールバック。
  // テスト時は opts.fetcher が指定されているのでスキップ (DI 優先)。
  // Scrapling が止めるべき検出 (CAPTCHA/403/429/login) を返した場合はそのまま伝搬。
  let result;
  if (!opts.fetcher && !opts.skipScrapling && scraplingClient.isEnabled()) {
    const available: any = await scraplingClient.isAvailable().catch(() => false);
    if (available) {
      const scResult: any = await scraplingClient.fetchPage(url, {
        mode: opts.scraplingMode || 'stealthy',
        timeoutMs: opts.timeoutMs || DEFAULT_TIMEOUT_MS,
      }).catch((e) => ({ ok: false, error: e && e.message }));
      if (scResult && scResult.ok && typeof scResult.html === 'string') {
        result = {
          ok: true,
          html: scResult.html,
          statusCode: scResult.statusCode || 200,
          finalUrl: scResult.finalUrl || url,
          truncated: !!scResult.truncated,
          fetcherKind: 'scrapling',
        };
      } else if (scResult && scResult.blocked) {
        // Scrapling 自身が "ブロックされた" と判定した場合は通常 fetcher も同じ
        // 結果になる可能性が高いので、フォールバックせず即終了する。
        return {
          ok: false,
          error: scResult.error || 'access blocked (scrapling)',
          blocked: true,
          blockReason: scResult.blockReason || 'access_blocked',
          riskFlags: ['access_blocked'],
          formType: 'unknown',
          fetcherKind: 'scrapling',
        };
      }
      // 上記以外の失敗 (TIMEOUT / SPAWN_FAILED / SCRAPLING_NOT_INSTALLED 等) は
      // result を設定せず、下の defaultHttpFetch にフォールバックする。
    }
  }

  if (!result) {
    result = await fetcher(url, opts);
  }

  // フェッチ自体が失敗 (SSRF, timeout, network error)
  if (!result || (!result.ok && !result.statusCode)) {
    return {
      ok: false,
      error: result?.error || 'fetch failed',
      blocked: !!result?.blocked,
      blockReason: result?.blocked ? 'fetch_blocked' : undefined,
      riskFlags: result?.blocked ? ['ssrf_blocked'] : [],
      formType: 'unknown',
    };
  }

  // コンプライアンス分析
  const analysis = compliancePrecheck.analyze({
    html: result.html || '',
    statusCode: result.statusCode || 0,
    headers: result.headers,
  });

  return {
    ok: result.ok,
    html: result.html || '',
    statusCode: result.statusCode,
    finalUrl: result.finalUrl,
    headers: result.headers,
    truncated: !!result.truncated,
    blocked: analysis.blocked,
    blockReason: analysis.blockReason,
    riskFlags: analysis.riskFlags,
    formType: analysis.formType,
    fetcherKind: result.fetcherKind || 'http',
  };
}

async function checkRobotsAllowed(url, fetcher, opts: Record<string, any> = {}) {
  let robotsUrl;
  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) {
      return { allowed: false, reason: 'invalid URL' };
    }
    robotsUrl = `${parsed.protocol}//${parsed.host}/robots.txt`;
  } catch (_) {
    return { allowed: false, reason: 'invalid URL' };
  }

  try {
    const result: any = await fetcher(robotsUrl, {
      ...opts,
      skipRobots: true,
      maxRedirects: 1,
      maxBodyBytes: Math.min(opts.maxBodyBytes || DEFAULT_MAX_ROBOTS_BYTES, DEFAULT_MAX_ROBOTS_BYTES),
      timeoutMs: Math.min(opts.timeoutMs || DEFAULT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    });
    if (!result || result.statusCode !== 200 || !result.html) {
      return { allowed: true, reason: 'robots unavailable' };
    }
    const robots = compliancePrecheck.parseRobotsTxt(result.html);
    return compliancePrecheck.isPathAllowed(url, robots);
  } catch (_) {
    return { allowed: true, reason: 'robots check failed open' };
  }
}

// HTML から問い合わせフォーム URL を探索（form-finder 簡易版）
//
// 一般的な contact パスを試す前に、HTML 内の <a> リンクから「お問い合わせ/contact」
// 関連リンクを抽出する。
const CONTACT_LINK_PATTERNS = [
  /お問い?合わ?せ/, /お問合せ/,
  /contact(?:\s*us)?/i, /inquiry/i, /問い?合わ?せ/,
  /資料請求/, /リクエスト/, /パートナー/,
];

function findContactLinks(html, baseUrl) {
  if (!html) return [];
  const found: any[] = [];
  const seen = new Set<any>();
  const anchorRegex = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]{0,200}?)<\/a>/gi;
  let m;
  while ((m = anchorRegex.exec(html)) !== null) {
    const href = m[1];
    const text = m[2].replace(/<[^>]+>/g, ' ').trim();
    const matchesText = CONTACT_LINK_PATTERNS.some((p: any) => p.test(text));
    // 'contact-form' / 'inquiry-form' / 'contact_form' 等もマッチさせる
    const matchesHref = /\b(?:contact|inquiry|toiawase|otoiawase)(?:[-_]?form)?\b/i.test(href);
    if (!matchesText && !matchesHref) continue;
    try {
      const u = new URL(href, baseUrl).toString();
      const norm = urlNormalizer.normalize(u).normalized;
      if (!seen.has(norm)) {
        seen.add(norm);
        found.push({ url: norm, text, matchedBy: matchesText ? 'text' : 'href' });
      }
    } catch (_) {}
  }
  return found;
}

module.exports = {
  extract,
  checkRobotsAllowed,
  defaultHttpFetch,
  findContactLinks,
  isPrivateHost,
  isPrivateAddress,
  // テスト用定数
  CONTACT_LINK_PATTERNS,
};

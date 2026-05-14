'use strict';

/**
 * Target list data quality validator (P1-1)。
 *
 * インポート済みターゲットリストの formUrl / url が「その会社のページ」か
 * を軽量チェックする。
 *
 * チェック項目:
 *   1. URL が http(s) スキーム
 *   2. fetch 可能 (HEAD or GET。タイムアウト 6 秒)
 *   3. HTML の <title>, og:site_name, <h1>, body text に会社名が出現する
 *      もしくは domain 名と会社名英語表記の strong overlap がある
 *   4. formUrl の場合は <form> 要素の有無もチェック
 *
 * 重い場合があるので並列度 4 で limited concurrency。
 */

const http = require('http');
const https = require('https');
const dns = require('dns');
const net = require('net');
const { URL } = require('url');

const FETCH_TIMEOUT_MS = 6000;
const CONCURRENCY = 4;
const MAX_BODY_BYTES = 200_000;

// SSRF prevention: block private/loopback hosts
const PRIVATE_PATTERNS = [
  /^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./, /^0\./, /^::1$/, /^fe80:/, /^fc00:/, /^fd[0-9a-f]{2}:/, /^localhost$/i,
];
function isPrivateHost(hostname) {
  if (!hostname) return true;
  const normalized = String(hostname).replace(/^\[|\]$/g, '').toLowerCase();
  return PRIVATE_PATTERNS.some((re: any) => re.test(normalized));
}

function isPrivateAddress(address) {
  if (!address) return true;
  let normalized = String(address).replace(/^\[|\]$/g, '').toLowerCase();
  if (normalized.startsWith('::ffff:')) normalized = normalized.slice('::ffff:'.length);
  if (net.isIPv4(normalized)) return isPrivateHost(normalized);
  if (net.isIPv6(normalized)) {
    return normalized === '::1'
      || normalized.startsWith('fe80:')
      || normalized.startsWith('fc')
      || normalized.startsWith('fd');
  }
  return isPrivateHost(normalized);
}

function publicLookup(hostname, options, callback) {
  dns.lookup(hostname, options, (err, address, family) => {
    if (err) return callback(err);
    if (isPrivateAddress(address)) {
      const blocked: any = new Error('private address blocked');
      blocked.code = 'EPRIVATEADDR';
      return callback(blocked);
    }
    callback(null, address, family);
  });
}

function fetchHtml(url, options: Record<string, any> = {}) {
  return new Promise<any>((resolve) => {
    let parsed;
    try { parsed = new URL(url); }
    catch { return resolve({ ok: false, error: 'invalid URL' }); }
    if (!/^https?:$/.test(parsed.protocol)) return resolve({ ok: false, error: 'unsupported scheme' });
    if (isPrivateHost(parsed.hostname)) return resolve({ ok: false, error: 'private host blocked' });
    const redirectDepth = Number(options.redirectDepth) || 0;
    if (redirectDepth > 3) return resolve({ ok: false, error: 'too many redirects' });

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
      try { req.destroy(); } catch (_) {}
      finish({ ok: false, error: 'timeout' });
    }, FETCH_TIMEOUT_MS);

    req = lib.get(parsed, {
      headers: {
        'User-Agent': 'SalesClaw/1.0 TargetListValidator',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'ja,en;q=0.5',
      },
      lookup: publicLookup,
    }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        // 少数回だけ追従。追従先も fetchHtml 冒頭と DNS lookup で再検証する。
        settled = true;
        clearTimeout(timer);
        try { req.destroy(); } catch (_) {}
        return resolve(fetchHtml(new URL(res.headers.location, url).toString(), { redirectDepth: redirectDepth + 1 }));
      }
      if (status >= 400) {
        return finish({ ok: false, status, error: 'HTTP ' + status });
      }
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        if (aborted || settled) return;
        body += chunk;
        if (body.length > MAX_BODY_BYTES) {
          aborted = true;
          try { req.destroy(); } catch (_) {}
          finish({ ok: true, status, body: body.slice(0, MAX_BODY_BYTES), finalUrl: url, truncated: true });
        }
      });
      res.on('end', () => {
        if (aborted && body.length === 0) return;
        finish({ ok: true, status, body, finalUrl: url });
      });
    });
    req.on('error', (e) => {
      if (!settled) finish({ ok: false, error: e.message });
    });
  });
}

function extractIdentifiers(html) {
  const raw = String(html || '');
  const m = raw.toLowerCase();
  const titleMatch = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const ogSiteName = getMetaContent(raw, 'og:site_name');
  const ogTitleText = getMetaContent(raw, 'og:title');
  const h1 = raw.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const hasForm = /<form\b/i.test(raw);
  const hasMailto = /mailto:/i.test(raw);
  const hasIframe = /<iframe\b/i.test(raw);
  return {
    title: titleMatch ? stripTags(titleMatch[1]) : '',
    ogSiteName,
    ogTitle: ogTitleText,
    h1: h1 ? stripTags(h1[1]) : '',
    hasForm,
    hasMailto,
    hasIframe,
    bodyLowerSample: m.slice(0, 5000),
  };
}

function stripTags(s) {
  return decodeHtmlEntities(String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}

function getMetaContent(html, propertyName) {
  const wanted = String(propertyName || '').toLowerCase();
  const tagRe = /<meta\b[^>]*>/gi;
  let match;
  while ((match = tagRe.exec(String(html || '')))) {
    const attrs: Record<string, any> = {};
    const attrRe = /([\w:-]+)\s*=\s*(["'])(.*?)\2/g;
    let attr;
    while ((attr = attrRe.exec(match[0]))) {
      attrs[String(attr[1]).toLowerCase()] = decodeHtmlEntities(attr[3]).trim();
    }
    const key = String(attrs.property || attrs.name || '').toLowerCase();
    if (key === wanted) return attrs.content || '';
  }
  return '';
}

/**
 * 会社名が html の identifiers に「現れる」か曖昧マッチ。
 * 株式会社 / 有限会社 / 合同会社 / Inc. / Co.,Ltd 等は除去して比較。
 */
function nameMatches(companyName, identifiers, hostname) {
  if (!companyName) return false;
  const stripped = String(companyName)
    .replace(/(株式会社|有限会社|合同会社|（株）|\(株\))/g, '')
    .replace(/(Inc\.?|Co\.,?\s*Ltd\.?|Corp\.?|Ltd\.?|LLC)/gi, '')
    .replace(/\s+/g, '')
    .trim();
  if (!stripped) return false;
  const lower = stripped.toLowerCase();

  const candidates = [identifiers.title, identifiers.ogSiteName, identifiers.ogTitle, identifiers.h1, hostname || '']
    .filter(Boolean).map((s: any) => String(s).toLowerCase().replace(/\s+/g, ''));

  for (const c of candidates) {
    if (c.includes(lower)) return true;
    // 部分一致 (3文字以上)
    if (lower.length >= 3) {
      const head = lower.slice(0, Math.min(lower.length, 6));
      if (c.includes(head)) return true;
    }
  }
  // body にも 3 回以上現れていれば一致と判定
  const body = identifiers.bodyLowerSample || '';
  if (lower.length >= 3) {
    const occurrences = body.split(lower).length - 1;
    if (occurrences >= 2) return true;
  }
  return false;
}

/**
 * @param {Array<{no, name, url?, formUrl?}>} targets
 * @param {object} [options]
 * @param {function} [options.onProgress] (done, total)
 * @returns {Promise<{ checked, issues: Array<{no, name, url, type, severity, reason}> }>}
 */
async function validateTargetList(targets, options: Record<string, any> = {}) {
  const list = Array.isArray(targets) ? targets : [];
  const issues: any[] = [];
  let done = 0;

  // 1.2.92 F2: 重複 No. 検出
  // Excel/CSV 取込で同一 No. の行が 2 つ入ると、dashboard で重複キュー → 同じ会社に
  // 2 回送信または片方スキップ事故。fetch チェック前に検知して high severity で警告。
  const noCount = new Map<any, any>();
  list.forEach((t, idx) => {
    const no = t && (t.no !== undefined && t.no !== null) ? Number(t.no) : null;
    if (no !== null && Number.isFinite(no)) {
      if (!noCount.has(no)) noCount.set(no, []);
      noCount.get(no).push({ idx, name: (t && t.name) || '' });
    }
  });
  for (const [no, occurrences] of noCount.entries()) {
    if (occurrences.length > 1) {
      const names = occurrences.map((o: any) => o.name).join(' / ');
      issues.push({
        no, name: occurrences[0].name, url: '', type: 'duplicate_no', severity: 'high',
        reason: `No.${no} が ${occurrences.length} 行に重複: ${names}。同じ会社に 2 回送信される可能性があります`,
      });
    }
  }

  // limited concurrency
  let cursor = 0;
  async function worker() {
    while (cursor < list.length) {
      const i = cursor++;
      const t = list[i];
      try {
        if (!t || !t.name) {
          issues.push({ no: t && t.no, name: t && t.name || '', url: '', type: 'name', severity: 'high', reason: '会社名が空' });
          continue;
        }
        // formUrl チェック (優先)
        if (t.formUrl) {
          const r: any = await fetchHtml(t.formUrl);
          if (!r.ok) {
            issues.push({ no: t.no, name: t.name, url: t.formUrl, type: 'formUrl', severity: 'medium', reason: 'fetch 失敗: ' + (r.error || ('HTTP ' + r.status)) });
          } else {
            const ids = extractIdentifiers(r.body);
            const host = (() => { try { return new URL(t.formUrl).hostname; } catch { return ''; } })();
            const matches = nameMatches(t.name, ids, host);
            if (!matches) {
              issues.push({
                no: t.no, name: t.name, url: t.formUrl, type: 'formUrl', severity: 'high',
                reason: '会社名と URL 先 (title:"' + (ids.title || '').slice(0, 60) + '") が一致しない可能性',
              });
            }
            if (!ids.hasForm && !ids.hasMailto && !ids.hasIframe) {
              issues.push({
                no: t.no, name: t.name, url: t.formUrl, type: 'formUrl', severity: 'medium',
                reason: 'ページに <form> / mailto / iframe が無く、入力対象が無さそう',
              });
            }
          }
        }
        // url チェック (formUrl が無い場合のみ深掘り)
        if (!t.formUrl && t.url) {
          const r: any = await fetchHtml(t.url);
          if (!r.ok) {
            issues.push({ no: t.no, name: t.name, url: t.url, type: 'url', severity: 'low', reason: 'fetch 失敗: ' + (r.error || ('HTTP ' + r.status)) });
          }
        }
      } catch (e) {
        issues.push({ no: t.no, name: t.name, url: t.formUrl || t.url || '', type: 'unknown', severity: 'low', reason: 'validator error: ' + e.message });
      }
      done++;
      if (typeof options.onProgress === 'function') {
        try { options.onProgress(done, list.length); } catch (_) {}
      }
    }
  }
  const workers = Array.from({ length: Math.min(CONCURRENCY, list.length) }, () => worker());
  await Promise.all(workers);

  return {
    checked: done,
    total: list.length,
    issueCount: issues.length,
    issues: issues.sort((a: any, b: any) => {
      const score = (s) => s === 'high' ? 0 : s === 'medium' ? 1 : 2;
      return score(a.severity) - score(b.severity);
    }),
  };
}

module.exports = {
  validateTargetList,
  fetchHtml,
  extractIdentifiers,
  getMetaContent,
  isPrivateAddress,
  isPrivateHost,
  nameMatches,
};

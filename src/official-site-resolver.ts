'use strict';

const http = require('http');
const https = require('https');
const zlib = require('zlib');
const { isSafeUrl } = require('./form-url-resolver');

const FULL_CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const BLOCKED_HOST_PATTERNS = [
  /(^|\.)bing\.com$/i,
  /(^|\.)google\./i,
  /(^|\.)yahoo\./i,
  /(^|\.)wikipedia\.org$/i,
  /(^|\.)facebook\.com$/i,
  /(^|\.)linkedin\.com$/i,
  /(^|\.)x\.com$/i,
  /(^|\.)twitter\.com$/i,
  /(^|\.)instagram\.com$/i,
  /(^|\.)wantedly\.com$/i,
  /(^|\.)green-japan\.com$/i,
  /(^|\.)rikunabi\.com$/i,
  /(^|\.)mynavi\.jp$/i,
  /(^|\.)doda\.jp$/i,
  /(^|\.)openwork\.jp$/i,
  /(^|\.)indeed\.com$/i,
  /(^|\.)en-gage\.net$/i,
  /(^|\.)jobtalk\.jp$/i,
  /(^|\.)type\.jp$/i,
  /(^|\.)prtimes\.jp$/i,
  /(^|\.)minkabu\.jp$/i,
  /(^|\.)macloud\.jp$/i,
  /(^|\.)salesnow\.jp$/i,
  /(^|\.)kaisharesearch\.com$/i,
  /(^|\.)careerforum\.net$/i,
  /(^|\.)lapras\.com$/i,
  /(^|\.)nikkei\.com$/i,
  /(^|\.)baseconnect\.in$/i,
  /(^|\.)houjin\.jp$/i,
  /(^|\.)houjin-bangou\.nta\.go\.jp$/i,
  /(^|\.)gbiz\.go\.jp$/i,
  /(^|\.)initial\.inc$/i,
  /(^|\.)strainer\.jp$/i,
  /(^|\.)ullet\.com$/i,
  /(^|\.)irbank\.net$/i,
  /(^|\.)biz-maps\.com$/i,
  /(^|\.)alarmbox\.jp$/i,
  /(^|\.)buffett-code\.com$/i,
  /(^|\.)onecareer\.jp$/i,
  /(^|\.)openmoney\.jp$/i,
  /(^|\.)bizreach\.jp$/i,
  /(^|\.)careerconnection\.jp$/i,
  /(^|\.)jobcatalog\.yahoo\.co\.jp$/i,
];

function decodeHtml(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      try { return String.fromCodePoint(parseInt(hex, 16)); } catch (_) { return ''; }
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      try { return String.fromCodePoint(parseInt(dec, 10)); } catch (_) { return ''; }
    });
}

function normalizeWhitespace(value) {
  return decodeHtml(String(value || '').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeCompanyNameForSearch(companyName) {
  return normalizeWhitespace(companyName)
    .replace(/（[^）]*）/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripLegalForm(companyName) {
  return String(companyName || '')
    .replace(/^(株式会社|有限会社|合同会社|合資会社|一般社団法人|一般財団法人|公益社団法人|公益財団法人)\s*/i, '')
    .replace(/\s*(株式会社|有限会社|合同会社|合資会社|一般社団法人|一般財団法人|公益社団法人|公益財団法人)$/i, '')
    .replace(/\s*(Inc\.?|Corporation|Corp\.?|Co\.?,?\s*Ltd\.?|Ltd\.?|LLC)$/i, '')
    .trim();
}

function getCompanyNameVariants(companyName) {
  const cleaned = normalizeCompanyNameForSearch(companyName);
  const noLegal = stripLegalForm(cleaned);
  const variants = [cleaned, noLegal];

  if (/ジャパン$/.test(noLegal)) variants.push(noLegal.replace(/ジャパン$/, ''));
  if (/日本$/.test(noLegal)) variants.push(noLegal.replace(/日本$/, ''));
  if (/Japan$/i.test(noLegal)) variants.push(noLegal.replace(/\s*Japan$/i, '').trim());

  return [...new Set(variants.map((v: any) => normalizeWhitespace(v)).filter((v: any) => v.length >= 2))];
}

function buildOfficialSiteQueries(companyName) {
  const variants = getCompanyNameVariants(companyName);
  const cleaned = variants[0] || normalizeCompanyNameForSearch(companyName);
  const noLegal = variants[1] || cleaned;
  return [...new Set([
    `${cleaned} 公式`,
    `${cleaned} 会社概要`,
    `${cleaned} コーポレートサイト`,
    noLegal !== cleaned ? `${noLegal} 公式 会社` : '',
  ].filter(Boolean))].slice(0, 4);
}

function isPrivateIP(ip) {
  return /^(127\.|0\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1|fc|fd|fe80|::ffff:)/.test(String(ip || ''));
}

function safeLookup(hostname, options, callback) {
  const dns = require('dns');
  dns.lookup(hostname, options, (err, address, family) => {
    if (err) return callback(err);
    if (isPrivateIP(address)) return callback(new Error('DNS resolved to private IP: ' + address));
    callback(null, address, family);
  });
}

function decodeBody(buffer, encoding) {
  try {
    switch (String(encoding || '').toLowerCase()) {
      case 'gzip': return zlib.gunzipSync(buffer).toString('utf8');
      case 'deflate': return zlib.inflateSync(buffer).toString('utf8');
      case 'br': return zlib.brotliDecompressSync(buffer).toString('utf8');
      default: return buffer.toString('utf8');
    }
  } catch (_) {
    try { return buffer.toString('utf8'); } catch (_) { return ''; }
  }
}

function fetchText(targetUrl, options: Record<string, any> = {}, redirects = 3) {
  if (!isSafeUrl(targetUrl)) return Promise.resolve('');
  const timeoutMs = Number(options.timeoutMs) || 10000;
  const maxBytes = Number(options.maxBytes) || 500000;
  const headers = {
    'User-Agent': FULL_CHROME_UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept-Encoding': 'gzip, deflate, br',
    ...(options.headers || {}),
  };

  return new Promise<any>((resolve) => {
    if (redirects <= 0) {
      resolve('');
      return;
    }

    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value || '');
    };

    const mod = targetUrl.startsWith('https') ? https : http;
    const req = mod.get(targetUrl, { timeout: timeoutMs, lookup: safeLookup, headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = new URL(res.headers.location, targetUrl).href;
        res.resume();
        if (!isSafeUrl(next)) {
          finish('');
          return;
        }
        fetchText(next, options, redirects - 1).then(finish);
        return;
      }

      const chunks: any[] = [];
      let totalLen = 0;
      const encoding = res.headers['content-encoding'];
      res.on('data', (chunk) => {
        chunks.push(chunk);
        totalLen += chunk.length;
        if (totalLen > maxBytes) {
          req.destroy();
          finish(decodeBody(Buffer.concat(chunks), encoding));
        }
      });
      res.on('end', () => finish(decodeBody(Buffer.concat(chunks), encoding)));
      res.on('error', () => finish(''));
    });
    req.on('error', () => finish(''));
    req.on('timeout', () => {
      req.destroy();
      finish('');
    });
  });
}

function extractTag(block, tagName) {
  const re = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i');
  const match = String(block || '').match(re);
  return normalizeWhitespace(match && match[1]);
}

function parseBingRss(xml) {
  const results: any[] = [];
  const blocks = String(xml || '').match(/<item\b[\s\S]*?<\/item>/gi) || [];
  blocks.forEach((block, index) => {
    const title = extractTag(block, 'title');
    const link = decodeHtml(extractTag(block, 'link'));
    const description = extractTag(block, 'description');
    const normalizedUrl = normalizeCandidateUrl(link);
    if (!title || !normalizedUrl) return;
    results.push({
      title,
      url: normalizedUrl,
      description,
      rank: index + 1,
      source: 'bing-rss',
    });
  });
  return results;
}

async function fetchBingRss(query, options: Record<string, any> = {}) {
  const searchUrl = new URL('https://www.bing.com/search');
  searchUrl.searchParams.set('format', 'rss');
  searchUrl.searchParams.set('q', query);
  const xml: any = await fetchText(searchUrl.href, {
    timeoutMs: options.timeoutMs || 10000,
    maxBytes: 300000,
    headers: {
      'Accept': 'application/rss+xml,application/xml,text/xml;q=0.9,*/*;q=0.8',
    },
  });
  return parseBingRss(xml);
}

function normalizeCandidateUrl(rawUrl) {
  if (!rawUrl) return '';
  try {
    const url = new URL(decodeHtml(String(rawUrl).trim()));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    url.hash = '';
    if (!isSafeUrl(url.href)) return '';
    return url.href;
  } catch (_) {
    return '';
  }
}

function isBlockedCandidateUrl(rawUrl) {
  let url;
  try { url = new URL(rawUrl); } catch (_) { return true; }
  const host = url.hostname.toLowerCase();
  const pathName = `${url.pathname}${url.search}`.toLowerCase();
  if (BLOCKED_HOST_PATTERNS.some((pattern: any) => pattern.test(host))) return true;
  if (/\.pdf($|[?#])/i.test(pathName)) return true;
  if (/\/(?:db|companies|company_list|search\/corp)\b/i.test(pathName)) return true;
  if (/\/content\/\d+\/?$/i.test(pathName)) return true;
  return false;
}

function scoreOfficialCandidate(candidate, companyName) {
  const normalizedUrl = normalizeCandidateUrl(candidate && (candidate.url || candidate.link));
  if (!normalizedUrl || isBlockedCandidateUrl(normalizedUrl)) return -1000;

  const variants = getCompanyNameVariants(companyName);
  const text = normalizeWhitespace(`${candidate.title || ''} ${candidate.description || ''}`).toLowerCase();
  const title = normalizeWhitespace(candidate.title || '').toLowerCase();
  const description = normalizeWhitespace(candidate.description || '').toLowerCase();
  const url = new URL(normalizedUrl);
  const host = url.hostname.toLowerCase();
  const pathName = url.pathname.toLowerCase();

  let score = Math.max(0, 24 - (Number(candidate.rank) || 20) * 3);
  variants.forEach((variant, index) => {
    const needle = variant.toLowerCase();
    const weight = index === 0 ? 1 : 0.72;
    if (title.includes(needle)) score += Math.round(120 * weight);
    if (description.includes(needle)) score += Math.round(80 * weight);
    if (text.includes(needle)) score += Math.round(28 * weight);

    const romanish = needle.replace(/[^a-z0-9]/g, '');
    if (romanish.length >= 3 && host.replace(/[^a-z0-9]/g, '').includes(romanish)) score += 60;
  });

  if (/公式|official|コーポレートサイト|corporate site/.test(text)) score += 70;
  if (/会社概要|会社情報|企業情報|about us|about-|company/.test(text)) score += 30;
  if ((/ジャパン|日本|japan/i.test(companyName) || /日本/.test(text)) && /\/jp|japan|日本/.test(`${host}${pathName}${text}`)) {
    score += 18;
  }
  if (pathName === '/' || /^\/[a-z]{2}(?:\/[a-z]{2})?\/?$/i.test(pathName)) score += 45;
  if (/\/about|\/company|\/corp|\/profile|会社概要|企業情報/.test(`${pathName}${text}`)) score += 15;
  if (/採用|求人|recruit|career|jobs|ir|press|news/.test(pathName)) score -= 45;
  if (/\/contact|\/inquiry|\/toiawase/.test(pathName)) score -= 20;
  if (/note|blog|magazine|media|column/.test(`${host}${pathName}${title}`)) score -= 160;

  return score;
}

function extractTitle(html) {
  return extractTag(html, 'title');
}

function extractPageText(html) {
  return normalizeWhitespace(String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' '))
    .slice(0, 12000);
}

async function defaultCandidateFetcher(url) {
  const html: any = await fetchText(url, { timeoutMs: 12000, maxBytes: 700000 });
  return {
    html,
    title: extractTitle(html),
    text: extractPageText(html),
  };
}

async function verifyCandidateOfficialSite(candidate, companyName, fetcher = defaultCandidateFetcher) {
  const baseScore = scoreOfficialCandidate(candidate, companyName);
  if (baseScore < 0) {
    return { ok: false, score: baseScore, reason: 'blocked-candidate' };
  }

  let fetched: any = null;
  try {
    fetched = await fetcher(candidate.url);
  } catch (_) {
    fetched = null;
  }
  if (typeof fetched === 'string') {
    fetched = { text: extractPageText(fetched), title: extractTitle(fetched), html: fetched };
  }

  const pageTitle = normalizeWhitespace(fetched && fetched.title);
  const pageText = normalizeWhitespace(fetched && fetched.text);
  const searchEvidence = normalizeWhitespace(`${candidate.title || ''} ${candidate.description || ''}`);
  const haystack = `${searchEvidence} ${pageTitle} ${pageText}`.toLowerCase();
  const variants = getCompanyNameVariants(companyName);
  const matchedVariant = variants.find((variant: any) => variant.length >= 3 && haystack.includes(variant.toLowerCase())) || '';

  let score = baseScore;
  if (pageText.length >= 200) score += 25;
  if (matchedVariant) score += matchedVariant === variants[0] ? 90 : 75;
  if (/公式サイト|会社概要|会社情報|企業情報|お問い合わせ|contact|about us/i.test(`${pageTitle} ${pageText}`)) score += 20;

  const strongSearchEvidence = baseScore >= 185 && variants.some((variant: any) => {
    const needle = variant.toLowerCase();
    return needle.length >= 3 && searchEvidence.toLowerCase().includes(needle);
  });

  if ((matchedVariant && score >= 115) || strongSearchEvidence) {
    return {
      ok: true,
      score,
      matchedVariant,
      verifiedBy: matchedVariant ? 'page-text' : 'search-result',
      pageTextLength: pageText.length,
    };
  }

  return {
    ok: false,
    score,
    matchedVariant,
    reason: matchedVariant ? 'score-too-low' : 'company-name-not-found',
    pageTextLength: pageText.length,
  };
}

function withTimeout(promise, timeoutMs, fallbackValue) {
  return Promise.race([
    promise,
    new Promise<any>((resolve) => setTimeout(() => resolve(fallbackValue), timeoutMs)),
  ]);
}

async function resolveOfficialSiteByCompanyName(companyName, options: Record<string, any> = {}) {
  const normalizedName = normalizeCompanyNameForSearch(companyName);
  if (!normalizedName || normalizedName.length < 2) {
    return { ok: false, error: 'company-name-missing', companyName: normalizedName };
  }

  const queries = Array.isArray(options.queries) && options.queries.length > 0
    ? options.queries
    : buildOfficialSiteQueries(normalizedName);
  const searchInvoker = options.searchInvoker || fetchBingRss;
  const fetcher = options.fetcher || defaultCandidateFetcher;
  const searchTimeoutMs = Number(options.searchTimeoutMs) || 12000;
  const minCandidateScore = Number.isFinite(options.minCandidateScore) ? options.minCandidateScore : 45;

  const candidates: any[] = [];
  const seen = new Set<any>();

  for (const query of queries) {
    let results: any[] = [];
    try {
      results = await withTimeout(Promise.resolve(searchInvoker(query, options)), searchTimeoutMs, []);
    } catch (_) {
      results = [];
    }
    if (typeof results === 'string') results = parseBingRss(results);
    if (!Array.isArray(results)) results = [];

    for (const result of results.slice(0, 8)) {
      const normalizedUrl = normalizeCandidateUrl(result.url || result.link);
      if (!normalizedUrl || isBlockedCandidateUrl(normalizedUrl)) continue;
      const score = scoreOfficialCandidate({ ...result, url: normalizedUrl }, normalizedName);
      if (score < minCandidateScore) continue;
      const key = normalizedUrl.replace(/\/$/, '');
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({
        title: normalizeWhitespace(result.title),
        url: normalizedUrl,
        description: normalizeWhitespace(result.description || result.snippet),
        rank: result.rank || candidates.length + 1,
        query,
        score,
        source: result.source || 'search',
      });
    }
  }

  candidates.sort((a: any, b: any) => b.score - a.score || a.rank - b.rank);

  const verified: any[] = [];
  for (const candidate of candidates.slice(0, Number(options.maxVerifyCandidates) || 6)) {
    const verification: any = await verifyCandidateOfficialSite(candidate, normalizedName, fetcher);
    verified.push({ ...candidate, verification });
    if (verification.ok) {
      return {
        ok: true,
        url: candidate.url,
        companyName: normalizedName,
        method: 'company-name-search',
        provider: 'bing-rss',
        query: candidate.query,
        title: candidate.title,
        description: candidate.description,
        confidence: Math.min(1, verification.score / 260),
        score: verification.score,
        verifiedBy: verification.verifiedBy,
        matchedVariant: verification.matchedVariant,
        candidates: verified.slice(0, 5),
      };
    }
  }

  return {
    ok: false,
    error: candidates.length > 0 ? 'official-site-not-verified' : 'official-site-not-found',
    companyName: normalizedName,
    queries,
    candidates: verified.length > 0 ? verified.slice(0, 5) : candidates.slice(0, 5),
  };
}

module.exports = {
  buildOfficialSiteQueries,
  fetchBingRss,
  getCompanyNameVariants,
  normalizeCompanyNameForSearch,
  parseBingRss,
  resolveOfficialSiteByCompanyName,
  scoreOfficialCandidate,
  verifyCandidateOfficialSite,
};

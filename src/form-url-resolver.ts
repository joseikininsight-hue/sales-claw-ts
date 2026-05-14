'use strict';

const http = require('http');
const https = require('https');

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

function isSafeUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const hostname = parsed.hostname.toLowerCase();
  const bareHost = hostname.replace(/^\[|\]$/g, '');
  if (/^(localhost|127\.|0\.|::1|169\.254\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|fc[0-9a-f]{2}:|fd[0-9a-f]{2}:|fe80:|::ffff:)/.test(bareHost)) return false;
  if (/^\d+$/.test(hostname) || /^0x[0-9a-f]+$/i.test(hostname)) return false;
  if (!hostname.includes('.') && !hostname.includes(':')) return false;
  return true;
}

function fetchText(targetUrl, redirects = 3) {
  if (!isSafeUrl(targetUrl)) return Promise.resolve('');
  return new Promise<any>((resolve) => {
    if (redirects <= 0) {
      resolve('');
      return;
    }
    const mod = targetUrl.startsWith('https') ? https : http;
    const req = mod.get(targetUrl, {
      timeout: 10000,
      lookup: safeLookup,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = new URL(res.headers.location, targetUrl).href;
        resolve(fetchText(next, redirects - 1));
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
        if (body.length > 300000) res.destroy();
      });
      res.on('end', () => resolve(body));
      res.on('error', () => resolve(''));
    });
    req.on('error', () => resolve(''));
    req.on('timeout', () => {
      req.destroy();
      resolve('');
    });
  });
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function normalizeWhitespace(value) {
  return decodeHtml(String(value || '').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeCandidateUrl(baseUrl, href) {
  if (!href) return '';
  const trimmed = String(href).trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('#') || /^mailto:/i.test(trimmed) || /^tel:/i.test(trimmed) || /\.pdf($|\?)/i.test(trimmed)) {
    return '';
  }
  try {
    const resolved = new URL(trimmed, baseUrl);
    const base = new URL(baseUrl);
    if (!/^https?:$/i.test(resolved.protocol)) return '';
    if (resolved.hostname !== base.hostname) return '';
    return resolved.href;
  } catch {
    return '';
  }
}

function extractLinks(html, baseUrl) {
  const links: any[] = [];
  const seen = new Set<any>();
  const re = /<a\b[^>]*href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    const href = match[1] || match[2] || match[3] || '';
    const normalizedUrl = normalizeCandidateUrl(baseUrl, href);
    if (!normalizedUrl || seen.has(normalizedUrl)) continue;
    seen.add(normalizedUrl);
    links.push({
      href: normalizedUrl,
      text: normalizeWhitespace(match[4]).slice(0, 120),
    });
  }
  return links;
}

function scoreLinkCandidate(link) {
  const combined = `${link.text} ${link.href}`.toLowerCase();
  let score = 0;
  if (/問い合わせ|お問合|contact|inquiry|toiawase/.test(combined)) score += 100;
  if (/form|フォーム/.test(combined)) score += 60;
  if (/support|相談/.test(combined)) score += 25;
  if (/partner|パートナー|協業|提携/.test(combined)) score -= 30;
  if (/recruit|採用|ir|press|news|privacy/.test(combined)) score -= 60;
  if (/\/contact|\/inquiry|\/toiawase|\/form/.test(combined)) score += 40;
  return score;
}

function looksLikeContactPage(html) {
  const lowered = String(html || '').toLowerCase();
  return (
    /<form\b/.test(lowered) ||
    /<textarea\b/.test(lowered) ||
    /type=["']email["']/.test(lowered) ||
    /問い合わせ|お問合|contact|inquiry/.test(lowered)
  );
}

// ページ本文から接触手段を判別するヘルパー
// 'contact_form' — <form>/<input name=...> を含む
// 'email_only' — mailto: リンクのみ
// 'phone_only' — tel:リンクのみ
// 'not_found' — いずれもなし
function classifyPageContent(html) {
  const safe = String(html || '').toLowerCase();
  const hasForm = /<form\b[^>]*>/i.test(safe) || /<input\b[^>]+name\s*=/i.test(safe);
  const hasMailto = /mailto:/i.test(safe);
  const hasTel = /tel:\+?\d/i.test(safe);
  if (hasForm) return 'contact_form';
  if (hasMailto) return 'email_only';
  if (hasTel) return 'phone_only';
  return 'not_found';
}

async function probeUrl(targetUrl) {
  const html: any = await fetchText(targetUrl);
  if (!html) return { ok: false, url: targetUrl };
  return {
    ok: looksLikeContactPage(html),
    url: targetUrl,
    hasForm: /<form\b/i.test(html) || /<textarea\b/i.test(html),
  };
}

async function resolveContactFormUrl(siteUrl) {
  if (!siteUrl || !isSafeUrl(siteUrl)) {
    return { found: false, reason: 'invalid-url', formUrl: '', formType: 'not_found' };
  }

  const html: any = await fetchText(siteUrl);
  if (!html) {
    return { found: false, reason: 'fetch-failed', formUrl: '', formType: 'not_found' };
  }

  const links = extractLinks(html, siteUrl)
    .map((link: any) => ({ ...link, score: scoreLinkCandidate(link) }))
    .filter((link: any) => link.score > 0)
    .sort((a: any, b: any) => b.score - a.score)
    .slice(0, 6);

  let lastCandidateHtml = '';

  for (const link of links) {
    const candidateHtml: any = await fetchText(link.href);
    if (candidateHtml) lastCandidateHtml = candidateHtml;
    const isContact = looksLikeContactPage(candidateHtml);
    if (isContact) {
      const hasForm = /<form\b/i.test(candidateHtml) || /<textarea\b/i.test(candidateHtml);
      // looksLikeContactPage が true でも <form> が無ければ、本文から mailto:/tel: を判定して分類
      const formType = hasForm
        ? 'contact_form'
        : classifyPageContent(candidateHtml);
      return {
        found: true,
        formUrl: link.href,
        method: 'link',
        linkText: link.text,
        hasForm,
        formType,
      };
    }
  }

  const base = new URL(siteUrl);
  const commonPaths = [
    '/contact',
    '/contact/',
    '/contact-us',
    '/contact-us/',
    '/inquiry',
    '/inquiry/',
    '/toiawase',
    '/toiawase/',
    '/form',
    '/form/',
  ];

  for (const pathName of commonPaths) {
    const candidate = new URL(pathName, base).href;
    const candidateHtml: any = await fetchText(candidate);
    if (candidateHtml) lastCandidateHtml = candidateHtml;
    const isContact = looksLikeContactPage(candidateHtml);
    if (isContact) {
      const hasForm = /<form\b/i.test(candidateHtml) || /<textarea\b/i.test(candidateHtml);
      const formType = hasForm ? 'contact_form' : classifyPageContent(candidateHtml);
      return {
        found: true,
        formUrl: candidate,
        method: 'common-path',
        hasForm,
        formType,
      };
    }
  }

  // リンク候補あり / 接触ページと判定できない場合: 最後に見たページ or トップを分類
  // 候補がない場合はトップページを分類して email_only / phone_only を判定
  const classifyTarget = lastCandidateHtml || html;
  const pageType = classifyPageContent(classifyTarget);

  // pageType が 'contact_form' でも resolveContactFormUrl がここまで来るのは
  // looksLikeContactPage が false だった稀なケース → 保守的に not_found 扱い
  let formType;
  if (pageType === 'email_only') {
    formType = 'email_only';
  } else if (pageType === 'phone_only') {
    formType = 'phone_only';
  } else {
    formType = 'not_found';
  }

  return {
    found: false,
    reason: links.length > 0 ? 'candidate-not-contact' : 'no-candidate',
    formUrl: '',
    formType,
  };
}

module.exports = {
  resolveContactFormUrl,
  isSafeUrl,
  classifyPageContent,
};

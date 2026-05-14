'use strict';

// List Page Discovery — 企業一覧ページ（ランキング記事/業界一覧/会員企業ページ等）
// から個別企業の候補 URL を抽出する
//
// 入力 (要件§5.1):
//   { urls: string[],            // リストページURL
//     maxPages?: number,         // ページネーション上限 (default 10)
//     maxCompanies?: number,     // 取得上限 (default 100)
//     fetchHtml?: async (url) => string  // テスト用 DI
//   }
//
// 出力:
//   { ok: true, candidates: Array<{
//       companyName?: string,
//       url: string,
//       sourceListUrl: string,    // 取得元のリストページ URL
//       rank?: number             // リスト内での出現順
//     }>,
//     warnings: string[]
//   }
//
// アルゴリズム:
//   1. 各 URL をフェッチ
//   2. ページネーションを検出して全ページを巡回 (上限あり)
//   3. 各ページから外部企業ドメインへの <a> リンクを抽出
//   4. 同一ドメインリンクを集約・重複排除して candidates として返す

const { URL } = require('url');
const urlNormalizer = require('../url-normalizer');
const pagination = require('./pagination');
const extractor = require('../extractor');
const settings = require('../../settings-manager');

const DEFAULT_MAX_PAGES = 10;
const DEFAULT_MAX_COMPANIES = 100;

// HTML から <a> リンクを抽出
function extractLinks(html, baseUrl) {
  if (!html || !baseUrl) return [];
  const result: any[] = [];
  const anchorRegex = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]{0,200}?)<\/a>/gi;
  let m;
  while ((m = anchorRegex.exec(html)) !== null) {
    try {
      const u = new URL(m[1], baseUrl);
      // http(s) 以外（mailto, javascript, tel）は除外
      if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
      const text = stripTags(m[2]).trim();
      result.push({ url: u.toString(), text });
    } catch (_) {}
  }
  return result;
}

function stripTags(s) {
  return String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

// HTML からリスト構造（カード/テーブル行/li 反復）を見つけて、
// その中の最初の外部リンクを抽出する。
//
// 戦略:
//   1. <nav>, <header>, <footer> 内の HTML を予め除去（ナビ/フッタ誤採用防止）
//   2. 4 つのコンテナパターン (li / tr / article / div.card) を全て評価
//   3. 最も多くの企業候補を抽出できたパターンを採用 (件数同率なら多様性で優先)
//   4. 全パターンで件数 0 の場合、ページ全体の外部リンクをフォールバック採用
function stripNavRegions(html) {
  if (!html) return '';
  return String(html)
    .replace(/<nav\b[\s\S]*?<\/nav>/gi, '')
    .replace(/<header\b[\s\S]*?<\/header>/gi, '')
    .replace(/<footer\b[\s\S]*?<\/footer>/gi, '');
}

function extractCompanyEntries(html, baseUrl) {
  const cleaned = stripNavRegions(html);
  const containerPatterns = [
    /<li\b[^>]*>([\s\S]*?)<\/li>/gi,
    /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi,
    /<article\b[^>]*>([\s\S]*?)<\/article>/gi,
    /<div\b[^>]*\bclass\s*=\s*["'][^"']*\b(?:card|item|company|entry)\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi,
  ];

  let bestMatch: { entries: any[] } = { entries: [] };

  for (const pattern of containerPatterns) {
    const local: any[] = [];
    let m;
    pattern.lastIndex = 0;
    while ((m = pattern.exec(cleaned)) !== null) {
      const inner = m[1];
      const links = extractLinks(inner, baseUrl);
      const firstExternal = links.find((link: any) => isExternalLink(link.url, baseUrl));
      if (firstExternal) {
        let name = firstExternal.text || '';
        if (!name) name = stripTags(inner).slice(0, 60);
        local.push({ companyName: name, url: firstExternal.url });
      }
    }
    if (local.length > bestMatch.entries.length) {
      bestMatch = { entries: local };
    }
  }

  if (bestMatch.entries.length > 0) return bestMatch.entries;

  // フォールバック: 反復構造から候補を取れなかった場合、ページ全体の外部リンク
  const fallbackEntries: any[] = [];
  const allLinks = extractLinks(cleaned, baseUrl);
  for (const link of allLinks) {
    if (isExternalLink(link.url, baseUrl)) {
      fallbackEntries.push({ companyName: link.text || '', url: link.url });
    }
  }
  return fallbackEntries;
}

// baseUrl と異なる eTLD+1（domainRoot）のリンクか判定。
// hostname 単純比較だと blog.example.com と www.example.com が別扱いになるため、
// urlNormalizer.extractDomainRoot を使って eTLD+1 で比較する。
function isExternalLink(linkUrl, baseUrl) {
  try {
    const a = new URL(linkUrl);
    const b = new URL(baseUrl);
    const aRoot = urlNormalizer.extractDomainRoot(a.hostname.toLowerCase());
    const bRoot = urlNormalizer.extractDomainRoot(b.hostname.toLowerCase());
    return aRoot !== bRoot;
  } catch (_) {
    return false;
  }
}

// 候補リストを domainRoot で集約・重複排除
//
// 同じドメインの企業に対して複数のリンクが出ている場合、最初に登場した
// もの（rank が小さい方）を採用する。
//
// 戻り値: { records, invalidCount } - 正規化失敗件数も呼び出し側に返して
// warnings に積めるようにする。
function dedupeCandidates(candidates) {
  const seen = new Map<any, any>();
  let invalidCount = 0;
  for (const c of candidates) {
    const norm = urlNormalizer.normalize(c.url);
    if (!norm.valid) {
      invalidCount++;
      continue;
    }
    const key = norm.domainRoot;
    if (!seen.has(key)) {
      seen.set(key, {
        ...c,
        url: norm.normalized,
        domainRoot: norm.domainRoot,
      });
    }
  }
  return { records: [...seen.values()], invalidCount };
}

function shouldRespectRobots(opts: Record<string, any> = {}) {
  if (opts.respectRobotsTxt !== undefined) return opts.respectRobotsTxt !== false;
  const config = settings.getListBuilderConfig?.() || {};
  return config.respectRobotsTxt !== false;
}

// メイン: discover
async function discover(payload, opts: Record<string, any> = {}) {
  if (!payload || !Array.isArray(payload.urls) || payload.urls.length === 0) {
    return { ok: false, error: 'urls is required' };
  }
  const fetchHtml = opts.fetchHtml || (async () => ({ ok: false, error: 'no fetcher' }));
  const maxPages = Math.min(Math.max(payload.maxPages || DEFAULT_MAX_PAGES, 1), 50);
  const maxCompanies = Math.min(Math.max(payload.maxCompanies || DEFAULT_MAX_COMPANIES, 1), 500);

  const allCandidates: any[] = [];
  const warnings: any[] = [];

  for (const listUrl of payload.urls) {
    if (allCandidates.length >= maxCompanies) break;

    let currentUrl = listUrl;
    let pagesFetched = 0;

    while (currentUrl && pagesFetched < maxPages && allCandidates.length < maxCompanies) {
      if (shouldRespectRobots(opts)) {
        const robots: any = await extractor.checkRobotsAllowed(currentUrl, fetchHtml, opts);
        if (!robots.allowed) {
          warnings.push(`robots disallowed: ${currentUrl} (${robots.reason || 'disallowed'})`);
          break;
        }
      }
      const result: any = await fetchHtml(currentUrl);
      if (!result || !result.ok) {
        warnings.push(`fetch failed: ${currentUrl} (${result?.error || 'unknown'})`);
        break;
      }
      const html = result.html || '';
      pagesFetched++;

      // この URL のページから企業候補を抽出
      const entries = extractCompanyEntries(html, currentUrl);
      let rank = allCandidates.length + 1;
      for (const e of entries) {
        if (allCandidates.length >= maxCompanies) break;
        allCandidates.push({
          ...e,
          sourceListUrl: listUrl,
          rank,
        });
        rank++;
      }

      // ページネーション検出
      const pag = pagination.detect(html, currentUrl);
      if (pag.type === 'link' && pag.nextUrl && pag.nextUrl !== currentUrl) {
        currentUrl = pag.nextUrl;
      } else if (pag.type === 'query' && pag.buildPageUrl) {
        const nextPage = pagesFetched + 1;
        const nextUrl = pag.buildPageUrl(nextPage);
        if (nextUrl !== currentUrl) {
          currentUrl = nextUrl;
        } else {
          currentUrl = null;
        }
      } else if (pag.type === 'infinite') {
        warnings.push(`infinite scroll detected (Phase 5 では未対応): ${currentUrl}`);
        currentUrl = null;
      } else {
        currentUrl = null;
      }
    }

    if (pagesFetched === 0) {
      warnings.push(`could not fetch any page for: ${listUrl}`);
    }
  }

  // domainRoot で集約・重複排除
  const { records, invalidCount } = dedupeCandidates(allCandidates);
  if (invalidCount > 0) {
    warnings.push(`${invalidCount} candidates dropped due to invalid URL normalization`);
  }
  return { ok: true, candidates: records.slice(0, maxCompanies), warnings };
}

module.exports = {
  discover,
  extractLinks,
  extractCompanyEntries,
  isExternalLink,
  dedupeCandidates,
  // テスト用定数
  DEFAULT_MAX_PAGES,
  DEFAULT_MAX_COMPANIES,
};

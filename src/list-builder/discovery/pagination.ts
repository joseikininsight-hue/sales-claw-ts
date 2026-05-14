'use strict';

// Pagination — リストページのページネーション検出
//
// 3 形式に対応:
//   1. クエリパラメータ型: ?page=N / ?p=N / &start=N / ?offset=N
//   2. リンクボタン型: <a rel="next"> / 「次へ」/「Next」テキストの <a>
//   3. 無限スクロール型: 上記が見当たらず、ページ末尾に lazy-load 系の
//      スクリプト/属性が見える場合 (Playwright で対応する想定)
//
// 純粋関数として実装。HTML テキストと現在 URL を渡すだけで、副作用なし。
//
// 出力:
//   {
//     type: 'query' | 'link' | 'infinite' | 'none',
//     // type が 'query' のとき: パターン情報
//     queryParam?: 'page' | 'p' | 'start' | 'offset',
//     stride?: number,           // start/offset の場合の刻み (例: 10)
//     baseUrl?: string,          // クエリ抜きのURL
//     totalPages?: number,       // 検出できれば
//
//     // type が 'link' のとき:
//     nextUrl?: string,          // 直接の next URL
//
//     // 共通: 候補生成関数（呼び出し側が任意ページの URL を組み立てる）
//     buildPageUrl?: (n: number) => string,
//   }

const { URL } = require('url');

// ?page=N / ?p=N / ?start=N / ?offset=N の検出
//
// 候補リンクの中で「直近の page クエリパラメータ違いだけで他は同じ」リンクが
// 複数あればクエリ型と判定する。
function detectQueryParamPagination(html, currentUrl) {
  const candidates = ['page', 'p', 'start', 'offset', 'pg', 'page_num'];

  // <a href="..."> を全部抜き出して URL 解析
  const anchorRegex = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi;
  const links: URL[] = [];
  let m;
  while ((m = anchorRegex.exec(html)) !== null) {
    try {
      const u = new URL(m[1], currentUrl);
      links.push(u);
    } catch (_) {}
  }

  for (const param of candidates) {
    // 同じ origin + path で param だけ違う URL を集める
    const groups = new Map<string, Array<{ link: URL; num: number }>>();
    for (const link of links) {
      const value = link.searchParams.get(param);
      if (value === null) continue;
      const num = Number(value);
      if (!Number.isFinite(num)) continue;
      const key = link.origin + link.pathname;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push({ link, num });
    }

    // 同じパスで 2 つ以上の候補があり、かつ数値が単調増加（連番性あり）なら確定。
    // 単純な閾値2 だけだと sort=1/sort=2 のようなフィルタリンクを誤検知する。
    for (const [key, list] of groups) {
      if (list.length < 2) continue;
      const sorted = [...list].sort((a: any, b: any) => a.num - b.num);
      const first = sorted[0];
      const second = sorted[1];

      // 数値の連続性チェック (page 系は 1, 2, 3 のような連番、start/offset は等間隔)
      const isPageType = (param !== 'start' && param !== 'offset');
      const diff = second.num - first.num;
      if (isPageType) {
        // page 型は連番である必要 (差分 1〜2)
        if (diff < 1 || diff > 2) continue;
      } else {
        // start/offset は等間隔ストライド (10, 20, 50 等)
        if (diff <= 0) continue;
      }

      // 3 件以上ある場合は連番性をさらに確認
      if (sorted.length >= 3) {
        const third = sorted[2];
        const expectedThird = isPageType ? second.num + diff : second.num + diff;
        if (Math.abs(third.num - expectedThird) > 1) continue;
      }

      {
        const stride = (param === 'start' || param === 'offset')
          ? Math.max(1, diff)
          : 1;

        const baseUrl = (() => {
          const u = new URL(currentUrl);
          u.search = '';
          // currentUrl の他のパラメータは保持
          const cu = new URL(currentUrl);
          for (const [k, v] of cu.searchParams.entries()) {
            if (k !== param) u.searchParams.set(k, v);
          }
          return u;
        })();

        const buildPageUrl = (n) => {
          const u = new URL(baseUrl);
          if (param === 'start' || param === 'offset') {
            u.searchParams.set(param, String((n - 1) * stride));
          } else {
            u.searchParams.set(param, String(n));
          }
          return u.toString();
        };

        return {
          type: 'query',
          queryParam: param,
          stride,
          baseUrl: baseUrl.toString(),
          totalPages: estimateTotalPages(list, param, stride),
          buildPageUrl,
        };
      }
    }
  }
  return null;
}

function estimateTotalPages(list, param, stride) {
  if (!list || !list.length) return null;
  let max = 0;
  for (const { num } of list) {
    if (param === 'start' || param === 'offset') {
      const page = Math.floor(num / stride) + 1;
      if (page > max) max = page;
    } else {
      if (num > max) max = num;
    }
  }
  return max || null;
}

// rel="next" / テキストが「次へ」「Next」「Next page」の <a> を検出
function detectLinkPagination(html, currentUrl) {
  // <a rel="next" href="..."> パターン
  const relNextMatch = html.match(/<a\b[^>]*\brel\s*=\s*["'][^"']*\bnext\b[^"']*["'][^>]*>/i);
  if (relNextMatch) {
    const hrefMatch = relNextMatch[0].match(/\bhref\s*=\s*["']([^"']+)["']/i);
    if (hrefMatch) {
      try {
        const next = new URL(hrefMatch[1], currentUrl).toString();
        return { type: 'link', nextUrl: next };
      } catch (_) {}
    }
  }

  // <link rel="next"> (head 内)
  const linkNextMatch = html.match(/<link\b[^>]*\brel\s*=\s*["']next["'][^>]*\bhref\s*=\s*["']([^"']+)["']/i);
  if (linkNextMatch) {
    try {
      const next = new URL(linkNextMatch[1], currentUrl).toString();
      return { type: 'link', nextUrl: next };
    } catch (_) {}
  }

  // 「次へ」「Next」テキストの <a>
  const textNextRegex = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([^<]{0,40})<\/a>/gi;
  let m;
  while ((m = textNextRegex.exec(html)) !== null) {
    const text = m[2].trim();
    if (/^(?:次(?:のページ)?へ?|next(?:\s+page)?|»|>>)$/i.test(text)
        || /[≫»]/.test(text)) {
      try {
        const next = new URL(m[1], currentUrl).toString();
        return { type: 'link', nextUrl: next };
      } catch (_) {}
    }
  }

  return null;
}

// 無限スクロール型の検出 (lazy-load / load-more ボタン)
//
// data-lazy だけでは画像 lazy-load との誤検知があるため、より特異な属性に限定する。
function detectInfiniteScroll(html) {
  // 明確に無限スクロール/load-more を示す属性
  if (/data-(?:infinite-scroll|load-more|next-page|lazy-load|lazyload)\b/i.test(html)) {
    return { type: 'infinite' };
  }
  // class 名で判定 (load-more ボタン等)
  if (/class\s*=\s*["'][^"']*\b(?:load-more|loadMore|infinite-scroll)\b/i.test(html)) {
    return { type: 'infinite' };
  }
  return null;
}

// メイン: ページネーション形式を検出
function detect(html, currentUrl) {
  if (!html || !currentUrl) return { type: 'none' };

  const query = detectQueryParamPagination(html, currentUrl);
  if (query) return query;

  const link = detectLinkPagination(html, currentUrl);
  if (link) return link;

  const infinite = detectInfiniteScroll(html);
  if (infinite) return infinite;

  return { type: 'none' };
}

module.exports = {
  detect,
  detectQueryParamPagination,
  detectLinkPagination,
  detectInfiniteScroll,
};

'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'discovery-test-'));
process.env.SALES_CLAW_USER_DATA_DIR = tmpRoot;
process.env.SALES_CLAW_TEST_MODE = '1';

const pagination = require('../../dist-ts/src/list-builder/discovery/pagination');
const listPage = require('../../dist-ts/src/list-builder/discovery/list-page');
const nlq = require('../../dist-ts/src/list-builder/discovery/nlq');
const category = require('../../dist-ts/src/list-builder/discovery/category');

function describe(n, f) { console.log('\n=== ' + n + ' ==='); f(); }
function it(n, f) {
  try { f(); console.log('  OK  ' + n); }
  catch (e) { console.error('  FAIL ' + n + ' — ' + e.message); process.exitCode = 1; }
}
function itAsync(n, f) {
  return f().then(() => console.log('  OK  ' + n))
    .catch((e) => { console.error('  FAIL ' + n + ' — ' + e.message); process.exitCode = 1; });
}

// ============================================================
// pagination
// ============================================================
describe('pagination: query parameter detection', () => {
  it('detects ?page=N pattern', () => {
    const html = `
      <a href="/articles?page=1">1</a>
      <a href="/articles?page=2">2</a>
      <a href="/articles?page=3">3</a>
    `;
    const r = pagination.detect(html, 'https://example.com/articles');
    assert.equal(r.type, 'query');
    assert.equal(r.queryParam, 'page');
    assert.equal(r.totalPages, 3);
    const nextUrl = r.buildPageUrl(2);
    assert.match(nextUrl, /page=2/);
  });

  it('detects ?start=N stride pattern', () => {
    const html = `
      <a href="/list?start=0">1</a>
      <a href="/list?start=10">2</a>
      <a href="/list?start=20">3</a>
    `;
    const r = pagination.detect(html, 'https://example.com/list');
    assert.equal(r.type, 'query');
    assert.equal(r.queryParam, 'start');
    assert.equal(r.stride, 10);
    const u3 = r.buildPageUrl(3);
    assert.match(u3, /start=20/);
  });

  it('preserves other query parameters', () => {
    const html = `
      <a href="/list?cat=foo&page=1">1</a>
      <a href="/list?cat=foo&page=2">2</a>
    `;
    const r = pagination.detect(html, 'https://example.com/list?cat=foo');
    const u = r.buildPageUrl(3);
    assert.match(u, /cat=foo/);
    assert.match(u, /page=3/);
  });
});

describe('pagination: link detection', () => {
  it('detects <a rel="next">', () => {
    const html = '<a rel="next" href="/page2">次へ</a>';
    const r = pagination.detect(html, 'https://example.com/page1');
    assert.equal(r.type, 'link');
    assert.equal(r.nextUrl, 'https://example.com/page2');
  });

  it('detects <link rel="next"> in head', () => {
    const html = '<head><link rel="next" href="/p/2"></head>';
    const r = pagination.detect(html, 'https://example.com/p/1');
    assert.equal(r.type, 'link');
    assert.equal(r.nextUrl, 'https://example.com/p/2');
  });

  it('detects 「次へ」 text link', () => {
    const html = '<a href="/p2">次へ</a>';
    const r = pagination.detect(html, 'https://example.com/');
    assert.equal(r.type, 'link');
  });

  it('detects "Next" text link', () => {
    const html = '<a href="/p2">Next</a>';
    const r = pagination.detect(html, 'https://example.com/');
    assert.equal(r.type, 'link');
  });
});

describe('pagination: infinite scroll detection', () => {
  it('detects load-more class', () => {
    const html = '<button class="load-more">More</button>';
    const r = pagination.detect(html, 'https://example.com/');
    assert.equal(r.type, 'infinite');
  });

  it('detects data-infinite-scroll attribute', () => {
    const html = '<div data-infinite-scroll="true"></div>';
    const r = pagination.detect(html, 'https://example.com/');
    assert.equal(r.type, 'infinite');
  });

  it('does NOT misdetect data-lazy on images as infinite scroll', () => {
    // 一般的な lazy-load 属性は誤検知させない
    const html = '<img data-lazy="real-image.jpg">';
    const r = pagination.detect(html, 'https://example.com/');
    assert.equal(r.type, 'none');
  });
});

describe('pagination: false-positive defenses', () => {
  it('does NOT detect non-page query params (e.g. sort=1, sort=2) as pagination', () => {
    const html = `
      <a href="/list?sort=1">By Date</a>
      <a href="/list?sort=2">By Name</a>
    `;
    const r = pagination.detect(html, 'https://example.com/list');
    assert.notEqual(r.type, 'query');
  });

  it('detects p=1, p=2, p=3 connected page sequence (positive)', () => {
    const html = `
      <a href="/list?p=1">1</a>
      <a href="/list?p=2">2</a>
      <a href="/list?p=3">3</a>
    `;
    const r = pagination.detect(html, 'https://example.com/list');
    assert.equal(r.type, 'query');
    assert.equal(r.queryParam, 'p');
  });
});

describe('pagination: none', () => {
  it('returns none when no pagination found', () => {
    const html = '<p>Just regular content</p>';
    const r = pagination.detect(html, 'https://example.com/');
    assert.equal(r.type, 'none');
  });
});

// ============================================================
// list-page
// ============================================================
describe('list-page.extractCompanyEntries', () => {
  it('extracts entries from <li> structure', () => {
    const html = `
      <ul>
        <li><a href="https://abc.co.jp">ABC Corp</a></li>
        <li><a href="https://def.com">DEF Inc</a></li>
        <li><a href="https://ghi.jp">GHI</a></li>
      </ul>
    `;
    const entries = listPage.extractCompanyEntries(html, 'https://list.example.com/page');
    assert.equal(entries.length, 3);
    assert.equal(entries[0].companyName, 'ABC Corp');
    assert.equal(entries[0].url, 'https://abc.co.jp/');
  });

  it('extracts from <tr> table structure', () => {
    const html = `
      <table>
        <tr><th>Name</th><th>URL</th></tr>
        <tr><td>Foo</td><td><a href="https://foo.com">Foo Inc</a></td></tr>
        <tr><td>Bar</td><td><a href="https://bar.com">Bar Inc</a></td></tr>
      </table>
    `;
    const entries = listPage.extractCompanyEntries(html, 'https://list.example.com/');
    assert.ok(entries.length >= 2);
  });

  it('extracts from <div class="card">', () => {
    const html = `
      <div class="card"><a href="https://a.com">Company A</a></div>
      <div class="company"><a href="https://b.com">Company B</a></div>
    `;
    const entries = listPage.extractCompanyEntries(html, 'https://list.example.com/');
    assert.ok(entries.length >= 2);
  });

  it('skips same-domain links (internal navigation)', () => {
    const html = `
      <li><a href="/about">About</a></li>
      <li><a href="https://external.com">External</a></li>
    `;
    const entries = listPage.extractCompanyEntries(html, 'https://list.example.com/page');
    const externalOnly = entries.filter((e) => e.url.includes('external.com'));
    assert.ok(externalOnly.length > 0);
  });
});

describe('list-page: best-pattern selection (Critical fix)', () => {
  it('selects pattern with most entries instead of first match', () => {
    // <li> に nav 由来の外部リンク 1 件、<article> に 5 件 → article を採用
    const html = `
      <ul>
        <li><a href="https://nav-link.com">Some Link</a></li>
      </ul>
      <article><a href="https://co1.com">Co 1</a></article>
      <article><a href="https://co2.com">Co 2</a></article>
      <article><a href="https://co3.com">Co 3</a></article>
      <article><a href="https://co4.com">Co 4</a></article>
      <article><a href="https://co5.com">Co 5</a></article>
    `;
    const entries = listPage.extractCompanyEntries(html, 'https://list.example.com/');
    assert.equal(entries.length, 5);
    // co1〜co5 が含まれる
    assert.ok(entries.some((e) => e.url.includes('co1.com')));
    assert.ok(entries.some((e) => e.url.includes('co5.com')));
  });

  it('strips <nav> / <header> / <footer> regions before matching', () => {
    const html = `
      <header>
        <nav>
          <ul>
            <li><a href="https://other-site.com/about">About</a></li>
            <li><a href="https://other-site.com/help">Help</a></li>
          </ul>
        </nav>
      </header>
      <main>
        <ul>
          <li><a href="https://co1.com">Co 1</a></li>
          <li><a href="https://co2.com">Co 2</a></li>
        </ul>
      </main>
      <footer>
        <a href="https://corporate-info.com/privacy">Privacy</a>
      </footer>
    `;
    const entries = listPage.extractCompanyEntries(html, 'https://list.example.com/');
    // co1, co2 のみ取得できているはず
    assert.equal(entries.length, 2);
  });
});

describe('list-page: subdomain treated as same domain (Major fix)', () => {
  it('blog.example.com is treated as same site as www.example.com', () => {
    // baseUrl が blog.example.com の場合、www.example.com のリンクは内部とみなす
    assert.equal(
      listPage.isExternalLink('https://www.example.com/path', 'https://blog.example.com/'),
      false
    );
    // 異なる eTLD+1 は外部
    assert.equal(
      listPage.isExternalLink('https://other.com/x', 'https://example.com/'),
      true
    );
  });
});

describe('list-page.dedupeCandidates', () => {
  it('dedupes by domainRoot', () => {
    const candidates = [
      { url: 'https://www.example.com/a' },
      { url: 'https://example.com/b' },        // 同じ domain
      { url: 'https://other.com/c' },
    ];
    const r = listPage.dedupeCandidates(candidates);
    assert.equal(r.records.length, 2);
    assert.equal(r.invalidCount, 0);
  });

  it('reports invalidCount for unparsable URLs', () => {
    const r = listPage.dedupeCandidates([
      { url: 'https://valid.com' },
      { url: '' },                           // 空文字 → invalid
      { url: 'mailto:foo@bar.com' },         // unsupported scheme → invalid
    ]);
    assert.equal(r.records.length, 1);
    assert.equal(r.invalidCount, 2);
  });
});

describe('list-page.discover (integration with mock fetcher)', () => {
  itAsync('crawls multiple pages and aggregates candidates', async () => {
    const pages = {
      'https://list.example.com/p1': `
        <html>
          <body>
            <ul>
              <li><a href="https://abc.co.jp">ABC</a></li>
              <li><a href="https://def.com">DEF</a></li>
            </ul>
            <a rel="next" href="https://list.example.com/p2">Next</a>
          </body>
        </html>
      `,
      'https://list.example.com/p2': `
        <html><body>
          <ul>
            <li><a href="https://ghi.jp">GHI</a></li>
            <li><a href="https://abc.co.jp">ABC dup</a></li>
          </ul>
        </body></html>
      `,
    };
    const fetchHtml = async (url) => {
      const html = pages[url];
      return html ? { ok: true, html } : { ok: false, error: '404' };
    };
    const r = await listPage.discover(
      { urls: ['https://list.example.com/p1'] },
      { fetchHtml }
    );
    assert.equal(r.ok, true);
    // ABC は重複除去で 1 つ
    assert.equal(r.candidates.length, 3);
    const domains = r.candidates.map((c) => c.domainRoot).sort();
    assert.deepEqual(domains, ['abc.co.jp', 'def.com', 'ghi.jp']);
  });

  itAsync('respects maxCompanies limit', async () => {
    const html = '<ul>' + Array(20).fill(0).map((_, i) =>
      `<li><a href="https://co${i}.com">Co ${i}</a></li>`
    ).join('') + '</ul>';
    const fetchHtml = async () => ({ ok: true, html });
    const r = await listPage.discover(
      { urls: ['https://list.example.com/'], maxCompanies: 5 },
      { fetchHtml }
    );
    assert.equal(r.candidates.length, 5);
  });

  itAsync('records warning when fetch fails', async () => {
    const fetchHtml = async () => ({ ok: false, error: 'timeout' });
    const r = await listPage.discover(
      { urls: ['https://list.example.com/'] },
      { fetchHtml }
    );
    assert.equal(r.ok, true);
    assert.ok(r.warnings.length > 0);
    assert.equal(r.candidates.length, 0);
  });

  itAsync('does not fetch a list page when robots.txt disallows it', async () => {
    const calls = [];
    const fetchHtml = async (url) => {
      calls.push(url);
      if (url === 'https://blocked-list.example.com/robots.txt') {
        return { ok: true, statusCode: 200, html: 'User-agent: *\nDisallow: /' };
      }
      if (url === 'https://blocked-list.example.com/ranking') {
        return {
          ok: true,
          statusCode: 200,
          html: '<a href="https://should-not-fetch.example.net">Should Not Fetch</a>',
        };
      }
      return { ok: false, statusCode: 404 };
    };
    const r = await listPage.discover(
      { urls: ['https://blocked-list.example.com/ranking'] },
      { fetchHtml }
    );
    assert.equal(r.ok, true);
    assert.equal(r.candidates.length, 0);
    assert.ok(r.warnings.some((w) => w.includes('robots disallowed')));
    assert.equal(calls.includes('https://blocked-list.example.com/ranking'), false);
  });

  itAsync('rejects empty urls', async () => {
    const r = await listPage.discover({ urls: [] });
    assert.equal(r.ok, false);
  });
});

// ============================================================
// nlq
// ============================================================
describe('nlq.extractJson', () => {
  it('extracts JSON from plain response', () => {
    const j = nlq.extractJson('{"industries":["SaaS"]}');
    assert.deepEqual(j, { industries: ['SaaS'] });
  });

  it('extracts JSON from code-block wrapped response', () => {
    const j = nlq.extractJson('```json\n{"industries":["SaaS"]}\n```');
    assert.deepEqual(j, { industries: ['SaaS'] });
  });

  it('extracts JSON when surrounded by explanation text', () => {
    const j = nlq.extractJson('以下が結果です:\n{"industries":["SaaS"]}\nです。');
    assert.deepEqual(j, { industries: ['SaaS'] });
  });

  it('returns null for invalid JSON', () => {
    assert.equal(nlq.extractJson('not json'), null);
    assert.equal(nlq.extractJson(''), null);
  });
});

describe('nlq.validateStructuredIntent', () => {
  it('fills missing fields with empty arrays', () => {
    const r = nlq.validateStructuredIntent({});
    assert.deepEqual(r.industries, []);
    assert.deepEqual(r.prefectures, []);
    assert.deepEqual(r.keywords, []);
  });

  it('filters non-string array items', () => {
    const r = nlq.validateStructuredIntent({ industries: ['SaaS', 123, null, 'SIer'] });
    assert.deepEqual(r.industries, ['SaaS', 'SIer']);
  });

  it('returns null for non-object input', () => {
    assert.equal(nlq.validateStructuredIntent(null), null);
    assert.equal(nlq.validateStructuredIntent('foo'), null);
  });
});

describe('nlq.parseQuery', () => {
  itAsync('uses injected llmInvoker', async () => {
    const llmInvoker = async (msg) => {
      assert.match(msg.system, /B2B営業/);
      assert.match(msg.user, /SaaS/);
      return {
        ok: true,
        text: '{"industries":["SaaS"],"prefectures":["東京都"],"companySizeHints":[],"revenueHints":[],"keywords":["自社プロダクト"],"negativeKeywords":[],"mustHave":[],"niceToHave":[]}',
      };
    };
    const r = await nlq.parseQuery({ query: '都内のSaaS企業' }, { llmInvoker });
    assert.equal(r.ok, true);
    assert.deepEqual(r.intent.industries, ['SaaS']);
    assert.deepEqual(r.intent.prefectures, ['東京都']);
    assert.deepEqual(r.intent.keywords, ['自社プロダクト']);
  });

  itAsync('fails gracefully when LLM returns garbage', async () => {
    const llmInvoker = async () => ({ ok: true, text: 'hello world' });
    const r = await nlq.parseQuery({ query: 'something' }, { llmInvoker });
    assert.equal(r.ok, false);
    assert.match(r.error, /JSON/);
  });

  itAsync('rejects empty query', async () => {
    const r = await nlq.parseQuery({ query: '' });
    assert.equal(r.ok, false);
  });
});

// ============================================================
// category
// ============================================================
describe('category.buildQueries', () => {
  it('generates cross-product queries for industries × prefectures', () => {
    const q = category.buildQueries({
      industries: ['SaaS', 'SIer'],
      prefectures: ['東京都', '大阪府'],
    });
    assert.equal(q.length, 4); // 2 industries × 2 prefectures
    assert.ok(q.some((s) => s.includes('東京都') && s.includes('SaaS')));
    assert.ok(q.some((s) => s.includes('大阪府') && s.includes('SIer')));
  });

  it('handles empty industries gracefully', () => {
    const q = category.buildQueries({
      industries: [],
      prefectures: ['東京都'],
    });
    assert.equal(q.length, 1);
    assert.match(q[0], /東京都/);
  });

  it('appends employee range label', () => {
    const q = category.buildQueries({
      industries: ['SaaS'],
      employeeRanges: ['51-100'],
    });
    assert.match(q[0], /51-100名/);
  });

  it('appends keywords (max 3)', () => {
    const q = category.buildQueries({
      industries: ['SaaS'],
      keywords: ['プロダクト', 'BtoB', 'API', 'Webhook', 'GraphQL'],
    });
    // 最初の 3 つだけ
    assert.match(q[0], /プロダクト/);
    assert.match(q[0], /API/);
    assert.doesNotMatch(q[0], /Webhook/);
  });
});

describe('category.expandEmployeeRanges', () => {
  it('expands one step on each side', () => {
    const r = category.expandEmployeeRanges(['51-100']);
    assert.ok(r.includes('51-100'));
    assert.ok(r.includes('11-50'));
    assert.ok(r.includes('101-300'));
  });

  it('does not go below smallest range', () => {
    const r = category.expandEmployeeRanges(['1-10']);
    assert.ok(r.includes('1-10'));
    assert.ok(r.includes('11-50'));
    assert.equal(r.length, 2);
  });
});

describe('category.buildLooseningSteps', () => {
  it('produces multiple steps with growth/employee/keyword relaxation', () => {
    const params = {
      industries: ['SaaS'],
      prefectures: ['東京都'],
      employeeRanges: ['51-100'],
      growthTrend: 'growing',
      keywords: ['プロダクト'],
    };
    const steps = category.buildLooseningSteps(params);
    // 初期 + growth緩和 + employee拡大 + keyword緩和 = 4 steps
    assert.equal(steps.length, 4);
    assert.equal(steps[0].step, 0);
    assert.match(steps[1].description, /成長性/);
  });

  it('skips steps when nothing to relax', () => {
    const params = {
      industries: ['SaaS'],
      prefectures: ['東京都'],
      growthTrend: 'any',
    };
    const steps = category.buildLooseningSteps(params);
    assert.equal(steps.length, 1);
  });
});

describe('category.discover', () => {
  itAsync('aggregates results across loosening steps and stops at limit', async () => {
    let queryCount = 0;
    const searchInvoker = async (query) => {
      queryCount++;
      return {
        ok: true,
        results: [
          { title: `Co ${queryCount}-A`, url: `https://co${queryCount}a.com` },
          { title: `Co ${queryCount}-B`, url: `https://co${queryCount}b.com` },
        ],
      };
    };
    const r = await category.discover({
      industries: ['SaaS', 'SIer'],
      prefectures: ['東京都'],
      limit: 3,
    }, { searchInvoker });
    assert.equal(r.ok, true);
    // 2 industries × 1 prefecture = 2 queries × 2 results = 4 候補のうち、limit 3
    assert.equal(r.candidates.length, 3);
  });

  itAsync('records loosened conditions when needed', async () => {
    let callCount = 0;
    const searchInvoker = async () => {
      callCount++;
      return { ok: true, results: callCount > 1 ? [{ title: 'Late', url: 'https://late.com' }] : [] };
    };
    const r = await category.discover({
      industries: ['SaaS'],
      prefectures: ['東京都'],
      growthTrend: 'growing',
      employeeRanges: ['51-100'],
      keywords: ['プロダクト'],
      limit: 5,
    }, { searchInvoker });
    assert.equal(r.ok, true);
    assert.ok(r.loosenedConditions.length >= 1);
  });

  itAsync('rejects when searchInvoker is missing', async () => {
    const r = await category.discover({ industries: ['SaaS'], limit: 10 });
    assert.equal(r.ok, false);
    assert.match(r.error, /searchInvoker/);
  });

  itAsync('dedupes URLs across queries', async () => {
    const searchInvoker = async () => ({
      ok: true,
      results: [{ title: 'Same', url: 'https://same.com' }],
    });
    const r = await category.discover({
      industries: ['SaaS', 'SIer', '製造'],
      prefectures: ['東京都'],
      limit: 100,
    }, { searchInvoker });
    assert.equal(r.candidates.length, 1);
  });
});

// クリーンアップ
process.on('exit', () => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}
});

'use strict';

const assert = require('node:assert/strict');

const employeeCount = require('../../dist-ts/src/list-builder/enrichers/employee-count');
const revenue = require('../../dist-ts/src/list-builder/enrichers/revenue');
const growthTrend = require('../../dist-ts/src/list-builder/enrichers/growth-trend');
const enricher = require('../../dist-ts/src/list-builder/enricher');
const extractor = require('../../dist-ts/src/list-builder/extractor');

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
// employee-count
// ============================================================
describe('employee-count.extract', () => {
  it('extracts 従業員数', () => {
    const html = '<p>従業員数: 250名</p>';
    const r = employeeCount.extract({ html });
    assert.equal(r.value, 250);
    assert.equal(r.source, 'html');
    assert.ok(r.confidence > 0.5);
  });

  it('extracts 連結 with priority', () => {
    const html = '従業員数 単体 100名 連結 1,234名';
    const r = employeeCount.extract({ html });
    assert.equal(r.value, 1234);
  });

  it('extracts comma-separated numbers', () => {
    const html = '<p>従業員数: 1,234人</p>';
    const r = employeeCount.extract({ html });
    assert.equal(r.value, 1234);
  });

  it('extracts English Employees', () => {
    const html = '<p>Employees: 500</p>';
    const r = employeeCount.extract({ html });
    assert.equal(r.value, 500);
  });

  it('uses existingEmployeeCount with high confidence', () => {
    const r = employeeCount.extract({ existingEmployeeCount: 100, html: '従業員数 200名' });
    assert.equal(r.value, 100);
    assert.equal(r.source, 'existing');
    assert.ok(r.confidence > 0.8);
  });

  it('returns null when no match', () => {
    const r = employeeCount.extract({ html: '<p>This page has no employee info.</p>' });
    assert.equal(r.value, null);
  });

  it('strips script/style tags before matching', () => {
    const html = '<script>従業員数 99999名</script><p>従業員数 100名</p>';
    const r = employeeCount.extract({ html });
    assert.equal(r.value, 100);
  });
});

describe('employee-count.classifySize', () => {
  it('classifies size correctly', () => {
    assert.equal(employeeCount.classifySize(10), 'small');
    assert.equal(employeeCount.classifySize(50), 'small');
    assert.equal(employeeCount.classifySize(51), 'medium');
    assert.equal(employeeCount.classifySize(300), 'medium');
    assert.equal(employeeCount.classifySize(301), 'large');
    assert.equal(employeeCount.classifySize(0), 'unknown');
    assert.equal(employeeCount.classifySize(null), 'unknown');
  });
});

// ============================================================
// revenue
// ============================================================
describe('revenue.toMillionYen', () => {
  it('converts 億円 to million yen', () => {
    assert.equal(revenue.toMillionYen('100', '億'), 10000);
    assert.equal(revenue.toMillionYen('1', '兆'), 1000000);
    assert.equal(revenue.toMillionYen('100', '百万'), 100);
  });

  it('handles comma-separated', () => {
    assert.equal(revenue.toMillionYen('1,234', '億'), 123400);
  });

  it('handles English units', () => {
    assert.equal(revenue.toMillionYen('100', 'million'), 100);
    // 1 billion = 1,000 million → 1,000 百万円
    assert.equal(revenue.toMillionYen('1', 'billion'), 1000);
    // 1 trillion = 1,000,000 million
    assert.equal(revenue.toMillionYen('1', 'trillion'), 1000000);
  });

  it('rejects negative or absurd values', () => {
    assert.equal(revenue.toMillionYen('-100', '億'), null);
    assert.equal(revenue.toMillionYen('999999999', '兆'), null);
  });
});

describe('revenue.extract', () => {
  it('extracts 売上高 億円', () => {
    const html = '<p>売上高: 100億円</p>';
    const r = revenue.extract({ html });
    assert.equal(r.value, 10000);
    assert.equal(r.source, 'html');
  });

  it('extracts 連結売上高 with comma', () => {
    const html = '<p>連結売上高 1,234億円</p>';
    const r = revenue.extract({ html });
    assert.equal(r.value, 123400);
  });

  it('uses EDINET data with high confidence', () => {
    const r = revenue.extract({
      html: '売上高 999億円',
      edinetData: { revenueMillionYen: 50000 },
    });
    assert.equal(r.value, 50000);
    assert.equal(r.source, 'edinet');
    assert.ok(r.confidence >= 0.9);
  });

  it('returns null when no match (capital is not revenue)', () => {
    const html = '<p>資本金: 1億円</p>';
    const r = revenue.extract({ html });
    assert.equal(r.value, null);
  });
});

describe('revenue.classifyRange', () => {
  it('classifies revenue ranges', () => {
    assert.equal(revenue.classifyRange(50), 'under_100m');
    assert.equal(revenue.classifyRange(500), '100m-1b');
    assert.equal(revenue.classifyRange(5000), '1b-10b');
    assert.equal(revenue.classifyRange(50000), '10b-100b');
    assert.equal(revenue.classifyRange(200000), 'over_100b');
  });
});

// ============================================================
// growth-trend
// ============================================================
describe('growth-trend.calculateCAGR', () => {
  it('returns positive CAGR for growing revenue', () => {
    const cagr = growthTrend.calculateCAGR([
      { fiscalYear: 2023, revenueMillionYen: 1000 },
      { fiscalYear: 2024, revenueMillionYen: 1200 },
      { fiscalYear: 2025, revenueMillionYen: 1500 },
    ]);
    assert.ok(cagr > 0.2 && cagr < 0.3, `expected ~22%, got ${cagr}`);
  });

  it('returns negative CAGR for declining revenue', () => {
    const cagr = growthTrend.calculateCAGR([
      { fiscalYear: 2023, revenueMillionYen: 1000 },
      { fiscalYear: 2025, revenueMillionYen: 800 },
    ]);
    assert.ok(cagr < 0);
  });

  it('returns null for insufficient data', () => {
    assert.equal(growthTrend.calculateCAGR([{ fiscalYear: 2024, revenueMillionYen: 100 }]), null);
    assert.equal(growthTrend.calculateCAGR([]), null);
    assert.equal(growthTrend.calculateCAGR(null), null);
  });
});

describe('growth-trend.classify', () => {
  it('returns growing for >= 10% CAGR (listed company)', () => {
    const r = growthTrend.classify({
      record: { listingStatus: 'listed' },
      revenueHistory: [
        { fiscalYear: 2023, revenueMillionYen: 1000 },
        { fiscalYear: 2025, revenueMillionYen: 1500 },
      ],
    });
    assert.equal(r.trend, 'growing');
    assert.equal(r.source, 'edinet');
  });

  it('returns stable for 0-10% CAGR', () => {
    const r = growthTrend.classify({
      record: { listingStatus: 'listed' },
      revenueHistory: [
        { fiscalYear: 2023, revenueMillionYen: 1000 },
        { fiscalYear: 2025, revenueMillionYen: 1080 },
      ],
    });
    assert.equal(r.trend, 'stable');
  });

  it('returns declining for negative CAGR', () => {
    const r = growthTrend.classify({
      record: { listingStatus: 'listed' },
      revenueHistory: [
        { fiscalYear: 2023, revenueMillionYen: 1000 },
        { fiscalYear: 2025, revenueMillionYen: 800 },
      ],
    });
    assert.equal(r.trend, 'declining');
  });

  it('returns unknown for non-listed (private) company', () => {
    const r = growthTrend.classify({
      record: { listingStatus: 'unlisted' },
      revenueHistory: [
        { fiscalYear: 2023, revenueMillionYen: 1000 },
        { fiscalYear: 2025, revenueMillionYen: 1500 },
      ],
    });
    assert.equal(r.trend, 'unknown');
  });

  it('treats edinetVerified=true as listed (replaces vague source check)', () => {
    const r = growthTrend.classify({
      record: { edinetVerified: true },
      revenueHistory: [
        { fiscalYear: 2023, revenueMillionYen: 100 },
        { fiscalYear: 2025, revenueMillionYen: 150 },
      ],
    });
    assert.equal(r.trend, 'growing');
  });

  it('does NOT treat ambiguous source=edinet field as listed', () => {
    // 旧実装は record.source === 'edinet' で listed 扱いしていたが廃止
    const r = growthTrend.classify({
      record: { source: 'edinet' }, // 上場フラグなし
      revenueHistory: [
        { fiscalYear: 2023, revenueMillionYen: 100 },
        { fiscalYear: 2025, revenueMillionYen: 150 },
      ],
    });
    assert.equal(r.trend, 'unknown');
  });
});

// ============================================================
// extractor
// ============================================================
describe('extractor.extract (with mock fetcher)', () => {
  itAsync('returns analyzed record when HTML is fetched', async () => {
    const fetcher = async () => ({
      ok: true,
      html: '<form action="/contact"><input/></form>',
      statusCode: 200,
      finalUrl: 'https://example.com/',
    });
    const r = await extractor.extract('https://example.com/', { fetcher });
    assert.equal(r.ok, true);
    assert.equal(r.statusCode, 200);
    assert.equal(r.formType, 'general_contact');
    assert.equal(r.blocked, false);
  });

  itAsync('marks blocked when CAPTCHA is detected', async () => {
    const fetcher = async () => ({
      ok: true,
      html: '<div class="g-recaptcha"></div>',
      statusCode: 200,
    });
    const r = await extractor.extract('https://example.com/', { fetcher });
    assert.equal(r.blocked, true);
    assert.ok(r.riskFlags.includes('captcha_detected'));
  });

  itAsync('marks blocked on 403', async () => {
    const fetcher = async () => ({ ok: false, statusCode: 403, html: 'Forbidden' });
    const r = await extractor.extract('https://example.com/', { fetcher });
    assert.equal(r.blocked, true);
    assert.equal(r.blockReason, 'access_blocked');
  });

  itAsync('reports SSRF block', async () => {
    const fetcher = async () => ({ ok: false, error: 'private host blocked', blocked: true });
    const r = await extractor.extract('http://localhost/', { fetcher });
    assert.equal(r.blocked, true);
    assert.ok(r.riskFlags.includes('ssrf_blocked'));
  });
});

describe('extractor.findContactLinks', () => {
  it('finds links by text "お問い合わせ"', () => {
    const html = '<a href="/contact">お問い合わせはこちら</a>';
    const links = extractor.findContactLinks(html, 'https://example.com/');
    assert.equal(links.length, 1);
    assert.equal(links[0].url, 'https://example.com/contact');
    assert.equal(links[0].matchedBy, 'text');
  });

  it('finds links by href "/contact"', () => {
    const html = '<a href="/contact-us">Click here</a>';
    const links = extractor.findContactLinks(html, 'https://example.com/');
    assert.equal(links.length, 1);
  });

  it('dedupes links pointing to the same URL', () => {
    const html = `
      <a href="/contact">問い合わせ</a>
      <a href="/contact">Contact</a>
    `;
    const links = extractor.findContactLinks(html, 'https://example.com/');
    assert.equal(links.length, 1);
  });
});

// ============================================================
// enricher (full pipeline)
// ============================================================
describe('enricher.detectIndustry', () => {
  it('detects SaaS from keywords', () => {
    const html = '<p>当社のSaaSプロダクトはクラウドベースのサブスクリプション型です。</p>';
    const r = enricher.detectIndustry(html);
    assert.equal(r.industry, 'SaaS');
    assert.ok(r.confidence > 0);
  });

  it('detects 製造 from keywords', () => {
    const html = '<p>製造業向けの工場自動化メーカーです。</p>';
    const r = enricher.detectIndustry(html);
    assert.equal(r.industry, '製造');
  });

  it('returns null for low keyword density', () => {
    const html = '<p>当社についてのページです。</p>';
    const r = enricher.detectIndustry(html);
    assert.equal(r.industry, null);
  });
});

describe('enricher.detectPrefecture', () => {
  it('detects 東京都', () => {
    assert.equal(enricher.detectPrefecture('〒100-0001 東京都千代田区...'), '東京都');
    assert.equal(enricher.detectPrefecture('北海道札幌市'), '北海道');
    assert.equal(enricher.detectPrefecture('大阪府大阪市'), '大阪府');
    assert.equal(enricher.detectPrefecture('神奈川県横浜市'), '神奈川県');
  });

  it('returns null when no prefecture found', () => {
    assert.equal(enricher.detectPrefecture('Tokyo, Japan'), null);
  });
});

describe('enricher.enrich (full pipeline)', () => {
  itAsync('enriches industry, employeeCount, revenue, formUrl from HTML', async () => {
    const html = `
      <html><body>
        <h1>当社について</h1>
        <p>当社はSaaSのクラウドサービスを提供しています。</p>
        <p>従業員数: 80名</p>
        <p>売上高: 50億円</p>
        <a href="/contact">お問い合わせ</a>
      </body></html>
    `;
    const r = await enricher.enrich({
      record: {
        companyName: '株式会社サンプル',
        url: 'https://example.com/',
      },
      html,
    });
    assert.equal(r.ok, true);
    assert.equal(r.record.industry, 'SaaS');
    assert.equal(r.record.employeeCount, 80);
    assert.equal(r.record.companySize, 'medium');
    assert.equal(r.record.revenueMillionYen, 5000);
    assert.equal(r.record.formUrl, 'https://example.com/contact');
    assert.ok(r.record.evidence.length >= 4);
  });

  itAsync('preserves existing values over HTML extraction', async () => {
    const html = '<p>従業員数: 999名</p>';
    const r = await enricher.enrich({
      record: {
        companyName: 'A',
        url: 'https://a.com/',
        employeeCount: 100, // 既存値を優先
      },
      html,
    });
    assert.equal(r.record.employeeCount, 100);
  });

  itAsync('classifies growthTrend as unknown for non-listed company', async () => {
    const r = await enricher.enrich({
      record: { companyName: 'A', url: 'https://a.com/' },
      html: '',
      revenueHistory: [
        { fiscalYear: 2023, revenueMillionYen: 100 },
        { fiscalYear: 2025, revenueMillionYen: 150 },
      ],
    });
    assert.equal(r.record.growthTrend, 'unknown');
  });

  itAsync('classifies growthTrend for listed company', async () => {
    const r = await enricher.enrich({
      record: { companyName: 'A', url: 'https://a.com/', listingStatus: 'listed' },
      html: '',
      revenueHistory: [
        { fiscalYear: 2023, revenueMillionYen: 100 },
        { fiscalYear: 2025, revenueMillionYen: 150 },
      ],
    });
    assert.equal(r.record.growthTrend, 'growing');
    assert.equal(r.record.growthTrendSource, 'edinet_ir');
  });
});

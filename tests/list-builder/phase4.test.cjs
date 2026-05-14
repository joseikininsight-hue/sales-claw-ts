'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'phase4-test-'));
process.env.SALES_CLAW_USER_DATA_DIR = tmpRoot;
process.env.SALES_CLAW_TEST_MODE = '1';

const dataDir = path.join(tmpRoot, 'data');
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({
  apiKeys: {
    houjinBangou: 'test_houjin_key',
    gBizInfo: 'test_gbiz_key',
  },
}));

const settings = require('../../dist-ts/src/settings-manager');
settings.invalidateSettingsCache();

const identityResolver = require('../../dist-ts/src/list-builder/identity-resolver');
const compliancePrecheck = require('../../dist-ts/src/list-builder/compliance-precheck');
const scorer = require('../../dist-ts/src/list-builder/qualification-scorer');

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
// identity-resolver
// ============================================================

describe('identity-resolver: corporate number path', () => {
  itAsync('resolves with gBizINFO when corporate number is provided', async () => {
    const gbizFetcher = async (url, apiKey) => {
      assert.match(url, /\/hojin\/1234567890123/);
      return {
        ok: true,
        json: {
          'hojin-infos': [{
            corporate_number: '1234567890123',
            name: '株式会社サンプル',
            location: '東京都千代田区丸の内1-1-1',
          }],
        },
      };
    };
    const r = await identityResolver.resolve(
      { companyName: 'サンプル', corporateNumber: '1234567890123', url: 'https://example.com' },
      { gbizFetcher }
    );
    assert.equal(r.ok, true);
    assert.equal(r.confidence, 'high');
    assert.equal(r.source, 'gbizinfo');
    assert.equal(r.record.corporateNumber, '1234567890123');
    assert.equal(r.record.officialName, '株式会社サンプル');
    assert.equal(r.record.prefecture, '東京都');
  });

  itAsync('keeps corporateNumber even when gBizINFO returns empty', async () => {
    const gbizFetcher = async () => ({ ok: true, json: { 'hojin-infos': [] } });
    const r = await identityResolver.resolve(
      { companyName: 'A', corporateNumber: '1234567890123' },
      { gbizFetcher }
    );
    assert.equal(r.ok, true);
    assert.equal(r.record.corporateNumber, '1234567890123');
  });
});

describe('identity-resolver: name search path', () => {
  itAsync('resolves uniquely when name search returns single record', async () => {
    const houjinFetcher = async () => ({
      ok: true,
      text: '"1","1234567890123","01","0","20260101","20260101","株式会社サンプル","","","JP","13","101","100-0001","東京都","千代田区","丸の内1-1-1"',
    });
    const r = await identityResolver.resolve(
      { companyName: '株式会社サンプル', prefecture: '東京都' },
      { houjinFetcher }
    );
    assert.equal(r.ok, true);
    assert.equal(r.confidence, 'high');
    assert.equal(r.source, 'houjin_bangou');
    assert.equal(r.record.corporateNumber, '1234567890123');
  });

  itAsync('filters by prefecture when multiple candidates returned', async () => {
    const csvLines = [
      '"1","1234567890123","01","0","20260101","20260101","株式会社サンプル","","","JP","13","101","","東京都","千代田区","1-1"',
      '"2","9999999999999","01","0","20260101","20260101","株式会社サンプル","","","JP","27","100","","大阪府","大阪市","2-2"',
    ];
    const houjinFetcher = async () => ({ ok: true, text: csvLines.join('\n') });
    const r = await identityResolver.resolve(
      { companyName: '株式会社サンプル', prefecture: '東京都' },
      { houjinFetcher }
    );
    assert.equal(r.ok, true);
    assert.equal(r.confidence, 'medium');
    assert.equal(r.record.corporateNumber, '1234567890123');
    assert.equal(r.record.prefecture, '東京都');
  });

  itAsync('returns candidates when filter cannot narrow down', async () => {
    const csvLines = [
      '"1","1234567890123","01","0","20260101","20260101","株式会社サンプル","","","JP","13","101","","東京都","千代田区","1-1"',
      '"2","9999999999999","01","0","20260101","20260101","株式会社サンプル","","","JP","13","100","","東京都","新宿区","2-2"',
    ];
    const houjinFetcher = async () => ({ ok: true, text: csvLines.join('\n') });
    const r = await identityResolver.resolve(
      { companyName: '株式会社サンプル', prefecture: '東京都' },
      { houjinFetcher }
    );
    assert.equal(r.ok, true);
    assert.equal(r.confidence, 'low');
    assert.ok(Array.isArray(r.candidates));
    assert.equal(r.candidates.length, 2);
  });
});

describe('identity-resolver: URL only fallback', () => {
  itAsync('extracts domainRoot when only URL is given (no APIs)', async () => {
    const r = await identityResolver.resolve(
      { url: 'https://www.example.co.jp/about' },
      // 公式 API は呼ばれない (companyName / corporateNumber が無いので)
    );
    // 公式 API は試行されない、URL のみで domainRoot 確定
    assert.equal(r.ok, true);
    assert.equal(r.record.domainRoot, 'example.co.jp');
    assert.equal(r.confidence, 'low');
  });

  itAsync('returns failure when no information is sufficient', async () => {
    const r = await identityResolver.resolve({});
    assert.equal(r.ok, false);
  });
});

describe('identity-resolver: corporate number with name verification (Major 2)', () => {
  itAsync('elevates confidence to high when houjin name matches', async () => {
    // gBizINFO 空、houjin で名前一致 → confidence high
    const gbizFetcher = async () => ({ ok: true, json: { 'hojin-infos': [] } });
    const houjinFetcher = async () => ({
      ok: true,
      text: '"1","1234567890123","01","0","20260101","20260101","株式会社サンプル","","","JP","13","101","","東京都","千代田区","1-1"',
    });
    const r = await identityResolver.resolve(
      { companyName: '株式会社サンプル', corporateNumber: '1234567890123' },
      { gbizFetcher, houjinFetcher }
    );
    assert.equal(r.ok, true);
    assert.equal(r.source, 'houjin_bangou');
    assert.equal(r.confidence, 'high');
  });

  itAsync('flags warning when name does not match looked-up corporate number', async () => {
    const gbizFetcher = async () => ({ ok: true, json: { 'hojin-infos': [] } });
    const houjinFetcher = async () => ({
      ok: true,
      text: '"1","1234567890123","01","0","20260101","20260101","株式会社全然違う名前","","","JP","13","101","","東京都","千代田区","1-1"',
    });
    const r = await identityResolver.resolve(
      { companyName: '株式会社サンプル', corporateNumber: '1234567890123' },
      { gbizFetcher, houjinFetcher }
    );
    assert.equal(r.ok, true);
    assert.equal(r.confidence, 'low');
    assert.match(r.warning, /name does not match/);
  });
});

describe('identity-resolver: filterCandidates fallback (Major 1)', () => {
  itAsync('falls back to prefecture-only filter when name filter empties', async () => {
    // 入力名 'サンプル' に対して、候補の officialName は別物だが prefecture は一致
    const csvLines = [
      '"1","1234567890123","01","0","20260101","20260101","株式会社サンプル工業","","","JP","13","101","","東京都","千代田区","1-1"',
      '"2","9999999999999","01","0","20260101","20260101","株式会社サンプル研究所","","","JP","13","100","","東京都","新宿区","2-2"',
      '"3","8888888888888","01","0","20260101","20260101","株式会社サンプル販売","","","JP","27","100","","大阪府","大阪市","3-3"',
    ];
    const houjinFetcher = async () => ({ ok: true, text: csvLines.join('\n') });
    const r = await identityResolver.resolve(
      { companyName: 'サンプル', prefecture: '東京都' },
      { houjinFetcher }
    );
    assert.equal(r.ok, true);
    assert.equal(r.confidence, 'low');
    // 大阪府の候補は除外されているはず (prefecture フィルタが効いている)
    assert.equal(r.candidates.length, 2);
    assert.ok(r.candidates.every((c) => c.prefecture === '東京都'));
  });
});

describe('identity-resolver: filterCandidates', () => {
  it('filters by prefecture exact match', () => {
    const candidates = [
      { officialName: '株式会社A', prefecture: '東京都' },
      { officialName: '株式会社A', prefecture: '大阪府' },
    ];
    const filtered = identityResolver.filterCandidates(candidates, {
      companyName: '株式会社A',
      prefecture: '東京都',
    });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].prefecture, '東京都');
  });

  it('filters by name normalized match', () => {
    const candidates = [
      { officialName: '株式会社サンプル', prefecture: '東京都' },
      { officialName: '株式会社サンプル別商号', prefecture: '東京都' },
    ];
    const filtered = identityResolver.filterCandidates(candidates, {
      companyName: 'サンプル',
      prefecture: '東京都',
    });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].officialName, '株式会社サンプル');
  });
});

// ============================================================
// compliance-precheck
// ============================================================

describe('compliance-precheck.analyze: status code blocking', () => {
  it('flags 403 as access_blocked', () => {
    const r = compliancePrecheck.analyze({ statusCode: 403, html: '' });
    assert.equal(r.blocked, true);
    assert.ok(r.riskFlags.includes('access_blocked'));
  });

  it('flags 429 as rate limited', () => {
    const r = compliancePrecheck.analyze({ statusCode: 429, html: '' });
    assert.equal(r.blocked, true);
    assert.equal(r.blockReason, 'rate_limited');
  });

  it('treats 200 OK with no risk html as fine', () => {
    const r = compliancePrecheck.analyze({ statusCode: 200, html: '<html><body><form></form></body></html>' });
    assert.equal(r.blocked, false);
    assert.equal(r.formType, 'general_contact');
  });
});

describe('compliance-precheck.analyze: sales prohibition', () => {
  it('detects 営業お断り', () => {
    const html = '<p>営業目的のお問い合わせはご遠慮ください。</p>';
    const r = compliancePrecheck.analyze({ html, statusCode: 200 });
    assert.ok(r.riskFlags.includes('sales_prohibited'));
  });

  it('detects 勧誘ご遠慮', () => {
    const html = '<p>勧誘目的のご連絡はご遠慮ください</p>';
    const r = compliancePrecheck.analyze({ html, statusCode: 200 });
    assert.ok(r.riskFlags.includes('sales_prohibited'));
  });

  it('detects English no-sales notice', () => {
    const html = '<p>No solicitation please</p>';
    const r = compliancePrecheck.analyze({ html, statusCode: 200 });
    assert.ok(r.riskFlags.includes('sales_prohibited'));
  });
});

describe('compliance-precheck.analyze: form type detection', () => {
  it('classifies recruit form', () => {
    const html = '<form action="/entry"><h1>新卒採用 応募フォーム</h1></form>';
    const r = compliancePrecheck.analyze({ html, statusCode: 200 });
    assert.equal(r.formType, 'recruit');
    assert.ok(r.riskFlags.includes('recruit_only'));
  });

  it('classifies support form', () => {
    const html = '<form><h1>お客様サポート専用窓口</h1></form>';
    const r = compliancePrecheck.analyze({ html, statusCode: 200 });
    assert.equal(r.formType, 'support');
  });

  it('classifies IR form', () => {
    const html = '<form><h2>IRに関するお問い合わせ</h2></form>';
    const r = compliancePrecheck.analyze({ html, statusCode: 200 });
    assert.equal(r.formType, 'ir');
  });

  it('classifies general contact when no exclusions', () => {
    const html = '<form><label>会社名</label><input/><label>お問い合わせ内容</label><textarea></textarea></form>';
    const r = compliancePrecheck.analyze({ html, statusCode: 200 });
    assert.equal(r.formType, 'general_contact');
  });
});

describe('compliance-precheck.analyze: blocking detectors', () => {
  it('detects reCAPTCHA', () => {
    const html = '<div class="g-recaptcha" data-sitekey="..."></div>';
    const r = compliancePrecheck.analyze({ html, statusCode: 200 });
    assert.equal(r.blocked, true);
    assert.ok(r.riskFlags.includes('captcha_detected'));
  });

  it('detects login required', () => {
    const html = '<form action="/login" id="signin"></form>';
    const r = compliancePrecheck.analyze({ html, statusCode: 200 });
    assert.equal(r.blocked, true);
    assert.ok(r.riskFlags.includes('login_required'));
  });

  it('detects Cloudflare turnstile', () => {
    const html = '<div class="cf-turnstile"></div>';
    const r = compliancePrecheck.analyze({ html, statusCode: 200 });
    assert.equal(r.blocked, true);
  });
});

describe('compliance-precheck.parseRobotsTxt', () => {
  it('parses Disallow paths under User-agent: *', () => {
    const text = `
User-agent: *
Disallow: /admin
Disallow: /private/

User-agent: Googlebot
Disallow: /not-this
`;
    const r = compliancePrecheck.parseRobotsTxt(text);
    assert.deepEqual(r.disallowedPaths, ['/admin', '/private/']);
  });

  it('parses Allow and Crawl-delay', () => {
    const text = `User-agent: *\nAllow: /public\nCrawl-delay: 5`;
    const r = compliancePrecheck.parseRobotsTxt(text);
    assert.deepEqual(r.allowedPaths, ['/public']);
    assert.equal(r.crawlDelay, 5);
  });

  it('handles comments and empty lines', () => {
    const text = `# this is a comment\nUser-agent: *\n# another\nDisallow: /x`;
    const r = compliancePrecheck.parseRobotsTxt(text);
    assert.deepEqual(r.disallowedPaths, ['/x']);
  });

  it('returns empty for invalid input', () => {
    assert.deepEqual(compliancePrecheck.parseRobotsTxt(null).disallowedPaths, []);
    assert.deepEqual(compliancePrecheck.parseRobotsTxt('').disallowedPaths, []);
  });
});

describe('compliance-precheck.isPathAllowed', () => {
  it('blocks path matching disallow rule', () => {
    const robots = { disallowedPaths: ['/admin'], allowedPaths: [] };
    const r = compliancePrecheck.isPathAllowed('https://example.com/admin/users', robots);
    assert.equal(r.allowed, false);
  });

  it('allows path that does not match any rule', () => {
    const robots = { disallowedPaths: ['/admin'], allowedPaths: [] };
    const r = compliancePrecheck.isPathAllowed('https://example.com/about', robots);
    assert.equal(r.allowed, true);
  });

  it('allows when more specific Allow overrides Disallow', () => {
    const robots = { disallowedPaths: ['/'], allowedPaths: ['/public/api'] };
    const r = compliancePrecheck.isPathAllowed('https://example.com/public/api/v1', robots);
    assert.equal(r.allowed, true);
  });

  it('handles wildcard patterns', () => {
    const robots = { disallowedPaths: ['/private/*/secret'], allowedPaths: [] };
    const r1 = compliancePrecheck.isPathAllowed('https://example.com/private/foo/secret', robots);
    assert.equal(r1.allowed, false);
    const r2 = compliancePrecheck.isPathAllowed('https://example.com/private/foo/public', robots);
    assert.equal(r2.allowed, true);
  });
});

// ============================================================
// qualification-scorer
// ============================================================

describe('qualification-scorer: matchesEmployeeRange', () => {
  it('matches numeric range', () => {
    assert.equal(scorer.matchesEmployeeRange(50, ['11-50']), true);
    assert.equal(scorer.matchesEmployeeRange(60, ['51-100']), true);
    assert.equal(scorer.matchesEmployeeRange(60, ['11-50']), false);
  });

  it('handles 5001+ range', () => {
    assert.equal(scorer.matchesEmployeeRange(10000, ['5001+']), true);
    assert.equal(scorer.matchesEmployeeRange(5000, ['5001+']), false);
  });

  it('returns false for invalid input', () => {
    assert.equal(scorer.matchesEmployeeRange(null, ['1-10']), false);
    assert.equal(scorer.matchesEmployeeRange(50, []), false);
  });
});

describe('qualification-scorer: matchesRevenueRange', () => {
  it('matches revenue ranges (million yen)', () => {
    assert.equal(scorer.matchesRevenueRange(50, ['under_100m']), true);     // 5,000万円
    assert.equal(scorer.matchesRevenueRange(500, ['100m-1b']), true);       // 5億
    assert.equal(scorer.matchesRevenueRange(5000, ['1b-10b']), true);       // 50億
    assert.equal(scorer.matchesRevenueRange(50000, ['10b-100b']), true);    // 500億
    assert.equal(scorer.matchesRevenueRange(200000, ['over_100b']), true);  // 2000億
  });

  it('rejects boundary cases correctly', () => {
    assert.equal(scorer.matchesRevenueRange(100, ['under_100m']), false);
    assert.equal(scorer.matchesRevenueRange(99, ['100m-1b']), false);
  });
});

describe('qualification-scorer: score (full record)', () => {
  it('produces high fitScore for full match (>= 70)', () => {
    const record = {
      industry: 'SaaS',
      prefecture: '東京都',
      employeeCount: 80,
      formType: 'general_contact',
      formUrl: 'https://example.com/contact',
      corporateNumber: '1234567890123',
      domainRoot: 'example.com',
      businessSummary: 'クラウドベースのSaaSを提供',
      priorContactCount: 0,
    };
    const criteria = {
      industries: ['SaaS', 'SIer'],
      prefectures: ['東京都'],
      employeeRanges: ['51-100'],
      keywords: ['クラウド', 'SaaS'],
    };
    const r = scorer.score(record, criteria);
    assert.ok(r.fitScore >= 70, `expected >= 70, got ${r.fitScore}`);
    assert.equal(r.recommendedAction, 'add');
    assert.ok(r.fitReasons.length > 0);
  });

  it('produces lower fitScore for partial match', () => {
    const record = {
      industry: 'SaaS',
      prefecture: '北海道',
      employeeCount: 1000,
      formUrl: '',
      corporateNumber: '',
      priorContactCount: 0,
    };
    const criteria = {
      industries: ['SaaS'],
      prefectures: ['東京都'],
      employeeRanges: ['1-10'],
    };
    const r = scorer.score(record, criteria);
    assert.ok(r.fitScore < 50);
    assert.equal(r.recommendedAction, 'skip');
  });

  it('immediately sets skip when sales_prohibited risk flag is present', () => {
    const record = {
      industry: 'SaaS',
      prefecture: '東京都',
      employeeCount: 80,
      formUrl: 'https://example.com/contact',
      corporateNumber: '1234567890123',
      domainRoot: 'example.com',
      priorContactCount: 0,
      riskFlags: ['sales_prohibited'],
    };
    const r = scorer.score(record, {
      industries: ['SaaS'], prefectures: ['東京都'], employeeRanges: ['51-100'],
    });
    assert.equal(r.fitScore, 0);
    assert.equal(r.recommendedAction, 'skip');
  });

  it('immediately sets skip for captcha_detected', () => {
    const record = { riskFlags: ['captcha_detected'] };
    const r = scorer.score(record, {});
    assert.equal(r.recommendedAction, 'skip');
  });

  it('does not award form points for recruit form', () => {
    const recordRecruit = {
      formUrl: 'https://example.com/entry',
      formType: 'recruit',
    };
    const r = scorer.score(recordRecruit, {});
    // recruit form では formAvailable 加点なし
    assert.equal(r.fitScore, 15); // noPriorContact のみ
  });

  it('marks review when 50 <= fitScore < 70', () => {
    const record = {
      industry: 'SaaS',
      prefecture: '東京都',
      employeeCount: 80,
      formUrl: 'https://example.com/contact',
      formType: 'general_contact',
      priorContactCount: 0,
    };
    const r = scorer.score(record, {
      industries: ['SaaS'], prefectures: ['東京都'], employeeRanges: ['51-100'],
    });
    // 業種(20) + 地域(10) + 規模(15) + フォーム(15) + 過去(15) = 75 → add
    assert.equal(r.recommendedAction, 'add');
  });

  it('handles null record gracefully', () => {
    const r = scorer.score(null, {});
    assert.equal(r.fitScore, 0);
    assert.equal(r.recommendedAction, 'skip');
  });
});

describe('qualification-scorer: scoreAll', () => {
  it('scores multiple records and merges into each', () => {
    const records = [
      { industry: 'SaaS', prefecture: '東京都', priorContactCount: 0 },
      { industry: 'SIer', prefecture: '大阪府', priorContactCount: 0 },
    ];
    const criteria = { industries: ['SaaS'], prefectures: ['東京都'] };
    const results = scorer.scoreAll(records, criteria);
    assert.equal(results.length, 2);
    assert.ok(results[0].fitScore > results[1].fitScore);
    assert.ok(Array.isArray(results[0].fitReasons));
  });
});

// クリーンアップ
process.on('exit', () => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}
});

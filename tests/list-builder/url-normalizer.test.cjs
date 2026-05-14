'use strict';

const assert = require('node:assert/strict');
const urlNormalizer = require('../../dist-ts/src/list-builder/url-normalizer');

function describe(n, f) { console.log('\n=== ' + n + ' ==='); f(); }
function it(n, f) {
  try { f(); console.log('  OK  ' + n); }
  catch (e) { console.error('  FAIL ' + n + ' — ' + e.message); process.exitCode = 1; }
}

describe('url-normalizer.normalize() basic cases', () => {
  it('normalizes scheme to https by default', () => {
    const r = urlNormalizer.normalize('http://example.com');
    assert.equal(r.normalized, 'https://example.com/');
    assert.equal(r.valid, true);
  });

  it('strips www. subdomain prefix', () => {
    const r = urlNormalizer.normalize('https://www.example.co.jp/about');
    assert.equal(r.host, 'example.co.jp');
    assert.equal(r.normalized, 'https://example.co.jp/about');
  });

  it('strips m. and amp. prefixes', () => {
    assert.equal(urlNormalizer.normalize('https://m.example.com/x').host, 'example.com');
    assert.equal(urlNormalizer.normalize('https://amp.example.com/x').host, 'example.com');
    assert.equal(urlNormalizer.normalize('https://sp.example.com/x').host, 'example.com');
  });

  it('removes index.html / index.php / index.htm suffix', () => {
    assert.equal(urlNormalizer.normalize('https://example.com/index.html').path, '/');
    assert.equal(urlNormalizer.normalize('https://example.com/about/index.html').path, '/about');
    assert.equal(urlNormalizer.normalize('https://example.com/foo/index.php').path, '/foo');
  });

  it('removes trailing slash except root', () => {
    assert.equal(urlNormalizer.normalize('https://example.com/').path, '/');
    assert.equal(urlNormalizer.normalize('https://example.com/about/').path, '/about');
    assert.equal(urlNormalizer.normalize('https://example.com/about/team/').path, '/about/team');
  });

  it('compresses multiple slashes', () => {
    assert.equal(urlNormalizer.normalize('https://example.com//foo///bar').path, '/foo/bar');
  });

  it('strips fragments', () => {
    const r = urlNormalizer.normalize('https://example.com/foo#section1');
    assert.equal(r.normalized, 'https://example.com/foo');
  });

  it('removes UTM tracking params', () => {
    const r = urlNormalizer.normalize('https://example.com/foo?utm_source=ad&utm_medium=cpc&id=42');
    assert.equal(r.normalized, 'https://example.com/foo?id=42');
  });

  it('removes gclid / fbclid / msclkid', () => {
    const r = urlNormalizer.normalize('https://example.com/?gclid=abc&fbclid=xyz&msclkid=1');
    assert.equal(r.normalized, 'https://example.com/');
  });

  it('preserves non-tracking query params and sorts them alphabetically', () => {
    const r = urlNormalizer.normalize('https://example.com/?z=1&a=2&m=3');
    assert.equal(r.normalized, 'https://example.com/?a=2&m=3&z=1');
  });

  it('lowercases host but preserves path case', () => {
    const r = urlNormalizer.normalize('https://EXAMPLE.COM/About/Team');
    assert.equal(r.host, 'example.com');
    assert.equal(r.path, '/About/Team');
  });

  it('returns invalid for malformed input', () => {
    assert.equal(urlNormalizer.normalize('').valid, false);
    assert.equal(urlNormalizer.normalize('not a url at all !!!').valid, false);
    assert.equal(urlNormalizer.normalize('mailto:foo@example.com').valid, false);
    assert.equal(urlNormalizer.normalize('javascript:alert(1)').valid, false);
  });

  it('adds https scheme when missing', () => {
    const r = urlNormalizer.normalize('example.com/about');
    assert.equal(r.normalized, 'https://example.com/about');
    assert.equal(r.valid, true);
  });

  it('drops standard ports but keeps non-standard', () => {
    assert.equal(urlNormalizer.normalize('https://example.com:443/').normalized, 'https://example.com/');
    assert.equal(urlNormalizer.normalize('http://example.com:80/', { preferHttps: false }).normalized, 'http://example.com/');
    assert.equal(urlNormalizer.normalize('https://example.com:8080/').normalized, 'https://example.com:8080/');
  });
});

describe('url-normalizer.extractDomainRoot', () => {
  it('extracts eTLD+1 for .com / .jp', () => {
    assert.equal(urlNormalizer.extractDomainRoot('foo.example.com'), 'example.com');
    assert.equal(urlNormalizer.extractDomainRoot('example.com'), 'example.com');
  });

  it('handles JP shared SLDs (co.jp / ne.jp / or.jp etc.)', () => {
    assert.equal(urlNormalizer.extractDomainRoot('foo.example.co.jp'), 'example.co.jp');
    assert.equal(urlNormalizer.extractDomainRoot('a.b.example.ne.jp'), 'example.ne.jp');
    assert.equal(urlNormalizer.extractDomainRoot('test.example.or.jp'), 'example.or.jp');
    assert.equal(urlNormalizer.extractDomainRoot('example.ac.jp'), 'example.ac.jp');
  });

  it('handles international shared SLDs (co.uk / com.au)', () => {
    assert.equal(urlNormalizer.extractDomainRoot('shop.example.co.uk'), 'example.co.uk');
    assert.equal(urlNormalizer.extractDomainRoot('foo.example.com.au'), 'example.com.au');
  });

  it('returns input as-is for single-label hosts', () => {
    assert.equal(urlNormalizer.extractDomainRoot('localhost'), 'localhost');
  });
});

describe('url-normalizer.isSameUrl / isSameDomain', () => {
  it('detects same URL with scheme/www/trailing-slash variations', () => {
    assert.equal(
      urlNormalizer.isSameUrl('http://www.example.com/about', 'https://example.com/about/'),
      true
    );
    assert.equal(
      urlNormalizer.isSameUrl('https://example.com/index.html', 'https://example.com'),
      true
    );
    assert.equal(
      urlNormalizer.isSameUrl('https://example.com/?utm_source=foo', 'https://example.com/'),
      true
    );
  });

  it('detects different URLs', () => {
    assert.equal(
      urlNormalizer.isSameUrl('https://example.com/foo', 'https://example.com/bar'),
      false
    );
    assert.equal(
      urlNormalizer.isSameUrl('https://example.com', 'https://other.com'),
      false
    );
  });

  it('detects same domain across different paths', () => {
    assert.equal(
      urlNormalizer.isSameDomain('https://www.example.co.jp/about', 'https://news.example.co.jp/article/1'),
      true
    );
    assert.equal(
      urlNormalizer.isSameDomain('https://example.com', 'https://otherbrand.com'),
      false
    );
  });

  it('returns false for invalid inputs', () => {
    assert.equal(urlNormalizer.isSameUrl('', ''), false);
    assert.equal(urlNormalizer.isSameDomain('mailto:a@b.c', 'https://b.c'), false);
  });
});

describe('url-normalizer.normalize() Japanese / punycode', () => {
  it('lowercases host with mixed case from input', () => {
    const r = urlNormalizer.normalize('HTTPS://Example.Co.JP/');
    assert.equal(r.host, 'example.co.jp');
    assert.equal(r.domainRoot, 'example.co.jp');
  });

  it('treats punycode and unicode forms of the same host as identical', () => {
    // Node の URL クラスが Unicode → punycode 自動変換するので、
    // どちらの入力でも同じ正規化済み URL になることを検証する
    const punycode = urlNormalizer.normalize('https://xn--wgv71a119e.jp/');
    const unicode = urlNormalizer.normalize('https://日本語.jp/');
    assert.equal(punycode.valid, true);
    assert.equal(unicode.valid, true);
    assert.equal(punycode.host, unicode.host);
    assert.equal(punycode.normalized, unicode.normalized);
  });

  it('isSameDomain matches punycode and unicode forms', () => {
    assert.equal(
      urlNormalizer.isSameDomain('https://xn--wgv71a119e.jp/', 'https://日本語.jp/about'),
      true
    );
  });
});

describe('url-normalizer.normalize() query encoding integrity', () => {
  it('does not double-encode already-encoded query values', () => {
    // 'q=日本語' → URL エンコード後は '%E6%97%A5%E6%9C%AC%E8%AA%9E'
    // 二重エンコードバグでは '%25E6%2597%25A5...' になってしまう
    const r = urlNormalizer.normalize('https://example.com/search?q=%E6%97%A5%E6%9C%AC%E8%AA%9E');
    assert.match(r.normalized, /q=%E6%97%A5%E6%9C%AC%E8%AA%9E/);
    assert.doesNotMatch(r.normalized, /%25E6/);
  });

  it('preserves non-tracking source/ref params (not stripped)', () => {
    // レビュー指摘で 'source' / 'ref' は誤除去防止のためトラッキング対象外にした
    const r = urlNormalizer.normalize('https://example.com/news?source=press_release');
    assert.equal(r.normalized, 'https://example.com/news?source=press_release');
  });
});

// URL Normalizer — 重複検出・dedupe のための URL 正規化ユーティリティ
// 同一企業を指す URL のゆらぎを吸収するために使う。

export interface NormalizeOptions {
  preferHttps?: boolean;
}

export interface NormalizeResult {
  /** 正規化されたフル URL */
  normalized: string;
  /** www 除去後のホスト名 */
  host: string;
  /** 正規化済みパス */
  path: string;
  /** eTLD+1 (重複検出主キー) */
  domainRoot: string;
  /** 解析成功か */
  valid: boolean;
  /** 元の入力 */
  original: string;
}

// 日本の共有ドメイン (co.jp, ne.jp など)。これらの下を eTLD+1 として扱う。
const JP_SLD_SUFFIXES = new Set<string>([
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp',
  'lg.jp', 'ed.jp', 'gr.jp', 'ad.jp', 'geo.jp',
]);

const INTERNATIONAL_SLD_SUFFIXES = new Set<string>([
  'com.au', 'com.br', 'co.uk', 'com.cn', 'co.kr',
  'com.tw', 'com.hk', 'com.sg', 'com.my', 'co.id',
  'co.in', 'co.th', 'com.mx', 'com.ar',
]);

const TRACKING_QUERY_KEYS = new Set<string>([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'utm_id', 'utm_name', 'utm_brand', 'utm_social', 'utm_creative',
  'gclid', 'gclsrc', 'dclid', 'fbclid', 'msclkid', 'mc_cid', 'mc_eid',
  'yclid', 'wbraid', 'gbraid', '_ga', '_gl',
  'ref_src', 'ref_url',
]);

const STRIPPABLE_SUBDOMAIN_PREFIXES = ['www.', 'm.', 'mobile.', 'amp.', 'sp.'];

const INDEX_FILENAMES = new Set<string>([
  'index.html', 'index.htm', 'index.php', 'index.aspx', 'index.jsp',
  'default.html', 'default.htm', 'default.aspx',
]);

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function stripSubdomainPrefix(host: string | undefined | null): string {
  if (!host) return '';
  let result = host.toLowerCase();
  for (const prefix of STRIPPABLE_SUBDOMAIN_PREFIXES) {
    if (result.startsWith(prefix)) {
      result = result.slice(prefix.length);
      break;
    }
  }
  return result;
}

/** eTLD+1 (domainRoot) を抽出 */
export function extractDomainRoot(host: string | undefined | null): string {
  if (!host) return '';
  const lower = host.toLowerCase();
  const parts = lower.split('.');
  if (parts.length < 2) return lower;

  // 多段共有サフィックスのチェック (co.jp, com.au 等)
  if (parts.length >= 3) {
    const lastTwo = parts.slice(-2).join('.');
    if (JP_SLD_SUFFIXES.has(lastTwo) || INTERNATIONAL_SLD_SUFFIXES.has(lastTwo)) {
      return parts.slice(-3).join('.');
    }
  }

  return parts.slice(-2).join('.');
}

function normalizePath(rawPath: string | undefined | null): string {
  if (!rawPath || rawPath === '/') return '/';
  let result = rawPath.replace(/\/+/g, '/');
  const segments = result.split('/');
  const last = segments[segments.length - 1].toLowerCase();
  if (INDEX_FILENAMES.has(last)) {
    segments.pop();
    result = segments.join('/') || '/';
  }
  if (result.length > 1 && result.endsWith('/')) {
    result = result.slice(0, -1);
  }
  return result;
}

function normalizeQuery(searchParams: URLSearchParams | null | undefined): string {
  if (!searchParams) return '';
  const remaining: Array<[string, string]> = [];
  for (const [key, value] of searchParams.entries()) {
    if (TRACKING_QUERY_KEYS.has(key.toLowerCase())) continue;
    remaining.push([key, value]);
  }
  if (remaining.length === 0) return '';
  remaining.sort((a: any, b: any) => a[0].localeCompare(b[0]));
  const reconstructed = new URLSearchParams();
  for (const [k, v] of remaining) {
    reconstructed.append(k, v);
  }
  return '?' + reconstructed.toString();
}

/** メイン関数: URL を正規化して構造化された情報を返す */
export function normalize(input: unknown, opts: NormalizeOptions = {}): NormalizeResult {
  const preferHttps = opts.preferHttps !== false;
  const original = isString(input) ? input.trim() : '';

  if (!original) {
    return { normalized: '', host: '', path: '', domainRoot: '', valid: false, original };
  }

  let candidate = original;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(candidate)) {
    candidate = 'https://' + candidate;
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return { normalized: '', host: '', path: '', domainRoot: '', valid: false, original };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { normalized: '', host: '', path: '', domainRoot: '', valid: false, original };
  }

  let host = parsed.hostname.toLowerCase();
  host = stripSubdomainPrefix(host);

  const path = normalizePath(parsed.pathname);
  const query = normalizeQuery(parsed.searchParams);
  const protocol = preferHttps ? 'https:' : parsed.protocol;

  const isStandardPort = (
    (protocol === 'https:' && (parsed.port === '' || parsed.port === '443')) ||
    (protocol === 'http:' && (parsed.port === '' || parsed.port === '80'))
  );
  const portSuffix = isStandardPort ? '' : (parsed.port ? `:${parsed.port}` : '');

  const normalized = `${protocol}//${host}${portSuffix}${path}${query}`;
  const domainRoot = extractDomainRoot(host);

  return {
    normalized,
    host,
    path,
    domainRoot,
    valid: true,
    original,
  };
}

/** 2 つの URL が同じドメインルートに属するかを判定 */
export function isSameDomain(a: unknown, b: unknown): boolean {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na.valid || !nb.valid) return false;
  return na.domainRoot === nb.domainRoot && na.domainRoot !== '';
}

/** 2 つの URL が完全に同じレコードを指しているかを判定 (dedupe Layer 2) */
export function isSameUrl(a: unknown, b: unknown): boolean {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na.valid || !nb.valid) return false;
  return na.normalized === nb.normalized;
}

module.exports = {
  normalize,
  isSameDomain,
  isSameUrl,
  extractDomainRoot,
  _internal: {
    stripSubdomainPrefix,
    normalizePath,
    normalizeQuery,
    JP_SLD_SUFFIXES,
    TRACKING_QUERY_KEYS,
  },
};

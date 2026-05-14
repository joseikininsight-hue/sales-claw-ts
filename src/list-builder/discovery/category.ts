'use strict';

// Category Discovery
//
// CategorySearchParams を SerpApi 検索クエリに変換し、段階的緩和ロジックを持つ。
//
// 要件§5.3:
//   - 業種 × 都道府県 × 従業員数 × 売上 × 成長性 × キーワード
//   - 指定件数（limit）に達するまで段階的にクエリを緩める
//   - 緩和ログを返して UI に表示する
//   - growthTrend は上場企業のみ EDINET で厳密判定。非上場は除外しない
//
// 純粋関数として実装。SerpApi 呼び出しは opts.searchInvoker で DI する。

// 従業員数レンジを自然言語に変換
const EMPLOYEE_RANGE_LABELS = {
  '1-10': '1-10名',
  '11-50': '11-50名',
  '51-100': '51-100名',
  '101-300': '101-300名',
  '301-1000': '301-1000名',
  '1001-5000': '1001-5000名',
  '5001+': '5001名以上',
};

const REVENUE_RANGE_LABELS = {
  'under_100m': '売上1億未満',
  '100m-1b': '売上1〜10億',
  '1b-10b': '売上10〜100億',
  '10b-100b': '売上100〜1000億',
  'over_100b': '売上1000億超',
};

// 検索クエリ生成のチューニング定数
//
// SerpApi のリクエスト数が爆発しないように、cross-product の総数を制限する。
// 5 業種 × 47 都道府県 = 235 だと費用面で重いため、上限超過時はサンプリングする。
const MAX_CROSS_PRODUCT = 30;
// クエリ末尾に追加するキーワード数（クエリ長制限のため）
const MAX_KEYWORDS_PER_QUERY = 3;

// CategorySearchParams から検索クエリ群を構築
//
// 戻り値: 検索クエリの配列（複数のクエリを並列実行する想定）
//         クロス積が MAX_CROSS_PRODUCT を超える場合は、上から順に切り詰める。
function buildQueries(params) {
  if (!params || typeof params !== 'object') return [];
  const industries = Array.isArray(params.industries) ? params.industries : [];
  const prefectures = Array.isArray(params.prefectures) ? params.prefectures : [];
  const employeeRanges = Array.isArray(params.employeeRanges) ? params.employeeRanges : [];
  const revenueRanges = Array.isArray(params.revenueRanges) ? params.revenueRanges : [];
  const keywords = Array.isArray(params.keywords) ? params.keywords : [];

  const queries: any[] = [];

  const industryList = industries.length > 0 ? industries : [''];
  const prefectureList = prefectures.length > 0 ? prefectures : [''];

  for (const industry of industryList) {
    for (const prefecture of prefectureList) {
      if (queries.length >= MAX_CROSS_PRODUCT) break;
      const parts: any[] = [];
      if (prefecture) parts.push(prefecture);
      if (industry) parts.push(industry);
      parts.push('企業');
      if (employeeRanges.length > 0) {
        parts.push('従業員' + EMPLOYEE_RANGE_LABELS[employeeRanges[0]]);
      } else if (revenueRanges.length > 0) {
        parts.push(REVENUE_RANGE_LABELS[revenueRanges[0]]);
      }
      for (const kw of keywords.slice(0, MAX_KEYWORDS_PER_QUERY)) {
        parts.push(kw);
      }
      queries.push(parts.join(' '));
    }
    if (queries.length >= MAX_CROSS_PRODUCT) break;
  }

  return queries;
}

// 段階的緩和: フィルタを段階的に弱めて、各段階のクエリを返す。
//
// 戻り値: Array<{ step: number, description: string, queries: string[] }>
function buildLooseningSteps(params) {
  if (!params) return [];

  const original = buildQueries(params);
  const steps = [
    { step: 0, description: '初期条件: ' + summarize(params), queries: original },
  ];

  // Step 1: 成長性条件を緩める
  if (params.growthTrend && params.growthTrend !== 'any') {
    const relaxed = { ...params, growthTrend: 'any' };
    steps.push({
      step: 1,
      description: '成長性条件を参考条件に変更',
      queries: buildQueries(relaxed),
    });
  }

  // Step 2: 従業員数レンジを拡大
  if (Array.isArray(params.employeeRanges) && params.employeeRanges.length > 0) {
    const expanded = expandEmployeeRanges(params.employeeRanges);
    if (expanded.length > params.employeeRanges.length) {
      const relaxed = { ...params, employeeRanges: expanded, growthTrend: 'any' };
      steps.push({
        step: 2,
        description: '従業員数レンジを拡大: ' + expanded.join(', '),
        queries: buildQueries(relaxed),
      });
    }
  }

  // Step 3: キーワードを nice-to-have に変更（クエリから除外）
  if (Array.isArray(params.keywords) && params.keywords.length > 0) {
    const relaxed = { ...params, keywords: [], growthTrend: 'any' };
    steps.push({
      step: 3,
      description: 'キーワード一致を nice-to-have に変更',
      queries: buildQueries(relaxed),
    });
  }

  return steps;
}

function summarize(params) {
  const bits: any[] = [];
  if (params.prefectures?.length) bits.push(params.prefectures.join('/'));
  if (params.industries?.length) bits.push(params.industries.join('/'));
  if (params.employeeRanges?.length) bits.push('従業員' + params.employeeRanges.join(','));
  if (params.revenueRanges?.length) bits.push(params.revenueRanges.map((r: any) => REVENUE_RANGE_LABELS[r] || r).join(','));
  if (params.growthTrend && params.growthTrend !== 'any') bits.push(params.growthTrend);
  if (params.keywords?.length) bits.push('KW: ' + params.keywords.join(','));
  return bits.join(' × ');
}

// 与えられた employeeRanges を 1 段階拡大する
function expandEmployeeRanges(ranges) {
  const order = ['1-10', '11-50', '51-100', '101-300', '301-1000', '1001-5000', '5001+'];
  const expanded = new Set(ranges);
  for (const r of ranges) {
    const idx = order.indexOf(r);
    if (idx === -1) continue;
    if (idx > 0) expanded.add(order[idx - 1]);
    if (idx < order.length - 1) expanded.add(order[idx + 1]);
  }
  return Array.from(expanded);
}

// メイン: discover
//
// payload: CategorySearchParams (要件§5.3)
// opts:
//   - searchInvoker: async (query) => { ok, results: Array<{title, url, snippet}> }
//   - limit: payload.limit と同じ（無視されない）
async function discover(payload, opts: Record<string, any> = {}) {
  if (!payload || typeof payload !== 'object') {
    return { ok: false, error: 'payload required' };
  }
  const limit = Math.min(Math.max(payload.limit || 50, 1), 500);
  const searchInvoker = opts.searchInvoker;
  if (typeof searchInvoker !== 'function') {
    return { ok: false, error: 'searchInvoker (SerpApi等) is required' };
  }

  const collected: any[] = [];
  const seenUrls = new Set<any>();
  const loosenedConditions: any[] = [];

  const steps = buildLooseningSteps(payload);

  for (const step of steps) {
    if (collected.length >= limit) break;

    let stepMatched = 0;
    for (const query of step.queries) {
      if (collected.length >= limit) break;
      const r: any = await searchInvoker(query, opts);
      if (!r || !r.ok || !Array.isArray(r.results)) continue;

      for (const result of r.results) {
        if (collected.length >= limit) break;
        if (!result || !result.url) continue;
        if (seenUrls.has(result.url)) continue;
        seenUrls.add(result.url);
        collected.push({
          companyName: result.title || '',
          url: result.url,
          snippet: result.snippet || '',
          sourceQuery: query,
          loosenStep: step.step,
        });
        stepMatched++;
      }
    }

    if (step.step > 0) {
      loosenedConditions.push({
        step: step.step,
        description: step.description,
        matched: stepMatched,
      });
    }
  }

  return {
    ok: true,
    candidates: collected.slice(0, limit),
    loosenedConditions,
  };
}

module.exports = {
  discover,
  buildQueries,
  buildLooseningSteps,
  expandEmployeeRanges,
  summarize,
  EMPLOYEE_RANGE_LABELS,
  REVENUE_RANGE_LABELS,
  MAX_CROSS_PRODUCT,
  MAX_KEYWORDS_PER_QUERY,
};

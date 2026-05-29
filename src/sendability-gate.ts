'use strict';

/**
 * Sendability Gate
 * ─────────────────
 * 「サイトを読まずに / 不適合先に / 営業お断りなのに 送信してしまう」事故を
 * 構造的に止めるための事前ゲート。LLM 不要、純粋なルール判定。
 *
 * 8 項目すべて pass しないと message_draft → form_fill フローに進まない。
 * 1 つでも fail すれば skipped/error をログして終了する。
 *
 * 使い方:
 *   const gate = require('./sendability-gate');
 *   const result = gate.evaluate({ analysis, idealCustomer });
 *   if (!result.ok) {
 *     // result.failures に fail した項目が入る
 *     // result.action: 'skip' | 'error' (skip = 営業対象外, error = 取得失敗)
 *   }
 */

const DEFAULT_MIN_SITE_TEXT_LENGTH = 800;

// 営業お断り検出の語彙。サイト本文や notes に含まれていたら自動 skip。
// idealCustomer.exclusionKeywords.patterns を上書き合体する。
const BUILT_IN_EXCLUSION_PATTERNS = [
  '営業お断り',
  '営業のご連絡はご遠慮',
  '営業目的のお問い合わせはご遠慮',
  'セールス目的',
  '採用専用',
  'IR専用',
  '報道専用',
  'メディア専用',
  '個人情報の取り扱いに関する目的以外でのご利用はご遠慮',
];

/**
 * @typedef {Object} SendabilityAnalysis
 * @property {number} [siteTextLength]
 * @property {string} [siteTextExcerpt]
 * @property {string} [metaDescription]
 * @property {string} [companyType]
 * @property {string} [companyName]
 * @property {string} [notes] target list の備考欄
 * @property {Array<{label?:string,key?:string}>} [businessAreas]
 * @property {boolean} [urlMissing]
 */

/**
 * @typedef {Object} SendabilityIdealCustomer
 * @property {number} [minSiteTextLength]
 * @property {Array<string>} [dealBreakers]
 * @property {{patterns: Array<string>}} [exclusionKeywords]
 * @property {{patterns: Array<string>}} [competitors]
 */

/**
 * @typedef {Object} SendabilityFailure
 * @property {string} name
 * @property {'fatal'|'skip'|'warn'|'info'} severity
 * @property {string} reason
 */

/**
 * @typedef {Object} SendabilityResult
 * @property {boolean} ok
 * @property {'send'|'skip'|'error'} action
 * @property {Array<SendabilityFailure>} failures
 * @property {string} reason failures を 1 行に summary した文字列
 */

/**
 * 7 項目の事前ゲートを評価し、送信可否を返す (LLM 不要、純粋ルール判定)。
 * action: 'send'=全 pass / 'skip'=営業対象外 / 'error'=取得失敗等の技術的理由。
 *
 * 入力:
 *   - analysis: parallel-analysis.cjs::analyzeCompanyLite の戻り値
 *   - idealCustomer: settings-manager.cjs::getIdealCustomer() の戻り値
 *
 * @param {{analysis?: SendabilityAnalysis, idealCustomer?: SendabilityIdealCustomer}} [params]
 * @returns {SendabilityResult}
 */
function evaluate({ analysis, idealCustomer, protectedGroups, approachTargets }: { analysis?: any; idealCustomer?: any; protectedGroups?: any; approachTargets?: any } = {}) {
  if (!analysis || typeof analysis !== 'object') {
    return failure('error', [{ name: 'analysis_present', severity: 'fatal', reason: 'analysis 未取得' }]);
  }
  const ic = normalizeIdealCustomer(idealCustomer);
  // v2.0.99: アプローチ意図で緩和される除外パターン (例: 採用 をターゲットにしたら
  //   「採用専用」を除外語から外す)。これにより狙った種別のフォームを Phase A で
  //   弾かずに通せる。
  let relaxedExclusions: string[] = [];
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    relaxedExclusions = require('./approach-intent').getRelaxedExclusions(approachTargets) || [];
  } catch (_) { relaxedExclusions = []; }
  const normalizedProtectedGroups = normalizeProtectedGroups(protectedGroups);
  const failures: unknown[] = [];

  // 0. 保護グループチェック（既存協業先・グループ会社）
  // 設定の protected_groups に含まれる会社名パターンが companyName / siteText に
  // 含まれている場合、既存関係を毀損するリスクがあるため skip。
  // 例: 親会社グループ傘下の子会社 (Inc. / Subsidiary 等) など
  if (normalizedProtectedGroups.length > 0) {
    const targetText = [
      analysis.companyName,
      analysis.parent_or_group,
      analysis.parentOrGroup,
      analysis.groupName,
      analysis.metaDescription,
      analysis.siteTextExcerpt,
      analysis.llm && analysis.llm.parent_or_group,
      analysis.llm && analysis.llm.parentOrGroup,
      analysis.llm && analysis.llm.fitReason,
      Array.isArray(analysis.companyPhrases) ? analysis.companyPhrases.join('\n') : '',
    ].map((v: any) => String(v || '')).join('\n').toLowerCase();
    for (const group of normalizedProtectedGroups) {
      const hitPattern = group.match_patterns.find((p: any) => {
        const needle = String(p).toLowerCase();
        return needle.length >= 2 && targetText.includes(needle);
      });
      if (hitPattern) {
        failures.push({
          name: 'not_protected_group',
          severity: 'skip',
          reason: `保護グループに該当: "${group.name}" (${group.reason || '既存協業先グループ'}) — パターン: "${hitPattern}"`,
        });
        break;
      }
    }
  }

  // 1. サイトテキスト充足
  // 一定文字数以上のテキストを取得できていないと「拝見し」が嘘になる。
  // idealCustomer.minSiteTextLength で上書き可能 (default 800)。
  //
  const minLen = ic.minSiteTextLength;
  const siteLen = Number(analysis.siteTextLength) || 0;
  if (analysis.urlMissing === true) {
    failures.push({
      name: 'siteText_sufficient',
      severity: 'fatal',
      reason: `公式サイトURL未設定のためサイト分析未実施。本文生成・フォーム入力前に公式サイト本文 ${minLen} 字以上の取得が必須`,
    });
  } else if (siteLen < minLen) {
    failures.push({
      name: 'siteText_sufficient',
      severity: 'fatal',
      reason: `サイトテキスト ${siteLen} 字 (必要 ${minLen} 字以上)。HTTP取得失敗 / JS描画 / 社名のみページの可能性`,
    });
  }

  // 2. 営業お断り検出
  // exclusionKeywords + 組み込みパターンで本文 + notes をスキャン。
  const haystack = [
    String(analysis.siteTextExcerpt || ''),
    String(analysis.metaDescription || ''),
    String(analysis.notes || ''),
  ].join('\n').toLowerCase();
  const exclusionPatterns = [
    ...BUILT_IN_EXCLUSION_PATTERNS.filter((p) => relaxedExclusions.indexOf(p) < 0),
    ...ic.exclusionKeywords.patterns,
  ];
  const hitExclusion = exclusionPatterns.find((p: any) => haystack.includes(String(p).toLowerCase()));
  if (hitExclusion) {
    failures.push({
      name: 'no_sales_block',
      severity: 'skip',
      reason: `営業お断り検出: "${hitExclusion}"`,
    });
  }

  // 3. dealBreakers マッチ
  // companyType / businessAreas / siteText のいずれかに dealBreakers キーワードがあれば skip。
  // dealBreakers は「自社で完結する独立系SIer」のような長いフレーズなので、
  // 単純文字列マッチではなく、キーセグメントに分解して判定。
  const dealBreakerHit = matchDealBreaker(analysis, ic.dealBreakers);
  if (dealBreakerHit) {
    failures.push({
      name: 'no_deal_breaker_match',
      severity: 'skip',
      reason: `理想顧客の deal_breakers にマッチ: "${dealBreakerHit}"`,
    });
  }

  // 4. 競合除外
  // companyName / siteText に競合パターンが含まれていたら skip (自社サービス売り込みは無意味)
  const competitorHit = ic.competitors.patterns.find((p: any) => {
    const needle = String(p).toLowerCase();
    return haystack.includes(needle)
      || String(analysis.companyName || '').toLowerCase().includes(needle);
  });
  if (competitorHit) {
    failures.push({
      name: 'not_competitor',
      severity: 'skip',
      reason: `競合扱い: "${competitorHit}"`,
    });
  }

  // 5. 会社名の最低限
  if (!analysis.companyName || String(analysis.companyName).trim().length < 2) {
    failures.push({
      name: 'company_name_present',
      severity: 'fatal',
      reason: '会社名が空または不正',
    });
  }

  // 6. 業態判定の最低確信度 (businessAreas が 1 つも当たっていない = サイトが空に近い)
  // ※ Phase 0 では弱い judge。Phase A で LLM confidence を入れる。
  if (siteLen >= minLen && Array.isArray(analysis.businessAreas) && analysis.businessAreas.length === 0) {
    failures.push({
      name: 'business_area_detected',
      severity: 'warn',  // skip ではなく warn
      reason: '業態カテゴリが 1 つも判定できず (送信は続行するが要確認)',
    });
  }

  // 7. ICP の dealBreakers と descriptionFreetext が両方未設定 = 設定不完全の警告
  // dealBreakers のみ未設定は info。両方未設定 (ICP完全空) は warn に格上げして
  // ダッシュボードの CLI Activity に目立つ警告を出す。送信は止めない。
  const icpCompletelyEmpty = ic.dealBreakers.length === 0 && !ic.descriptionFreetext;
  if (icpCompletelyEmpty) {
    failures.push({
      name: 'icp_configured',
      severity: 'warn',
      reason: '⚠ ICP (理想顧客) が未設定です。dealBreakers / 説明文を設定すると不適合先への自動スキップが有効になります。Settings → 理想顧客 (ICP) から設定してください。',
    });
  } else if (ic.dealBreakers.length === 0 && !ic._isDefaults) {
    failures.push({
      name: 'icp_configured',
      severity: 'info',
      reason: 'idealCustomer.dealBreakers が未設定です。設定すると不適合先への送信を自動停止できます。',
    });
  }

  if (failures.length === 0) {
    return { ok: true, action: 'send', failures: [], reason: '' };
  }

  // action 決定: fatal が含まれれば error, skip が含まれれば skip, それ以外なら send (warn/info のみ)
  const fatal = failures.some((f: any) => f.severity === 'fatal');
  const skip = failures.some((f: any) => f.severity === 'skip');
  if (fatal) {
    return failure('error', failures);
  }
  if (skip) {
    return failure('skip', failures);
  }
  // warn / info しかない → 送信続行 (UI には警告表示)
  return {
    ok: true,
    action: 'send',
    failures,
    reason: failures.map((f: any) => `[${f.severity}] ${f.name}: ${f.reason}`).join(' / '),
  };
}

function failure(action, failures) {
  return {
    ok: false,
    action,
    failures,
    reason: failures.map((f: any) => `[${f.severity}] ${f.name}: ${f.reason}`).join(' / '),
  };
}

/**
 * dealBreakers のフリーテキスト (例: "自社で完結する開発体制を持つ独立系SIer")
 * から判定キーワードを抽出してマッチさせる。
 *
 * 日本語向け token 抽出:
 *   1. 記号 + 助詞 (の/を/は/が/に/で/と/も/や/から/まで/より) で分割
 *   2. 2 文字以上の語を残す
 *   3. 一般的な機能語 (する/もつ/ある/いる/もの/こと等) を除去
 *   4. 60% 以上の token がマッチしたら hit (全部一致を要求すると Japanese の
 *      語順揺れに弱いので閾値式)
 *
 * Phase A で LLM 判定に置き換える予定。
 */
// 日本語の助詞・接続語・動詞語幹で分割する separator regex。
// 「自社で完結する開発体制を持つ独立系 SIer」を ["自社", "完結", "開発体制", "独立系", "sier"]
// に砕くために、助詞 + よく使われる動詞 (する/持つ/ある/いる) も separator 扱いする。
const JA_PARTICLES_RE = /[\s（）()【】〈〉「」『』,，、。/／・]+|の|を|は|が|に|で|と|も|や|から|まで|より|として|について|における|に対する|する|して|した|される|持つ|もつ|ある|いる|なる/g;

function tokenizeBreaker(breaker) {
  const cleaned = String(breaker || '').toLowerCase();
  const tokens = cleaned
    .split(JA_PARTICLES_RE)
    .map((t: any) => t.trim())
    .filter((t: any) => t.length >= 2);
  return Array.from(new Set(tokens));
}

/**
 * 1 つの breaker に対する判定:
 *   - tokens 数 1 (短いキーワード "新築物件" 等) → 1 hit で判定 OK
 *   - tokens 数 2+ (長いフレーズ) → 60% 以上、最低 2 hit が必要
 *
 * 1-token のときに「最低 2 hit」を要求すると "新築物件" のような短い
 * 単独キーワードが弾かれるので、1-token は例外的に 1 hit で OK にする。
 *
 * @param {SendabilityAnalysis} analysis
 * @param {Array<string>} dealBreakers
 * @returns {string|null} hit した breaker 文字列、無ければ null
 */
function matchDealBreaker(analysis, dealBreakers) {
  const haystack = [
    String(analysis.companyType || ''),
    String(analysis.companyName || ''),
    String(analysis.siteTextExcerpt || ''),
    String(analysis.metaDescription || ''),
    Array.isArray(analysis.businessAreas)
      ? analysis.businessAreas.map((a: any) => `${a.label || ''} ${a.key || ''}`).join(' ')
      : '',
  ].join('\n').toLowerCase();

  for (const breaker of dealBreakers) {
    if (typeof breaker !== 'string' || breaker.length < 3) continue;
    const tokens = tokenizeBreaker(breaker);
    if (tokens.length === 0) continue;
    const hits = tokens.filter((t: any) => haystack.includes(t));
    if (tokens.length === 1) {
      // 単独キーワード → 1 hit で OK
      if (hits.length >= 1) return breaker;
    } else {
      // 複合フレーズ → 60% 以上、最低 2 hit
      const minHits = Math.max(2, Math.ceil(tokens.length * 0.6));
      if (hits.length >= minHits) return breaker;
    }
  }
  return null;
}

function normalizeIdealCustomer(ic) {
  if (!ic || typeof ic !== 'object') {
    return {
      _isDefaults: true,
      minSiteTextLength: DEFAULT_MIN_SITE_TEXT_LENGTH,
      descriptionFreetext: '',
      dealBreakers: [],
      exclusionKeywords: { patterns: [] },
      competitors: { patterns: [] },
    };
  }
  return {
    _isDefaults: false,
    minSiteTextLength: Number(ic.minSiteTextLength) || DEFAULT_MIN_SITE_TEXT_LENGTH,
    descriptionFreetext: String(ic.descriptionFreetext || '').trim(),
    dealBreakers: Array.isArray(ic.dealBreakers) ? ic.dealBreakers : [],
    exclusionKeywords: ic.exclusionKeywords || { patterns: [] },
    competitors: ic.competitors || { patterns: [] },
  };
}

function normalizeProtectedGroups(groups) {
  if (!Array.isArray(groups)) return [];
  return groups
    .filter((g: any) => g && typeof g === 'object' && String(g.name || '').trim())
    .map((g: any) => {
      const patterns: unknown[] = [];
      if (g.name) patterns.push(String(g.name));
      if (Array.isArray(g.match_patterns)) patterns.push(...g.match_patterns);
      if (Array.isArray(g.patterns)) patterns.push(...g.patterns);
      return {
        name: String(g.name || '').trim(),
        reason: String(g.reason || '').trim(),
        match_patterns: Array.from(new Set(patterns
          .map((p: any) => String(p || '').trim())
          .filter((p: any) => p.length >= 2))),
      };
    })
    .filter((g: any) => g.match_patterns.length > 0);
}

module.exports = {
  evaluate,
  // テスト用 export
  matchDealBreaker,
  normalizeProtectedGroups,
  BUILT_IN_EXCLUSION_PATTERNS,
};

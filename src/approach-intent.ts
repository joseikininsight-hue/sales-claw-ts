'use strict';

/**
 * Approach Intent (営業アプローチ意図)
 * ───────────────────────────────────
 * 「どこに営業をかけたいか」(協業 / 業務提携 / 採用 / 広報 / IR / 一般 …) を
 * ユーザーが設定し、それに応じて
 *   (1) Phase B のフォーム選択優先順位 (formPreferences) を自動生成
 *   (2) Phase A の sendability-gate の「営業お断り」ハードコード除外を意図連動で緩和
 *       (例: 採用 をターゲットにしたら「採用専用」フォームを除外しない)
 * を行う単一の意図カタログ。
 *
 * settings: messageTemplates.approachTargets = string[] (下記キーの配列)
 * 明示的な messageTemplates.formPreferences があればそちらが優先される。
 */

interface IntentDef {
  label: string;
  preferred: string[];        // 優先フォーム名キーワード
  avoid: string[];            // 避けるフォーム名キーワード
  relaxExclusions: string[];  // この意図が有効なとき除外しない BUILT_IN パターン
}

const APPROACH_INTENTS: Record<string, IntentDef> = {
  collaboration: {
    label: '協業・アライアンス',
    preferred: ['協業', 'アライアンス', 'パートナー', '業務提携', 'Partner', 'Alliance', 'Collaboration'],
    avoid: ['FAQ', 'カスタマーサポート', '製品サポート', 'Support', 'Help Center'],
    relaxExclusions: [],
  },
  partner: {
    label: '業務提携・取引',
    preferred: ['業務提携', '取引', 'お取引', 'パートナー', '調達', '購買', 'Procurement', 'Business Inquiry'],
    avoid: ['FAQ', 'サポート', 'Support'],
    relaxExclusions: [],
  },
  general: {
    label: '一般のお問い合わせ',
    preferred: ['お問い合わせ', 'ご相談', 'Contact', 'Inquiry'],
    avoid: ['FAQ', 'カスタマーサポート', 'Support', 'Help Center'],
    relaxExclusions: [],
  },
  recruit: {
    label: '採用・人材',
    preferred: ['採用', '求人', 'キャリア', '人材', 'Recruit', 'Careers', 'Hiring'],
    avoid: [],
    relaxExclusions: ['採用専用'],
  },
  sales_agency: {
    label: '代理店・販売パートナー',
    preferred: ['代理店', '販売店', '販売パートナー', 'Reseller', 'Distributor', 'パートナー'],
    avoid: ['FAQ', 'サポート'],
    relaxExclusions: [],
  },
  media: {
    label: '広報・メディア',
    preferred: ['広報', 'メディア', '報道', 'プレス', 'Press', 'PR', 'Media'],
    avoid: ['FAQ', 'サポート'],
    relaxExclusions: ['報道専用', 'メディア専用'],
  },
  ir: {
    label: 'IR・投資家',
    preferred: ['IR', '投資家', 'Investor'],
    avoid: ['FAQ', 'サポート'],
    relaxExclusions: ['IR専用'],
  },
};

const DEFAULT_TARGETS = ['collaboration', 'general'];

function normalizeTargets(targets: unknown): string[] {
  const arr = Array.isArray(targets) ? targets : [];
  const valid = arr.map((t) => String(t)).filter((t) => Object.prototype.hasOwnProperty.call(APPROACH_INTENTS, t));
  return valid.length > 0 ? Array.from(new Set(valid)) : DEFAULT_TARGETS.slice();
}

function uniqMerge(...lists: string[][]): string[] {
  const out: string[] = [];
  for (const list of lists) {
    for (const v of (list || [])) {
      if (v && out.indexOf(v) < 0) out.push(v);
    }
  }
  return out;
}

/**
 * 選択された意図から formPreferences (preferredKeywords / avoidKeywords / approachLabel) を生成する。
 * explicit に明示値があればそれを優先 (後方互換)。
 */
function derive(keys: string[]): { preferredKeywords: string[]; avoidKeywords: string[]; approachLabel: string } {
  const defs = keys.map((k) => APPROACH_INTENTS[k]).filter(Boolean);
  const preferred = uniqMerge(...defs.map((d) => d.preferred));
  // avoid は「いずれかの意図が preferred にしているキーワード」は除外しない
  const avoid = uniqMerge(...defs.map((d) => d.avoid)).filter((a) => preferred.indexOf(a) < 0);
  return { preferredKeywords: preferred, avoidKeywords: avoid, approachLabel: defs.map((d) => d.label).join(' / ') || '一般のお問い合わせ' };
}

function resolveFormPreferences(targets: unknown, explicit: any = null): { preferredKeywords: string[]; avoidKeywords: string[]; approachLabel: string } {
  // ユーザーが approachTargets を明示設定していれば、それが最優先 (意図駆動)。
  const userKeys = Array.isArray(targets) ? targets.map((t) => String(t)).filter((t) => APPROACH_INTENTS[t]) : [];
  if (userKeys.length > 0) return derive(Array.from(new Set(userKeys)));
  // approachTargets 未設定: 後方互換で明示 formPreferences を使い、無ければ既定意図。
  const fallback = derive(DEFAULT_TARGETS.slice());
  const e = explicit && typeof explicit === 'object' ? explicit : {};
  return {
    preferredKeywords: Array.isArray(e.preferredKeywords) && e.preferredKeywords.length > 0 ? e.preferredKeywords : fallback.preferredKeywords,
    avoidKeywords: Array.isArray(e.avoidKeywords) && e.avoidKeywords.length > 0 ? e.avoidKeywords : fallback.avoidKeywords,
    approachLabel: typeof e.approachLabel === 'string' && e.approachLabel.trim() ? e.approachLabel.trim() : fallback.approachLabel,
  };
}

/**
 * 選択された意図で「除外しない」BUILT_IN パターン一覧。
 * sendability-gate が BUILT_IN_EXCLUSION_PATTERNS から差し引く。
 */
function getRelaxedExclusions(targets: unknown): string[] {
  const keys = normalizeTargets(targets);
  return uniqMerge(...keys.map((k) => (APPROACH_INTENTS[k] ? APPROACH_INTENTS[k].relaxExclusions : [])));
}

function listIntents(): Array<{ key: string; label: string }> {
  return Object.keys(APPROACH_INTENTS).map((k) => ({ key: k, label: APPROACH_INTENTS[k].label }));
}

module.exports = {
  APPROACH_INTENTS,
  DEFAULT_TARGETS,
  normalizeTargets,
  resolveFormPreferences,
  getRelaxedExclusions,
  listIntents,
};

export {};

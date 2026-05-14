'use strict';

// Compliance Precheck — リスト作成時の安全性事前確認
//
// 要件§8 (docs/list-builder-requirements.md v2.0) に基づく:
//   - robots.txt 違反パスの取得は行わない
//   - フォーム用途判定 (sales_prohibited / recruit_only / support_only / ir_only)
//   - 個人情報フィールド (個人メール/個人名) の抽出抑制 (デフォルト)
//   - CAPTCHA / 403 / 429 / login 検出時はスキップ
//
// 既存の compliance.cjs (送信時の特定電子メール法適合) とは別レイヤ。
// 補完関係: 収集時に問題があるレコードは送信前により早く弾く。

const urlNormalizer = require('./url-normalizer');

// --- 営業禁止検知 ---

// 営業禁止文言パターン（日本語の代表的表現）
const SALES_PROHIBITION_PATTERNS = [
  /営業[\s\S]{0,10}(?:目的|電話|メール|ご連絡|お問い?合わせ|問い?合わせ)[\s\S]{0,20}(?:お断り|ご遠慮|禁止|お控え|お断わり)/,
  /営業[\s\S]{0,10}(?:お断り|ご遠慮|禁止|お控え|お断わり)/,
  /(?:勧誘|セールス|営業活動)[\s\S]{0,20}(?:お断り|ご遠慮|禁止|お控え)/,
  /(?:no\s+(?:sales|solicitation)|no\s+cold\s+call)/i,
];

// 採用専用フォーム
//
// 注: 全 HTML を対象にすると、企業サイトの一般問い合わせページに
// 「採用情報はこちら」というリンク文言があるだけで誤検出する。
// ページタイトル・h1/h2 ・<form> 要素近傍に限定する判定が必要 (analyze 内で実施)。
const RECRUIT_ONLY_PATTERNS = [
  /採用[\s\S]{0,5}(?:専用|お問い合わせ窓口)/,
  /採用に?関するお問い合わせ/,
  /(?:中途|新卒|キャリア|career)\s*採用[\s\S]{0,10}(?:専用|応募)/i,
  /(?:採用|recruit|career)\s*(?:応募|エントリー|entry)\s*フォーム/i,
];

// サポート専用フォーム
const SUPPORT_ONLY_PATTERNS = [
  /(?:お客様|カスタマー|サポート)[\s\S]{0,5}(?:窓口|専用|サポート)/,
  /既存(?:のお|お)?客様(?:のみ|専用|向け)/,
  /(?:サポート|technical\s*support|customer\s*support)\s*(?:専用|フォーム|窓口|only)/i,
  /(?:バグ|不具合|障害)報告/,
];

// IR・報道専用フォーム
const IR_ONLY_PATTERNS = [
  /IR(?:に関する|の)?お問い合わせ/,
  /(?:報道|プレス|press|media)[\s\S]{0,5}(?:関係者|専用|窓口|問い合わせ)/i,
  /(?:investor|株主|機関投資家)\s*(?:専用|向け|relations)/i,
];

// アクセス制限・ログイン要求の検出（HTML/レスポンスヘッダから）
const LOGIN_REQUIRED_PATTERNS = [
  /<form[^>]*\b(?:action|name|id)\s*=\s*["'][^"']*(?:login|signin|auth)/i,
  /(?:ログインが必要|ログインしてください|please\s+log\s*in|sign\s+in\s+required)/i,
];

// CAPTCHA 検出
const CAPTCHA_PATTERNS = [
  /\bg-recaptcha\b/i,
  /grecaptcha/i,
  /hcaptcha/i,
  /cf-(?:turnstile|challenge)/i,
  /<img[^>]+src\s*=\s*["'][^"']*captcha/i,
];

// 個人メール抽出抑制用 ([first]\.[last]@... の検出)
// 抽出するわけではなく、HTMLに含まれている時に riskFlag を立てる用
const PERSONAL_EMAIL_HINTS = [
  /[a-z]+\.[a-z]+@[a-z0-9.-]+\.(?:co\.jp|com|net|org)/i,
];

function someMatch(text, patterns) {
  if (!text) return false;
  for (const p of patterns) {
    if (p.test(text)) return true;
  }
  return false;
}

// HTML から「ページタイトル + h1/h2/h3 + form 要素近傍」だけを切り出す。
// recruit/support/ir などの判定は全 HTML を対象にすると誤検出が多いため、
// フォーム自体の意図を強く示すスコープに絞る。
function extractFormScopeText(html) {
  if (!html) return '';
  const pieces: unknown[] = [];

  // <title>
  const titleMatch = html.match(/<title[^>]*>([\s\S]{0,200}?)<\/title>/i);
  if (titleMatch) pieces.push(titleMatch[1]);

  // 見出し h1〜h3 (各 200 文字まで)
  const headingRegex = /<h[1-3][^>]*>([\s\S]{0,200}?)<\/h[1-3]>/gi;
  let m;
  while ((m = headingRegex.exec(html)) !== null) {
    pieces.push(m[1]);
  }

  // <form> 要素本体（最初の form 要素のみ、最大 2000 文字）
  const formMatch = html.match(/<form\b[\s\S]{0,2000}?<\/form>/i);
  if (formMatch) pieces.push(formMatch[0]);

  // form 要素の action 属性も判定材料に含める (e.g. action="/recruit/")
  const actionRegex = /<form[^>]+\baction\s*=\s*["']([^"']+)["']/gi;
  while ((m = actionRegex.exec(html)) !== null) {
    pieces.push('FORM_ACTION:' + m[1]);
  }

  return pieces.join('\n');
}

// HTML を解析して riskFlags を抽出
//
// 入力: { html, statusCode?, headers? }
// 出力: { riskFlags: string[], formType: FormType, blocked: boolean, blockReason? }
function analyze(input) {
  const html = typeof input?.html === 'string' ? input.html : '';
  const status = typeof input?.statusCode === 'number' ? input.statusCode : 0;

  const riskFlags: unknown[] = [];
  let blocked = false;
  let blockReason: any = null;
  let formType = 'unknown';

  // ---- Step 1: ステータスコード判定 ----
  if (status === 403 || status === 401) {
    blocked = true;
    blockReason = 'access_blocked';
    riskFlags.push('access_blocked');
  } else if (status === 429) {
    blocked = true;
    blockReason = 'rate_limited';
    riskFlags.push('access_blocked');
  } else if (status >= 500 && status < 600) {
    blocked = true;
    blockReason = 'server_error';
    riskFlags.push('server_error');
  }

  // ---- Step 2: コンテンツ解析 ----
  if (html) {
    if (someMatch(html, CAPTCHA_PATTERNS)) {
      blocked = true;
      blockReason = blockReason || 'captcha_detected';
      riskFlags.push('captcha_detected');
    }

    if (someMatch(html, LOGIN_REQUIRED_PATTERNS)) {
      blocked = true;
      blockReason = blockReason || 'login_required';
      riskFlags.push('login_required');
    }

    if (someMatch(html, SALES_PROHIBITION_PATTERNS)) {
      riskFlags.push('sales_prohibited');
      formType = 'unknown'; // 営業禁止を最優先表示
    }

    // フォーム種別判定はフォームスコープに絞って実施 (誤検出抑制)
    const formScope = extractFormScopeText(html);
    if (someMatch(formScope, RECRUIT_ONLY_PATTERNS) || /FORM_ACTION:[^\n]*\b(?:recruit|entry|career)\b/i.test(formScope)) {
      riskFlags.push('recruit_only');
      formType = 'recruit';
    } else if (someMatch(formScope, SUPPORT_ONLY_PATTERNS) || /FORM_ACTION:[^\n]*\bsupport\b/i.test(formScope)) {
      riskFlags.push('support_only');
      formType = 'support';
    } else if (someMatch(formScope, IR_ONLY_PATTERNS) || /FORM_ACTION:[^\n]*\b(?:ir|investor)\b/i.test(formScope)) {
      riskFlags.push('ir_only');
      formType = 'ir';
    } else if (riskFlags.includes('sales_prohibited')) {
      formType = 'unknown';
    } else if (/<form\b/i.test(html)) {
      // 一般問い合わせフォームと推定（除外要素がない場合）
      formType = 'general_contact';
    }

    // 個人メールアドレスが本文に書かれている場合の警告 (デフォルトでは収集しない)
    if (someMatch(html, PERSONAL_EMAIL_HINTS)) {
      riskFlags.push('personal_email_present');
    }
  }

  return {
    riskFlags,
    formType,
    blocked,
    blockReason,
  };
}

// --- robots.txt パース・許可判定 ---
//
// 簡易実装: User-agent: * のセクションだけを見る（最も一般的）。
// 入力: robots.txt のテキスト
// 出力: { disallowedPaths: string[], allowedPaths: string[], crawlDelay?: number }
function parseRobotsTxt(text) {
  const disallowedPaths: unknown[] = [];
  const allowedPaths: unknown[] = [];
  let crawlDelay: any = null;

  if (typeof text !== 'string' || !text) {
    return { disallowedPaths, allowedPaths, crawlDelay };
  }

  let currentApplies = false;
  // 行ごとに処理
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const directive = line.slice(0, colonIdx).trim().toLowerCase();
    const value = line.slice(colonIdx + 1).trim();

    if (directive === 'user-agent') {
      // '*' または 'salesclaw' に該当するセクションを採用
      currentApplies = value === '*' || /salesclaw/i.test(value);
    } else if (currentApplies) {
      if (directive === 'disallow') {
        if (value) disallowedPaths.push(value);
      } else if (directive === 'allow') {
        if (value) allowedPaths.push(value);
      } else if (directive === 'crawl-delay') {
        const n = Number(value);
        if (Number.isFinite(n)) crawlDelay = n;
      }
    }
  }

  return { disallowedPaths, allowedPaths, crawlDelay };
}

// 与えられた URL のパスが robots.txt の制約に違反しないか判定
//
// 戻り値: { allowed: boolean, reason: string }
function isPathAllowed(url, robotsResult) {
  if (!robotsResult) return { allowed: true, reason: 'no robots data' };
  const parsed = urlNormalizer.normalize(url);
  if (!parsed.valid) return { allowed: false, reason: 'invalid URL' };
  const targetPath = parsed.path || '/';

  // Allow の方が長く具体的なら優先
  let bestAllow = '';
  let bestDisallow = '';

  for (const path of robotsResult.allowedPaths || []) {
    if (matchRobotsPath(targetPath, path) && path.length > bestAllow.length) {
      bestAllow = path;
    }
  }
  for (const path of robotsResult.disallowedPaths || []) {
    if (matchRobotsPath(targetPath, path) && path.length > bestDisallow.length) {
      bestDisallow = path;
    }
  }

  if (bestAllow && bestAllow.length >= bestDisallow.length) {
    return { allowed: true, reason: `allowed by '${bestAllow}'` };
  }
  if (bestDisallow) {
    return { allowed: false, reason: `disallowed by '${bestDisallow}'` };
  }
  return { allowed: true, reason: 'no matching rule' };
}

// robots.txt のパスは前方一致 + ワイルドカード `*` / 終端 `$` をサポート
function matchRobotsPath(target, pattern) {
  if (!pattern) return false;
  if (pattern === '/') return true; // '/' は全パスにマッチ
  // パターンを正規表現に変換
  const regex = patternToRegex(pattern);
  return regex.test(target);
}

function patternToRegex(pattern) {
  let escaped = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') {
      escaped += '.*';
    } else if (ch === '$' && i === pattern.length - 1) {
      escaped += '$';
    } else if (/[.+?^=!:${}()|[\]/\\]/.test(ch)) {
      escaped += '\\' + ch;
    } else {
      escaped += ch;
    }
  }
  // 前方一致
  return new RegExp('^' + escaped);
}

module.exports = {
  analyze,
  parseRobotsTxt,
  isPathAllowed,
  matchRobotsPath,
  extractFormScopeText,
  // テスト用
  _internal: {
    SALES_PROHIBITION_PATTERNS,
    RECRUIT_ONLY_PATTERNS,
    SUPPORT_ONLY_PATTERNS,
    IR_ONLY_PATTERNS,
    LOGIN_REQUIRED_PATTERNS,
    CAPTCHA_PATTERNS,
  },
};

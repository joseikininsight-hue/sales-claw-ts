#!/usr/bin/env node
/**
 * Sales Claw Blog Post Evaluator
 *
 * Fatal Gate (17 項目) + Scored Evaluation (25 軸、重み付き 100 点満点) を実行し、
 * 自動公開可否を判定する。
 *
 * Usage:
 *   node scripts/evaluate-blog-post.cjs <slug>
 *
 * Output: JSON ({ slug, fatalErrors, score, publishable, imageCount, axes })
 *
 * Exit codes:
 *   0  = publishable (Fatal 0 + score >= 92)
 *   1  = needs revision (Fatal 0 + 88 <= score < 92)
 *   2  = drafts (Fatal 0 + score < 88)
 *   3  = fatal hit (1 件以上)
 */

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');

function fail(msg) {
  console.error(`[evaluator] ${msg}`);
  process.exit(3);
}

const slug = process.argv[2];
if (!slug) {
  console.error('Usage: node scripts/evaluate-blog-post.cjs <slug>');
  process.exit(2);
}

const blogTs = fs.readFileSync(path.join(REPO_ROOT, 'lib', 'blog.ts'), 'utf8');
const tsxPath = path.join(REPO_ROOT, 'content', 'blog', `${slug}.tsx`);
if (!fs.existsSync(tsxPath)) fail(`tsx not found: ${tsxPath}`);
const tsx = fs.readFileSync(tsxPath, 'utf8');

const BANNED_TITLE = /完全|絶対|魔法|100%|革命|必ず|圧倒的|衝撃|知らないと損/;
const BANNED_BRAND = /人間承認|人間レビュー|人間が承認|送信前に人間|完全自律|完全自動|100%安全|放置で稼働/;

function getEntryBlock(slug) {
  const re = new RegExp(`\\{[\\s\\S]*?slug:\\s*'${slug}'[\\s\\S]*?\\n  \\}`, 'm');
  const m = blogTs.match(re);
  return m ? m[0] : null;
}

const entry = getEntryBlock(slug);
if (!entry) fail(`blog entry not found in lib/blog.ts: ${slug}`);

const fatalErrors = [];

// #5 title 誇張禁止語
const titleMatch = entry.match(/title:\s*'([^']+)'/);
const title = titleMatch ? titleMatch[1] : '';
if (BANNED_TITLE.test(title)) fatalErrors.push(`#5 タイトルに誇張禁止語: "${title.match(BANNED_TITLE)[0]}"`);

// #16 brand banned
if (BANNED_BRAND.test(tsx) || BANNED_BRAND.test(entry)) {
  const hit = (tsx.match(BANNED_BRAND) || entry.match(BANNED_BRAND))[0];
  fatalErrors.push(`#16 ブランド禁止語残存: "${hit}"`);
}

// #10 risks section
if (!/id="risks"/.test(tsx)) fatalErrors.push('#10 リスク章 (id="risks") 欠落');

// #11 対象読者 + この記事でわかること
const hasReaderTarget = /対象読者|この記事の対象/.test(tsx);
const hasWhatYouLearn = /わかること|学べる/.test(tsx);
if (!hasReaderTarget) fatalErrors.push('#11 「対象読者」InfoBox 欠落');
if (!hasWhatYouLearn) fatalErrors.push('#11 「この記事でわかること」InfoBox 欠落');

// #14 alt 欠落チェック (DiagramFigure / img タグ)
// alt 属性: 文字列リテラル ("..."), JSX 式 ({alt} など), template literal どれもOK
const hasAlt = (t) => /\balt\s*=\s*(\{[^{}]*[a-zA-Z0-9_$"`'][^{}]*\}|["'][^"']+["'])/.test(t);
const imgTags = tsx.match(/<img\s[\s\S]*?\/?>/g) || [];
const diagramTags = tsx.match(/<DiagramFigure\s[\s\S]*?\/>/g) || [];
let missingAlt = 0;
imgTags.forEach((t) => { if (!hasAlt(t)) missingAlt++; });
diagramTags.forEach((t) => { if (!hasAlt(t)) missingAlt++; });
if (missingAlt > 0) fatalErrors.push(`#14 alt 欠落画像: ${missingAlt} 件`);

// #17 画像数チェック (アイキャッチ + DiagramFigure + Python 図解)
// 2026-05-13 v5: Python 図解 1 枚以上を必須化、合計 4 枚以上に
const hasCoverImage = /coverImage:\s*'\/images\/blog\//.test(entry);
const imageCount = (hasCoverImage ? 1 : 0) + diagramTags.length;
if (imageCount < 4) fatalErrors.push(`#17 画像数 ${imageCount} 枚 (最低 4 枚必須: hero 1 + 本文 2 + Python 図解 1)`);

// Python 図解参照数のカウント (TSX 内の DiagramFigure src= で "diagram-<slug>-" を含むもの)
const slugDiagramRefs = (tsx.match(/src=["']\/images\/blog\/diagram-[a-z0-9-]+\.png["']/g) || [])
  .filter((s) => s.includes(slug.replace(/^\d{4}-\d{2}-\d{2}-/, '')) || s.includes(slug));
const pyScriptPath = path.join(REPO_ROOT, 'scripts', 'blog-diagrams', `${slug}.py`);
const hasPyScript = fs.existsSync(pyScriptPath);
// 緩い検出: src に "diagram-" を含むものすべてを「Python 図解の候補」として扱う
const allDiagramRefs = (tsx.match(/src=["']\/images\/blog\/diagram-[^"']+\.png["']/g) || []).length;
// Python 図解の存在条件: スクリプトがある or 記事に diagram-*.png 参照がある
const hasPyDiagram = hasPyScript || allDiagramRefs > 0;
if (!hasPyDiagram) {
  fatalErrors.push('#17 Python 図解が 0 枚 (scripts/blog-diagrams/<slug>.py の作成 → 実行 → TSX 参照が必須)');
}

// #18 Python 図解の参照漏れ検出 (scripts/blog-diagrams/<slug>.py を作ったのに記事で参照していない)
const pyScript = path.join(REPO_ROOT, 'scripts', 'blog-diagrams', `${slug}.py`);
if (fs.existsSync(pyScript)) {
  const pyContent = fs.readFileSync(pyScript, 'utf8');
  // savefig の出力パスから期待ファイル名を抽出
  const expectedDiagrams = [...pyContent.matchAll(/OUT_DIR\s*\/\s*["']([^"']+\.png)["']/g)].map((m) => m[1]);
  const blogDir = path.join(REPO_ROOT, 'public', 'images', 'blog');
  const missingPng = expectedDiagrams.filter((name) => !fs.existsSync(path.join(blogDir, name)));
  const unreferenced = expectedDiagrams.filter((name) => fs.existsSync(path.join(blogDir, name)) && !tsx.includes(name));
  if (missingPng.length > 0) {
    fatalErrors.push(`#18 Python 図解の出力 PNG が存在しない (スクリプト未実行?): ${missingPng.join(', ')}`);
  }
  if (unreferenced.length > 0) {
    fatalErrors.push(`#18 Python 図解は生成済だが記事 TSX で参照されていない: ${unreferenced.join(', ')}`);
  }
}

// #3 timezone (lib/blog.ts::generateArticleJsonLd で自動付与されるため省略)
// #1 canonical (app/blog/[slug]/page.tsx で自動付与されるため省略)
// #2 article schema image (coverImage from entry → JSON-LD 自動)
// #7 citations source check
const citationSources = [...entry.matchAll(/source:\s*'([^']+)'/g)].map((m) => m[1]);
const invalidSources = citationSources.filter((s) => !['x', 'official', 'blog', 'releases'].includes(s));
if (invalidSources.length > 0) fatalErrors.push(`#7 citation source invalid: ${invalidSources.join(', ')}`);

// scoring (simplified heuristics)
const scores = {};

// 技術 SEO
const descMatch = entry.match(/description:\s*\n?\s*'([^']+)'/);
const desc = descMatch ? descMatch[1] : '';
// T1: title 40-90 字 (日本語ベース)、description 100-200 字
const titleLenOk = title.length >= 40 && title.length <= 90;
const descLenOk = desc.length >= 100 && desc.length <= 200;
scores.T1_metadata = titleLenOk && descLenOk ? 95 : (titleLenOk || descLenOk ? 85 : 75);
// T2: ArticleJsonLd 使用 + lib/blog.ts に generateArticleJsonLd export
const pageTsx = fs.readFileSync(path.join(REPO_ROOT, 'app', 'blog', '[slug]', 'page.tsx'), 'utf8');
const usesJsonLd = /<ArticleJsonLd\s/.test(pageTsx) && /export function generateArticleJsonLd/.test(blogTs);
scores.T2_schema = usesJsonLd ? 95 : 70;
const internalLinks = (tsx.match(/<Link\s+href="[^"]+"/g) || []).length;
scores.T3_internalLinks = internalLinks >= 3 && internalLinks <= 8 ? 92 : 80;

// 検索意図 / コンテンツ SEO
scores.C1_searchClarity = title.includes('？') && !BANNED_TITLE.test(title) ? 95 : 85;
const h2Count = (tsx.match(/<h2\s+id="/g) || []).length;
scores.C2_intentCompletion = h2Count >= 7 && h2Count <= 9 ? 92 : 80;
// C3: LSI 関連語の出現数 (汎用バンク)
const lsiBank = ['自律', '並列', 'エンタープライズ', 'Hooks', 'event-loop', 'バッチ', 'CAPTCHA', '監査ログ', 'コンプライアンス', 'subagent', 'goal', 'awaiting_approval'];
const lsiHits = lsiBank.filter((w) => tsx.includes(w)).length;
scores.C3_lsi = lsiHits >= 7 ? 92 : (lsiHits >= 4 ? 85 : 75);

// AIO / GEO
const quickFactsMatch = entry.match(/quickFacts:\s*\[([\s\S]*?)\],/);
const qfCount = quickFactsMatch ? (quickFactsMatch[1].match(/\{\s*label:/g) || []).length : 0;
scores.A1_quickFacts = qfCount === 4 ? 95 : (qfCount > 0 ? 80 : 50);
scores.A2_snippet = (tsx.match(/<Tldr>/g) || []).length >= 4 ? 92 : 80;
const faqMatch = entry.match(/faq:\s*\[([\s\S]*?)\],\s*citations/);
const faqEntries = faqMatch ? (faqMatch[1].match(/\{\s*\n?\s*q:/g) || []).length : 0;
scores.A3_faqSchema = faqEntries >= 5 && faqEntries <= 8 ? 90 : 75;
scores.A4_qaNaturalness = 88;

// Source / Fact Integrity
scores.S1_factLedger = 90;
scores.S2_primaryRate = invalidSources.length === 0 ? 100 : 60;
scores.S3_sourceRatio = 92;
// S4: Claim Severity — estimate に前提条件 / 変動幅 / サンプル計測の付帯
const hasPremise = /前提条件|変動幅|サンプル計測|±\s*[0-9]+\s*%|JPY=|為替|検証条件/.test(tsx);
scores.S4_claimSeverity = hasPremise ? 93 : 80;
scores.S5_urlValidation = 90;

// E-E-A-T
// E1: experience キーワード出現数
const expHits = (tsx.match(/experience|社内検証|社内ベンチ|運用観察|開発者の運用|検証条件|社内 (?:検証|ベンチ)/g) || []).length;
scores.E1_experience = expHits >= 2 ? 90 : (expHits >= 1 ? 82 : 70);
scores.E2_authority = /author:\s*\{[\s\S]*?xHandle/.test(entry) ? 90 : 75;
scores.E3_trust = 90;

// Safety / Legal / Brand Risk
// L1: タイトル + description + lead に対する誇張禁止語スキャン (本文中の通常の「必ず」「絶対」は許容)
const leadMatch = entry.match(/lead:\s*\n?\s*'([^']+)'/);
const lead = leadMatch ? leadMatch[1] : '';
const hypeTargets = `${title} ${desc} ${lead}`;
scores.L1_noHype = !BANNED_TITLE.test(hypeTargets) ? 95 : 50;
scores.L2_legalDisclosure = /特定電子メール法|CAPTCHA|オプトアウト|送信頻度/.test(tsx) ? 92 : 75;
scores.L3_brandIntegrity = !BANNED_BRAND.test(tsx) && /ポリシー制御|送信前自動検査|監査ログ/.test(tsx) ? 95 : 75;
scores.L4_imageSafety = 90;

// Reader UX
scores.U1_readerMotivation = 90;
scores.U2_visualRest = (tsx.match(/<(InfoBox|Tldr|PullQuote|ComparisonTable|DiagramFigure)/g) || []).length >= 10 ? 95 : 80;

// Originality
scores.O1_originality = /Sales Claw/.test(tsx) && imageCount >= 3 ? 90 : 78;

// Accessibility
scores.Y1_a11y = missingAlt === 0 ? 90 : 60;

// weights
const weights = {
  T1_metadata: 0.04, T2_schema: 0.04, T3_internalLinks: 0.04,
  C1_searchClarity: 0.04, C2_intentCompletion: 0.04, C3_lsi: 0.04,
  A1_quickFacts: 0.035, A2_snippet: 0.035, A3_faqSchema: 0.035, A4_qaNaturalness: 0.035,
  S1_factLedger: 0.036, S2_primaryRate: 0.036, S3_sourceRatio: 0.036, S4_claimSeverity: 0.036, S5_urlValidation: 0.036,
  E1_experience: 0.034, E2_authority: 0.033, E3_trust: 0.033,
  L1_noHype: 0.04, L2_legalDisclosure: 0.04, L3_brandIntegrity: 0.04, L4_imageSafety: 0.04,
  U1_readerMotivation: 0.04, U2_visualRest: 0.04,
  O1_originality: 0.06,
  Y1_a11y: 0.04,
};

let weightedSum = 0;
let weightTotal = 0;
for (const [k, v] of Object.entries(scores)) {
  const w = weights[k] ?? 0;
  weightedSum += v * w;
  weightTotal += w;
}
const score = Number((weightedSum / weightTotal).toFixed(2));

const result = {
  slug,
  fatalErrors,
  imageCount,
  diagramCount: diagramTags.length,
  internalLinkCount: internalLinks,
  score,
  publishable: fatalErrors.length === 0 && score >= 92,
  decision:
    fatalErrors.length > 0
      ? 'BLOCKED (Fatal Gate hit)'
      : score >= 92
      ? 'PUBLISHABLE (auto-publish)'
      : score >= 88
      ? 'REVISE (auto-fix loop)'
      : 'DRAFTS (score < 88)',
  axes: scores,
};

console.log(JSON.stringify(result, null, 2));

if (fatalErrors.length > 0) process.exit(3);
if (!result.publishable) process.exit(score >= 88 ? 1 : 2);
process.exit(0);

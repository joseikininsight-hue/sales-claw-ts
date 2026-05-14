// 企業サイトからお問い合わせフォームURLを探す
// /contact, /inquiry, /form, お問い合わせ リンク等を巡回
import { chromium, type Browser, type Page } from 'playwright';

export interface FindContactFormSuccess {
  found: true;
  formUrl: string;
  method: 'direct_path' | 'contact_page' | 'link_with_form' | 'sub_link';
  linkText?: string;
}

export interface FindContactFormFailure {
  found: false;
  reason: string;
}

export type FindContactFormResult = FindContactFormSuccess | FindContactFormFailure;

interface LinkCandidate {
  href: string;
  text: string;
  priority?: number;
}

interface PatternEntry {
  keywords: string[];
  priority: number;
}

export async function findContactForm(siteUrl: string | undefined | null): Promise<FindContactFormResult> {
  if (!siteUrl) return { found: false, reason: 'URL無し' };

  const browser: Browser = await chromium.launch({ headless: true });
  const page: Page = await browser.newPage({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    locale: 'ja-JP',
  });

  try {
    await page.goto(siteUrl, { waitUntil: 'domcontentloaded', timeout: 12000 });
    await page.waitForTimeout(2000);

    // 1. ページ内のリンクからフォームURLを探す
    const links: LinkCandidate[] = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('a')).map((a: any) => ({
        href: (a as HTMLAnchorElement).href,
        text: (a.textContent ?? '').trim().substring(0, 40),
      })).filter((l: any) => l.href && l.href.startsWith('http'));
    });

    // 問い合わせ系リンクを優先度順でチェック
    const patterns: PatternEntry[] = [
      { keywords: ['パートナー', '協業', '協力会社', 'partner'], priority: 1 },
      { keywords: ['問い合わせ', 'お問合', 'contact', 'inquiry', 'toiawase'], priority: 2 },
      { keywords: ['フォーム', 'form'], priority: 3 },
    ];

    const candidates: LinkCandidate[] = [];
    for (const link of links) {
      const combined = (link.text + ' ' + link.href).toLowerCase();
      for (const p of patterns) {
        if (p.keywords.some((k: any) => combined.includes(k))) {
          if (link.href.startsWith('tel:') || link.href.startsWith('mailto:') ||
              link.href.endsWith('.pdf') || link.href === siteUrl ||
              link.href === siteUrl + '#') continue;
          candidates.push({ ...link, priority: p.priority });
          break;
        }
      }
    }

    candidates.sort((a: any, b: any) => (a.priority ?? 99) - (b.priority ?? 99));

    if (candidates.length === 0) {
      // 2. よくあるURL直接アクセスを試す
      const commonPaths = ['/contact/', '/inquiry/', '/contact', '/inquiry', '/form/', '/toiawase/'];
      const base = siteUrl.replace(/\/+$/, '');
      for (const p of commonPaths) {
        try {
          const res: any = await page.goto(base + p, { waitUntil: 'domcontentloaded', timeout: 8000 });
          if (res && res.status() < 400) {
            await page.waitForTimeout(1000);
            const hasForm: any = await page.evaluate(() => {
              const forms = document.querySelectorAll('form');
              const inputs = document.querySelectorAll('input[type="text"], input[type="email"], textarea');
              return forms.length > 0 && inputs.length >= 2;
            });
            if (hasForm) {
              await browser.close();
              return { found: true, formUrl: base + p, method: 'direct_path' };
            }
            const pageText: any = await page.evaluate(() => document.body.innerText.substring(0, 500));
            if (pageText.includes('問い合わせ') || pageText.includes('お問合') || pageText.includes('Contact')) {
              await browser.close();
              return { found: true, formUrl: base + p, method: 'contact_page' };
            }
          }
        } catch { /* skip */ }
      }

      await browser.close();
      return { found: false, reason: 'リンクも定型URLも見つからない' };
    }

    // 3. 候補リンク先を順番にチェック
    for (const candidate of candidates.slice(0, 3)) {
      try {
        await page.goto(candidate.href, { waitUntil: 'domcontentloaded', timeout: 10000 });
        await page.waitForTimeout(1500);

        const hasForm: any = await page.evaluate(() => {
          const forms = document.querySelectorAll('form');
          const inputs = document.querySelectorAll('input[type="text"], input[type="email"], textarea');
          const iframes = document.querySelectorAll('iframe[src*="form"], iframe[src*="contact"]');
          return (forms.length > 0 && inputs.length >= 2) || iframes.length > 0;
        });

        if (hasForm) {
          await browser.close();
          return { found: true, formUrl: candidate.href, method: 'link_with_form', linkText: candidate.text };
        }

        // 振り分けページかもしれない: さらにリンクを辿る
        const subLinks: LinkCandidate[] = await page.evaluate(() => {
          return Array.from(document.querySelectorAll('a')).map((a: any) => ({
            href: (a as HTMLAnchorElement).href,
            text: (a.textContent ?? '').trim().substring(0, 40),
          })).filter((l: any) => {
            const t = (l.text + ' ' + l.href).toLowerCase();
            return (t.includes('その他') || t.includes('一般') || t.includes('パートナー') ||
                    t.includes('協業') || t.includes('フォーム') || t.includes('form')) &&
                   l.href.startsWith('http') && l.text.length > 0;
          });
        });

        if (subLinks.length > 0) {
          await browser.close();
          return { found: true, formUrl: subLinks[0].href, method: 'sub_link', linkText: subLinks[0].text };
        }

        await browser.close();
        return { found: true, formUrl: candidate.href, method: 'contact_page', linkText: candidate.text };

      } catch { /* skip to next candidate */ }
    }

    await browser.close();
    return { found: false, reason: 'リンク先にフォームなし' };

  } catch (e: unknown) {
    await browser.close();
    const msg = e instanceof Error ? e.message : String(e);
    return { found: false, reason: 'アクセスエラー: ' + msg.substring(0, 60) };
  }
}

module.exports = { findContactForm };

if (require.main === module) {
  const url = process.argv[2];
  if (!url) { console.log('Usage: node form-finder.js <siteUrl>'); process.exit(1); }
  findContactForm(url).then((r) => console.log(JSON.stringify(r, null, 2)));
}

// フォームページの事前検証
// 問い合わせフォームとして有効かどうかを判定し、無効なら理由を返す
import { chromium, type Browser, type Page, type Frame, type ElementHandle } from 'playwright';

export type FormValidatorType =
  | 'self_hosted'
  | 'iframe_embedded'
  | 'redirect_page'
  | 'email_only'
  | 'rejected'
  | 'unknown'
  | 'error';

export interface FormValidatorResult {
  valid: boolean;
  reason: string;
  formType: FormValidatorType;
  actualFormUrl: string | null;
  fieldCount?: number;
  hasTextarea?: boolean;
  hasEmailField?: boolean;
  emails?: string[];
  suggestedLinks?: Array<{ href: string; text: string }>;
}

interface MainFormInfo {
  action: string;
  method: string;
  fieldCount: number;
  hasTextarea: boolean;
  hasEmailField: boolean;
}

interface IframeInfo {
  src: string;
  width: string;
  height: string;
}

interface IframeFormSummary {
  fieldCount: number;
  hasTextarea: boolean;
}

interface PageAnalysis {
  mailtoLinks: string[];
  phoneCount: number;
  formLinks: Array<{ href: string; text: string }>;
  rejectSales: boolean;
  textLength: number;
}

/** URL にアクセスして問い合わせフォームとして有効かを判定する */
export async function validateFormPage(url: string): Promise<FormValidatorResult> {
  const browser: Browser = await chromium.launch({ headless: true });
  const page: Page = await browser.newPage({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    locale: 'ja-JP',
  });

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(2000);

    // --- 判定1: メインページのフォーム ---
    const mainFormInfo: MainFormInfo[] = await page.evaluate(() => {
      const forms = document.querySelectorAll('form');
      const validForms: MainFormInfo[] = [];

      forms.forEach((form: any) => {
        const inputs = form.querySelectorAll('input, textarea, select');
        const textInputs = Array.from(inputs).filter((el: any) => {
          const t = (el as HTMLInputElement).type ?? '';
          return ['text', 'email', 'tel', 'url', ''].includes(t) || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT';
        });
        const isSearchForm = Array.from(inputs).some((el: any) =>
          ((el as HTMLInputElement).name ?? '').toLowerCase().match(/^(q|query|search|keyword|s)$/) ||
          ((el as HTMLInputElement).placeholder ?? '').includes('検索') ||
          ((el as HTMLInputElement).placeholder ?? '').includes('search')
        );

        if (textInputs.length >= 2 && !isSearchForm) {
          validForms.push({
            action: (form as HTMLFormElement).action,
            method: (form as HTMLFormElement).method,
            fieldCount: textInputs.length,
            hasTextarea: Array.from(inputs).some((el: any) => el.tagName === 'TEXTAREA'),
            hasEmailField: Array.from(inputs).some((el: any) =>
              (el as HTMLInputElement).type === 'email'
              || ((el as HTMLInputElement).name ?? '').toLowerCase().includes('mail')
            ),
          });
        }
      });

      return validForms;
    });

    if (mainFormInfo.length > 0) {
      const best = mainFormInfo[0];
      await browser.close();
      return {
        valid: true,
        reason: '入力可能なフォームを検出',
        formType: 'self_hosted',
        actualFormUrl: url,
        fieldCount: best.fieldCount,
        hasTextarea: best.hasTextarea,
        hasEmailField: best.hasEmailField,
      };
    }

    // --- 判定2: iframe 埋め込みフォーム ---
    const iframeInfo: IframeInfo[] = await page.evaluate(() => {
      const iframes = document.querySelectorAll('iframe');
      return Array.from(iframes)
        .map((f: any) => ({ src: (f as HTMLIFrameElement).src, width: (f as HTMLIFrameElement).width, height: (f as HTMLIFrameElement).height }))
        .filter((f: any) => f.src && (
          f.src.includes('form') || f.src.includes('contact') ||
          f.src.includes('inquiry') || f.src.includes('hsforms') ||
          f.src.includes('formrun') || f.src.includes('form.run') ||
          f.src.includes('formmailer') || f.src.includes('movabletype')
        ));
    });

    if (iframeInfo.length > 0) {
      const iframe: ElementHandle<SVGElement | HTMLElement> | null = await page.$(
        'iframe[src*="form"], iframe[src*="contact"], iframe[src*="inquiry"], iframe[src*="hsforms"], iframe[src*="formrun"], iframe[src*="form.run"], iframe[src*="movabletype"]'
      );
      if (iframe) {
        const frame: Frame | null = await iframe.contentFrame();
        if (frame) {
          const iframeFormInfo: IframeFormSummary | null = await frame.evaluate(() => {
            const forms = document.querySelectorAll('form');
            if (forms.length === 0) return null;
            const inputs = forms[0].querySelectorAll('input, textarea, select');
            const textInputs = Array.from(inputs).filter((el: any) => {
              const t = (el as HTMLInputElement).type ?? '';
              return ['text', 'email', 'tel', 'url', ''].includes(t) || el.tagName === 'TEXTAREA';
            });
            return { fieldCount: textInputs.length, hasTextarea: Array.from(inputs).some((el: any) => el.tagName === 'TEXTAREA') };
          });

          if (iframeFormInfo && iframeFormInfo.fieldCount >= 2) {
            await browser.close();
            return {
              valid: true,
              reason: 'iframe埋め込みフォームを検出（' + iframeInfo[0].src.substring(0, 60) + '）',
              formType: 'iframe_embedded',
              actualFormUrl: url,
              fieldCount: iframeFormInfo.fieldCount,
              hasTextarea: iframeFormInfo.hasTextarea,
            };
          }
        }
      }
    }

    // --- 判定3: メールアドレスのみ / 振り分けページ ---
    const pageAnalysis: PageAnalysis = await page.evaluate(() => {
      const text = document.body.innerText;
      const _html = document.body.innerHTML;

      const mailtoLinks = Array.from(document.querySelectorAll('a[href^="mailto:"]'))
        .map((a: any) => (a as HTMLAnchorElement).href.replace('mailto:', ''));

      const phonePattern = text.match(/\d{2,4}-\d{2,4}-\d{3,4}/g) ?? [];

      const formLinks = Array.from(document.querySelectorAll('a'))
        .map((a: any) => ({ href: (a as HTMLAnchorElement).href, text: (a.textContent ?? '').trim() }))
        .filter((l: any) => {
          const t = (l.text + ' ' + l.href).toLowerCase();
          return (t.includes('問い合わせ') || t.includes('お問合') || t.includes('フォーム') ||
                  t.includes('contact') || t.includes('inquiry') || t.includes('form')) &&
                 l.href.startsWith('http') && l.text.length > 0 && l.text.length < 40 &&
                 l.href !== location.href;
        });

      const rejectSales = text.includes('営業のメールはこちらでは承ることはできません') ||
                          text.includes('営業目的のお問い合わせはご遠慮') ||
                          text.includes('セールス・勧誘はお断り') ||
                          text.includes('営業・売り込みはご遠慮');

      return { mailtoLinks, phoneCount: phonePattern.length, formLinks, rejectSales, textLength: text.length };
    });

    if (pageAnalysis.rejectSales) {
      await browser.close();
      return {
        valid: false,
        reason: '営業お断りの記載あり',
        formType: 'rejected',
        actualFormUrl: null,
      };
    }

    if (pageAnalysis.formLinks.length > 0) {
      const priorityKeywords = ['その他', '一般', 'パートナー', '協業', '協力', '提携', 'ビジネス'];
      let bestLink = pageAnalysis.formLinks[0];
      for (const link of pageAnalysis.formLinks) {
        if (priorityKeywords.some((k: any) => link.text.includes(k))) {
          bestLink = link;
          break;
        }
      }

      await browser.close();
      return {
        valid: false,
        reason: '振り分けページ。フォームへのリンクあり',
        formType: 'redirect_page',
        actualFormUrl: bestLink.href,
        suggestedLinks: pageAnalysis.formLinks.slice(0, 5),
      };
    }

    if (pageAnalysis.mailtoLinks.length > 0) {
      await browser.close();
      return {
        valid: false,
        reason: 'メールアドレスのみ（Webフォームなし）',
        formType: 'email_only',
        emails: pageAnalysis.mailtoLinks,
        actualFormUrl: null,
      };
    }

    await browser.close();
    return {
      valid: false,
      reason: '入力可能なフォームが見つからない',
      formType: 'unknown',
      actualFormUrl: null,
    };

  } catch (e: unknown) {
    await browser.close();
    const msg = e instanceof Error ? e.message : String(e);
    return {
      valid: false,
      reason: 'アクセスエラー: ' + msg.substring(0, 80),
      formType: 'error',
      actualFormUrl: null,
    };
  }
}

module.exports = { validateFormPage };

if (require.main === module) {
  const url = process.argv[2];
  if (!url) {
    console.log('Usage: node form-validator.js <url>');
    process.exit(1);
  }
  validateFormPage(url).then((r) => console.log(JSON.stringify(r, null, 2)));
}

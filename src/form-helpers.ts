// フォーム操作ヘルパー関数 (共通)
//
// Playwright Page を直接型付けせず最小限の duck-typing 用 interface を定義する
// (この helper が呼ばれるコンテキストでは Playwright Page or 似たオブジェクトを期待)。

export interface FormFieldDescriptor {
  name?: string;
  id?: string;
}

export interface FormPageLike {
  click: (selector: string, options?: { timeout?: number }) => Promise<unknown>;
  evaluate: <T>(fn: (selector: string) => T, selector: string) => Promise<T>;
}

/**
 * チェックボックスを確実にクリックする (複数パターン対応)
 * パターン1: 通常の visible checkbox → click
 * パターン2: CSS非表示 (カスタムUI) → label をクリック
 * パターン3: wpcf7-acceptance 等 → 親label/spanをクリック
 * パターン4: どれも失敗 → JS で直接 checked = true
 */
export async function clickCheckbox(formPage: FormPageLike, field: FormFieldDescriptor): Promise<boolean> {
  const sel = field.name ? `input[name="${field.name}"]` : `#${field.id ?? ''}`;

  // パターン1: 直接クリック
  try {
    await formPage.click(sel, { timeout: 2000 });
    return true;
  } catch { /* fall through */ }

  // パターン2: 親の label 要素をクリック
  try {
    const clicked: any = await formPage.evaluate<boolean>((selector) => {
      const cb = document.querySelector(selector) as HTMLInputElement | null;
      if (!cb) return false;
      const label = cb.closest('label');
      if (label) { (label as HTMLLabelElement).click(); return true; }
      return false;
    }, sel);
    if (clicked) return true;
  } catch { /* fall through */ }

  // パターン3: 隣接する label や span をクリック
  try {
    const clicked: any = await formPage.evaluate<boolean>((selector) => {
      const cb = document.querySelector(selector) as HTMLInputElement | null;
      if (!cb) return false;
      const span = cb.parentElement?.querySelector('.wpcf7-list-item-label, .wpcf7-acceptance label, span') as HTMLElement | null;
      if (span) { span.click(); return cb.checked; }
      const next = cb.nextElementSibling as HTMLElement | null;
      if (next && (next.tagName === 'LABEL' || next.tagName === 'SPAN')) { next.click(); return cb.checked; }
      return false;
    }, sel);
    if (clicked) return true;
  } catch { /* fall through */ }

  // パターン4: JS で直接チェック (最終手段)
  try {
    await formPage.evaluate<void>((selector) => {
      const cb = document.querySelector(selector) as HTMLInputElement | null;
      if (cb) {
        cb.checked = true;
        cb.dispatchEvent(new Event('change', { bubbles: true }));
        cb.dispatchEvent(new Event('click', { bubbles: true }));
      }
    }, sel);
    const isChecked: any = await formPage.evaluate<boolean>((selector) => {
      const cb = document.querySelector(selector) as HTMLInputElement | null;
      return cb ? cb.checked : false;
    }, sel);
    return isChecked;
  } catch { /* fall through */ }

  return false;
}

module.exports = { clickCheckbox };

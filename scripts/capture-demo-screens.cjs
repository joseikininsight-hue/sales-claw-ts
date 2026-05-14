'use strict';

/**
 * デモダッシュボード (port 3766) の各タブを light/dark 両モードでスクショ撮影し、
 * public/images/screen-{tab}.png (= 暗) / screen-{tab}-dark.png (= 明) に保存する。
 *
 * LP のライトモード時にはダーク画面を、ダークモード時にはライト画面を見せる演出
 * (= ScreenImage 内で src が light、srcDark が dark スロットに対応するが、ユーザ要望で逆配置にする)
 *
 * 使い方:
 *   1) 別ターミナルで `npm run demo:start`
 *   2) このスクリプト実行: `node scripts/capture-demo-screens.cjs`
 */

const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const DEMO_URL = process.env.DEMO_URL || 'http://127.0.0.1:3766';
const OUT_DIR = path.join(__dirname, '..', 'public', 'images');
const VIEWPORT = { width: 1600, height: 1000 };

// SCREENS と一致させる順序
const TABS = [
  { key: 'dashboard',    buttonText: 'ダッシュボード', file: 'screen-dashboard' },
  { key: 'companies',    buttonText: '企業一覧',       file: 'screen-companies' },
  { key: 'list-builder', buttonText: 'リスト作成',     file: 'screen-list-builder' },
  { key: 'approval',     buttonText: '確認待ち',       file: 'screen-approval' },
  { key: 'sent',         buttonText: '送信済み',       file: 'screen-sent' },
  { key: 'cli',          buttonText: 'CLI Activity',   file: 'screen-cli' },
  { key: 'settings',     buttonText: '設定',           file: 'screen-settings' },
];

async function setTheme(page, theme) {
  await page.evaluate((t) => {
    try { localStorage.setItem('sc-theme', t); } catch (_) {}
    try { localStorage.setItem('theme', t); } catch (_) {}
    document.documentElement.setAttribute('data-theme', t);
    document.documentElement.classList.toggle('dark', t === 'dark');
  }, theme);
}

async function waitForFullyLoaded(page) {
  // 1) フォントロード
  await page.evaluate(() => (document.fonts && document.fonts.ready) ? document.fonts.ready : Promise.resolve());

  // 2) 全 <img> の load 完了
  await page.evaluate(() => Promise.all(
    Array.from(document.images)
      .filter((img) => !img.complete)
      .map((img) => new Promise((res) => { img.onload = img.onerror = res; }))
  ));

  // 3) Chart.js が実際に何かを描画したかをピクセル単位で確認
  //    canvas の透明ピクセルが残っているうちは「未描画」と判定
  try {
    await page.waitForFunction(() => {
      const canvases = document.querySelectorAll('canvas');
      if (canvases.length === 0) return true;
      return Array.from(canvases).every((c) => {
        if (c.width <= 1 || c.height <= 1) return false;
        try {
          const ctx = c.getContext('2d');
          if (!ctx) return true;
          // canvas の中央付近 + 四隅でサンプリングし、不透明ピクセルが 1 つでもあれば描画済み
          const w = c.width, h = c.height;
          const samplePoints = [
            [Math.floor(w * 0.25), Math.floor(h * 0.5)],
            [Math.floor(w * 0.5),  Math.floor(h * 0.5)],
            [Math.floor(w * 0.75), Math.floor(h * 0.5)],
            [Math.floor(w * 0.5),  Math.floor(h * 0.25)],
            [Math.floor(w * 0.5),  Math.floor(h * 0.75)],
          ];
          for (const [x, y] of samplePoints) {
            const px = ctx.getImageData(x, y, 1, 1).data;
            if (px[3] > 0) return true;
          }
          return false;
        } catch { return true; }
      });
    }, { timeout: 10000 });
  } catch (_) { /* タブによっては描画開始まで時間がかかるが先に進める */ }

  // 4) 主要 KPI 数字が初期値 0 から実値に変わるのを待つ (ダッシュボードのみ。他タブは即 true)
  try {
    await page.waitForFunction(() => {
      // 「対象」のスタッツが表示されている (=ダッシュボード) 場合のみチェック
      const totalCard = Array.from(document.querySelectorAll('*'))
        .find((el) => el.textContent && el.textContent.trim() === '対象');
      if (!totalCard) return true;
      // 兄弟か親方向に数字を探す
      const card = totalCard.closest('[class*="stat"], .stat, .stat-card, *');
      if (!card) return true;
      const text = card.textContent || '';
      // 「対象 NN 全体の件数」のような形で N が 1 以上であること
      const m = text.match(/対象\s*(\d+)/);
      if (!m) return true;
      return Number(m[1]) > 0;
    }, { timeout: 8000 });
  } catch (_) {}

  // 5) Chart.js のアニメーション完了 + 余裕
  await page.waitForTimeout(1500);
}

async function gotoTab(page, buttonText) {
  const button = page.getByRole('button', { name: new RegExp(buttonText) }).first();
  await button.click({ timeout: 10000 });
  // タブ遷移後の data-fetch + アニメーション + Chart 再描画完了まで待つ
  await page.waitForTimeout(600);
  await waitForFullyLoaded(page);
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2 });
  const page = await context.newPage();

  console.log('[capture] navigate', DEMO_URL);

  // Chart.js のアニメーションを無効化するスクリプトを事前注入
  await context.addInitScript(() => {
    // @ts-ignore
    Object.defineProperty(window, '__SC_NO_ANIM__', { value: true });
    const obs = new MutationObserver(() => {
      // @ts-ignore
      if (window.Chart && window.Chart.defaults) {
        // @ts-ignore
        window.Chart.defaults.animation = false;
        // @ts-ignore
        window.Chart.defaults.animations = { colors: false, x: false, y: false };
      }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
  });

  await page.goto(DEMO_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  // 初回ロードはアセット (フォント/icon font/JS bundle) が大きいので余裕を持って待つ
  await page.waitForTimeout(3000);
  await waitForFullyLoaded(page);

  for (const theme of ['light', 'dark']) {
    console.log('[capture] === theme:', theme);
    await setTheme(page, theme);
    await page.waitForTimeout(400);

    for (const tab of TABS) {
      try {
        await gotoTab(page, tab.buttonText);
        const fileSuffix = theme === 'dark' ? '-dark' : '';
        const out = path.join(OUT_DIR, tab.file + fileSuffix + '.png');
        await page.screenshot({ path: out, fullPage: false });
        console.log('  ✓', tab.buttonText, '→', path.basename(out));
      } catch (e) {
        console.warn('  ✗', tab.buttonText, e.message);
      }
    }
  }

  await browser.close();
  console.log('[capture] done. files in:', OUT_DIR);
})().catch((e) => {
  console.error('[capture] failed:', e);
  process.exit(1);
});

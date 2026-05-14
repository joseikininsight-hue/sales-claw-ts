// Demo Mode — LP の /demo ページから iframe で埋め込まれる「疑似体験」専用モード。
//
// 環境変数 SALES_CLAW_DEMO=1 で有効化される。
// - ダッシュボード認証 (token/origin) を全面バイパスし、別オリジン LP からの iframe 埋め込みを許可する
// - フォーム送信・AI 起動・自動更新インストール・list-builder 実行など、外部影響/破壊的副作用のあるエンドポイントは 403 で即拒否
// - 設定/ログ/履歴は SALES_CLAW_USER_DATA_DIR で指定された一時ディレクトリ (= デモ用シード) のみを参照する
//
// ⚠️ 認証バイパスなので、本物のユーザデータが入っているマシンで誤って起動しないよう、
//    起動時に SALES_CLAW_USER_DATA_DIR がデモ専用ディレクトリ (/demo を含む) であることをチェックする。

import type { ServerResponse } from 'http';

export function isDemoMode(): boolean {
  return process.env.SALES_CLAW_DEMO === '1';
}

const DEMO_BLOCKED_PATHS: string[] = [
  '/api/launch-ai',
  '/api/launch-ai-external',
  '/api/stop-ai',
  '/api/ai-input',
  '/api/cli-input',
  '/api/install-claude-cli',
  '/api/install-ai-cli',
  '/api/install-update',
  '/api/ai-form-fill',
  '/api/parallel-form-fill',
  '/api/managed-ai',
  '/api/form-session',
  '/api/approve',
  '/api/recovery/resume',
  '/api/recovery/discard',
  '/api/list-builder/run',
  '/api/list-builder/commit',
  '/api/list-builder/runs',
  '/api/import',
  '/api/target-list/import',
  '/api/email/sync',
];

export function isBlockedInDemo(pathname: string, method: string): boolean {
  if (!isDemoMode()) return false;
  if (method === 'GET') return false;
  if (pathname === '/api/list-builder/runs' && method === 'GET') return false;
  return DEMO_BLOCKED_PATHS.some((p: any) => pathname === p || pathname.startsWith(p + '/'));
}

export function sendDemoBlockedResponse(res: ServerResponse, pathname: string): void {
  if (res.headersSent) return;
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify({
    ok: false,
    error: 'demo_mode_readonly',
    message: 'これはデモ環境です。実際の送信・AI 起動・インストール・リスト生成などの操作は無効化されています。',
    path: pathname,
  }));
}

/**
 * iframe 埋め込みを許可するため、デモ時は frame-ancestors / X-Frame-Options を緩和する。
 * 許可するオリジンは LP のデプロイ先ドメイン + ローカル開発の 3000 番。
 */
export function getDemoFrameAncestors(): string {
  const fromEnv = (process.env.SALES_CLAW_DEMO_FRAME_ANCESTORS ?? '').trim();
  if (fromEnv) return fromEnv;
  return [
    "'self'",
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'https://salesclaw.app',
    'https://www.salesclaw.app',
    'https://salesclaw.vercel.app',
  ].join(' ');
}

/**
 * 「これはデモです」バナーを HTML <body> 直後に挿入するための差し込み HTML。
 * dashboard-server の buildPage() の最終 HTML に対して 1 箇所だけ差し込む。
 */
export function getDemoBannerHtml(): string {
  return [
    '<div id="sc-demo-banner" role="status" aria-live="polite" style="',
    'position:fixed;top:0;left:0;right:0;z-index:99999;',
    'padding:6px 16px;text-align:center;font-size:12px;font-weight:700;',
    "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;",
    'color:#ffffff;',
    'background:linear-gradient(90deg,#2563eb 0%,#7c3aed 100%);',
    'box-shadow:0 2px 8px rgba(0,0,0,.12);letter-spacing:.02em;">',
    'これはインタラクティブデモです — 実際の送信・AI 起動・インストールは無効化されています',
    '</div>',
    '<style>body{padding-top:30px!important}</style>',
  ].join('');
}

export interface InjectDemoBannerOptions {
  embed?: boolean;
}

export function injectDemoBanner(html: string, options: InjectDemoBannerOptions = {}): string {
  if (!isDemoMode() || typeof html !== 'string') return html;
  // LP の /demo から iframe で開かれている場合 (?embed=1) は LP 側に StickyBanner があるので
  // ダッシュボード本体側のバナーは挿入しない。
  if (options.embed) return html;
  const idx = html.indexOf('<body');
  if (idx < 0) return html;
  const closeIdx = html.indexOf('>', idx);
  if (closeIdx < 0) return html;
  return html.slice(0, closeIdx + 1) + getDemoBannerHtml() + html.slice(closeIdx + 1);
}

/**
 * デモ用にユーザデータディレクトリが本当にデモ専用か検証する。
 * 「demo」または「temp」を含まないパスは絶対に使わない (本物の data を上書きしないため)。
 */
export function assertDemoDataDirIsSafe(dir: string | undefined | null): void {
  if (!dir || typeof dir !== 'string') {
    throw new Error('[demo-mode] SALES_CLAW_USER_DATA_DIR が未設定です');
  }
  const normalized = dir.replace(/\\/g, '/').toLowerCase();
  const safe = /(demo|temp|tmp)/.test(normalized);
  if (!safe) {
    throw new Error('[demo-mode] SALES_CLAW_USER_DATA_DIR にデモ専用パスを指定してください (demo/temp/tmp を含むこと): ' + dir);
  }
}

module.exports = {
  isDemoMode,
  isBlockedInDemo,
  sendDemoBlockedResponse,
  getDemoFrameAncestors,
  getDemoBannerHtml,
  injectDemoBanner,
  assertDemoDataDirIsSafe,
};

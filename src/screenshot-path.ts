// Screenshot static-serving path safety.
//
// `/screenshots/ss-{No}-{suffix}.png` を settings.getScreenshotDir() 配下から
// 配信する際の path-traversal ガードを純関数として切り出したもの。
//
// 背景: dashboard-server.ts には同じ URL prefix を処理するブロックが2つあり、
//   先行ブロックが全分岐 return するため2つ目は到達不能なデッドコードだった。
//   ガードロジックをここに集約し、トラバーサル payload (../, ..%2f, 絶対パス,
//   UNC パス) を明示的に単体テストできるようにする。

import * as path from 'path';

const SCREENSHOTS_PREFIX = '/screenshots/';

/**
 * `/screenshots/<relative>` の relative 部分が安全か判定する。
 * - 空文字 / 非文字列 → 不許可
 * - `..` を含む (親ディレクトリ脱出) → 不許可
 * - NUL バイト → 不許可
 * - `.png` 以外の拡張子 → 不許可 (任意ファイル読み出し防止)
 */
export function isSafeScreenshotRelative(relative: unknown): relative is string {
  if (typeof relative !== 'string' || relative.length === 0) return false;
  if (relative.includes('..')) return false;
  if (relative.includes('\0')) return false;
  // バックスラッシュは全プラットフォームで拒否する。Windows では区切り文字
  // (UNC \\server\share 含む)、Linux ではファイル名の一部として解釈が割れ、
  // Linux だと `\\server\share\x.png` が baseDir 配下の 1 ファイル扱いで
  // ガードを素通りしていた。正規のスクショ名 (ss-{No}-{suffix}.png) に
  // バックスラッシュは現れないため一律拒否で問題ない。
  if (relative.includes('\\')) return false;
  if (!relative.toLowerCase().endsWith('.png')) return false;
  return true;
}

/**
 * pathname (`/screenshots/...`) と screenshotDir から、配信して良い絶対パスを解決する。
 * 危険・不正な場合は null を返す (呼び出し側で 400 を返す想定)。
 *
 * resolved パスが screenshotDir 配下 (path.sep 境界含む厳密な接頭辞一致) に
 * あることを確認するため、`screenshots-evil/` のような兄弟ディレクトリ接頭辞
 * バイパスも防ぐ。
 */
export function resolveScreenshotPath(pathname: string, screenshotDir: string): string | null {
  if (typeof pathname !== 'string' || !pathname.startsWith(SCREENSHOTS_PREFIX)) return null;
  let relative: string;
  try {
    relative = decodeURIComponent(pathname.slice(SCREENSHOTS_PREFIX.length));
  } catch {
    // 不正な %-エンコード (壊れた %2f トリック等)
    return null;
  }
  if (!isSafeScreenshotRelative(relative)) return null;

  const baseDir = path.resolve(screenshotDir || 'screenshots');
  const resolved = path.resolve(baseDir, relative);
  // 絶対パス / UNC パスが relative に入った場合は path.resolve が baseDir を
  // 無視して resolved が baseDir 配下から外れるため、ここで弾かれる。
  if (resolved !== baseDir && !resolved.startsWith(baseDir + path.sep)) return null;
  return resolved;
}

module.exports = { isSafeScreenshotRelative, resolveScreenshotPath };

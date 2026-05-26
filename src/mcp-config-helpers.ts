// Pure helper logic for managed MCP config decisions.
//
// 切り出し理由:
//  - dashboard-server は Electron / WebSocket / 多数の require 依存があり、
//    純ロジックだけのテストが困難。
//  - 判定ロジックはクロスプラットフォームで微妙な分岐 (Windows のみで .cmd
//    シムを置換) を持つので回帰テストが必要。
//  - 1 ファイル 1 関数で副作用ゼロ。新しい MCP 種別を追加するときの土台にも
//    使えるよう独立させた。

export interface PlaywrightMcpConfig {
  command?: string;
  args?: string[];
  [key: string]: unknown;
}

/**
 * 既存の playwright MCP 設定が「我々が上書きすべきもの」かどうかを判定する。
 *
 * 上書き対象になるケース:
 *  - command が npm / npx / cmd 系 (spawn 時に必ず子プロセス起動 → cmd.exe popup)
 *  - args に npm / npx を含む
 *  - Windows 環境で command が .cmd / .bat
 *  - Windows 環境で command が "playwright-mcp" 単体 (PATH lookup → .cmd 解決)
 *
 * 上書きしないケース:
 *  - 既存設定が無い (≒ 上書きするしかない、true を返すが呼び出し側は新規作成扱い)
 *  - command が本物の .exe (Windows でも cmd.exe を経由しない)
 *  - Linux/macOS の `/usr/local/bin/playwright-mcp` 等のネイティブコマンド
 *  - ユーザーが意図的に独自ラッパーを指している
 */
export function shouldOverridePlaywrightMcpConfig(
  existingPlaywright: PlaywrightMcpConfig | null | undefined,
  platform: NodeJS.Platform | string = process.platform
): boolean {
  if (!existingPlaywright || typeof existingPlaywright !== 'object') return true;

  const existingCommand = String(existingPlaywright.command ?? '').toLowerCase();
  // command が空 (empty object や typo) は spawn できないので上書き対象
  if (!existingCommand) return true;

  const existingArgs = Array.isArray(existingPlaywright.args)
    ? existingPlaywright.args.join(' ').toLowerCase()
    : '';

  // npm / npx ベースは全プラットフォームで上書き対象
  const usesSystemPackageManager =
    /(^|[\\/])(npm|npx)(\.cmd|\.exe)?$/.test(existingCommand)
    || ['npm', 'npx', 'cmd', 'cmd.exe'].includes(existingCommand)
    || /\b(npm|npx)\b/.test(existingArgs);
  if (usesSystemPackageManager) return true;

  // .cmd / .bat シムと bundled basename は Windows でのみ popup 問題を起こす
  if (platform === 'win32') {
    if (/\.(cmd|bat)$/i.test(existingCommand)) return true;
    const basename = (existingCommand.split(/[\\/]/).pop() ?? '').replace(/\.(cmd|bat)$/i, '');
    if (basename === 'playwright-mcp') return true;
  }

  return false;
}

/**
 * Phase 1 (v2.1.0-pre): 内製 sales-claw-form MCP の設定が「上書きすべきか」を判定する。
 *
 * 上書き対象になるケース:
 *  - 既存設定が無い、または command が空
 *  - command が npm/npx 系 (子 cmd spawn でラグる)
 *  - command が我々の bin/sales-claw-form-mcp.cjs 以外を指している
 *    (古いバージョンの shim path 等 — 上書きして整える)
 *
 * 上書きしないケース:
 *  - 既存設定が我々の shim を正しく指している (= 何もしなくて良い)
 *  - ユーザーが意図的に独自ラッパーを指している (basename が一致しない時のみ)
 *
 * @see docs/architecture/in-app-form-fill.md §1.2, §6.3 R3
 */
export function shouldOverrideInternalFormMcpConfig(
  existing: PlaywrightMcpConfig | null | undefined,
  platform: NodeJS.Platform | string = process.platform,
): boolean {
  if (!existing || typeof existing !== 'object') return true;

  const existingCommand = String(existing.command ?? '').toLowerCase();
  if (!existingCommand) return true;

  const existingArgs = Array.isArray(existing.args)
    ? existing.args.join(' ').toLowerCase()
    : '';

  // npm / npx 系は全プラットフォームで上書き対象 (cmd.exe popup / 起動遅延)
  const usesSystemPackageManager =
    /(^|[\\/])(npm|npx)(\.cmd|\.exe)?$/.test(existingCommand)
    || ['npm', 'npx', 'cmd', 'cmd.exe'].includes(existingCommand)
    || /\b(npm|npx)\b/.test(existingArgs);
  if (usesSystemPackageManager) return true;

  // basename が我々の shim でなければ上書き
  // (basename 一致 = path が変わっただけなので、新しい path に書き換える)
  const commandBase = (existingCommand.split(/[\\/]/).pop() ?? '')
    .replace(/\.(cmd|bat|exe)$/i, '');
  const argsTokens = existingArgs.split(/\s+/).map((token) => {
    const t = token.split(/[\\/]/).pop() || token;
    return t.replace(/\.(cjs|js|cmd|bat|exe)$/i, '');
  });
  const knownShimNames = ['sales-claw-form-mcp', 'sales-claw-form-mcp.cjs'];
  const shimReferenced = knownShimNames.includes(commandBase)
    || argsTokens.some((t) => knownShimNames.includes(t));
  if (!shimReferenced) return true;

  // Windows で .cmd / .bat 経由は popup の原因なので上書き
  if (platform === 'win32') {
    if (/\.(cmd|bat)$/i.test(existingCommand)) return true;
  }

  return false;
}

module.exports = {
  shouldOverridePlaywrightMcpConfig,
  shouldOverrideInternalFormMcpConfig,
};

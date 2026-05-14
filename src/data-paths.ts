// Data path resolver — Sales Claw のランタイムデータ配置先を決定する
import * as fs from 'fs';
import * as path from 'path';

// settings-manager は循環依存になり得るので require() で遅延読み込みする。
// (data-paths は startup 時に呼ばれるため、settings-manager のロード完了前にも安全に動くようにする)
interface SettingsManagerShape {
  getSection?: (key: string) => { dataDir?: string } | undefined;
  getRuntimeRoot?: () => string;
}

function loadSettings(): SettingsManagerShape {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('./settings-manager') as SettingsManagerShape;
}

export const PROJECT_ROOT: string = path.join(__dirname, '..', '..');

export function getDataDir(): string {
  const settings = loadSettings();
  let configured = 'data';
  try {
    const preferences = settings.getSection?.('preferences');
    const raw = preferences?.dataDir;
    if (typeof raw === 'string' && raw.trim().length > 0) {
      configured = raw.trim();
    }
  } catch {
    // settings 読み込み失敗時はデフォルトの 'data' を使う
  }
  const runtimeRoot = typeof settings.getRuntimeRoot === 'function'
    ? settings.getRuntimeRoot()
    : PROJECT_ROOT;
  return path.isAbsolute(configured) ? configured : path.join(runtimeRoot, configured);
}

export function ensureDataDir(): string {
  const dir = getDataDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function resolveDataPath(...segments: string[]): string {
  return path.join(getDataDir(), ...segments);
}

// CommonJS 互換 export — 既存の require() ベースの呼び出しから使えるように
module.exports = {
  PROJECT_ROOT,
  ensureDataDir,
  getDataDir,
  resolveDataPath,
};

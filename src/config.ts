// 設定の読み取りインターフェース
// settings-manager から動的に読み取る (後方互換のため sender 形式を維持)
//
// 注意: settings-manager は循環依存になり得るので require() を遅延評価する。

import type { CompanyProfile } from './types/settings';

interface SettingsManagerShape {
  getSender: () => CompanyProfile;
  get: (...args: string[]) => unknown;
}

// 遅延 require のためゲッタプロパティで wrap する
function lazyLoad(): SettingsManagerShape {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('./settings-manager') as SettingsManagerShape;
}

const exported = {
  get sender(): CompanyProfile {
    return lazyLoad().getSender();
  },
  get inquiryTypes(): string[] {
    const result = lazyLoad().get('messageTemplates', 'inquiryTypes');
    return Array.isArray(result) ? result as string[] : [];
  },
};

export default exported;
module.exports = exported;

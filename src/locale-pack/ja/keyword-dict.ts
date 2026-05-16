// 日本語企業サイトの事業領域・注力領域を判別するためのキーワード辞書
module.exports = {
  businessAreas: {
    'system-integration': ['システム開発', '受託開発', 'SI', 'カスタム開発'],
    cloud: ['クラウド', 'AWS', 'Azure', 'GCP', 'クラウド移行'],
    data: ['データ分析', 'データ基盤', 'BI', 'データパイプライン'],
    'web-app': ['Web開発', 'アプリケーション', 'Webサイト', 'WebApp'],
    ai: ['AI', '人工知能', '機械学習', 'LLM', '生成AI'],
    mobile: ['モバイル', 'iOS', 'Android', 'スマホアプリ'],
    security: ['セキュリティ', 'ペネトレーション', '脆弱性診断'],
    consulting: ['コンサルティング', '業務改善', 'DX'],
  },
  focusAreas: {
    dx: ['DX', 'デジタル変革', 'トランスフォーメーション'],
    'partner-program': ['パートナー', '協業', '取引先', '業務提携'],
    recruiting: ['採用', '人材', 'エンジニア募集'],
  },
};

export {};

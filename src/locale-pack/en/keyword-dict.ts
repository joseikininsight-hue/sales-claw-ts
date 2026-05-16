// 英語企業サイトの事業領域・注力領域を判別するためのキーワード辞書
module.exports = {
  businessAreas: {
    'system-integration': [
      'system integration',
      'custom development',
      'IT services',
      'SI',
      'outsourced development',
    ],
    cloud: ['cloud', 'AWS', 'Azure', 'GCP', 'cloud migration'],
    data: ['data analytics', 'data platform', 'BI', 'data pipeline', 'big data'],
    'web-app': [
      'web development',
      'web application',
      'web app',
      'website development',
    ],
    ai: ['AI', 'artificial intelligence', 'machine learning', 'LLM', 'generative AI'],
    mobile: ['mobile', 'iOS', 'Android', 'mobile app'],
    security: [
      'security',
      'penetration test',
      'vulnerability assessment',
      'cybersecurity',
    ],
    consulting: ['consulting', 'consultancy', 'advisory', 'digital transformation'],
  },
  focusAreas: {
    dx: ['DX', 'digital transformation', 'digital initiative'],
    'partner-program': [
      'partner program',
      'become a partner',
      'reseller program',
      'partnership',
    ],
    recruiting: ['hiring', 'careers', 'recruitment', 'open positions'],
  },
};

export {};

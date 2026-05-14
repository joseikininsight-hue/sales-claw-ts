const fs = require('fs');
const XLSX = require('xlsx');

const settings = require('./settings-manager');

const SHEET_NAMES = {
  guide: 'はじめに',
  companyProfile: '会社プロフィール',
  valueBasics: '提供価値_基本',
  strengths: '強み',
  successPatterns: '協業実績',
  industryProfiles: '業種別プロフィール',
  serviceUrls: 'サービスURL',
  documentPaths: '資料',
  idealCustomer: '理想顧客(ICP)',
};

const ICP_TYPE = {
  description: '説明文',
  mustHave: '必須条件',
  dealBreaker: '除外条件',
  exemplarPos: '好例企業',
  exemplarNeg: '悪例企業',
};

const COMPANY_PROFILE_FIELDS = [
  { key: 'companyName', label: '会社名', level: '必須', description: '問い合わせフォームに入力する法人名', example: 'サンプル株式会社' },
  { key: 'companyNameEn', label: '会社名(英語)', level: '任意', description: '英語フォーム用の法人名', example: 'Sample Inc.' },
  { key: 'companyNameKana', label: '会社名(カナ)', level: '任意', description: 'カナ入力欄がある場合に使用', example: 'サンプルカブシキガイシャ' },
  { key: 'representative', label: '代表者名', level: '任意', description: '会社代表者の名前', example: 'サンプル 太郎' },
  { key: 'contactName', label: '担当者名', level: '必須', description: 'フォームに入力する窓口担当者名', example: '担当者名' },
  { key: 'contactNameKana', label: '担当者名(カナ)', level: '任意', description: '担当者名のカナ表記', example: 'タントウシャメイ' },
  { key: 'contactTitle', label: '担当者役職', level: '任意', description: '役職欄がある場合に使用', example: '営業責任者' },
  { key: 'department', label: '部署名', level: '推奨', description: '部署入力欄がある場合に使用', example: '営業部' },
  { key: 'email', label: 'メールアドレス', level: '必須', description: '送信元メールアドレス', example: 'sample@example.com' },
  { key: 'phone', label: '電話番号', level: '必須', description: 'フォームに入力する代表または担当電話番号', example: '03-0000-0000' },
  { key: 'fax', label: 'FAX番号', level: '任意', description: 'FAX入力欄がある場合に使用', example: '03-0000-0001' },
  { key: 'mobile', label: '携帯番号', level: '任意', description: '携帯番号入力欄がある場合に使用', example: '090-0000-0000' },
  { key: 'postalCode', label: '郵便番号', level: '任意', description: '郵便番号欄がある場合に使用', example: '100-0001' },
  { key: 'address', label: '住所', level: '任意', description: '住所欄がある場合に使用', example: '東京都千代田区サンプル1-1-1' },
  { key: 'addressEn', label: '住所(英語)', level: '任意', description: '英語フォーム用の住所', example: '1-1-1 Sample, Chiyoda-ku, Tokyo' },
  { key: 'website', label: '自社サイトURL', level: '推奨', description: '会社サイトURL', example: 'https://www.example.com/' },
  { key: 'partnerPage', label: 'パートナーページURL', level: '推奨', description: '協業案内やパートナー募集ページURL', example: 'https://www.example.com/partner/' },
  { key: 'corporateProfile', label: '会社概要URL', level: '任意', description: '会社紹介や企業情報ページURL', example: 'https://www.example.com/about/' },
  { key: 'established', label: '設立', level: '任意', description: '設立年月など', example: '2010年4月' },
  { key: 'employeeCount', label: '従業員数', level: '任意', description: '規模感を伝える情報', example: '150名' },
  { key: 'capital', label: '資本金', level: '任意', description: '会社情報として補足したい場合に使用', example: '5,000万円' },
  { key: 'industry', label: '業種', level: '任意', description: '自社業種', example: 'IT・ソフトウェア' },
  { key: 'businessDescription', label: '事業内容', level: '推奨', description: 'フォームや文面作成時の会社説明', example: 'Webサイトや業務システムの制作・運用' },
  { key: 'notes', label: '備考', level: '任意', description: '社内メモ。フォーム入力には使われない', example: '資料送付時の注意点など' },
];

const VALUE_BASIC_FIELDS = [
  { key: 'companyUrl', label: '自社URL', level: '推奨', description: 'Claude が自社情報を補足するために参照するURL', example: 'https://www.example.com/' },
];

const LIST_HINTS = {
  serviceUrls: '例: サービス紹介ページ | https://www.example.com/services/',
  documentPaths: '例: 紹介資料.pdf | docs/intro.pdf | 営業時に参照する資料',
  strengths: '例: web_dev | Webアプリ開発 | 要件整理から実装まで対応 | webアプリ, システム開発',
  successPatterns: '例: サンプルパートナー | Web刷新を技術面で支援した例 | SIer',
  industryProfiles: '例: SIer | 貴社の案件対応において... | Web領域支援の提案文 | 一部工程支援の例 | Web領域の対応力',
};

function normalizeText(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function cloneDefaultSection(section) {
  return structuredClone(settings.DEFAULT_SETTINGS[section]);
}

function loadSampleSettings() {
  try {
    return JSON.parse(fs.readFileSync(settings.SAMPLE_SETTINGS_FILE, 'utf8'));
  } catch (_) {
    return structuredClone(settings.DEFAULT_SETTINGS);
  }
}

function buildGuideSheet(mode) {
  const rows = [
    ['Sales Claw 設定Excel'],
    [mode === 'template' ? 'このテンプレートは、会社プロフィールと提供価値をまとめて入力するためのものです。' : 'このファイルは、現在の会社プロフィールと提供価値をExcelで編集できるようにしたものです。'],
    ['基本ルール'],
    ['1. 会社プロフィール / 提供価値_基本 シートは value 列だけ編集してください。'],
    ['2. 強み / 協業実績 / 業種別プロフィール / サービスURL / 資料 シートは、見出し行の下に必要行を追加して入力してください。'],
    ['3. 理想顧客(ICP) シートは type 列の区分に従い value 列に入力してください。'],
    ['4. 不要な行は削除して構いません。空行は無視されます。'],
    ['5. このExcelを取り込むと、会社プロフィールと提供価値の設定が更新されます。'],
    ['最低限ここは入力'],
    ['会社プロフィール: 会社名 / 担当者名 / メールアドレス / 電話番号'],
    ['提供価値: 強みを最低1件'],
    [],
    ['シート', '用途'],
    [SHEET_NAMES.companyProfile, '会社情報。value 列に入力'],
    [SHEET_NAMES.valueBasics, '提供価値の基本設定。value 列に入力'],
    [SHEET_NAMES.strengths, '自社の強み。1行1件'],
    [SHEET_NAMES.successPatterns, '協業実績。1行1件'],
    [SHEET_NAMES.industryProfiles, '業種別プロフィール。1行1業種'],
    [SHEET_NAMES.serviceUrls, 'サービス紹介URL。1行1件'],
    [SHEET_NAMES.documentPaths, '資料パス。1行1件'],
    [SHEET_NAMES.idealCustomer, '理想顧客(ICP)。type 列で区分、value 列に入力'],
  ];
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [{ wch: 26 }, { wch: 80 }];
  return ws;
}

function buildFieldSheet(fields, values) {
  const rows = [['fieldKey', '項目名', '入力目安', '入力例', '説明', 'value']];
  fields.forEach((field: any) => {
    rows.push([
      field.key,
      field.label,
      field.level,
      field.example,
      field.description,
      normalizeText(values[field.key]),
    ]);
  });
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [
    { wch: 22 },
    { wch: 24 },
    { wch: 10 },
    { wch: 28 },
    { wch: 46 },
    { wch: 36 },
  ];
  ws['!autofilter'] = { ref: `A1:F${rows.length}` };
  return ws;
}

function buildListSheet(headers, rows, hintText) {
  const aoa = [headers];
  if (hintText) {
    const hintRow = new Array(headers.length).fill('');
    hintRow[headers.length - 1] = hintText;
    aoa.push(hintRow);
  }
  rows.forEach((row: any) => aoa.push(row));
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = headers.map((header: any) => ({ wch: Math.max(16, String(header).length + 6) }));
  ws['!autofilter'] = { ref: `A1:${columnLetter(headers.length)}${aoa.length}` };
  return ws;
}

function buildIcpSheet(idealCustomer) {
  const ic = idealCustomer || {};
  const mustHave = Array.isArray(ic.mustHave) ? ic.mustHave : [];
  const dealBreakers = Array.isArray(ic.dealBreakers) ? ic.dealBreakers : [];
  const exemplars = (ic.exemplars && typeof ic.exemplars === 'object') ? ic.exemplars : {};
  const positive = Array.isArray(exemplars.positive) ? exemplars.positive : [];
  const negative = Array.isArray(exemplars.negative) ? exemplars.negative : [];

  const rows = [
    ['type', 'value', '補助（説明）'],
    [ICP_TYPE.description, normalizeText(ic.descriptionFreetext), '理想顧客の自由記述。1行のみ使用'],
  ];

  if (mustHave.length) {
    mustHave.forEach((item: any) => rows.push([ICP_TYPE.mustHave, normalizeText(item), '']));
  } else {
    rows.push([ICP_TYPE.mustHave, '', 'mustHave を1行1件で追加（例: 従業員100名以上）']);
  }

  if (dealBreakers.length) {
    dealBreakers.forEach((item: any) => rows.push([ICP_TYPE.dealBreaker, normalizeText(item), '']));
  } else {
    rows.push([ICP_TYPE.dealBreaker, '', 'dealBreakers を1行1件で追加（例: 個人事業主）']);
  }

  if (positive.length) {
    positive.forEach((item: any) => rows.push([ICP_TYPE.exemplarPos, normalizeText(item), '']));
  } else {
    rows.push([ICP_TYPE.exemplarPos, '', '好例企業名を1行1件で追加']);
  }

  if (negative.length) {
    negative.forEach((item: any) => rows.push([ICP_TYPE.exemplarNeg, normalizeText(item), '']));
  } else {
    rows.push([ICP_TYPE.exemplarNeg, '', '悪例企業名を1行1件で追加']);
  }

  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [{ wch: 14 }, { wch: 60 }, { wch: 36 }];
  ws['!autofilter'] = { ref: `A1:C${rows.length}` };
  return ws;
}

function columnLetter(index) {
  let value = index;
  let result = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result || 'A';
}

function buildWorkbookBuffer({ mode = 'current', settingsData }: { mode?: string; settingsData?: any } = {}) {
  const sample = loadSampleSettings();
  const source = mode === 'current'
    ? (settingsData || settings.getAll())
    : {
        companyProfile: cloneDefaultSection('companyProfile'),
        valuePropositions: cloneDefaultSection('valuePropositions'),
      };
  const wb = XLSX.utils.book_new();

  XLSX.utils.book_append_sheet(wb, buildGuideSheet(mode), SHEET_NAMES.guide);
  XLSX.utils.book_append_sheet(
    wb,
    buildFieldSheet(COMPANY_PROFILE_FIELDS.map((field: any) => ({
      ...field,
      example: normalizeText(sample.companyProfile && sample.companyProfile[field.key]) || field.example,
    })), source.companyProfile || {}),
    SHEET_NAMES.companyProfile,
  );
  XLSX.utils.book_append_sheet(
    wb,
    buildFieldSheet(VALUE_BASIC_FIELDS.map((field: any) => ({
      ...field,
      example: normalizeText(sample.valuePropositions && sample.valuePropositions[field.key]) || field.example,
    })), source.valuePropositions || {}),
    SHEET_NAMES.valueBasics,
  );

  const vp = source.valuePropositions || {};
  XLSX.utils.book_append_sheet(
    wb,
    buildListSheet(
      ['key', 'label', 'detail', 'keywords', '補助'],
      ensureArray(vp.strengths).map((item: any) => [
        normalizeText(item.key),
        normalizeText(item.label),
        normalizeText(item.detail),
        ensureArray(item.keywords).join(', '),
        '',
      ]),
      LIST_HINTS.strengths,
    ),
    SHEET_NAMES.strengths,
  );
  XLSX.utils.book_append_sheet(
    wb,
    buildListSheet(
      ['partner', 'proof', 'type', '補助'],
      ensureArray(vp.successPatterns).map((item: any) => [
        normalizeText(item.partner),
        normalizeText(item.proof),
        normalizeText(item.type),
        '',
      ]),
      LIST_HINTS.successPatterns,
    ),
    SHEET_NAMES.successPatterns,
  );
  XLSX.utils.book_append_sheet(
    wb,
    buildListSheet(
      ['key', 'opener', 'point', 'examples', 'strength', '補助'],
      Object.entries(vp.industryProfiles || {}).map(([key, item]: [string, any]) => [
        normalizeText(key),
        normalizeText(item && item.opener),
        normalizeText(item && item.point),
        normalizeText(item && item.examples),
        normalizeText(item && item.strength),
        '',
      ]),
      LIST_HINTS.industryProfiles,
    ),
    SHEET_NAMES.industryProfiles,
  );
  XLSX.utils.book_append_sheet(
    wb,
    buildListSheet(
      ['label', 'url', '補助'],
      ensureArray(vp.serviceUrls).map((item: any) => [
        normalizeText(item.label),
        normalizeText(item.url),
        '',
      ]),
      LIST_HINTS.serviceUrls,
    ),
    SHEET_NAMES.serviceUrls,
  );
  XLSX.utils.book_append_sheet(
    wb,
    buildListSheet(
      ['name', 'path', 'description', '補助'],
      ensureArray(vp.documentPaths).map((item: any) => [
        normalizeText(item.name),
        normalizeText(item.path),
        normalizeText(item.description),
        '',
      ]),
      LIST_HINTS.documentPaths,
    ),
    SHEET_NAMES.documentPaths,
  );
  XLSX.utils.book_append_sheet(
    wb,
    buildIcpSheet(vp.idealCustomer),
    SHEET_NAMES.idealCustomer,
  );

  wb.Props = {
    Title: mode === 'template' ? 'Sales Claw Settings Template' : 'Sales Claw Settings Export',
    Subject: 'Company Profile and Value Propositions',
    Author: 'Sales Claw',
  };

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

function readSheetRows(workbook, sheetNames) {
  const matched = sheetNames.find((name: any) => workbook.Sheets[name]);
  if (!matched) return null;
  return XLSX.utils.sheet_to_json(workbook.Sheets[matched], { defval: '', raw: false });
}

function parseFieldSheet(rows, defaultSection) {
  if (!rows || !rows.length) return null;
  const result = structuredClone(defaultSection);
  let recognized = 0;
  let hasAnyValue = false;
  rows.forEach((row: any) => {
    const key = normalizeText(row.fieldKey || row.key);
    if (!key || !Object.prototype.hasOwnProperty.call(result, key)) return;
    const value = normalizeText(row.value);
    result[key] = value;
    if (value) hasAnyValue = true;
    recognized += 1;
  });
  return recognized && hasAnyValue ? result : null;
}

function parseListRows(rows, columns, mapper) {
  if (!rows || !rows.length) return null;
  const parsed: unknown[] = [];
  rows.forEach((row: any) => {
    const entry: Record<string, any> = {};
    let hasValue = false;
    columns.forEach((column: any) => {
      const value = normalizeText(row[column]);
      entry[column] = value;
      if (value) hasValue = true;
    });
    if (!hasValue) return;
    parsed.push(mapper(entry));
  });
  return parsed.length ? parsed : null;
}

const XLSX_MAX_BUFFER_SIZE = 50 * 1024 * 1024; // 50MB

function parseWorkbookBuffer(buffer) {
  if (Buffer.isBuffer(buffer) && buffer.length > XLSX_MAX_BUFFER_SIZE) {
    throw new Error(`アップロードファイルが上限(50MB)を超えています`);
  }
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const parsedSections: Record<string, any> = {};
  const applied: unknown[] = [];

  const companyProfile = parseFieldSheet(
    readSheetRows(workbook, [SHEET_NAMES.companyProfile, 'CompanyProfile', 'Company Profile']),
    cloneDefaultSection('companyProfile'),
  );
  if (companyProfile) {
    parsedSections.companyProfile = companyProfile;
    applied.push('companyProfile');
  }

  const vp: Record<string, any> = {};
  let valueSectionsFound = false;

  const basicRows = readSheetRows(workbook, [SHEET_NAMES.valueBasics, 'ValueBasics', 'Value Propositions']);
  const valueBasics = parseFieldSheet(basicRows, { companyUrl: '' });
  if (valueBasics) {
    vp.companyUrl = normalizeText(valueBasics.companyUrl);
    valueSectionsFound = true;
  }

  const strengths = parseListRows(
    readSheetRows(workbook, [SHEET_NAMES.strengths, 'Strengths']),
    ['key', 'label', 'detail', 'keywords'],
    (entry) => ({
      key: entry.key,
      label: entry.label,
      detail: entry.detail,
      keywords: entry.keywords.split(',').map((item: any) => item.trim()).filter(Boolean),
    }),
  );
  if (strengths && strengths.length) {
    vp.strengths = strengths;
    valueSectionsFound = true;
  }

  const successPatterns = parseListRows(
    readSheetRows(workbook, [SHEET_NAMES.successPatterns, 'SuccessPatterns']),
    ['partner', 'proof', 'type'],
    (entry) => ({
      partner: entry.partner,
      proof: entry.proof,
      type: entry.type,
    }),
  );
  if (successPatterns) {
    vp.successPatterns = successPatterns;
    valueSectionsFound = true;
  }

  const serviceUrls = parseListRows(
    readSheetRows(workbook, [SHEET_NAMES.serviceUrls, 'ServiceUrls']),
    ['label', 'url'],
    (entry) => ({
      label: entry.label,
      url: entry.url,
    }),
  );
  if (serviceUrls) {
    vp.serviceUrls = serviceUrls;
    valueSectionsFound = true;
  }

  const documentPaths = parseListRows(
    readSheetRows(workbook, [SHEET_NAMES.documentPaths, 'DocumentPaths']),
    ['name', 'path', 'description'],
    (entry) => ({
      name: entry.name,
      path: entry.path,
      description: entry.description,
    }),
  );
  if (documentPaths) {
    vp.documentPaths = documentPaths;
    valueSectionsFound = true;
  }

  const industryRows = readSheetRows(workbook, [SHEET_NAMES.industryProfiles, 'IndustryProfiles']);
  if (industryRows) {
    const industryProfiles: Record<string, any> = {};
    industryRows.forEach((row: any) => {
      const key = normalizeText(row.key);
      if (!key) return;
      industryProfiles[key] = {
        opener: normalizeText(row.opener),
        point: normalizeText(row.point),
        examples: normalizeText(row.examples),
        strength: normalizeText(row.strength),
      };
    });
    if (Object.keys(industryProfiles).length) {
      vp.industryProfiles = industryProfiles;
      valueSectionsFound = true;
    }
  }

  const icpRows = readSheetRows(workbook, [SHEET_NAMES.idealCustomer, 'ICP', '理想顧客']);
  if (icpRows && icpRows.length) {
    const ic: any = { mustHave: [], dealBreakers: [], exemplars: { positive: [], negative: [] } };
    let icHasValue = false;
    icpRows.forEach((row: any) => {
      const type = normalizeText(row.type);
      const value = normalizeText(row.value);
      if (!value) return;
      icHasValue = true;
      if (type === ICP_TYPE.description) ic.descriptionFreetext = value;
      else if (type === ICP_TYPE.mustHave) ic.mustHave.push(value);
      else if (type === ICP_TYPE.dealBreaker) ic.dealBreakers.push(value);
      else if (type === ICP_TYPE.exemplarPos) ic.exemplars.positive.push(value);
      else if (type === ICP_TYPE.exemplarNeg) ic.exemplars.negative.push(value);
    });
    if (icHasValue) {
      vp.idealCustomer = ic;
      valueSectionsFound = true;
    }
  }

  if (valueSectionsFound) {
    parsedSections.valuePropositions = vp;
    applied.push('valuePropositions');
  }

  if (!applied.length) {
    throw new Error('認識できる設定シートが見つかりませんでした。Sales Claw 用のExcelを選択してください。');
  }

  const senderReady = parsedSections.companyProfile
    && parsedSections.companyProfile.companyName
    && parsedSections.companyProfile.contactName
    && parsedSections.companyProfile.email
    && parsedSections.companyProfile.phone;
  const strengthsCount = parsedSections.valuePropositions
    && Array.isArray(parsedSections.valuePropositions.strengths)
    ? parsedSections.valuePropositions.strengths.length
    : null;

  return {
    sections: parsedSections,
    applied,
    summary: {
      senderReady: !!senderReady,
      strengthsCount,
    },
  };
}

module.exports = {
  SHEET_NAMES,
  buildWorkbookBuffer,
  parseWorkbookBuffer,
};

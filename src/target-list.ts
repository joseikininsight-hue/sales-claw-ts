'use strict';

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const settings = require('./settings-manager');
const { PROJECT_ROOT, resolveDataPath } = require('./data-paths');

const XLSX_MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

// 既存の XLSX/CSV 既定カラム（DEFAULT_COLUMN_MAPPING に列位置を持つ）
const CORE_TARGET_FIELDS = ['no', 'status', 'companyName', 'type', 'url', 'formUrl', 'notes', 'captcha', 'progress'];

// list-builder で生成される拡張カラム
//
// XLSX への永続化はオプション扱い:
//   - DEFAULT_COLUMN_MAPPING には載せない（既存ファイル構造を変えない）
//   - settings.targetList.columnMapping にユーザーが明示した場合のみ XLSX 列に書出し
//   - 既定では Companion JSON (`data/list-builder/records/{no}.json`) に保存
const EXTENDED_TARGET_FIELDS = [
  'corporateNumber',     // 法人番号 (13 桁)
  'officialName',        // 公式名称（法人番号API由来）
  'normalizedName',      // 正規化会社名（dedupe キー）
  'officialAddress',     // 公式所在地
  'domainRoot',          // example.co.jp
  'industry',            // 業種
  'companySize',         // small | medium | large | unknown
  'prefecture',          // 都道府県
  'employeeCount',       // 従業員数（数値）
  'revenue',             // 売上高（百万円）
  'fitScore',            // 0-100
  'sourceConfidence',    // high | medium | low
];

const TARGET_FIELDS = [...CORE_TARGET_FIELDS, ...EXTENDED_TARGET_FIELDS];

// XLSX / CSV の既定カラム位置（既存互換）
const DEFAULT_COLUMN_MAPPING = {
  no: 0,
  status: 1,
  companyName: 2,
  type: 3,
  url: 4,
  formUrl: 5,
  notes: 6,
  captcha: 8,
  progress: 10,
};

const HEADER_LABELS = {
  no: 'No.',
  status: 'Status',
  companyName: 'Company Name',
  type: 'Type',
  url: 'Website URL',
  formUrl: 'Form URL',
  notes: 'Notes',
  captcha: 'CAPTCHA',
  progress: 'Progress',
  corporateNumber: 'Corporate Number',
  officialName: 'Official Name',
  normalizedName: 'Normalized Name',
  officialAddress: 'Official Address',
  domainRoot: 'Domain Root',
  industry: 'Industry',
  companySize: 'Company Size',
  prefecture: 'Prefecture',
  employeeCount: 'Employee Count',
  revenue: 'Revenue (M JPY)',
  fitScore: 'Fit Score',
  sourceConfidence: 'Source Confidence',
};

const HEADER_HINTS = {
  no: ['no', 'no.', 'number', 'id', '番号', '管理番号'],
  status: ['status', 'ステータス', '判定'],
  companyName: ['companyname', 'company', 'company_name', '企業名', '会社名', '法人名', '名称'],
  type: ['type', 'category', 'kind', '種別', '業種', 'カテゴリ', '分類'],
  url: ['websiteurl', 'website', 'siteurl', 'site', 'weburl', 'url', 'web', 'homepage', 'hp', 'webサイト', 'ホームページ'],
  formUrl: ['formurl', 'contacturl', 'inquiryurl', '問い合わせフォームurl', 'お問い合わせフォームurl', '問い合わせurl', 'お問い合わせurl', 'form', 'contact', 'inquiry', 'toiawase'],
  notes: ['notes', 'note', 'memo', '備考', 'メモ', 'コメント'],
  captcha: ['captcha', 'recaptcha', 're-captcha'],
  progress: ['progress', '進捗', '対応状況'],
  corporateNumber: ['corporatenumber', 'corp_number', '法人番号'],
  officialName: ['officialname', '正式名称', '公式名称'],
  normalizedName: ['normalizedname', '正規化名'],
  officialAddress: ['officialaddress', '所在地', '本店所在地'],
  domainRoot: ['domainroot', 'domain', 'ドメイン'],
  industry: ['industry'],
  companySize: ['companysize', 'size', '規模'],
  prefecture: ['prefecture', '都道府県', '所在県'],
  employeeCount: ['employeecount', 'employees', '従業員数'],
  revenue: ['revenue', '売上', '売上高'],
  fitScore: ['fitscore', '適合度', 'スコア'],
  sourceConfidence: ['sourceconfidence', 'confidence', '信頼度'],
};

const workbookCache = new Map<any, any>();
const importRepairCache: {
  targetPath: string;
  signature: string | null;
  attempted: boolean;
  result: any;
} = {
  targetPath: '',
  signature: null,
  attempted: false,
  result: null,
};

function getFileSignature(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return null;
  }
}

function makeWorkbookCacheKey(targetPath, fileType, sheetIndex, columnMapping) {
  return [
    path.resolve(targetPath || ''),
    fileType || '',
    Number.isInteger(sheetIndex) ? sheetIndex : '',
    JSON.stringify(columnMapping || {}),
  ].join('|');
}

function storeWorkbookCache(workbookData) {
  if (!workbookData || !workbookData.targetPath) return;
  const cacheKey = makeWorkbookCacheKey(
    workbookData.targetPath,
    workbookData.fileType,
    workbookData.sheetIndex,
    workbookData.columnMapping,
  );
  workbookCache.set(cacheKey, {
    signature: getFileSignature(workbookData.targetPath),
    bundle: workbookData,
  });
}

function normalizeValue(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function normalizeHeader(value) {
  return normalizeValue(value)
    .toLowerCase()
    .replace(/[ \t\r\n_\-./\\:：()[\]{}<>「」『』【】・]/g, '');
}

function normalizeCompanyNo(value) {
  if (value === undefined || value === null || value === '') return null;
  const numberValue = Number(value);
  if (Number.isFinite(numberValue)) return numberValue;
  const text = normalizeValue(value);
  return text === '' ? null : text;
}

function isPlaceholderCompanyName(value) {
  const normalized = normalizeHeader(value);
  return normalized === '企業名' || normalized === 'company' || normalized === 'companyname';
}

function getColumnMapping() {
  const targetList = settings.getSection('targetList');
  return {
    ...DEFAULT_COLUMN_MAPPING,
    ...(targetList.columnMapping || {}),
  };
}

function getFileTypeFromPath(targetPath, fallback = 'xlsx') {
  const ext = path.extname(targetPath || '').toLowerCase();
  if (ext === '.csv') return 'csv';
  if (ext === '.xlsx' || ext === '.xls') return 'xlsx';
  return fallback === 'csv' ? 'csv' : 'xlsx';
}

function toRelativeProjectPath(targetPath) {
  if (!targetPath) return '';
  // 1.2.111+: 相対化基準は runtimeRoot に揃える (settings.getTargetListPath が
  // runtimeRoot を基準に結合するため)。以前は PROJECT_ROOT を基準にしており、
  // Electron dev (runtimeRoot=.electron-userdata/runtime) で書き込み時と読み出し時の
  // 基準がズレて二重 prefix のパスを生成していた。
  const settingsModule = require('./settings-manager');
  const runtimeRoot = typeof settingsModule.getRuntimeRoot === 'function'
    ? settingsModule.getRuntimeRoot()
    : PROJECT_ROOT;
  const relativePath = path.relative(runtimeRoot, targetPath);
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return targetPath;
  }
  return relativePath;
}

function ensureDirectory(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function getListBuilderRecordsDir() {
  return resolveDataPath('list-builder', 'records');
}

function makeCompanionFileName(companyNo) {
  const value = normalizeValue(companyNo);
  const safe = value.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 80);
  return safe || 'unknown';
}

function writeJsonAtomic(filePath, data) {
  ensureDirectory(path.dirname(filePath));
  const tmpFile = filePath + '.tmp.' + process.pid;
  fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2), 'utf-8');
  try {
    fs.renameSync(tmpFile, filePath);
  } catch (e) {
    if (process.platform === 'win32' && (e.code === 'EPERM' || e.code === 'EBUSY')) {
      fs.copyFileSync(tmpFile, filePath);
      try { fs.unlinkSync(tmpFile); } catch (_) {}
    } else {
      try { fs.unlinkSync(tmpFile); } catch (_) {}
      throw e;
    }
  }
}

function pickExtendedTargetFields(companyData) {
  const fields: Record<string, unknown> = {};
  if (!companyData || typeof companyData !== 'object') return fields;
  for (const field of EXTENDED_TARGET_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(companyData, field)) continue;
    const value = companyData[field];
    if (value === undefined || value === null || value === '') continue;
    fields[field] = value;
  }
  return fields;
}

function saveListBuilderCompanionRecord(companyNo, companyData) {
  const fields = pickExtendedTargetFields(companyData);
  if (Object.keys(fields).length === 0) return null;
  const filePath = path.join(getListBuilderRecordsDir(), makeCompanionFileName(companyNo) + '.json');
  const current = (() => {
    try { return JSON.parse(fs.readFileSync(filePath, 'utf-8')); } catch (_) { return null; }
  })();
  const next = {
    version: 1,
    no: companyNo,
    updatedAt: new Date().toISOString(),
    source: {
      runId: companyData.listBuilderRunId || current?.source?.runId || '',
      recordId: companyData.listBuilderRecordId || current?.source?.recordId || '',
    },
    fields: {
      ...((current && current.fields && typeof current.fields === 'object') ? current.fields : {}),
      ...fields,
    },
  };
  writeJsonAtomic(filePath, next);
  return filePath;
}

// v2.0.18: 「ディレクトリ内の存在ファイル」を 500ms TTL でキャッシュ。
// 旧実装は 371 社それぞれで fs.readFileSync を呼んでおり、存在しないファイルでも
// ENOENT → catch のオーバーヘッドが発生していた (loadData 1 回で 1.7 秒のうち
// 大部分)。今は records dir を 1 度 readdir して Set<basename> をキャッシュ、
// Set に無いファイルは fs アクセス自体をスキップ。
const _listBuilderRecordsCache: { dir: string; fetchedAt: number; entries: Set<string> } = {
  dir: '',
  fetchedAt: 0,
  entries: new Set<string>(),
};
const LIST_BUILDER_RECORDS_TTL_MS = 500;

function getListBuilderRecordsSet(): Set<string> {
  const dir = getListBuilderRecordsDir();
  const now = Date.now();
  if (_listBuilderRecordsCache.dir === dir && (now - _listBuilderRecordsCache.fetchedAt) < LIST_BUILDER_RECORDS_TTL_MS) {
    return _listBuilderRecordsCache.entries;
  }
  let entries: Set<string>;
  try {
    entries = new Set(fs.readdirSync(dir));
  } catch (_) {
    entries = new Set<string>();
  }
  _listBuilderRecordsCache.dir = dir;
  _listBuilderRecordsCache.fetchedAt = now;
  _listBuilderRecordsCache.entries = entries;
  return entries;
}

function loadListBuilderCompanionFields(companyNo) {
  const fileName = makeCompanionFileName(companyNo) + '.json';
  // v2.0.18: Set lookup で skip 判定 → 存在しない 99%+ の会社で 1 syscall を節約
  const entries = getListBuilderRecordsSet();
  if (!entries.has(fileName)) return {};
  const filePath = path.join(getListBuilderRecordsDir(), fileName);
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return parsed && parsed.fields && typeof parsed.fields === 'object' ? parsed.fields : {};
  } catch (_) {
    return {};
  }
}

function mergeListBuilderCompanionFields(company) {
  if (!company || company.no === null || company.no === undefined || company.no === '') return company;
  const fields = loadListBuilderCompanionFields(company.no);
  if (!fields || Object.keys(fields).length === 0) return company;
  const merged = { ...company };
  for (const field of EXTENDED_TARGET_FIELDS) {
    if (merged[field] !== undefined && merged[field] !== null && merged[field] !== '') continue;
    if (fields[field] !== undefined && fields[field] !== null) merged[field] = fields[field];
  }
  return merged;
}

function getImportDir() {
  return resolveDataPath('imports');
}

/**
 * imports/ から最新 (mtime 降順) の `*-target-list.xlsx` を返す。
 * settings.targetList.filePath が削除済み参照を保持していて、AI Form Fill
 * 投入時に「Target list file not found」400 が連発する事故から自動復旧する。
 */
function findLatestTargetListInImports(): string | null {
  try {
    const dir = getImportDir();
    if (!fs.existsSync(dir)) return null;
    const entries = fs.readdirSync(dir).filter((name: string) => /-target-list\.xlsx$/i.test(name));
    if (entries.length === 0) return null;
    const withMtime = entries
      .map((name: string) => {
        const full = path.join(dir, name);
        try { return { full, mtime: fs.statSync(full).mtimeMs }; }
        catch (_) { return null; }
      })
      .filter((entry: any) => entry !== null) as Array<{ full: string; mtime: number }>;
    if (withMtime.length === 0) return null;
    withMtime.sort((a, b) => b.mtime - a.mtime);
    return withMtime[0].full;
  } catch (_) {
    return null;
  }
}

function getDefaultTargetFile() {
  return resolveDataPath('manual-targets.csv');
}

function getCanonicalImportFile(baseName) {
  const stem = path.basename(baseName || 'target-list', path.extname(baseName || ''));
  return path.join(getImportDir(), `${Date.now()}-${stem}-target-list.xlsx`);
}

function buildDefaultHeaders(columnMapping: Record<string, number>) {
  const length = Math.max(...(Object.values(columnMapping) as number[])) + 1;
  const headers = Array.from({ length }, () => '');
  Object.entries(columnMapping).forEach(([field, index]: [string, any]) => {
    headers[index] = HEADER_LABELS[field] || field;
  });
  return headers;
}

function createEmptyWorkbookBundle(targetPath, fileType, columnMapping, sheetName = 'Targets') {
  const workbook = XLSX.utils.book_new();
  const rows = [buildDefaultHeaders(columnMapping)];
  const worksheet = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
  writeWorkbookBundle({ workbook, targetPath, fileType });
  const bundle = {
    workbook,
    rows,
    headers: rows[0],
    sheetName,
    sheetIndex: 0,
    targetPath,
    fileType,
    columnMapping,
  };
  storeWorkbookCache(bundle);
  return bundle;
}

function writeWorkbookBundle({ workbook, targetPath, fileType }) {
  ensureDirectory(path.dirname(targetPath));
  if (fileType === 'csv') {
    XLSX.writeFile(workbook, targetPath, { bookType: 'csv' });
    return;
  }
  XLSX.writeFile(workbook, targetPath);
}

function readWorkbookBundle(targetPath, options: Record<string, unknown> = {}) {
  const targetList = settings.getSection('targetList');
  const fileType = getFileTypeFromPath(targetPath, options.fileType || targetList.fileType || 'xlsx');
  const columnMapping = options.columnMapping || getColumnMapping();
  const sheetIndex = Number.isInteger(options.sheetIndex) ? options.sheetIndex : (targetList.sheetIndex || 0);
  const cacheKey = makeWorkbookCacheKey(targetPath, fileType, sheetIndex, columnMapping);

  if (!targetPath) {
    return { ok: false, error: 'Target list file is not configured.' };
  }

  const signature = getFileSignature(targetPath);
  const cached = workbookCache.get(cacheKey);
  if (cached && cached.signature === signature) {
    return { ok: true, ...cached.bundle };
  }

  if (!signature) {
    // v2.0.32: ファイル不在時に imports/ ディレクトリから最新の
    // *-target-list.xlsx を auto-recover。settings.targetList.filePath が
    // 古いファイル参照のまま残り、cleanup 等で実ファイルが削除されると
    // AI Form Fill 投入時に「対象が見つかりません」400 が連発する事故を防ぐ。
    if (options.allowAutoRecover !== false) {
      const recovered = findLatestTargetListInImports();
      if (recovered && recovered !== targetPath) {
        const recoveredSig = getFileSignature(recovered);
        if (recoveredSig) {
          // settings を更新 (絶対パスのまま保存)
          try {
            const tlSection = settings.getSection('targetList') || {};
            settings.updateSection('targetList', { ...tlSection, filePath: recovered });
          } catch (_) { /* settings 書き込み失敗は無視、in-memory fallback で続行 */ }
          // recovered で再帰呼び出し (autoRecover を無効化して無限再帰防止)
          return readWorkbookBundle(recovered, { ...options, allowAutoRecover: false });
        }
      }
    }
    if (!options.createIfMissing) {
      return { ok: false, error: `Target list file not found: ${targetPath}`, targetPath };
    }
    return {
      ok: true,
      ...createEmptyWorkbookBundle(targetPath, fileType, columnMapping),
    };
  }

  try {
    const stat = fs.statSync(targetPath);
    if (stat.size > XLSX_MAX_FILE_SIZE) throw new Error(`ファイルサイズが上限(50MB)を超えています: ${stat.size} bytes`);
    const workbook = XLSX.readFile(targetPath, { raw: false, defval: '' });
    const sheetNames = workbook.SheetNames || [];
    const sheetName = sheetNames[sheetIndex] || sheetNames[0] || 'Targets';

    if (!workbook.Sheets[sheetName]) {
      workbook.Sheets[sheetName] = XLSX.utils.aoa_to_sheet([buildDefaultHeaders(columnMapping)]);
      if (!sheetNames.includes(sheetName)) workbook.SheetNames.push(sheetName);
    }

    const worksheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' });
    const normalizedRows = rows.length > 0 ? rows : [buildDefaultHeaders(columnMapping)];

    const bundle = {
      workbook,
      rows: normalizedRows,
      headers: normalizedRows[0] || [],
      sheetName,
      sheetIndex: sheetNames.indexOf(sheetName),
      targetPath,
      fileType,
      columnMapping,
    };
    storeWorkbookCache(bundle);
    return { ok: true, ...bundle };
  } catch (error) {
    return { ok: false, error: error.message, targetPath };
  }
}

function mapRow(row, columnMapping, rowIndex) {
  const result = {
    no: normalizeCompanyNo(row[columnMapping.no]),
    status: normalizeValue(row[columnMapping.status]),
    companyName: normalizeValue(row[columnMapping.companyName]),
    type: normalizeValue(row[columnMapping.type]),
    url: normalizeValue(row[columnMapping.url]),
    formUrl: normalizeValue(row[columnMapping.formUrl]),
    notes: normalizeValue(row[columnMapping.notes]),
    captcha: normalizeValue(row[columnMapping.captcha]),
    progress: normalizeValue(row[columnMapping.progress]),
    rowIndex,
    raw: row,
  };
  // 拡張カラム: columnMapping に明示的な列インデックスがある場合のみ XLSX から読み出す。
  // 既存ファイルには通常存在しないので、デフォルトでは Companion JSON 側で管理する。
  for (const field of EXTENDED_TARGET_FIELDS) {
    if (columnMapping && Object.prototype.hasOwnProperty.call(columnMapping, field)) {
      result[field] = normalizeValue(row[columnMapping[field]]);
    }
  }
  return result;
}

function readTargetList() {
  repairImportedTargetListIfNeeded();
  const targetPath = settings.getTargetListPath();
  const workbookData = readWorkbookBundle(targetPath);
  if (!workbookData.ok) return workbookData;

  const dataRows = workbookData.rows.slice(1);
  const companies = dataRows
    .map((row, index) => mergeListBuilderCompanionFields(mapRow(row, workbookData.columnMapping, index + 1)))
    .filter((row: any) => row.no !== null || row.companyName || row.url || row.formUrl);

  return {
    ok: true,
    columnMapping: workbookData.columnMapping,
    companies,
    headers: workbookData.headers,
    rows: dataRows,
    sheetName: workbookData.sheetName,
    targetPath: workbookData.targetPath,
    fileType: workbookData.fileType,
  };
}

function getTargetPreview(limit = 10) {
  const data = readTargetList();
  if (!data.ok) return data;
  return {
    ok: true,
    headers: data.headers,
    rows: data.rows.slice(0, limit),
    sheetName: data.sheetName,
    targetPath: data.targetPath,
  };
}

function findCompanyByNo(companyNo) {
  const data = readTargetList();
  if (!data.ok) return data;

  const wanted = normalizeCompanyNo(companyNo);
  const company = data.companies.find((entry: any) => String(entry.no) === String(wanted));
  return {
    ...data,
    company: company || null,
  };
}

function findCompaniesByNos(companyNos) {
  const data = readTargetList();
  if (!data.ok) return data;

  const wanted = new Set((companyNos || []).map((value: any) => String(normalizeCompanyNo(value))));
  return {
    ...data,
    companies: data.companies.filter((entry: any) => wanted.has(String(entry.no))),
  };
}

function detectColumnMapping(headers) {
  const detected: Record<string, unknown> = {};
  (headers || []).forEach((header, index) => {
    const normalized = normalizeHeader(header);
    if (!normalized) return;

    TARGET_FIELDS.forEach((field: any) => {
      if (detected[field] !== undefined) return;
      const matched = (HEADER_HINTS[field] || []).some((hint: any) => normalized.includes(normalizeHeader(hint)));
      if (matched) detected[field] = index;
    });
  });
  return detected;
}

function hasImportableContent(row) {
  if (!row) return false;
  if (isPlaceholderCompanyName(row.companyName)) return false;
  return !!(row.companyName || row.url || row.formUrl || row.type || row.status || row.progress);
}

function scoreImportSheet(headers, rows) {
  const detected = detectColumnMapping(headers);
  const mappedRows = (rows || []).slice(1).map((row, index) => mapRow(row, {
    ...DEFAULT_COLUMN_MAPPING,
    ...detected,
  }, index + 1));
  const populatedRows = mappedRows.filter(hasImportableContent);
  let score = populatedRows.length;
  if (detected.companyName !== undefined) score += 500;
  if (detected.formUrl !== undefined) score += 120;
  if (detected.url !== undefined) score += 80;
  if (detected.type !== undefined) score += 40;
  if (detected.status !== undefined) score += 20;
  if (detected.no !== undefined) score += 10;
  return { detected, populatedRows, score };
}

function selectImportSheet(workbook) {
  const sheetNames = workbook.SheetNames || [];
  let best: any = null;

  sheetNames.forEach((sheetName, sheetIndex) => {
    const worksheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' });
    const headers = rows[0] || [];
    const scored = scoreImportSheet(headers, rows);
    const candidate = {
      sheetName,
      sheetIndex,
      headers,
      rows,
      detected: scored.detected,
      populatedRows: scored.populatedRows,
      score: scored.score,
    };
    if (!best || candidate.score > best.score) {
      best = candidate;
    }
  });

  return best;
}

function normalizeImportedCompanies(rows, columnMapping) {
  const normalized: unknown[] = [];
  const usedNos = new Set<any>();
  let nextGeneratedNo = 1;

  function allocateNo() {
    while (usedNos.has(String(nextGeneratedNo))) nextGeneratedNo += 1;
    const value = nextGeneratedNo;
    usedNos.add(String(value));
    nextGeneratedNo += 1;
    return value;
  }

  (rows || []).slice(1).forEach((row, index) => {
    const mapped = mapRow(row, columnMapping, index + 1);
    if (!hasImportableContent(mapped)) return;

    let normalizedNo = mapped.no;
    if (normalizedNo === null || normalizedNo === '' || usedNos.has(String(normalizedNo))) {
      normalizedNo = allocateNo();
    } else {
      usedNos.add(String(normalizedNo));
      const numeric = Number(normalizedNo);
      if (Number.isFinite(numeric) && numeric >= nextGeneratedNo) {
        nextGeneratedNo = numeric + 1;
      }
    }

    normalized.push({
      ...mapped,
      no: normalizedNo,
    });
  });

  return normalized;
}

function getImportComparableStem(filePath) {
  const stem = path.basename(filePath || '', path.extname(filePath || ''));
  return stem
    .replace(/^\d+-/, '')
    .replace(/-target-list$/i, '')
    .trim()
    .toLowerCase();
}

function repairImportedTargetListIfNeeded() {
  const targetPath = settings.getTargetListPath();
  if (!targetPath) {
    return { ok: true, repaired: false, reason: 'no-target-path' };
  }

  const resolvedTargetPath = path.resolve(targetPath);
  const signature = getFileSignature(resolvedTargetPath);
  if (
    importRepairCache.attempted
    && importRepairCache.targetPath === resolvedTargetPath
    && importRepairCache.signature === signature
  ) {
    return importRepairCache.result || { ok: true, repaired: false, reason: 'cached' };
  }

  const defaultResult = { ok: true, repaired: false, reason: 'not-needed' };
  importRepairCache.targetPath = resolvedTargetPath;
  importRepairCache.signature = signature;
  importRepairCache.attempted = true;
  importRepairCache.result = defaultResult;

  const importDir = path.resolve(getImportDir());
  if (!resolvedTargetPath.startsWith(importDir) || !/-target-list\.xlsx$/i.test(resolvedTargetPath)) {
    return defaultResult;
  }

  const currentData = readWorkbookBundle(resolvedTargetPath);
  if (!currentData.ok) {
    const result = { ok: false, repaired: false, reason: currentData.error || 'current-target-read-failed' };
    importRepairCache.result = result;
    return result;
  }
  const currentCompanies = currentData.rows
    .slice(1)
    .map((row, index) => mapRow(row, currentData.columnMapping, index + 1))
    .filter(hasImportableContent);
  const currentCount = currentCompanies.length;

  const comparableStem = getImportComparableStem(resolvedTargetPath);
  const candidatePaths = fs.readdirSync(importDir)
    .filter((fileName: any) => /\.(xlsx|xls|csv)$/i.test(fileName))
    .map((fileName: any) => path.join(importDir, fileName))
    .filter((candidatePath: any) => path.resolve(candidatePath) !== resolvedTargetPath)
    .filter((candidatePath: any) => getImportComparableStem(candidatePath) === comparableStem)
    .filter((candidatePath: any) => !/-target-list\.xlsx$/i.test(candidatePath));

  let bestCandidate: any = null;
  candidatePaths.forEach((candidatePath: any) => {
    try {
      const workbook = XLSX.readFile(candidatePath, { raw: false, defval: '' });
      const selectedSheet = selectImportSheet(workbook);
      if (!selectedSheet || !selectedSheet.headers || selectedSheet.headers.length === 0) return;
      const importMapping = {
        ...DEFAULT_COLUMN_MAPPING,
        ...selectedSheet.detected,
      };
      const normalizedCompanies = normalizeImportedCompanies(selectedSheet.rows, importMapping);
      const companyCount = normalizedCompanies.length;
      if (!bestCandidate || companyCount > bestCandidate.companyCount) {
        bestCandidate = {
          sourceFilePath: candidatePath,
          companyCount,
          normalizedCompanies,
        };
      }
    } catch (_) {
      // ignore unreadable candidates
    }
  });

  if (!bestCandidate) {
    importRepairCache.result = { ok: true, repaired: false, reason: 'no-related-import-source' };
    return importRepairCache.result;
  }

  // v2.0.16: count-based auto-repair を **無効化** (root cause of「370 件削除に
  // 5 回必要」「200 社一括削除しても残る」事故)。
  //
  // 旧仕様: 現在のターゲットリストの行数 < 元 CSV/XLSX の行数 × 1.5 + 50 だと
  // 「ファイル破損で行が消えた」と判断して **元 import ファイルから自動復元**
  // していた。
  //
  // 問題: ユーザーが意図的に bulk-delete した直後に readTargetList() が呼ばれ
  // ると、count threshold を超えて auto-repair が走り、削除した行が即復活する。
  //
  // 新仕様: parse 失敗 (currentData.ok === false) のときだけ repair (上で既に
  // 早期 return しているので、ここに来た時点で current file は読めている)。
  // count 比較による自動復元は廃止。ユーザーが復元したい場合は再度 import すれば良い。
  importRepairCache.result = {
    ok: true,
    repaired: false,
    reason: 'auto-repair-by-count-disabled-v2.0.16',
    currentCount,
    candidateCount: bestCandidate.companyCount,
  };
  return importRepairCache.result;

  const repairedTargetPath = getCanonicalImportFile(path.basename(bestCandidate.sourceFilePath));
  const canonicalRows = buildCanonicalWorkbookRows(bestCandidate.normalizedCompanies, DEFAULT_COLUMN_MAPPING);
  const repairedBundle = createEmptyWorkbookBundle(repairedTargetPath, 'xlsx', DEFAULT_COLUMN_MAPPING, 'Targets');
  saveRows(repairedBundle, canonicalRows);
  settings.updateSection('targetList', {
    filePath: toRelativeProjectPath(repairedTargetPath),
    fileType: 'xlsx',
    sheetIndex: 0,
    columnMapping: DEFAULT_COLUMN_MAPPING,
  });

  importRepairCache.result = {
    ok: true,
    repaired: true,
    previousPath: resolvedTargetPath,
    repairedPath: repairedTargetPath,
    previousCount: currentCount,
    repairedCount: bestCandidate.companyCount,
    sourceFilePath: bestCandidate.sourceFilePath,
  };
  return importRepairCache.result;
}

function buildCanonicalWorkbookRows(companies, columnMapping) {
  const rows = [buildDefaultHeaders(columnMapping)];
  (companies || []).forEach((company: any) => {
    rows.push(buildCompanyRow(company, columnMapping, rows[0].length));
  });
  return rows;
}

function sanitizeImportFileName(fileName) {
  const baseName = path.basename(fileName || 'target-list.xlsx');
  return baseName.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_');
}

function getNextCompanyNo(companies) {
  const numericIds = (companies || [])
    .map((company: any) => Number(company.no))
    .filter((value: any) => Number.isFinite(value));
  return numericIds.length > 0 ? Math.max(...numericIds) + 1 : 1;
}

function buildCompanyRow(companyData: any, columnMapping: any, currentLength: number, seedRow?: any) {
  const rowLength = Math.max(currentLength || 0, Math.max(...(Object.values(columnMapping) as number[])) + 1);
  const row = Array.from({ length: rowLength }, (_, index) => {
    if (seedRow && seedRow[index] !== undefined) return seedRow[index];
    return '';
  });
  const values = {
    no: companyData.no,
    status: companyData.status || '',
    companyName: companyData.companyName || '',
    type: companyData.type || '',
    url: companyData.url || '',
    formUrl: companyData.formUrl || '',
    notes: companyData.notes || '',
    captcha: companyData.captcha || '',
    progress: companyData.progress || '',
  };
  for (const field of EXTENDED_TARGET_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(companyData, field)) {
      values[field] = companyData[field];
    }
  }

  Object.entries(values).forEach(([field, value]) => {
    const index = columnMapping[field];
    if (!Number.isInteger(index) || index < 0) return;
    row[index] = value === undefined || value === null ? '' : value;
  });

  return row;
}

function saveRows(workbookData, rows) {
  const workbook = workbookData.workbook || XLSX.utils.book_new();
  const worksheet = XLSX.utils.aoa_to_sheet(rows);
  workbook.Sheets[workbookData.sheetName] = worksheet;
  if (!workbook.SheetNames.includes(workbookData.sheetName)) {
    workbook.SheetNames.push(workbookData.sheetName);
  }
  writeWorkbookBundle({
    workbook,
    targetPath: workbookData.targetPath,
    fileType: workbookData.fileType,
  });
  workbookData.workbook = workbook;
  workbookData.rows = rows;
  if (!workbookData.sheetIndex && workbookData.sheetIndex !== 0) {
    workbookData.sheetIndex = 0;
  }
  storeWorkbookCache(workbookData);
}

function ensureEditableTargetList() {
  const targetList = settings.getSection('targetList');
  let targetPath = settings.getTargetListPath();
  let fileType = getFileTypeFromPath(targetPath, targetList.fileType || 'csv');

  if (!targetPath) {
    targetPath = getDefaultTargetFile();
    fileType = 'csv';
    settings.updateSection('targetList', {
      filePath: toRelativeProjectPath(targetPath),
      fileType,
      sheetIndex: 0,
      columnMapping: getColumnMapping(),
    });
  }

  return readWorkbookBundle(targetPath, { createIfMissing: true, fileType });
}

function appendCompany(companyData) {
  const companyName = normalizeValue(companyData.companyName);
  if (!companyName) {
    return { ok: false, error: 'companyName is required.' };
  }

  const workbookData = ensureEditableTargetList();
  if (!workbookData.ok) return workbookData;

  const dataRows = workbookData.rows.slice(1);
  const existingCompanies = dataRows.map((row, index) => mapRow(row, workbookData.columnMapping, index + 1));
  const nextNo = normalizeCompanyNo(companyData.no) || getNextCompanyNo(existingCompanies);
  const row = buildCompanyRow({
    ...companyData,
    no: nextNo,
  }, workbookData.columnMapping, workbookData.headers.length);

  workbookData.rows.push(row);
  saveRows(workbookData, workbookData.rows);
  const mapped = mapRow(row, workbookData.columnMapping, workbookData.rows.length - 1);
  try {
    saveListBuilderCompanionRecord(mapped.no, companyData);
  } catch (e) {
    console.warn('[target-list] failed to save list-builder companion record:', e.message);
  }

  return {
    ok: true,
    company: mergeListBuilderCompanionFields(mapped),
    targetPath: workbookData.targetPath,
  };
}

function updateCompany(companyNo, patch) {
  const targetPath = settings.getTargetListPath();
  const workbookData = readWorkbookBundle(targetPath);
  if (!workbookData.ok) return workbookData;

  const wanted = String(normalizeCompanyNo(companyNo));
  const rowIndex = workbookData.rows.findIndex((row, index) => {
    if (index === 0) return false;
    return String(mapRow(row, workbookData.columnMapping, index).no) === wanted;
  });

  if (rowIndex === -1) {
    return { ok: false, error: `Company not found: ${companyNo}` };
  }

  const current = mapRow(workbookData.rows[rowIndex], workbookData.columnMapping, rowIndex);
  const nextCompany = { ...current, ...patch, no: current.no };
  const nextRow = buildCompanyRow(nextCompany, workbookData.columnMapping, workbookData.rows[rowIndex].length, workbookData.rows[rowIndex]);
  workbookData.rows[rowIndex] = nextRow;
  saveRows(workbookData, workbookData.rows);
  try {
    saveListBuilderCompanionRecord(current.no, nextCompany);
  } catch (e) {
    console.warn('[target-list] failed to save list-builder companion record:', e.message);
  }

  return {
    ok: true,
    company: mergeListBuilderCompanionFields(mapRow(nextRow, workbookData.columnMapping, rowIndex)),
    targetPath: workbookData.targetPath,
  };
}

function deleteCompany(companyNo) {
  const targetPath = settings.getTargetListPath();
  const workbookData = readWorkbookBundle(targetPath);
  if (!workbookData.ok) return workbookData;

  const wanted = String(normalizeCompanyNo(companyNo));
  const rowIndex = workbookData.rows.findIndex((row, index) => {
    if (index === 0) return false;
    return String(mapRow(row, workbookData.columnMapping, index).no) === wanted;
  });

  if (rowIndex === -1) {
    return { ok: false, error: `Company not found: ${companyNo}` };
  }

  const deleted = mapRow(workbookData.rows[rowIndex], workbookData.columnMapping, rowIndex);
  workbookData.rows.splice(rowIndex, 1);
  saveRows(workbookData, workbookData.rows);

  return {
    ok: true,
    company: deleted,
    targetPath: workbookData.targetPath,
  };
}

/**
 * v2.0.16: 複数行を 1 回の workbook I/O で削除する。
 *
 * 旧実装は API 側で `deleteCompany(no)` をループ呼び出ししていたため
 * **N 件削除 = N 回の workbook 全文 read+write**。370 件で数十秒〜数分かかり
 * ブラウザ/プロキシのタイムアウトで途中失敗、ユーザーが 5 回繰り返さないと
 * 全件消えない事故が起きていた。
 *
 * 新実装は 1 回の read → 全行 filter → 1 回の write で O(N)。
 */
function deleteCompaniesBatch(companyNos: any[]) {
  const targetPath = settings.getTargetListPath();
  const workbookData = readWorkbookBundle(targetPath);
  if (!workbookData.ok) {
    return {
      ok: false,
      deleted: [] as any[],
      notFound: (companyNos || []).map((no: any) => String(no)),
      error: workbookData.error,
    };
  }

  const wantedSet = new Set((companyNos || []).map((no: any) => String(normalizeCompanyNo(no))));
  const deleted: any[] = [];
  const remainingRows: any[] = workbookData.rows.length > 0 ? [workbookData.rows[0]] : [];

  for (let i = 1; i < workbookData.rows.length; i += 1) {
    const row = workbookData.rows[i];
    const mapped = mapRow(row, workbookData.columnMapping, i);
    if (wantedSet.has(String(mapped.no))) {
      deleted.push(mapped);
    } else {
      remainingRows.push(row);
    }
  }

  if (deleted.length > 0) {
    saveRows(workbookData, remainingRows);
  }

  const deletedNoSet = new Set(deleted.map((d: any) => String(d.no)));
  const notFound = (companyNos || []).filter((no: any) => !deletedNoSet.has(String(normalizeCompanyNo(no))));

  return {
    ok: true,
    deleted,
    notFound,
    targetPath: workbookData.targetPath,
  };
}

/**
 * 会社名比較用の正規化キー (大文字小文字・前後空白・全角空白の差異を無視)。
 * 空文字なら null。
 */
function normalizeCompanyNameKey(name: unknown): string | null {
  const trimmed = String(name ?? '').trim().replace(/\s+/g, ' ');
  if (!trimmed) return null;
  return trimmed.toLowerCase();
}

/**
 * v2.0.15: 既存ターゲットリストと新規インポート分を companyName で merge する。
 *
 * - 既存リストの companyName と一致する行 → **既存 no を保持しつつ、新データで上書き**
 *   (空欄は既存維持)
 * - 既存にあって新規 import に無い行 → **そのまま残す**
 * - 新規にしかない行 → 新しい no を割り当てて追加
 *
 * 返り値:
 *   - companies: merge 後の全企業
 *   - stats: { added, updated, kept } 件数 (UI 通知用)
 */
function mergeImportedCompaniesUpsert(
  existingCompanies: any[],
  importedCompanies: any[],
): { companies: any[]; stats: { added: number; updated: number; kept: number } } {
  const stats = { added: 0, updated: 0, kept: 0 };
  const usedNos = new Set<string>();
  existingCompanies.forEach((c: any) => { if (c && c.no !== undefined && c.no !== null) usedNos.add(String(c.no)); });
  let nextGeneratedNo = 1;
  function allocateNo(): number {
    while (usedNos.has(String(nextGeneratedNo))) nextGeneratedNo += 1;
    const value = nextGeneratedNo;
    usedNos.add(String(value));
    nextGeneratedNo += 1;
    return value;
  }

  const existingByName = new Map<string, any>();
  existingCompanies.forEach((c: any) => {
    const key = normalizeCompanyNameKey(c?.companyName ?? c?.name ?? '');
    if (key) existingByName.set(key, c);
  });

  const merged: any[] = [];
  const visitedNames = new Set<string>();

  importedCompanies.forEach((imp: any) => {
    const key = normalizeCompanyNameKey(imp?.companyName ?? imp?.name ?? '');
    if (!key) {
      // 会社名が空 → 単純追加 (識別不能なので merge できない)
      const newNo = imp?.no !== undefined && imp?.no !== null && imp?.no !== '' && !usedNos.has(String(imp.no))
        ? imp.no
        : allocateNo();
      usedNos.add(String(newNo));
      merged.push({ ...imp, no: newNo });
      stats.added += 1;
      return;
    }
    visitedNames.add(key);
    const existingRec = existingByName.get(key);
    if (existingRec) {
      // 上書き: 既存 no と companyName を保持 (companyName は識別子として使った
      // ので大文字小文字や空白の差で表記を変えない)、imp の non-empty fields だけ overlay
      const overlaid: any = { ...existingRec };
      Object.keys(imp).forEach((k) => {
        if (k === 'no' || k === 'companyName' || k === 'name') return;
        const v = imp[k];
        if (v !== undefined && v !== null && v !== '') {
          overlaid[k] = v;
        }
      });
      merged.push(overlaid);
      stats.updated += 1;
    } else {
      // 新規追加
      const newNo = allocateNo();
      merged.push({ ...imp, no: newNo });
      stats.added += 1;
    }
  });

  // 既存にあって import に無い → keep
  existingCompanies.forEach((c: any) => {
    const key = normalizeCompanyNameKey(c?.companyName ?? c?.name ?? '');
    if (key && !visitedNames.has(key)) {
      merged.push(c);
      stats.kept += 1;
    } else if (!key) {
      // 会社名なしの既存行は安全側で残す
      merged.push(c);
      stats.kept += 1;
    }
  });

  return { companies: merged, stats };
}

function importTargetList({ fileName, buffer, mode = 'upsert' }: { fileName: string; buffer: Buffer; mode?: 'upsert' | 'replace' } | any) {
  const safeName = sanitizeImportFileName(fileName);
  const ext = path.extname(safeName).toLowerCase();
  if (!['.xlsx', '.xls', '.csv'].includes(ext)) {
    return { ok: false, error: '対応形式は .xlsx / .xls / .csv のみです。アップロードされたファイル: ' + safeName };
  }

  if (!buffer || buffer.length === 0) {
    return { ok: false, error: 'アップロードされたファイルが空です。中身を確認してください。' };
  }
  if (buffer.length > XLSX_MAX_FILE_SIZE) {
    return { ok: false, error: `ファイルサイズが上限(50MB)を超えています: ${buffer.length} bytes` };
  }

  const importDir = getImportDir();
  ensureDirectory(importDir);
  const sourcePath = path.join(importDir, `${Date.now()}-${safeName}`);
  fs.writeFileSync(sourcePath, buffer);

  const warnings: string[] = [];

  // CSV の文字コード簡易判定 (UTF-8 BOM / SJIS 高確率の検出)
  if (ext === '.csv') {
    const head = buffer.slice(0, Math.min(buffer.length, 4096));
    const hasBom = head[0] === 0xEF && head[1] === 0xBB && head[2] === 0xBF;
    if (!hasBom) {
      // 0x80-0xFF が多く現れて UTF-8 として不正なら SJIS の可能性が高い
      let nonAsciiInvalidUtf8 = 0;
      for (let i = 0; i < head.length; i += 1) {
        const b = head[i];
        if (b < 0x80) continue;
        // UTF-8 リード bytes パターンを満たすか簡易チェック
        if ((b & 0xE0) === 0xC0 && i + 1 < head.length && (head[i + 1] & 0xC0) === 0x80) { i += 1; continue; }
        if ((b & 0xF0) === 0xE0 && i + 2 < head.length && (head[i + 1] & 0xC0) === 0x80 && (head[i + 2] & 0xC0) === 0x80) { i += 2; continue; }
        if ((b & 0xF8) === 0xF0 && i + 3 < head.length && (head[i + 1] & 0xC0) === 0x80 && (head[i + 2] & 0xC0) === 0x80 && (head[i + 3] & 0xC0) === 0x80) { i += 3; continue; }
        nonAsciiInvalidUtf8 += 1;
      }
      if (nonAsciiInvalidUtf8 > 4) {
        warnings.push('CSV の文字コードが UTF-8 でない可能性があります。文字化けする場合は UTF-8 (BOM 付き) で保存し直してください。');
      }
    }
  }

  let workbook;
  try {
    workbook = XLSX.read(buffer, { type: 'buffer', raw: false, defval: '' });
  } catch (error) {
    return { ok: false, error: `ファイルを読み込めませんでした: ${error.message}. 形式が壊れていないか確認してください。` };
  }

  const sheetNames = workbook.SheetNames || [];
  if (sheetNames.length === 0) {
    return { ok: false, error: 'シートが見つかりません。Excel/CSV にデータが含まれているか確認してください。' };
  }

  const selectedSheet = selectImportSheet(workbook);
  if (!selectedSheet || !selectedSheet.headers || selectedSheet.headers.length === 0) {
    return {
      ok: false,
      error: `読み取れるシートが見つかりません (候補: ${sheetNames.join(', ')})。ヘッダー行 (1 行目) に列名が入っているか確認してください。`,
    };
  }

  const importMapping = {
    ...DEFAULT_COLUMN_MAPPING,
    ...selectedSheet.detected,
  };

  if (selectedSheet.detected.companyName === undefined) {
    warnings.push('「会社名」列を自動検出できませんでした。デフォルトの 3 列目を会社名として読み取ります。読み込み結果がおかしい場合は、ヘッダーを「会社名」「Company Name」等に変更してください。');
  }

  const totalDataRows = Math.max(0, (selectedSheet.rows || []).length - 1);
  const normalizedCompanies = normalizeImportedCompanies(selectedSheet.rows, importMapping);
  const skippedRowCount = Math.max(0, totalDataRows - normalizedCompanies.length);

  if (normalizedCompanies.length === 0) {
    return {
      ok: false,
      error: `インポート対象の企業行が見つかりませんでした (${totalDataRows} 行を確認しましたが、会社名・URL がすべて空でした)。サンプル: data/sample-targets.csv`,
      warnings,
      totalDataRows,
      detectedMapping: importMapping,
      headers: selectedSheet.headers,
      sourceSheet: selectedSheet.sheetName,
    };
  }

  // v2.0.15: 既存リストと merge する (mode='upsert' がデフォルト)。
  // companyName で識別 → 一致は上書き、新規は追加、import 不在の既存は keep。
  let finalCompanies: any[] = normalizedCompanies as any[];
  let mergeStats: { added: number; updated: number; kept: number } | null = null;
  if (mode !== 'replace') {
    let existingCompanies: any[] = [];
    try {
      const existing = readTargetList();
      if (existing.ok && Array.isArray(existing.companies)) {
        existingCompanies = existing.companies;
      }
    } catch (_) { /* 既存ファイル無しは初回扱い */ }
    if (existingCompanies.length > 0) {
      const merged = mergeImportedCompaniesUpsert(existingCompanies, normalizedCompanies as any[]);
      finalCompanies = merged.companies;
      mergeStats = merged.stats;
    }
  }

  const targetPath = getCanonicalImportFile(safeName);
  const canonicalRows = buildCanonicalWorkbookRows(finalCompanies, DEFAULT_COLUMN_MAPPING);
  const workbookData = createEmptyWorkbookBundle(targetPath, 'xlsx', DEFAULT_COLUMN_MAPPING, 'Targets');
  saveRows(workbookData, canonicalRows);

  settings.updateSection('targetList', {
    filePath: toRelativeProjectPath(targetPath),
    fileType: 'xlsx',
    sheetIndex: 0,
    columnMapping: DEFAULT_COLUMN_MAPPING,
  });

  const data = readTargetList();
  if (skippedRowCount > 0) {
    warnings.push(`${skippedRowCount} 行を空行または会社名なしとしてスキップしました。`);
  }
  if (mergeStats) {
    warnings.push(`既存リストと merge: 追加 ${mergeStats.added} 社 / 更新 ${mergeStats.updated} 社 / 据え置き ${mergeStats.kept} 社`);
  }
  return {
    ok: !!data.ok,
    filePath: toRelativeProjectPath(targetPath),
    targetPath,
    sourceFilePath: sourcePath,
    fileType: 'xlsx',
    mode: mode || 'upsert',
    mergeStats,
    detectedMapping: importMapping,
    headers: selectedSheet.headers,
    sourceSheet: selectedSheet.sheetName,
    companyCount: data.ok ? data.companies.length : 0,
    totalDataRows,
    skippedRowCount,
    warnings,
    error: data.ok ? null : data.error,
  };
}

module.exports = {
  DEFAULT_COLUMN_MAPPING,
  TARGET_FIELDS,
  CORE_TARGET_FIELDS,
  EXTENDED_TARGET_FIELDS,
  appendCompany,
  deleteCompany,
  deleteCompaniesBatch,
  detectColumnMapping,
  findCompaniesByNos,
  findCompanyByNo,
  getColumnMapping,
  getTargetPreview,
  importTargetList,
  normalizeCompanyNo,
  repairImportedTargetListIfNeeded,
  readTargetList,
  toRelativeProjectPath,
  updateCompany,
};

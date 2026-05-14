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
  const relativePath = path.relative(PROJECT_ROOT, targetPath);
  if (!relativePath || relativePath.startsWith('..')) return targetPath;
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
  const fields: Record<string, any> = {};
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

function loadListBuilderCompanionFields(companyNo) {
  const filePath = path.join(getListBuilderRecordsDir(), makeCompanionFileName(companyNo) + '.json');
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

function readWorkbookBundle(targetPath, options: Record<string, any> = {}) {
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
  const detected: Record<string, any> = {};
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
  const normalized: any[] = [];
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

  const shouldRepair = bestCandidate.companyCount > Math.max(currentCount + 50, Math.ceil(currentCount * 1.5));
  if (!shouldRepair) {
    importRepairCache.result = {
      ok: true,
      repaired: false,
      reason: 'current-target-count-looks-reasonable',
      currentCount,
      candidateCount: bestCandidate.companyCount,
    };
    return importRepairCache.result;
  }

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

function importTargetList({ fileName, buffer }) {
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

  const targetPath = getCanonicalImportFile(safeName);
  const canonicalRows = buildCanonicalWorkbookRows(normalizedCompanies, DEFAULT_COLUMN_MAPPING);
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
  return {
    ok: !!data.ok,
    filePath: toRelativeProjectPath(targetPath),
    targetPath,
    sourceFilePath: sourcePath,
    fileType: 'xlsx',
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

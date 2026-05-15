'use strict';

const fs = require('fs');
const path = require('path');
const settings = require('./settings-manager');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const ARTIFACT_TIME_WINDOW_BEFORE_MS = 60 * 60 * 1000;
const ARTIFACT_TIME_WINDOW_AFTER_MS = 5 * 60 * 1000;
const screenshotDirCache = new Map<any, any>();
const fileStatCache = new Map<any, any>();
const MANUAL_REVIEW_RULES = [
  {
    code: 'direct_submit',
    pattern: /確認ステップなし|すでに送信済み|直接送信|送信ボタンで直接送信完了|サンクスページ/i,
    label: '確認画面なしで直接送信型です。',
    confirmRequired: false,
    allowInputOnly: true,
    readyForManualSubmission: false,
    alreadySubmitted: true,
    requiresManualAction: false,
    auditState: 'direct-submit',
  },
  {
    code: 'browser_pending',
    pattern: /確認ボタン未押下|入力内容を確認するボタン未押下|送信ボタン未押下|フォーム入力済み状態で残っています|ブラウザタブにフォーム入力済み状態で残っています|ブラウザタブ.*残しています|ユーザーによる送信判断を待機中/i,
    label: 'ブラウザタブで最終確認して送信してください。',
    confirmRequired: false,
    allowInputOnly: true,
    readyForManualSubmission: true,
    alreadySubmitted: false,
    requiresManualAction: true,
    auditState: 'manual-send-pending',
  },
  {
    code: 'captcha',
    pattern: /recaptcha|hcaptcha|turnstile|captcha/i,
    label: 'CAPTCHA の手動対応が必要です。',
    confirmRequired: false,
    allowInputOnly: true,
    readyForManualSubmission: true,
    alreadySubmitted: false,
    requiresManualAction: true,
    auditState: 'manual-send-pending',
  },
  {
    code: 'manual_send',
    pattern: /ユーザーが手動|手動解決後に送信可能|手動送信|手動実行要|手動対応|送信可能な状態|次へボタン未クリック/i,
    label: 'ブラウザで手動送信してください。',
    confirmRequired: false,
    allowInputOnly: true,
    readyForManualSubmission: true,
    alreadySubmitted: false,
    requiresManualAction: true,
    auditState: 'manual-send-pending',
  },
];

function getExpectedScreenshotPaths(companyNo) {
  const dir = settings.getScreenshotDir();
  const safeNo = String(companyNo).replace(/[^a-zA-Z0-9_-]/g, '_');
  return {
    input: path.join(dir, `ss-${safeNo}-input.png`),
    confirm: path.join(dir, `ss-${safeNo}-confirm.png`),
    sent: path.join(dir, `ss-${safeNo}-sent.png`),
    error: path.join(dir, `ss-${safeNo}-error.png`),
  };
}

function getFileSignature(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return null;
  }
}

// v2.0.18: hot-path TTL を導入。loadData (371 社規模) では同じディレクトリを
// 各社で 4 回引く → 1500 回の fs.statSync が発生していた。
// 500ms 以内の連続アクセスは statSync を省略して cache を返す。
// 実 mutation が起きたら signature ベースの正規 cache invalidation はそのまま動く
// (TTL 切れ時に signature を取り直して整合性を取る)。
const SCREENSHOT_CACHE_HOT_TTL_MS = 500;

function getDirectoryEntries(dirPath) {
  const resolved = path.resolve(dirPath);
  const cached: any = screenshotDirCache.get(resolved);
  // hot-path: TTL 内なら statSync 省略
  if (cached && cached.fetchedAt && (Date.now() - cached.fetchedAt) < SCREENSHOT_CACHE_HOT_TTL_MS) {
    return cached.entries;
  }
  const signature = getFileSignature(resolved);
  if (cached && cached.signature === signature) {
    cached.fetchedAt = Date.now();
    return cached.entries;
  }

  if (signature === null) {
    const entries = new Set<any>();
    screenshotDirCache.set(resolved, { signature: null, entries, fetchedAt: Date.now() });
    return entries;
  }

  try {
    const entries = new Set(fs.readdirSync(resolved));
    screenshotDirCache.set(resolved, { signature, entries, fetchedAt: Date.now() });
    return entries;
  } catch {
    const entries = new Set<any>();
    screenshotDirCache.set(resolved, { signature: null, entries, fetchedAt: Date.now() });
    return entries;
  }
}

function getCachedFileStat(filePath) {
  const resolved = path.resolve(filePath);
  const cached: any = fileStatCache.get(resolved);
  // v2.0.18: hot-path TTL — 500ms 内なら statSync 省略
  if (cached && cached.fetchedAt && (Date.now() - cached.fetchedAt) < SCREENSHOT_CACHE_HOT_TTL_MS) {
    return cached.stat;
  }
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    fileStatCache.set(resolved, { signature: null, stat: null, fetchedAt: Date.now() });
    return null;
  }

  const signature = `${stat.mtimeMs}:${stat.size}`;
  if (cached && cached.signature === signature) {
    cached.fetchedAt = Date.now();
    return cached.stat;
  }

  fileStatCache.set(resolved, { signature, stat, fetchedAt: Date.now() });
  return stat;
}

function getScreenshotSearchDirs() {
  const dirs = [
    settings.getScreenshotDir(),
    PROJECT_ROOT,
    path.join(PROJECT_ROOT, 'screenshots'),
  ];

  // v2.0.9: CLI が cwd 直下に保存した ss-{No}-{input,sent,confirm}.png を回収する。
  // CLI の cwd は %APPDATA%/sales-claw-ts/runtime/data/.cli-workspace (packaged)
  // または PROJECT_ROOT (dev) なので、両方を探索対象に含める。
  // 過去バグ (2026-05-15): No.70 サイバネットシステムへ送信完了したが、
  // スクショは .cli-workspace/ に残ったまま、ダッシュボードからは見えなかった。
  try {
    const { resolveDataPath } = require('./data-paths');
    const cliWorkspace = resolveDataPath('.cli-workspace');
    if (cliWorkspace) {
      dirs.push(cliWorkspace);
      dirs.push(path.join(cliWorkspace, 'screenshots'));
    }
  } catch (_) { /* best-effort */ }

  if (process.resourcesPath) {
    dirs.push(
      path.join(process.resourcesPath, 'app', 'screenshots'),
      path.join(process.resourcesPath, 'screenshots'),
      path.join(process.resourcesPath, 'app'),
    );
  }

  // Extra dirs from env (semicolon-separated) for legacy/dev migration
  const extra = process.env.SALES_CLAW_EXTRA_SCREENSHOT_DIRS || '';
  extra.split(';')
    .filter(Boolean)
    .map((p: any) => path.resolve(p.trim()))
    .filter((p: any) => !p.includes('\0'))
    .forEach((p: any) => dirs.push(p));

  return Array.from(new Set(
    dirs
      .filter((dirPath: any) => !!dirPath)
      .map((dirPath: any) => path.resolve(dirPath))
  ));
}

function findScreenshotPath(fileName) {
  if (!fileName) return null;
  const safeName = path.basename(fileName);
  const directories = getScreenshotSearchDirs();
  for (const dirPath of directories) {
    if (getDirectoryEntries(dirPath).has(safeName)) {
      return path.join(dirPath, safeName);
    }
  }

  const directPath = path.resolve(fileName);
  if (getCachedFileStat(directPath)) return directPath;
  return null;
}

function getScreenshotPaths(companyNo) {
  const expected = getExpectedScreenshotPaths(companyNo);
  return {
    input: findScreenshotPath(expected.input) || expected.input,
    confirm: findScreenshotPath(expected.confirm) || expected.confirm,
    sent: findScreenshotPath(expected.sent) || expected.sent,
    error: findScreenshotPath(expected.error) || expected.error,
    expected,
  };
}

function getScreenshotStatus(companyNo) {
  const paths = getScreenshotPaths(companyNo);
  const expected = paths.expected || getExpectedScreenshotPaths(companyNo);
  const inputExists = !!getCachedFileStat(paths.input);
  const confirmExists = !!getCachedFileStat(paths.confirm);
  const sentExists = !!getCachedFileStat(paths.sent);
  const errorExists = !!getCachedFileStat(paths.error);
  return {
    ...paths,
    confirm: paths.confirm,
    inputExists,
    confirmExists,
    sentExists,
    errorExists,
    expected,
    confirmUsedFallback: confirmExists && path.resolve(paths.confirm) !== path.resolve(expected.confirm),
    readyForApproval: inputExists,
    readyForSubmission: inputExists,
  };
}

function findLatestLog(logs, action) {
  for (let i = (logs || []).length - 1; i >= 0; i -= 1) {
    if (logs[i] && logs[i].action === action) return logs[i];
  }
  return null;
}

function toLogText(details) {
  if (!details) return '';
  if (typeof details === 'string') return details;
  if (typeof details === 'object') {
    const candidates = [
      details.screenshot,
      details.detail,
      details.message,
      details.text,
      details.body,
    ].filter((value: any) => typeof value === 'string' && value.trim());
    if (candidates.length > 0) return candidates.join(' ');
    try {
      return JSON.stringify(details);
    } catch (_) {
      return '';
    }
  }
  return String(details || '');
}

function resolveLogContext(options: Record<string, any> = {}) {
  if (Array.isArray(options)) return options.filter(Boolean);
  if (Array.isArray(options.logs) && options.logs.length > 0) return options.logs.filter(Boolean);
  return [
    options.formFillLog,
    options.confirmLog,
    options.awaitingLog,
    options.submittedLog,
  ].filter(Boolean);
}

function getManualApprovalMeta(input) {
  const logs = resolveLogContext(input);
  const matched: any[] = [];
  for (let i = logs.length - 1; i >= 0; i -= 1) {
    const log = logs[i];
    const text = toLogText(log && log.details);
    if (!text) continue;
    MANUAL_REVIEW_RULES.forEach((rule: any) => {
      if (rule.pattern.test(text)) {
        matched.push({
          code: rule.code,
          label: rule.label,
          detail: text,
          action: log && log.action ? log.action : '',
          timestamp: log && log.timestamp ? log.timestamp : '',
          confirmRequired: rule.confirmRequired,
          allowInputOnly: rule.allowInputOnly,
          readyForManualSubmission: rule.readyForManualSubmission,
          alreadySubmitted: rule.alreadySubmitted,
          requiresManualAction: rule.requiresManualAction,
          auditState: rule.auditState,
        });
      }
    });
  }

  const unique: any[] = [];
  const seen = new Set<any>();
  matched.forEach((entry: any) => {
    const key = `${entry.code}:${entry.detail}`;
    if (seen.has(key)) return;
    seen.add(key);
    unique.push(entry);
  });

  const primary = unique[0] || null;
  return {
    requiresManualAction: primary ? !!primary.requiresManualAction : false,
    reasonCode: primary ? primary.code : null,
    reasonLabel: primary ? primary.label : '',
    reasonDetail: primary ? primary.detail : '',
    reasons: unique,
    captchaDetected: unique.some((entry: any) => entry.code === 'captcha'),
    directSubmitDetected: unique.some((entry: any) => entry.code === 'direct_submit'),
    confirmRequired: primary ? !!primary.confirmRequired : false,
    allowInputOnly: primary ? !!primary.allowInputOnly : false,
    readyForManualSubmission: primary ? !!primary.readyForManualSubmission : false,
    alreadySubmitted: primary ? !!primary.alreadySubmitted : false,
    auditState: primary ? primary.auditState : 'standard',
    sourceAction: primary ? primary.action : '',
    sourceTimestamp: primary ? primary.timestamp : '',
  };
}

function collectScreenshotHints(companyNo, logs, kind) {
  const expectedName = `ss-${companyNo}-${kind}.png`;
  const hints = new Set([expectedName]);

  (logs || []).forEach((log: any) => {
    if (!log) return;
    if (log.details && typeof log.details === 'object') {
      if (log.details.screenshots && typeof log.details.screenshots[kind] === 'string' && log.details.screenshots[kind].trim()) {
        hints.add(log.details.screenshots[kind].trim());
      }
      if ((kind === 'confirm' || kind === 'input') && typeof log.details.screenshot === 'string' && log.details.screenshot.trim()) {
        hints.add(log.details.screenshot.trim());
      }
    }
    const text = toLogText(log.details);
    if (text && text.includes(expectedName)) hints.add(expectedName);
  });

  return Array.from(hints);
}

function parseTimestampMs(value) {
  const ms = Date.parse(value || '');
  return Number.isFinite(ms) ? ms : null;
}

function fileExistsWithinWindow(filePath, referenceTimes) {
  const stat = filePath ? getCachedFileStat(filePath) : null;
  if (!stat) return false;
  if (!Array.isArray(referenceTimes) || referenceTimes.length === 0) return true;

  const min = Math.min(...referenceTimes) - ARTIFACT_TIME_WINDOW_BEFORE_MS;
  const max = Math.max(...referenceTimes) + ARTIFACT_TIME_WINDOW_AFTER_MS;
  return stat.mtimeMs >= min && stat.mtimeMs <= max;
}

function resolveLogBoundArtifact(companyNo, kind, logs, referenceTimes) {
  const hints = collectScreenshotHints(companyNo, logs, kind);
  for (const hint of hints) {
    const resolved = findScreenshotPath(hint);
    if (resolved && fileExistsWithinWindow(resolved, referenceTimes)) return resolved;
  }
  return null;
}

function buildArtifactStatus(companyNo, expected, actual, manual) {
  const exists = {
    input: !!actual.input,
    confirm: !!actual.confirm,
    sent: !!actual.sent,
    error: !!actual.error,
  };
  const requirements = {
    input: true,
    confirm: manual ? !!manual.confirmRequired : true,
  };
  const missing: any[] = [];
  if (!exists.input) missing.push('input');
  if (requirements.confirm && !exists.confirm) missing.push('confirm');

  let auditState = 'missing';
  if (exists.confirm) {
    auditState = 'confirm';
  } else if (exists.input && manual && manual.auditState === 'direct-submit') {
    auditState = 'direct-submit';
  } else if (exists.input && manual && manual.readyForManualSubmission) {
    auditState = 'manual-send-pending';
  } else if (exists.input) {
    auditState = 'input-only';
  }

  return {
    companyNo,
    screenshots: {
      input: actual.input || expected.input,
      confirm: actual.confirm || expected.confirm,
      sent: actual.sent || expected.sent,
      error: actual.error || expected.error,
    },
    actual,
    exists,
    requirements,
    missing,
    manualActionRequired: manual ? manual.requiresManualAction : false,
    manualActionReason: manual ? manual.reasonLabel : '',
    manualActionDetail: manual ? manual.reasonDetail : '',
    manualActionReasons: manual ? manual.reasons : [],
    captchaDetected: manual ? manual.captchaDetected : false,
    directSubmitDetected: manual ? manual.directSubmitDetected : false,
    allowInputOnly: manual ? manual.allowInputOnly : false,
    readyForManualApproval: exists.input && !exists.confirm && !!(manual && manual.readyForManualSubmission),
    auditState,
    approvalFlow: manual || null,
    readyForApproval: missing.length === 0,
    readyForSubmission: missing.length === 0,
  };
}

function getExpectedApprovalArtifacts(companyNo, options: Record<string, any> = {}) {
  const logs = resolveLogContext(options);
  const manual = getManualApprovalMeta(logs);
  const hasLogContext = logs.length > 0;
  const referenceTimes = hasLogContext
    ? [
        options.formFillLog,
        options.confirmLog,
        options.awaitingLog,
        options.submittedLog,
      ]
        .map((entry: any) => entry && entry.timestamp)
        .map(parseTimestampMs)
        .filter((value: any) => value !== null)
    : [];

  if (!hasLogContext) {
    const status = getScreenshotStatus(companyNo);
    return buildArtifactStatus(
      companyNo,
      status.expected || getExpectedScreenshotPaths(companyNo),
      {
        input: status.inputExists ? status.input : null,
        confirm: status.confirmExists ? status.confirm : null,
        sent: status.sentExists ? status.sent : null,
        error: status.errorExists ? status.error : null,
      },
      manual,
    );
  }

  const expected = getExpectedScreenshotPaths(companyNo);
  const expectedInput = findScreenshotPath(expected.input);
  const expectedConfirm = findScreenshotPath(expected.confirm);
  const expectedSent = findScreenshotPath(expected.sent);
  const expectedError = findScreenshotPath(expected.error);
  const actual = {
    input: resolveLogBoundArtifact(companyNo, 'input', logs, referenceTimes)
      ?? (fileExistsWithinWindow(expectedInput, referenceTimes) ? expectedInput : null),
    confirm: resolveLogBoundArtifact(companyNo, 'confirm', logs, referenceTimes)
      ?? (fileExistsWithinWindow(expectedConfirm, referenceTimes) ? expectedConfirm : null),
    sent: resolveLogBoundArtifact(companyNo, 'sent', logs, referenceTimes)
      ?? (fileExistsWithinWindow(expectedSent, referenceTimes) ? expectedSent : null),
    error: resolveLogBoundArtifact(companyNo, 'error', logs, referenceTimes)
      ?? (fileExistsWithinWindow(expectedError, referenceTimes) ? expectedError : null),
  };

  return buildArtifactStatus(companyNo, expected, actual, manual);
}

function assertApprovalArtifacts(companyNo, options: Record<string, any> = {}) {
  const status = getExpectedApprovalArtifacts(companyNo, options);
  const missing = Array.isArray(status.missing) ? status.missing.slice() : [];

  if (missing.length > 0) {
    const error: any = new Error(
      options.message || `承認用スクリーンショットが不足しています: ${missing.join(', ')}`
    );
    error.code = 'APPROVAL_ARTIFACTS_MISSING';
    error.companyNo = companyNo;
    error.missing = missing;
    error.status = status;
    throw error;
  }

  return status;
}

function buildApprovalLogDetails(input: Record<string, any> = {}) {
  const companyNo = input.companyNo || null;
  const status = companyNo ? getExpectedApprovalArtifacts(companyNo, input) : null;
  return {
    companyNo,
    source: input.source || 'runner',
    action: input.action || null,
    mode: input.mode || null,
    screenshot: input.screenshot || (status
      ? (status.actual.sent || status.actual.confirm || status.actual.input
        || status.screenshots.sent || status.screenshots.confirm || status.screenshots.input)
      : null),
    screenshots: status
      ? {
          input: status.screenshots.input,
          confirm: status.screenshots.confirm,
          sent: status.screenshots.sent,
          error: status.screenshots.error,
        }
      : null,
    exists: status
      ? {
          input: status.exists.input,
          confirm: status.exists.confirm,
          sent: status.exists.sent,
          error: status.exists.error,
        }
      : null,
    requirements: status ? status.requirements : null,
    missing: status ? status.missing : null,
    auditState: status ? status.auditState : null,
    approvalFlow: status ? status.approvalFlow : null,
    success: !!input.success,
    verified: !!input.verified,
    attempt: Number.isFinite(input.attempt) ? input.attempt : null,
    messageLength: Number.isFinite(input.messageLength) ? input.messageLength : null,
    detail: input.detail || '',
    reason: input.reason || '',
    approvalRequired: input.approvalRequired !== false,
  };
}

module.exports = {
  getManualApprovalMeta,
  findScreenshotPath,
  getExpectedScreenshotPaths,
  getScreenshotSearchDirs,
  getScreenshotPaths,
  getScreenshotStatus,
  getExpectedApprovalArtifacts,
  assertApprovalArtifacts,
  buildApprovalLogDetails,
};

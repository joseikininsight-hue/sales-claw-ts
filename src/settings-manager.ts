// Settings Manager — 全設定の一元管理
// data/settings.json を Single Source of Truth として管理
// ダッシュボードUI・各モジュールがここを通じて設定を読み書きする

const fs = require('fs');
const os = require('os');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const STATIC_DATA_DIR = path.join(__dirname, '..', '..', 'data');
const LEGACY_SETTINGS_FILE = path.join(STATIC_DATA_DIR, 'settings.json');
const SAMPLE_SETTINGS_FILE = path.join(STATIC_DATA_DIR, 'sample-settings.json');
const DEFAULT_SETTINGS_DIR = path.join(getRuntimeRoot(), 'data');
const SETTINGS_FILE = path.join(DEFAULT_SETTINGS_DIR, 'settings.json');

/**
 * Sales Claw のランタイムルート（ユーザーデータ格納先）の絶対パスを返す。
 * @returns {string} ルートディレクトリの絶対パス
 */
function getRuntimeRoot() {
  const configured = typeof process.env.SALES_CLAW_USER_DATA_DIR === 'string'
    ? process.env.SALES_CLAW_USER_DATA_DIR.trim()
    : '';
  const base = configured || path.join(os.homedir(), '.sales-claw');
  return path.resolve(base);
}

const DEFAULT_SETTINGS = {
  // === 会社プロフィール（詳細） ===
  companyProfile: {
    companyName: '',
    companyNameEn: '',
    companyNameKana: '',
    representative: '',           // 代表者名
    contactName: '',              // 担当者名
    contactNameKana: '',          // 担当者名カナ
    contactTitle: '',             // 役職
    department: '',               // 部署名
    email: '',
    phone: '',
    fax: '',
    mobile: '',                   // 携帯番号
    postalCode: '',
    address: '',
    addressEn: '',
    website: '',
    partnerPage: '',              // パートナー募集ページURL
    corporateProfile: '',         // 会社概要URL
    established: '',              // 設立年
    employeeCount: '',            // 従業員数
    capital: '',                  // 資本金
    industry: '',                 // 業種
    businessDescription: '',      // 事業内容（自由記述）
    notes: '',                    // 備考（自由記述）
  },

  // === 提供価値 ===
  valuePropositions: {
    // 自社サイト・サービス情報URL
    companyUrl: '',               // 自社サイトURL
    serviceUrls: [],              // サービス紹介URL配列 [{label, url}]
    documentPaths: [],            // アップロード済みドキュメントパス [{name, path, description}]

    // 自社の強み
    strengths: [
      // { key: 'example', label: '強みの名前', detail: '詳細説明', keywords: ['関連ワード1', '関連ワード2'] }
    ],

    // 協業実績パターン
    successPatterns: [
      // { partner: '匿名企業A', proof: '協業内容の概要', type: 'SIer' }
    ],

    // 既存協業先・親会社グループなど、雑な営業接触を避ける保護リスト
    protected_groups: [
      // { name: '親会社A', match_patterns: ['親会社A', 'グループ会社X'], reason: '既存協業先・グループ会社含む' }
    ],

    // 直接競合・営業対象外になりやすい事業シグナル
    competitors: [
      // { category: 'CMS競合', match_patterns: ['WordPress VIP', 'Drupal特化'] }
    ],

    // 業種別プロフィール（メッセージテンプレート）
    industryProfiles: {
      // 'SIer': { opener: '...', point: '...', examples: '...', strength: '...' },
      // 'default': { opener: '...', point: '...', examples: '...', strength: '...' },
    },
  },

  // === ターゲットリスト ===
  targetList: {
    filePath: '',                 // Excelファイルパス（プロジェクトルートからの相対パス）
    fileType: 'xlsx',             // 'xlsx' | 'csv'
    sheetIndex: 0,                // シートインデックス
    columnMapping: {              // Excelカラムマッピング（0-based index）
      no: 0,                      // No.列
      status: 1,                  // ステータス列
      companyName: 2,             // 企業名列
      type: 3,                    // 種別列
      url: 4,                     // WebサイトURL列
      formUrl: 5,                 // 問い合わせフォームURL列
      notes: 6,                   // 備考列
      captcha: 8,                 // CAPTCHA列
      progress: 10,               // 進捗列
    },
  },

  // === 除外ルール ===
  exclusionRules: {
    competitors: [
      // { pattern: '会社名パターン', status: '競合' }
    ],
    existingClients: [
      // { pattern: '会社名パターン', status: '既存契約' }
    ],
    ngList: [
      // { pattern: '会社名パターン', reason: '除外理由', status: 'NG' }
    ],
    customRules: [
      // { pattern: '正規表現パターン', status: 'カスタムステータス', reason: '理由' }
    ],
    // 除外ステータス一覧（これらのステータスを持つ企業は対象外）
    excludeStatuses: ['×', 'web×', '競合', '規模×', '既存契約', 'パイプ有', '提案辞退', '失注', 'NG'],
  },

  // === メッセージテンプレート ===
  messageTemplates: {
    style: {
      tone: 'formal',             // 'formal' | 'casual' | 'business'
      language: 'ja',             // 'ja' | 'en'
      maxLength: 2000,            // 最大文字数
      signatureFormat: 'full',    // 'full' | 'minimal' | 'none'
    },
    // 問い合わせ種別（フォームのドロップダウン値候補）
    inquiryTypes: ['その他', 'お問い合わせ', '協業・パートナーシップ', 'サービスについて', 'その他のお問い合わせ'],
    // 営業アプローチ方針（AI への内部指示）
    approachObjective: '',
    approachGuardrails: '',
    // v2.0.99: 営業アプローチ意図 (どの窓口に営業したいか)。approach-intent.ts のキー配列。
    //   フォーム選択優先順位 + Phase A の除外緩和を駆動する。
    approachTargets: ['collaboration', 'general'],
    // 締め文
    closingLine: 'もしご興味がございましたら、30分程度の情報交換の場をいただけないでしょうか。\n貴社のお取り組みについてもお伺いできればと存じます。',
    // 挨拶文
    greetingLine: 'お世話になります。',
    // CTA
    cta: '何卒よろしくお願いいたします。',
    // 参照URL案内テキスト
    referenceUrlText: '詳細はこちらをご覧いただけますと幸いです。',
    // 署名テンプレート（プレースホルダー使用）
    signatureTemplate: '{companyName}\n{contactName}\nTEL: {phone}\nMAIL: {email}',
    // 書面テンプレート（PDF/手紙用）
    letterTemplate: {
      enabled: false,
      header: '',                 // 書面ヘッダー（「拝啓　時下ますます…」等）
      footer: '',                 // 書面フッター（「敬具」等）
      format: 'A4',              // 'A4' | 'letter'
    },
    // v2.0.59: フォーム選択のパーソナライズ設定。
    //   Claude が複数のお問い合わせフォーム (一般 / パートナー / 採用 / IR 等)
    //   を持つ B2B サイトに到達したとき、どれを優先・回避するかをユーザーが定義。
    //
    //   利用例:
    //   - パートナー営業 (default): preferredKeywords=["パートナー","協業","alliance"]
    //   - 人材紹介:                 preferredKeywords=["採用","HR","career","recruit"]
    //   - IR / 投資家対応:         preferredKeywords=["IR","investor","株主"]
    //   - 取材/PR:                  preferredKeywords=["広報","PR","press","media"]
    formPreferences: {
      approachLabel: 'パートナー / 協業 営業',
      preferredKeywords: ['パートナー', '協業', '取引', 'アライアンス', 'Partner Inquiry', 'Business Inquiry', 'Corporate Inquiry'],
      avoidKeywords: ['FAQ', 'カスタマーサポート', '製品サポート', 'Customer Support', 'Product Support', 'Help Center'],
    },
  },

  // === 環境設定（詳細） ===
  preferences: {
    // サーバー
    dashboardPort: 3765,
    dashboardHost: '127.0.0.1',
    // 表示
    language: 'ja',               // 'ja' | 'en'
    timezone: 'Asia/Tokyo',
    dateFormat: 'YYYY-MM-DD HH:mm',
    // ストレージ
    screenshotDir: 'screenshots',
    dataDir: 'data',
    // メール取得
    emailSearchKeyword: '',
    emailProvider: 'outlook',     // 'outlook' | 'gmail' | 'other'
    // 自動化
    maxRetries: 3,                // フォーム送信リトライ回数
    pageTimeout: 15000,           // ページ読み込みタイムアウト(ms)
    formFillTimeout: 5000,        // フォーム入力タイムアウト(ms)
    // ブラウザ
    headless: true,               // ヘッドレスモード
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    locale: 'ja-JP',
    // 法令適合
    complianceFooter: true,        // 送信者表示 + オプトアウト案内を本文末尾に自動追記
    listSourceMetadata: '',        // ターゲットリスト取得経路 (個情法 27 条対応のメモ)
    // 為替
    usdJpy: 150,                   // コスト概算で使う為替レート
    aiProvider: 'claude',
    aiModels: {
      claude: 'claude-sonnet-4-6',
      codex: '',
      gemini: '',
    },
    claudeModel: 'claude-sonnet-4-6',
    // ログ
    logLevel: 'info',             // 'debug' | 'info' | 'warn' | 'error'
    maxLogEntries: 10000,         // ログの最大保持件数
    // セキュリティ
    requireApprovalBeforeSend: true,  // 送信前に承認を要求
    autoSendEligibleForms: false,     // CAPTCHA等がない安全なフォームは自動送信
    // エクスポート
    exportFilenamePrefix: 'outreach_progress',
    // v2.0.26: parallelTabs は **default を未設定 (undefined)** にする。
    //   - undefined: getPhaseBParallelTabs() が env / fallback (1) を見る
    //   - ユーザーが UI から保存した値だけ settings に入る
    // (default を 1 で書き込むと env override が効かなくなるため)
  },

  // === Form-fill mode (v2.1.0+) ===
  // Phase B でフォーム入力に使うブラウザエンジン:
  //   - 'internal'   : Electron 内蔵 WebContentsView (外部 Chrome 不要、推奨)
  //   - 'playwright' : 外部 Chrome を起動する旧モード (rollback 用)
  //   - 'both'       : 両方登録 (A/B テスト用)
  // 詳細: docs/architecture/in-app-form-fill.md
  formFill: {
    mode: 'internal',
    parallelism: 3,  // 1-5。同時に処理する社数
  },

  // === 外部 API キー（list-builder などで利用） ===
  // 機微情報のため、UI からの読み出し時はマスクする想定。
  // 値が未設定の場合、該当機能はロックされる。
  apiKeys: {
    serpApi: '',         // SerpApi (NLQ/カテゴリモードで利用)
    houjinBangou: '',    // 国税庁 法人番号 Web-API (無料登録)
    gBizInfo: '',        // gBizINFO (無料登録)
    edinet: '',          // 金融庁 EDINET (無料登録、上場企業 IR/財務データ)
  },

  // === 企業リスト作成機能 (docs/list-builder-requirements.md v2.0) ===
  listBuilder: {
    // データソース
    officialDataFirst: true,             // 公式 API を最優先する
    scraplingMcpEnabled: false,          // Scrapling MCP を補助利用するか
    scraplingPythonPath: 'python',
    // 並列度・レート
    concurrency: 3,
    perDomainConcurrency: 2,
    perDomainMinIntervalMs: 1000,
    timeoutMs: 30000,
    // コンプライアンス
    respectRobotsTxt: true,
    stopOnCaptcha: true,
    stopOn403: true,
    stopOn429: true,
    extractPersonalEmails: false,        // 安全側デフォルト
    extractPersonNames: false,           // 安全側デフォルト
    // 上限
    maxResultsPerRun: 500,
    maxDepthPerCompanySite: 2,
    maxPagesPerDomain: 20,
    // ポリシー・しきい値
    defaultUnknownFieldPolicy: 'standard', // 'strict' | 'standard' | 'broad'
    dedupeThreshold: 0.9,                // ファジーマッチしきい値 (Layer 4)
    // 証跡・キャッシュ
    saveEvidence: true,
    cacheTtlDays: 30,
    // スコア配点 (qualification-scorer)
    scoring: {
      industry: 20,
      prefecture: 10,
      size: 15,
      officialVerified: 15,
      formAvailable: 15,
      noPriorContact: 15,
      keywordMatch: 10,
    },
  },
};

// --- Core Functions ---

function ensureDataDir(dirPath = DEFAULT_SETTINGS_DIR) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function readSettingsFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (err) {
    // 1.2.92: JSON 破損時は corrupt として隔離 + 警告。
    // 旧: silent null fallback で破損ファイルが残り続け、save 時に上書き → 設定全消失
    // 新: corrupt ファイルを .corrupt.{timestamp} にバックアップして残す
    if (err && err.name === 'SyntaxError') {
      const corruptPath = filePath + '.corrupt.' + Date.now();
      try {
        fs.copyFileSync(filePath, corruptPath);
        console.warn(`[settings-manager] settings.json parse failed: ${filePath} - backed up to ${corruptPath}. Falling back to defaults. Error: ${err.message}`);
      } catch (backupErr) {
        console.warn(`[settings-manager] settings.json parse failed AND backup failed: ${filePath}. parse: ${err.message}, backup: ${backupErr && backupErr.message}`);
      }
      // 根本原因 5 の対策: .backup (既存ポリシー) から復元を試みる
      // settings は既存の .backup を流用 (.bak ではなく .backup)
      const bakPath = filePath + '.backup';
      try {
        const bakData = JSON.parse(fs.readFileSync(bakPath, 'utf-8'));
        // .backup から本体へ復元
        fs.copyFileSync(bakPath, filePath);
        console.warn(`[settings-manager] restored from ${bakPath}`);
        return bakData;
      } catch (_) {
        // .backup も読めない場合は null フォールバック
      }
    }
    return null;
  }
}

// ────────────────────────────────────────────────────────────────────
// load() キャッシュ
// ────────────────────────────────────────────────────────────────────
// 設定値は HTTP リクエスト 1 本につき 5–10 回読まれる（getPort, getHost,
// getSender, getStrengths, ...）。素直に毎回 fs.readFileSync + JSON.parse
// + structuredClone(DEFAULT) + deepMerge + normalize を実行すると
// 1 リクエストで 12 ms 以上消費する（tests/perf-baseline.cjs で計測）。
//
// activeSettingsFile の mtime + size をシグネチャにしてメモリキャッシュ。
// 外部エディタで data/settings.json を編集された場合も、次回呼び出しで
// シグネチャが変わって自動的に再読込される。
//
// save() 時はキャッシュを直接更新する（書き込んだ値で即時反映）。
// invalidateSettingsCache() で外部から強制クリアも可能（テスト用途）。
interface SettingsCache {
  filePath: string | null;
  signature: string | null;
  data: Record<string, unknown> | null;
}
const settingsCache: SettingsCache = {
  filePath: null,
  signature: null,
  data: null,
};

// 戻り値:
//   `${mtimeMs}:${size}`  — 通常の hit/miss 判定に使う
//   'missing'             — ファイル不存在 (ENOENT) の確定値。同じ "missing"
//                           同士なら hit と扱える（無いままなら再読み込み不要）
//   'error:<code>'        — それ以外のエラー (EACCES / EBUSY 等)。前回が
//                           成功キャッシュだった場合は hit させない
//   null                  — 旧 API 互換のため残置（直接呼ぶ箇所はゼロ）
function getFileSignature(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch (e) {
    if (e && e.code === 'ENOENT') return 'missing';
    return `error:${e && e.code ? e.code : 'unknown'}`;
  }
}

/**
 * load() のメモリキャッシュを強制クリアする（テスト・外部編集検知用途）。
 * @returns {void}
 */
function invalidateSettingsCache() {
  settingsCache.filePath = null;
  settingsCache.signature = null;
  settingsCache.data = null;
}

// 再帰凍結。キャッシュした settings オブジェクトを戻り値として返した後、
// 呼び出し側が `result.preferences.foo = 'x'` のように破壊変更すると
// キャッシュが汚染されて以後のリクエストに永続的に影響が残る。
// Object.freeze は浅いので deepFreeze で全階層を凍結する。
// 凍結された値を mutate しようとすると strict mode で TypeError が出るので
// 開発時に問題が即露見する。
function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value)) {
    deepFreeze(value[key]);
  }
  return value;
}

function readLegacyClaudeModel() {
  try {
    const legacySettingsPath = path.join(PROJECT_ROOT, '.claude', 'settings.local.json');
    const parsed = JSON.parse(fs.readFileSync(legacySettingsPath, 'utf-8'));
    const model = typeof parsed.model === 'string' ? parsed.model.trim() : '';
    return model || null;
  } catch {
    return null;
  }
}

function resolveConfiguredDataDir(configured) {
  const value = typeof configured === 'string' ? configured.trim() : '';
  if (!value || value.includes('\0')) return DEFAULT_SETTINGS_DIR;
  const resolved = path.isAbsolute(value) ? value : path.join(getRuntimeRoot(), value);
  return path.resolve(resolved);
}

function getBootstrapSettings() {
  return readSettingsFile(SETTINGS_FILE) || readSettingsFile(LEGACY_SETTINGS_FILE);
}

/**
 * 現在有効な settings.json の絶対パスを返す（preferences.dataDir を反映）。
 * @returns {string} settings.json の絶対パス
 */
function getActiveSettingsFile() {
  const bootstrap = getBootstrapSettings();
  const dataDir = resolveConfiguredDataDir(bootstrap && bootstrap.preferences && bootstrap.preferences.dataDir);
  return path.join(dataDir, 'settings.json');
}

/**
 * 現在の設定をロードする（ファイル mtime+size でメモリキャッシュ）。戻り値は frozen。
 * @returns {Object} 正規化済みの設定オブジェクト（DEFAULT_SETTINGS と同じ形）
 */
function load() {
  // 高速パス: 既にキャッシュがあるなら、その filePath を stat するだけで
  // ヒット判定できる。getActiveSettingsFile() は内部で 2 回の sync read
  // をしているため、cache 効果を無にしないために skip する。
  // (注: dataDir 設定を変えた場合は save() が cache を更新するので、
  //   次回 load() の signature 比較で必ず変化が検知される)
  //
  // signature == 'error:*' のときは hit させない: 一時的な権限エラーで
  // キャッシュをそのまま返すと、エラー解消後も古い値を返し続けるため。
  if (settingsCache.data && settingsCache.filePath) {
    const sig = getFileSignature(settingsCache.filePath);
    if (sig === settingsCache.signature && !sig.startsWith('error:')) {
      return settingsCache.data;
    }
  }

  ensureDataDir(DEFAULT_SETTINGS_DIR);
  const activeSettingsFile = getActiveSettingsFile();

  // ファイルパス決定後の二段目チェック: 別ファイルだった場合の
  // signature 比較もここで実施 (起動直後の cold パス用)
  const signature = getFileSignature(activeSettingsFile);
  if (
    settingsCache.data
    && settingsCache.filePath === activeSettingsFile
    && settingsCache.signature === signature
    && !signature.startsWith('error:')
  ) {
    return settingsCache.data;
  }

  const saved = readSettingsFile(activeSettingsFile)
    || readSettingsFile(SETTINGS_FILE)
    || readSettingsFile(LEGACY_SETTINGS_FILE)
    || readSettingsFile(SAMPLE_SETTINGS_FILE);
  const merged = normalizeSettings(deepMerge(structuredClone(DEFAULT_SETTINGS), saved || {}));
  const legacyClaudeModel = readLegacyClaudeModel();
  if (!merged.preferences.aiModels.claude && legacyClaudeModel) {
    merged.preferences.aiModels.claude = legacyClaudeModel;
  }
  if (!merged.preferences.claudeModel && legacyClaudeModel) {
    merged.preferences.claudeModel = legacyClaudeModel;
  }

  // 凍結してキャッシュ。以後 load() の戻り値を mutate しようとすると
  // 即 TypeError になり、cache pollution を未然に防げる。
  // 内部の updateSection / replaceSection / set は load() の結果を
  // structuredClone してから書き換えるので、凍結しても破綻しない。
  deepFreeze(merged);
  settingsCache.filePath = activeSettingsFile;
  settingsCache.signature = signature;
  settingsCache.data = merged;
  return merged;
}

/**
 * 設定を atomic write で永続化し、メモリキャッシュを更新する。
 * @param {Object} settings - 保存する設定オブジェクト
 * @returns {void}
 */
function save(settings) {
  const normalized = normalizeSettings(settings);
  const configuredDir = resolveConfiguredDataDir(normalized && normalized.preferences && normalized.preferences.dataDir);
  const configuredFile = path.join(configuredDir, 'settings.json');
  const payload = JSON.stringify(normalized, null, 2);

  ensureDataDir(DEFAULT_SETTINGS_DIR);
  ensureDataDir(configuredDir);

  // 1.2.91 H4 fix: file-lock で concurrent write を排他化
  // 元: atomic rename だけだと load → merge → save の間に別の save が割り込むと
  // 後者の merge 結果が前者で上書きされる (ICP 設定保存等で再現)。
  const { acquireFileLock, releaseFileLock } = require('./file-lock');
  const lockFile = acquireFileLock(configuredFile, { maxWaitMs: 5000, label: 'settings-save' });
  try {
    // 1.2.92: バックアップ保持 — 既存ファイルを .backup にコピーしてから上書き
    // 設定が破損した場合、ユーザーは {settings.json}.backup から手動復元可能
    if (fs.existsSync(configuredFile)) {
      try { fs.copyFileSync(configuredFile, configuredFile + '.backup'); } catch (_) { /* backup 失敗は致命的でない */ }
    }
    atomicWriteFileSync(configuredFile, payload);
    if (path.resolve(configuredFile) !== path.resolve(SETTINGS_FILE)) {
      atomicWriteFileSync(SETTINGS_FILE, payload);
    }
  } finally {
    releaseFileLock(lockFile);
  }

  // キャッシュを直接更新: 次の load() は disk を読まずにこれを返す。
  // signature も新しいファイルの mtime+size に揃える。
  // (ファイルが書き換わったので古い signature では一致しなくなる)
  // 凍結してから格納: 戻り値を呼び出し側が触っても汚染されない。
  deepFreeze(normalized);
  settingsCache.filePath = configuredFile;
  settingsCache.signature = getFileSignature(configuredFile);
  settingsCache.data = normalized;
}

function atomicWriteFileSync(filePath, content) {
  // 根本原因 1・2 の対策: file-lock.ts の atomicWriteJson に委譲して
  // copyFileSync フォールバックを撤廃。EPERM/EBUSY は atomicWriteJson 内でリトライ。
  const { atomicWriteJson } = require('./file-lock');
  atomicWriteJson(filePath, content);
}

/**
 * ロックを保持したままファイルへ書き込む内部専用関数。
 * ロック取得は呼び出し元 (mutateLocked / save) の責任。
 * 再入防止: set/updateSection/replaceSection はこちら経由とし、
 * save() を呼ばない (ロック二重取得を避ける)。
 */
function _saveUnlocked(normalized, configuredFile) {
  ensureDataDir(DEFAULT_SETTINGS_DIR);
  const configuredDir = path.dirname(configuredFile);
  ensureDataDir(configuredDir);
  const payload = JSON.stringify(normalized, null, 2);
  // .backup を既存の .backup 保持ポリシーに従い保存
  if (fs.existsSync(configuredFile)) {
    try { fs.copyFileSync(configuredFile, configuredFile + '.backup'); } catch (_) { /* ignore */ }
  }
  atomicWriteFileSync(configuredFile, payload);
  if (path.resolve(configuredFile) !== path.resolve(SETTINGS_FILE)) {
    atomicWriteFileSync(SETTINGS_FILE, payload);
  }
  deepFreeze(normalized);
  settingsCache.filePath = configuredFile;
  settingsCache.signature = getFileSignature(configuredFile);
  settingsCache.data = normalized;
}

/**
 * 根本原因 3 の対策: read-modify-write をロック内で一括実行するヘルパ。
 * set / updateSection / replaceSection はこれを経由することで lost-update を防ぐ。
 * @param fn - 最新の設定オブジェクトを受け取り、変更後の設定を返すコールバック
 */
function mutateLocked(fn: (settings: Record<string, unknown>) => Record<string, unknown>): void {
  const { acquireFileLock: _acq, releaseFileLock: _rel } = require('./file-lock');
  // configuredFile は最新の bootstrap から決定する
  const bootstrap = getBootstrapSettings();
  const configuredDir = resolveConfiguredDataDir(bootstrap && bootstrap.preferences && bootstrap.preferences.dataDir);
  const configuredFile = path.join(configuredDir, 'settings.json');
  ensureDataDir(DEFAULT_SETTINGS_DIR);
  ensureDataDir(configuredDir);
  const lockFile = _acq(configuredFile, { maxWaitMs: 5000, label: 'settings-mutate' });
  try {
    // ロック内で最新をロードしてから mutate する (キャッシュを無効化して確実に disk から読む)
    invalidateSettingsCache();
    const latest = structuredClone(load());
    const mutated = fn(latest);
    const normalized = normalizeSettings(mutated);
    _saveUnlocked(normalized, configuredFile);
  } finally {
    _rel(lockFile);
  }
}

/**
 * 全設定を取得する（load() のエイリアス）。戻り値は frozen。
 * @returns {Object} 設定オブジェクト全体
 */
function getAll() {
  return load();
}

/**
 * 設定のトップレベルセクションを取得する。
 * @param {string} section - セクション名（'companyProfile' / 'preferences' 等）
 * @returns {Object} 該当セクションのデータ
 */
function getSection(section) {
  const settings = load();
  if (!(section in settings)) throw new Error(`Unknown section: ${section}`);
  return settings[section];
}

/**
 * セクションを deep merge で部分更新する。
 * @param {string} section - セクション名
 * @param {Object} data - マージする部分データ
 * @returns {Object} 更新後のセクションデータ
 */
function updateSection(section, data) {
  // 根本原因 3 の対策: mutateLocked 内で最新をロードしてから mutate する
  if (!(section in DEFAULT_SETTINGS)) throw new Error(`Unknown section: ${section}`);
  let result: unknown;
  mutateLocked((settings) => {
    if (!(section in settings)) throw new Error(`Unknown section: ${section}`);
    settings[section] = deepMerge(settings[section], data);
    result = settings[section];
    return settings;
  });
  return result;
}

/**
 * セクションを丸ごと置き換える（deep merge ではなく上書き）。
 * @param {string} section - セクション名
 * @param {*} data - 新しいセクション値
 * @returns {*} 置換後のセクションデータ
 */
function replaceSection(section, data) {
  // 根本原因 3 の対策: mutateLocked 内で最新をロードしてから mutate する
  if (!(section in DEFAULT_SETTINGS)) throw new Error(`Unknown section: ${section}`);
  let result: unknown;
  mutateLocked((settings) => {
    if (!(section in settings)) throw new Error(`Unknown section: ${section}`);
    settings[section] = data;
    result = settings[section];
    return settings;
  });
  return result;
}

/**
 * セクション内の特定キー、もしくはセクション全体を取得する。
 * @param {string} section - セクション名
 * @param {string} [key] - キー名（省略時はセクション全体を返す）
 * @returns {*} 値またはセクションデータ
 */
function get(section, key) {
  const sectionData = getSection(section);
  return key ? sectionData[key] : sectionData;
}

/**
 * セクション内の特定キーに値を書き込む。
 * @param {string} section - セクション名
 * @param {string} key - キー名
 * @param {*} value - 書き込む値
 * @returns {*} 書き込み後の値
 */
function set(section, key, value) {
  // 根本原因 3 の対策: mutateLocked 内で最新をロードしてから mutate する
  if (!(section in DEFAULT_SETTINGS)) throw new Error(`Unknown section: ${section}`);
  let result: unknown;
  mutateLocked((settings) => {
    if (!(section in settings)) throw new Error(`Unknown section: ${section}`);
    (settings[section] as Record<string, unknown>)[key] = value;
    result = (settings[section] as Record<string, unknown>)[key];
    return settings;
  });
  return result;
}

// --- Helpers ---

// Object prototype 汚染を防ぐためのガード集合。
// JSON.parse で `{"__proto__": {...}}` をパースすると own プロパティとして
// __proto__ が入る。`result['__proto__'] = ...` は Object.prototype を変更する
// setter なので、後続の全コードが汚染される。
// PUT /api/settings/:section 経由でユーザー入力が deepMerge に流れるので
// 必ずガードする。
const _PROTO_POLLUTION_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function deepMerge(target, source) {
  if (!source || typeof source !== 'object') return target;
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (_PROTO_POLLUTION_KEYS.has(key)) continue; // ★ prototype pollution 防御
    if (source[key] !== null && typeof source[key] === 'object' && !Array.isArray(source[key])
        && typeof result[key] === 'object' && !Array.isArray(result[key])) {
      result[key] = deepMerge(result[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

// --- Convenience Getters ---

/**
 * @typedef {Object} SenderInfo
 * @property {string} companyName
 * @property {string} name
 * @property {string} nameKana
 * @property {string} email
 * @property {string} phone
 * @property {string} mobile
 * @property {string} fax
 * @property {string} postalCode
 * @property {string} address
 * @property {string} website
 * @property {string} partnerPage
 * @property {string} department
 * @property {string} title
 */

/**
 * フォーム入力に使う送信者情報を companyProfile から組み立てて返す。
 * @returns {SenderInfo} 送信者情報
 */
function getSender() {
  const profile = getSection('companyProfile');
  return {
    companyName: profile.companyName,
    name: profile.contactName,
    nameKana: profile.contactNameKana,
    email: profile.email,
    phone: profile.phone,
    mobile: profile.mobile,
    fax: profile.fax,
    postalCode: profile.postalCode,
    address: profile.address,
    website: profile.website,
    partnerPage: profile.partnerPage,
    department: profile.department,
    title: profile.contactTitle,
  };
}

/**
 * 自社の強み一覧を取得する。
 * @returns {Array<Object>} strengths 配列（{ key, label, detail, keywords }）
 */
function getStrengths() {
  return getSection('valuePropositions').strengths || [];
}

/**
 * 協業実績パターン一覧を取得する。
 * @returns {Array<Object>} successPatterns 配列（{ partner, proof, type }）
 */
function getSuccessPatterns() {
  return getSection('valuePropositions').successPatterns || [];
}

/**
 * 業種別プロフィール（メッセージテンプレート）を取得する。
 * @returns {Object} 業種名 → { opener, point, examples, strength } のマップ
 */
function getIndustryProfiles() {
  return getSection('valuePropositions').industryProfiles || {};
}

/**
 * @typedef {Object} IdealCustomer
 * @property {string} descriptionFreetext
 * @property {Array<string>} mustHave
 * @property {Array<string>} dealBreakers
 * @property {{ positive: Array<*>, negative: Array<*> }} exemplars
 * @property {{ patterns: Array<string> }} exclusionKeywords
 * @property {{ patterns: Array<string> }} competitors
 * @property {number} minSiteTextLength
 * @property {boolean} useLLMAnalyzer
 * @property {boolean} useLLMMessageGenerator
 */

/**
 * 業界非依存の理想顧客像 (ICP) を返す。
 * 旧: industryProfiles の業界文字列マッチで送信先を決めていた → 業界辞書必須
 * 新: idealCustomer.{descriptionFreetext, mustHave, dealBreakers, exemplars} で
 *     業態を問わない判定基準を保持。AI 分析・品質ゲートが共通参照する。
 *
 * 既存設定 (idealCustomer 未設定) でも安全な空オブジェクトを返す。
 * 必須フィールドのみ default 補完する。
 * @returns {IdealCustomer} 正規化済み ICP オブジェクト
 */
function getIdealCustomer() {
  const raw = getSection('valuePropositions').idealCustomer;
  if (!raw || typeof raw !== 'object') {
    return {
      descriptionFreetext: '',
      mustHave: [],
      dealBreakers: [],
      exemplars: { positive: [], negative: [] },
      exclusionKeywords: { patterns: [] },
      competitors: { patterns: [] },
      minSiteTextLength: 800,
      useLLMAnalyzer: false,
      useLLMMessageGenerator: false,
    };
  }
  const exemplars = (raw.exemplars && typeof raw.exemplars === 'object') ? raw.exemplars : {};
  return {
    descriptionFreetext: String(raw.descriptionFreetext || '').trim(),
    mustHave: Array.isArray(raw.mustHave) ? raw.mustHave.filter((s: any) => typeof s === 'string' && s.trim()) : [],
    dealBreakers: Array.isArray(raw.dealBreakers) ? raw.dealBreakers.filter((s: any) => typeof s === 'string' && s.trim()) : [],
    exemplars: {
      positive: Array.isArray(exemplars.positive) ? exemplars.positive : [],
      negative: Array.isArray(exemplars.negative) ? exemplars.negative : [],
    },
    exclusionKeywords: {
      patterns: Array.isArray(raw.exclusionKeywords && raw.exclusionKeywords.patterns)
        ? raw.exclusionKeywords.patterns.filter((s: any) => typeof s === 'string' && s.trim())
        : [],
    },
    competitors: {
      patterns: Array.isArray(raw.competitors && raw.competitors.patterns)
        ? raw.competitors.patterns.filter((s: any) => typeof s === 'string' && s.trim())
        : [],
    },
    minSiteTextLength: Number.isFinite(Number(raw.minSiteTextLength))
      ? Math.max(0, Math.floor(Number(raw.minSiteTextLength)))
      : 800,
    // Phase A-1 feature flag.
    // ON にすると Phase A の業態判定をキーワード辞書から CLI ヘッドレス
    // 解析に切替える (Claude/Codex/Gemini を 1社あたり 5-30s 呼び出す)。
    // 既定 OFF (CLI quota を消費するため)。
    useLLMAnalyzer: raw.useLLMAnalyzer === true,
    // Phase B feature flag.
    // ON にすると本文生成を CLI に委譲し、テンプレ感のない各社専用文面を生成。
    // 8 項目品質ゲートで送信前検証。useLLMAnalyzer と独立に切替可能。
    useLLMMessageGenerator: raw.useLLMMessageGenerator === true,
  };
}

/**
 * 除外対象のステータス文字列一覧を取得する。
 * @returns {Array<string>} 除外ステータス
 */
function getExcludeStatuses() {
  return getSection('exclusionRules').excludeStatuses || [];
}

// v2.0.99: 営業アプローチ意図 (messageTemplates.approachTargets)。
//   「どこに営業をかけたいか」(協業/業務提携/採用/広報/IR/一般) の選択。
//   Phase B のフォーム選好生成 + Phase A の除外緩和に使う。未設定は既定意図。
function getApproachTargets() {
  let raw: any = null;
  try { const mt = getSection('messageTemplates') || {}; raw = mt.approachTargets; } catch (_) { /* swallow */ }
  if (!Array.isArray(raw)) return null; // null = 未設定 (呼び出し側で default を適用)
  return raw.map((t: any) => String(t)).filter(Boolean);
}

// v2.0.98: フォーム入力の並列度 (settings の formFill.parallelism)。
//   これが Phase B の「1 バッチあたりの社数 = pipelineFlushSize」と
//   「同時に開く WebView タブ数 (min(値, 3))」の両方を駆動する単一ノブ。
//   旧来 UI に出ていたが pipeline が読んでいなかった (DEAD 設定) のを配線する。
function getFormFillParallelism() {
  let raw: any = null;
  try { const ff = getSection('formFill') || {}; raw = ff.parallelism; } catch (_) { /* swallow */ }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 3; // 既定 3
  return Math.max(1, Math.min(5, Math.floor(n)));
}

/**
 * フォーム自動送信ポリシーを取得する。
 * @returns {{ enabled: boolean, requireApproval: boolean, skipIfCaptcha: boolean }} 自動送信ポリシー
 */
function getAutoSubmitPolicy() {
  const prefs = getSection('preferences');
  return {
    enabled: prefs.autoSendEligibleForms === true,
    requireApproval: prefs.requireApprovalBeforeSend !== false,
    skipIfCaptcha: true,
  };
}

/**
 * ターゲットリスト Excel/CSV の絶対パスを返す。未設定なら null。
 * @returns {string|null} ターゲットリストの絶対パス
 */
function getTargetListPath() {
  const tl = getSection('targetList');
  if (!tl.filePath) return null;
  return path.isAbsolute(tl.filePath) ? tl.filePath : path.join(getRuntimeRoot(), tl.filePath);
}

/**
 * ダッシュボードのポート番号を取得する（1024〜65535、不正なら 3765）。
 * @returns {number} ポート番号
 */
function getPort() {
  const port = Number(getSection('preferences').dashboardPort);
  if (Number.isInteger(port) && port >= 1024 && port <= 65535) return port;
  return 3765;
}

/**
 * ダッシュボードのバインドホストを取得する（不正値や 0.0.0.0 系は 127.0.0.1）。
 * @returns {string} ホスト名
 */
function getHost() {
  const host = (getSection('preferences').dashboardHost || '').trim();
  if (!host || host === '0.0.0.0' || host === '::' || host === '::0') return '127.0.0.1';
  return host;
}

/**
 * スクリーンショット保存ディレクトリの絶対パスを返す。
 * @returns {string} 絶対パス
 */
function getScreenshotDir() {
  const raw = getSection('preferences').screenshotDir || 'screenshots';
  const dir = typeof raw === 'string' && !raw.includes('\0') ? raw.trim() : 'screenshots';
  const resolved = path.isAbsolute(dir) ? dir : path.join(getRuntimeRoot(), dir);
  return path.resolve(resolved);
}

function normalizeSettings(input) {
  const settings = input && typeof input === 'object' ? input : structuredClone(DEFAULT_SETTINGS);
  if (!settings.preferences || typeof settings.preferences !== 'object') {
    settings.preferences = structuredClone(DEFAULT_SETTINGS.preferences);
  }

  const prefs = settings.preferences;
  const aiProvider = typeof prefs.aiProvider === 'string' && prefs.aiProvider.trim()
    ? prefs.aiProvider.trim().toLowerCase()
    : 'claude';
  prefs.aiProvider = ['claude', 'codex', 'gemini'].includes(aiProvider) ? aiProvider : 'claude';

  const aiModels = prefs.aiModels && typeof prefs.aiModels === 'object' && !Array.isArray(prefs.aiModels)
    ? { ...prefs.aiModels }
    : {};
  aiModels.claude = typeof aiModels.claude === 'string' ? aiModels.claude : '';
  aiModels.codex = typeof aiModels.codex === 'string' ? aiModels.codex : '';
  aiModels.gemini = typeof aiModels.gemini === 'string' ? aiModels.gemini : '';

  if (!aiModels.claude && typeof prefs.claudeModel === 'string' && prefs.claudeModel.trim()) {
    aiModels.claude = prefs.claudeModel.trim();
  }
  if (!aiModels.claude) {
    aiModels.claude = DEFAULT_SETTINGS.preferences.aiModels.claude;
  }

  prefs.aiModels = aiModels;
  prefs.claudeModel = aiModels.claude;

  return settings;
}

/**
 * 必須プロフィール項目（会社名・担当者名・メール・電話）が揃っているか判定する。
 * @returns {boolean} 設定完了なら true
 */
function isConfigured() {
  const profile = getSection('companyProfile');
  return !!(profile.companyName && profile.contactName && profile.email && profile.phone);
}

/**
 * 署名テンプレートを展開して文字列で返す（signatureFormat に応じて 'full'/'minimal'/'none'）。
 * @returns {string} 展開済み署名文字列
 */
function getSignature() {
  const profile = getSection('companyProfile');
  const tmpl = getSection('messageTemplates');
  const style = getMessageStyle();
  const signatureFormat = style.signatureFormat || 'full';
  if (signatureFormat === 'none') return '';
  if (signatureFormat === 'minimal') {
    return [
      profile.companyName || '',
      profile.contactName || '',
      profile.email ? `MAIL: ${profile.email}` : '',
    ].filter(Boolean).join('\n');
  }
  const template = tmpl.signatureTemplate || '{companyName}\n{contactName}\nTEL: {phone}\nMAIL: {email}';
  return template
    .replace('{companyName}', profile.companyName || '')
    .replace('{contactName}', profile.contactName || '')
    .replace('{contactTitle}', profile.contactTitle || '')
    .replace('{department}', profile.department || '')
    .replace('{phone}', profile.phone || '')
    .replace('{mobile}', profile.mobile || '')
    .replace('{fax}', profile.fax || '')
    .replace('{email}', profile.email || '')
    .replace('{website}', profile.website || '')
    .replace('{partnerPage}', profile.partnerPage || '')
    .replace('{address}', profile.address || '');
}

/**
 * メッセージスタイル設定（tone / language / maxLength / signatureFormat 等）を取得する。
 * @returns {Object} スタイル設定のシャローコピー
 */
function getMessageStyle() {
  const tmpl = getSection('messageTemplates');
  return {
    ...(tmpl.style || {}),
  };
}

/**
 * 書面（PDF/手紙）テンプレート設定を取得する。未設定値はデフォルトで補完する。
 * @returns {{ enabled: boolean, header: string, footer: string, format: string }} 書面テンプレート
 */
function getLetterTemplate() {
  const tmpl = getSection('messageTemplates');
  return {
    enabled: !!(tmpl.letterTemplate && tmpl.letterTemplate.enabled),
    header: tmpl.letterTemplate && typeof tmpl.letterTemplate.header === 'string' ? tmpl.letterTemplate.header : '',
    footer: tmpl.letterTemplate && typeof tmpl.letterTemplate.footer === 'string' ? tmpl.letterTemplate.footer : '',
    format: (tmpl.letterTemplate && tmpl.letterTemplate.format) || 'A4',
  };
}

/**
 * 送信前承認が必須かどうかを返す（デフォルト true）。
 * @returns {boolean} 承認必須なら true
 */
function getApprovalBeforeSend() {
  return getSection('preferences').requireApprovalBeforeSend !== false;
}

/**
 * 安全なフォームの自動送信が許可されているかを返す。
 * @returns {boolean} 自動送信許可なら true
 */
function getAutoSendEligibleForms() {
  return getSection('preferences').autoSendEligibleForms === true;
}

/**
 * フォーム入力タイムアウト（ms）を取得する。不正値は 5000 ms にフォールバック。
 * @returns {number} タイムアウト（ms）
 */
function getFormFillTimeout() {
  const timeout = Number(getSection('preferences').formFillTimeout);
  return Number.isFinite(timeout) && timeout > 0 ? timeout : 5000;
}

/**
 * 現在の AI プロバイダ ID（'claude' / 'codex' / 'gemini'）を返す。
 * @returns {string} プロバイダ ID
 */
function getAiProvider() {
  return (getSection('preferences').aiProvider || 'claude').trim() || 'claude';
}

/**
 * 各 AI プロバイダのモデル名マップを取得する。
 * @returns {{ claude?: string, codex?: string, gemini?: string }} モデル名マップ
 */
function getAiModels() {
  return { ...(getSection('preferences').aiModels || {}) };
}

/**
 * 指定プロバイダのモデル名を取得する。
 * @param {string} [providerId] - プロバイダ ID（'claude' / 'codex' / 'gemini'、デフォルト 'claude'）
 * @returns {string} モデル名（未設定時は空文字）
 */
function getAiModel(providerId = 'claude') {
  const key = typeof providerId === 'string' ? providerId.trim().toLowerCase() : 'claude';
  const models = getAiModels();
  return typeof models[key] === 'string' ? models[key].trim() : '';
}

/**
 * Phase 別のモデル名を取得する。Programmatic Credit 枠を節約するために
 * Phase A (サイト解析・パターン抽出) は安価な Haiku、Phase B (メッセージ生成)
 * は品質重視の Sonnet を既定にする。
 *
 * 優先順位:
 *   1. settings.preferences.aiModelsByPhase[phase][providerId]
 *      例: { 'site-analysis': { claude: 'claude-haiku-4-5' }, 'message-generation': { claude: 'claude-sonnet-4-6' } }
 *   2. settings.preferences.aiModels[providerId]  (phase 区別なし)
 *   3. 各プロバイダのデフォルト
 *
 * @param {string} phase - 'site-analysis' | 'message-generation'
 * @param {string} [providerId] - 'claude' | 'codex' | 'gemini'
 * @returns {string} モデル名 (未設定時は phase の既定)
 */
function getAiModelForPhase(phase: string, providerId: string = 'claude') {
  const providerKey = typeof providerId === 'string' ? providerId.trim().toLowerCase() : 'claude';
  const phaseKey = typeof phase === 'string' ? phase.trim() : '';

  // 1. phase + provider 個別指定
  const prefs = getSection('preferences') as any;
  const byPhase = (prefs && prefs.aiModelsByPhase) || {};
  const phaseMap = byPhase[phaseKey];
  if (phaseMap && typeof phaseMap[providerKey] === 'string' && phaseMap[providerKey].trim()) {
    return phaseMap[providerKey].trim();
  }

  // 2. phase 区別なしの provider 別指定
  const fallback = getAiModel(providerKey);
  if (fallback) return fallback;

  // 3. 各プロバイダのデフォルト
  if (phaseKey === 'site-analysis') {
    if (providerKey === 'claude') return 'claude-haiku-4-5';  // Phase A: 単価 1/10 で十分
    if (providerKey === 'codex') return '';   // codex はデフォルト任せ
    if (providerKey === 'gemini') return 'gemini-2.5-flash';
  }
  if (phaseKey === 'message-generation') {
    if (providerKey === 'claude') return 'claude-sonnet-4-6'; // Phase B: 文章品質重視
    if (providerKey === 'codex') return '';
    if (providerKey === 'gemini') return 'gemini-2.5-pro';
  }
  return '';
}

// --- list-builder / API キー アクセサ ---
//
// 重要なセキュリティ契約:
//   - getApiKey(name) は内部専用。実値を返すため、HTTP API レスポンスや UI に
//     直接漏らしてはいけない。ダッシュボード API は getApiKeyStatus() を使う。
//   - getApiKeys() も同じく内部専用（実値オブジェクト全体を返す）。
//   - UI / API には getApiKeyStatus() で boolean マップだけ渡す。
//   - 平文保存は Phase 1 の暫定対応。Phase 8 で settings 暗号化を導入する予定。

/**
 * API キーセクション全体（実値）を取得する。内部専用、HTTP/UI に渡してはいけない。
 * @returns {Object} API キーマップ（{ serpApi, houjinBangou, gBizInfo, edinet, ... }）
 */
function getApiKeys() {
  const section = getSection('apiKeys');
  return section && typeof section === 'object' ? section : {};
}

/**
 * 個別 API キーの実値を取得する。内部専用。
 * @param {string} name - キー名
 * @returns {string} キー値（未設定時は空文字）
 */
function getApiKey(name) {
  const keys = getApiKeys();
  return typeof keys[name] === 'string' ? keys[name].trim() : '';
}

/**
 * 指定 API キーが設定済みか判定する。
 * @param {string} name - キー名
 * @returns {boolean} 設定済みなら true
 */
function hasApiKey(name) {
  return getApiKey(name).length > 0;
}

/**
 * UI / HTTP API 向けに API キーの有無マップ（boolean）のみを返す。値は返さない。
 * @returns {Object<string, boolean>} キー名 → 設定済みフラグ
 */
function getApiKeyStatus() {
  const keys = getApiKeys();
  const result: Record<string, unknown> = {};
  for (const name of Object.keys(keys)) {
    result[name] = typeof keys[name] === 'string' && keys[name].trim().length > 0;
  }
  return result;
}

/**
 * list-builder の設定セクションを取得する。
 * @returns {Object} listBuilder セクションのデータ
 */
function getListBuilderConfig() {
  const section = getSection('listBuilder');
  return section && typeof section === 'object' ? section : {};
}

/**
 * list-builder の qualification-scorer 用スコア配点を取得する（未設定時はデフォルト）。
 * @returns {Object<string, number>} カテゴリ名 → 配点
 */
function getListBuilderScoring() {
  const config = getListBuilderConfig();
  const defaults = (DEFAULT_SETTINGS.listBuilder && DEFAULT_SETTINGS.listBuilder.scoring) || {};
  const scoring = config && config.scoring && typeof config.scoring === 'object'
    ? config.scoring
    : {};
  return { ...defaults, ...scoring };
}

/**
 * 既存協業先・グループ会社の保護リストを返す。
 * 保護リストに該当する会社には営業メールを送らない。
 * @returns {Array<{name: string, match_patterns: string[], reason: string}>}
 */
function getProtectedGroups() {
  const raw = getSection('valuePropositions').protected_groups;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((g: any) => g && typeof g === 'object' && String(g.name || '').trim())
    .map((g: any) => {
      const patterns: string[] = [];
      if (g.name) patterns.push(String(g.name));
      if (Array.isArray(g.match_patterns)) patterns.push(...g.match_patterns);
      if (Array.isArray(g.patterns)) patterns.push(...g.patterns);
      return {
        name: String(g.name || '').trim(),
        match_patterns: Array.from(new Set(patterns
          .map((p: any) => String(p || '').trim())
          .filter((p: any) => p.length >= 2))),
        reason: String(g.reason || '').trim(),
      };
    })
    .filter((g: any) => g.match_patterns.length > 0);
}

/**
 * 直接競合・営業対象外シグナルのリストを返す。
 * @returns {Array<{category: string, match_patterns: string[]}>}
 */
function getCompetitors() {
  const vp = getSection('valuePropositions');
  const raw = Array.isArray(vp.competitors) ? vp.competitors : [];
  return raw
    .filter((entry: any) => entry && typeof entry === 'object')
    .map((entry: any) => ({
      category: String(entry.category || entry.name || '').trim(),
      match_patterns: Array.from(new Set([
        ...(Array.isArray(entry.match_patterns) ? entry.match_patterns : []),
        ...(Array.isArray(entry.patterns) ? entry.patterns : []),
        ...(Array.isArray(entry.signals) ? entry.signals : []),
      ].map((p: any) => String(p || '').trim()).filter((p: any) => p.length >= 2))),
    }))
    .filter((entry: any) => entry.match_patterns.length > 0);
}

// --- Export ---

module.exports = {
  // Core
  load, save, getAll, getSection, updateSection, replaceSection, get, set,
  // Convenience
  getSender, getStrengths, getSuccessPatterns, getIndustryProfiles, getIdealCustomer,
  getExcludeStatuses, getFormFillParallelism, getApproachTargets, getTargetListPath, getPort, getScreenshotDir, getProtectedGroups, getCompetitors,
  getHost, getRuntimeRoot,
  isConfigured, getSignature, getMessageStyle, getLetterTemplate,
  getApprovalBeforeSend, getAutoSendEligibleForms, getAutoSubmitPolicy, getFormFillTimeout, getActiveSettingsFile,
  getAiProvider, getAiModels, getAiModel, getAiModelForPhase,
  // list-builder / API キー
  getApiKeys, getApiKey, hasApiKey, getApiKeyStatus,
  getListBuilderConfig, getListBuilderScoring,
  // Cache control (テスト & 外部編集検知用途)
  invalidateSettingsCache,
  // Constants
  DEFAULT_SETTINGS, PROJECT_ROOT, SETTINGS_FILE, LEGACY_SETTINGS_FILE, SAMPLE_SETTINGS_FILE, STATIC_DATA_DIR,
};

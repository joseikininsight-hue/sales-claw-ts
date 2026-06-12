// Sales Claw settings types
//
// data/settings.json の型定義。実体は src/settings-manager のデフォルト値と sample-settings.json を反映。
// 段階的移行中なので、後方互換のため Partial を多用している。

import type { Country } from './locale';

export interface CompanyProfile {
  companyName: string;
  companyNameEn: string;
  companyNameKana: string;
  representative: string;
  contactName: string;
  contactNameKana: string;
  contactTitle: string;
  department: string;
  email: string;
  phone: string;
  fax: string;
  mobile: string;
  postalCode: string;
  address: string;
  addressEn: string;
  website: string;
  partnerPage: string;
  corporateProfile: string;
  established: string;
  employeeCount: string;
  capital: string;
  industry: string;
  businessDescription: string;
  notes: string;
  /**
   * 拠点国コード。法令適合チェック / フッター生成の locale 切替に使う (Phase 4)。
   * 未設定時は 'ja-jp' として扱う (既存ユーザー互換)。
   */
  country?: Country;
}

export interface ServiceUrl {
  label: string;
  url: string;
}

export interface DocumentPath {
  name: string;
  path: string;
  description?: string;
}

export interface Strength {
  key: string;
  label: string;
  detail: string;
  keywords: string[];
}

export interface SuccessPattern {
  partner: string;
  proof: string;
  type: string;
}

export interface ProtectedGroup {
  name: string;
  match_patterns: string[];
  reason: string;
}

export interface Competitor {
  category: string;
  match_patterns: string[];
}

export interface IndustryProfile {
  opener?: string;
  point?: string;
  examples?: string;
  strength?: string;
}

export interface ValuePropositions {
  companyUrl: string;
  serviceUrls: ServiceUrl[];
  documentPaths: DocumentPath[];
  strengths: Strength[];
  successPatterns: SuccessPattern[];
  protected_groups: ProtectedGroup[];
  competitors: Competitor[];
  industryProfiles: Record<string, IndustryProfile>;
}

export interface TargetListColumnMapping {
  no: number;
  status: number;
  companyName: number;
  type: number;
  url: number;
  formUrl: number;
  notes: number;
  captcha: number;
  progress: number;
}

export interface TargetListConfig {
  filePath: string;
  fileType: 'xlsx' | 'csv';
  sheetIndex: number;
  columnMapping: TargetListColumnMapping;
}

export interface ExclusionRule {
  pattern: string;
  status?: string;
  reason?: string;
}

export interface CustomExclusionRule {
  pattern: string;
  status: string;
  reason: string;
}

export interface ExclusionRules {
  competitors: ExclusionRule[];
  existingClients: ExclusionRule[];
  ngList: ExclusionRule[];
  customRules: CustomExclusionRule[];
  excludeStatuses: string[];
}

export type ToneStyle = 'formal' | 'casual' | 'business';
export type Language = 'ja' | 'en';
export type SignatureFormat = 'full' | 'minimal' | 'none';
export type LetterFormat = 'A4' | 'letter';

export interface MessageStyle {
  tone: ToneStyle;
  language: Language;
  maxLength: number;
  signatureFormat: SignatureFormat;
}

export interface LetterTemplate {
  enabled: boolean;
  header: string;
  footer: string;
  format: LetterFormat;
}

/**
 * v2.0.59: ユーザーごとのフォーム選択設定。
 *
 * Claude が複数のお問い合わせフォーム (一般 Contact / パートナー / 採用 / IR 等)
 * を持つ B2B サイトに到達したとき、どれを優先・回避するかをユーザーが定義できる。
 *
 * 未設定なら locale-pack のデフォルト (= パートナー営業向け) が適用される。
 *
 * 利用例:
 * - パートナー営業 (default): preferredKeywords=["パートナー","協業","alliance"]
 * - 人材紹介:                preferredKeywords=["採用","HR","career","recruit"]
 * - IR / 投資家対応:        preferredKeywords=["IR","investor","株主"]
 * - 取材/PR:                 preferredKeywords=["広報","PR","press","media"]
 */
export interface FormPreferences {
  approachLabel?: string;        // 「パートナー営業」「人材紹介」等の表示ラベル
  preferredKeywords?: string[];  // 優先するフォーム名キーワード
  avoidKeywords?: string[];      // 避けるフォーム名キーワード
}

export interface MessageTemplates {
  style: MessageStyle;
  inquiryTypes: string[];
  approachObjective: string;
  approachGuardrails: string;
  closingLine: string;
  greetingLine: string;
  cta: string;
  referenceUrlText: string;
  signatureTemplate: string;
  letterTemplate: LetterTemplate;
  /**
   * Phase 3: メッセージ生成・CLI prompt の言語指定。
   * - 'auto' (default): 各社の analysis.detectedLanguage を採用する
   * - 'ja' | 'en': 全社で明示的に固定する
   *
   * ja のままなら従来挙動と完全互換。
   */
  language?: 'auto' | 'ja' | 'en';
  /** v2.0.59: フォーム選択のパーソナライズ設定 */
  formPreferences?: FormPreferences;
}

export type EmailProvider = 'outlook' | 'gmail' | 'other';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type AiProvider = 'claude' | 'codex' | 'gemini';

export interface AiModels {
  claude: string;
  codex: string;
  gemini: string;
}

export interface Preferences {
  dashboardPort: number;
  dashboardHost: string;
  language: Language;
  timezone: string;
  dateFormat: string;
  screenshotDir: string;
  dataDir: string;
  emailSearchKeyword: string;
  emailProvider: EmailProvider;
  maxRetries: number;
  pageTimeout: number;
  formFillTimeout: number;
  headless: boolean;
  userAgent: string;
  locale: string;
  complianceFooter: boolean;
  listSourceMetadata: string;
  usdJpy: number;
  aiProvider: AiProvider;
  aiModels: AiModels;
  claudeModel: string;
  logLevel: LogLevel;
  maxLogEntries: number;
  requireApprovalBeforeSend: boolean;
  autoSendEligibleForms: boolean;
  exportFilenamePrefix: string;
}

export interface ApiKeys {
  serpApi: string;
  houjinBangou: string;
  gBizInfo: string;
  edinet: string;
}

export type UnknownFieldPolicy = 'strict' | 'standard' | 'broad';

export interface ListBuilderScoring {
  industry: number;
  prefecture: number;
  size: number;
  officialVerified: number;
  formAvailable: number;
  noPriorContact: number;
  keywordMatch: number;
}

export interface ListBuilderConfig {
  officialDataFirst: boolean;
  scraplingMcpEnabled: boolean;
  scraplingPythonPath: string;
  concurrency: number;
  perDomainConcurrency: number;
  perDomainMinIntervalMs: number;
  timeoutMs: number;
  respectRobotsTxt: boolean;
  stopOnCaptcha: boolean;
  stopOn403: boolean;
  stopOn429: boolean;
  extractPersonalEmails: boolean;
  extractPersonNames: boolean;
  maxResultsPerRun: number;
  maxDepthPerCompanySite: number;
  maxPagesPerDomain: number;
  defaultUnknownFieldPolicy: UnknownFieldPolicy;
  dedupeThreshold: number;
  saveEvidence: boolean;
  cacheTtlDays: number;
  scoring: ListBuilderScoring;
}

export interface Settings {
  companyProfile: CompanyProfile;
  valuePropositions: ValuePropositions;
  targetList: TargetListConfig;
  exclusionRules: ExclusionRules;
  messageTemplates: MessageTemplates;
  preferences: Preferences;
  apiKeys: ApiKeys;
  listBuilder: ListBuilderConfig;
  /** 初回オンボーディング完了時刻 (ISO 8601)。未設定なら未完了 */
  _onboardedAt?: string;
}

/** 個々のセクション名 → セクション型のマッピング (settings-manager.getSection の戻り値推論用) */
export interface SectionMap {
  companyProfile: CompanyProfile;
  valuePropositions: ValuePropositions;
  targetList: TargetListConfig;
  exclusionRules: ExclusionRules;
  messageTemplates: MessageTemplates;
  preferences: Preferences;
  apiKeys: ApiKeys;
  listBuilder: ListBuilderConfig;
}

export type SectionKey = keyof SectionMap;

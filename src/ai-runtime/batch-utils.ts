// AI バッチ制御の純粋関数群
//
// 状態に依存しない / 外部副作用のないヘルパーのみを集約する。
// dashboard-server が require して使う。

export interface BatchCompany {
  no: number | string;
  [key: string]: unknown;
}

export interface PhaseASuccessEntry {
  companyNo: number | string;
  [key: string]: unknown;
}

export interface PhaseAFailureEntry {
  companyNo: number | string;
  [key: string]: unknown;
}

export interface ManagedAiBatchOptions {
  phaseAByCompany?: Map<string, unknown>;
  phaseASuccesses?: PhaseASuccessEntry[];
  phaseAFailures?: PhaseAFailureEntry[];
  [key: string]: unknown;
}

export interface ManagedAiBatchController {
  providerId: string;
  autoSendSafe: boolean;
  pending: unknown[];
  activeBatch: unknown;
  batchCounter: number;
  pollTimer: NodeJS.Timeout | null;
}

/** 企業リストを chunkSize ごとに分割する。 */
export function chunkManagedAiCompanies<T extends BatchCompany>(
  companies: T[] | null | undefined,
  chunkSize = 3
): T[][] {
  const normalizedChunkSize = Math.max(1, Number(chunkSize) || 3);
  const chunks: T[][] = [];
  const source = Array.isArray(companies) ? companies : [];
  for (let i = 0; i < source.length; i += normalizedChunkSize) {
    chunks.push(source.slice(i, i + normalizedChunkSize));
  }
  return chunks;
}

/**
 * baseOptions から、対象企業だけに絞った subset options を作る。
 * phaseAByCompany (Map), phaseASuccesses, phaseAFailures を subset 化。
 */
export function buildManagedAiBatchOptionsSubset(
  baseOptions: ManagedAiBatchOptions = {},
  companies: BatchCompany[] = []
): ManagedAiBatchOptions {
  const companyKeySet = new Set(companies.map((company: any) => String(company.no)));
  const subsetMap = new Map<string, unknown>();
  const sourceMap = baseOptions.phaseAByCompany instanceof Map ? baseOptions.phaseAByCompany : null;
  if (sourceMap) {
    companies.forEach((company: any) => {
      const key = String(company.no);
      if (sourceMap.has(key)) subsetMap.set(key, sourceMap.get(key));
    });
  }
  return {
    ...baseOptions,
    phaseAByCompany: subsetMap,
    phaseASuccesses: Array.isArray(baseOptions.phaseASuccesses)
      ? baseOptions.phaseASuccesses.filter((entry: any) => companyKeySet.has(String(entry.companyNo)))
      : [],
    phaseAFailures: Array.isArray(baseOptions.phaseAFailures)
      ? baseOptions.phaseAFailures.filter((entry: any) => companyKeySet.has(String(entry.companyNo)))
      : [],
  };
}

/**
 * batch controller の初期状態を生成する。
 * providerId の normalization は呼び出し側の責務
 * (ai-providers モジュールへの依存を避けるため)。
 */
export function createManagedAiBatchController(providerId: string, autoSendSafe: boolean): ManagedAiBatchController {
  return {
    providerId,
    autoSendSafe: Boolean(autoSendSafe),
    pending: [],
    activeBatch: null,
    batchCounter: 0,
    pollTimer: null,
  };
}

/** timestamp 文字列 / 数値を epoch ms に変換する。無効値は 0。 */
export function parseEventTimestampMs(value: unknown): number {
  if (!value) return 0;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * ANSI エスケープシーケンスを文字列から除去する。
 * PTY 出力をログや diff 比較に使う前処理として使う。
 */
export function stripAnsiCodes(value: unknown): string {
  return String(value ?? '').replace(
    /\[[0-9;?]*[ -/]*[@-~]|[@-_]|[0-9;?]*[ -/]*[@-~]/g,
    '',
  );
}

const CLAUDE_PASTE_BANNER_RE = /\[Pasted text|paste again to expand/i;

/**
 * Claude CLI の paste banner ("[Pasted text..." 等) が出力に含まれるか判定する。
 * ANSI エスケープを除去してから regex マッチする。
 */
export function hasClaudePasteBanner(value: unknown): boolean {
  return CLAUDE_PASTE_BANNER_RE.test(stripAnsiCodes(value));
}

module.exports = {
  chunkManagedAiCompanies,
  buildManagedAiBatchOptionsSubset,
  createManagedAiBatchController,
  parseEventTimestampMs,
  stripAnsiCodes,
  hasClaudePasteBanner,
};

'use strict';

/**
 * 汎用 retry + exponential back-off ヘルパー。
 *
 * Phase B (フォーム入力) の managed AI session 自動起動など、
 * 一時的な原因 (MCP race / CLI 認証タイムアウト / spawn 競合)
 * で 1 度だけ fail するケースを救う。
 *
 * 設計:
 *   - retry 回数・初期 delay・最大 delay・jitter を引数化
 *   - shouldRetry(err) で「リトライしてはいけないエラー」を弾く
 *     (例: 設定不足 / 認証拒否 / 致命的構成エラー)
 *   - 各試行ごとに onAttempt(attempt, error) でログ出力フックを呼ぶ
 */

export interface RetryOptions<T> {
  /** 最大試行回数 (初回 + retry 数 = N)。default 3 */
  attempts?: number;
  /** 初期 back-off [ms]。default 500 */
  initialDelayMs?: number;
  /** 上限 back-off [ms]。default 5000 */
  maxDelayMs?: number;
  /** 倍率。default 2 (500ms → 1000ms → 2000ms ...) */
  factor?: number;
  /**
   * このエラーで止まる場合 false を返す。
   * 未指定なら全エラーをリトライ対象として扱う。
   */
  shouldRetry?: (error: any, attempt: number) => boolean;
  /** 試行ごとのコールバック (ログ等)。throw されると無視 */
  onAttempt?: (attempt: number, error: any | null) => void;
}

const DEFAULTS = {
  attempts: 3,
  initialDelayMs: 500,
  maxDelayMs: 5000,
  factor: 2,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions<T> = {},
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? DEFAULTS.attempts);
  const initialDelayMs = Math.max(0, options.initialDelayMs ?? DEFAULTS.initialDelayMs);
  const maxDelayMs = Math.max(initialDelayMs, options.maxDelayMs ?? DEFAULTS.maxDelayMs);
  const factor = Math.max(1, options.factor ?? DEFAULTS.factor);
  const shouldRetry = options.shouldRetry ?? (() => true);
  const onAttempt = options.onAttempt;

  let lastError: any = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      if (onAttempt) {
        try { onAttempt(attempt, null); } catch (_) { /* swallow */ }
      }
      return await fn(attempt);
    } catch (error: any) {
      lastError = error;
      if (onAttempt) {
        try { onAttempt(attempt, error); } catch (_) { /* swallow */ }
      }
      if (attempt >= attempts) break;
      if (!shouldRetry(error, attempt)) break;
      const exp = initialDelayMs * Math.pow(factor, attempt - 1);
      const jitter = Math.random() * 0.3 * exp;  // 0..+30% jitter
      const delay = Math.min(maxDelayMs, exp + jitter);
      await sleep(delay);
    }
  }
  throw lastError;
}

module.exports = { withRetry };

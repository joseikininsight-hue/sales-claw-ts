'use strict';

/**
 * Spawn Env Sanitizer
 * ───────────────────
 * Claude / Codex / Gemini の CLI を子プロセスで起動する際に渡す env を
 * 「subscription (定額枠) 認証に乗る」状態に整形する。
 *
 * 背景:
 *   2026-06-15 から Anthropic Pro / Max / Team / Enterprise プランに
 *   "Programmatic credit" 枠が含まれるようになり、`claude -p` (headless)
 *   経由の呼び出しはこの定額枠で消費される。ただし以下の env が
 *   セットされていると CLI は API key 認証 (= 従量課金) を優先する:
 *
 *     ANTHROPIC_API_KEY         直接の API key
 *     ANTHROPIC_AUTH_TOKEN      OAuth token
 *     CLAUDE_CODE_USE_BEDROCK   AWS Bedrock 経由 (=自分の AWS 課金)
 *     CLAUDE_CODE_USE_VERTEX    GCP Vertex 経由 (=自分の GCP 課金)
 *
 *   このプロジェクトは Electron アプリで、ユーザーの環境変数を
 *   そのまま child_process に流しているため、ユーザーのシェル env に
 *   ANTHROPIC_API_KEY 等が残っていると意図せず従量課金に切り替わる。
 *
 *   さらに claude CLI は HOME (Unix) / USERPROFILE (Windows) を見て
 *   `~/.claude/credentials.json` から subscription token を読む。
 *   このプロジェクトは provider-home として
 *   `<runtime data dir>/provider-homes/claude/` を使うため、HOME を
 *   そこへ向けないと subscription 認証が拾えない。
 *
 * 使い方:
 *
 *   const { buildSanitizedSpawnEnv } = require('./spawn-env-sanitizer');
 *   const sanitized = buildSanitizedSpawnEnv({
 *     providerId: 'claude',
 *     providerHomeDir: '/path/to/provider-homes/claude',
 *     extraEnv: { ELECTRON_RUN_AS_NODE: '1' },
 *   });
 *   spawn(exe, args, { env: sanitized, ... });
 *
 * 設計原則:
 *   - 副作用なし: process.env は変更しない。新しい object を返す
 *   - allowlist ではなく blocklist: 既知の課金エスケープ env だけを消す。
 *     他の env (PATH, SystemRoot 等) は壊さず通す
 *   - providerHomeDir 未指定なら HOME / USERPROFILE は元のまま (=後方互換)
 *   - 削除した env のキー一覧を debug log 用に返す
 */

import * as path from 'path';

/**
 * 削除対象の env 変数。これらがセットされていると
 * `claude -p` は subscription credit ではなく API key / Bedrock / Vertex
 * の従量課金経路を取ってしまう。
 *
 * Codex / Gemini 系の credential も同じ理由で削除対象に入れている
 * (それぞれ subscription 認証経路を別途持っているため、API key を
 * 残しておくと従量課金にフォールバックする)。
 */
export const BILLING_LEAK_ENV_KEYS = [
  // Anthropic 直接
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_URL',         // カスタム API endpoint
  'ANTHROPIC_BASE_URL',        // カスタム base URL (アカウント分離)

  // 3rd-party provider switches
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',

  // Bedrock (AWS) — 自分の AWS アカウントに課金される経路
  'AWS_BEARER_TOKEN_BEDROCK',
  'ANTHROPIC_BEDROCK_BASE_URL',
  // AWS 認証情報そのもの (Bedrock 認証に使われる)
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_PROFILE',

  // Vertex (GCP) — 自分の GCP プロジェクトに課金される経路
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'CLOUD_ML_REGION',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_CLOUD_PROJECT',
  'GCLOUD_PROJECT',

  // Codex / OpenAI 系 — Codex CLI の従量課金経路
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_ORG_ID',

  // Gemini 系 — gemini CLI の API key 認証
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
] as const;

export type SpawnEnvSanitizerOptions = {
  /**
   * プロバイダ ID。'claude' | 'codex' | 'gemini'。
   * 主に provider-home の選択用。
   */
  providerId?: string;

  /**
   * provider-home の絶対パス。
   * 指定された場合のみ HOME / USERPROFILE を上書きする。
   * `<runtime data dir>/provider-homes/<providerId>` を想定。
   */
  providerHomeDir?: string;

  /**
   * 追加で env に乗せたい key-value。
   * 例: { ELECTRON_RUN_AS_NODE: '1', SALES_CLAW_CLI_TOKEN: '...' }
   */
  extraEnv?: Record<string, string | undefined>;

  /**
   * subscription credit に乗らせたい (= 課金リーク env を全消し) か。
   * 既定 true。テスト等で完全な passthrough が必要な場合のみ false。
   */
  sanitizeBillingLeak?: boolean;

  /**
   * provider-home 内に credentials.json が存在しない場合 (= subscription
   * 認証未セットアップ) は HOME を上書きしない。
   * Provider-home に credentials.json が無いまま HOME を切ると CLI は
   * 「未ログイン」状態になり API key にフォールバックする可能性があるため、
   * ユーザー HOME の `~/.claude/credentials.json` を残しておいた方が
   * 認証成功する確率が高い。既定 true。
   */
  skipHomeOverrideIfNoCredentials?: boolean;
};

export type SanitizedSpawnEnv = NodeJS.ProcessEnv & {
  __removedKeys?: string[];
  __homeOverridden?: boolean;
};

/**
 * spawn 用の env を作る。process.env は変更しない (immutable)。
 *
 * @returns env オブジェクト (spawn options.env にそのまま渡す)
 *          ただし __removedKeys / __homeOverridden は spawn 前に消すこと:
 *
 *            const { __removedKeys, __homeOverridden, ...spawnEnv } = sanitized;
 *            spawn(exe, args, { env: spawnEnv });
 */
export function buildSanitizedSpawnEnv(options: SpawnEnvSanitizerOptions = {}): SanitizedSpawnEnv {
  const {
    providerHomeDir,
    extraEnv = {},
    sanitizeBillingLeak = true,
    skipHomeOverrideIfNoCredentials = true,
  } = options;

  // 浅いコピーで十分 (子プロセスに渡る時点でディープコピーは不要)
  const next: NodeJS.ProcessEnv = { ...process.env };
  const removedKeys: string[] = [];

  if (sanitizeBillingLeak) {
    for (const key of BILLING_LEAK_ENV_KEYS) {
      if (next[key] !== undefined) {
        removedKeys.push(key);
        delete next[key];
      }
    }
  }

  let homeOverridden = false;
  if (providerHomeDir && typeof providerHomeDir === 'string' && providerHomeDir.length > 0) {
    const credentialsPath = path.join(providerHomeDir, '.claude', 'credentials.json');
    // 動的 require: fs を top-level で import すると CJS/ESM 混在環境で警告が出るため
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs');
    const hasCredentials = (() => {
      try { return fs.existsSync(credentialsPath); } catch { return false; }
    })();

    if (hasCredentials || !skipHomeOverrideIfNoCredentials) {
      next.HOME = providerHomeDir;
      next.USERPROFILE = providerHomeDir;
      // Windows: APPDATA / LOCALAPPDATA は触らない (個別アプリ設定の保存先で
      // CLI 認証とは無関係)
      homeOverridden = true;
    }
  }

  // extraEnv は最後に適用するが、サニタイズ対象キーが extraEnv 経由で
  // リーク復活しないようガードする (内部のうっかりミス防止)。
  // 意図的に escape したい場合は sanitizeBillingLeak: false を使う。
  const leakSet: Set<string> = sanitizeBillingLeak
    ? new Set<string>(BILLING_LEAK_ENV_KEYS as readonly string[])
    : new Set<string>();
  const restoredViaExtra: string[] = [];
  for (const [k, v] of Object.entries(extraEnv)) {
    if (v === undefined) continue;
    if (leakSet.has(k)) {
      // 警告: 課金リーク env を extraEnv 経由で復活させようとしている
      restoredViaExtra.push(k);
      try {
        process.stderr.write(`[spawn-env-sanitizer] WARN: extraEnv tried to restore billing-leak key "${k}". Ignored. Use sanitizeBillingLeak: false to opt out.\n`);
      } catch (_) { /* best-effort */ }
      continue;
    }
    next[k] = v;
  }

  // メタ情報 (caller が debug 用に使う)
  Object.defineProperty(next, '__removedKeys', {
    value: removedKeys,
    enumerable: false,
    configurable: true,
  });
  Object.defineProperty(next, '__homeOverridden', {
    value: homeOverridden,
    enumerable: false,
    configurable: true,
  });

  return next as SanitizedSpawnEnv;
}

/**
 * spawn options に渡す前にメタ情報を剥がす。
 * Object.defineProperty で non-enumerable にしてあるので spawn 自体には
 * 影響しないが、明示的に剥がす API を用意する。
 */
export function stripSanitizerMeta(env: SanitizedSpawnEnv): NodeJS.ProcessEnv {
  const { __removedKeys, __homeOverridden, ...rest } = env;
  return rest as NodeJS.ProcessEnv;
}

module.exports = {
  BILLING_LEAK_ENV_KEYS,
  buildSanitizedSpawnEnv,
  stripSanitizerMeta,
};

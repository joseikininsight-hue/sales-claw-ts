// Managed AI PTY のログ I/O
//
// dashboard-server から切り出した PTY ログファイル管理。
// ログはプロバイダごとに別ファイル、上限サイズを超えたら 1 段ローテート。
//
// ログ用途:
// - AI セッションの stdout/stderr 記録 (デバッグ)
// - 復旧時の直近出力参照
// - ユーザーに見せる「CLI Activity」タブの事後再生ソース

import * as path from 'path';
import { resolveDataPath, ensureDataDir } from '../data-paths';
import * as logWriter from '../log-writer';

// 移行中のため batch-utils / redact は @ts-nocheck 状態 (まだ ES module ではない)。
// require() で読み込んで明示的に型を付ける。
interface BatchUtilsShape {
  stripAnsiCodes: (s: string) => string;
  [key: string]: unknown;
}
interface RedactShape {
  redactSecrets: (s: string) => string;
  [key: string]: unknown;
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { stripAnsiCodes } = require('./batch-utils') as BatchUtilsShape;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { redactSecrets } = require('./redact') as RedactShape;

/** ログファイル上限: これを超えたら .1 にローテートして新規ファイルを開く */
export const DEFAULT_MAX_BYTES = 1024 * 1024; // 1 MiB

export type PtyLogKind = 'output' | 'input' | 'system';

export interface AppendPtyLogOptions {
  /** ローテート閾値 (default: 1 MiB) */
  maxBytes?: number;
  /** テスト専用。本番では指定しない */
  skipRedaction?: boolean;
}

/** プロバイダごとのログファイルパスを返す。 */
export function getManagedAiPtyLogFile(providerId: string | undefined | null): string {
  const safe = String(providerId ?? 'claude').replace(/[^a-zA-Z0-9_-]/g, '_');
  return resolveDataPath(path.join('ai-runs', `managed-${safe}-session.log`));
}

/**
 * PTY の出力/入力を 1 行ずつログに追記する。
 * ANSI 除去 + \r 削除 + 空行フィルタ + 機密文字列マスク。
 *
 * 機密文字列マスクは input/output/system すべての kind に適用する。
 * - output: CLI が API キーや OAuth トークンをエコーバックすることがある
 * - input: ユーザーが手で API キーを貼り付けるケースをカバー
 * - system: 内部メッセージで env 由来の値が含まれることがある
 *
 * H2 対応: 旧版は appendFileSync を main thread でブロッキング実行していた。
 * 本実装は log-writer の async キュー経由で fire-and-forget。
 */
export function appendManagedAiPtyLog(
  providerId: string,
  chunk: string | Buffer | null | undefined,
  kind: PtyLogKind = 'output',
  options: AppendPtyLogOptions = {}
): void {
  let text = stripAnsiCodes(String(chunk ?? '')).replace(/\r/g, '');
  if (!text.trim()) return;
  if (!options.skipRedaction) {
    text = redactSecrets(text);
  }

  const lines = text.split('\n').filter((line: any) => line.trim());
  if (lines.length === 0) return;

  const logFile = getManagedAiPtyLogFile(providerId);
  ensureDataDir();

  const maxBytes = Number(options.maxBytes) > 0 ? Number(options.maxBytes) : DEFAULT_MAX_BYTES;
  const stamp = new Date().toISOString();
  const payload = lines.map((line: any) => `[${stamp}] [${kind}] ${line}`).join('\n') + '\n';

  // 非ブロッキング: queue に積んで即時リターン。
  logWriter.appendLine(logFile, payload, { maxBytes });
}

module.exports = {
  DEFAULT_MAX_BYTES,
  getManagedAiPtyLogFile,
  appendManagedAiPtyLog,
};

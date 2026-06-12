// Recovery snapshot のディスク永続化
// サーバー / Electron 再起動で managed AI batch の残バッチを失わないようにするため、
// snapshotManagedAiBatchesForRecovery の出力を data/recovery/managed-ai-batches.json に書く。
//
// ファイルロックは使わず atomic rename のみで済ませる（呼び出し元で timing 制御する前提）。

import * as fs from 'fs';
import * as path from 'path';
import { resolveDataPath } from './data-paths';
import { atomicWriteJson } from './file-lock';

export interface RecoveryBatch {
  id: string;
  companies: Array<Record<string, unknown>>;
  options: Record<string, unknown>;
}

export interface RecoverySnapshot {
  providerId: string;
  autoSendSafe: boolean;
  mode: string;
  batches: RecoveryBatch[];
  savedAt: string;
}

function getRecoveryFilePath(): string {
  return resolveDataPath('recovery', 'managed-ai-batches.json');
}

function ensureDir(filePath: string): void {
  // mkdirSync({recursive:true}) は既存ディレクトリで no-op のため事前 existsSync は不要
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

/**
 * snapshot のスキーマを最低限バリデートする。
 * 破損や外部改ざんを想定し、既知の許容範囲のみ通す。
 */
function validateSnapshot(snapshot: unknown): RecoverySnapshot | null {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const s = snapshot as Record<string, unknown>;
  const providerId = typeof s.providerId === 'string' ? s.providerId : '';
  // providerId はファイルパス生成や外部プロセス呼び出しに使われる可能性があるため
  // 英数字・ハイフン・アンダースコアのみ許可
  if (providerId && !/^[a-zA-Z0-9_-]{1,64}$/.test(providerId)) return null;
  const rawBatches = Array.isArray(s.batches)
    ? s.batches.filter((b): b is Record<string, unknown> => !!b && typeof b === 'object')
    : [];
  const batches: RecoveryBatch[] = rawBatches.map((batch: any) => {
    const opts = batch.options && typeof batch.options === 'object'
      ? batch.options as Record<string, unknown>
      : {};
    return {
      id: typeof batch.id === 'string' ? batch.id : '',
      companies: Array.isArray(batch.companies)
        ? batch.companies.filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
        : [],
      // prototype 汚染を防ぐため Object.create(null) ベースで安全コピー
      options: Object.assign(Object.create(null) as Record<string, unknown>, opts),
    };
  }).filter((b: any) => b.companies.length > 0);

  return {
    providerId,
    autoSendSafe: Boolean(s.autoSendSafe),
    mode: typeof s.mode === 'string' ? s.mode : '',
    batches,
    savedAt: typeof s.savedAt === 'string' ? s.savedAt : '',
  };
}

/**
 * Recovery snapshot を atomic に書き込む（tmp → rename）。
 * 失敗時は例外を再スローする（呼び出し元で try/catch すること）。
 */
function saveRecoverySnapshot(snapshot: Partial<RecoverySnapshot> | null | undefined): void {
  if (!snapshot || typeof snapshot !== 'object') return;
  const filePath = getRecoveryFilePath();
  ensureDir(filePath);
  const payload = JSON.stringify({
    savedAt: new Date().toISOString(),
    ...snapshot,
  }, null, 2);
  // P0/QW4: 共通 atomicWriteJson (fsync + rename リトライ) に統一。
  //   旧ローカル実装の copyFileSync フォールバックは file-lock.ts が
  //   「torn write の元凶」として撤廃済み。クラッシュ復旧スナップショット
  //   そのものなので耐久性の効果が最も大きい。
  atomicWriteJson(filePath, payload);
}

/**
 * Recovery snapshot を読み込む。
 * ファイルが存在しない / 壊れている場合は null を返す。
 */
function loadRecoverySnapshot(): RecoverySnapshot | null {
  const filePath = getRecoveryFilePath();
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return validateSnapshot(parsed);
  } catch {
    return null;
  }
}

/** Recovery snapshot を削除する。存在しなければ no-op。 */
function clearRecoverySnapshot(): void {
  const filePath = getRecoveryFilePath();
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch { /* ignore */ }
}

module.exports = {
  getRecoveryFilePath,
  saveRecoverySnapshot,
  loadRecoverySnapshot,
  clearRecoverySnapshot,
};

export {
  getRecoveryFilePath,
  saveRecoverySnapshot,
  loadRecoverySnapshot,
  clearRecoverySnapshot,
};

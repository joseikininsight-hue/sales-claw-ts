// バッチ停滞検知ロジック (純関数)
// dashboard-server から切り出し、単体テスト可能にするためのモジュール
// 主目的: message_draft / site_analysis / form_fill のまま stall している企業を
//        自動 error 化するため、対象 companyNo を特定する

export type StallableAction = 'message_draft' | 'site_analysis' | 'form_fill';

/** 停滞中と判定するアクション名 */
export const STALL_CANDIDATE_ACTIONS = new Set<StallableAction>(['message_draft', 'site_analysis', 'form_fill']);

/** 人間向けのアクションラベル (formatStallReason 用) */
const ACTION_LABELS: Record<string, string> = {
  message_draft: 'メッセージ生成後',
  site_analysis: 'サイト分析後',
  form_fill: 'フォーム入力後',
};

export interface BatchStatus {
  companyNo: number | string;
  action?: string;
  latestAction?: string;
  monitorStatus?: string;
  terminal?: boolean;
  latestTimestamp?: string;
  updatedAt?: string;
  timestamp?: string;
}

export interface ActiveBatch {
  companyNos?: number[];
  companies?: Array<{ no: number; companyName?: string }>;
  lastProgressAt?: number;
}

export interface DetectStalledOptions {
  /** 停滞とみなす idle ms */
  stallMs: number;
  /** 現在時刻 (テスト用。既定: Date.now()) */
  now?: number;
}

function extractAction(status: BatchStatus | null | undefined): string {
  if (!status) return '';
  if (status.latestAction) return String(status.latestAction);
  if (status.action) return String(status.action);
  return '';
}

function extractTimestamp(status: BatchStatus | null | undefined): string | null {
  if (!status) return null;
  return status.latestTimestamp ?? status.updatedAt ?? status.timestamp ?? null;
}

/**
 * active batch の中で stall している企業の companyNo 配列を返す。
 */
export function detectStalledCompanies(
  activeBatch: ActiveBatch | null | undefined,
  statuses: BatchStatus[] | null | undefined,
  options: DetectStalledOptions
): number[] {
  if (!activeBatch || !Array.isArray(statuses)) return [];
  const stallMs = Number(options.stallMs) || 0;
  if (stallMs <= 0) return [];
  const now = Number.isFinite(options.now) ? (options.now as number) : Date.now();

  const stalled: number[] = [];
  for (const status of statuses) {
    if (!status) continue;
    if (status.terminal) continue;
    const action = extractAction(status);
    if (!STALL_CANDIDATE_ACTIONS.has(action as StallableAction)) continue;

    // 優先: status.latestTimestamp ベースでの idle 判定
    const tsRaw = extractTimestamp(status);
    if (tsRaw) {
      const tsMs = Date.parse(tsRaw);
      if (Number.isFinite(tsMs) && (now - tsMs) > stallMs) {
        stalled.push(Number(status.companyNo));
        continue;
      }
      // latestTimestamp が存在するなら、それが stall 未満ならスキップ
      if (Number.isFinite(tsMs)) continue;
    }

    // フォールバック: activeBatch.lastProgressAt を使った idle 判定
    const lastProgressAt = Number(activeBatch.lastProgressAt) || 0;
    if (lastProgressAt > 0 && (now - lastProgressAt) > stallMs) {
      stalled.push(Number(status.companyNo));
    }
  }
  return stalled;
}

/** error ログの理由文字列を生成する。 */
export function formatStallReason(action: string, idleMs: number): string {
  const label = ACTION_LABELS[action] ?? action ?? 'unknown';
  const idleSec = Math.max(0, Math.round(Number(idleMs) / 1000) || 0);
  return `フェーズB遷移タイムアウト: ${label} で ${idleSec}秒更新なし（自動タイムアウト）`;
}

module.exports = {
  STALL_CANDIDATE_ACTIONS,
  detectStalledCompanies,
  formatStallReason,
};

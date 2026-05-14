// Action log types
//
// `data/action-log.json` のレコード型。

export type ActionType =
  | 'site_analysis'
  | 'message_draft'
  | 'form_fill'
  | 'confirm_reached'
  | 'awaiting_approval'
  | 'submitted'
  | 'skipped'
  | 'error';

export interface ApprovalArtifactDetails {
  /** 実際にフォーム本文欄に入力した文字列そのもの */
  sentMessage: string;
  /** screenshots/ss-{No}-input.png のファイル名 */
  screenshot: string;
  /** タブを保持しているか (Workflow Step 7 contract) */
  tabKept?: boolean;
  /** 最終フォームタブの URL */
  finalFormTab?: string;
  /** 閉じたタブの数 */
  tabsClosed?: number;
  /** タブを残した理由 */
  tabReason?: string;
}

export type ActionDetails =
  | string
  | (Partial<ApprovalArtifactDetails> & Record<string, unknown>);

export interface ActionLogEntry {
  /** ターゲットリストの行番号 (No.) — 内部実装では companyNo として保持されている */
  companyNo: number | string;
  /** 会社名 — 内部実装では companyName として保持されている */
  companyName: string;
  /** アクション種別 */
  action: ActionType;
  /** 詳細 (object 形式が新しい、string は legacy) */
  details: ActionDetails;
  /** タイムスタンプ (ISO 8601) — 通常はサーバ側で自動付与 */
  timestamp?: string;
}

export type AnyActionLogEntry = ActionLogEntry & Record<string, unknown>;

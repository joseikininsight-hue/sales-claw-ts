// Target company types
//
// ターゲットリストの 1 行 (Excel/CSV)。

export interface TargetCompany {
  no: number;
  status: string;
  companyName: string;
  type: string;
  url: string;
  formUrl?: string;
  notes?: string;
  captcha?: string;
  progress?: string;
  /** Excel 列に存在する任意の追加カラム */
  [extra: string]: unknown;
}

/** 「営業対象外」と判定された企業 */
export interface SkippedTarget extends TargetCompany {
  skippedReason: string;
}

/** 連絡履歴の 1 件 */
export interface ContactHistoryEntry {
  no: number | string;
  name: string;
  status: 'awaiting_approval' | 'submitted' | 'skipped' | 'error';
  timestamp: string;
  sentMessage?: string;
  screenshot?: string;
  url?: string;
  formUrl?: string;
}

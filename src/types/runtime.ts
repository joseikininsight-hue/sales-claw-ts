// Runtime/IPC types

export type { DashboardRuntime, RuntimeRequestTarget } from '../dashboard-runtime';

export interface LiveMonitorEntry {
  ts: number;
  /** 進行状況のヒューマンリーダブルなテキスト */
  message: string;
  /** ログレベル: 'info' | 'action' | 'warn' | 'error' */
  level?: 'info' | 'action' | 'warn' | 'error';
  /** 関連する会社の No. */
  no?: number | string;
  /** 関連する会社名 */
  name?: string;
}

export interface DashboardSession {
  token: string;
  createdAt: string;
  pid?: number;
}

export interface UpdateStatus {
  appVersion: string;
  buildSource: 'installed' | 'development';
  autoUpdateEnabled: boolean;
  state:
    | 'disabled'
    | 'disabled-dev'
    | 'checking'
    | 'up-to-date'
    | 'available'
    | 'downloading'
    | 'downloaded'
    | 'error';
  version?: string;
  remoteVersion?: string | null;
  percent?: number;
  message?: string;
  checkReason?: string;
  lastCheckStartedAt?: number | null;
  lastCheckedAt?: number;
  ts: number;
}

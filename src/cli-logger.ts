// ダッシュボードのCLI Activityストリームにログを送信するヘルパー
import * as http from 'http';
import { getRequestTarget } from './dashboard-runtime';

export type LogType = 'debug' | 'info' | 'step' | 'action' | 'warn' | 'warning' | 'error' | 'thinking' | string;

function toLogRank(type: string | undefined | null): number {
  const key = String(type ?? 'info').toLowerCase();
  if (key === 'debug') return 10;
  if (key === 'info' || key === 'step' || key === 'action') return 20;
  if (key === 'warn' || key === 'warning') return 30;
  if (key === 'error') return 40;
  return 20;
}

interface SettingsManagerSubset {
  getHost: () => string;
  getPort: () => number;
  getSection: (key: string) => { logLevel?: string } | undefined;
}

let _lastDeliveryWarnAt = 0;

export function log(message: string, type?: LogType): void {
  const logType: string = type ?? 'info';

  let target = { hostname: '127.0.0.1', port: 3765 };
  let enabled = true;
  try {
    // 循環依存を避けるため遅延 require
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const settings = require('./settings-manager') as SettingsManagerSubset;
    target = getRequestTarget(settings.getHost(), settings.getPort());
    const configured = settings.getSection('preferences')?.logLevel ?? 'info';
    enabled = toLogRank(logType) >= toLogRank(configured);
  } catch {
    // settings 取得失敗時はデフォルト値で続行
  }

  if (!enabled) return;

  const payload = JSON.stringify({ message, type: logType });
  try {
    const req = http.request({
      hostname: target.hostname,
      port: target.port,
      path: '/api/cli-log',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'X-CLI-Token': process.env.SALES_CLAW_CLI_TOKEN ?? '',
      },
    });
    req.on('error', (err) => {
      // fire-and-forget は維持しつつ、送達失敗の完全無音はやめる (60秒に1回だけ警告)。
      // 典型原因: ダッシュボードのポート違い / サーバ停止 — 進捗がUIに出ない事故の早期発見用。
      const now = Date.now();
      if (now - _lastDeliveryWarnAt > 60_000) {
        _lastDeliveryWarnAt = now;
        console.warn(`[cli-logger] dashboard notify failed (${target.hostname}:${target.port}): ${err && err.message}`);
      }
    });
    req.write(payload);
    req.end();
  } catch {
    // HTTP 失敗は無視（ログの fire-and-forget）
  }
  console.log(`[${logType.toUpperCase()}] ${message}`);
}

export function thinking(message: string): void {
  log(message, 'thinking');
}

module.exports = { log, thinking };

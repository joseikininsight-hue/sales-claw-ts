// CDP (Chrome DevTools Protocol) bridge for Electron WebContentsView.
//
// Phase 1 skeleton (v2.1.0-pre): Electron main process 内で
// `webContents.debugger.attach('1.3')` をシングルトン管理し、
// internal MCP server から IPC 経由で送られてくる CDP コマンドを
// 各 session の webContents へディスパッチする。
//
// 設計: docs/architecture/in-app-form-fill.md §1.1, §2, §5.3 を参照。
//
// 注意:
//   - 各 WebContentsView は独立の webContents を持つので attach は 1:1
//   - OOPIF (cross-origin iframe) は Target.setAutoAttach({flatten:true}) で
//     自動 attach され、sessionId 付き message が来る
//   - DevTools (F12) と debugger.attach は排他。`?devtools=1` query で escape

import type { WebContents } from 'electron';

export interface CdpAttachOptions {
  protocolVersion?: string;
}

export interface CdpCommandOptions {
  /** OOPIF target の sessionId。未指定なら main frame */
  sessionId?: string;
  /** ms。デフォルト 15000 */
  timeoutMs?: number;
}

export type CdpEventListener = (
  method: string,
  params: Record<string, unknown>,
  sessionId?: string,
) => void;

interface AttachedEntry {
  webContents: WebContents;
  oopifSessions: Map<string, string>; // targetId -> sessionId
  isolatedContextIds: Map<number, number>; // frameId -> executionContextId
  listeners: Set<CdpEventListener>;
}

const _attached = new Map<number, AttachedEntry>();

/**
 * 指定 webContents に CDP debugger を attach する。冪等 (既に attach 済なら何もしない)。
 * attach 完了後、OOPIF auto-attach も有効化する。
 *
 * @throws CDP attach に失敗した場合 (DevTools が開いている等)
 */
export async function attach(
  webContents: WebContents,
  options: CdpAttachOptions = {},
): Promise<void> {
  if (_attached.has(webContents.id)) return;
  const protocol = options.protocolVersion || '1.3';
  webContents.debugger.attach(protocol);
  const entry: AttachedEntry = {
    webContents,
    oopifSessions: new Map(),
    isolatedContextIds: new Map(),
    listeners: new Set(),
  };
  _attached.set(webContents.id, entry);

  webContents.debugger.on('message', (_event, method, params, sessionId) => {
    // OOPIF auto-attach handling
    if (method === 'Target.attachedToTarget') {
      const p = params as { targetInfo?: { targetId?: string }; sessionId?: string };
      if (p.targetInfo?.targetId && p.sessionId) {
        entry.oopifSessions.set(p.targetInfo.targetId, p.sessionId);
      }
    } else if (method === 'Target.detachedFromTarget') {
      const p = params as { targetId?: string };
      if (p.targetId) entry.oopifSessions.delete(p.targetId);
    } else if (method === 'Page.frameNavigated') {
      // navigation で isolated world は失効。次回 createIsolatedWorld でラズリ生成
      const p = params as { frame?: { id?: string } };
      if (p.frame?.id) {
        entry.isolatedContextIds.delete(hashFrameId(p.frame.id));
      }
    }
    for (const listener of entry.listeners) {
      try { listener(method, (params as Record<string, unknown>) || {}, sessionId); }
      catch (_) { /* listener errors are swallowed to prevent cascade */ }
    }
  });

  // OOPIF auto-attach 有効化 (flat mode)
  await sendCommandRaw(webContents, 'Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true,
  });
  // Page / Runtime / DOM / Accessibility は基本 enable
  await sendCommandRaw(webContents, 'Page.enable', {});
  await sendCommandRaw(webContents, 'Runtime.enable', {});
  await sendCommandRaw(webContents, 'DOM.enable', {});
}

/**
 * 指定 webContents から CDP debugger を detach する (既に detach 済でも no-op)。
 */
export function detach(webContents: WebContents): void {
  if (!_attached.has(webContents.id)) return;
  try { webContents.debugger.detach(); } catch (_) { /* already detached */ }
  _attached.delete(webContents.id);
}

/**
 * CDP コマンドを送信する。`options.sessionId` 指定で OOPIF target に送信。
 */
export async function sendCommand<TResult = unknown>(
  webContents: WebContents,
  method: string,
  params: Record<string, unknown> = {},
  options: CdpCommandOptions = {},
): Promise<TResult> {
  if (!_attached.has(webContents.id)) {
    throw new Error(`CDP not attached for webContents ${webContents.id}`);
  }
  return sendCommandRaw<TResult>(webContents, method, params, options);
}

async function sendCommandRaw<T = unknown>(
  webContents: WebContents,
  method: string,
  params: Record<string, unknown>,
  options: CdpCommandOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 15000;
  // Electron debugger.sendCommand の sessionId 引数は flat mode の OOPIF 用。
  // 未指定 = main session。
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`)), timeoutMs);
    const cb = (err: Error | null, result?: unknown) => {
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(result as T);
    };
    if (options.sessionId) {
      // 4 引数 signature: sendCommand(method, params, sessionId, callback)
      (webContents.debugger.sendCommand as unknown as (
        m: string, p: Record<string, unknown>, s: string,
      ) => Promise<unknown>)(method, params, options.sessionId)
        .then((r) => cb(null, r))
        .catch((e) => cb(e instanceof Error ? e : new Error(String(e))));
    } else {
      webContents.debugger.sendCommand(method, params)
        .then((r) => cb(null, r))
        .catch((e) => cb(e instanceof Error ? e : new Error(String(e))));
    }
  });
}

/**
 * isolated world (Page.createIsolatedWorld) を frame 単位で確保する。
 * frameNavigated で invalidate されるので、必要に応じて再生成。
 *
 * @returns executionContextId (Runtime.evaluate の contextId で使用)
 */
export async function ensureIsolatedWorld(
  webContents: WebContents,
  frameId: string,
  worldName = 'sales-claw',
): Promise<number> {
  const entry = _attached.get(webContents.id);
  if (!entry) throw new Error(`CDP not attached for webContents ${webContents.id}`);
  const key = hashFrameId(frameId);
  const cached = entry.isolatedContextIds.get(key);
  if (cached) return cached;
  const result = await sendCommandRaw<{ executionContextId: number }>(
    webContents,
    'Page.createIsolatedWorld',
    { frameId, worldName, grantUniveralAccess: false },
  );
  entry.isolatedContextIds.set(key, result.executionContextId);
  return result.executionContextId;
}

/**
 * CDP イベント listener を登録する。返り値で unsubscribe 可能。
 */
export function addEventListener(
  webContents: WebContents,
  listener: CdpEventListener,
): () => void {
  const entry = _attached.get(webContents.id);
  if (!entry) throw new Error(`CDP not attached for webContents ${webContents.id}`);
  entry.listeners.add(listener);
  return () => entry.listeners.delete(listener);
}

/** Phase 2 で本格実装。skeleton では衝突しない hash で十分 */
function hashFrameId(frameId: string): number {
  let h = 0;
  for (let i = 0; i < frameId.length; i++) {
    h = ((h << 5) - h) + frameId.charCodeAt(i);
    h |= 0;
  }
  return h;
}

export default {
  attach,
  detach,
  sendCommand,
  ensureIsolatedWorld,
  addEventListener,
};

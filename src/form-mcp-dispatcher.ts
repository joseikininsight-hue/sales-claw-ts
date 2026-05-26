// Electron-main side dispatcher that bridges IPC ops from the internal
// sales-claw-form MCP server to FormSessionManager / CdpBridge.
//
// 設計: docs/architecture/in-app-form-fill.md §3 (IPC) + §2 (tools)
//
// Phase 2 implementation status:
//   ✅ navigate / snapshot / screenshot / fill_form / tabs / evaluate /
//      wait_for / press_key / file_upload
//   ⚠️ click / type / select_option: Runtime.evaluate ベースの簡易実装
//      (CDP Input.dispatchMouseEvent は Phase 3 で座標計算込み完全化)
//   ⏸️ handle_dialog / drag / hover: stub のみ (Phase 3 で完全化)

import path from 'path';
import fs from 'fs';
import * as cdp from './cdp-bridge';
import type { IpcRequest, IpcServer, IpcHandler } from './ipc-server';

interface FormSessionManagerLike {
  createSession(formUrl: string, companyNo: number | string): Promise<string>;
  getFormStructure(sessionId: string): Promise<unknown>;
  fillForm(sessionId: string, mappings: Array<{ selector: string; value: string; type?: string }>): Promise<unknown>;
  captureScreenshot(sessionId: string, savePath: string): Promise<string>;
  destroySession(sessionId: string): void;
  _sessions: Map<string, {
    id: string;
    view: { webContents: import('electron').WebContents };
    formUrl: string;
    companyNo: string;
    status: string;
    screenshotPath: string | null;
  }>;
  _activeSessionId: string | null;
  _setActiveSession?(sessionId: string | null): void;
}

interface DispatcherContext {
  formSessionManager: FormSessionManagerLike;
  /**
   * screenshots ディレクトリ取得関数。settings.getScreenshotDir() と必ず
   * 同じ値を返すように電源側で wire すること。FormSessionManager.captureScreenshot
   * 内の SSRF / path traversal guard と一致させる必要がある。
   */
  getScreenshotDir: () => string;
}

interface NavigateParams { url: string; sessionId?: string; waitUntil?: string; companyNo?: number }
interface SnapshotParams { sessionId: string; mode?: string }
interface ScreenshotParams { sessionId: string; suffix: string; fullPage?: boolean }
interface FillFormParams { sessionId: string; mappings: Array<{ selector: string; value: string; type?: string }> }
interface ClickParams { sessionId: string; selector: string; button?: string; clickCount?: number }
interface TypeParams { sessionId: string; selector: string; text: string; delay?: number }
interface SelectOptionParams { sessionId: string; selector: string; values: string[] }
interface TabsParams { action: string; sessionId?: string; url?: string; companyNo?: number }
interface EvaluateParams { sessionId: string; expression: string; awaitPromise?: boolean }
interface WaitForParams { sessionId: string; selector?: string; text?: string; timeout: number }
interface PressKeyParams { sessionId: string; key: string; modifiers?: string[] }
interface FileUploadParams { sessionId: string; selector: string; paths: string[] }

function getSession(ctx: DispatcherContext, sessionId: string) {
  const s = ctx.formSessionManager._sessions.get(sessionId);
  if (!s) throw new Error(`Session not found: ${sessionId}`);
  return s;
}

async function ensureAttached(ctx: DispatcherContext, sessionId: string) {
  const session = getSession(ctx, sessionId);
  await cdp.attach(session.view.webContents);
  return session;
}

/**
 * すべての IPC op を `ipcServer.on(op, handler)` に登録する。
 */
export function registerHandlers(ipcServer: IpcServer, ctx: DispatcherContext): void {
  const register = (op: string, fn: IpcHandler) => ipcServer.on(op, fn);

  register('navigate', async (req: IpcRequest) => {
    const p = req.params as unknown as NavigateParams;
    let sessionId: string;
    if (p.sessionId && ctx.formSessionManager._sessions.has(p.sessionId)) {
      // 既存セッションを navigate
      const s = ctx.formSessionManager._sessions.get(p.sessionId)!;
      await s.view.webContents.loadURL(p.url);
      sessionId = p.sessionId;
    } else {
      // 新規セッション。companyNo 未指定なら 0 (warning ログを出して呼び出し側に注意喚起)。
      const companyNo = p.companyNo ?? 0;
      if (companyNo === 0) {
        // eslint-disable-next-line no-console
        console.warn('[form-mcp-dispatcher] browser_navigate called without companyNo; screenshots will be ss-0-*.png');
      }
      sessionId = await ctx.formSessionManager.createSession(p.url, companyNo);
    }
    const session = ctx.formSessionManager._sessions.get(sessionId)!;
    return {
      sessionId,
      url: session.view.webContents.getURL(),
      status: session.status,
      title: session.view.webContents.getTitle(),
    };
  });

  register('snapshot', async (req: IpcRequest) => {
    const p = req.params as unknown as SnapshotParams;
    const structure = await ctx.formSessionManager.getFormStructure(p.sessionId);
    // Phase 2: getFormStructure の出力 (fields + meta) を返す。
    // Phase 3 で Accessibility.getFullAXTree も追加して a11y mode を実装。
    return {
      mode: p.mode || 'dom-lite',
      ...(structure as Record<string, unknown>),
    };
  });

  register('screenshot', async (req: IpcRequest) => {
    const p = req.params as unknown as ScreenshotParams;
    const session = getSession(ctx, p.sessionId);
    const screenshotDir = ctx.getScreenshotDir();
    const savePath = path.join(screenshotDir, `ss-${session.companyNo}-${p.suffix}.png`);
    if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir, { recursive: true });
    const finalPath = await ctx.formSessionManager.captureScreenshot(p.sessionId, savePath);
    return { path: finalPath };
  });

  register('fill_form', async (req: IpcRequest) => {
    const p = req.params as unknown as FillFormParams;
    const results = await ctx.formSessionManager.fillForm(p.sessionId, p.mappings);
    return { results };
  });

  register('click', async (req: IpcRequest) => {
    const p = req.params as unknown as ClickParams;
    const session = getSession(ctx, p.sessionId);
    // Phase 2 簡易実装: Runtime.evaluate ベース。Phase 3 で CDP dispatchMouseEvent + getBoxModel に移行。
    const script = `(function(){
      const el=document.querySelector(${JSON.stringify(p.selector)});
      if(!el)return{ok:false,reason:'not_found'};
      el.click();
      return{ok:true};
    })()`;
    const result = await session.view.webContents.executeJavaScript(script);
    return result;
  });

  register('type', async (req: IpcRequest) => {
    const p = req.params as unknown as TypeParams;
    const session = getSession(ctx, p.sessionId);
    // Phase 2 簡易実装: focus + value setter (fillForm と同じ系統)。
    // Phase 3 で Input.dispatchKeyEvent 1 文字ずつに置換。
    const script = `(function(){
      const el=document.querySelector(${JSON.stringify(p.selector)});
      if(!el)return{ok:false,reason:'not_found'};
      el.focus();
      const tag=el.tagName;
      const proto=tag==='TEXTAREA'?window.HTMLTextAreaElement.prototype:window.HTMLInputElement.prototype;
      const setter=Object.getOwnPropertyDescriptor(proto,'value')?.set;
      const text=${JSON.stringify(p.text)};
      if(setter)setter.call(el,(el.value||'')+text);
      else el.value=(el.value||'')+text;
      el.dispatchEvent(new Event('input',{bubbles:true}));
      el.dispatchEvent(new Event('change',{bubbles:true}));
      return{ok:true};
    })()`;
    const result = await session.view.webContents.executeJavaScript(script);
    return result;
  });

  register('select_option', async (req: IpcRequest) => {
    const p = req.params as unknown as SelectOptionParams;
    const session = getSession(ctx, p.sessionId);
    const script = `(function(){
      const el=document.querySelector(${JSON.stringify(p.selector)});
      if(!el)return{ok:false,reason:'not_found'};
      const values=${JSON.stringify(p.values)};
      const selected=[];
      for(const opt of el.options){
        const match=values.includes(opt.value)||values.includes(opt.label);
        opt.selected=match;
        if(match)selected.push(opt.value);
      }
      el.dispatchEvent(new Event('change',{bubbles:true}));
      return{ok:true,selected};
    })()`;
    const result = await session.view.webContents.executeJavaScript(script);
    return result;
  });

  register('tabs', async (req: IpcRequest) => {
    const p = req.params as unknown as TabsParams;
    if (p.action === 'list') {
      const tabs: Array<Record<string, unknown>> = [];
      for (const [id, s] of ctx.formSessionManager._sessions) {
        tabs.push({
          id,
          companyNo: s.companyNo,
          url: s.view.webContents.getURL(),
          title: s.view.webContents.getTitle(),
          status: s.status,
          active: ctx.formSessionManager._activeSessionId === id,
        });
      }
      return { tabs };
    }
    if (p.action === 'new') {
      const sessionId = await ctx.formSessionManager.createSession(p.url!, p.companyNo!);
      return { sessionId };
    }
    if (p.action === 'close') {
      ctx.formSessionManager.destroySession(p.sessionId!);
      return { ok: true };
    }
    if (p.action === 'select') {
      if (ctx.formSessionManager._setActiveSession) {
        ctx.formSessionManager._setActiveSession(p.sessionId!);
      }
      return { ok: true };
    }
    throw new Error(`unknown tabs action: ${p.action}`);
  });

  register('evaluate', async (req: IpcRequest) => {
    const p = req.params as unknown as EvaluateParams;
    const session = await ensureAttached(ctx, p.sessionId);
    // Phase 2: isolated world は省略し、executeJavaScript で実行。
    // (security validation は MCP server 側 tool で済んでいる)
    //
    // 注: Electron WebContents.executeJavaScript の第2引数は userGesture (boolean)
    //   で、awaitPromise ではない。awaitPromise=true は expression を
    //   `Promise.resolve().then(()=>(<expr>))` でラップして実現する。
    const wrapped = p.awaitPromise
      ? `Promise.resolve().then(function(){ return (${p.expression}); })`
      : p.expression;
    const result = await session.view.webContents.executeJavaScript(wrapped, /* userGesture */ false);
    return { result, type: typeof result };
  });

  register('wait_for', async (req: IpcRequest) => {
    const p = req.params as unknown as WaitForParams;
    const session = getSession(ctx, p.sessionId);
    const start = Date.now();
    const intervalMs = 200;
    while (Date.now() - start < p.timeout) {
      try {
        const script = p.selector
          ? `!!document.querySelector(${JSON.stringify(p.selector)})`
          : `(document.body && document.body.innerText && document.body.innerText.includes(${JSON.stringify(p.text || '')}))`;
        const found = await session.view.webContents.executeJavaScript(script);
        if (found) return { ok: true, foundAt: Date.now() - start };
      } catch (_) { /* keep polling */ }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    return { ok: false, timeout: p.timeout };
  });

  register('press_key', async (req: IpcRequest) => {
    const p = req.params as unknown as PressKeyParams;
    const session = await ensureAttached(ctx, p.sessionId);
    const modifiers = p.modifiers || [];
    // CDP key modifier mask: Alt=1, Ctrl=2, Meta=4, Shift=8
    let modMask = 0;
    if (modifiers.includes('Alt')) modMask |= 1;
    if (modifiers.includes('Control')) modMask |= 2;
    if (modifiers.includes('Meta')) modMask |= 4;
    if (modifiers.includes('Shift')) modMask |= 8;
    await cdp.sendCommand(session.view.webContents, 'Input.dispatchKeyEvent', {
      type: 'rawKeyDown', modifiers: modMask, key: p.key,
    });
    await cdp.sendCommand(session.view.webContents, 'Input.dispatchKeyEvent', {
      type: 'keyUp', modifiers: modMask, key: p.key,
    });
    return { ok: true };
  });

  register('file_upload', async (req: IpcRequest) => {
    const p = req.params as unknown as FileUploadParams;
    const session = await ensureAttached(ctx, p.sessionId);
    // DOM.querySelector → nodeId 取得 → DOM.setFileInputFiles
    const doc = await cdp.sendCommand<{ root: { nodeId: number } }>(
      session.view.webContents, 'DOM.getDocument', {},
    );
    const queryResult = await cdp.sendCommand<{ nodeId: number }>(
      session.view.webContents, 'DOM.querySelector',
      { nodeId: doc.root.nodeId, selector: p.selector },
    );
    if (!queryResult.nodeId) throw new Error(`selector not found: ${p.selector}`);
    await cdp.sendCommand(session.view.webContents, 'DOM.setFileInputFiles', {
      nodeId: queryResult.nodeId, files: p.paths,
    });
    return { ok: true };
  });

  // Phase 3 で完全化する stub 群
  register('handle_dialog', async () => {
    throw new Error('handle_dialog is not implemented in Phase 2 (TODO Phase 3)');
  });
  register('drag', async () => {
    throw new Error('drag is not implemented in Phase 2 (TODO Phase 3)');
  });
  register('hover', async () => {
    throw new Error('hover is not implemented in Phase 2 (TODO Phase 3)');
  });
}

export default { registerHandlers };

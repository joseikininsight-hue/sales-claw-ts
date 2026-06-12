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

// 貫通要素解決 (light DOM → open shadow DOM → 同一オリジン iframe) は
//   src/injected/pierce-resolve.ts に集約。click / type / select_option /
//   fillForm の全経路で同一ソースを注入し、shadow/iframe 内の送信ボタンが
//   押せない非対称 (confirm_reached 未到達 stall) を防ぐ。
import { PIERCE_RESOLVE_FN_SRC as PIERCE_RESOLVE_SRC } from './injected/pierce-resolve';

interface FormSessionManagerLike {
  createSession(formUrl: string, companyNo: number | string): Promise<string>;
  _waitForLoad(sessionId: string, timeout?: number): Promise<void>;
  getFormStructure(sessionId: string): Promise<unknown>;
  fillForm(sessionId: string, mappings: Array<{ selector: string; value: string; type?: string }>): Promise<unknown>;
  getValidationSummary?(sessionId: string): Promise<unknown>;
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
      s.status = 'loading';
      // loadURL は redirect 等で ERR_ABORTED reject することがあるが、その場合でも
      // ページは進行し得るので reject は握りつぶし dom-ready 待ちに委ねる。
      s.view.webContents.loadURL(p.url).catch(() => {});
      // loadURL は commit で resolve するため DOM 未構築のまま返る。
      // createSession と同様に dom-ready を待ってから返し、直後の snapshot が
      // 未ロードページに当たって空フィールド→再 snapshot する無駄を防ぐ。
      await ctx.formSessionManager._waitForLoad(p.sessionId, 15000);
      sessionId = p.sessionId;
    } else {
      // 新規セッション。companyNo 未指定なら 0 (warning ログを出して呼び出し側に注意喚起)。
      const companyNo = p.companyNo ?? 0;
      if (companyNo === 0) {
        // eslint-disable-next-line no-console
        console.warn('[form-mcp-dispatcher] browser_navigate called without companyNo; screenshots will be ss-0-*.png');
      }
      sessionId = await ctx.formSessionManager.createSession(p.url, companyNo);
      // v2.0.82: 作成完了後に dock を呼ぶ (failure は warn のみ、navigate result は OK 返す)
      try {
        if (typeof (ctx.formSessionManager as unknown as { showSession?: (id: string) => void }).showSession === 'function') {
          (ctx.formSessionManager as unknown as { showSession: (id: string) => void }).showSession(sessionId);
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[form-mcp-dispatcher] showSession after createSession failed:', (e as Error).message);
      }
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
    // v2.0.97: CAPTCHA を検出したらセッションに記録する。これにより
    //   (1) UI が「要対応」バナー/バッジを出せる、(2) 完了セッション自動破棄や
    //   MAX_SESSIONS 退避から温存される (人間がライブブラウザで解くため)。
    try {
      const meta = (structure as { meta?: { hasCaptcha?: boolean; captchaInteractive?: boolean; captchaKind?: string } })?.meta;
      const sess = ctx.formSessionManager._sessions.get(p.sessionId);
      if (sess && meta) {
        // v2.0.98: 「要対応」フラグは interactive CAPTCHA のみ。不可視型 (v3 等) は
        //   人手不要なので立てない (操作中タブで誤って要対応バナーを出さない)。
        (sess as Record<string, unknown>).captchaDetected = !!meta.captchaInteractive;
        // v2.1.0: どの CAPTCHA 型をどう扱ったか (interactive/invisible/none) を保持し、
        //   UI チップ/監査ログで「v3=自動送信した」等を追跡できるようにする (可視性向上)。
        (sess as Record<string, unknown>).captchaKind = meta.captchaKind || 'none';
      }
    } catch { /* best-effort */ }
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

    // v2.0.84: webContents.capturePage() は WebContentsView が visible でないと
    //   0-byte PNG を返す。internal mode で view が dock されていない (headless)
    //   と全 screenshot が 0-byte になる (実機 No.455 で確認)。
    //   CDP Page.captureScreenshot は visibility 不問で確実に PNG を取得できる。
    //   失敗時のみ legacy capturePage() に fallback。
    let pngBytes: Buffer | null = null;
    try {
      await cdp.attach(session.view.webContents);
      const result = await cdp.sendCommand<{ data: string }>(
        session.view.webContents,
        'Page.captureScreenshot',
        { format: 'png', captureBeyondViewport: p.fullPage === true, optimizeForSpeed: true },
      );
      if (result && result.data) {
        pngBytes = Buffer.from(result.data, 'base64');
      }
    } catch (cdpErr) {
      // eslint-disable-next-line no-console
      console.warn('[form-mcp-dispatcher] CDP screenshot failed, falling back to capturePage:', (cdpErr as Error).message);
    }

    if (pngBytes && pngBytes.length > 100) {
      fs.writeFileSync(savePath, pngBytes);
      return { path: savePath, source: 'cdp', size: pngBytes.length };
    }

    // Fallback: 既存 captureScreenshot (visibility 依存)
    const finalPath = await ctx.formSessionManager.captureScreenshot(p.sessionId, savePath);
    const fallbackSize = (() => {
      try { return fs.statSync(finalPath).size; } catch { return 0; }
    })();
    return { path: finalPath, source: 'capturePage', size: fallbackSize };
  });

  register('fill_form', async (req: IpcRequest) => {
    const p = req.params as unknown as FillFormParams;
    const results = await ctx.formSessionManager.fillForm(p.sessionId, p.mappings);
    // ★ v2.1.4: 入力直後にフォーム全体の必須未充足/制約違反を検証して同梱する。
    //   AI は validation.problems が空であることを確認してから送信ボタンを押せる
    //   (送信 → サイト側「必須項目を入力してください」→ 分析 → 再入力の往復を根絶)。
    let validation: unknown = null;
    try {
      if (typeof ctx.formSessionManager.getValidationSummary === 'function') {
        validation = await ctx.formSessionManager.getValidationSummary(p.sessionId);
      }
    } catch { /* 検証はベストエフォート */ }
    return { results, validation };
  });

  register('click', async (req: IpcRequest) => {
    const p = req.params as unknown as ClickParams;
    const session = await ensureAttached(ctx, p.sessionId);
    // Phase 3: CDP Input.dispatchMouseEvent ベース。`isTrusted:true` で発火
    //   されるため reCAPTCHA v2 checkbox 等が「ロボット判定」しにくい。
    //   Bug fallback: 要素が viewport 外 / hidden の場合は scrollIntoView する
    //   ために Runtime.evaluate で座標取得 + scrollIntoView 1 回試行。
    const coordsResult = await session.view.webContents.executeJavaScript(`(function(){
      var resolve=${PIERCE_RESOLVE_SRC};
      var el=resolve(${JSON.stringify(p.selector)});
      if(!el)return null;
      el.scrollIntoView({block:'center',inline:'center'});
      var r=el.getBoundingClientRect();
      var x=r.left + r.width/2, y=r.top + r.height/2;
      // v2.1.0 回帰修正: pierce リゾルバが同一オリジン iframe 内の要素を解決した場合、
      //   getBoundingClientRect() は iframe ローカル座標を返す。CDP Input.dispatchMouseEvent
      //   はトップレベル viewport 座標で発火するため、親方向へ各 iframe のオフセット
      //   (位置 + border 幅) を累積加算してグローバル座標に補正する。これを怠ると iframe
      //   内の送信/確認ボタンを誤った位置でクリックしてしまう。
      //   (クロスオリジン iframe は resolve 時点で contentDocument に到達できず対象外)
      try {
        var win=(el.ownerDocument&&el.ownerDocument.defaultView)||null;
        while(win&&win!==win.top&&win.frameElement){
          var fe=win.frameElement;
          var fr=fe.getBoundingClientRect();
          x+=fr.left+(fe.clientLeft||0);
          y+=fr.top+(fe.clientTop||0);
          win=win.parent;
        }
      }catch(_){}
      return { x: x, y: y, w: r.width, h: r.height };
    })()`);
    if (!coordsResult) return { ok: false, reason: 'not_found' };
    if (coordsResult.w === 0 || coordsResult.h === 0) {
      return { ok: false, reason: 'zero_size' };
    }
    const button = p.button === 'right' ? 'right' : p.button === 'middle' ? 'middle' : 'left';
    const clickCount = p.clickCount || 1;
    // CDP Input.dispatchMouseEvent: mousePressed → mouseReleased を clickCount 回
    for (let i = 0; i < clickCount; i++) {
      await cdp.sendCommand(session.view.webContents, 'Input.dispatchMouseEvent', {
        type: 'mousePressed', x: coordsResult.x, y: coordsResult.y,
        button, clickCount: i + 1,
      });
      await cdp.sendCommand(session.view.webContents, 'Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: coordsResult.x, y: coordsResult.y,
        button, clickCount: i + 1,
      });
    }
    return { ok: true, x: coordsResult.x, y: coordsResult.y };
  });

  register('type', async (req: IpcRequest) => {
    const p = req.params as unknown as TypeParams;
    const session = getSession(ctx, p.sessionId);
    // Phase 2 簡易実装: focus + value setter (fillForm と同じ系統)。
    // Phase 3 で Input.dispatchKeyEvent 1 文字ずつに置換。
    const script = `(function(){
      var resolve=${PIERCE_RESOLVE_SRC};
      var el=resolve(${JSON.stringify(p.selector)});
      if(!el)return{ok:false,reason:'not_found'};
      var view=(el.ownerDocument&&el.ownerDocument.defaultView)||window;
      el.focus();
      var tag=el.tagName;
      var proto=tag==='TEXTAREA'?view.HTMLTextAreaElement.prototype:view.HTMLInputElement.prototype;
      var desc=Object.getOwnPropertyDescriptor(proto,'value');
      var setter=desc&&desc.set;
      var text=${JSON.stringify(p.text)};
      if(setter)setter.call(el,(el.value||'')+text);
      else el.value=(el.value||'')+text;
      el.dispatchEvent(new view.Event('input',{bubbles:true}));
      el.dispatchEvent(new view.Event('change',{bubbles:true}));
      return{ok:true};
    })()`;
    const result = await session.view.webContents.executeJavaScript(script);
    return result;
  });

  register('select_option', async (req: IpcRequest) => {
    const p = req.params as unknown as SelectOptionParams;
    const session = getSession(ctx, p.sessionId);
    const script = `(function(){
      var resolve=${PIERCE_RESOLVE_SRC};
      var el=resolve(${JSON.stringify(p.selector)});
      if(!el)return{ok:false,reason:'not_found'};
      var view=(el.ownerDocument&&el.ownerDocument.defaultView)||window;
      var values=${JSON.stringify(p.values)};
      var selected=[];
      for(var oi=0;oi<el.options.length;oi++){
        var opt=el.options[oi];
        var match=values.indexOf(opt.value)>=0||values.indexOf(opt.label)>=0;
        opt.selected=match;
        if(match)selected.push(opt.value);
      }
      el.dispatchEvent(new view.Event('change',{bubbles:true}));
      return{ok:true,selected:selected};
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

  // Phase 3 完全実装

  register('handle_dialog', async (req: IpcRequest) => {
    const p = req.params as { sessionId: string; accept: boolean; promptText?: string };
    const session = await ensureAttached(ctx, p.sessionId);
    // CDP Page.handleJavaScriptDialog
    await cdp.sendCommand(session.view.webContents, 'Page.handleJavaScriptDialog', {
      accept: p.accept,
      promptText: p.promptText || '',
    });
    return { ok: true };
  });

  register('drag', async (req: IpcRequest) => {
    const p = req.params as { sessionId: string; sourceSelector: string; targetSelector: string };
    const session = await ensureAttached(ctx, p.sessionId);
    const coords = await session.view.webContents.executeJavaScript(`(function(){
      var src=document.querySelector(${JSON.stringify(p.sourceSelector)});
      var dst=document.querySelector(${JSON.stringify(p.targetSelector)});
      if(!src||!dst)return null;
      var sr=src.getBoundingClientRect();
      var dr=dst.getBoundingClientRect();
      return {
        sx: sr.left+sr.width/2, sy: sr.top+sr.height/2,
        dx: dr.left+dr.width/2, dy: dr.top+dr.height/2,
      };
    })()`);
    if (!coords) return { ok: false, reason: 'selector_not_found' };
    const wc = session.view.webContents;
    await cdp.sendCommand(wc, 'Input.dispatchMouseEvent', {
      type: 'mousePressed', x: coords.sx, y: coords.sy, button: 'left', clickCount: 1,
    });
    // Smoothing: 5 中間ステップで move
    const STEPS = 5;
    for (let i = 1; i <= STEPS; i++) {
      const x = coords.sx + (coords.dx - coords.sx) * (i / STEPS);
      const y = coords.sy + (coords.dy - coords.sy) * (i / STEPS);
      await cdp.sendCommand(wc, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left' });
    }
    await cdp.sendCommand(wc, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: coords.dx, y: coords.dy, button: 'left', clickCount: 1,
    });
    return { ok: true };
  });

  register('hover', async (req: IpcRequest) => {
    const p = req.params as { sessionId: string; selector: string };
    const session = await ensureAttached(ctx, p.sessionId);
    const coords = await session.view.webContents.executeJavaScript(`(function(){
      var el=document.querySelector(${JSON.stringify(p.selector)});
      if(!el)return null;
      var r=el.getBoundingClientRect();
      return { x: r.left+r.width/2, y: r.top+r.height/2 };
    })()`);
    if (!coords) return { ok: false, reason: 'not_found' };
    await cdp.sendCommand(session.view.webContents, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: coords.x, y: coords.y,
    });
    return { ok: true };
  });
}

export default { registerHandlers };

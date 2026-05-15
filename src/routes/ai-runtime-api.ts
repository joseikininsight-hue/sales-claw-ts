'use strict';

/**
 * AI Runtime API Routes
 *
 * dashboard-server.cjs から切り出された AI runtime 系 API ハンドラ群。
 * Phase 2 リファクタリングの一環として、モノリス化した dashboard-server.cjs から
 * AI (Claude/他) の CLI インストール・PTY 起動/停止・入力送信に関わる
 * ルーター関数を集約する。
 *
 * 対応エンドポイント:
 *  - POST /api/install-claude-cli     (legacy 名) / POST /api/install-ai-cli
 *  - POST /api/launch-claude          (legacy 名) / POST /api/launch-ai
 *  - POST /api/launch-claude-external (legacy 名) / POST /api/launch-ai-external
 *  - POST /api/stop-claude            (legacy 名) / POST /api/stop-ai
 *  - POST /api/claude-input           (legacy 名) / POST /api/ai-input
 *
 * 既存の dashboard-server.cjs のロジックは変更せずそのまま移植している。
 * claudePty / claudeProcess のような state は依然として dashboard-server.cjs に
 * 存在するため、getter / setter 関数で ctx 経由で参照する。
 */

const {
  getInstallCommand,
} = require('../ai-providers');

/**
 * AI Runtime API ルーターを生成する factory。
 * dashboard-server.cjs から require して呼び、共有ユーティリティ & state アクセサを ctx で注入する。
 *
 * @param {object} ctx - 依存注入
 * @param {function} ctx.jsonResponse - (res, statusCode, data, extraHeaders?) を書き込む
 * @param {function} ctx.parseJsonBody - (req) → Promise<object>
 * @param {string}   ctx.PROJECT_ROOT - プロジェクトルート絶対パス
 *
 * @param {function} ctx.normalizeProviderId - (id) → 正規化された providerId
 * @param {function} ctx.getSelectedAiProvider - () → 現在選択中の providerId
 * @param {function} ctx.getProvider - (providerId) → provider定義 (displayName/cliLabel 等)
 * @param {function} ctx.getProviderDisplayName - (providerId) → 表示名
 *
 * @param {function} ctx.probeNpmStatus - () → Promise<{ available, error? }>
 * @param {function} ctx.probeClaudeStatus - (providerId) → Promise<{ installed, version }>
 * @param {function} ctx.installAiRuntime - (providerId) → Promise<Result>
 * @param {function} ctx.getProviderInstallCommand - (providerId) → string
 * @param {function} ctx.setProviderInstallState - (providerId, state, error) → void
 * @param {function} ctx.invalidateAiStatusCache - (providerId?) → void
 * @param {function} ctx.clearAiExecutablePath - (providerId) → void (既存の `_aiExecutablePath[providerId] = null;` と同等)
 *
 * @param {function} ctx.startManagedAiSession - (mode, providerId, options) → Promise<Result>
 * @param {function} ctx.cancelManagedAiLaunch - (reason) → void
 * @param {function} ctx.launchClaudeInExternalTerminal - (mode, providerId, autoSendSafe) → Promise<Result>
 * @param {function} ctx.stopManagedClaudePty - (options) → Promise<Result>
 * @param {function} ctx.stopHeadlessAiRun - (providerId) → Promise<Result>
 * @param {function} ctx.getActiveHeadlessRun - (providerId?) → run | null
 * @param {function} ctx.getHeadlessAiRun - () → headlessAiRun (state snapshot for provider selection)
 * @param {function} ctx.getManagedAiProvider - () → active managed providerId
 *
 * @param {function} ctx.getClaudePty - () → claudePty | null  (PTY インスタンスを取得)
 * @param {function} ctx.getClaudeProcess - () → claudeProcess | null
 * @param {function} ctx.clearClaudeProcess - () → void (claudeProcess && kill(); null 代入)
 *
 * @param {function} ctx.appendDiagnosticEvent - (type, payload) → void
 *
 * @returns {function} dispatch(req, res, pathname) → Promise<boolean> (handled なら true)
 */
module.exports = function createAiRuntimeRoutes(ctx) {
  const {
    jsonResponse,
    parseJsonBody,
    PROJECT_ROOT,
    normalizeProviderId,
    getSelectedAiProvider,
    getProvider,
    getProviderDisplayName,
    probeNpmStatus,
    probeClaudeStatus,
    installAiRuntime,
    getProviderInstallCommand = getInstallCommand,
    setProviderInstallState,
    invalidateAiStatusCache,
    clearAiExecutablePath,
    startManagedAiSession,
    cancelManagedAiLaunch,
    launchClaudeInExternalTerminal,
    stopManagedClaudePty,
    stopHeadlessAiRun,
    getActiveHeadlessRun,
    getHeadlessAiRun,
    getManagedAiProvider,
    getClaudePty,
    getClaudeProcess,
    clearClaudeProcess,
    // appendDiagnosticEvent は現状このモジュール内では未使用だが、互換性維持のため受け取る
  } = ctx;

  // ---------- 各ハンドラ関数 ----------

  // POST /api/install-ai-cli (legacy: /api/install-claude-cli) — install into Sales Claw's embedded toolchain
  async function handleInstallAi(req, res) {
    try {
      const body: any = await parseJsonBody(req).catch(() => ({}));
      const providerId = normalizeProviderId(body.provider || getSelectedAiProvider());
      const provider = getProvider(providerId);
      const npmStatus: any = await probeNpmStatus();
      if (!npmStatus.available) {
        const installError = `${provider.cliLabel} の自動インストールに必要な内蔵 npm を起動できません。${npmStatus.error || ''}`.trim();
        setProviderInstallState(providerId, 'failed', installError);
        jsonResponse(res, 409, {
          ok: false,
          provider: providerId,
          providerLabel: provider.displayName,
          error: installError,
          command: getProviderInstallCommand(providerId),
        });
        return;
      }
      setProviderInstallState(providerId, 'installing', null);
      invalidateAiStatusCache(providerId);
      clearAiExecutablePath(providerId);

      const result: any = await installAiRuntime(providerId);
      if (!result.ok) {
        const installError = String(
          result.cli?.error
          || result.playwright?.error
          || `${provider.cliLabel} / Playwright setup failed.`
        ).trim();
        setProviderInstallState(providerId, 'failed', installError);
        jsonResponse(res, 500, {
          ok: false,
          provider: providerId,
          providerLabel: provider.displayName,
          error: installError,
          details: result,
          command: getProviderInstallCommand(providerId),
        });
        return;
      }

      invalidateAiStatusCache(providerId);
      const status: any = await probeClaudeStatus(providerId);
      if (!status.installed) {
        const installError = `${provider.cliLabel} was not detected after installation.`;
        setProviderInstallState(providerId, 'failed', installError);
        jsonResponse(res, 500, {
          ok: false,
          provider: providerId,
          providerLabel: provider.displayName,
          error: installError,
          command: getProviderInstallCommand(providerId),
        });
        return;
      }

      setProviderInstallState(providerId, 'idle', null);
      jsonResponse(res, 200, {
        ok: true,
        provider: providerId,
        providerLabel: provider.displayName,
        installed: status.installed,
        version: status.version,
        playwright: result.playwright || null,
        command: getProviderInstallCommand(providerId),
      });
    } catch (e) {
      const providerId = getSelectedAiProvider();
      setProviderInstallState(providerId, 'failed', e.message);
      jsonResponse(res, 500, { ok: false, provider: providerId, error: e.message, command: getProviderInstallCommand(providerId) });
    }
  }

  // POST /api/launch-ai (legacy: /api/launch-claude) — spawn selected provider in a real PTY via node-pty
  async function handleLaunchAi(req, res) {
    try {
      const body: any = await parseJsonBody(req).catch(() => ({}));
      const { mode = 'default' } = body;
      const cols = Math.max(2, Math.min(300, Math.floor(Number(body.cols) || 120)));
      const rows = Math.max(1, Math.min(120, Math.floor(Number(body.rows) || 30)));
      const autoSendSafe = body.autoSendSafe === true;
      const providerId = normalizeProviderId(body.provider || getSelectedAiProvider());
      // v2.0.31: 120秒に拡張。MCP playwright re-add (stale entry 検知 →
      // remove + add + verify) のワーストケースは ensureProviderPlaywrightMcp
      // 内のサブタイムアウト合計で最大 90s。旧 75s だとここに先にぶつかって
      // 「AI が永久に起動しない」状態になっていた (インストール版 ↔ dev mode を
      // 切り替えると毎回 stale 判定で再 add ループが発生する)。
      const LAUNCH_TIMEOUT_MS = 120000;
      let timedOut = false;
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => {
          timedOut = true;
          reject(Object.assign(new Error('AI launch did not complete within ' + (LAUNCH_TIMEOUT_MS / 1000) + 's.'), { code: 'LAUNCH_TIMEOUT' }));
        }, LAUNCH_TIMEOUT_MS);
      });
      let result;
      try {
        result = await Promise.race([
          startManagedAiSession(mode, providerId, {
            cols,
            rows,
            allowReuse: body.restart === true ? false : true,
            autoSendSafe,
          }),
          timeoutPromise,
        ]);
      } catch (timeoutErr) {
        if (timedOut && typeof cancelManagedAiLaunch === 'function') {
          try { cancelManagedAiLaunch('timeout'); } catch (_) { /* ignore */ }
        }
        throw timeoutErr;
      }
      jsonResponse(res, 200, result);
    } catch (e) {
      // 構造化エラー (CLI_NOT_INSTALLED / CLI_TOO_OLD など) は status 200 で OK=false を
      // 返し、UI 側で actionable な案内を出せるようにする。500 系は本物の障害用。
      if (e && e.code === 'CLI_NOT_INSTALLED') {
        jsonResponse(res, 200, {
          ok: false,
          reason: 'cli_not_installed',
          error: e.message,
          provider: e.providerId,
          providerLabel: e.providerLabel,
          installCommand: e.installCommand,
        });
        return;
      }
      if (e && e.code === 'CLI_TOO_OLD') {
        jsonResponse(res, 200, {
          ok: false,
          reason: 'cli_too_old',
          error: e.message,
          provider: e.providerId,
          providerLabel: e.providerLabel,
          installedVersion: e.installedVersion,
          minVersion: e.minVersion,
          updateCommand: e.updateCommand,
        });
        return;
      }
      if (e && e.code === 'LAUNCH_CANCELLED') {
        jsonResponse(res, 200, {
          ok: false,
          reason: 'launch_cancelled',
          error: e.message,
        });
        return;
      }
      if (e && e.code === 'LAUNCH_TIMEOUT') {
        jsonResponse(res, 200, {
          ok: false,
          reason: 'launch_timeout',
          error: e.message,
          hint: 'CLI 起動が時間内に完了しませんでした。Claude のレート上限に達しているか、MCP Playwright のセットアップが応答していない可能性があります。',
        });
        return;
      }
      jsonResponse(res, 500, { ok: false, error: e.message });
    }
  }

  // POST /api/launch-ai-external (legacy: /api/launch-claude-external) — open selected provider in an interactive external terminal
  async function handleLaunchAiExternal(req, res) {
    try {
      const body: any = await parseJsonBody(req).catch(() => ({}));
      const providerId = normalizeProviderId(body.provider || getSelectedAiProvider());
      const { mode = 'default' } = body;
      const result: any = await launchClaudeInExternalTerminal(mode, providerId, body.autoSendSafe === true);
      invalidateAiStatusCache(providerId);
      jsonResponse(res, 200, result);
    } catch (e) {
      jsonResponse(res, 500, { ok: false, error: e.message });
    }
  }

  // POST /api/stop-ai (legacy: /api/stop-claude) — stop active AI runtime
  async function handleStopAi(req, res) {
    const body: any = await parseJsonBody(req).catch(() => ({}));
    if (typeof cancelManagedAiLaunch === 'function') {
      cancelManagedAiLaunch('stop-api');
    }
    const headlessRun = typeof getHeadlessAiRun === 'function' ? getHeadlessAiRun() : null;
    const managedPty = typeof getClaudePty === 'function' ? getClaudePty() : null;
    const providerId = headlessRun
      ? headlessRun.provider
      : managedPty && typeof getManagedAiProvider === 'function'
        ? getManagedAiProvider()
        : normalizeProviderId(body.provider || getSelectedAiProvider());
    const provider = getProvider(providerId);
    const stopped = getActiveHeadlessRun(providerId)
      ? await stopHeadlessAiRun(providerId)
      : await stopManagedClaudePty({ suppressAutoRecovery: true });
    if (!stopped.ok) {
      jsonResponse(res, 500, stopped);
      return;
    }
    const claudeProcess = typeof getClaudeProcess === 'function' ? getClaudeProcess() : null;
    if (claudeProcess && !claudeProcess.killed) {
      try { clearClaudeProcess(); } catch (_) {}
    }
    invalidateAiStatusCache(providerId);
    jsonResponse(res, 200, { ...stopped, provider: providerId, providerLabel: provider.displayName });
  }

  // GET /api/ai-toolchain/status?provider=claude — 事前状態確認 (非破壊)
  async function handleAiToolchainStatus(req, res, queryParams) {
    try {
      const provider = normalizeProviderId(
        (queryParams && queryParams.get && queryParams.get('provider')) || getSelectedAiProvider()
      );
      // ctx.localToolchain or fallback to require
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const lt = ctx.localToolchain || require('../local-toolchain');
      const status: any = await lt.probeAiToolchainStatus(provider);
      jsonResponse(res, 200, status);
    } catch (e: any) {
      jsonResponse(res, 500, { ok: false, error: e.message });
    }
  }

  // GET /api/install-ai-cli/stream?provider=claude — SSE 進捗ストリーム付きインストール
  async function handleInstallAiStream(req, res, queryParams) {
    const providerId = normalizeProviderId(
      (queryParams && queryParams.get && queryParams.get('provider')) || getSelectedAiProvider()
    );
    const provider = getProvider(providerId);

    // SSE ヘッダー
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const send = (event: string, data: any) => {
      try {
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      } catch (_) { /* socket closed */ }
    };

    // クライアント切断検知
    let aborted = false;
    req.on('close', () => { aborted = true; });

    try {
      const npmStatus: any = await probeNpmStatus();
      if (!npmStatus.available) {
        const err = `${provider.cliLabel} の自動インストールに必要な内蔵 npm を起動できません。${npmStatus.error || ''}`.trim();
        setProviderInstallState(providerId, 'failed', err);
        send('progress', { stage: 'error', progress: 0, message: err });
        send('done', { ok: false, error: err });
        res.end();
        return;
      }

      setProviderInstallState(providerId, 'installing', null);
      invalidateAiStatusCache(providerId);
      clearAiExecutablePath(providerId);

      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const lt = ctx.localToolchain || require('../local-toolchain');
      const result: any = await lt.installAiRuntimeWithProgress(providerId, (evt: any) => {
        if (aborted) return;
        send('progress', { provider: providerId, ...evt });
      });

      if (!result.ok) {
        setProviderInstallState(providerId, 'failed', result.error);
        send('done', { ok: false, ...result });
      } else {
        invalidateAiStatusCache(providerId);
        const status: any = await probeClaudeStatus(providerId).catch(() => null);
        setProviderInstallState(providerId, 'idle', null);
        send('done', {
          ok: true,
          provider: providerId,
          providerLabel: provider.displayName,
          reused: !!result.reused,
          cli: result.cli,
          playwright: result.playwright,
          installed: !!status?.installed,
          version: status?.version,
        });
      }
    } catch (e: any) {
      send('done', { ok: false, error: e.message });
    } finally {
      try { res.end(); } catch (_) {}
    }
  }

  // POST /api/ai-input (legacy: /api/claude-input) — send text to managed AI PTY (fallback for non-WS clients)
  async function handleAiInput(req, res) {
    try {
      const body: any = await parseJsonBody(req).catch(() => ({}));
      const { text } = body;
      const claudePty = getClaudePty();
      if (claudePty) {
        claudePty.write(text || '');
        jsonResponse(res, 200, { ok: true });
      } else {
        jsonResponse(res, 409, { ok: false, error: `${getProviderDisplayName(getSelectedAiProvider())} is not running (managed mode)` });
      }
    } catch (e) {
      jsonResponse(res, 500, { ok: false, error: e.message });
    }
  }

  // ---------- dispatch ----------

  /**
   * 受信した request が AI runtime API の管轄であれば handle して true を返す。
   * 管轄外であれば false を返して呼び出し側に処理を戻す。
   *
   * legacy 名 (/api/*-claude*) と新 名 (/api/*-ai*) の両方を受け付ける。
   *
   * @param {http.IncomingMessage} req
   * @param {http.ServerResponse} res
   * @param {string} pathname - URL.pathname (? 以降削除済み)
   * @returns {Promise<boolean>}
   */
  return async function dispatch(req, res, pathname, queryParams?: any) {
    const method = req.method;

    // GET /api/ai-toolchain/status?provider=claude
    if (pathname === '/api/ai-toolchain/status' && method === 'GET') {
      await handleAiToolchainStatus(req, res, queryParams);
      return true;
    }

    // GET /api/install-ai-cli/stream?provider=claude — SSE 進捗付きインストール
    if (pathname === '/api/install-ai-cli/stream' && method === 'GET') {
      await handleInstallAiStream(req, res, queryParams);
      return true;
    }

    // POST /api/install-claude-cli | /api/install-ai-cli (legacy 同期版、後方互換)
    if ((pathname === '/api/install-claude-cli' || pathname === '/api/install-ai-cli') && method === 'POST') {
      await handleInstallAi(req, res);
      return true;
    }

    // POST /api/launch-claude | /api/launch-ai
    if ((pathname === '/api/launch-claude' || pathname === '/api/launch-ai') && method === 'POST') {
      await handleLaunchAi(req, res);
      return true;
    }

    // POST /api/launch-claude-external | /api/launch-ai-external
    if ((pathname === '/api/launch-claude-external' || pathname === '/api/launch-ai-external') && method === 'POST') {
      await handleLaunchAiExternal(req, res);
      return true;
    }

    // POST /api/stop-claude | /api/stop-ai
    if ((pathname === '/api/stop-claude' || pathname === '/api/stop-ai') && method === 'POST') {
      await handleStopAi(req, res);
      return true;
    }

    // POST /api/claude-input | /api/ai-input
    if ((pathname === '/api/claude-input' || pathname === '/api/ai-input') && method === 'POST') {
      await handleAiInput(req, res);
      return true;
    }

    // 管轄外
    return false;
  };
};

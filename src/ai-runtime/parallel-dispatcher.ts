'use strict';

/**
 * Parallel AI form-fill dispatcher (P1-4)。
 *
 * 既存の単一 managed PTY フロー (`queueAiFormFill`) はそのまま温存し、
 * 並列化したい場合だけ別経路でこのモジュールを呼ぶ。
 *
 * 動作:
 *   1. companies を `concurrency` (1〜3) グループに分割
 *   2. 各グループにつき独立したヘッドレス Claude プロセスを spawn
 *   3. 各 Claude プロセスは自前で MCP Playwright をスポーンする
 *      → 各々 別 Chromium / 別 user-data-dir で互いに干渉しない
 *   4. 完了を Promise.allSettled で待ち、結果を集約
 *
 * 注意点:
 *   - Anthropic Max のレート制限はアカウント共有なので、3 並列でも
 *     必ず 3 倍速にはならない。既定は 2 並列 + 30 秒 stagger で
 *     バーストを避ける。
 *   - 各 Claude プロセスは独立した HOME (= 同じ provider home dir) を
 *     共有する。MCP 設定や認証は共通。バグ時は片方の状態が他方に影響する
 *     可能性あり (特に MCP server 登録状態) ことを承知
 *   - スクショは ss-{No}-input.png で衝突しない (No が異なる前提)
 *   - 失敗時の自動リトライは入れていない (呼び出し側が判断)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const DEFAULT_CONCURRENCY = 2;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000; // 15 分 (1 グループ = 最大 MAX_GROUP_SIZE 社に適用)
const DEFAULT_STAGGER_MS = 30 * 1000;
// v2.1.9: ワークキュー投入単位。1 ヘッドレスプロセスが一度に受け持つ社数。
//   timeoutMs はこの単位に適用されるため、大きくしすぎると 50 社バッチ全滅
//   (2026-08-14) の再発になる。3 社 × ~4分 = 12分 < 15分 で整合。
const MAX_GROUP_SIZE = 3;

/**
 * @param {Array<object>} companies
 * @param {object} ctx - 依存注入 (dashboard-server.cjs から受け取る)
 * @param {string} ctx.providerId
 * @param {function} ctx.buildPromptText - (groupCompanies) => string
 * @param {function} ctx.writePromptFile - (groupCompanies, promptText, providerId, slotIdx) => string (path)
 * @param {function} ctx.buildHeadlessArgs - (providerId, mode, opts) => { args, effectiveMode }
 * @param {function} ctx.buildCliCommandSpec - (executable, args) => { command, args, windowsVerbatimArguments }
 * @param {function} ctx.resolveExecutable - (providerId) => Promise<string>
 * @param {function} ctx.buildBaseEnv - (providerId) => Record<string,string>
 * @param {function} ctx.appendDiagnosticEvent - (type, payload) => void
 * @param {function} ctx.emitLog - (text, stream, providerId, slotIdx) => void
 * @param {function} ctx.createLogFile - (providerId, slotIdx) => string
 * @param {function} ctx.appendLog - (filePath, stream, text) => void
 * @param {string}   ctx.projectRoot
 * @param {string}   ctx.runtimeBaseDir - %APPDATA%/sales-claw/runtime/data 等
 * @param {object}   [options]
 * @param {number}   [options.concurrency=2]
 * @param {number}   [options.timeoutMs=900000]
 * @param {number}   [options.staggerMs=30000]
 * @param {string}   [options.mode='auto']
 * @returns {Promise<{ok, slots: Array, totalCompanies, succeeded, failed}>}
 */
async function runParallelBatch(companies, ctx, options: Record<string, unknown> = {}) {
  const concurrency = Math.max(1, Math.min(3, Number(options.concurrency) || DEFAULT_CONCURRENCY));
  const configuredTimeoutMs = Number(options.timeoutMs);
  const configuredStaggerMs = Number(options.staggerMs);
  const timeoutMs = Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs > 0
    ? configuredTimeoutMs
    : DEFAULT_TIMEOUT_MS;
  const staggerMs = Number.isFinite(configuredStaggerMs)
    ? Math.max(0, configuredStaggerMs)
    : DEFAULT_STAGGER_MS;
  const mode = options.mode || 'auto';
  const providerId = ctx.providerId || 'claude';
  const list = Array.isArray(companies) ? companies.filter(Boolean) : [];

  if (list.length === 0) {
    return { ok: false, error: 'no companies', slots: [], totalCompanies: 0, succeeded: 0, failed: 0 };
  }

  // v2.1.9: 「concurrency 個の巨大グループに事前分割」をやめ、
  //   小グループ (MAX_GROUP_SIZE 社) のワークキュー方式に変更。
  //   旧方式は 50 社バッチが 25 社×2 グループになり、グループ単位の
  //   timeoutMs (15分) と物理的に矛盾して全社 slot timeout で全滅した
  //   (2026-08-14 00:43 実機)。新方式は空いたワーカーがキューから次の
  //   小グループを取るため、timeoutMs は常に「数社分の処理時間」に対して
  //   適用され、100-200 社でも連続的に消化できる。
  const groups = _splitIntoGroups(list, MAX_GROUP_SIZE);
  ctx.appendDiagnosticEvent && ctx.appendDiagnosticEvent('parallel_dispatch_started', {
    provider: providerId,
    totalCompanies: list.length,
    concurrency,
    groupCount: groups.length,
    groupSizes: groups.map((g: any) => g.length),
    timeoutMs,
    staggerMs,
    mode,
  });

  const delay = (ms) => new Promise<unknown>((resolve) => setTimeout(resolve, ms));
  const queue = groups.slice();
  const slots: any[] = [];
  let nextSlotIdx = 0;

  const startedAt = Date.now();
  const workerCount = Math.min(concurrency, groups.length);
  const workers = Array.from({ length: workerCount }, (_, workerIdx) => (async () => {
    // 初回のみ stagger でバースト回避。2 グループ目以降は前グループ完了直後に続行。
    await delay(workerIdx * staggerMs);
    while (queue.length > 0) {
      const groupCompanies = queue.shift();
      if (!groupCompanies || groupCompanies.length === 0) continue;
      const slotIdx = nextSlotIdx;
      nextSlotIdx += 1;
      const result = await _runSlot(groupCompanies, slotIdx, ctx, { mode, timeoutMs })
        .catch((err) => ({
          ok: false,
          slotIdx,
          error: err && err.message || String(err),
          companies: groupCompanies,
          failedCompanyNos: groupCompanies.map((c: any) => c && c.no).filter((n: any) => n != null),
        }));
      slots.push(result);
      ctx.appendDiagnosticEvent && ctx.appendDiagnosticEvent('parallel_group_completed', {
        provider: providerId,
        workerIdx,
        slotIdx,
        ok: !!(result as any).ok,
        companyCount: groupCompanies.length,
        remainingGroups: queue.length,
      });
    }
  })());

  await Promise.allSettled(workers);
  const elapsedMs = Date.now() - startedAt;
  const succeeded = slots.filter((s: any) => s.ok).length;
  const failed = slots.length - succeeded;
  const failedCompanyNos = new Set<any>();
  slots.forEach((slot: any) => {
    (slot.failedCompanyNos || slot.missingCompanyNos || []).forEach((no: any) => failedCompanyNos.add(String(no)));
  });
  const succeededCompanies = list.filter((company: any) => !failedCompanyNos.has(String(company.no))).length;
  const failedCompanies = Math.max(0, list.length - succeededCompanies);

  ctx.appendDiagnosticEvent && ctx.appendDiagnosticEvent('parallel_dispatch_completed', {
    provider: providerId,
    totalCompanies: list.length,
    concurrency,
    succeeded,
    failed,
    succeededCompanies,
    failedCompanies,
    elapsedMs,
  });

  return {
    ok: failed === 0,
    totalCompanies: list.length,
    concurrency,
    timeoutMs,
    staggerMs,
    succeeded,
    failed,
    succeededCompanies,
    failedCompanies,
    elapsedMs,
    slots,
  };
}

function _splitIntoGroups(companies: unknown[], groupSize: number) {
  // v2.1.9: 連続 groupSize 社ずつの小グループ列に分割 (ワークキュー投入単位)。
  const size = Math.max(1, Number(groupSize) || 1);
  const groups: unknown[][] = [];
  for (let i = 0; i < companies.length; i += size) {
    groups.push(companies.slice(i, i + size));
  }
  return groups;
}

/**
 * Windows 上で child + その descendant (主に MCP Playwright + Chromium)
 * をツリーごと強制終了する。Linux/macOS は process.kill('SIGKILL') で
 * setsid されていないため子も連れて落ちないので、別途 process group
 * 経由 kill する必要があるが、対象 OS が現状 Windows メインなので
 * Windows 経路を優先実装。POSIX は best-effort で SIGKILL のみ。
 *
 * @param {ChildProcess} child
 * @param {function} emitLog (text, stream, providerId, slotIdx) => void
 * @param {string} providerId
 * @param {number} slotIdx
 */
function _killChildTree(child, emitLog, providerId, slotIdx) {
  if (!child || child.killed) return;
  const pid = Number(child.pid);
  if (!Number.isFinite(pid) || pid <= 0) return;
  if (process.platform === 'win32') {
    try {
      const { spawnSync } = require('child_process');
      const r = spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], {
        windowsHide: true, timeout: 5000,
      });
      if (emitLog) emitLog(
        `[parallel slot ${slotIdx}] taskkill /F /T /PID ${pid} -> code ${r.status}\n`,
        'system', providerId, slotIdx
      );
    } catch (e) {
      try { child.kill(); } catch (_) {}
      if (emitLog) emitLog(
        `[parallel slot ${slotIdx}] taskkill failed (${e && e.message}); fallback child.kill\n`,
        'system', providerId, slotIdx
      );
    }
  } else {
    try { child.kill('SIGKILL'); } catch (_) {}
  }
}

async function _runSlot(companies, slotIdx, ctx, options) {
  const providerId = ctx.providerId || 'claude';
  const promptText = ctx.buildPromptText(companies, slotIdx);
  const promptFile = ctx.writePromptFile(companies, promptText, providerId, slotIdx);
  const logFile = ctx.createLogFile(providerId, slotIdx);

  // 致命-1 修正: -p の引数にプロンプト全文を渡すのは
  //  (a) cmd.exe の 8191 文字引数上限に容易に到達 → spawn 失敗
  //  (b) Process List (ps / Task Manager) に PII が露出
  //  (c) buildHeadlessArgs(promptViaStdin) との二重渡しで競合
  // を引き起こす。並列ヘッドレスでは arg に本文を載せず、実行指示は
  // stdin だけで流す。promptFile は監査用の控えとして残す。
  // v2.1.0: ブラウザ自動化 MCP は formFill.mode により sales-claw-form (内蔵) か
  //   playwright (外部) のいずれか。tool 名 (browser_*) は両モードでミラーされるため、
  //   特定の MCP 名を固定で指示せず「利用可能なブラウザ自動化ツール (browser_*) を使う」
  //   とモード非依存に伝える (internal モードで Playwright を名指しして誤誘導しない)。
  const kickoff = `以下の stdin 指示だけを実行してください。監査用 prompt file: ${promptFile}\n`
    + '利用可能なブラウザ自動化 MCP (browser_* ツール) を必ず使ってください。フォームタブは閉じず、確認待ちまでで止めてください。\n';

  const headlessSpec = ctx.buildHeadlessArgs(providerId, options.mode, {
    cwd: ctx.projectRoot,
    prompt: '',           // -p に長文を載せない
    promptFile,
    slotIdx,
  });
  const executable: any = await ctx.resolveExecutable(providerId);
  const spawnSpec = ctx.buildCliCommandSpec(executable, headlessSpec.args);
  const env = ctx.buildBaseEnv(providerId);

  // 1.2.89 fix: 並列モードで MCP Playwright (chromium) のプロファイルディレクトリ
  // (chrome-for-testing-profile/User Data) を slot 毎に分けないと、
  // 同一プロファイルを 2 slot 以上が取り合って "ProfileLock" 競合 → 2 社失敗。
  // PWMCP_PROFILES_DIR_FOR_TEST 環境変数で profiles ルートを slot 毎に分離。
  // playwright-mcp-wrapper.cjs がこの env を尊重する仕組みになっている。
  if (process.env.PWMCP_PROFILES_DIR_FOR_TEST || env.PWMCP_PROFILES_DIR_FOR_TEST) {
    const baseProfileDir = env.PWMCP_PROFILES_DIR_FOR_TEST || process.env.PWMCP_PROFILES_DIR_FOR_TEST;
    env.PWMCP_PROFILES_DIR_FOR_TEST = require('path').join(baseProfileDir, `slot${slotIdx}`);
  } else if (env.APPDATA || process.env.APPDATA) {
    // フォールバック: APPDATA 配下の sales-claw runtime tools/mcp-profiles に slot dir を作る
    const appdata = env.APPDATA || process.env.APPDATA;
    env.PWMCP_PROFILES_DIR_FOR_TEST = require('path').join(appdata, 'sales-claw', 'runtime', 'tools', 'mcp-profiles', `slot${slotIdx}`);
  }
  ctx.emitLog && ctx.emitLog(
    `[parallel slot ${slotIdx}] starting (${companies.length} companies, mode=${headlessSpec.effectiveMode || options.mode}, profileDir=${env.PWMCP_PROFILES_DIR_FOR_TEST || 'default'})\n`,
    'system', providerId, slotIdx
  );

  const startedAtMs = Date.now();
  const child = spawn(spawnSpec.command, spawnSpec.args, {
    cwd: ctx.projectRoot,
    env,
    windowsHide: true,
    windowsVerbatimArguments: spawnSpec.windowsVerbatimArguments === true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdoutBuf = '';
  let stderrBuf = '';
  let resolved = false;

  return new Promise<unknown>((resolve) => {
    const hasTerminalLog = (company) => (
      typeof ctx.hasCompanyTerminalLogSince === 'function'
        ? ctx.hasCompanyTerminalLogSince(company.no, startedAtMs)
        : false
    );
    const companiesWithoutTerminalLog = () => companies.filter((company: any) => !hasTerminalLog(company));
    const markMissingCompaniesFailed = (reason, extra: Record<string, unknown> = {}) => {
      const missing = companiesWithoutTerminalLog();
      if (missing.length > 0 && typeof ctx.markCompaniesFailed === 'function') {
        try {
          ctx.markCompaniesFailed(missing, reason, {
            providerId,
            slotIdx,
            startedAtMs,
            promptFile,
            logFile,
            ...extra,
          });
        } catch (_) {}
      }
      return missing;
    };
    const finishOnce = (payload) => {
      if (resolved) return;
      resolved = true;
      try { clearTimeout(killTimer); } catch (_) {}
      resolve(payload);
    };

    const killTimer = setTimeout(() => {
      ctx.emitLog && ctx.emitLog(
        `[parallel slot ${slotIdx}] timeout after ${options.timeoutMs}ms, killing child tree\n`,
        'system', providerId, slotIdx
      );
      _killChildTree(child, ctx.emitLog, providerId, slotIdx);
      const missing = markMissingCompaniesFailed('parallel slot timeout', { error: 'timeout' });
      finishOnce({
        ok: false, slotIdx, providerId, companies, error: 'timeout',
        elapsedMs: Date.now() - startedAtMs, promptFile, logFile,
        failedCompanyNos: missing.map((company: any) => company.no),
        missingCompanyNos: missing.map((company: any) => company.no),
      });
    }, options.timeoutMs);

    child.stdout.on('data', (chunk) => {
      if (resolved) return; // kill 後の遅延 chunk を無視
      const text = String(chunk);
      stdoutBuf = (stdoutBuf + text).slice(-12000);
      try { ctx.appendLog && ctx.appendLog(logFile, 'stdout', text); } catch (_) {}
      try { ctx.emitLog && ctx.emitLog(text, 'stdout', providerId, slotIdx); } catch (_) {}
    });
    child.stderr.on('data', (chunk) => {
      if (resolved) return;
      const text = String(chunk);
      stderrBuf = (stderrBuf + text).slice(-6000);
      try { ctx.appendLog && ctx.appendLog(logFile, 'stderr', text); } catch (_) {}
      try { ctx.emitLog && ctx.emitLog(text, 'stderr', providerId, slotIdx); } catch (_) {}
    });
    child.on('error', (e) => {
      try { ctx.appendLog && ctx.appendLog(logFile, 'error', String(e && e.message || e) + '\n'); } catch (_) {}
      const missing = markMissingCompaniesFailed('parallel slot spawn error', { error: e && e.message || String(e) });
      finishOnce({
        ok: false, slotIdx, providerId, companies, error: e && e.message || String(e),
        elapsedMs: Date.now() - startedAtMs, promptFile, logFile,
        failedCompanyNos: missing.map((company: any) => company.no),
        missingCompanyNos: missing.map((company: any) => company.no),
      });
    });
    child.on('exit', (code, signal) => {
      try { ctx.appendLog && ctx.appendLog(logFile, 'system', `[exit] code=${code} signal=${signal}\n`); } catch (_) {}
      const missing = companiesWithoutTerminalLog();
      const ok = code === 0 && missing.length === 0;
      if (!ok) {
        const reason = code === 0
          ? 'parallel slot exited without terminal company logs'
          : `parallel slot exited early (code=${code}, signal=${signal || 'none'})`;
        markMissingCompaniesFailed(reason, { exitCode: code, signal: signal || null });
      }
      finishOnce({
        ok, slotIdx, providerId, companies,
        error: ok ? null : (code === 0 ? 'missing_terminal_logs' : 'exit_' + code),
        exitCode: code, signal,
        elapsedMs: Date.now() - startedAtMs,
        promptFile, logFile,
        failedCompanyNos: missing.map((company: any) => company.no),
        missingCompanyNos: missing.map((company: any) => company.no),
        // 致命-1 修正の補助: stdoutTail は短くして PII 漏洩リスクを下げる。
        // 詳細は logFile に書いてあるのでサーバ側ログで参照する想定。
        stdoutTail: stdoutBuf.slice(-500),
        stderrTail: stderrBuf.slice(-300),
      });
    });

    // 致命-1 修正: プロンプト全文は stdin で流す ( -p には載せない)。
    // Claude の `-p ""` モード (引数空) は stdin から読む。
    try {
      child.stdin.end(kickoff + '\n' + promptText, 'utf8');
    } catch (e) {
      ctx.emitLog && ctx.emitLog(
        `[parallel slot ${slotIdx}] stdin write failed: ${e.message}\n`,
        'system', providerId, slotIdx
      );
    }
  });
}

module.exports = {
  runParallelBatch,
  _splitIntoGroups,
  _killChildTree,
  DEFAULT_CONCURRENCY,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_STAGGER_MS,
};

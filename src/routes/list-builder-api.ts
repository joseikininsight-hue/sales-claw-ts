'use strict';

/**
 * List Builder API.
 *
 * 要件§9 (docs/list-builder-requirements.md v2.0):
 *   POST   /api/list-builder/run                — run 開始
 *   GET    /api/list-builder/stream/:runId      — SSE 進捗購読
 *   POST   /api/list-builder/commit             — 選択分をターゲットリストに追加
 *   GET    /api/list-builder/runs               — run 一覧
 *   GET    /api/list-builder/runs/:runId        — run 詳細 (candidates 含む)
 *   POST   /api/list-builder/runs/:runId/cancel
 *   POST   /api/list-builder/runs/:runId/retry-failed
 *   DELETE /api/list-builder/runs/:runId
 *
 *   GET    /api/list-builder/api-key-status     — API キーの設定有無 (値は返さない)
 */

const orchestrator = require('../list-builder/orchestrator');
const runManager = require('../list-builder/run-manager');
const dedupe = require('../list-builder/dedupe');
const suppression = require('../list-builder/suppression');
const settings = require('../settings-manager');
const httpClient = require('../list-builder/official-clients/http-client');
const { renderListBuilderPage } = require('../list-builder-page');
const { EXTENDED_TARGET_FIELDS } = require('../target-list');

// ログ用: 内部エラーは console に残しつつ、HTTP レスポンスには汎用文言だけ返す
function logInternalError(scope, e) {
  try {
    console.warn(`[list-builder-api] ${scope}:`, e && e.message ? e.message : e);
  } catch (_) {}
}

// SSE stream を保持する: runId → res オブジェクト Set
const sseClients = new Map<any, any>();
const MAX_SSE_PER_RUN = 10;
const MAX_SSE_TOTAL = 200;

// SSE / イベント・runId フィルタ用の正規表現
const RUN_ID_PATTERN = /^run_[a-z0-9_-]+$/i;
const STATUS_ENUM = new Set(['queued', 'running', 'completed', 'failed', 'cancelled', 'partial']);
const MODE_ENUM = new Set(['url', 'nlq', 'category']);
const COMMIT_BLOCKING_RISK_FLAGS = new Set([
  'robots_disallowed',
  'sales_prohibited',
  'recruit_only',
  'support_only',
  'ir_only',
  'access_blocked',
  'captcha_detected',
  'login_required',
]);

function isValidRunId(runId) {
  return typeof runId === 'string' && runId.length <= 100 && RUN_ID_PATTERN.test(runId);
}

function getExistingTargets(readTargetList) {
  try {
    const r = typeof readTargetList === 'function' ? readTargetList() : null;
    return r && r.ok ? (r.companies || []) : [];
  } catch (_) {
    return [];
  }
}

function getExistingHistory(getAllHistorySummary) {
  try {
    const rows = typeof getAllHistorySummary === 'function' ? getAllHistorySummary() : [];
    return Array.isArray(rows) ? rows : [];
  } catch (_) {
    return [];
  }
}

function buildExistingRecords(readTargetList, getAllHistorySummary) {
  return [
    ...getExistingTargets(readTargetList).map((r: any) => ({ ...r, source: 'targets' })),
    ...getExistingHistory(getAllHistorySummary).map((r: any) => ({ ...r, source: 'history' })),
  ];
}

function sanitizeDuplicateMatch(match) {
  return dedupe.sanitizeMatchedAgainst ? dedupe.sanitizeMatchedAgainst(match) : match;
}

function sanitizeCandidateForResponse(candidate) {
  if (!candidate || typeof candidate !== 'object') return candidate;
  const next = { ...candidate };
  if (next.dedupeMatchedAgainst) {
    next.dedupeMatchedAgainst = sanitizeDuplicateMatch(next.dedupeMatchedAgainst);
  }
  // 念のため古い run ファイルに HTML や内部エラー詳細が残っていても API へ出さない。
  delete next.html;
  delete next.rawHtml;
  delete next.internalError;
  return next;
}

function sanitizeCandidatesForResponse(candidates) {
  return (Array.isArray(candidates) ? candidates : []).map(sanitizeCandidateForResponse);
}

function hasCommitBlockingRisk(candidate) {
  if (!candidate || typeof candidate !== 'object') return true;
  if (candidate.collectionStatus === 'blocked' || candidate.collectionStatus === 'failed') return true;
  const flags = Array.isArray(candidate.riskFlags) ? candidate.riskFlags : [];
  return flags.some((flag: any) => COMMIT_BLOCKING_RISK_FLAGS.has(flag));
}

function buildTargetListPayload(candidate, runId) {
  const notes: unknown[] = [];
  if (Array.isArray(candidate.fitReasons) && candidate.fitReasons.length > 0) {
    notes.push(candidate.fitReasons.join(' / '));
  }
  if (Array.isArray(candidate.riskFlags) && candidate.riskFlags.length > 0) {
    notes.push('risk: ' + candidate.riskFlags.join(','));
  }
  if (candidate.sourceConfidence) notes.push('confidence: ' + candidate.sourceConfidence);

  const payload = {
    companyName: candidate.companyName || candidate.officialName || '',
    url: candidate.url || '',
    formUrl: candidate.formUrl || '',
    type: candidate.industry || candidate.type || '',
    notes: notes.join(' | '),
    listBuilderRunId: runId,
    listBuilderRecordId: candidate.id || '',
  };
  for (const field of EXTENDED_TARGET_FIELDS || []) {
    if (Object.prototype.hasOwnProperty.call(candidate, field)) {
      payload[field] = candidate[field];
    }
  }
  return payload;
}

function csvCell(value) {
  const text = value === undefined || value === null ? '' : String(value);
  return '"' + text.replace(/"/g, '""') + '"';
}

function candidatesToCsv(candidates) {
  const fields = [
    'id', 'companyName', 'officialName', 'url', 'formUrl', 'industry', 'prefecture',
    'employeeCount', 'revenue', 'fitScore', 'sourceConfidence', 'collectionStatus',
    'dedupeDecision', 'dedupeMatchKey', 'dedupeSimilarity', 'riskFlags',
  ];
  const rows = [fields.join(',')];
  for (const c of candidates || []) {
    rows.push(fields.map((field: any) => {
      const value = Array.isArray(c[field]) ? c[field].join('|') : c[field];
      return csvCell(value);
    }).join(','));
  }
  return '\uFEFF' + rows.join('\r\n') + '\r\n';
}

function totalSseCount() {
  let n = 0;
  for (const set of sseClients.values()) n += set.size;
  return n;
}

function addSseClient(runId, res) {
  if (!sseClients.has(runId)) sseClients.set(runId, new Set<any>());
  sseClients.get(runId).add(res);
}

function removeSseClient(runId, res) {
  const set = sseClients.get(runId);
  if (set) {
    set.delete(res);
    if (set.size === 0) sseClients.delete(runId);
  }
}

function broadcastProgress(runId, event) {
  const set = sseClients.get(runId);
  if (!set || set.size === 0) return;
  // SSE event type をサニタイズ (CR/LF はプロトコル禁止文字)
  const eventType = String(event && event.type ? event.type : 'progress').replace(/[\r\n]/g, '');
  const payload = `event: ${eventType}\ndata: ${JSON.stringify(event)}\n\n`;
  for (const res of [...set]) {
    try {
      res.write(payload);
    } catch (_) {
      // 接続切れ
      removeSseClient(runId, res);
    }
  }
}

function closeAllSseClients(runId) {
  const set = sseClients.get(runId);
  if (!set) return;
  for (const res of [...set]) {
    try {
      res.write(`event: done\ndata: ${JSON.stringify({ runId })}\n\n`);
      res.end();
    } catch (_) {}
  }
  sseClients.delete(runId);
}

// payload バリデーション
//
// 受け入れ基準:
//   - mode は 'url' / 'nlq' / 'category' のみ
//   - URL モード: urls は文字列配列、最大 10 件
//   - NLQ モード: query は 1〜500 文字
//   - カテゴリモード: limit は 1〜500
function validateRunInput(body) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'body required' };
  const { mode, payload } = body;
  if (!['url', 'nlq', 'category'].includes(mode)) {
    return { ok: false, error: 'invalid mode' };
  }
  if (!payload || typeof payload !== 'object') {
    return { ok: false, error: 'payload required' };
  }
  if (mode === 'url') {
    if (!Array.isArray(payload.urls) || payload.urls.length === 0) {
      return { ok: false, error: 'urls is required (non-empty array)' };
    }
    if (payload.urls.length > 10) {
      return { ok: false, error: 'too many URLs (max 10)' };
    }
    for (const u of payload.urls) {
      if (typeof u !== 'string' || u.length > 2000) {
        return { ok: false, error: 'invalid URL in urls' };
      }
      // SSRF 予防: スキームとプライベート IP を入口で弾く
      let parsed;
      try {
        parsed = new URL(u);
      } catch (_) {
        return { ok: false, error: 'invalid URL syntax' };
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { ok: false, error: 'URL must use http or https' };
      }
      if (httpClient.isPrivateHost(parsed.hostname)) {
        return { ok: false, error: 'URL targets a private/loopback host' };
      }
    }
  } else if (mode === 'nlq') {
    if (typeof payload.query !== 'string' || !payload.query.trim()) {
      return { ok: false, error: 'query required' };
    }
    if (payload.query.length > 500) {
      return { ok: false, error: 'query too long (max 500 chars)' };
    }
  } else if (mode === 'category') {
    const limit = payload.limit;
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 500)) {
      return { ok: false, error: 'invalid limit (1-500)' };
    }
  }
  return { ok: true };
}

module.exports = function createListBuilderRoutes(ctx) {
  const {
    jsonResponse,
    parseJsonBody,
    appendCompany,
    readTargetList,
    getAllHistorySummary,
    getDashboardSessionToken,
    cliAgentCtx, // CLI Agent モード用 (resolveExecutable / buildHeadlessArgs / etc)
  } = ctx;
  const cliAgent = require('../list-builder/discovery/cli-agent');

  // GET /list-builder — UI ページ
  function handlePage(req, res) {
    const sessionToken = (typeof getDashboardSessionToken === 'function')
      ? (getDashboardSessionToken() || '') : '';
    // v2.0.32+: preferences.language を見て ja/en を切替
    let lang: 'ja' | 'en' = 'ja';
    try {
      const pref = (settings.getSection && settings.getSection('preferences')) || {};
      lang = pref.language === 'en' ? 'en' : 'ja';
    } catch (_) { /* keep default ja */ }
    const html = renderListBuilderPage({ sessionToken, lang });
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      // CSP: 厳格に self のみ。inline script/style は許可（onboarding と同じ方針）
      'Content-Security-Policy': [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline'",
        "connect-src 'self'",
        "img-src 'self' data:",
        "frame-ancestors 'none'",
      ].join('; '),
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
    });
    res.end(html);
  }

  // POST /api/list-builder/run
  async function handleRun(req, res) {
    try {
      const body: any = await parseJsonBody(req);
      const valid = validateRunInput(body);
      if (!valid.ok) {
        jsonResponse(res, 400, { ok: false, error: valid.error });
        return;
      }

      // run を作成して即座にレスポンス。実行は非同期でバックグラウンド。
      const run = runManager.createRun({ mode: body.mode, payload: body.payload });
      jsonResponse(res, 200, {
        ok: true,
        runId: run.runId,
        status: run.status,
        // 概算 (Phase 8 では暫定値)
        estimated: {
          maxUrls: body.payload.maxCompanies || body.payload.limit || 100,
          searchRequests: body.mode === 'category' ? 5 : 1,
          aiCalls: body.mode === 'nlq' ? 1 : 0,
          estimatedJpyMin: 10,
          estimatedJpyMax: 350,
        },
      });

      // バックグラウンドで実行開始
      const existingTargets = getExistingTargets(readTargetList);
      const existingHistory = getExistingHistory(getAllHistorySummary);

      // SSE ブロードキャスト
      const onProgress = (event) => broadcastProgress(run.runId, event);

      // setImmediate でレスポンス送信後に実行
      setImmediate(async () => {
        try {
          await orchestrator.runPipeline({
            mode: body.mode,
            payload: body.payload,
            runId: run.runId,
            options: {
              onProgress,
              existingTargets,
              existingHistory,
              criteria: body.payload,
            },
          });
        } catch (e) {
          broadcastProgress(run.runId, { type: 'error', runId: run.runId, error: e.message });
        } finally {
          closeAllSseClients(run.runId);
        }
      });
    } catch (e) {
      logInternalError('handleRun', e);
      jsonResponse(res, 500, { ok: false, error: 'internal_error' });
    }
  }

  // POST /api/list-builder/cli-run
  // 起動中の Claude/Codex/Gemini CLI に headless モードで「企業を探して JSON で
  // 返して」と依頼するシンプルな経路。SerpApi / 法人番号 API 不要。
  async function handleCliRun(req, res) {
    if (!cliAgentCtx) {
      jsonResponse(res, 503, { ok: false, error: 'cli_agent_unavailable' });
      return;
    }
    let body;
    try { body = await parseJsonBody(req); } catch (_) {
      jsonResponse(res, 400, { ok: false, error: 'invalid_body' }); return;
    }
    const query = String(body && body.query || '').trim();
    const limit = Math.max(1, Math.min(Number(body && body.limit) || 30, cliAgent.MAX_LIMIT));
    const provider = ['claude', 'codex', 'gemini'].includes(body && body.provider) ? body.provider : 'claude';
    if (!query) { jsonResponse(res, 400, { ok: false, error: 'query_required' }); return; }

    let run;
    try {
      run = runManager.createRun({ mode: 'nlq', payload: { query, limit, provider, agent: 'cli' } });
    } catch (e) {
      logInternalError('handleCliRun:createRun', e);
      jsonResponse(res, 500, { ok: false, error: 'internal_error' }); return;
    }

    jsonResponse(res, 200, {
      ok: true,
      runId: run.runId,
      status: 'running',
      mode: 'cli',
      provider,
    });

    setImmediate(async () => {
      const onProgress = (event) => broadcastProgress(run.runId, { runId: run.runId, ...event });
      onProgress({ type: 'progress', stage: 'discovery', message: provider + ' CLI に依頼中…' });
      try {
        const result: any = await cliAgent.runCliAgent({
          query, limit,
          providerId: provider,
          mode: 'bypassPermissions',
          ctx: cliAgentCtx,
          onProgress: (p) => onProgress({ type: 'progress', stage: 'streaming', ...p }),
        });

        if (!result.ok || !Array.isArray(result.candidates)) {
          runManager.updateRun(run.runId, { status: 'failed', error: result.error || 'no_candidates' });
          onProgress({ type: 'error', error: result.error || 'no_candidates', stderr: (result.stderr || '').slice(-500) });
          closeAllSseClients(run.runId);
          return;
        }

        const normalized = cliAgent.normalizeAgentRecords(result.candidates);

        // dedupe + suppression を既存ロジックで適用
        const existingTargets = getExistingTargets(readTargetList);
        const existingHistory = getExistingHistory(getAllHistorySummary);
        const existingRecords = [
          ...existingTargets.map((r: any) => ({ ...r, source: 'targets' })),
          ...existingHistory.map((r: any) => ({ ...r, source: 'history' })),
        ];
        // loadSuppressionList() は { version, records:[...] } を返すので records だけ渡す
        const supData = suppression.loadSuppressionList() || {};
        const supList = Array.isArray(supData.records) ? supData.records : (Array.isArray(supData) ? supData : []);
        const dedupeResults = dedupe.checkDuplicates(normalized, existingRecords, supList);
        const dedupedRecords = dedupeResults.map((r: any) => ({
          ...r.candidate,
          dedupeDecision: r.decision,
          dedupeMatchKey: r.matchKey || null,
          dedupeSimilarity: r.similarity || null,
        }));

        // checkDuplicates の decision: unique | duplicate | needs_review | suppressed
        const newCount = dedupedRecords.filter((r: any) => r.dedupeDecision === 'unique').length;
        const dupCount = dedupedRecords.filter((r: any) => r.dedupeDecision === 'duplicate' || r.dedupeDecision === 'suppressed').length;
        const reviewCount = dedupedRecords.filter((r: any) => r.dedupeDecision === 'needs_review').length;

        runManager.updateRun(run.runId, {
          status: 'completed',
          totalCandidates: dedupedRecords.length,
          verifiedCount: dedupedRecords.length,
          newCount, duplicateCount: dupCount, needsReviewCount: reviewCount,
          completedAt: new Date().toISOString(),
        });
        runManager.saveCandidates(run.runId, dedupedRecords);

        onProgress({
          type: 'done',
          stage: 'preview_ready',
          summary: { total: dedupedRecords.length, new: newCount, duplicate: dupCount, review: reviewCount },
        });
        closeAllSseClients(run.runId);
      } catch (e) {
        logInternalError('handleCliRun:exec', e);
        try { runManager.updateRun(run.runId, { status: 'failed', error: String(e && e.message || e) }); } catch (_) {}
        onProgress({ type: 'error', error: String(e && e.message || e) });
        closeAllSseClients(run.runId);
      }
    });
  }

  // GET /api/list-builder/stream/:runId  (SSE)
  async function handleStream(req, res, runId) {
    if (!isValidRunId(runId)) {
      jsonResponse(res, 400, { ok: false, error: 'invalid runId' });
      return;
    }
    // SSE 接続数の上限チェック (DoS 予防)
    const perRun = sseClients.get(runId);
    if (perRun && perRun.size >= MAX_SSE_PER_RUN) {
      jsonResponse(res, 429, { ok: false, error: 'too many listeners for this run' });
      return;
    }
    if (totalSseCount() >= MAX_SSE_TOTAL) {
      jsonResponse(res, 429, { ok: false, error: 'too many SSE listeners total' });
      return;
    }
    const run = runManager.getRun(runId);
    if (!run) {
      jsonResponse(res, 404, { ok: false, error: 'run not found' });
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    // 初回ハンドシェイク
    res.write(`event: open\ndata: ${JSON.stringify({ runId, status: run.status })}\n\n`);
    addSseClient(runId, res);

    // 既に完了した run の場合は最終結果を流して即終了
    if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled' || run.status === 'partial') {
      const candidates = sanitizeCandidatesForResponse(runManager.loadCandidates(runId));
      res.write(`event: result\ndata: ${JSON.stringify({ runId, records: candidates })}\n\n`);
      res.write(`event: done\ndata: ${JSON.stringify({ runId, status: run.status })}\n\n`);
      res.end();
      removeSseClient(runId, res);
      return;
    }

    // 接続切断ハンドラ
    req.on('close', () => removeSseClient(runId, res));
    req.on('error', () => removeSseClient(runId, res));
  }

  // POST /api/list-builder/commit
  async function handleCommit(req, res) {
    try {
      const body: any = await parseJsonBody(req);
      const { runId, recordIds } = body || {};
      if (!isValidRunId(runId) || !Array.isArray(recordIds)) {
        jsonResponse(res, 400, { ok: false, error: 'valid runId and recordIds required' });
        return;
      }
      // 空配列は明示的に拒否 (curl 経由で空 recordIds → 全件 commit を防ぐ)
      if (recordIds.length === 0) {
        jsonResponse(res, 400, { ok: false, error: 'recordIds must not be empty' });
        return;
      }
      if (recordIds.length > 1000) {
        jsonResponse(res, 400, { ok: false, error: 'too many recordIds' });
        return;
      }
      const candidates = runManager.loadCandidates(runId);
      if (!candidates || candidates.length === 0) {
        jsonResponse(res, 404, { ok: false, error: 'run candidates not found' });
        return;
      }

      const recordIdSet = new Set(recordIds.map(String));
      let appended = 0, skippedDuplicate = 0, flaggedSimilar = 0, skippedBlocked = 0, appendFailed = 0;
      const duplicateDetails: unknown[] = [];
      const threshold = settings.getListBuilderConfig?.()?.dedupeThreshold || 0.9;
      const supList = suppression.loadSuppressionList();
      const existingRecords = buildExistingRecords(readTargetList, getAllHistorySummary);

      for (const c of candidates) {
        // recordIds は空でないことを上で検証済み。指定 ID のみ commit。
        if (!recordIdSet.has(String(c.id || c.url))) continue;

        // コンプライアンス・取得不能系は、UI が改ざんされても commit させない。
        if (hasCommitBlockingRisk(c)) {
          skippedBlocked++;
          duplicateDetails.push({
            record: { companyName: c.companyName, url: c.url },
            matchedAgainst: null,
            reason: c.blockReason || (Array.isArray(c.riskFlags) ? c.riskFlags.join(',') : 'blocked'),
          });
          continue;
        }

        // プレビュー時点で duplicate/suppressed と判定されていたものはスキップ
        if (c.dedupeDecision === 'duplicate' || c.dedupeDecision === 'suppressed') {
          skippedDuplicate++;
          duplicateDetails.push({
            record: { companyName: c.companyName, url: c.url },
            matchedAgainst: sanitizeDuplicateMatch(c.dedupeMatchedAgainst),
            reason: c.dedupeDecision,
          });
          continue;
        }

        // commit 直前に最新 targets/history/suppression と再照合する。
        // run 作成後に別経路で同じ会社が追加された場合でも、ここで止める。
        const finalDedupe = dedupe.checkDuplicate(c, existingRecords, supList.records || [], {
          fuzzyThreshold: threshold,
        });
        if (finalDedupe.decision === 'duplicate' || finalDedupe.decision === 'suppressed') {
          skippedDuplicate++;
          duplicateDetails.push({
            record: { companyName: c.companyName, url: c.url },
            matchedAgainst: sanitizeDuplicateMatch(finalDedupe.matchedAgainst),
            reason: finalDedupe.reason || finalDedupe.decision,
          });
          continue;
        }
        if (c.dedupeDecision === 'needs_review' || finalDedupe.decision === 'needs_review') {
          flaggedSimilar++;
          // ユーザーが明示的に選択した場合は追加
        }

        try {
          const r = appendCompany(buildTargetListPayload(c, runId));
          if (r && r.ok !== false) {
            appended++;
            const targetNo = r.company?.no || r.no || r.companyNo || '';
            existingRecords.push({
              ...(r.company || {}),
              ...c,
              no: targetNo,
              source: 'targets',
            });
            try {
              runManager.saveCommittedRecordArtifacts({ runId, targetNo, record: c });
            } catch (artifactError) {
              logInternalError('saveCommittedRecordArtifacts', artifactError);
            }
          } else {
            appendFailed++;
          }
        } catch (e) {
          appendFailed++;
        }
      }

      if (appended > 0) {
        try {
          const run = runManager.getRun(runId);
          const previous = Number(run?.committedCount || 0);
          runManager.updateRun(runId, {
            committedCount: previous + appended,
            lastCommittedAt: new Date().toISOString(),
          });
        } catch (_) {}
      }

      jsonResponse(res, 200, {
        ok: true,
        appended,
        skippedDuplicate,
        flaggedSimilar,
        skippedBlocked,
        appendFailed,
        duplicateDetails,
      });
    } catch (e) {
      logInternalError('handleCommit', e);
      jsonResponse(res, 500, { ok: false, error: 'internal_error' });
    }
  }

  // GET /api/list-builder/runs
  function handleListRuns(req, res, searchParams) {
    try {
      const filter: Record<string, unknown> = {};
      const status = searchParams && searchParams.get('status');
      const mode = searchParams && searchParams.get('mode');
      // 列挙値以外は無視 (任意文字列が listRuns に渡らないようにする)
      if (status && STATUS_ENUM.has(status)) filter.status = status;
      if (mode && MODE_ENUM.has(mode)) filter.mode = mode;
      const runs = runManager.listRuns(filter);
      jsonResponse(res, 200, { ok: true, runs });
    } catch (e) {
      logInternalError('handleListRuns', e);
      jsonResponse(res, 500, { ok: false, error: 'internal_error' });
    }
  }

  // GET /api/list-builder/runs/:runId
  function handleGetRun(req, res, runId) {
    if (!isValidRunId(runId)) {
      jsonResponse(res, 400, { ok: false, error: 'invalid runId' });
      return;
    }
    const run = runManager.getRun(runId);
    if (!run) {
      jsonResponse(res, 404, { ok: false, error: 'run not found' });
      return;
    }
    const candidates = sanitizeCandidatesForResponse(runManager.loadCandidates(runId));
    jsonResponse(res, 200, { ok: true, run, candidates });
  }

  // POST /api/list-builder/runs/:runId/cancel
  function handleCancel(req, res, runId) {
    if (!isValidRunId(runId)) {
      jsonResponse(res, 400, { ok: false, error: 'invalid runId' });
      return;
    }
    const run = runManager.getRun(runId);
    if (!run) {
      jsonResponse(res, 404, { ok: false, error: 'run not found' });
      return;
    }
    runManager.requestCancel(runId);
    jsonResponse(res, 200, { ok: true, runId });
  }

  // POST /api/list-builder/runs/:runId/retry-failed
  async function handleRetryFailed(req, res, runId) {
    if (!isValidRunId(runId)) {
      jsonResponse(res, 400, { ok: false, error: 'invalid runId' });
      return;
    }
    try {
      const r: any = await orchestrator.retryFailed(runId);
      jsonResponse(res, r.ok ? 200 : 400, r);
    } catch (e) {
      logInternalError('handleRetryFailed', e);
      jsonResponse(res, 500, { ok: false, error: 'internal_error' });
    }
  }

  // DELETE /api/list-builder/runs/:runId
  function handleDeleteRun(req, res, runId) {
    if (!isValidRunId(runId)) {
      jsonResponse(res, 400, { ok: false, error: 'invalid runId' });
      return;
    }
    const r = runManager.deleteRun(runId);
    jsonResponse(res, r.ok ? 200 : 404, r);
  }

  // GET /api/list-builder/api-key-status (UI 向け)
  function handleApiKeyStatus(req, res) {
    try {
      const status = typeof settings.getApiKeyStatus === 'function'
        ? settings.getApiKeyStatus()
        : {};
      jsonResponse(res, 200, { ok: true, apiKeys: status });
    } catch (e) {
      logInternalError('handleApiKeyStatus', e);
      // フォールバックで空オブジェクトを返す（UIロック判定のため 200 を維持）
      jsonResponse(res, 200, { ok: true, apiKeys: {} });
    }
  }

  function handleListSuppressions(req, res, searchParams) {
    try {
      const filter: Record<string, unknown> = {};
      const type = searchParams && searchParams.get('type');
      const reason = searchParams && searchParams.get('reason');
      if (type) filter.type = type;
      if (reason) filter.reason = reason;
      jsonResponse(res, 200, { ok: true, records: suppression.listSuppressions(filter) });
    } catch (e) {
      logInternalError('handleListSuppressions', e);
      jsonResponse(res, 500, { ok: false, error: 'internal_error' });
    }
  }

  async function handleAddSuppression(req, res) {
    try {
      const body: any = await parseJsonBody(req);
      const r = suppression.addSuppression(body);
      jsonResponse(res, r.ok ? 200 : 400, r);
    } catch (e) {
      logInternalError('handleAddSuppression', e);
      jsonResponse(res, 500, { ok: false, error: 'internal_error' });
    }
  }

  function handleDeleteSuppression(req, res, id) {
    try {
      if (!id || id.length > 100 || !/^[a-zA-Z0-9_-]+$/.test(id)) {
        jsonResponse(res, 400, { ok: false, error: 'invalid id' });
        return;
      }
      const r = suppression.removeSuppression(id);
      jsonResponse(res, r.ok ? 200 : 404, r);
    } catch (e) {
      logInternalError('handleDeleteSuppression', e);
      jsonResponse(res, 500, { ok: false, error: 'internal_error' });
    }
  }

  function handleExportRun(req, res, runId, format) {
    if (!isValidRunId(runId)) {
      jsonResponse(res, 400, { ok: false, error: 'invalid runId' });
      return;
    }
    const run = runManager.getRun(runId);
    if (!run) {
      jsonResponse(res, 404, { ok: false, error: 'run not found' });
      return;
    }
    const candidates = sanitizeCandidatesForResponse(runManager.loadCandidates(runId));
    if (format === 'json') {
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Disposition': `attachment; filename="${runId}.json"`,
      });
      res.end(JSON.stringify({ ok: true, run, candidates }, null, 2));
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Disposition': `attachment; filename="${runId}.csv"`,
    });
    res.end(candidatesToCsv(candidates));
  }

  return async function dispatch(req, res, pathname, searchParams) {
    const method = req.method;

    if (pathname === '/list-builder' && method === 'GET') {
      handlePage(req, res);
      return true;
    }

    if (pathname === '/api/list-builder/run' && method === 'POST') {
      await handleRun(req, res);
      return true;
    }
    if (pathname === '/api/list-builder/cli-run' && method === 'POST') {
      await handleCliRun(req, res);
      return true;
    }
    if (pathname === '/api/list-builder/commit' && method === 'POST') {
      await handleCommit(req, res);
      return true;
    }
    if (pathname === '/api/list-builder/runs' && method === 'GET') {
      handleListRuns(req, res, searchParams);
      return true;
    }
    if (pathname === '/api/list-builder/api-key-status' && method === 'GET') {
      handleApiKeyStatus(req, res);
      return true;
    }
    if (pathname === '/api/list-builder/suppressions') {
      if (method === 'GET') { handleListSuppressions(req, res, searchParams); return true; }
      if (method === 'POST') { await handleAddSuppression(req, res); return true; }
    }

    // /api/list-builder/stream/:runId
    let m = pathname.match(/^\/api\/list-builder\/stream\/([\w-]+)$/);
    if (m && method === 'GET') {
      await handleStream(req, res, m[1]);
      return true;
    }
    // /api/list-builder/runs/:runId/export.csv|json
    m = pathname.match(/^\/api\/list-builder\/runs\/([\w-]+)\/export\.(csv|json)$/);
    if (m && method === 'GET') {
      handleExportRun(req, res, m[1], m[2]);
      return true;
    }
    // /api/list-builder/runs/:runId
    m = pathname.match(/^\/api\/list-builder\/runs\/([\w-]+)$/);
    if (m) {
      if (method === 'GET') { handleGetRun(req, res, m[1]); return true; }
      if (method === 'DELETE') { handleDeleteRun(req, res, m[1]); return true; }
    }
    // /api/list-builder/runs/:runId/cancel
    m = pathname.match(/^\/api\/list-builder\/runs\/([\w-]+)\/cancel$/);
    if (m && method === 'POST') {
      handleCancel(req, res, m[1]);
      return true;
    }
    // /api/list-builder/runs/:runId/retry-failed
    m = pathname.match(/^\/api\/list-builder\/runs\/([\w-]+)\/retry-failed$/);
    if (m && method === 'POST') {
      await handleRetryFailed(req, res, m[1]);
      return true;
    }
    // /api/list-builder/suppressions/:id
    m = pathname.match(/^\/api\/list-builder\/suppressions\/([\w-]+)$/);
    if (m && method === 'DELETE') {
      handleDeleteSuppression(req, res, m[1]);
      return true;
    }

    return false;
  };
};

// テスト用エクスポート
module.exports.validateRunInput = validateRunInput;
module.exports.broadcastProgress = broadcastProgress;

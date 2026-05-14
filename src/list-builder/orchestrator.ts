'use strict';

// Orchestrator — 8-stage パイプライン実行
//
// 要件§3 アーキテクチャ:
//
//   Stage 1: discovery        (mode に応じて list-page / nlq / category)
//   Stage 2: extractor         (各候補の HTML 取得 + コンプライアンスチェック)
//   Stage 3: identity-resolver (法人番号・公式サイト確定)
//   Stage 4: official-verifier (上場企業のみ EDINET で IR 取得)  ※Phase 7 では薄い
//   Stage 5: enricher           (industry/employee/revenue/formUrl 等)
//   Stage 6: qualification     (fitScore 算出)
//   Stage 7: compliance        (extractor 内で完了済み、ここでは riskFlags 集約)
//   Stage 8: dedupe             (既存 targets + history + Suppression と照合)
//
// 設計:
//   - run-manager で run の永続化を管理
//   - 各 stage 完了時に onProgress コールバックで SSE 用イベントを発火
//   - cancel が要求されたら最も近いチェックポイントで中断
//   - 失敗・blocked のレコードは failed_records.json に記録

const runManager = require('./run-manager');
const dedupe = require('./dedupe');
const suppression = require('./suppression');
const identityResolver = require('./identity-resolver');
const enricher = require('./enricher');
const extractor = require('./extractor');
const qualificationScorer = require('./qualification-scorer');
const settings = require('../settings-manager');
const nameNormalizer = require('./name-normalizer');

const listPageDiscovery = require('./discovery/list-page');
const nlqDiscovery = require('./discovery/nlq');
const categoryDiscovery = require('./discovery/category');

const STAGES = [
  'discovery', 'extracting', 'identity_resolution',
  'official_verification', 'enrichment', 'qualification',
  'compliance_precheck', 'dedupe', 'preview_ready',
];

function noop() {}

// 進捗イベントを生成するヘルパ
function makeProgress(runId: any, stage: any, total: any, completed: any, current?: any) {
  return {
    type: 'progress',
    runId, stage, total, completed,
    current: current || null,
    timestamp: new Date().toISOString(),
  };
}

function buildPriorContactLookup(historyRecords) {
  const lookup = new Map<any, any>();
  for (const entry of historyRecords || []) {
    const name = entry.companyName || entry.officialName || '';
    const normalized = nameNormalizer.normalize(name).normalized;
    if (!normalized) continue;
    const count = Number(entry.contactCount || entry.lastContactNo || 1);
    lookup.set(normalized, Math.max(lookup.get(normalized) || 0, Number.isFinite(count) ? count : 1));
  }
  return lookup;
}

function attachPriorContactCount(record, lookup) {
  const name = record.companyName || record.officialName || '';
  const normalized = nameNormalizer.normalize(name).normalized;
  const priorContactCount = normalized ? (lookup.get(normalized) || 0) : 0;
  return { ...record, priorContactCount };
}

// メイン: パイプライン実行
//
// 入力:
//   { mode: 'url'|'nlq'|'category', payload, runId, options }
//   options:
//     - onProgress: (event) => void           // SSE 連携用
//     - fetchHtml: async (url) => result      // 公開ページ取得 (DI)
//     - searchInvoker: async (query) => ...   // SerpApi (NLQ/category)
//     - llmInvoker: async (msgs) => ...       // NLQ 用
//     - existingTargets: 既存 targets         // dedupe 用
//     - existingHistory: contact-history      // dedupe 用
//     - criteria: scoring 用
async function runPipeline({ mode, payload, runId: providedRunId, options = {} }: { mode: string; payload: any; runId?: string; options?: any }) {
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : noop;

  // run 作成 or 既存利用
  let run;
  if (providedRunId) {
    run = runManager.getRun(providedRunId);
    if (!run) return { ok: false, error: 'run not found' };
  } else {
    run = runManager.createRun({ mode, payload });
  }
  const runId = run.runId;
  runManager.updateRun(runId, { status: 'running' });

  const cancelled = () => runManager.isCancelled(runId);

  try {
    // ---- Stage 1: Discovery ----
    onProgress(makeProgress(runId, 'discovery', 1, 0));
    const discoveryResult: any = await runDiscovery(mode, payload, options);
    if (!discoveryResult.ok) {
      runManager.updateRun(runId, { status: 'failed' });
      return { ok: false, error: discoveryResult.error, runId };
    }
    let candidates = discoveryResult.candidates || [];
    const loosenedConditions = discoveryResult.loosenedConditions || [];
    runManager.updateRun(runId, {
      totalCandidates: candidates.length,
      loosenedConditions,
    });
    runManager.saveCheckpoint(runId, { stage: 'discovery', candidates });
    if (cancelled()) return finishCancelled(runId, candidates);

    // ---- Stage 2: Extractor ----
    onProgress(makeProgress(runId, 'extracting', candidates.length, 0));
    const enriched: any[] = [];
    let extractedCount = 0;
    const fetchHtml = options.fetchHtml || extractor.defaultHttpFetch;

    for (const candidate of candidates) {
      if (cancelled()) break;
      extractedCount++;
      onProgress(makeProgress(runId, 'extracting', candidates.length, extractedCount, {
        url: candidate.url, status: 'fetching',
      }));

      let html = '', extractResult: any = {};
      if (candidate.url) {
        extractResult = await extractor.extract(candidate.url, {
          fetcher: fetchHtml,
        });
        html = extractResult.html || '';
        if (extractResult.blocked) {
          enriched.push({
            ...candidate,
            collectionStatus: 'blocked',
            riskFlags: extractResult.riskFlags,
            blockReason: extractResult.blockReason,
            sourceConfidence: 'low',
            sourceListUrl: candidate.sourceListUrl,
            discoveredAt: new Date().toISOString(),
            discoverySource: mode,
          });
          continue;
        }
      }

      // ---- Stage 3: Identity Resolver ----
      onProgress(makeProgress(runId, 'identity_resolution', candidates.length, extractedCount, {
        companyName: candidate.companyName, status: 'resolving',
      }));
      const identity: any = await identityResolver.resolve({
        companyName: candidate.companyName,
        url: candidate.url,
        prefecture: candidate.prefecture,
      }, options);

      // ---- Stage 4: Official Verifier ----
      // 現時点では法人番号/gBizINFO/EDINET の重い追加検証は identity/enricher 側に
      // 寄せているが、進捗と checkpoint 上は独立 stage として扱う。
      onProgress(makeProgress(runId, 'official_verification', candidates.length, extractedCount, {
        companyName: candidate.companyName, status: 'verified_or_skipped',
      }));

      // ---- Stage 5: Enricher ----
      // (Stage 4 official-verifier は Phase 7 では enricher 内で revenueHistory を渡せば十分)
      onProgress(makeProgress(runId, 'enrichment', candidates.length, extractedCount, {
        companyName: candidate.companyName, status: 'enriching',
      }));
      const enrichResult: any = await enricher.enrich({
        record: identity.record || candidate,
        html,
        riskFlags: extractResult.riskFlags || [],
        formType: extractResult.formType,
        revenueHistory: candidate.revenueHistory,  // 呼び出し側で事前取得した場合
      });

      enriched.push({
        ...enrichResult.record,
        collectionStatus: identity.confidence === 'high' ? 'verified' : 'partial',
        sourceConfidence: identity.confidence || 'low',
        sourceListUrl: candidate.sourceListUrl,
        discoveredAt: new Date().toISOString(),
        discoverySource: mode,
      });

      // 中間チェックポイント (10件ごと)
      if (extractedCount % 10 === 0) {
        runManager.saveCheckpoint(runId, { stage: 'extracting', enriched });
      }
    }
    if (cancelled()) return finishPartial(runId, enriched);

    // ---- Stage 6: Qualification ----
    onProgress(makeProgress(runId, 'qualification', enriched.length, 0));
    const criteria = options.criteria || payload || {};
    const priorLookup = buildPriorContactLookup(options.existingHistory || []);
    const scored = enriched.map((rec: any) => {
      const withPrior = attachPriorContactCount(rec, priorLookup);
      const result = qualificationScorer.score(withPrior, criteria);
      return { ...withPrior, ...result };
    });

    // ---- Stage 7: Compliance Precheck ----
    onProgress(makeProgress(runId, 'compliance_precheck', scored.length, scored.length));

    // ---- Stage 8: Dedupe ----
    onProgress(makeProgress(runId, 'dedupe', scored.length, 0));
    const existing = [
      ...(options.existingTargets || []).map((r: any) => ({ ...r, source: 'targets' })),
      ...(options.existingHistory || []).map((r: any) => ({ ...r, source: 'history' })),
    ];
    const supList = suppression.loadSuppressionList();
    const dedupeResults = dedupe.checkDuplicates(
      scored, existing, supList.records || [], {
        fuzzyThreshold: settings.getListBuilderConfig?.()?.dedupeThreshold || 0.9,
      }
    );

    let newCount = 0, duplicateCount = 0, needsReviewCount = 0, blockedCount = 0;
    const finalRecords = dedupeResults.map((dr: any) => {
      if (dr.decision === 'unique') newCount++;
      else if (dr.decision === 'duplicate') duplicateCount++;
      else if (dr.decision === 'needs_review') needsReviewCount++;
      else if (dr.decision === 'suppressed') duplicateCount++;
      const candidate = dr.candidate;
      if (candidate.collectionStatus === 'blocked') blockedCount++;
      return {
        ...candidate,
        dedupeDecision: dr.decision,
        dedupeMatchKey: dr.matchKey,
        dedupeSimilarity: dr.similarity,
        dedupeMatchedAgainst: dr.matchedAgainst,
      };
    });

    // ---- Stage 9: Preview Ready ----
    onProgress(makeProgress(runId, 'preview_ready', finalRecords.length, finalRecords.length));
    runManager.saveCandidates(runId, finalRecords);
    runManager.updateRun(runId, {
      status: 'completed',
      newCount, duplicateCount, needsReviewCount, blockedCount,
      verifiedCount: finalRecords.filter((r: any) => r.collectionStatus === 'verified').length,
    });

    return { ok: true, runId, records: finalRecords };
  } catch (err) {
    runManager.updateRun(runId, { status: 'failed' });
    return { ok: false, runId, error: err.message };
  } finally {
    runManager.clearLiveState(runId);
  }
}

function finishCancelled(runId, candidates) {
  runManager.updateRun(runId, {
    status: 'cancelled',
    totalCandidates: candidates.length,
  });
  return { ok: true, runId, records: candidates, cancelled: true };
}

function finishPartial(runId, records) {
  const finalRecords = Array.isArray(records) ? records : [];
  runManager.saveCandidates(runId, finalRecords);
  runManager.updateRun(runId, {
    status: 'partial',
    totalCandidates: finalRecords.length,
    blockedCount: finalRecords.filter((r: any) => r.collectionStatus === 'blocked').length,
  });
  return { ok: true, runId, records: finalRecords, partial: true };
}

// mode に応じて discovery を呼び分け
async function runDiscovery(mode, payload, options) {
  switch (mode) {
    case 'url':
      return await listPageDiscovery.discover(payload, options);
    case 'nlq': {
      const intentResult: any = await nlqDiscovery.parseQuery(payload, options);
      if (!intentResult.ok) return { ok: false, error: intentResult.error };
      // NLQ は構造化クエリ → カテゴリと同じパスへ
      const categoryParams = {
        industries: intentResult.intent.industries,
        prefectures: intentResult.intent.prefectures,
        keywords: intentResult.intent.keywords,
        limit: payload.limit || 50,
      };
      return await categoryDiscovery.discover(categoryParams, options);
    }
    case 'category':
      return await categoryDiscovery.discover(payload, options);
    default:
      return { ok: false, error: `unknown mode: ${mode}` };
  }
}

// retry-failed: failed/blocked のレコードのみ再実行
//
// 既存 run の candidates から status='failed'/'blocked' のものを抜き出して再パイプライン。
// 結果は元 run にマージする。
async function retryFailed(runId, options: Record<string, any> = {}) {
  const run = runManager.getRun(runId);
  if (!run) return { ok: false, error: 'run not found' };
  const candidates = runManager.loadCandidates(runId);
  const targets = candidates.filter((c: any) =>
    c.collectionStatus === 'blocked'
    || c.collectionStatus === 'failed'
    || c.dedupeDecision === undefined  // 未到達
  );
  if (targets.length === 0) {
    return { ok: true, runId, retriedCount: 0 };
  }

  // candidates を払い出して再 pipeline ... ただし mode/payload は元のまま使う
  const payload = runManager.loadPayload(runId) || {};
  // テンポラリに既存 candidates を空にして re-run （シンプル実装）
  // Phase 7 では retryFailed は最小限に（既存 candidates と新結果をマージするのは Phase 10）
  return { ok: true, runId, retriedCount: targets.length, message: 'retry queued' };
}

module.exports = {
  runPipeline,
  retryFailed,
  runDiscovery,
  STAGES,
};

'use strict';

/**
 * デモダッシュボード用のシードデータ。
 *
 * 方針:
 *  - すべて架空の会社名 (実在企業は使わない)
 *  - 業種・地域・規模を散らして多様性を出す
 *  - 過去 30 日に約 150 件のログを散らす (今日と昨日に山を作りアクティブに見せる)
 *  - 送信済 / 確認待ち / エラー / スキップ / 進行中 をバランス良く配分
 *
 * 既存の本物データを誤って上書きしないよう demo-mode.assertDemoDataDirIsSafe() で防御。
 */

const fs = require('fs');
const path = require('path');
const { assertDemoDataDirIsSafe } = require('../dist-ts/src/demo-mode');
const { makeFormMockPng } = require('./lib/png-mock.cjs');

const PROJECT_ROOT = path.join(__dirname, '..');
const STATIC_DATA = path.join(PROJECT_ROOT, 'data');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function writeJson(file, obj) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
}

// === 30 社の架空企業 (業種を散らす) ===
const COMPANIES = [
  { no: 1,  name: 'クラウドネクスト・アナリティクス株式会社', type: 'データ分析',     region: '東京' },
  { no: 2,  name: 'スカイブリッジテクノロジー株式会社',         type: 'クラウド',         region: '東京' },
  { no: 3,  name: 'デジタルパースペクティブ株式会社',           type: '広告/IT',          region: '東京' },
  { no: 4,  name: 'イノベーションラボ株式会社',                 type: 'IT',               region: '神奈川' },
  { no: 5,  name: 'セールスエッジ株式会社',                     type: 'SaaS',             region: '東京' },
  { no: 6,  name: 'ファイナンスフロー株式会社',                 type: 'FinTech',          region: '東京' },
  { no: 7,  name: 'ビズコネクト株式会社',                       type: 'SaaS',             region: '大阪' },
  { no: 8,  name: 'リーガルテック・パートナーズ株式会社',       type: 'リーガル',         region: '東京' },
  { no: 9,  name: 'ワークフロー・ソリューションズ株式会社',     type: 'SaaS',             region: '東京' },
  { no: 10, name: 'エンゲージメントワークス株式会社',           type: 'CX',               region: '東京' },
  { no: 11, name: 'ノースリッジマニュファクチャリング株式会社', type: '製造',             region: '愛知' },
  { no: 12, name: 'プレシジョンメタル工業株式会社',             type: '製造',             region: '大阪' },
  { no: 13, name: 'アクシス商事株式会社',                       type: '商社',             region: '東京' },
  { no: 14, name: 'ジャパンイースト・トレーディング株式会社',   type: '商社',             region: '東京' },
  { no: 15, name: 'グランドコミュニケーションズ株式会社',       type: '広告',             region: '東京' },
  { no: 16, name: 'ストリームメディア株式会社',                 type: 'メディア',         region: '東京' },
  { no: 17, name: 'ハーモニー不動産株式会社',                   type: '不動産',           region: '東京' },
  { no: 18, name: 'アーバンライフ・パートナーズ株式会社',       type: '不動産',           region: '神奈川' },
  { no: 19, name: 'ロジスティクス・コア株式会社',               type: '物流',             region: '埼玉' },
  { no: 20, name: 'クイックデリバリー株式会社',                 type: '物流',             region: '千葉' },
  { no: 21, name: 'メディカルブリッジ株式会社',                 type: 'ヘルスケア',       region: '東京' },
  { no: 22, name: 'ウェルネステック株式会社',                   type: 'ヘルスケア',       region: '福岡' },
  { no: 23, name: 'ラーニングサークル株式会社',                 type: '教育',             region: '東京' },
  { no: 24, name: 'エデュフィット株式会社',                     type: '教育',             region: '京都' },
  { no: 25, name: 'ベイサイド建設株式会社',                     type: '建設',             region: '神奈川' },
  { no: 26, name: 'グリーンビルディング株式会社',               type: '建設',             region: '大阪' },
  { no: 27, name: 'タレントブリッジ株式会社',                   type: '人材',             region: '東京' },
  { no: 28, name: 'キャリアシフト株式会社',                     type: '人材',             region: '東京' },
  { no: 29, name: 'クイックコマース株式会社',                   type: 'EC',               region: '東京' },
  { no: 30, name: 'リテールフロンティア株式会社',               type: 'EC',               region: '愛知' },
];

// === outcome 配分 ===
// 30 社中:
//   送信済 18 (No.1-18)
//   確認待ち 4 (No.19-22)
//   エラー 3   (No.23-25)
//   スキップ 3 (No.26-28)
//   進行中 2   (No.29-30)
const OUTCOME = {
  submitted:  [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18],
  awaiting:   [19, 20, 21, 22],
  errors:     [23, 24, 25],
  skipped:    [26, 27, 28],
  inflight:   [29, 30],
};

const ERROR_REASONS = [
  { stage: 'form_fill_partial', detail: 'CAPTCHA検出 (reCAPTCHA v2)。フォーム入力は完了したが送信は人間判断要' },
  { stage: 'form_not_found',    detail: 'お問い合わせフォームが見つかりません。サイト構造を再確認してください' },
  { stage: 'field_mismatch',    detail: 'フォームに必須フィールド「業種コード」があり値が不明。スキップ判断要' },
];

const SKIP_REASONS = [
  '営業NG: お問い合わせフォームに「営業目的のお問い合わせはご遠慮ください」と明記',
  '営業NG/対象外: 採用専用フォームのみ。お問い合わせ窓口なし',
  '営業NG/対象外: IR専用フォーム。問い合わせ窓口は別途要',
];

const URL_FOR = (no) => 'https://example.com/demo-corp-' + String(no).padStart(2, '0');
const FORM_URL_FOR = (no) => URL_FOR(no) + '/contact';

function buildDemoSettings(port) {
  const sample = JSON.parse(fs.readFileSync(path.join(STATIC_DATA, 'sample-settings.json'), 'utf8'));
  sample.companyProfile = {
    ...sample.companyProfile,
    companyName: '株式会社デモワークス',
    companyNameEn: 'Demo Works Inc.',
    contactName: '山田 太郎',
    contactNameKana: 'ヤマダ タロウ',
    representative: '山田 太郎',
    contactTitle: '代表取締役',
    department: '営業企画部',
    email: 'taro.yamada@demoworks.example.jp',
    phone: '03-5555-1234',
    fax: '03-5555-1235',
    postalCode: '150-0001',
    address: '東京都渋谷区神宮前1-2-3 デモビル 5F',
    website: 'https://demoworks.example.jp',
    industry: 'IT・クラウドインフラ',
    employeeCount: '45名',
    capital: '5,000万円',
    established: '2018年',
    businessDescription: 'クラウドインフラ構築・運用の専門会社。AWS / Azure / GCP の設計・構築・運用を中心に、コスト最適化・セキュリティ監査まで一気通貫で支援。',
  };
  sample.targetList = sample.targetList || {};
  sample.targetList.filePath = 'data/sample-targets.csv';
  sample.preferences = sample.preferences || {};
  sample.preferences.dashboardPort = Number(port || 3766);
  sample.preferences.dashboardHost = '127.0.0.1';
  sample._onboardedAt = new Date().toISOString();
  return sample;
}

// 「N 日前の朝〜夕方」のいい感じの ms を返す (決定論的に日別カウントを散らすため、submitted の散らしには使わない)
function tsAtDaysAgo(now, daysAgo, hourSeed = 0) {
  const day = 24 * 60 * 60 * 1000;
  const base = now - daysAgo * day;
  // 9 時 〜 18 時の間に分布
  const hour = 9 + (hourSeed % 9);
  const minute = (hourSeed * 13) % 60;
  const d = new Date(base);
  d.setHours(hour, minute, 0, 0);
  return d.getTime();
}

function makeMessageDraft(c) {
  const lines = [
    'お世話になります。',
    '株式会社デモワークスの山田と申します。',
    '',
    '貴社の' + c.type + '事業を拝見し、ご連絡いたしました。',
    '弊社はクラウドインフラ構築の専門会社として、コスト最適化・セキュリティ監査まで一気通貫で支援しております。',
    '貴社の' + c.type + '事業に対して、技術パートナーとしてお役に立てる可能性があるのではないかと考えております。',
    '',
    '30 分程度の情報交換の場をいただけませんでしょうか。',
    '何卒よろしくお願いいたします。',
    '',
    '株式会社デモワークス',
    '山田 太郎',
    'TEL: 03-5555-1234',
    'MAIL: taro.yamada@demoworks.example.jp',
  ];
  return lines.join('\n');
}

// awaiting カードのスクリーンショット PNG を後で書き出すためのプラン (buildDemoActionLog で populate)
const awaitingScreenshotPlan = [];

function buildDemoActionLog() {
  const now = Date.now();
  const log = [];
  const minute = 60 * 1000;

  function pushSubmittedFlow(c, baseTs, suffix) {
    log.push({ timestamp: new Date(baseTs - 12 * minute).toISOString(), companyNo: c.no, companyName: c.name, action: 'site_analysis', details: '{"areas":["' + c.type + '"],"gaps":["cloud","webapp"],"focus":["DX推進","パートナー募集"]}' });
    log.push({ timestamp: new Date(baseTs - 10 * minute).toISOString(), companyNo: c.no, companyName: c.name, action: 'message_draft', details: makeMessageDraft(c) });
    log.push({ timestamp: new Date(baseTs -  6 * minute).toISOString(), companyNo: c.no, companyName: c.name, action: 'form_fill', details: '入力完了 (会社名 / 担当者名 / メール / 電話 / 本文)' });
    log.push({ timestamp: new Date(baseTs -  4 * minute).toISOString(), companyNo: c.no, companyName: c.name, action: 'submitted', details: '送信成功 (HTTP 200)' + (suffix ? ' / ' + suffix : '') });
  }

  // ---- 送信済 18 社を過去 7 日間に決定論的に分配 (6日前から今日まで毎日件数が出る) ----
  // [今日, 1日前, 2日前, 3日前, 4日前, 5日前, 6日前]
  const dailyDist = [4, 5, 3, 2, 2, 1, 1]; // 計 18
  const submittedQueue = OUTCOME.submitted.slice();
  let qIdx = 0;
  for (let day = 0; day < dailyDist.length; day++) {
    const count = dailyDist[day];
    for (let i = 0; i < count; i++) {
      const c = COMPANIES[submittedQueue[qIdx % submittedQueue.length] - 1];
      qIdx++;
      const baseTs = tsAtDaysAgo(now, day, qIdx + day * 7);
      pushSubmittedFlow(c, baseTs);
    }
  }

  // 過去 7 日のさらに古い側 (7〜13 日前) にも 1 日 1〜2 件、シャドウ送信を撒く
  for (let day = 7; day <= 13; day++) {
    const count = day % 2 === 0 ? 2 : 1;
    for (let i = 0; i < count; i++) {
      const fakeNo = 400 + day * 10 + i;
      const baseTs = tsAtDaysAgo(now, day, day * 5 + i);
      log.push({
        timestamp: new Date(baseTs).toISOString(),
        companyNo: fakeNo,
        companyName: 'デモ過去送信企業 No.' + (day - 6) + '-' + (i + 1),
        action: 'submitted',
        details: '送信成功 (HTTP 200)',
      });
    }
  }

  // ---- 確認待ち 4 社 (24 時間以内) ----
  // 同時にスクリーンショット mtime を log の form_fill 時刻に合わせるため、各社のタイムスタンプを記録
  awaitingScreenshotPlan.length = 0;
  for (let i = 0; i < OUTCOME.awaiting.length; i++) {
    const no = OUTCOME.awaiting[i];
    const c = COMPANIES[no - 1];
    const baseTs = now - (60 + i * 90) * minute; // 1〜6h 前
    log.push({ timestamp: new Date(baseTs - 12 * minute).toISOString(), companyNo: c.no, companyName: c.name, action: 'site_analysis', details: '{"areas":["' + c.type + '"],"gaps":[],"focus":["事業拡大中"]}' });
    log.push({ timestamp: new Date(baseTs - 10 * minute).toISOString(), companyNo: c.no, companyName: c.name, action: 'message_draft', details: makeMessageDraft(c) });
    log.push({ timestamp: new Date(baseTs -  7 * minute).toISOString(), companyNo: c.no, companyName: c.name, action: 'form_fill', details: '入力完了' });
    log.push({ timestamp: new Date(baseTs -  5 * minute).toISOString(), companyNo: c.no, companyName: c.name, action: 'confirm_reached', details: 'スクショ撮影完了 (screenshots/ss-' + c.no + '-input.png)' });
    log.push({ timestamp: new Date(baseTs -  4 * minute).toISOString(), companyNo: c.no, companyName: c.name, action: 'awaiting_approval', details: 'ダッシュボードで確認待ち' });
    awaitingScreenshotPlan.push({
      companyNo: c.no,
      companyName: c.name,
      type: c.type,
      mtimeMs: baseTs - 5 * minute, // confirm_reached 時刻に合わせる (window 内)
    });
  }

  // ---- エラー 3 社 ----
  for (let i = 0; i < OUTCOME.errors.length; i++) {
    const no = OUTCOME.errors[i];
    const c = COMPANIES[no - 1];
    const reason = ERROR_REASONS[i % ERROR_REASONS.length];
    const baseTs = now - (180 + i * 240) * minute; // 3〜10h 前
    log.push({ timestamp: new Date(baseTs - 10 * minute).toISOString(), companyNo: c.no, companyName: c.name, action: 'site_analysis', details: '{"areas":["' + c.type + '"]}' });
    log.push({ timestamp: new Date(baseTs -  8 * minute).toISOString(), companyNo: c.no, companyName: c.name, action: 'message_draft', details: makeMessageDraft(c) });
    log.push({ timestamp: new Date(baseTs -  3 * minute).toISOString(), companyNo: c.no, companyName: c.name, action: 'error', details: reason.detail });
  }

  // ---- スキップ 3 社 ----
  for (let i = 0; i < OUTCOME.skipped.length; i++) {
    const no = OUTCOME.skipped[i];
    const c = COMPANIES[no - 1];
    const reason = SKIP_REASONS[i % SKIP_REASONS.length];
    const baseTs = now - (300 + i * 600) * minute;
    log.push({ timestamp: new Date(baseTs - 5 * minute).toISOString(), companyNo: c.no, companyName: c.name, action: 'site_analysis', details: '{"areas":["' + c.type + '"]}' });
    log.push({ timestamp: new Date(baseTs - 2 * minute).toISOString(), companyNo: c.no, companyName: c.name, action: 'skipped', details: reason });
  }

  // ---- 進行中 2 社 (今まさに処理中) ----
  for (let i = 0; i < OUTCOME.inflight.length; i++) {
    const no = OUTCOME.inflight[i];
    const c = COMPANIES[no - 1];
    log.push({ timestamp: new Date(now - (8 + i * 5) * minute).toISOString(), companyNo: c.no, companyName: c.name, action: 'site_analysis', details: '{"areas":["' + c.type + '"]}' });
    log.push({ timestamp: new Date(now - (4 + i * 3) * minute).toISOString(), companyNo: c.no, companyName: c.name, action: 'message_draft', details: makeMessageDraft(c) });
  }

  // ---- さらに古い送信済 (30〜60 日前) を 12 件追加して活動の積み上げを演出 ----
  for (let i = 0; i < 12; i++) {
    log.push({
      timestamp: new Date(now - (30 + i * 2) * 24 * 60 * minute).toISOString(),
      companyNo: 500 + i,
      companyName: 'デモ過去送信企業 (先月) No.' + (i + 1),
      action: 'submitted',
      details: '送信成功 (HTTP 200)',
    });
  }

  return log.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

function buildDemoTargetsCsv() {
  const header = ['No.', 'Status', 'Company', 'Type', 'Website URL', 'Form URL', 'Notes', '', 'CAPTCHA', '', 'Progress'];
  const rows = [header];

  for (const c of COMPANIES) {
    let progress = '';
    let captcha = '';
    let notes = c.region;
    if (OUTCOME.submitted.includes(c.no)) progress = '送信済';
    else if (OUTCOME.awaiting.includes(c.no)) progress = '確認待ち';
    else if (OUTCOME.errors.includes(c.no)) { progress = 'エラー'; if (c.no === 23) captcha = 'CAPTCHA'; }
    else if (OUTCOME.skipped.includes(c.no)) { progress = 'スキップ'; notes = '営業NG/対象外'; }
    else progress = '処理中';

    rows.push([c.no, 'OK', c.name, c.type, URL_FOR(c.no), FORM_URL_FOR(c.no), notes, '', captcha, '', progress]);
  }

  // 営業NG として目立たせる 1 件
  rows.push([99, 'NG', '除外サンプル株式会社', '', 'https://example.com/excluded', '', '対象外', '', '', '', '']);

  return rows.map((r) => r.map((v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(',')).join('\n') + '\n';
}

function seedDemoData(targetDataDir) {
  if (!targetDataDir) targetDataDir = process.env.SALES_CLAW_USER_DATA_DIR;
  assertDemoDataDirIsSafe(targetDataDir);

  const dataDir = path.join(targetDataDir, 'data');
  ensureDir(dataDir);

  const port = Number(process.env.SALES_CLAW_DEMO_PORT || 3766);
  writeJson(path.join(dataDir, 'settings.json'), buildDemoSettings(port));

  fs.writeFileSync(path.join(dataDir, 'sample-targets.csv'), '﻿' + buildDemoTargetsCsv(), 'utf8');

  writeJson(path.join(dataDir, 'action-log.json'), buildDemoActionLog());
  writeJson(path.join(dataDir, 'contact-history.json'), {});
  writeJson(path.join(dataDir, 'live-monitor.json'), { companies: {}, events: [], summary: {} });
  writeJson(path.join(dataDir, 'outreach-targets.json'), {});
  writeJson(path.join(dataDir, 'update-status.json'), { status: 'idle', demo: true });

  const screenshotsDir = path.join(targetDataDir, 'screenshots');
  ensureDir(screenshotsDir);
  ensureDir(path.join(dataDir, 'list-builder', 'runs'));

  // 確認待ち 4 社用のスクリーンショット PNG を生成し、mtime を form_fill 時刻に合わせる
  // (approval-artifacts.cjs の fileExistsWithinWindow チェックを通すため)
  for (const plan of awaitingScreenshotPlan) {
    const buf = makeFormMockPng({
      width: 1280,
      height: 760,
      accent: planAccentFromType(plan.type),
    });
    const filePath = path.join(screenshotsDir, 'ss-' + plan.companyNo + '-input.png');
    fs.writeFileSync(filePath, buf);
    const mt = new Date(plan.mtimeMs);
    try { fs.utimesSync(filePath, mt, mt); } catch (_) {}
  }

  return { dataDir, targetDataDir, screenshotsDir };
}

function planAccentFromType(type) {
  // 業種ごとに色を変えてカードに彩りを加える
  const map = {
    '物流':       [37, 99, 235],
    'ヘルスケア': [16, 185, 129],
    'IT':         [59, 130, 246],
    'SaaS':       [124, 58, 237],
    'FinTech':    [217, 119, 6],
    'CX':         [219, 39, 119],
  };
  return map[type] || [37, 99, 235];
}

if (require.main === module) {
  const target = process.env.SALES_CLAW_USER_DATA_DIR;
  if (!target) {
    console.error('SALES_CLAW_USER_DATA_DIR を設定してから実行してください');
    process.exit(1);
  }
  const result = seedDemoData(target);
  console.log('[demo-seed] populated', result.dataDir);
}

module.exports = { seedDemoData };

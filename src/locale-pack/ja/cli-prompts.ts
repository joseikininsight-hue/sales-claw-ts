// CLI Prompt 用 batch_rules (日本語)
//
// dashboard-server.ts の buildClaudeFormFillPrompt 内 batch_rules セクションを
// locale 別に抽出したもの。CLI (Claude/Codex/Gemini) に対する MCP Playwright
// 自動化指示をまとめる。日本語企業を相手にする際の現状文言をそのまま保持し、
// 日本語ユーザーの挙動が変わらないようにする。

interface FormPreferences {
  preferredKeywords?: string[];   // 優先的に選ぶフォーム名キーワード (例: パートナー, 協業, alliance)
  avoidKeywords?: string[];       // 避けるフォーム名キーワード (例: FAQ, support, 採用)
  approachLabel?: string;         // ユーザーのアプローチ趣旨 (例: 「パートナー営業」「人材紹介」「IR」)
}

interface BuildBatchRulesOpts {
  autoSendSafe: boolean;
  parallelTabs: number;
  formPreferences?: FormPreferences;
  // v2.1.0: 'internal' = Electron 内蔵 WebContentsView (sales-claw-form MCP)。
  //   'playwright' = 外部 Chrome (旧)。並列タブ展開手順がモードで異なるため出し分ける。
  formFillMode?: string;
}

// v2.0.59: デフォルトのフォーム優先順位 (パートナー営業向け)。
// settings.json で messageTemplates.formPreferences を上書きできる。
const DEFAULT_PREFERRED_KEYWORDS = ['パートナー', '協業', '取引', 'アライアンス', 'Partner Inquiry', 'Business Inquiry', 'Corporate Inquiry'];
const DEFAULT_AVOID_KEYWORDS = ['FAQ', 'カスタマーサポート', '製品サポート', 'Customer Support', 'Product Support', 'Help Center'];
const DEFAULT_APPROACH_LABEL = 'パートナー / 協業 営業';

function buildFormSelectionRule(pref: FormPreferences | undefined): string {
  const preferred = (pref && Array.isArray(pref.preferredKeywords) && pref.preferredKeywords.length > 0)
    ? pref.preferredKeywords : DEFAULT_PREFERRED_KEYWORDS;
  const avoid = (pref && Array.isArray(pref.avoidKeywords) && pref.avoidKeywords.length > 0)
    ? pref.avoidKeywords : DEFAULT_AVOID_KEYWORDS;
  const label = (pref && typeof pref.approachLabel === 'string' && pref.approachLabel.trim())
    ? pref.approachLabel.trim() : DEFAULT_APPROACH_LABEL;
  const preferredStr = preferred.map((k: any) => `「${k}」`).join(' / ');
  const avoidStr = avoid.map((k: any) => `「${k}」`).join(' / ');
  return `- ★ フォーム選択優先順位 (アプローチ趣旨: ${label}): ① ${preferredStr} 系の専用フォームが見つかればそれを最優先で使う。② 一般 Contact / お問い合わせ系は **①が無い場合の fallback**。③ ${avoidStr} 系は B2B 営業先として **不適切なので避ける** (例: faq.oracle.co.jp/app/ask/referer_id/contact は一般 Q&A 受付で営業窓口ではない)。`;
}

/**
 * CLI フォーム入力プロンプトの batch_rules 配列を返す。
 * 出力結果は dashboard-server で `'batch_rules:'` セクションの行として
 * そのまま join される。
 *
 * v2.0.59: formPreferences (preferred/avoid keywords + approachLabel) を
 * settings.json から受け取り、ユーザー固有のフォーム選好を prompt に反映できる。
 */
function buildBatchRules(opts: BuildBatchRulesOpts): string[] {
  const tabs = Number.isFinite(opts && opts.parallelTabs) ? Number(opts.parallelTabs) : 1;
  const autoSendSafe = !!(opts && opts.autoSendSafe);
  const formPref = opts && opts.formPreferences;
  const isInternal = !opts || opts.formFillMode !== 'playwright'; // 既定は internal (内蔵ブラウザ)

  const lines: string[] = [
    '- Phase A は backend 完了済み。form 未解決時を除き、対象サイトを再分析しない',
    '- ★ urlMissing=true の会社: WebSearch を **1 回だけ** (「会社名 公式サイト」のクエリ 1 本) 実行 → 上位 3 件から公式ドメインを判定 → 確定したら即 navigate (再検索禁止)。30 秒以内に決まらない or 公式が見つからない → **即 error**。WebSearch のリトライ・候補を 1 件ずつ navigate 試行・wikipedia 経由検索は全て禁止。',
    '- ★ urlMissing=false かつ siteExcerpt 空 / サイト取得失敗の会社は送信対象外。フォーム入力せず error で止める。本文を推測して awaiting_approval / submitted にしてはいけない',
    '- ★ awaiting_approval / submitted は、Phase A の site_analysis が十分なサイト本文を取得済みで、form_fill → confirm_reached が記録済みの場合だけ API が受け付ける',
    '- ★ 確認画面への進み方: 送信/確認ボタンは browser_snapshot の fields 一覧には出ない (フォーム項目ではない)。可視テキスト (「送信」「確認」「確認画面へ」「次へ」「送信する」「Submit」「Confirm」) でボタンを特定して browser_click する。クリック後は browser_wait_for で確認画面の文言/URL 変化が出るまで待ち、到達したら confirm_reached を curl で記録する。フォーム入力 (form_fill) だけで止まり confirm_reached を記録しないと、その社は送信判定に進めず未完了のまま残る。',
    '- messagePrompt がある場合は、それを使ってこの会社向けの本文を最終化してからフォーム入力する',
    '- messageDraft は Phase A の草案、messagePrompt は本文生成コンテキスト。messagePrompt を優先し、messageDraft はフォールバックとして扱う',
    '- 本文を書き換える場合でも、messagePrompt / analysisHints / siteExcerpt にない事実は足さない。社員数・設立年・資本金など sender_json に無い数値は推測しない',
    '- sender_json にない送信者情報は追加しない',
    '- 本文末尾には sender_json の会社名/担当者/連絡先/住所(ある場合)と送信停止案内を必ず含める。住所が無い場合は推測しない',
    buildFormSelectionRule(formPref),
    '- unresolved form は site から Contact/お問い合わせ または common path を浅く確認する',
    '- awaiting_approval はフォーム入力済み + ss-{No}-input.png 作成済みの場合だけ許可',
    '- CAPTCHA を見つけたら停止せず、まず可能な限り全フィールドを入力 → ss-{No}-input.png 撮影 → awaiting_approval (人間が CAPTCHA 解いて送信)',
    '- visible な checkbox 型 reCAPTCHA v2 (「私はロボットではありません」) は browser_click で 1 回だけ試行可。画像チャレンジが出たら諦めて awaiting_approval',
    '- CAPTCHA を理由に error にするのは「フォームが表示されない」「Cloudflare 等のページゲートで本体に到達できない」場合だけ',
  ];

  if (tabs <= 1) {
    lines.push('- 1社ずつ処理し、結果報告は簡潔にする');
  } else {
    // v2.1.0: タブ生成手順をモード別に出し分ける。internal (内蔵ブラウザ) では
    //   window.open は内蔵タブマネージャに追従しないため、各社タブは必ず
    //   browser_tabs({action:'new', url, companyNo}) で開く。
    const openRule = isInternal
      ? `- 並列発行手順: 最初の thinking ブロックで「${tabs} 社分を同時に開く」と決定 → 直後に ${tabs} 社分を browser_tabs({action:"new", url:<会社のURL>, companyNo:<No>}) で **同じ tool_use ブロック群として並列発行** (各社=専用タブ)。window.open は使わない (内蔵ブラウザでは追従しない)。`
      : `- 並列発行手順: 最初の thinking ブロックで「${tabs} 社分を同時に開く」と決定 → 直後に最初の 1 社を browser_navigate、残り ${tabs - 1} 社は browser_evaluate(window.open) + browser_tabs(select) を **同じ tool_use ブロック群として並列発行**。`;
    lines.push(
      `- ★★ 並列ツール呼び出し (parallel tool_use) を必ず使用すること。Claude は 1 つの thinking で複数の tool_use ブロックを同時発行できる。最初の応答で ${tabs} 社分のタブ生成を **同一 assistant message の中に並列に発行**する。逐次に「1 社目→完了待ち→2 社目」と進めるのは禁止。`,
      openRule,
      `- ${tabs} 社の navigate が全て完了するまで待機 → その後 browser_snapshot を ${tabs} 社並列発行 → browser_fill_form を ${tabs} 社並列発行 (Claude API は同種ツールを並列に呼べる)。`,
      `- screenshot / curl は社ごとに発行するが、可能なら ${tabs} 社分まとめて並列発行。同時タブは ${tabs + 1} 個まで (それ以上はリソース競合)。`,
      `- 並列発行が効くのは「同じ前提条件・同じ判断軸で進むツール」のみ。CAPTCHA 解析・本文最終化・送信可否判断など「社ごとに違う思考が必要な工程」は 1 社ずつ集中する。`,
      `- 各社の awaiting_approval / submitted ログには finalFormTab URL を必ず含める。`,
    );
  }

  lines.push(
    autoSendSafe
      ? '- CAPTCHA / 手動必須項目 / 営業NG / 不確実ケースを除き、確認画面が取れたら最終送信まで進めて submitted にする'
      : '- 送信は行わず awaiting_approval で止める',
  );
  lines.push('- 送信完了時は sent スクリーンショットを残し、送信済みタブは閉じる');
  lines.push(
    '- 入力済みだが最終送信しない場合だけタブを残して awaiting_approval。未入力 (CAPTCHA 以外の理由) / フォーム無しは error / skipped',
  );

  return lines;
}

module.exports = { buildBatchRules };

export {};

// CLI Prompt 用 batch_rules (日本語)
//
// dashboard-server.ts の buildClaudeFormFillPrompt 内 batch_rules セクションを
// locale 別に抽出したもの。CLI (Claude/Codex/Gemini) に対する MCP Playwright
// 自動化指示をまとめる。日本語企業を相手にする際の現状文言をそのまま保持し、
// 日本語ユーザーの挙動が変わらないようにする。

interface BuildBatchRulesOpts {
  autoSendSafe: boolean;
  parallelTabs: number;
}

/**
 * CLI フォーム入力プロンプトの batch_rules 配列を返す。
 * 出力結果は dashboard-server で `'batch_rules:'` セクションの行として
 * そのまま join される。
 */
function buildBatchRules(opts: BuildBatchRulesOpts): string[] {
  const tabs = Number.isFinite(opts && opts.parallelTabs) ? Number(opts.parallelTabs) : 1;
  const autoSendSafe = !!(opts && opts.autoSendSafe);

  const lines: string[] = [
    '- Phase A は backend 完了済み。form 未解決時を除き、対象サイトを再分析しない',
    '- ★ urlMissing=true の会社は WebSearch で「会社名 公式サイト」を検索して公式ドメインを特定→サイト分析→本文生成→フォーム入力と進む。公式サイトが見つからなければ error にする',
    '- ★ urlMissing=false かつ siteExcerpt 空 / サイト取得失敗の会社は送信対象外。フォーム入力せず error で止める。本文を推測して awaiting_approval / submitted にしてはいけない',
    '- ★ awaiting_approval / submitted は、Phase A の site_analysis が十分なサイト本文を取得済みで、form_fill → confirm_reached が記録済みの場合だけ API が受け付ける',
    '- messagePrompt がある場合は、それを使ってこの会社向けの本文を最終化してからフォーム入力する',
    '- messageDraft は Phase A の草案、messagePrompt は本文生成コンテキスト。messagePrompt を優先し、messageDraft はフォールバックとして扱う',
    '- 本文を書き換える場合でも、messagePrompt / analysisHints / siteExcerpt にない事実は足さない。社員数・設立年・資本金など sender_json に無い数値は推測しない',
    '- sender_json にない送信者情報は追加しない',
    '- 本文末尾には sender_json の会社名/担当者/連絡先/住所(ある場合)と送信停止案内を必ず含める。住所が無い場合は推測しない',
    '- unresolved form は site から Contact/お問い合わせ または common path を浅く確認する',
    '- awaiting_approval はフォーム入力済み + ss-{No}-input.png 作成済みの場合だけ許可',
    '- CAPTCHA を見つけたら停止せず、まず可能な限り全フィールドを入力 → ss-{No}-input.png 撮影 → awaiting_approval (人間が CAPTCHA 解いて送信)',
    '- visible な checkbox 型 reCAPTCHA v2 (「私はロボットではありません」) は browser_click で 1 回だけ試行可。画像チャレンジが出たら諦めて awaiting_approval',
    '- CAPTCHA を理由に error にするのは「フォームが表示されない」「Cloudflare 等のページゲートで本体に到達できない」場合だけ',
  ];

  if (tabs <= 1) {
    lines.push('- 1社ずつ処理し、結果報告は簡潔にする');
  } else {
    lines.push(
      `- ★ タブ並列 pipeline 許可 (最大 ${tabs} 並列): browser_navigate を発行したら snapshot を待たずに、次の会社のタブを window.open / browser_tabs で開いてさらに navigate を発行してよい。両方の navigate 完了を待ってから browser_snapshot → browser_fill_form の順で進める。同時に 4 社以上のタブを開いてはいけない (Claude の状態管理が混乱する)。各社の入力・スクショ・ログ記録は会社単位で完結させ、混同しない。会社ごとの awaiting_approval / submitted ログには finalFormTab URL を含める。\n- pipeline で進めるのはサイト到達 / form 発見 / form_fill の navigation 待ち局面のみ。CAPTCHA 解析・本文生成は 1 社ずつ集中する`,
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

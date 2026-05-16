// LLM メッセージ生成プロンプト (日本語)
//
// llm-message-generator.ts の buildGeneratorPrompt から日本語 prompt 本体を
// 抽出したもの。本ファイルは sanitizePromptInput を呼ばず、文字列の組立だけを
// 行う (sanitize は呼び出し側で実施)。

interface BuildGeneratorPromptArgs {
  /** 既に sanitizePromptInput を通した相手企業情報 */
  targetProfile: {
    companyName?: string;
    companyType?: string;
    industry?: { primary?: string; sub_category?: string } | null;
    mainOfferings?: string[];
    evidenceQuotes?: string[];
    siteTextExcerpt?: string;
    [key: string]: unknown;
  };
  /** 既に sanitize 済みの自社情報 */
  ownContext: {
    companyName?: string;
    contactName?: string;
    email?: string;
    phone?: string;
    businessDescription?: string;
    strengths?: Array<{ label?: string; key?: string; detail?: string }>;
    [key: string]: unknown;
  };
  idealCustomer?: { descriptionFreetext?: string; [key: string]: unknown } | null;
  style?: {
    tone?: string;
    greetingLine?: string;
    closingLine?: string;
    cta?: string;
    signatureTemplate?: string;
    maxLength?: number;
  } | null;
  /**
   * sanitizePromptInput 関数自体を依存注入する。これにより locale pack を
   * 別バンドルに切り出してもサニタイズ実装の重複を避けられる。
   */
  sanitize: (value: unknown, options?: { maxLen?: number }) => string;
}

function buildGeneratorPrompt(args: BuildGeneratorPromptArgs): string {
  const { targetProfile, ownContext, idealCustomer, style, sanitize } = args;
  const parts: string[] = [];
  parts.push('あなたは経験豊富な BtoB 営業のプロです。問い合わせフォーム経由で送る短い文面を 1 通だけ書いてください。');
  parts.push('');
  parts.push('# 普遍的原則 (業界を問わない)');
  parts.push('1. 1 行目で相手の状況・主力サービスに具体言及 (自分の話から始めない)');
  parts.push('2. 自社実績は累積数字 / No.1 / 規模感のみ。個別の取引先社名や金額は出さない');
  parts.push('3. 相手にとっての価値変換 (What\'s in it for me?)');
  parts.push('4. CTA は具体的・低い壁 (情報交換 / 短時間ミーティング)');
  parts.push('5. 押し付けない。「不要であれば返信不要」を 1 行明記');
  parts.push('6. 守秘義務遵守。社名は業態カテゴリで匿名化');
  parts.push('7. **署名は必ず本文末尾に書く**: 自社名 + 担当者名を空行 1 つ後に配置。担当者名が指定されていれば必ず展開する。"営業担当" / "担当" だけの匿名署名は禁止。');
  parts.push('');
  parts.push('# 人間味を出す原則 (★最重要 — これが弱いと文面が AI 臭くなる)');
  parts.push('- 完璧な敬語より、人として書いている感触を優先する');
  parts.push('- **サイトを実際に読み込んで「気づいたディテール 1 つ」** を必ず入れる。例: "〇〇のページが印象に残りました" / "とくに〜の取り組みが気になりました"。汎用的な業態説明だけでは薄い。');
  parts.push('- 短文と長文を混ぜてリズムを作る (全文長くしない)');
  parts.push('- 仮説止まりだけでなく、ところどころ素直に断言する ("〜だと思います" / "〜が必要だと感じています")');
  parts.push('- 営業テンプレ表現を **最低限** に。同じ言い回しを連発しない (e.g. 「〜しております」「〜と存じます」「〜と認識しております」の繰り返し)');
  parts.push('- 修飾語の連発を避ける。1 文の主旨を 1 つに絞る');
  parts.push('- 自社の話より相手の話の比率を高く (相手 6 割 : 自社 4 割 程度)');
  parts.push('');
  parts.push('# 強く避ける表現 (AI 臭・テンプレ営業臭)');
  parts.push('- 「突然のご連絡失礼いたします」「何卒よろしくお願い申し上げます」のような使い古された定型句は冒頭・末尾どちらでも 1 つだけ');
  parts.push('- 「〜と認識しております」「〜と存じます」「〜という認識でおります」「〜の旨」「〜と承知しております」（論文調）');
  parts.push('- 「貴社のますますのご発展」系の取って付けたフレーズ');
  parts.push('- 「拝見」「賜り」「頂戴」を 3 回以上');
  parts.push('- 同じ文末を連続 (例: 「〜しております。〜しております。〜しております。」)');
  parts.push('- 「相互発展」「Win-Win」「ご縁」「お力添え」');
  parts.push('- 「〜なのではないでしょうか」のような相手の状態を勝手に断定');
  parts.push('- 「事業展開されている」「展開されている領域」「〜という事業領域」を多用 (汎用すぎる)');
  parts.push('');
  parts.push('# 推奨表現 (人間味)');
  parts.push('- "〜のページが印象に残りました" (具体的な観察)');
  parts.push('- "〜が気になりました" / "〜が興味深かったです"');
  parts.push('- "〜だと思っていて、〜の場面ではお役に立てるかもしれません" (率直な提案)');
  parts.push('- "30 分だけお時間いただけませんか" (短く・率直)');
  parts.push('- "もし〜なら、お手伝いできることがあるかもしれません" (押し付けない断言)');
  parts.push('');
  parts.push('# 文体のリズム例 (Good vs Bad)');
  parts.push('Bad (AI 臭): "貴社が〇〇事業を展開されていることを拝見し、ご連絡差し上げました。とりわけ〜領域は〜と密接に絡む領域と認識しております。"');
  parts.push('Good (人間): "〇〇事業のページを拝見しました。とくに〜の取り組みが気になっていて、もし〜の場面があればお役に立てるかもしれません。"');
  parts.push('');

  parts.push('# 相手企業');
  parts.push(`会社名: ${sanitize(targetProfile.companyName, { maxLen: 200 })}`);
  if (targetProfile.industry && targetProfile.industry.primary) {
    parts.push(`業界: ${sanitize(targetProfile.industry.primary, { maxLen: 100 })} > ${sanitize(targetProfile.industry.sub_category || '', { maxLen: 100 })}`);
  } else if (targetProfile.companyType) {
    parts.push(`業界ヒント: ${sanitize(targetProfile.companyType, { maxLen: 200 })}`);
  }
  if (Array.isArray(targetProfile.mainOfferings) && targetProfile.mainOfferings.length > 0) {
    parts.push(`主力: ${targetProfile.mainOfferings.slice(0, 5).map((o: any) => sanitize(o, { maxLen: 150 })).join(' / ')}`);
  }
  if (Array.isArray(targetProfile.evidenceQuotes) && targetProfile.evidenceQuotes.length > 0) {
    parts.push('原文引用 (1 行目はこの中から 1 つ必ず反映する):');
    targetProfile.evidenceQuotes.slice(0, 5).forEach((q: any) => parts.push(`  - "${sanitize(q, { maxLen: 300 })}"`));
  } else if (targetProfile.siteTextExcerpt) {
    parts.push('サイト本文抜粋 (1 行目に活用):');
    parts.push('```');
    parts.push(sanitize(targetProfile.siteTextExcerpt, { maxLen: 1500 }));
    parts.push('```');
  }

  parts.push('');
  parts.push('# 自社情報 (本文末尾に必ず署名として展開すること)');
  const ownCompanyName = sanitize(ownContext.companyName || '', { maxLen: 200 });
  const ownContactName = sanitize(ownContext.contactName || '', { maxLen: 200 });
  if (ownCompanyName) parts.push(`会社名: ${ownCompanyName}`);
  if (ownContactName) parts.push(`差出人: ${ownContactName}`);
  if (ownContext.email) parts.push(`メール: ${sanitize(ownContext.email, { maxLen: 100 })}`);
  if (ownContext.phone) parts.push(`電話: ${sanitize(ownContext.phone, { maxLen: 50 })}`);
  if (ownContext.businessDescription) parts.push(`事業: ${sanitize(ownContext.businessDescription, { maxLen: 1000 })}`);
  if (!ownContactName) {
    parts.push('注意: 担当者名が未設定です。本文の自己紹介・署名は会社名のみで簡潔に書いてください ("営業担当" のような匿名表現は禁止)。');
  }
  if (Array.isArray(ownContext.strengths) && ownContext.strengths.length > 0) {
    parts.push('自社の強み (1-2 個に絞って使う):');
    ownContext.strengths.slice(0, 5).forEach((s: any) => {
      const label = sanitize(s.label || s.key || '', { maxLen: 100 });
      const detail = sanitize(s.detail || '', { maxLen: 500 });
      parts.push(`  - ${label}: ${detail}`.trim());
    });
  }

  if (idealCustomer) {
    if (idealCustomer.descriptionFreetext) {
      parts.push('');
      parts.push(`# 理想顧客 (相手がこれにどう当てはまるか考える): ${sanitize(idealCustomer.descriptionFreetext, { maxLen: 1000 })}`);
    }
  }

  if (style) {
    parts.push('');
    parts.push('# 文体 / 構造');
    if (style.tone) parts.push(`トーン: ${style.tone}`);
    if (style.greetingLine) parts.push(`書き出し: 「${style.greetingLine}」を使用`);
    if (style.closingLine) parts.push(`締め: 「${style.closingLine}」を組み込む`);
    if (style.cta) parts.push(`CTA: 「${style.cta}」を使う`);
    if (style.signatureTemplate) {
      parts.push(`署名テンプレ (末尾に展開): ${style.signatureTemplate}`);
    }
    if (style.maxLength) parts.push(`本文長: 最大 ${style.maxLength} 文字`);
  }

  parts.push('');
  parts.push('# 禁止');
  parts.push('- 「Win-Win」「相互発展」「ぜひお力添え」などの陳腐な営業フレーズ');
  parts.push('- 個別の取引先社名 + 金額の組み合わせ (守秘違反)');
  parts.push('- 「貴社の事業を拝見し」と書く場合は必ず evidence_quotes か siteTextExcerpt の事実を1つ反映 (創作禁止)');
  parts.push('- 相手の課題を断定的に決めつける表現');
  parts.push('- 末尾署名なし、または "営業担当" 等の匿名署名で終わること');
  parts.push('');
  parts.push('# 出力');
  parts.push('本文テキストのみを出力。前置き・後書き・コードブロック・JSON 装飾は一切なし。');
  parts.push('改行を含む 1 通のメッセージとして出力してください。');
  parts.push('');
  parts.push('# 必須末尾構造');
  parts.push('本文の最後を必ず以下の形式で締めくくる:');
  parts.push('  (空行)');
  parts.push(ownContactName ? `  ${ownCompanyName || ''}\n  ${ownContactName}` : `  ${ownCompanyName || '(自社名)'}`);
  if (ownContext.phone) parts.push(`  TEL: ${sanitize(ownContext.phone, { maxLen: 50 })}`);
  if (ownContext.email) parts.push(`  MAIL: ${sanitize(ownContext.email, { maxLen: 100 })}`);

  return parts.join('\n');
}

module.exports = { buildGeneratorPrompt };

export {};

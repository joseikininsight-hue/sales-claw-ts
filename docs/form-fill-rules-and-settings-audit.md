# Form Fill Rules And Settings Audit

## 1. 運用ルール

### 1-1. 営業NG・対象外フォーム
- 「営業目的のお問い合わせはご遠慮ください」
- 「既存顧客専用」
- 「採用専用」
- 「IR専用」
- 「報道専用」
- 「サービス利用者専用」

上記に該当する場合は、フォーム入力を進めない。

その場合の扱い:
- `awaiting_approval` にしない
- `skipped` ログだけ残す
- 理由は `営業NG/対象外: ...` の形式で明記する

### 1-2. 入力項目の最低ライン
- 基本項目:
  - 会社名
  - 担当者名
  - メール
  - 電話
  - 問い合わせ本文
- 条件付き項目:
  - 部署
  - 役職
  - 担当者名カナ
  - 郵便番号
  - 住所
  - 携帯
  - FAX
  - Webサイト

条件付き項目は、フォーム側に明示的な対応欄がある場合だけ使う。

### 1-3. 埋め方の原則
- 設定に存在しない値を推測で作らない
- 内部メモはフォーム入力や送信本文に使わない
- 本文は `message-builder.cjs` 経由で作る
- 企業分析は `company-analyzer.cjs` の結果を優先する

## 2. 設定反映マトリクス

### 2-1. 現在の CLI 本流で重要

#### `companyProfile`
- `companyName`
  - 送信者情報、署名、フォーム入力候補で使う
- `contactName`
  - 送信者情報、署名、フォーム入力候補で使う
- `contactNameKana`
  - フォームにカナ欄がある場合の候補
- `contactTitle`
  - 送信者情報、署名、フォーム入力候補で使う
- `department`
  - 送信者情報、署名、フォーム入力候補で使う
- `email`
  - 送信者情報、署名、フォーム入力候補で使う
- `phone`
  - 送信者情報、署名、フォーム入力候補で使う
- `mobile`
  - 追加項目としてのみ使う
- `fax`
  - 追加項目としてのみ使う
- `postalCode`
  - 追加項目としてのみ使う
- `address`
  - 追加項目としてのみ使う
- `website`
  - 追加項目、署名プレースホルダーで使う
- `partnerPage`
  - 本文の参照 URL、署名プレースホルダーで使う

#### `valuePropositions`
- `strengths`
  - 企業分析と本文生成で使う
- `successPatterns`
  - 本文生成で使う
- `industryProfiles`
  - 本文生成で使う

#### `messageTemplates`
- `style.maxLength`
  - 本文の最終文字数制限に使う
- `style.signatureFormat`
  - 署名の出し方に使う
- `greetingLine`
  - 本文冒頭に使う
- `closingLine`
  - 締め文に使う
- `cta`
  - CTA に使う
- `referenceUrlText`
  - `partnerPage` を本文に出すときに使う
- `signatureTemplate`
  - 署名生成に使う
- `letterTemplate.*`
  - 本文の前後テンプレートに使う

#### `targetList`
- `filePath`
  - 対象企業読み込みの本体
- `sheetIndex`
  - Excel シート選択に使う
- `columnMapping.*`
  - 企業一覧の列解釈に使う

#### `exclusionRules`
- `excludeStatuses`
  - ダッシュボード上のアプローチ除外判定に使う

#### `preferences`
- `dashboardPort`
  - サーバー起動ポート
- `dashboardHost`
  - サーバー bind host
- `screenshotDir`
  - スクショ保存先
- `dataDir`
  - ログ、履歴、runtime、monitor などの保存先
- `logLevel`
  - CLI ログ表示の閾値
- `maxLogEntries`
  - `action-log.json` の最大保持件数
- `claudeModel`
  - Claude 起動モデルと、managed Claude への指示時の優先モデル表示

### 2-2. サイド機能では使うが、CLI 本流フォーム入力には直接効かない
- `emailProvider`
  - `email-fetcher.cjs` で使う
- `emailSearchKeyword`
  - `email-fetcher.cjs` で使う
- `exportFilenamePrefix`
  - Excel export のファイル名に使う
- `pageTimeout`
  - `company-analyzer.cjs` で使う
- `headless`
  - `company-analyzer.cjs` で使う
- `locale`
  - `company-analyzer.cjs` と `email-fetcher.cjs` で使う
- `userAgent`
  - `company-analyzer.cjs` で使う

### 2-3. 現在は保存されるが、CLI 本流で実効が弱い・未反映
- `requireApprovalBeforeSend`
  - 現在の運用では常に手動送信前提なので、設定値を切り替えても挙動差が出にくい
- `formFillTimeout`
  - getter はあるが、現在の managed Claude 本流では直接参照していない
- `maxRetries`
  - direct JS submitter 廃止後は実質未使用
- `timezone`
  - 表示保存はされるが、主要表示ロジックでは固定 `ja-JP` が残る
- `dateFormat`
  - UI にはあるが、主要表示ロジックでは未使用

### 2-4. UI 保存中心で、フォーム入力に安易に混ぜない方がよい
- `companyNameEn`
- `companyNameKana`
- `representative`
- `addressEn`
- `corporateProfile`
- `established`
- `employeeCount`
- `capital`
- `industry`
- `businessDescription`
- `notes`
- `valuePropositions.companyUrl`
- `valuePropositions.serviceUrls`
- `valuePropositions.documentPaths`

これらは社内コンテキストや将来拡張用としては有用だが、今のフォーム入力で自動投入すると誤入力や過入力になりやすい。

## 3. 運用上の結論

- フォーム入力は「最低限の基本項目 + 明示的に対応する追加項目」に限定する
- 営業NG・対象外は `skipped` ログのみで止める
- 本文生成は settings を直接読むのではなく `message-builder.cjs` 経由に寄せる
- 設定 UI にあるからといって、全部をフォーム入力対象にしない

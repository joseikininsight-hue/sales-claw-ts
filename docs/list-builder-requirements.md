# 企業リスト作成機能 — 完成形要件定義 v2.0

**ステータス**: 確定版（実装着手可能）
**最終更新**: 2026-05-06
**対象バージョン**: Sales Claw 次期マイナーリリース
**改版履歴**:
- v1.0 初版（基本3モード設計）
- v1.1 URLモードをリストページクロールに再定義、カテゴリパラメータ拡充
- v1.2 設立年/上場区分削除、3層重複検出を最重要要件化
- v2.0 公式データソース優先化、コンプライアンス前提強化、適合度スコアリング、証跡・Run管理・Suppression導入

---

## 1. 目的とスコープ

### 1.1 目的

Sales Claw に、**公開情報・公式データソース・ユーザー指定URLをもとに営業候補企業を発見し、公式性・重複・適合度・送信可否リスクを確認したうえで、人間の承認によりターゲットリストへ追加する機能**を提供する。

本機能は **無差別なリスト大量生成ではなく、営業対象として妥当な企業候補を「説明可能な根拠付き」で提示すること** を目的とする。

### 1.2 設計原則

| 原則 | 内容 |
|------|------|
| 公開情報のみ | アクセス制限回避・CAPTCHA突破・ログイン必須ページ取得・robots.txt禁止パスの取得は行わない |
| 公式データソース優先 | 法人番号API / gBizINFO / EDINET を最初に参照し、検索API・スクレイピングは補助 |
| 説明可能性 | 各レコードの各フィールドに取得元・取得日時・抽出根拠（evidence）を保存 |
| 人間確認型 | 自動でターゲットリストに追加せず、必ずプレビュー → 選択 → commit を経由 |
| 段階的データモデル | 候補 → 検証 → 適格 → ターゲットの4段階で品質管理 |
| 安全側のデフォルト | 個人メール・個人名抽出は無効、CAPTCHA/403/429検出時は停止 |

### 1.3 スコープ（3入力モード）

| モード | 入力 | 用途 |
|--------|------|------|
| **URLモード** | 企業一覧が載っているリストページのURL（複数可） | 業界ランキング、DX認定企業一覧、商工会議所会員企業ページ等 |
| **自然言語モード** | 「都内のSIerで自社プロダクト持ち」等の自由文 | LLMでクエリ構造化 → 公式DS+検索API |
| **カテゴリモード** | 業種×地域×従業員規模×売上規模×成長性のプリセットUI | 系統的なターゲット選定 |

---

## 2. 採用技術スタック

### 2.1 データソース優先順位

| 優先 | データソース | 用途 | 種別 |
|------|------------|------|------|
| 1 | 国税庁 法人番号API | 商号・所在地・法人番号の正規化 | 公式 |
| 2 | gBizINFO API | 法人活動情報（業種・所在地・資本金等）の補完 | 公式 |
| 3 | EDINET API | 上場企業の財務・成長性・IR情報 | 公式 |
| 4 | 企業公式サイト | 事業内容・問い合わせフォーム・連絡先 | 公開Web |
| 5 | SerpApi | 公式サイト探索・補助 | 検索API |
| 6 | リストページ/記事 | 発見元として利用、信頼度は低 | 公開Web |

### 2.2 実装技術

| 役割 | 選定 | 備考 |
|------|------|------|
| 自然言語→構造化クエリ | Claude Sonnet 4.6（既存`ai-providers.cjs`） | 出力は固定JSONスキーマで強制 |
| サイト抽出（主） | Playwright MCP（既存） | 公開ページの節度ある解析 |
| サイト抽出（軽量） | cheerio（新規追加） | URL正規化・robots.txt確認・静的HTML解析 |
| サイト抽出（耐性向上・任意） | Scrapling MCP | 公式DSと公開ページで取れない場合の補助。**Phase 1ではオプション扱い** |
| アクセス制限検出 | extractor内蔵 | CAPTCHA/403/429/ログイン必須を検出して停止 |
| ファジー会社名マッチ | Levenshtein距離（自前実装または`fastest-levenshtein`） | 重複検出Layer 3 |

### 2.3 採用しない / Phase 1で除外

- **Cloudflare突破系の積極利用**: Sales Clawの思想と合わない。検出時は停止
- **CapSolver等のCAPTCHA自動解決**: Phase 1では使わない。検出時はスキップして理由を表示
- **個人メール/個人名の機械抽出**: デフォルト無効

---

## 3. アーキテクチャ

```
[UI: src/ui/list-builder/*]
  ├ 3タブ: URL / 自然言語 / カテゴリ
  ├ 進捗SSE表示（stage別）
  ├ コスト見積もり事前表示
  └ プレビュー（適合度/信頼度/根拠/重複状態） → commit
        ↓ POST /api/list-builder/run
[src/routes/list-builder-api.cjs]                   新規
        ↓
[src/list-builder/orchestrator.cjs]                 新規
   │
   ├─ Stage 1: discovery
   │    ├─ [discovery/list-page.cjs]   リストページ→ページネーション→企業候補
   │    ├─ [discovery/nlq.cjs]         Sonnet→構造化クエリ→公式DS+検索API
   │    └─ [discovery/category.cjs]    パラメータ→クエリ生成→公式DS+検索API
   │
   ├─ Stage 2: extractor
   │    ├─ Playwright/cheerioで公開ページを取得
   │    ├─ CAPTCHA/403/429/login検出時は停止
   │    └─ 個人情報フィールドはデフォルトで取得しない
   │
   ├─ Stage 3: identity-resolver               新規
   │    ├─ 法人番号API照合（商号+住所）
   │    ├─ gBizINFOで法人活動情報補完
   │    └─ 公式サイトドメインの確定（canonical link優先）
   │
   ├─ Stage 4: official-verifier              新規
   │    └─ 上場企業はEDINETで売上・成長性確認
   │
   ├─ Stage 5: enricher
   │    ├─ industry検出（既存company-analyzer.cjs流用）
   │    ├─ employeeCount抽出
   │    ├─ revenue抽出（IR情報があれば）
   │    ├─ growthTrend判定（上場企業のみ厳密、非上場は unknown）
   │    └─ formUrl探索 + form種別判定
   │
   ├─ Stage 6: qualification-scorer           新規
   │    ├─ fitScore計算
   │    ├─ riskFlags付与
   │    └─ recommendedAction判定
   │
   ├─ Stage 7: compliance-precheck            新規
   │    ├─ robots/規約/アクセス制限の最終確認
   │    ├─ 営業禁止/採用専用/サポート専用フォーム判定
   │    └─ riskScore付与
   │
   └─ Stage 8: dedupe
        ├─ Layer1: 法人番号 + 公式ドメイン
        ├─ Layer2: URL正規化 + 会社名正規化
        ├─ Layer3: ファジーマッチ（要確認フラグ）
        └─ Layer4: Suppression List照合
   ↓
[Preview画面] — ユーザーが確認・選択
   ↓
[POST /api/list-builder/commit]
   ↓
[src/target-list.cjs::appendCompany]               既存（無改造）
   ↓
[data/targets.xlsx]                                 既存
```

---

## 4. データモデル

### 4.1 4段階のレコード種別

| 種別 | 意味 | 保存先 |
|------|------|--------|
| `CandidateCompany` | 発見しただけの候補 | run内メモリ + `data/list-builder/runs/{runId}/candidates.json` |
| `VerifiedCompany` | 公式サイト・法人番号等で確認済み | 同上 |
| `QualifiedLead` | 営業対象として条件に合った会社 | preview出力 |
| `TargetRecord` | 実際にターゲットリストへ追加された会社 | `data/targets.xlsx` |

### 4.2 CompanyRecord（厳密版）

```typescript
interface CompanyRecord {
  id: string;                                    // run内ID

  // identity
  companyName: string;
  officialName?: string;                         // 法人番号API由来
  normalizedName: string;                        // 正規化済み
  corporateNumber?: string;                      // 法人番号13桁

  // location
  prefecture?: string;
  city?: string;
  officialAddress?: string;                      // 法人番号API由来

  // web
  url?: string;                                  // 公式サイトURL
  domainRoot?: string;                           // example.co.jp
  canonicalUrl?: string;                         // canonical link
  formUrl?: string;
  formType?: FormType;                           // 4.3参照

  // classification
  industry?: string;
  industryConfidence?: number;                   // 0.0-1.0
  companySize?: 'small' | 'medium' | 'large' | 'unknown';
  employeeCount?: number;
  revenueMillionYen?: number;
  growthTrend?: 'growing' | 'stable' | 'declining' | 'unknown';
  growthTrendSource?: 'edinet_ir' | 'unknown';

  // qualification
  fitScore: number;                              // 0-100
  fitReasons: string[];
  riskFlags: string[];                           // 'sales_prohibited', 'recruit_only' 等
  recommendedAction: 'add' | 'review' | 'skip';

  // source/evidence
  discoverySource: 'manual' | 'url' | 'nlq' | 'category' | 'official_api';
  sourceListUrl?: string;                        // URLモード時
  evidence: Evidence[];
  sourceConfidence: 'high' | 'medium' | 'low';
  fieldConfidence: Record<string, number>;       // フィールド別 0.0-1.0

  // lifecycle
  collectionStatus:
    | 'candidate'
    | 'verified'
    | 'partial'
    | 'blocked'      // CAPTCHA/403/429/login
    | 'failed'
    | 'needs_review';
  doNotContactReason?: string;                   // dedupe/suppression時

  discoveredAt: string;                          // ISO 8601
  lastVerifiedAt?: string;
}

interface Evidence {
  field: string;                                 // 'employeeCount' 等
  value: string;
  sourceUrl: string;
  sourceType:
    | 'official_api'
    | 'official_site'
    | 'search_result'
    | 'list_page'
    | 'ir'
    | 'unknown';
  extractedAt: string;
  confidence: number;                            // 0.0-1.0
  snippet?: string;                              // 抽出根拠の引用
}
```

### 4.3 FormType

```typescript
type FormType =
  | 'general_contact'    // 送信可
  | 'sales_inquiry'      // 送信可
  | 'partnership'        // 送信可
  | 'support'            // 送信不可
  | 'recruit'            // 送信不可
  | 'ir'                 // 送信不可
  | 'unknown';           // 要確認
```

`general_contact` / `sales_inquiry` / `partnership` のみ送信対象。

### 4.4 TARGET_FIELDS拡張

`src/target-list.cjs` の `TARGET_FIELDS` 既存11 + 追加 **12カラム**:

```javascript
// v2.0 追加カラム
'corporateNumber',     // 法人番号
'officialName',        // 公式名称
'normalizedName',      // 正規化会社名
'officialAddress',     // 公式所在地
'domainRoot',          // example.co.jp
'industry',            // 業種
'companySize',         // small/medium/large/unknown
'prefecture',          // 都道府県
'employeeCount',       // 数値
'revenue',             // 百万円
'fitScore',            // 0-100
'sourceConfidence',    // high|medium|low
// 別ファイルへ分離保存
// 'evidenceJson'      → data/list-builder/evidence/{recordId}.json
// 'fieldConfidenceJson' → 同上
// 'discoveredAt' / 'discoverySource' / 'sourceListUrl' / 'lastVerifiedAt' / 'collectionStatus' / 'doNotContactReason'
//   → data/list-builder/lifecycle/{recordId}.json
```

XLSXは行が肥大化するため、evidence と lifecycle は **別JSONファイルに分離保存**。`recordId` で結合。XLSX旧形式読込時は新カラムを空欄として補完（後方互換維持）。

---

## 5. 各モード仕様

### 5.1 URLモード

**入力**: リストページURL × N件 + オプション

**処理フロー**:
```
Step 1: アクセス許可チェック
  ├─ robots.txt確認（禁止パスはスキップ）
  ├─ HEADリクエストで200/403/429/CAPTCHA/loginを判定
  └─ 拒否要素検出時はそのURLをスキップして理由を記録

Step 2: リストページ構造解析
  ├─ Playwrightでレンダリング → cheerioで「企業を表す繰り返し要素」検出
  ├─ LLM(Sonnet)にDOM抜粋を投げてセレクタを確定（必要時のみ、固定JSON出力）
  └─ ページネーション検出（次へボタン / ?page=N / 無限スクロール）

Step 3: 全ページ走査
  ├─ ページネーション形式別:
  │   - クエリパラメータ型 → 上限まで連番アクセス（同一ドメイン負荷制限適用）
  │   - リンクボタン型 → Playwright遷移
  │   - 無限スクロール型 → スクロール+待機ループ
  └─ 各ページから企業エントリ蓄積

Step 4: 個別企業の公式URL確定
  ├─ リスト内に直接URLがあれば canonical link で正規化して採用
  ├─ なければ企業名で検索API再ルックアップ → 信頼度low
  └─ 公式判定基準: ドメインがcorporateNumber/officialAddressと一致すること

Step 5: 各企業に対して extractor → identity-resolver → enricher を実行
```

**制約**:
| 項目 | 値 |
|------|-----|
| 最大ページ数 | デフォルト10、UIで設定可（最大50） |
| 最大企業数 | デフォルト100、UIで設定可（最大500） |
| 同一ドメイン並列度 | 最大2 |
| 同一ドメインリクエスト間隔 | 最低1秒 |
| ページネーション検出失敗時 | 1ページ目のみ抽出してwarning |
| サイト構造解析失敗時 | LLMフォールバック → それでも失敗なら error_log |
| 企業公式サイト巡回深度 | 最大2 |
| 巡回対象パス（whitelist） | `/`, `/company`, `/about`, `/about-us`, `/service(s)`, `/contact`, `/inquiry`, `/ir`, `/recruit` |
| 除外パス | `/login`, `/admin`, `/cart`, `/mypage`, `/privacy`, `/terms`, `/news/page/*`, `/blog/*` |

### 5.2 自然言語モード

**入力**: 自由文クエリ

**処理**:
1. Sonnetに固定JSONスキーマで構造化クエリを返させる（次の `StructuredSearchIntent`）
2. 法人番号API/gBizINFOで該当業種・地域の法人を一次検索
3. 不足分をSerpApiで補完
4. 各候補URL → extractor → identity-resolver → enricher

**LLM出力スキーマ（厳格）**:

```typescript
interface StructuredSearchIntent {
  industries: string[];
  prefectures: string[];
  companySizeHints: string[];      // '中小', '中堅', '大手' 等
  revenueHints: string[];          // '10-100億' 等
  keywords: string[];              // 必須キーワード
  negativeKeywords: string[];      // 除外キーワード
  mustHave: string[];              // 必須条件（自社プロダクト等）
  niceToHave: string[];            // 緩和可能条件
}
```

**重要**: LLMが推定した業種・規模・成長性は推定値として `fieldConfidence` を低めに設定。確定判断は公式DS・公式サイトの根拠による。

### 5.3 カテゴリモード

**UIパラメータ**:

```typescript
interface CategorySearchParams {
  industries: string[];
  prefectures: string[];           // 複数選択、空=全国
  employeeRanges: Array<
    | '1-10' | '11-50' | '51-100' | '101-300'
    | '301-1000' | '1001-5000' | '5001+'
  >;
  revenueRanges: Array<
    | 'under_100m' | '100m-1b' | '1b-10b' | '10b-100b' | 'over_100b'
  >;
  growthTrend: 'growing' | 'stable' | 'declining' | 'any';
  // 上場企業のみEDINETで厳密判定
  // 非上場は unknown扱い、フィルタから除外しない
  keywords: string[];
  unknownFieldPolicy: 'strict' | 'standard' | 'broad';
  // strict: 条件確認できない企業は除外
  // standard: needs_reviewとして残す
  // broad: 含めるが confidence を下げる
  limit: number;                   // 10/30/50/100/200/500
}
```

**条件緩和ロジック**:
- 指定件数（limit）に達するまで、検索クエリを段階的に緩めて補充
- 緩和した場合は **必ず緩和ログをUIに表示**（黙って緩めない）

**緩和ログUI例**:
```
初期条件:    東京 × SaaS × 従業員51-100 × 成長中
緩和Step 1: 成長中条件を参考条件に変更 (該当 32件)
緩和Step 2: 従業員数を51-300に拡大 (該当 47件)
緩和Step 3: keyword一致を nice-to-have に変更 (該当 50件)
最終件数: 50件
```

---

## 6. 重複検出（最重要要件）

### 6.1 検出スコープ

- `data/targets.xlsx` 既存全レコード
- `data/contact-history.json` 過去送信済みレコード（再送防止）
- `data/suppression-list.json` Suppression List（Section 11参照）
- 同一ラン内で取得した重複も除去

### 6.2 4層検出ロジック

```
Layer 1: 法人番号 + 公式ドメイン（最強）
  ├─ corporateNumber が一致 → 同一企業
  ├─ domainRoot が一致 → 同一企業
  └─ 自動除外

Layer 2: URL正規化マッチ
  - http/https統一
  - www有無、末尾スラッシュ揺らぎ
  - index.html/index.php除去
  - クエリパラメータ除去（UTM系含む）
  - フラグメント除去
  - mobile/amp URL正規化（m. / amp. プレフィックス除去）
  - punycode/日本語ドメイン対応
  - redirect最終URL保存
  - canonical link優先
  → ホスト+パス一致で自動除外

Layer 3: 会社名正規化マッチ
  - 株式会社/(株)/㈱/Inc./Co.,Ltd./Corp./Ltd./有限会社/合同会社/合資会社
    /一般社団法人/医療法人/学校法人 を統一
  - 前株/後株差異吸収
  - 全角半角統一、スペース除去
  - カタカナ→ひらがな揺らぎ吸収
  - 完全一致で自動除外

Layer 4: ファジーマッチ（補助）
  - Layer1-3を抜けたものに対し編集距離(Levenshtein)
  - 会社名類似度 ≥ 0.9 → 「重複候補」フラグ
  - 自動除外せず、UI上で「要確認」表示

Layer 5: Suppression List照合
  - domain / companyName / corporateNumber / formUrl のいずれか一致
  - 自動除外（理由をUIに表示）
```

### 6.3 補助キー

以下も将来的にdedupeキーとして利用可能（Phase 1では収集のみ、強制マッチには使わない）:
- 代表電話番号（グループ会社判定）
- 公式所在地（同名会社判別）

### 6.4 ホールディングス・子会社・ブランドの扱い

- `HD` / `Holdings` / `ホールディングス` を含む会社名は **別会社候補として要確認フラグ**
- 支店/営業所/事業部/ブランド名は本体企業に紐付けようとせず、独立レコードとして扱う（誤紐付け防止）

### 6.5 プレビューUI

```
┌─ プレビュー（取得件数: 50件）──────────────────────┐
│ 新規: 38件 / 重複(自動除外): 9件 / 要確認: 3件      │
│                                                      │
│ ☑ ABC株式会社                                       │
│   公式URL: https://abc.co.jp                        │
│   適合度: 86 / 100                                   │
│   信頼度: High                                       │
│   取得元: gBizINFO + 公式サイト + SerpApi            │
│   フォーム: あり (general_contact)                   │
│   重複: なし                                         │
│   注意: 売上未確認                                   │
│   理由: 東京 / SaaS / 従業員51-100 / 自社プロダクト │
│                                                      │
│ ⚠ DEF商事             要確認 既存#42に類似(0.92)    │
│ — GHI Corp.           重複除外 既存#88と一致(法人番号)│
│ — JKL Group           重複除外 過去送信済(2026/3)   │
│ — MNO株式会社         除外 Suppression List         │
│                                                      │
│ [選択分をリストに追加] [類似度しきい値: 0.9 ▼]       │
└──────────────────────────────────────────────────────┘
```

---

## 7. 適合度スコアリング

### 7.1 LeadQualification

```typescript
interface LeadQualification {
  fitScore: number;              // 0-100
  fitReasons: string[];
  riskFlags: string[];
  recommendedAction: 'add' | 'review' | 'skip';
}
```

### 7.2 スコア配点（既定）

| 項目 | 配点 | 判定基準 |
|------|------|---------|
| 業種一致 | 20 | カテゴリ指定または NLQ意図と一致 |
| 地域一致 | 10 | 指定都道府県と一致 |
| 企業規模一致 | 15 | employeeCount が範囲内 |
| 公式サイト確認済み | 15 | corporateNumber + domainRoot 紐付け確認 |
| 問い合わせフォームあり | 15 | formType が送信可カテゴリ |
| 過去送信なし | 15 | contact-history に該当なし |
| 事業内容キーワード一致 | 10 | keywords が公式サイトに存在 |

合計100。`fitScore ≥ 70` で `recommendedAction: 'add'`、`50-69` で `'review'`、`< 50` で `'skip'`。

### 7.3 配点はユーザー設定で上書き可能

`data/settings.json::listBuilder.scoring` で配点をカスタマイズ可能。

---

## 8. リスト作成時コンプライアンス事前チェック

### 8.1 チェック項目

| チェック | 内容 | フラグ |
|---------|------|-------|
| robots.txt | アクセス禁止パスの取得を行わない | `robots_disallowed` |
| アクセス制限 | 403/429/CAPTCHA/login検出時は停止 | `access_blocked` |
| フォーム用途 | 営業禁止文言検出 | `sales_prohibited` |
| フォーム用途 | 採用専用フォーム検出 | `recruit_only` |
| フォーム用途 | サポート専用フォーム検出 | `support_only` |
| フォーム用途 | IR専用フォーム検出 | `ir_only` |
| 個人情報 | 個人メール/個人名は **デフォルトで抽出しない** | — |

### 8.2 riskFlags運用

検出した違反/懸念は `riskFlags` に追加し、UIで表示。
`sales_prohibited` / `recruit_only` / `support_only` / `ir_only` のいずれかがある場合は `recommendedAction: 'skip'`。

### 8.3 既存compliance.cjsとの関係

- **送信時**: 既存 `compliance.cjs` が特定電子メール法4項要件をチェック（変更なし）
- **収集時**: 新規 `compliance-precheck.cjs` がリスト作成時の収集可否・送信可否を判定

両者は補完関係。収集時に問題があれば送信時より早く弾く。

---

## 9. API契約

### 9.1 POST `/api/list-builder/run`

**Request**:
```typescript
{
  mode: 'url' | 'nlq' | 'category',
  payload:
    | { urls: string[]; maxPages?: number; maxCompanies?: number }
    | { query: string }
    | CategorySearchParams,
  unknownFieldPolicy: 'strict' | 'standard' | 'broad'   // デフォルト 'standard'
}
```

**Response**:
```typescript
{
  runId: string,
  status: 'queued' | 'running',
  estimated: {
    maxUrls: number,
    searchRequests: number,
    aiCalls: number,
    estimatedJpyMin: number,
    estimatedJpyMax: number
  }
}
```

### 9.2 GET `/api/list-builder/stream/:runId` (SSE)

```typescript
event: progress | result | error | done
data: {
  runId: string,
  stage:
    | 'discovery'
    | 'extracting'
    | 'identity_resolution'
    | 'official_verification'
    | 'enrichment'
    | 'qualification'
    | 'compliance_precheck'
    | 'dedupe'
    | 'preview_ready',
  total: number,
  completed: number,
  current?: { url?: string; companyName?: string; status: string },
  loosenedConditions?: Array<{ step: number; description: string; matched: number }>
}
```

### 9.3 POST `/api/list-builder/commit`

**Request**:
```typescript
{ runId: string, recordIds: string[] }
```

**Response**:
```typescript
{
  ok: true,
  appended: number,
  skippedDuplicate: number,
  flaggedSimilar: number,
  duplicateDetails: Array<{
    record: CompanyRecord,
    matchedAgainst: {
      source: 'targets' | 'history' | 'suppression',
      id: string,
      similarity: number,
      matchKey: 'corporateNumber' | 'domain' | 'url' | 'name' | 'fuzzy'
    }
  }>
}
```

### 9.4 マージ戦略

`mergeStrategy` から **`replace` を削除**（既存営業状況・送信履歴・手動メモ破壊を防ぐ）:

```typescript
mergeStrategy:
  | 'preview_only'              // commitしない、プレビューのみ
  | 'append_selected'           // 選択分のみ新規追加（既存上書きしない）
  | 'append_and_update_empty_fields'  // 既存の空欄のみ補完（明示的選択時のみ）
```

既存レコード更新は別APIに分離（Phase 2以降）。Phase 1は `append_selected` のみ実装。

### 9.5 Run管理API

```
GET    /api/list-builder/runs                     // 一覧
GET    /api/list-builder/runs/:runId              // 詳細
POST   /api/list-builder/runs/:runId/cancel       // キャンセル
POST   /api/list-builder/runs/:runId/retry-failed // 失敗分のみ再実行
DELETE /api/list-builder/runs/:runId              // 削除（証跡含む）
```

### 9.6 ListBuilderRun

```typescript
interface ListBuilderRun {
  runId: string;
  mode: 'url' | 'nlq' | 'category';
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'partial';
  payloadHash: string;
  startedAt: string;
  completedAt?: string;
  totalCandidates: number;
  verifiedCount: number;
  newCount: number;
  duplicateCount: number;
  needsReviewCount: number;
  failedCount: number;
  blockedCount: number;          // CAPTCHA/403/429/login
  costEstimate: {
    serpApiRequests: number;
    aiTokens: number;
    estimatedJpy: number;
  };
  loosenedConditions?: Array<{ step: number; description: string; matched: number }>;
}
```

### 9.7 エラー分類

```typescript
type ListBuilderErrorCode =
  | 'ROBOTS_DISALLOWED'
  | 'ACCESS_BLOCKED'        // 403/429
  | 'CAPTCHA_DETECTED'
  | 'LOGIN_REQUIRED'
  | 'TIMEOUT'
  | 'PARSING_FAILED'
  | 'SEARCH_API_ERROR'
  | 'OFFICIAL_API_ERROR'
  | 'AI_PARSE_ERROR'
  | 'DUPLICATE'
  | 'INVALID_URL'
  | 'SSRF_BLOCKED'
  | 'SUPPRESSED';
```

---

## 10. 設定（`data/settings.json` 拡張）

```json
{
  "apiKeys": {
    "serpApi": "...",
    "houjinBangou": "",          // 国税庁法人番号API（無料登録）
    "gBizInfo": ""               // gBizINFO（無料登録）
  },
  "listBuilder": {
    "scraplingMcpEnabled": false,
    "scraplingPythonPath": "python",
    "concurrency": 3,
    "perDomainConcurrency": 2,
    "perDomainMinIntervalMs": 1000,
    "timeoutMs": 30000,
    "respectRobotsTxt": true,
    "stopOnCaptcha": true,
    "stopOn403": true,
    "stopOn429": true,
    "extractPersonalEmails": false,
    "extractPersonNames": false,
    "officialDataFirst": true,
    "saveEvidence": true,
    "cacheTtlDays": 30,
    "maxResultsPerRun": 500,
    "maxDepthPerCompanySite": 2,
    "maxPagesPerDomain": 20,
    "defaultUnknownFieldPolicy": "standard",
    "dedupeThreshold": 0.9,
    "scoring": {
      "industry": 20,
      "prefecture": 10,
      "size": 15,
      "officialVerified": 15,
      "formAvailable": 15,
      "noPriorContact": 15,
      "keywordMatch": 10
    }
  }
}
```

設定UIは既存「Settings」タブにセクション追加。SerpApiキー未設定時はNLQ/カテゴリモードを無効化（公式DS+URLモードは引き続き利用可能）。

---

## 11. Suppression List（除外リスト）

### 11.1 ファイル

`data/suppression-list.json`

```typescript
interface SuppressionRecord {
  type: 'domain' | 'companyName' | 'corporateNumber' | 'formUrl';
  value: string;
  reason:
    | 'user_blocked'
    | 'past_contacted'
    | 'complaint'
    | 'do_not_contact'
    | 'competitor'
    | 'customer'
    | 'partner'
    | 'invalid';
  createdAt: string;
  createdBy?: string;
}
```

### 11.2 管理UI

設定タブに「除外リスト管理」セクション。CSV取込・手動追加・削除が可能。

### 11.3 自動追加ルール

- 過去送信履歴から自動的に `past_contacted` として追加（任意）
- `awaiting_approval → rejected` のレコードは `do_not_contact` として追加（オプション）

---

## 12. 失敗・中断・再実行

### 12.1 中断時の保証

- 各stage完了時にチェックポイントを `data/list-builder/runs/{runId}/checkpoint.json` に保存
- プロセスクラッシュ時も次回起動時に `partial` 状態で復元可能（既存`recovery-api`流用）

### 12.2 キャンセル

- `POST /api/list-builder/runs/:runId/cancel` で実行中ランを停止
- 取得済み分は `partial` 状態で保存され、commitは可能

### 12.3 失敗分の再実行

- `POST /api/list-builder/runs/:runId/retry-failed` で `failed` / `blocked` だったURLのみ再実行
- 元runの結果とマージ

---

## 13. コスト見積もり・利用量管理

### 13.1 実行前見積もり

UIで「実行開始」を押す前に、概算を表示:

```
実行前の目安
  検索API:      約12リクエスト  (SerpApi)
  AI解析:       約30ページ      (Sonnet)
  最大取得企業: 100件
  想定時間:     2-5分
  想定コスト:   ¥150 〜 ¥350
  失敗時:       取得済み分のみ保存
  キャンセル可: いつでも可能
```

### 13.2 実時コスト記録

既存 `cost-estimator.cjs` に list-builder phase を追加:
- `data/ai-run-metrics.jsonl` に `phase_listbuilder_*` を記録
- `GET /api/cost/summary` でリスト作成分のコストも表示

---

## 14. データ保持・削除・エクスポート

### 14.1 保持期間

- run単位の生データ（candidates / evidence / lifecycle）: デフォルト30日（`cacheTtlDays`）
- ターゲットリストへcommit済みレコード: 永続（XLSX）
- Suppression List: 永続

### 14.2 削除

- `DELETE /api/list-builder/runs/:runId` で run単位の生データを削除
- ターゲットリストの該当レコードは別途削除操作が必要

### 14.3 エクスポート

- runごとに CSV/JSON エクスポート可能
- evidence 含む完全エクスポート / サマリのみエクスポート を選択可

---

## 15. 初回セットアップ統合

既存5ステップ オンボーディングウィザード（`src/onboarding-wizard.cjs`）に **Step 6: リスト自動作成（任意）** を追加:

1. **公式データソース APIキー入力**（無料登録、推奨）
   - 国税庁法人番号API
   - gBizINFO
2. **SerpApi キー入力**（任意、NLQ/カテゴリモード用）
3. **Scrapling 動作確認**（任意、補助強化用）
   - `python -m scrapling --version` 成功で✅
   - 失敗時は「公式DS+Playwrightで動作可能」表示
4. **デフォルト設定確認**
   - 個人情報抽出: 無効
   - CAPTCHA/403/429検出時: 停止
   - robots.txt: 遵守

---

## 16. UI構成

### 16.1 タブ配置

ダッシュボード左メニューに **「リスト作成」** タブ新設（「ターゲットリスト」タブの上）。

### 16.2 URLモード

```
┌─ URLモード ───────────────────────────────┐
│ 企業一覧が載っているページのURLを入力      │
│ ┌────────────────────────────────────┐    │
│ │ https://example.com/ranking-2026   │    │
│ │ https://example.com/dx-companies   │    │
│ └────────────────────────────────────┘    │
│                                            │
│ オプション:                                │
│  最大ページ数: [10]                        │
│  最大企業数:   [100]                       │
│  ☑ ページネーション自動追跡                │
│  ☑ 各企業の詳細サイトも巡回 (深度2)        │
│  ☐ Scrapling MCPを補助利用 (要設定)        │
│                                            │
│ 条件未確認企業の扱い:                      │
│  ◉ 要確認として残す  ○ 除外  ○ 含める      │
│                                            │
│ [見積り表示] → [スキャン開始]              │
└────────────────────────────────────────────┘
```

### 16.3 カテゴリモード

```
┌─ カテゴリモード ──────────────────────────┐
│ 業種:        [▼ SaaS ×] [▼ SIer ×] [+]    │
│ 都道府県:    [▼ 東京 ×] [▼ 大阪 ×] [+]    │
│ 従業員数:    ☐1-10  ☑11-50  ☑51-100       │
│              ☑101-300  ☐301-1000  ...     │
│ 売上規模:    ☐1億未満  ☑1-10億  ☑10-100億 │
│ 売上推移:    ◉ 成長中 ○ 安定 ○ 全て       │
│              ※上場企業のみEDINETで厳密判定 │
│              ※非上場は判定不能扱い        │
│ キーワード:  [自社プロダクト, 受託開発]    │
│ 取得件数:    [50 ▼] (最大500)             │
│                                            │
│ 条件未確認企業の扱い:                      │
│  ○ 厳格（除外）                            │
│  ◉ 標準（要確認として残す）                │
│  ○ 広め（含めるがconfidence低）            │
│                                            │
│ [見積り表示] → [検索開始]                  │
└────────────────────────────────────────────┘
```

### 16.4 プレビュー

Section 6.5 のレイアウトを採用。各レコードに以下を表示:
- 公式URL / 適合度 / 信頼度 / 取得元 / フォーム種別 / 重複状態 / 注意フラグ / 適合理由

---

## 17. 実装ファイル一覧

### 新規作成

```
src/list-builder/
├ orchestrator.cjs
├ discovery/
│  ├ list-page.cjs
│  ├ pagination.cjs
│  ├ nlq.cjs
│  └ category.cjs
├ extractor.cjs
├ identity-resolver.cjs
├ official-verifier.cjs
├ enricher.cjs
├ enrichers/
│  ├ employee-count.cjs
│  ├ revenue.cjs
│  └ growth-trend.cjs
├ qualification-scorer.cjs
├ compliance-precheck.cjs
├ dedupe.cjs
├ suppression.cjs
├ cost-estimator.cjs       (既存と統合)
├ run-manager.cjs
├ official-clients/
│  ├ houjin-bangou-client.cjs   (国税庁API)
│  ├ gbizinfo-client.cjs
│  └ edinet-client.cjs
├ scrapling-client.cjs       (任意、Phase 1 でstub可)
└ url-normalizer.cjs

src/routes/
└ list-builder-api.cjs

src/ui/list-builder/
├ index.html
└ client-scripts/list-builder.cjs

tests/list-builder/
├ url-normalizer.test.cjs
├ name-normalizer.test.cjs
├ dedupe.test.cjs
├ identity-resolver.test.cjs
├ qualification-scorer.test.cjs
├ compliance-precheck.test.cjs
├ discovery-list-page.test.cjs
├ discovery-nlq.test.cjs
├ extractor.test.cjs
├ suppression.test.cjs
├ run-manager.test.cjs
└ integration.test.cjs

data/
├ suppression-list.json
└ list-builder/
   ├ runs/{runId}/
   ├ evidence/{recordId}.json
   └ lifecycle/{recordId}.json
```

### 変更

- `src/target-list.cjs` — TARGET_FIELDS 12カラム追加
- `src/dashboard-server.cjs` — ルート登録、recovery統合
- `src/settings-manager.cjs` — apiKeys/listBuilder セクション + 暗号化
- `src/onboarding-wizard.cjs` — Step 6 追加
- `src/onboarding-validator.cjs` — Step 6 検証
- `src/ui/index.html` + メニュー — 「リスト作成」タブ追加
- `src/cost-estimator.cjs` — list-builder phase 追加
- `package.json` — `cheerio`, `fastest-levenshtein` 追加、version bump
- `data/sample-settings.json` — 新セクションのサンプル

---

## 18. テスト計画

| レイヤ | テスト |
|--------|--------|
| Unit | `url-normalizer.test.cjs` URL正規化（http/https、www、index、UTM、punycode、canonical、mobile/amp） |
| Unit | `name-normalizer.test.cjs` 会社名正規化（株式会社揺らぎ、前後株、HD、全角半角） |
| Unit | `dedupe.test.cjs` 4層検出、Layer別優先順位 |
| Unit | `identity-resolver.test.cjs` 法人番号API・gBizINFO照合 |
| Unit | `qualification-scorer.test.cjs` スコア計算、配点カスタマイズ |
| Unit | `compliance-precheck.test.cjs` robots/CAPTCHA/403/429/login/フォーム用途判定 |
| Unit | `discovery-list-page.test.cjs` ページネーション3形式検出 |
| Unit | `discovery-nlq.test.cjs` 固定JSONスキーマ強制 |
| Unit | `suppression.test.cjs` 4種別マッチ |
| Unit | `run-manager.test.cjs` checkpoint保存、cancel、retry-failed |
| Integration | 公式APIモック→discovery→identity→enricher→scorer→dedupe 一気通貫 |
| Integration | 既存targets.xlsx + contact-history + suppression との重複検出 |
| Integration | unknown-field-policy 3モード切替 |
| Integration | 条件緩和ログがUIに表示される |
| E2E (Playwright) | 3モード × プレビュー → commit のUIシナリオ |
| E2E (Playwright) | 実行中キャンセル、失敗分再実行 |
| Large Run | 500件収集時のメモリ・速度・APIリクエスト数 |
| Regression | 既存ターゲットリスト取込（XLSX旧形式読込）に影響なし |
| Regression | 既存営業送信フローに回帰なし |

---

## 19. 受け入れ基準

### 基本機能

1. URLモード: リストページURLでページネーションを踏破して全企業を取得できる（最大50ページ）
2. NLQモード: 自然文 → 構造化クエリ変換 → 公式DS+検索で企業発見
3. カテゴリモード: 業種×地域×規模×売上×成長性を指定 → 適切なクエリ生成
4. Scrapling未インストール環境でも全モードが動作（公式DS+Playwright/cheerio）
5. 既存リスト取込フロー・既存営業送信フローに**回帰なし**
6. 必要なAPIキー未設定時、該当モードは適切にロック表示

### 品質指標

7. **公式サイトURL特定率（NLQモード）**: ≥ 70%
8. **会社名抽出精度**: ≥ 85%
9. **フォームURL特定率**: ≥ 50%
10. **重複誤除外率**: ≤ 2%
11. **適合条件に明らかに反する企業の混入率**: ≤ 20%
12. **既知のテストデータセットに対する重複検出**: 再現率 ≥ 98%、精度 ≥ 98%
13. ファジーマッチ対象は自動除外せず、要確認として表示する

### 説明可能性

14. 全レコードに `evidence` が保存され、各フィールドの取得元・取得日時・抽出根拠が確認できる
15. 全レコードに `fieldConfidence` が付与され、UIで信頼度別に表示できる
16. 条件緩和が発生した場合、緩和ログがUIに表示される

### 安全性

17. SSRF・robots.txt 違反URLは抽出前に拒否ログ
18. CAPTCHA / 403 / 429 / login 検出時はそのURLをスキップし、理由を記録
19. 個人メール・個人名は **デフォルトで抽出しない**
20. `sales_prohibited` / `recruit_only` / `support_only` / `ir_only` フォームは送信対象外フラグ

### 重複検出（最重要）

21. 既存リスト100件 + 過去送信履歴50件 + Suppression50件 がある状態で 新規50件取得し、URL/法人番号/会社名重複が **再現率98%以上** で検出される
22. 表記揺れ（株式会社ABC / (株)ABC / ABC株式会社）が同一企業として判定される
23. 類似度0.9以上は「要確認」フラグでUIに表示
24. 過去送信履歴・Suppression Listとの重複は明示的にUI表示される

### 運用

25. 実行前にコスト見積もりが表示される
26. 実行中キャンセルが可能、`partial` 状態で結果が保存される
27. 失敗/blocked URLのみ再実行可能
28. 100URL同時実行で並列度設定を超えない（同一ドメイン並列度2、最低間隔1秒も遵守）
29. プロセスクラッシュ時も次回起動時に `partial` 状態で復元可能

---

## 20. リスク・前提

| 項目 | 内容 | 対応 |
|------|------|------|
| 公式API利用登録 | 法人番号API/gBizINFO/EDINET は無料だが事前登録必要 | オンボーディングで案内、未設定時はSerpApi+Webで代替（信頼度低） |
| Pythonランタイム | Scrapling利用時はユーザー側で `pip install scrapling` | デフォルト無効、Playwrightフォールバックで動作確保 |
| SerpApi月額コスト | カテゴリモード500件で数ドル発生する可能性 | ユーザー側でAPIキー取得・コスト管理 + 事前見積り表示 |
| Cloudflare等の保護 | 公開ページでも保護で取得失敗するケース | 検出時は停止して理由表示、突破は試みない |
| 法的観点 | robots.txt遵守はクローラー向けの目安、規約・アクセス制限・負荷も考慮が必要 | コンプライアンス事前チェックで多層防御。利用規約に「ユーザー責任」を明記 |
| 個人情報保護法 | 個人名・個人メールの収集は同法の論点 | デフォルト無効、UIで明示的にOPT-IN必要、保持期間・削除対応を実装 |
| LLM出力の信頼性 | LLM推定値を確定情報として扱うとリスク | 公式DS優先、LLM由来は `fieldConfidence` 低めで保存 |

---

## 21. 重要な記述（要件本文に含める文言）

> 本機能は、公開情報・公式データソース・ユーザー指定URLをもとに営業候補企業を発見する。ただし、アクセス制限の回避、CAPTCHA突破、ログイン必須ページの取得、robots.txtで禁止されたパスの取得は行わない。
>
> 取得した企業情報は、公式データソース・公式サイト・検索結果・リストページなどの取得元を evidence として保存し、項目ごとに confidence を付与する。
>
> 企業リストへの追加は自動実行せず、プレビュー画面でユーザーが確認・選択したレコードのみ commit する。
>
> 個人メール・個人名等の個人情報に該当し得る項目は、デフォルトで取得しない。

---

## 22. v2.0で追加された主要章（v1.2との差分サマリ）

| 章 | 内容 |
|----|------|
| §1.2 設計原則 | 公開情報のみ・公式DS優先・説明可能性・人間確認型・段階的データモデル・安全側デフォルト |
| §2.1 データソース優先順位 | 法人番号API/gBizINFO/EDINET を最優先 |
| §3 アーキテクチャ | identity-resolver / official-verifier / qualification-scorer / compliance-precheck を追加 |
| §4.1 4段階データモデル | Candidate → Verified → Qualified → Target |
| §4.2 CompanyRecord | corporateNumber / evidence / fieldConfidence / collectionStatus 等を追加 |
| §4.3 FormType | 送信可否を種別で判定 |
| §6.2 4層重複検出 | 法人番号 + 公式ドメインを最優先キー化、Suppression Listを追加 |
| §7 適合度スコアリング | fitScore 0-100、配点カスタマイズ可能 |
| §8 コンプライアンス事前チェック | リスト作成時の安全性確保 |
| §9.4 マージ戦略 | replace 削除 |
| §9.5-9.7 Run管理 | runs API、ListBuilderRun型、エラー分類 |
| §10 設定 | extractPersonalEmails等の安全側デフォルト |
| §11 Suppression List | 除外リスト管理 |
| §12 失敗・中断・再実行 | checkpoint、cancel、retry-failed |
| §13 コスト見積もり | 実行前見積りUI |
| §14 データ保持・削除・エクスポート | 保持期間と削除権 |
| §19 受け入れ基準 | 数値を現実化、品質指標を明確化 |
| §21 重要な記述 | 要件本文の中核宣言 |

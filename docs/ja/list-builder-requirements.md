English version: [list-builder-requirements.md](../list-builder-requirements.md)

# List Builder 要件仕様書 (日本語版)

> 📝 **翻訳ステータス**: 完全な日本語版は準備中です。
> 当面は英語版 ([../list-builder-requirements.md](../list-builder-requirements.md), 1108 行)
> を参照してください。下記は日本語サマリです。

## 概要

List Builder は、公開情報と公式データソース (国税庁法人番号 API / gBizINFO / EDINET)
+ ユーザー指定 URL を使って、アプローチ候補企業を発見・検証・適格化する機能です。
**人間の承認**が必要 → ターゲットリストへの自動追加はしません。

## 3 つの入力モード

### 1. URL モード
企業リストページ (業種ランキング / DX 認証企業リスト等) の URL を入力 →
ページネーション → 各企業の詳細抽出。

### 2. 自然言語モード
フリーテキスト → Sonnet で構造化クエリ → SerpApi で検索。

### 3. カテゴリモード
業種 × 地域 × 従業員数 × 売上規模 × 成長率 のプリセット UI。

## 設計原則

- **公開情報のみ** (Cloudflare バイパス / CAPTCHA 回避はしない、検出時に停止)
- **公式ソース優先** (法人番号 API → gBizINFO → EDINET → 検索 API → スクレイピング)
- **説明可能性**: 全レコードに `evidence` (source, fetched-at, confidence) を保存
- **人間確認**: `targets.xlsx` への自動追加なし、必ず preview → commit
- **安全な default**: 個人メール / 個人名抽出は OFF、CAPTCHA / 403 / 429 検出時は停止

## 必要 API キー

`data/settings.json::apiKeys` に設定:

| キー | 用途 | 必須度 |
|---|---|---|
| `serpApi` | 自然言語 / カテゴリモード | NLQ / カテゴリで必須 |
| `houjinBangou` | 国税庁法人番号 API (無料) | 推奨 |
| `gBizInfo` | gBizINFO (無料) | 推奨 |
| `edinet` | EDINET (任意) | 上場企業の売上推移厳密評価で利用 |

## API エンドポイント

- `POST /api/list-builder/run` - run 開始 (バックグラウンド)
- `GET /api/list-builder/stream/:runId` - SSE 進捗
- `POST /api/list-builder/commit` - 選択行をターゲットリストに追加
- `GET /api/list-builder/runs` / `runs/:runId` - 一覧 / 詳細
- `POST /api/list-builder/runs/:runId/cancel` / `retry-failed`
- `DELETE /api/list-builder/runs/:runId`
- `GET /api/list-builder/api-key-status` - キー設定有無のみ返す (値は返さない)

## 8-stage パイプライン

1. **Discovery** - 候補発見 (URL / NLQ / カテゴリ)
2. **Identity Resolution** - 法人番号 + gBizINFO で同一性確認
3. **Enrichment** - 業種 / 従業員数 / 売上 / フォーム抽出
4. **Compliance Pre-check** - robots.txt + フォームタイプ + CAPTCHA 検出
5. **Qualification Scoring** - fitScore 0-100
6. **Dedupe** - 4 層 + suppression-list 重複排除
7. **Suppression** - 除外リスト管理
8. **Preview** - ユーザーに表示 → commit 待ち

## ファイル構成

```
src/list-builder/
├ orchestrator.cjs           # 8-stage パイプライン実行
├ run-manager.cjs            # run 永続化 / cancel / retry
├ extractor.cjs              # HTTP fetch + compliance check 統合
├ enricher.cjs               # 業種 / 従業員数 / 売上 / フォーム抽出
├ identity-resolver.cjs      # 法人番号 API + gBizINFO で同一性解決
├ qualification-scorer.cjs   # fitScore 0-100
├ compliance-precheck.cjs    # robots.txt + フォームタイプ + CAPTCHA 検出
├ dedupe.cjs                 # 4 層 + suppression ベース重複排除
├ suppression.cjs            # 除外リスト管理
├ url-normalizer.cjs         # URL 正規化 (eTLD+1 / UTM 削除等)
├ name-normalizer.cjs        # 会社名正規化 (法人格 / 全角・半角)
├ discovery/                 # 3 モード discovery
│  ├ list-page.cjs / pagination.cjs / nlq.cjs / category.cjs
├ enrichers/                 # 個別フィールド抽出
│  ├ employee-count.cjs / revenue.cjs / growth-trend.cjs
└ official-clients/          # 公式 API ラッパー
   ├ http-client.cjs / houjin-bangou-client.cjs / gbizinfo-client.cjs / edinet-client.cjs
```

## 詳細仕様

完全な仕様 (1108 行) は **[英語版](../list-builder-requirements.md)** を参照してください。
日本語完訳は今後のリリースで対応予定です。

### 主要章 (英語版で参照可能)

1. Goals & Non-Goals
2. Three Discovery Modes (URL / NLQ / Category)
3. Identity Resolution
4. Enrichment Pipeline
5. Qualification Scoring
6. Compliance Pre-check
7. Dedupe Strategy (4 layers)
8. Suppression List Management
9. UI / API Surface
10. Error Handling & Recovery
11. Performance Targets
12. Security Considerations

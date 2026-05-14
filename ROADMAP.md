# Sales Claw Roadmap

このドキュメントは Sales Claw の今後の開発計画と既知の制約を明示します。
公開されていない既知の挙動・将来の作業を整理することで、ユーザー / コントリビュータ
への透明性を担保します。

## 既知の制約 (Known Limitations)

| 項目 | 影響 | 対策状況 |
|---|---|---|
| Windows code signing 未対応 | SmartScreen 警告 (初回起動時) | コード署名証明書のコスト ($200-500/年) と法人格が必要なため、現状は未対応。回避策: 「詳細情報」→「実行」 |
| `data/settings.json::apiKeys` 平文保存 | 共有マシンでの API キー流出リスク | Phase 8 で OS keystore 経由の暗号化を導入予定 |
| Auto-update は GitHub Releases 経由のみ | 企業の Firewall で GitHub アクセスが制限される環境では動かない | プライベートホスティング対応は未予定 |
| `as any` 残存 748 件 | 型安全性が部分的 | Stage 2 で段階削減中 (`docs/typescript-migration-roadmap.md`) |
| Programmatic Credit 切替は 2026-06-15 以降に有効 | それまでは API key を使う場合に従量課金 | spawn env サニタイザ自体は導入済み、ポリシー発効待ち |

## Stage 2-4.5 進捗 (TypeScript Migration)

| Stage | 進捗 | 詳細 |
|---|---|---|
| Stage 1: 基盤 | ✅ 完了 (2.0.0-rc.1) | `src/types/helpers.ts` / lint で `no-explicit-any` warn |
| Stage 2: any 段階削減 | 🔄 進行中 (83 件減 / 残 ~865 件) | Top 15 ファイルから順次。`unknown` + 型ガードへ |
| Stage 3: tsconfig 厳格化 | 🔄 部分完了 (3 オプション有効化) | `useUnknownInCatchVariables` は 164 errors のため見送り |
| Stage 4: `dashboard-server.ts` 分割 | 🔄 開始 (1 モジュール抽出) | 9540 行 → 200-400 行の 6 ファイル目標 |
| Stage 4.5: ブラウザ TS 化 | 🔄 土台のみ | `tsconfig.browser.json` + `src/ui/client-scripts/browser/` 用意。template literal 解体は今後 |

全体ロードマップ: [docs/typescript-migration-roadmap.md](./docs/typescript-migration-roadmap.md)

## 中長期 (next 6 months 想定)

### 機能
- **国際化 (i18n)** 完成: 現状は日本語が一級、英語の混在あり
- **List Builder Web API モード**: NLQ / カテゴリモードの安定化
- **CRM 連携**: HubSpot / Salesforce との同期 (連絡履歴の双方向)
- **送信スケジューリング**: 時間帯指定・送信ペース制御

### 品質
- **Code signing 導入**: Windows EV cert か Mac notarization を本格化
- **E2E テスト拡充**: Playwright で全主要動線のシナリオテスト
- **設定暗号化**: `data/settings.json::apiKeys` を OS keystore 経由に
- **Telemetry (opt-in)**: 障害再現に必要な匿名化メトリクス収集 (オプトインのみ)

### コミュニティ
- **コントリビュータガイド**: 設計判断の文書化、レビューフローの確立
- **Issue triage 体制**: 報告 → 検証 → 対応の SLA
- **日本語 / 英語 のサポート二言語化**

## 短期 (next 30 days 想定)

- [ ] `as any` を 200 件削減 (Stage 2 Top 5 ファイル)
- [ ] `dashboard-server.ts` から `dashboard-managed-provider-home.ts` を抽出
- [ ] CI で `npm run test:unit` の coverage 計測を追加
- [ ] README に Q&A / FAQ セクション追加
- [ ] CODEOWNERS / SUPPORT.md 追加

## 提案・要望

機能要望は [Issues](https://github.com/joseikininsight-hue/sales-claw-ts/issues) に
feature request テンプレートで投稿してください。

優先度の判断は以下を考慮します:
- ユーザー数への影響 (どれくらいの人が困っているか)
- 実装コスト (工数・破壊リスク)
- 既存のロードマップとの整合
- セキュリティ / コンプライアンス上の必要性

## 改訂履歴

| 日付 | 内容 |
|---|---|
| 2026-05-14 | 初版 (2.0.1 リリース時に作成) |

# Support

Sales Claw のサポート窓口・問い合わせ方法を整理します。

## どこに質問すべきか

| 質問の種類 | 行き先 |
|---|---|
| **バグ報告** | [GitHub Issues](https://github.com/joseikininsight-hue/sales-claw-ts/issues/new?template=bug_report.md) (bug_report テンプレート) |
| **機能要望** | [GitHub Issues](https://github.com/joseikininsight-hue/sales-claw-ts/issues/new?template=feature_request.md) (feature_request テンプレート) |
| **使い方の質問** | [GitHub Discussions](https://github.com/joseikininsight-hue/sales-claw-ts/discussions) (有効化後) |
| **セキュリティ脆弱性** | **公開 Issue を立てずに** [SECURITY.md](./SECURITY.md) の手順を参照 |
| **行動規範 (Code of Conduct) 違反** | [abckeishi@gmail.com](mailto:abckeishi@gmail.com) (確認後対応) |

## サポート対象バージョン

| Version | サポート | 備考 |
|---|---|---|
| 2.0.x | ✅ Active | 推奨。最新機能・自動更新あり |
| 1.2.x | 🟡 Security only | セキュリティ修正のみ |
| < 1.2 | ❌ End-of-life | 2.x へのアップデートを推奨 |

## 問い合わせ前のチェックリスト

時間を節約するため、以下を先にご確認ください:

1. **[README.md](./README.md)** にセットアップ・使い方の基本が記載されています
2. **[CHANGELOG.md](./CHANGELOG.md)** で既知の修正/変更を確認できます
3. **[既存の Issue](https://github.com/joseikininsight-hue/sales-claw-ts/issues?q=is%3Aissue)** で同じ問題が報告されていないか検索
4. **`%APPDATA%\sales-claw\runtime\data\dashboard-diagnostics.jsonl`** にアプリの診断ログがあります (バグ報告時に添付推奨)

## 返答の目安

| カテゴリ | 初回返答 |
|---|---|
| クリティカルなセキュリティ脆弱性 | 3 営業日以内 |
| バグ報告 | 7 営業日以内 |
| 機能要望 | 14 営業日以内 (検討開始の連絡) |
| 一般的な質問 | ベストエフォート |

> ⚠️ Sales Claw は OSS プロジェクトであり、商用サポート / SLA は提供していません。
> 上記は目安であり、保証ではありません。返答が遅れた場合は再投稿してください。

## コントリビュート

ユーザーとしてだけでなく、コードや翻訳で貢献いただける場合は [CONTRIBUTING.md](./CONTRIBUTING.md) をご参照ください。

## よくある質問

### Q: Windows で SmartScreen 警告が出ます
A: Windows code signing 未対応のため (詳細: [ROADMAP.md](./ROADMAP.md) の Known Limitations 参照)。「詳細情報」→「実行」で起動できます。

### Q: 自動更新が来ません
A: 起動 5 秒後 + 6 時間ごとに GitHub Releases の `latest.yml` を polling します。Firewall で `api.github.com` がブロックされていないか確認してください。

### Q: AI CLI (Claude/Codex/Gemini) のインストール先は？
A: Sales Claw とは別途、`npm install -g @anthropic-ai/claude-code` 等で別途インストールが必要です。詳細は [README.md](./README.md) を参照。

### Q: ライセンス料・利用料はかかりますか？
A: Sales Claw 自体は MIT ライセンスで無料です。ただし、利用する AI CLI のサブスクリプション (Claude Pro 等) や API キーの利用料は別途必要です。

### Q: GDPR / EU 在住者へ送信できますか？
A: ユーザー責任です。[PRIVACY.md](./PRIVACY.md) の GDPR セクションをご確認ください。

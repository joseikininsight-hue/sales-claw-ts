# Data Directory

このディレクトリには、配布・公開してよいサンプルだけを置きます。

サンプル設定は、実運用の個人情報や社内営業文脈を含まない中立的な内容にしています。導入時はこのファイルをそのまま使うのではなく、自社情報・自社の提供価値・対象リストに置き換えてください。

- `sample-settings.json`: 初回起動時にコピーされるサンプル設定
- `sample-targets.csv`: UI確認用のサンプルターゲットリスト

以下のような実運用データは `.gitignore` で除外されています。

- `settings.json`
- `action-log.json`
- `contact-history.json`
- `emails.json`
- `ai-submit-queue.json`
- `dashboard-runtime.json`
- ユーザーが追加した `.xlsx` / `.csv` のターゲットリスト

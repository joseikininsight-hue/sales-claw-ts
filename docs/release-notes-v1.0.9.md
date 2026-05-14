# Sales Claw v1.0.9

## 主要更新

- Windows デスクトップ版を最新 UI / UX に更新
- AI Provider を `Claude / Codex / Gemini` から選択可能に変更
- 設定画面にセットアップガイドと Excel import / export を追加
- 確認待ち、企業一覧、進行状況ログの操作性を改善
- API / SSE / PTY のローカル認証まわりを強化
- 誤って `Blocked cross-origin dashboard request.` になるケースを修正

## パフォーマンス

- `/api/data` のキャッシュ化
- 不要な standalone dashboard 多重起動の抑止
- 更新時の再描画頻度を調整
- AI status / update status ポーリングの軽量化

## 配布

- GitHub Releases から各 OS 向けアプリを配布
- Windows では `Sales-Claw-Setup-1.0.9.exe` を利用
- デスクトップ版の利用だけであれば Node.js の追加インストールは不要

## 補足

- AI 機能の利用には Claude Code CLI / Codex CLI / Gemini CLI のいずれかを別途インストールしてください
- `latest*.yml` は自動更新用ファイルです

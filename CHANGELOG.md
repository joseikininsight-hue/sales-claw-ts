# Changelog

## 2.0.0-rc.1 - 2026-05-14 (OSS / Public Release 準備完了)

**最初のパブリックリリース候補。TypeScript 移植 + 公開可能化パッチ。**

### Programmatic Credit 対応 (2026-06-15 ポリシー)
- **`src/spawn-env-sanitizer.ts`** (新規): `claude -p` ヘッドレス起動時に `ANTHROPIC_API_KEY` / `AWS_*` / `GOOGLE_*` / `OPENAI_API_KEY` 等 **22 種の課金リーク env を spawn options.env から削除**するサニタイザを導入。subscription credit 枠 (= 月額プラン) で課金される経路に切替
- **`buildManagedProviderEnv` 中央サニタイズ**: `src/dashboard-server.ts` の中央 env builder に組込み、parallel-dispatcher / cli-agent / form-fill / list-builder など全 spawn 経路を一括カバー
- **HOME / USERPROFILE を provider-home へ向ける**: subscription token が `<runtime data dir>/provider-homes/claude/.claude/credentials.json` から読まれるよう経路整備
- **Phase A を Haiku 化**: `settings-manager.getAiModelForPhase('site-analysis')` で `claude-haiku-4-5` を既定に (token 単価 1/10)
- **Phase B は Sonnet 維持**: メッセージ文章品質を落とさない
- **企業分析キャッシュ** (`src/analysis-cache.ts` 新規): 30 日 TTL ディスクキャッシュ、同じ会社の再分析を 0 token に。`%APPDATA%/sales-claw/runtime/data/cache/analysis/` に sha256(url+name) 単位で保存、5000 件超過で mtime 古い順 evict、PII 漏洩防止のため value のみ保存 (meta フィールド廃止)
- **Prompt cache 再利用率向上**: `--exclude-dynamic-system-prompt-sections` を全 `claude -p` 起動に追加
- **docs/programmatic-credit-migration.md** 新規: 認証切替手順 + トラブルシュート

### OSS 公開準備
- **LICENSE (MIT)** を root に追加 (electron-builder.yml の "MIT License" 宣言と一致)
- **`.github/workflows/ci.yml`** 新規: PR / main push で typecheck + lint + unit test を Ubuntu / Windows × Node 20 / 22 のマトリクスで実行
- **`.github/workflows/release.yml`** 新規: main push で `v{version}` タグ自動作成 → Win / Mac / Linux クロスビルド → GitHub Releases 自動 publish (electron-builder の `--publish always`)
- **package version**: `2.0.0-ts.0` → **`2.0.0-rc.1`** (リリース候補化)

### TypeScript 移行基盤
- **ESLint 10 + @typescript-eslint 8 を完全に動作する状態に**: 不足していた `eslint-plugin-n` / `eslint-plugin-promise` を devDeps に追加
- **`.ts` ファイルの lint 有効化**: `@typescript-eslint/no-explicit-any` を warn でルール化 (新規 any の混入をガード、既存 949 件は可視化)
- **`src/types/helpers.ts`** 新規: `parseJsonSafe` / `parseJsonAs` / `Result` / `ok` / `err` / `errorMessage` / `isPlainObject` / `isString` / `isNonEmptyString` / `getString` / `getNumber` / `getBoolean` / `getArray` / `getObject` / `requireSafe` / `clampNumber` / `truncate` — 既存 `: any` を unknown + ガード関数で narrow するためのプリミティブ集
- **`docs/typescript-migration-roadmap.md`** 新規: Stage 1 (現在) / Stage 2 (any 段階削減) / Stage 3 (strict 化) / Stage 4 (構造整理) の長期ロードマップ
- **lint**: 0 errors / 1129 warnings の状態に到達 (warnings は段階移行用の可視化)

### Test
- **`tests/spawn-env-sanitizer.test.cjs`** 新規 (16 件)
- **`tests/analysis-cache.test.cjs`** 新規 (13 件)
- `npm run test:unit` で計 130 件全パス

---

## Web v1.0 - 2026-05-13 (Landing / Blog / Docs 公開準備)

**Vercel デプロイ向け Next.js サイトの完成版**

### Sites / Pages
- **新規ページ**: `/about` `/pricing` `/contact` `/authors/keishi_nakazawa` `/not-found.tsx` を追加
- **Blog**: カテゴリフィルタ + 記事検索 (`?category=` `?q=`) を実装
- **OG Images**: about / pricing / contact / download / blog / docs に Edge runtime の `ImageResponse` ベース OGP 画像を追加 (1200x630)
- **Sitemap**: LP アンカーのみだった `app/sitemap.ts` を全ページ + ブログ記事に拡張
- **Robots**: `/api/` `/_next/` `/admin/` を Disallow + GPTBot / ClaudeBot / PerplexityBot 等 AI クローラ 8 種を明示 Allow

### SEO / Analytics
- **GA4 (Consent Mode v2)**: `NEXT_PUBLIC_GA_MEASUREMENT_ID` 設定時に `default denied` で初期化、Cookie 同意バナーで `granted` 切替
- **Cookie バナー** (`components/consent/cookie-banner.tsx`): `localStorage` で同意状態保持、`gtag('consent','update')` で反映
- **Privacy Policy**: GA4 利用について明記、Consent Mode 動作を記載
- **Security headers**: `next.config.mjs` で production CSP / HSTS / X-Frame-Options / Permissions-Policy

### Refactor
- **GithubIcon 重複削除**: 6 ファイルに散在していた inline `GithubIcon` 関数を `components/icons/github-icon.tsx` に統合
- **Footer**: 導入事例 / 採用情報 / RSS / ニュースレターのリンクを撤去、About / Pricing / Contact 動線を追加
- **Site Nav**: 「料金」リンクを `/#料金` → `/pricing` に差し替え

### Docs
- `docs/vercel-deployment.md` を新規追加 (環境変数 / CSP / Consent Mode / デプロイ後チェックリスト)

---

## v1.2.111 - 2026-05-13

**Phase A LLM解析の安定化 + Claude CLI起動証拠ログ**

### Bug Fix
- **Phase A 並列度を 2 に制限**: CPU コア数で決めていた並列度 (最大 8) が原因で、内部 spawn される `claude -p` プロセスが同時 12-16 個になり、Claude Pro レート制限に抵触して 90 秒タイムアウトしていた。`PHASE_A_CONCURRENCY` を 2 に固定 (環境変数 `SALES_CLAW_PHASE_A_CONCURRENCY` で上書き可)
- **LLM 解析タイムアウト 90秒 → 120秒**: 並列実行時の Claude API レート競合を考慮
- **失敗時ヒント追加**: タイムアウトログに「Claude Pro レート上限の可能性」案内を追加

### Observability
- **Claude CLI spawn 証拠ログ**: `[llm-cli] claude spawned pid=... at ISO時刻` を stderr に出力。ハングなのかレート待ちなのかが特定できる
- **進捗ログ強化**: `thinking('claude CLI 起動中... (claude.cmd)')` で起動フェーズを可視化
- **経過秒数表示**: 失敗時に「LLM 解析失敗 (タイムアウト / Xx秒)」と実時間を出す

### Test Results (並列2社同時実行)
- 株式会社CAICA DIGITAL: 90秒で LLM 解析完了 (verdict=skip)
- ANAシステムズ: 88秒で LLM 解析完了 (verdict=skip)
- v1.2.110では両社とも 90秒タイムアウトで失敗 → v1.2.111 で復旧

## v1.2.110 - 2026-05-12

**URLなし企業のPhase B委譲 + LLM解析タイムアウト延長**

### Bug Fix
- **URLなし企業がキューエラーになる問題を修正**: `urlMissing=true` (会社名からの公式サイト探索に失敗) の企業が Phase A でスキップされていた問題を修正。Phase B (CLI) に `urlMissing=true` マーカーを渡し、CLIが WebSearch で公式サイトを特定してからフォーム入力するフローに変更

### Performance
- **LLM解析タイムアウトを延長**: `llm-site-analyzer` の `timeoutMs` を 45秒 → **90秒** に延長。並列処理時のCLI起動遅延でタイムアウトが多発していた問題を解消
- **サイト分析タイムアウトも延長**: `analyzeCompanyLite` の Promise.race タイムアウトを 45秒 → **60秒** に延長

### UX
- **URLなし企業のPhase Bプロンプト修正**: `batch_rules` と `messageLines` から「urlMissing=true はエラー」という矛盾した指示を削除し、「WebSearch で公式サイト探索 → フォーム入力」という正しい指示に変更
- **log-action ガード緩和**: `form_fill` 済みの `urlMissing=true` 企業は `site_analysis` の不十分チェックをバイパスし `awaiting_approval` を許可

## v1.2.91 - 2026-05-10

**重要セキュリティ + 安定性 + UX 強化リリース**

### Security (Critical)
- **logAction を専用 API endpoint に切替**: 旧 `node -e shell` 経由 (会社名のシェル/プロンプトインジェクションで RCE 可能) を廃止し、`/api/log-action` POST + サーバー側サニタイズ (制御文字除去 / アクション whitelist / 最大長 truncate) に変更
- **`/api/settings` レスポンスで API キーマスク**: `apiKeys.*` `secrets.*` `password` `token` 系を `***` に置換 (空文字はそのまま)
- **`upload-document` パス検証**: PROJECT_ROOT または USER_DATA_DIR 配下のみ許可、拡張子ホワイトリスト (.pdf .md .txt .docx .xlsx .csv .pptx .xls .doc)、`..` トラバーサル拒否

### Stability / Performance
- **Phase A 並列度 semaphore**: 100 社一気に投入で 100 個の Node subprocess → 8-12 GB RSS スパイクの問題を解消。`max(2, min(8, cpus.length+1))` で上限
- **settings.json file-lock**: concurrent write の競合 (ICP 設定保存 + 他保存) でデータ消失するレースを排除
- **MCP Playwright slot プロファイル分離** (1.2.89→90): 並列モードで chromium User Data Dir 競合 → 2 社失敗を解消

### UX
- **ICP (理想顧客) UI**: 「提供価値」セクションに 8 入力欄 (descriptionFreetext / mustHave / dealBreakers / exemplars.positive,negative / minSiteTextLength / useLLMAnalyzer / useLLMMessageGenerator)
- **空状態メッセージ強化**: 確認待ち / 送信済タブで「次に何をすべきか」案内追加
- **進捗バッジ刷新**: `message_draft` → 「文面生成済 / フォーム入力待ち」
- **Pagination カウンタ修正**: 空リストで「全 1 件」誤表示を解消

### Phase A / Phase B
- **URL 空企業の CLI 委譲復活** (1.2.84→90): companyUrl 空 → CLI が WebSearch → 公式サイト発見 → フォーム入力。watchdog 10 → 20 分に拡張
- **HTTP fetch 大手対応**: 完全な Chrome 131 UA + 8 ヘッダ (Sec-Fetch / Sec-Ch-Ua) + gzip/br 自動解凍 で sint/dentsu/hakuhodo 等 0 字 → 1900-2300 字に
- **Playwright fallback**: HTTP fetch で siteText < 200 字なら chromium 起動して取得 (BUG dmgmori-digital 0→1914字)
- **CAPTCHA → awaiting_approval 仕様**: 旧「CAPTCHA = error」を撤回。フォーム入力 + ss-{No}-input.png + awaiting_approval (人間が CAPTCHA 解いて送信)
- **メッセージ品質改善**: `truncateSoft` で "…" 混入の解消、`businessAreas` 機械選択を `companyType` 優先に変更 (「貴社のセキュリティ案件」決めつけ防止)

### UI
- **managed PTY 単一ブラウザ + タブ方式**: 1.2.85 で「2 社以上 → 並列ルート (3 Chromium)」にした判断ミスを撤回。CLAUDE.md タブ管理契約通り 1 Chromium で 1社目 navigate / 2社目以降 window.open に統一

### 内部
- Phase A skipped propagate (no field) で「全件失敗」誤表示解消
- runParallelAnalysisWorker が `parsed.skipped===true` を正しく failures から分離
- `recommendFormSessionStatus` に `proceed_then_await` 追加 (CAPTCHA + フィールドあり)

## v1.2.23 - 2026-04-27

- 内蔵ターミナルの3つの不具合を修正
  - **ログイン成功後も認証バナーが再表示される問題**: `Login successful` / `Logged in as` を検知したらバッファをクリアしてバナーを永続的に閉じる。エラーは新しい chunk のみで判定し、古い「Please run /login」テキストの誤再検知を防止
  - **入力時の表示崩れ**: CLI Activity タブが表示状態に切り替わるたび `fitAddon.fit()` を 40/200/600ms で再実行し、PTY に resize を送信。隠れタブで初期化された xterm のサイズ 0 問題を解消
  - **ヘッダの「AI を起動」で立ち上げた CLI が内蔵ターミナルに映らない問題**: WebSocket の `connected` イベントで `running:true` を受信したら、自動的に terminal host を表示し xterm を初期化して既存セッションにアタッチする

## v1.2.22 - 2026-04-26

- **dev source override + hot reload を導入** — UI 修正のたびの再インストール (159MB / UAC) が原則不要に
  - `electron-main.js` に `SALES_CLAW_DEV_DASHBOARD_SRC` env を追加: 絶対パスで指定すると、bundled `resources/app/src/dashboard-server.cjs` ではなくその path 配下を `require` する
  - `dashboard-server.cjs` に `SALES_CLAW_DEV_HOT_RELOAD=1` env を追加: `buildPage()` の冒頭で `./ui/**` の require cache を捨てて、ブラウザ再読み込みごとに client-scripts をディスクから再読込
  - `renderX(...)` を関数ラッパに変更し、cache 再構築が即時反映されるように (production では通常の cache lookup で性能影響なし)
  - 起動ヘルパー: `scripts/run-dev-mode.bat` をダブルクリックすれば dev mode で立ち上がる
  - 通常の起動 (env 無設定) では bundled UI / production runtime のまま

## v1.2.21 - 2026-04-26

- AI 起動モーダルのプロバイダーアイコン視認性を改善
  - 既定でアイコン枠に微弱なブランドカラー背景 + 1px ボーダー
  - **ダークモードでは Codex (黒系ロゴ) のアイコン枠を白パネルに切替** — 同化問題解消
  - Claude / Gemini もブランドティント背景で視認性向上
  - hover / selected 時はさらにコントラスト強調

## v1.2.20 - 2026-04-25

- 設定タブ サイドバーを写真リファレンスに忠実に
  - メニュー項目間の余白を 4px → 8px、項目内 padding を 14px に拡張で読みやすく
  - 「設定のヒント」をメニューと視覚的に分離 (24px の spacer)
  - ヒントカードを縦レイアウトに刷新: 電球アイコン + 太字タイトル / 説明文 (2行) / 全幅の「詳細ガイドを見る」ボタン
  - 電球アイコンを `font-variation-settings:"FILL" 1` で塗りつぶし表現に

## v1.2.19 - 2026-04-25

- **インストーラサイズを 159MB → ~80MB に半減 (約50%減)**
  - `next` (145MB) / `react-dom` (7MB) / `lucide-react` (6.5MB) / `react` を `dependencies` から `devDependencies` に移動
  - これらは `lp:dev` (ランディングページ用 Next.js) でのみ使用され、デスクトップアプリは一切 import していなかった
  - 結果: `resources/app/node_modules/` から ~160MB のデッドウェイトを削除
  - 自動アップデートで毎回ダウンロードする量も同じく半減

## v1.2.18 - 2026-04-25

- 自動アップデート後の "Cannot find module" 系起動失敗を根治
  - `nsis.runAfterFinish: false` を追加し、NSIS インストール直後の auto-launch を停止
  - 旧アプリの uninstall → 新ファイル書き込みが完了する前にアプリが起動して、まだコピーされていない依存モジュール (universalify / node-pty / ws / xlsx 等) を `require` しに行って失敗する競合状態を解消
  - インストール後はトレイ / スタートメニューから手動で起動する運用に変更

## v1.2.17 - 2026-04-25

- 設定タブ刷新の不具合修正 (v1.2.16 のフィードバック対応)
  - `Cannot set properties of null` エラーとフォーム空白問題を修正: rebuild が二重実行で1回目に moveした子を2回目に見失っていた → 完全に idempotent 化 (placeholder で原位置を保持し、wrap先を `unwrapPreviousShell` で戻してから再構築)
  - Excel取込ボタン (`入力テンプレート` / `Excelから読み込む`) もフォームと一緒に保持されるように
  - サイドバー / ヘッダ / ステッパー / フォームを **独立した白カード** として配置し、`--bg-base` の親背景でカード間に隙間を表現
  - 「設定のヒント」をフッタからサイドバー下部に移動 (写真リファレンス通り)
  - フォームカードを min-height 520px に拡張し、下部の白い無駄な余白を解消
  - サイドバーを sticky にしてスクロール時もメニューが追従

## v1.2.16 - 2026-04-25

- 設定タブを大幅刷新 (写真リファレンスに準拠)
  - サイドバー: アイコン + 名前 + 説明の2行レイアウト、アクティブ時はブルー強調
  - 上部に **進捗付きヘッダ** (「設定の完了率 X%」+ プログレスバー)
  - **5ステップのインジケータ** を追加 (会社プロフィール / 提供価値 / ターゲットリスト / メッセージテンプレート / 環境設定)
  - 会社プロフィールに **リアルタイム更新の右側プレビューパネル** を追加 (会社名・連絡先・会社概要)
  - フッタに「設定のヒント」+ **「保存して次へ」ボタン** を配置 (保存後に次のステップへ自動遷移)
  - 既存のフォーム ID / 保存ロジックは温存 (non-invasive な装飾オーバーレイ)

## v1.2.15 - 2026-04-25

- **MCP Playwright チェックを launch 時の必須から外す**
  - `/api/launch-ai` の前段で MCP 設定確認に失敗してもエラーにせず警告ログだけにする
  - Gemini / Codex の `mcp` サブコマンド未対応や偽陰性で起動できなかった問題を解消
  - バッチ送信パスでは引き続き MCP 必須 (`requireMcp: true` 経路は据え置き)
- **ターミナル高さをドラッグでリサイズ可能に**
  - `cli-term-host` 下端にドラッグハンドル(8px / `cursor: ns-resize`)
  - 200px〜画面の85% の範囲で自由調整、`localStorage('cli-term:height')` に永続化
  - リサイズ中は `fitAddon.fit()` を毎フレーム呼んで PTY サイズも追従

## v1.2.14 - 2026-04-25

- 内蔵ターミナルで「文字入力できない」「プロンプトが見切れる」問題を修正
  - 高さ 380px → 460px に拡張
  - クリックでターミナルを強制フォーカス、`cursor: text` で操作可能性を視覚化
  - フォーカス時に `outline: 1px solid` のリングを表示
  - `xterm-helper-textarea` の z-index を `-5` → `5` に上げて入力捕捉を確実化
  - 受信データのたび `scrollToBottom()` でプロンプトを常に視野内に保持
  - launch 後 40 / 120 / 360 / 800ms の 4 回 `fitAddon.fit()` を呼んで再レイアウトに耐える
  - `window.resize` 監視で再フィット

## v1.2.13 - 2026-04-25

- ページネーションバーの「表示件数」セレクトを画面右端から外し、ページ番号のすぐ右に寄せた左寄せレイアウトに変更
  - `justify-content: space-between` → `flex-start` / pages の `flex` を grow しない設定に
  - サマリ → ページ番号 → 表示件数セレクト の順で 18px gap でクラスタリング

## v1.2.12 - 2026-04-25

- 企業一覧 / 確認待ち / 送信済み / Action Log 全リストに **ページネーション** を追加
  - "Minimal SaaS" スタイル: 全件表示+ページ番号 (省略付き) + 表示件数セレクト
  - 表示件数は localStorage に永続化 (リスト単位)
  - フィルタで非表示の行は自動除外してページ計算
  - **10,000 件**まで耐えるパフォーマンス検証済み (注入 + ページング合計 1秒程度)
  - レスポンシブ対応 (760px 未満で縦並び)

## v1.2.11 - 2026-04-25

- CLI Activity タブに「**Claude を起動 / Codex を起動 / Gemini を起動**」ボタンと内蔵対話ターミナル (xterm.js) を追加
  - 既存 WebSocket (`/terminal`) + `/api/launch-ai` / `/api/stop-ai` / `/api/ai-input` と接続
  - PTY 出力をブラウザ内で表示、キーストロークも双方向
- 認証エラー(`Please run /login` / `API Error: 401` / `authentication_error` / `Invalid API key` / `token expired`) をリアルタイム検出すると、**手順入りの黄色アシストバナー** を自動表示
  - 「**/login を実行**」ボタンでターミナルに自動入力
  - 公式ドキュメントへのリンク併記
- 非エンジニアでもログイン作業ができるよう、空状態のヘルプ文言・ステータス LED・閉じるボタンを整備

## v1.2.10 - 2026-04-25

- `verify-release-readiness.cjs` を `nsis.differentialPackage: false` 時に blockmap 不存在を許容するよう修正 (v1.2.9 の Windows ビルド失敗対応)
- v1.2.9 は Windows 配布なし(Mac / Linux のみ)。実質的な内容は v1.2.10 と同じ

## v1.2.9 - 2026-04-25

- 自動更新の差分配信 (`differentialPackage`) を無効化し、毎回フルインストーラ転送に切り替え
  - 既存インストールが CI ビルドと完全一致していない場合に node_modules の transitive 依存 (universalify ほか) が脱落して `Cannot find module 'universalify'` で起動失敗する事故が v1.2.5→1.2.6 / 1.2.6→1.2.7 / 1.2.7→1.2.8 の 3 連続で発生したため、信頼性を優先
  - ダウンロード量は毎回 ~200MB に増えるが、自動更新の確実性が大きく改善

## v1.2.8 - 2026-04-25

- 「編集して再送」を実装 (送信済みカードのボタン → モーダル表示 → 編集 → POST /api/resend-prepare → 確認待ちタブへ復帰)
  - バックエンド `/api/resend-prepare` を追加 (action-log と contact-history を更新)
  - 検証: 空文 / 32KB 超 / 企業番号不正 を 400 で弾く
  - キーボード: Esc で閉じる / Ctrl+Enter で送信
- 確認待ちカードから「AI 実行ログ」セクションを削除し、全体パディング・余白・フォントを縮小して 1 画面で多くの情報が見られるようコンパクト化
- 企業一覧テーブルの送信日付セルを刷新 (緑モノ強調 → check_circle アイコン + 通常書体、複数回連絡時のみ「N回目」chip)
- ヘッダ (.app-header) の sticky 上書き (`position:relative`) を削除し、`#mainTabNav` がスクロール時に画面上部へ正しく固定されるように修正

## v1.2.7 - 2026-04-25

- 確認待ち (awaiting) カードを「送信内容の確認」パネルに刷新 (ヘッダ + 2カラム + フッタ)
- 送信済み (sent) カードを同じデザイン言語に統一し、連絡履歴をタイムライン表示
- スクリーンショットの拡大/縮小コントロールを追加 (50%–400% / 25%刻み / リセット)
- 「編集して修正」「返信を記録」「編集して再送」など将来機能のUIプレースホルダを配置
- 企業一覧テーブル (#mt) の列幅をドラッグで調整可能に (localStorage で永続化、ダブルクリックでリセット)

## v1.2.6 - 2026-04-25

- 自動アップデート経路の E2E 検証用リリース
- `verify:dist` ゲートを再確認

## v1.2.5 - 2026-04-25

- ダッシュボード正本を `src/dashboard-server.cjs` + `src/ui/**` + `src/routes/**` に分割
- プレビュー (3480) / 開発 Electron / パッケージ済み Electron が同一ソースから起動するように統一
- `scripts/verify-release-readiness.cjs` / `scripts/verify-surface-parity.cjs` を `predist` / `postdist` ゲートとして配線
- `scripts/preview-dashboard.cjs` を追加 (3480 でルートのダッシュボードを起動)
- `scripts/install-latest-win.ps1` を追加 (Sales Claw 起動中なら停止検知して安全にインストール)
- オフライン用 vendor 資産を `assets/vendor/` に同梱 (Inter / JetBrains Mono / Noto Sans JP / Material Symbols / Phosphor / Tailwind / Chart.js / xterm)
- `electron-builder` 設定を `joseikininsight-hue/sales-claw` / channel:latest / publishAutoUpdate:true に固定
- `local-test` / `${env.GH_OWNER}` / `${env.GH_REPO}` のプレースホルダフィードを禁止
- `docs/release-parity-and-autoupdate.md` / `.claude/commands/release-parity.md` を追加
- `AGENTS.md` / `CLAUDE.md` に Desktop Release / Auto Update Gate ルールを追加
- バッチ復旧用の `src/batch-watchdog` / `src/recovery-store` / `src/startup-cleanup` / `src/ai-runtime` を追加

## v1.0.9 - 2026-04-05

- Windows デスクトップ版を最新 UI / UX に更新
- Claude / Codex / Gemini の AI Provider 切り替えに対応
- 確認待ち・送信済み・企業一覧まわりの操作性と監査表示を改善
- 設定の Excel import / export とセットアップ補助を追加
- ダッシュボード API / ランタイム保護を強化
- `/api/data` のキャッシュ化、不要な多重起動抑止、ポーリングと描画負荷の見直しでパフォーマンス改善
- `Blocked cross-origin dashboard request.` の誤判定を修正
- テスト用の一時ファイル、検証用スクリプト、不要な残骸を整理

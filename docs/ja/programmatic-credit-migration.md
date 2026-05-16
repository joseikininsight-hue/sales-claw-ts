English version: [programmatic-credit-migration.md](../programmatic-credit-migration.md)

# Programmatic Credit 移行ガイド (2026-06-15 ポリシー対応)

## 背景

Anthropic は 2026-06-15 から Claude Pro / Max / Team / Enterprise の月額
プランに **"Programmatic Credit"** 枠を含めるようになる。
これに伴い、以下の経路の API 呼び出しが「月額枠の中で消費される」よう
になる:

- `claude` CLI の対話セッション
- `claude -p` (headless) サブプロセス
- Agent SDK
- GitHub Actions の `anthropics/claude-code-base-action` 系
- 第三者製の Agent SDK 利用

ただし **以下のいずれかの env が子プロセスにセットされていると、
Anthropic は subscription credit ではなく API 従量制 (= 別課金) を優先する**:

| Env Key | 経路 |
|---|---|
| `ANTHROPIC_API_KEY` | 直接 API key |
| `ANTHROPIC_AUTH_TOKEN` | OAuth token |
| `ANTHROPIC_API_URL` / `ANTHROPIC_BASE_URL` | カスタム endpoint |
| `CLAUDE_CODE_USE_BEDROCK` + `AWS_BEARER_TOKEN_BEDROCK` | AWS Bedrock 経由 (自分の AWS 課金) |
| `CLAUDE_CODE_USE_VERTEX` + `ANTHROPIC_VERTEX_PROJECT_ID` | GCP Vertex 経由 (自分の GCP 課金) |

このプロジェクト (Sales Claw) は Electron アプリで Node から `claude -p` を
spawn する設計のため、ユーザーのシェル env に上記が残っていると意図せず
従量課金に転落する。

参照:
- [Use the Claude Agent SDK with your Claude plan (Anthropic Support)](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
- [claude -p suggested to Max subscriber — caused unintended API billing (#37686)](https://github.com/anthropics/claude-code/issues/37686)

---

## このプロジェクトでの対応 (実装済み)

### 1. spawn env の自動サニタイズ

すべての `claude / codex / gemini` CLI 起動経路で、課金リーク env を
**spawn options.env から削除** する `spawn-env-sanitizer.ts` を導入。

| ファイル | 修正内容 |
|---|---|
| `src/spawn-env-sanitizer.ts` (新規) | `buildSanitizedSpawnEnv()` を export |
| `src/dashboard-server.ts:2047-` | **`buildManagedProviderEnv` 中央サニタイズ** (parallel-dispatcher / cli-agent / form-fill / list-builder 等、ここを通る全 spawn 経路をカバー) |
| `src/llm-site-analyzer.ts:289-` | Phase A の `claude -p` spawn に適用 |
| `src/llm-message-generator.ts:303-` | Phase B の `claude -p` spawn に適用 |
| `src/dashboard-server.ts:4434-` | parallel-analysis.cjs intermediate spawn に適用 (二重防御) |
| `src/ai-providers.ts:200-` | AI Provider Manager 経由の headless launch に適用 |

削除対象 env (`BILLING_LEAK_ENV_KEYS`):
```
# Anthropic 直接
ANTHROPIC_API_KEY
ANTHROPIC_AUTH_TOKEN
ANTHROPIC_API_URL
ANTHROPIC_BASE_URL

# 3rd-party provider switches
CLAUDE_CODE_USE_BEDROCK
CLAUDE_CODE_USE_VERTEX

# Bedrock (AWS)
AWS_BEARER_TOKEN_BEDROCK
ANTHROPIC_BEDROCK_BASE_URL
AWS_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY
AWS_SESSION_TOKEN
AWS_PROFILE

# Vertex (GCP)
ANTHROPIC_VERTEX_PROJECT_ID
CLOUD_ML_REGION
GOOGLE_APPLICATION_CREDENTIALS
GOOGLE_CLOUD_PROJECT
GCLOUD_PROJECT

# Codex / OpenAI
OPENAI_API_KEY
OPENAI_BASE_URL
OPENAI_ORG_ID

# Gemini
GEMINI_API_KEY
GOOGLE_API_KEY
```

### 2. HOME / USERPROFILE を provider-home に向ける

`claude` CLI は `~/.claude/credentials.json` から subscription token を読む。
このプロジェクトは provider-home として
`<APPDATA>/sales-claw/runtime/data/provider-homes/claude/` を使うため、
spawn 時の `HOME` (POSIX) / `USERPROFILE` (Windows) をそこに向ける。

ただし provider-home に `credentials.json` が無い場合は HOME 上書きを
スキップする (`skipHomeOverrideIfNoCredentials: true`)。
ユーザーのデフォルト HOME に subscription 認証が入っていればそちらを使う、
というフォールバック方針。

### 3. Phase 別モデル使い分け

- **Phase A (サイト解析)**: `claude-haiku-4-5` を既定 (token 単価 1/10)
- **Phase B (メッセージ生成)**: `claude-sonnet-4-6` を既定 (文章品質)

設定で上書き可:
```jsonc
// data/settings.json
{
  "preferences": {
    "aiModelsByPhase": {
      "site-analysis": { "claude": "claude-haiku-4-5" },
      "message-generation": { "claude": "claude-sonnet-4-6" }
    }
  }
}
```

### 4. 企業分析キャッシュ

`src/analysis-cache.ts` で `analyzeCompanyLite` の結果を 30 日 TTL で
ディスクキャッシュ。同じ会社を再分析するときは 0 token で返す。

- key: `sha256(normalized_url + normalized_company_name + schema_version)[0:16]`
- 保存先: `<runtime data dir>/cache/analysis/<key>.json`
- LRU: 5000 エントリ超過で mtime 古い順に evict

無効化:
```
export SALES_CLAW_DISABLE_ANALYSIS_CACHE=1
```

### 5. Prompt Cache 再利用率の向上

すべての `claude -p` spawn に `--exclude-dynamic-system-prompt-sections`
フラグを追加。per-machine な dynamic section (cwd / env info / memory paths /
git status) が first user message に逃げるため、システムプロンプトの
hash 一致率が上がり、prompt cache (5min TTL) が効きやすくなる。

---

## ユーザー側で必要な作業

### Step 1: provider-home に subscription 認証を仕込む

初回のみ。ダッシュボードの「Claude を起動」ボタンから対話セッションを
立ち上げて `/login` を実行するか、コマンドラインで以下:

**Windows (PowerShell):**
```powershell
$env:USERPROFILE = "$env:APPDATA\sales-claw\runtime\data\provider-homes\claude"
claude auth
```

**Linux / macOS:**
```bash
HOME="$HOME/.config/sales-claw/runtime/data/provider-homes/claude" claude auth
```

ブラウザでログインすると provider-home 配下の `.claude/credentials.json`
に subscription token が書き込まれる。

### Step 2: シェル env の確認

シェル設定ファイル (`~/.bashrc` / `~/.zshrc` / PowerShell `$PROFILE`) に
`ANTHROPIC_API_KEY` 等が export されていないか確認する。
spawn 時のサニタイズで自動的に消すが、ユーザーが対話的に `claude` を
直接起動する場合はサニタイズが効かないので注意。

### Step 3: 動作確認

1. Sales Claw を起動 (`npm start`)
2. テスト企業 1 件で営業バッチを実行 (`useLLMAnalyzer` を ON にした状態で)
3. **Anthropic Console** ([https://console.anthropic.com/usage](https://console.anthropic.com/usage)) を開き、
   - **"Subscription Credit Usage"** タブで使用量が増えていることを確認
   - **"API Usage"** タブで使用量が増えていない (または別計上されている) ことを確認
4. stderr に以下のログが出ていることを確認 (sanitize 実績の証跡):
   ```
   [llm-cli] env sanitized: removed=["ANTHROPIC_API_KEY"], homeOverridden=true
   ```
   ※ もともとシェル env に課金リーク env が無ければ `removed=[]` になる。
   `homeOverridden=true` になっているのが重要。

---

## トラブルシュート

### Q. `[llm-cli] env sanitized: removed=[]` ばかりで `homeOverridden=false` になる

provider-home に `credentials.json` が無い。Step 1 を実施する。

### Q. spawn 後に "Authentication required" エラーになる

provider-home の credentials.json が壊れているか期限切れ。
provider-home を一度削除して Step 1 をやり直す:

```bash
rm -rf "$APPDATA/sales-claw/runtime/data/provider-homes/claude"
```

### Q. やっぱり API 従量で課金される

シェル env に課金リーク env が残っていないか確認:

```bash
# 一旦 unset してから Sales Claw を起動
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX
npm start
```

それでも従量課金される場合、Anthropic Console で plan の "Programmatic
Credit Enabled" が ON になっているか確認 (一部の旧プランは要手動 opt-in)。

### Q. 既に流したバッチの分は遡って subscription credit に振り替えられる？

**No.** Anthropic 側の請求は spawn 時の env で判定済み。過去分は API 従量に
そのまま計上される。今後の spawn のみ subscription credit に乗る。

---

## モニタリング

### Anthropic Console
- [Usage Dashboard](https://console.anthropic.com/usage) — 日次/月次の credit 消費量
- "Programmatic Credit Remaining" を週次でチェック

### Sales Claw 内部
- `GET /api/cost/summary` (既存) — `data/ai-run-metrics.jsonl` 集計
- ダッシュボード左下「AI コスト目安」chip

### 異常時の早期検知
以下のいずれかが発生したら課金が予定外に動いている可能性:
- Anthropic Console の "API Usage" (= 従量) が急増
- ダッシュボードのコスト目安 chip が想定の 5 倍以上

→ stderr ログで `removed=[]` かつ `homeOverridden=false` のままになって
いないか確認する。

---

## 改訂履歴

| 日付 | 内容 |
|---|---|
| 2026-05-14 | 初版作成 (P0 spawn env サニタイズ + P1 Haiku + P1 キャッシュ + P2 prompt cache) |

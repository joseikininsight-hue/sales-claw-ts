# Sales Claw Design System

> B2B営業アプローチ自動化ダッシュボード。業務効率と信頼感を両立する、データ密度の高いプロフェッショナルUI。
> Inspired by: Notion (温かいミニマリズム + 4層シャドウ), Stripe (金融グレードの精度), Linear (ステータス駆動UI), Vercel (shadow-as-border), Superhuman (極限の色の節制)

---

## 1. Visual Theme & Atmosphere

Sales Clawは「営業の司令塔」として、大量の企業データと処理ステータスを一目で把握できるUIを提供する。白を基調としたクリーンな画面に、深いスレートブルー(`#0f172a`)の見出しと、鮮やかなブルー(`#2563eb`)のアクセントが、信頼感と行動喚起を両立する。

**設計思想:**
- **データ密度 × 余白のバランス**: テーブルやステータスカードは密に、それを囲むUI chromeは余裕を持たせる（Stripe方式）
- **ステータス駆動**: 全ての色は意味を持つ。装飾的な色は使わない
- **Shadow-as-Border**: Vercel方式の `box-shadow: 0 0 0 1px` でボーダーを表現。スムーズな角丸と状態遷移を実現
- **コンパクト & スキャナブル**: 営業担当者が3秒で状況を把握できるレイアウト
- **ライトモード最適化**: 長時間の営業作業に適した目に優しい配色

---

## 2. Color Palette & Roles

### Primary
- **Claw Blue** (`#2563eb`): プライマリCTA、アクティブ状態、リンク、選択中タブ
- **Claw Blue Hover** (`#1d4ed8`): ホバー状態
- **Claw Blue Glow** (`rgba(37,99,235,.12)`): 選択行のハイライト、フォーカスリング背景
- **On Primary** (`#ffffff`): プライマリ上のテキスト

### Text — Notion風の温かいニュートラル（冷たいブルーグレーは使わない）
- **Heading** (`#1a1a1a`): 見出し、強調テキスト。温かいニアブラック（Notion `rgba(0,0,0,.95)` に近い）
- **Body** (`#5a5a58`): 本文、説明テキスト、セカンダリラベル。温かいグレー
- **Muted** (`#9a9a96`): キャプション、プレースホルダー、タイムスタンプ。温かいライトグレー

### Background (Light Mode) — Notion風の温かい白
- **Deep** (`#eeefeb`): 最も奥の面。スクロールバー、凹んだ領域。わずかにイエロー系
- **Base** (`#f5f5f3`): ページ背景。Notion風のウォームホワイト
- **Surface** (`#fafaf8`): カード内のサブ領域、テーブルヘッダー
- **Card** (`#ffffff`): カード、モーダル、最前面の面
- **Raised** (`#f0f0ee`): ホバーハイライト

### Status (セマンティック — 装飾使用禁止)
| トークン | HEX | 用途 | 背景(dim) |
|---------|-----|------|-----------|
| Success | `#059669` | 送信済み、完了 | `rgba(5,150,105,.1)` |
| Warning | `#d97706` | 確認待ち、要対応 | `rgba(217,119,6,.1)` |
| Error | `#dc2626` | エラー、失敗 | `rgba(220,38,38,.1)` |
| Info | `#7c3aed` | 分析中、処理中 | `rgba(124,58,237,.1)` |
| Neutral | `#64748b` | 除外、スキップ | `rgba(100,116,139,.1)` |

### Pipeline Status Colors (チャート・バッジ専用)
| ステータス | カラー | 用途 |
|-----------|--------|------|
| 対象 | `#6366f1` (Indigo) | 営業対象企業カウント |
| フォーム有 | `#94a3b8` (Slate) | フォームURL登録済み |
| 入力済み | `#3b82f6` (Blue) | フォーム入力完了 |
| 確認待ち | `#f59e0b` (Amber) | 人間の承認待ち |
| 送信済み | `#10b981` (Emerald) | 送信完了 |
| エラー | `#ef4444` (Red) | 処理失敗 |
| 除外 | `#64748b` (Slate) | 対象外 |

### Border
- **Subtle** (`rgba(15,23,42,.07)`): テーブル行区切り、軽いカード境界
- **Default** (`rgba(15,23,42,.12)`): 標準ボーダー、フィルターバー、入力欄
- **Strong** (`rgba(15,23,42,.22)`): ホバー時、アクティブ境界

---

## 3. Typography Rules

### Font Family
- **Primary**: `Inter`, system-ui, sans-serif
- **Monospace**: `JetBrains Mono`, `Fira Code`, monospace
- **Icon**: `Material Symbols Outlined` (font-variation-settings: 'FILL' 0, 'wght' 300)

### Hierarchy

| Role | Size | Weight | Line Height | Letter Spacing | Color | Use |
|------|------|--------|-------------|----------------|-------|-----|
| Page Title | 1.15rem | 900 | 1.0 | .02em | `--text-1` | アプリ名 |
| Section Label | .6rem | 700 | 1.0 | .07em | `--text-2` | uppercase。セクション見出し |
| Stat Number | 1.6rem | 700 | 1.0 | normal | 状況色 | mono。統計数値 |
| Stat Label | .6rem | 600 | 1.2 | .05em | `--text-2` | uppercase。統計ラベル |
| Table Header | .6rem | 700 | 1.0 | .07em | `--text-2` | uppercase。テーブル列見出し |
| Table Body | .8rem | 400 | 1.5 | normal | `--text-1` | テーブルセルテキスト |
| Body | .875rem | 400 | 1.5 | normal | `--text-1` | 標準本文 |
| Caption | .68rem | 500 | 1.3 | normal | `--text-2` | 補足情報、バッジラベル |
| Micro | .58rem | 700 | 1.1 | .03em | `--text-3` | バージョン番号、タイムスタンプ |
| Button | .78rem | 700 | 1.0 | .04em | inherit | ボタンテキスト |
| Filter Tab | .7rem | 500 | 1.0 | normal | `--text-2` | フィルターボタン |
| Filter Select | .78rem | 400 | 1.0 | normal | `--text-1` | ドロップダウン内テキスト |
| Code | .75rem | 500 | 1.4 | normal | inherit | mono。コードブロック |

### Principles
- **700-800は見出しとラベルのみ**。本文は400。ボタンとキャプションは500-700
- **uppercaseはセクションラベルとテーブルヘッダーのみ**。letter-spacingを`.05em`以上に
- **monoフォントは数値と技術情報のみ**。統計数値、バージョン、ログタイムスタンプ
- **フォントサイズは`.58rem`〜`1.6rem`の範囲**。極端に大きいサイズは使わない（ダッシュボードは情報密度が重要）

---

## 4. Component Stylings

### Buttons

**Primary (CTA)**
- Background: `var(--primary)` → `#2563eb`
- Text: `#ffffff`
- Padding: 6px 16px
- Radius: 20px (pill)
- Shadow: `0 2px 10px rgba(59,130,246,.3)`
- Hover: `var(--primary-dim)` → `#1d4ed8`
- Use: 「AIでフォーム入力」「AI を起動」

**Danger**
- Background: `#dc2626`
- Text: `#ffffff`
- Padding: 4px 12px
- Radius: 6px
- Use: 「選択を削除」

**Ghost / Outlined**
- Background: transparent
- Text: `var(--text-2)`
- Border: `1px solid var(--border-default)`
- Radius: 20px (pill)
- Hover: `var(--bg-raised)` background, `var(--text-1)` text
- Use: フィルタータブ、セカンダリアクション

**Filter Tab (Active)**
- Background: `var(--primary)`
- Text: `#ffffff`
- Border: `var(--primary)`
- Shadow: `0 2px 10px rgba(59,130,246,.3)`

### Cards & Panels

**Standard Card** (`.chart-panel`, `.tc`)
- Background: `var(--bg-card)` → `#ffffff`
- Border: `1px solid var(--border-subtle)`
- Radius: 8px
- Shadow: `0 1px 8px rgba(15,23,42,.08)`
- Hover: shadow → `0 4px 20px rgba(15,23,42,.1)`, transform: `translateY(-2px)`

**Dark Panel** (進行状況ログヘッダー)
- Background: `linear-gradient(135deg, #1e293b 0%, #334155 100%)`
- Text: `#e2e8f0`
- Border-radius: 8px (top only)
- Chip: `rgba(255,255,255,.1)` background, `#94a3b8` text

### Table

**Header Row**
- Background: `var(--bg-surface)` → `#f8f9fd`
- Text: uppercase, `.6rem`, weight 700, `var(--text-2)`
- Border-bottom: `1px solid var(--border-default)`

**Body Row**
- Background: `var(--bg-card)` (odd), `var(--bg-raised)` (even)
- Height: 44px fixed
- Text: `.8rem`, weight 400, `var(--text-1)`
- Hover: `var(--primary-glow)`
- Cursor: pointer (行クリックで詳細モーダル)
- Overflow: `text-overflow: ellipsis`

**Layout**: `table-layout: fixed` + `colgroup` で列幅を制御

### Filter Bar
- Container: `var(--bg-surface)` background, `1px solid var(--border-default)`, radius 10px
- Fields: `var(--bg-deep)` background, radius 7px, height 30px
- Focus: `border-color: var(--primary)`, `box-shadow: 0 0 0 3px rgba(59,130,246,.1)`
- Icon: Material Symbols 14px, `var(--text-3)`

### Toast Notifications
- Success: `rgba(16,185,129,.15)` bg, `var(--success)` text, green border
- Error: `rgba(239,68,68,.15)` bg, `var(--error)` text, red border
- Info: `rgba(59,130,246,.15)` bg, `var(--primary)` text, blue border
- Animation: `slideIn` from right, 3秒で自動消去

### Loading Overlay
- Backdrop: `rgba(0,0,0,.3)`
- Content box: `#fff`, radius 12px, shadow `0 8px 32px rgba(0,0,0,.2)`
- Spinner: `.spin` class, `var(--primary)` border-top
- Text: `.85rem`, `var(--text-1)`, weight 500

### Status Badge
- Radius: 4px
- Font: `.6rem`, weight 600
- Padding: 2px 8px
- Color-coded by status (Success/Warning/Error/Info)

### Thinking Indicator (AIの思考中)
- Spinner: `.think-spin`, 10px, `#818cf8` border-top
- Text: `.76rem`, italic, `#818cf8`
- Background: `rgba(99,102,241,.05)`, left border `rgba(99,102,241,.3)`

---

## 5. Layout Principles

### Spacing Scale
```
Base: 8px
Scale: 2px, 3px, 4px, 6px, 7px, 8px, 9px, 10px, 12px, 14px, 16px, 20px, 24px, 32px
```

### Grid System
- **App Header**: Fixed 48px, full width, `backdrop-filter: blur(12px)`
- **Tab Bar**: Horizontal tabs below header, pill-style buttons
- **Analytics Panel**: 3カラムグリッド (`1.1fr 1fr 1.8fr`)
  - Col1: 全体進捗 + ステータスリスト
  - Col2: ドーナツチャート
  - Col3: エリアチャート
- **Content Area**: Single column, max-width none (full width)
- **Table**: `table-layout: fixed` with explicit `colgroup` widths

### Whitespace Philosophy
- **セクション間**: 12px（コンパクト。スクロール量を減らす）
- **カード内padding**: 12-16px
- **テーブルセル**: `.55rem .75rem` padding
- **フィルタータブ間**: 4px gap
- **アナリティクスカード間**: 10px gap

### Border Radius Scale
| Token | Value | Use |
|-------|-------|-----|
| `--radius-sm` | 4px | バッジ、ステータスチップ |
| `--radius-md` | 8px | カード、テーブルコンテナ、モーダル |
| `--radius-lg` | 12px | チャートパネル、大きなカード |
| `--radius-xl` | 20px | フィルタータブ（pill） |
| Full Pill | 999px | バージョンバッジ、アプリヘッダーボタン |

---

## 6. Depth & Elevation

| Level | Token | Treatment | Use |
|-------|-------|-----------|-----|
| Flat (L0) | — | Shadow なし | ページ背景、インラインテキスト |
| Ambient (L1) | `--shadow-ambient` | `0 1px 8px rgba(15,23,42,.08)` | 標準カード、テーブルコンテナ |
| Card (L2) | `--shadow-card` | `0 4px 20px rgba(15,23,42,.1)` | ホバー時カード、ドロップダウン |
| Modal (L3) | `--shadow-modal` | `0 24px 60px rgba(15,23,42,.2)` | モーダル、オーバーレイ |
| Header | — | `0 1px 12px rgba(15,23,42,.08)` | スティッキーヘッダー |

### Shadow Philosophy
- Stripe方式のスレートブルー系シャドウ（`rgba(15,23,42,...)`）を全レベルで統一
- 純黒シャドウ (`rgba(0,0,0,...)`) は使わない
- ホバー時は shadow + `translateY(-2px)` で浮遊感を演出
- `backdrop-filter: blur(12px)` はヘッダーのみ

---

## 7. Do's and Don'ts

### Do
- Status Colorsは意味（成功/警告/エラー）に対してのみ使う
- テーブルは `table-layout: fixed` + `text-overflow: ellipsis` で行高さを統一
- フィルタータブは pill radius (20px) で、アクティブ時は `var(--primary)` fill
- 統計数値は mono フォント + ステータスカラーで視認性を確保
- モーダルはESCキーで閉じられるようにする
- 非同期操作にはローディングオーバーレイを表示する
- ユーザーデータは `esc()` で5文字エスケープ (`& < > " '`)
- CLI Activity のログは `textContent` で描画（innerHTML禁止）

### Don't
- 装飾目的でStatus Colorsを使わない（ブランドカラーは `--primary` のみ）
- テーブル行にwrapを許可しない（`white-space: nowrap` 必須）
- 12px以上のradiusをボタンに使わない（pill除く）
- 純黒 (`#000000`) をテキストに使わない（常に `#0f172a` スレートブルー）
- `innerHTML` にユーザーデータを直接挿入しない
- `font-weight: 800-900` を本文に使わない（見出しラベルのみ）
- ダークモードのカラーパレットを混在させない（ライトモード統一）

---

## 8. Responsive Behavior

### Breakpoints
| Name | Width | Key Changes |
|------|-------|-------------|
| Compact | <768px | Analytics 1列、テーブル横スクロール |
| Standard | 768-1200px | Analytics 2列、テーブルフル表示 |
| Wide | >1200px | Analytics 3列、余裕あるmargin |

### Touch Targets
- ボタン最小高さ: 30px
- テーブル行高さ: 44px（タップしやすい）
- フィルターフィールド高さ: 30px
- タブボタン padding: 4px 13px

### Collapsing Strategy
- Analytics 3列 → 2列 → 1列（積み重ね）
- テーブル: 固定レイアウト維持、水平スクロール
- 進行状況ログ: 2カラム → 1カラム
- フィルタータブ: flex-wrap で折り返し

---

## 9. Agent Prompt Guide

### Quick Color Reference
```
Primary CTA:     #2563eb (Claw Blue)
CTA Hover:       #1d4ed8
Background:      #f4f6fb (Base)
Card Surface:    #ffffff
Heading Text:    #0f172a (Slate Blue-Black)
Body Text:       #475569 (Slate)
Muted Text:      #94a3b8
Border:          rgba(15,23,42,.12)
Success:         #059669
Warning:         #d97706
Error:           #dc2626
Info/Processing: #7c3aed
```

### Example Component Prompts

**ステータスカード:**
「白背景カード、1px solid rgba(15,23,42,.07) ボーダー、8px radius。左に3px幅のステータスカラーバー。右寄せでmono .85rem bold の数値。ラベルは.68rem #475569。hover時にshadow: 0 4px 20px rgba(15,23,42,.1) + translateY(-2px)。」

**フィルターバー:**
「#f8f9fd背景、1px solid rgba(15,23,42,.12) ボーダー、10px radius、7px 10px padding。内部のフィルターフィールドは#f0f2f8背景、7px radius、30px高さ。Material Symbols 14px アイコン付き。focus時にblue ring: 0 0 0 3px rgba(59,130,246,.1)。」

**テーブル行:**
「table-layout:fixed。ヘッダーは#f8f9fd背景、.6rem uppercase bold #475569、letter-spacing .07em。行は44px固定高さ、奇数#fff/偶数#eef0f6。hover時にrgba(37,99,235,.12)背景。text-overflow:ellipsis。行クリックで詳細モーダル。」

**ダークヘッダーバー:**
「linear-gradient(135deg,#1e293b,#334155)背景。テキスト#e2e8f0 .68rem bold uppercase letter-spacing .1em。右端にチップ: rgba(255,255,255,.1)背景、#94a3b8テキスト、4px radius。思考中はスピナー + #818cf8テキスト。」

**プライマリボタン:**
「#2563eb背景、#fff テキスト、.78rem bold、letter-spacing .04em、6px 16px padding、20px radius (pill)。shadow: 0 2px 10px rgba(59,130,246,.3)。hover: #1d4ed8。」

### Iteration Guide
1. 色は常にCSS変数 (`var(--primary)`) 経由で参照する。ハードコードしない
2. テキストは `esc()` を通してから描画する。`innerHTML` にユーザーデータを直接入れない
3. 非同期操作は `safeFetch()` でラップし、ローディング表示 + エラートーストを自動化
4. テーブルは `table-layout: fixed` + `colgroup` で列幅を制御。行高さ44px固定
5. モーダル/オーバーレイはESCキーで閉じる。`z-index: 9999`
6. ステータスカラーは意味に紐づく。装飾に使わない
7. shadow は `rgba(15,23,42,...)` のスレートブルー系を統一。純黒禁止
8. border-radius は `--radius-sm(4)` / `--radius-md(8)` / `--radius-lg(12)` / `--radius-xl(20)` の4段階

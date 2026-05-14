# Vercel デプロイ ガイド

Sales Claw のランディング/ブログ/ドキュメント (Next.js 16 App Router 部分) を Vercel に
デプロイするための手順と環境変数リスト。Electron アプリ本体は対象外。

> Electron 側のソース (`electron-main.js`, `src/**`) は `electron-builder.yml` の
> `files` 設定で web ビルドから除外されているため、リポジトリそのまま push して
> 問題ない。

---

## 1. プロジェクト作成

```bash
# Vercel CLI
vercel link --project sales-claw
```

または Vercel ダッシュボードから GitHub リポジトリ `joseikininsight-hue/sales-claw`
を Import。

### Build Settings
- **Framework Preset**: `Next.js` (自動検出)
- **Build Command**: `next build` (デフォルト)
- **Output Directory**: `.next` (デフォルト)
- **Install Command**: `npm install` (デフォルト)
- **Node.js Version**: `20.x` 推奨

---

## 2. 環境変数

`.env.local` および Vercel ダッシュボード → Settings → Environment Variables に登録。

| 変数名 | 必須 | 用途 | 例 / 取得方法 |
|---|---|---|---|
| `NEXT_PUBLIC_GA_MEASUREMENT_ID` | 推奨 | Google Analytics 4 計測 ID。未設定なら GA4 自体を読み込まない (Cookie も落とさない) | `G-XXXXXXXXXX` (GA4 プロパティ > データストリーム) |
| `GITHUB_TOKEN` | 任意 | `/download` の GitHub Releases API レートリミット緩和 (60 req/h → 5000 req/h)。Public repo のみ参照する read-only fine-grained token で十分 | `github_pat_…` |
| `REVALIDATE_SECRET` | 推奨 | `/api/revalidate` を保護する shared secret。リリース時に Actions から叩く | `openssl rand -hex 32` で生成 |
| `NEXT_PUBLIC_SITE_URL` | 任意 | canonical URL の上書き (本番ドメインが `sales-claw.dev` 以外の場合) | `https://sales-claw.dev` |

### Environment スコープ
- **Production**: 上記全て
- **Preview**: `GITHUB_TOKEN` のみ (分析は preview では走らせない)
- **Development**: 空でよい (ローカルは `.env.local`)

---

## 3. ドメイン設定

1. Vercel ダッシュボード → Settings → Domains
2. `sales-claw.dev` を追加
3. DNS provider 側に Vercel が指示する A/CNAME レコードを設定
4. `www.sales-claw.dev` → `sales-claw.dev` の 308 redirect を Vercel 側で有効化

---

## 4. CSP / セキュリティヘッダ

`next.config.mjs` で production 時のみ以下を付与済み:

- `Content-Security-Policy` (GA4 / GitHub API を許可)
- `Strict-Transport-Security` (HSTS preload)
- `X-Frame-Options: DENY`
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy: camera=(), microphone=(), geolocation=()`

外部ドメインを追加する場合は `next.config.mjs` の `connect-src` / `script-src` を
更新する。

---

## 5. GA4 Consent Mode v2

`app/layout.tsx` で `default denied` を `beforeInteractive` で初期化、
`localStorage['sales-claw.consent.v1'] === 'accepted'` の場合のみ `granted` に
更新する Consent Mode v2 対応済み。

ユーザー初回訪問時には `components/consent/cookie-banner.tsx` のバナーが表示され、
「すべて同意」を押すと `gtag('consent', 'update', ...)` が発火する。

`NEXT_PUBLIC_GA_MEASUREMENT_ID` が未設定なら GA4 スクリプト自体読み込まれない
(= Cookie も落ちない) ため、ローカル開発で計測がノイズになる心配はない。

---

## 6. リリース連動の ISR Revalidate

`/download` ページは GitHub Releases API を `revalidate: 3600` (1h) で fetch している。
最新リリース直後にも即時更新したい場合、リポジトリの GitHub Actions
(`.github/workflows/release-revalidate.yml`) から以下が叩かれる:

```bash
curl -X POST \
  "https://sales-claw.dev/api/revalidate?path=/download&secret=${REVALIDATE_SECRET}"
```

`REVALIDATE_SECRET` は両側で同じ値を Vercel と GitHub Actions secrets に登録すること。

---

## 7. Sitemap / Robots

- `app/sitemap.ts` が `https://sales-claw.dev/sitemap.xml` を生成
- `app/robots.ts` が `/api/`, `/_next/`, `/admin/` を Disallow、主要 AI クローラを明示 Allow
- Google Search Console / Bing Webmaster Tools に sitemap URL を登録

---

## 8. デプロイ後チェックリスト

- [ ] `https://sales-claw.dev/` が 200 で返る
- [ ] `https://sales-claw.dev/sitemap.xml` が xml で返る
- [ ] `https://sales-claw.dev/robots.txt` が `Sitemap:` 行を含む
- [ ] `/download` から最新リリースが取得できる
- [ ] `/blog`, `/blog/[slug]` の OG image が生成されている (`/opengraph-image` パスでも確認可)
- [ ] DevTools Network で CSP 違反が出ていない
- [ ] Lighthouse: Performance 85+, Accessibility 90+, SEO 95+
- [ ] GSC の URL 検査で構造化データ (Article / SoftwareApplication / FAQPage) を認識
- [ ] 4 種 AI クローラの fetch ログ (1 週間後に確認)

---

## 9. Electron リリースとの分離

Vercel は `app/**`, `components/**`, `lib/**`, `public/**` 等の Next.js 部分しか
ビルドしない。Electron 専用ファイル (`electron-main.js`, `src/**.cjs`,
`dashboard-server.cjs`) は `next build` で参照されないため、リポジトリそのまま
push しても Vercel build には影響しない。

逆に Electron 配布は `npm run dist:win -- --publish never` で `dist/` 配下に
生成され、GitHub Releases にアップロードする。詳細は
`docs/release-parity-and-autoupdate.md` 参照。

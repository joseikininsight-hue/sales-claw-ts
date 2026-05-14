#!/usr/bin/env python3
"""Scrapling fetcher worker for Sales Claw list-builder.

このスクリプトは src/list-builder/scrapling-client.cjs から spawn で呼び出される。
Scrapling (Python ライブラリ) を使って 1 ページ取得し、結果を JSON で stdout に出力する。

設計方針 (Sales Claw 要件 v2.0 §1.2):
  - 公開情報の取得のみ
  - アクセス制限・CAPTCHA・ログイン必須ページの「突破」は行わない
  - 検出時はそのまま停止して呼び出し側に通知する

Usage:
  python scrapling-fetch.py URL [--mode stealthy|dynamic|fetch] [--timeout 30] [--headless]

Output:
  {"ok": true,  "html": "...", "statusCode": 200, "finalUrl": "...", "title": "..."}
  {"ok": false, "error": "..."}
"""

import argparse
import json
import sys


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("url")
    parser.add_argument("--mode", choices=["stealthy", "dynamic", "fetch"], default="stealthy")
    parser.add_argument("--timeout", type=int, default=30, help="seconds")
    parser.add_argument("--headless", action="store_true", default=True)
    parser.add_argument("--no-network-idle", dest="network_idle", action="store_false", default=True)
    args = parser.parse_args()

    # Scrapling 自体の import エラーは「未インストール」として返す
    try:
        from scrapling.fetchers import StealthyFetcher, DynamicFetcher, Fetcher
    except Exception as e:  # noqa: BLE001
        print(json.dumps({
            "ok": False,
            "error": "scrapling not installed: " + str(e),
            "errorCode": "SCRAPLING_NOT_INSTALLED",
        }, ensure_ascii=False))
        return 2

    try:
        if args.mode == "stealthy":
            fetcher = StealthyFetcher
        elif args.mode == "dynamic":
            fetcher = DynamicFetcher
        else:
            fetcher = Fetcher

        timeout_ms = max(1, args.timeout) * 1000

        # Scrapling は version によって fetch 引数が異なる可能性があるので、
        # よく使われる引数のみ渡す。失敗したら段階的にフォールバックする。
        try:
            page = fetcher.fetch(
                args.url,
                headless=args.headless,
                network_idle=args.network_idle,
                timeout=timeout_ms,
            )
        except TypeError:
            # 引数互換性問題: 最小引数で再試行
            page = fetcher.fetch(args.url)

        # Scrapling の Page オブジェクトから安全に値を取り出す
        def safe_attr(obj, name, default=None):
            try:
                v = getattr(obj, name, default)
                return v() if callable(v) else v
            except Exception:  # noqa: BLE001
                return default

        html = safe_attr(page, "html_content") or safe_attr(page, "html") or ""
        status = safe_attr(page, "status") or safe_attr(page, "status_code") or 0
        final_url = safe_attr(page, "url") or args.url
        title = safe_attr(page, "title") or ""

        # ブロック検出 (HTTP ステータスから)
        if isinstance(status, int) and (status == 403 or status == 429 or status == 401):
            print(json.dumps({
                "ok": False,
                "html": str(html)[:200000],
                "statusCode": status,
                "finalUrl": str(final_url),
                "blocked": True,
                "blockReason": "access_blocked",
                "errorCode": "ACCESS_BLOCKED",
            }, ensure_ascii=False))
            return 0

        # HTML サイズ上限 (3MB) — JSON にして spawn で返すので極端に大きいと困る
        max_bytes = 3 * 1024 * 1024
        truncated = False
        if html and len(html) > max_bytes:
            html = html[:max_bytes]
            truncated = True

        print(json.dumps({
            "ok": True,
            "html": html,
            "statusCode": int(status) if isinstance(status, int) else 200,
            "finalUrl": str(final_url),
            "title": str(title),
            "truncated": truncated,
            "fetcherKind": args.mode,
        }, ensure_ascii=False))
        return 0
    except Exception as e:  # noqa: BLE001
        print(json.dumps({
            "ok": False,
            "error": str(e),
            "errorCode": "SCRAPLING_RUNTIME_ERROR",
        }, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main() or 0)

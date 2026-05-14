"""
2026-05-13 GPT-5.5 Instant 解説の Python 図解

出力:
  - public/images/blog/diagram-2026-05-13-gpt-5-5-instant-bench.png
    (GPT-5.3 Instant vs GPT-5.5 Instant の社内評価ベンチ比較)
  - public/images/blog/diagram-2026-05-13-gpt-5-5-instant-rollout.png
    (ChatGPT 既定モデル / chat-latest ロールアウトのタイムライン)
"""

from __future__ import annotations
from pathlib import Path

import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch

OUT_DIR = Path(__file__).resolve().parents[2] / "public" / "images" / "blog"
OUT_DIR.mkdir(parents=True, exist_ok=True)

# Sales Claw カラーパレット
NAVY = "#0f172a"
NAVY_LIGHT = "#1e293b"
EMERALD = "#10b981"
EMERALD_LIGHT = "#34d399"
TEAL = "#14b8a6"
CYAN = "#06b6d4"
VIOLET = "#a855f7"
AMBER = "#f59e0b"
ROSE = "#ef4444"
ROSE_LIGHT = "#fda4af"
SLATE = "#64748b"
SLATE_LIGHT = "#94a3b8"
WHITE = "#ffffff"
BG = "#f8fafc"

plt.rcParams["font.family"] = ["Yu Gothic", "Hiragino Sans", "Noto Sans CJK JP", "Meiryo", "MS Gothic", "sans-serif"]
plt.rcParams["font.size"] = 11
plt.rcParams["axes.unicode_minus"] = False


def bench_compare() -> Path:
    """社内評価ベンチ Before/After 比較 (4 指標)"""
    fig, ax = plt.subplots(figsize=(13, 6.5), dpi=130)
    fig.patch.set_facecolor(WHITE)
    ax.set_facecolor(WHITE)

    metrics = [
        "高ステーク質問の\nハルシネーション率",
        "flag された会話の\n不正確な主張",
        "応答の単語数",
        "応答の行数",
    ]
    # 旧モデル (5.3 Instant) を 100 とした相対値
    before = [100, 100, 100, 100]
    # GPT-5.5 Instant: 公式数値より
    # ハルシネーション 52.5% 減 → 47.5% 相当
    # flagged で 37.3% 減 → 62.7% 相当
    # 単語 30.2% 減 → 69.8% 相当
    # 行数 29.2% 減 → 70.8% 相当
    after = [47.5, 62.7, 69.8, 70.8]
    diffs = ["-52.5%", "-37.3%", "-30.2%", "-29.2%"]

    x = list(range(len(metrics)))
    width = 0.36

    bars_before = ax.bar([i - width / 2 for i in x], before, width,
                          color=ROSE_LIGHT, edgecolor=ROSE, linewidth=1.4,
                          label="GPT-5.3 INSTANT (旧既定)", zorder=3)
    bars_after = ax.bar([i + width / 2 for i in x], after, width,
                         color=EMERALD_LIGHT, edgecolor=EMERALD, linewidth=1.4,
                         label="GPT-5.5 INSTANT (新既定)", zorder=3)

    # 数値ラベル
    for bar in bars_before:
        ax.text(bar.get_x() + bar.get_width() / 2, bar.get_height() + 2,
                f"{bar.get_height():.0f}", ha="center", va="bottom",
                fontsize=11, fontweight="bold", color=ROSE)
    for bar, d in zip(bars_after, diffs):
        ax.text(bar.get_x() + bar.get_width() / 2, bar.get_height() + 2,
                f"{bar.get_height():.1f}\n({d})", ha="center", va="bottom",
                fontsize=11, fontweight="bold", color=EMERALD)

    ax.set_xticks(x)
    ax.set_xticklabels(metrics, fontsize=11, color=NAVY)
    ax.set_ylabel("相対値 (旧モデル=100)", fontsize=11, color=SLATE)
    ax.set_ylim(0, 130)
    ax.set_title(
        "GPT-5.3 Instant → GPT-5.5 Instant: 4 指標の Before / After",
        fontsize=17, fontweight="bold", color=NAVY, pad=18,
    )
    ax.legend(loc="upper right", fontsize=10, frameon=True,
              edgecolor=SLATE_LIGHT, facecolor=WHITE)
    ax.grid(axis="y", linestyle="--", alpha=0.3, zorder=1)
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    ax.spines["left"].set_color(SLATE_LIGHT)
    ax.spines["bottom"].set_color(SLATE_LIGHT)

    # 出典脚注
    fig.text(0.5, 0.01,
             "出典: OpenAI 公式 (openai.com/index/gpt-5-5-instant/) 社内評価。production prevalence ではない点に留意",
             ha="center", fontsize=9, color=SLATE, style="italic")

    plt.tight_layout(rect=(0, 0.03, 1, 1))
    out = OUT_DIR / "diagram-2026-05-13-gpt-5-5-instant-bench.png"
    plt.savefig(out, dpi=130, bbox_inches="tight", facecolor=WHITE)
    plt.close()
    print(f"OK {out}")
    return out


def rollout_timeline() -> Path:
    """ChatGPT 既定モデル / chat-latest のロールアウトタイムライン"""
    fig, ax = plt.subplots(figsize=(13, 6), dpi=130)
    fig.patch.set_facecolor(WHITE)
    ax.set_facecolor(WHITE)
    ax.set_xlim(0, 100)
    ax.set_ylim(0, 100)
    ax.axis("off")

    # タイトル
    ax.text(50, 95, "GPT-5.5 Instant ロールアウトのタイムライン (公式情報ベース)",
            ha="center", va="top", fontsize=18, fontweight="bold", color=NAVY)
    ax.text(50, 89, "ChatGPT 既定モデル切替 + API `chat-latest` + 旧モデル 3 か月猶予",
            ha="center", va="top", fontsize=11, color=SLATE)

    # 横線タイムライン
    ax.plot([5, 95], [50, 50], color=SLATE_LIGHT, linewidth=2, zorder=1)

    events = [
        {"x": 12, "date": "2026.04.23", "title": "GPT-5.5\n発表", "desc": "Pro/Business/Enterprise 向け\nThinking / Pro 系統公開", "color": VIOLET},
        {"x": 35, "date": "2026.05.05", "title": "GPT-5.5 INSTANT\n既定モデル化", "desc": "ChatGPT 全プラン順次 +\n API alias `chat-latest`", "color": EMERALD},
        {"x": 58, "date": "2026.05.05+", "title": "パーソナライズ\n拡張", "desc": "Plus/Pro Web 先行 →\n Mobile / Free / Go / Biz / Ent", "color": TEAL},
        {"x": 82, "date": "2026.08 頃", "title": "GPT-5.3 INSTANT\nリタイア予定", "desc": "有料ユーザーは設定経由で\n3 か月間アクセス可", "color": AMBER},
    ]

    for ev in events:
        x = ev["x"]
        # マーカー
        ax.scatter([x], [50], s=320, color=ev["color"], zorder=3,
                   edgecolors=WHITE, linewidths=3)
        # 日付 (下)
        ax.text(x, 42, ev["date"], ha="center", va="top",
                fontsize=10, fontweight="bold", color=ev["color"])
        # タイトル (上)
        ax.text(x, 58, ev["title"], ha="center", va="bottom",
                fontsize=12, fontweight="bold", color=NAVY)
        # 詳細
        ax.text(x, 72, ev["desc"], ha="center", va="bottom",
                fontsize=9.5, color=SLATE)

    # 凡例的注釈
    ax.text(50, 18, "※ ロールアウトはプランや地域で時差あり。本記事は openai.com の発表時点情報に基づく",
            ha="center", va="center", fontsize=9.5, color=SLATE, style="italic")
    ax.text(50, 10, "出典: openai.com/index/gpt-5-5-instant/ / developers.openai.com/api/docs/changelog",
            ha="center", va="center", fontsize=9, color=SLATE_LIGHT)

    plt.tight_layout()
    out = OUT_DIR / "diagram-2026-05-13-gpt-5-5-instant-rollout.png"
    plt.savefig(out, dpi=130, bbox_inches="tight", facecolor=WHITE)
    plt.close()
    print(f"OK {out}")
    return out


if __name__ == "__main__":
    bench_compare()
    rollout_timeline()

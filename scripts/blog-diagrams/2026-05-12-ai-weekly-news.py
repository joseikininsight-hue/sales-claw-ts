"""
2026-05-12 AI Weekly News (Claude Code 2.1.139 + /goal + Agent View) の Python 図解

出力:
  - public/images/blog/diagram-2026-05-12-ai-weekly-cost-breakdown.png
    (月 1 万社運用時のコスト内訳棒グラフ、前提条件付き)
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
CYAN = "#06b6d4"
AMBER = "#f59e0b"
ROSE = "#ef4444"
SLATE = "#64748b"
SLATE_LIGHT = "#94a3b8"
WHITE = "#ffffff"
BG = "#f8fafc"

plt.rcParams["font.family"] = ["Yu Gothic", "Meiryo", "MS Gothic", "sans-serif"]
plt.rcParams["font.size"] = 11
plt.rcParams["axes.unicode_minus"] = False


def cost_breakdown() -> Path:
    """月 1 万社運用時のコスト内訳棒グラフ"""
    fig, ax = plt.subplots(figsize=(12, 6), dpi=130)
    fig.patch.set_facecolor(WHITE)
    ax.set_facecolor(WHITE)

    # データ (本文中のテーブルから抽出)
    items = ["企業分析\n(Haiku 4.5)", "/goal 判定\n(平均 3 判定/社)", "文面生成\n(Sonnet 4.6)", "フォーム入力\n(MCP Playwright)"]
    costs = [4000, 1500, 15000, 12000]
    colors = [CYAN, AMBER, EMERALD, EMERALD_LIGHT]

    bars = ax.bar(items, costs, color=colors, width=0.55, zorder=3,
                  edgecolor=WHITE, linewidth=1.5)

    # 数値ラベル
    for bar, c in zip(bars, costs):
        ax.text(
            bar.get_x() + bar.get_width() / 2, bar.get_height() + 400,
            f"¥{c:,}",
            ha="center", va="bottom",
            fontsize=14, fontweight="bold", color=NAVY,
        )

    # タイトル
    ax.set_title(
        "月 1 万社運用時のコスト内訳 (試算)",
        fontsize=18, fontweight="bold", color=NAVY, pad=30, loc="left",
    )
    ax.text(
        0, 1.04,
        "合計 ¥32,500 / 月 (Claude Haiku 4.5 + Sonnet 4.6、MCP Playwright、為替 1 USD = 150 JPY)",
        transform=ax.transAxes, fontsize=10.5, color=SLATE,
    )

    ax.set_ylabel("円 / 月", color=SLATE, fontsize=11)
    ax.set_ylim(0, 18000)
    ax.grid(axis="y", color="#e2e8f0", linewidth=1, zorder=0)
    ax.set_axisbelow(True)
    for s in ["top", "right"]:
        ax.spines[s].set_visible(False)

    # 合計ハイライト
    ax.text(
        0.98, 0.92,
        "合計\n¥32,500 / 月\n\n商談化率 0.5% → ¥650 / 商談",
        transform=ax.transAxes,
        ha="right", va="top",
        fontsize=11, fontweight="bold", color=EMERALD,
        bbox=dict(boxstyle="round,pad=0.6", facecolor="white", edgecolor=EMERALD, linewidth=2),
    )

    # 注釈
    ax.text(
        0, -0.14,
        "※ 前提: 1 社あたり入力 8,000 / 出力 600 トークン、CAPTCHA 8% / 営業 NG 4% / フォーム不在 6% を除外。\n"
        "  変動幅 ±30%。実運用前に 100 社サンプル計測を推奨。",
        transform=ax.transAxes,
        fontsize=9, color=SLATE, style="italic", va="top",
    )

    plt.tight_layout()
    out = OUT_DIR / "diagram-2026-05-12-ai-weekly-cost-breakdown.png"
    plt.savefig(out, dpi=130, bbox_inches="tight", facecolor=WHITE)
    plt.close(fig)
    print(f"OK {out}")
    return out


if __name__ == "__main__":
    cost_breakdown()
    print("\nDone.")

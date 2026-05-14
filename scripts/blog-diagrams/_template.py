"""
Sales Claw blog 用 Python 図解テンプレ (matplotlib + PIL)

使い方:
  1) cp scripts/blog-diagrams/_template.py scripts/blog-diagrams/<slug>.py
  2) <slug>.py の関数本体を書き換える
  3) python scripts/blog-diagrams/<slug>.py で実行
  4) public/images/blog/diagram-<slug>-*.png が出力される

依存:
  python -m pip install --user matplotlib pillow numpy
"""

from __future__ import annotations
from pathlib import Path

import matplotlib.pyplot as plt
import matplotlib.patches as patches
from matplotlib.patches import FancyBboxPatch

# 出力先: <repo>/public/images/blog/
OUT_DIR = Path(__file__).resolve().parents[2] / "public" / "images" / "blog"
OUT_DIR.mkdir(parents=True, exist_ok=True)

# Sales Claw カラーパレット
NAVY = "#0f172a"
EMERALD = "#10b981"
EMERALD_LIGHT = "#34d399"
AMBER = "#f59e0b"
ROSE = "#ef4444"
SLATE = "#64748b"
SLATE_LIGHT = "#94a3b8"
WHITE = "#ffffff"
BG = "#f8fafc"

# 日本語フォント (Windows / macOS / Linux)
plt.rcParams["font.family"] = ["Yu Gothic", "Hiragino Sans", "Noto Sans CJK JP", "Meiryo", "MS Gothic", "sans-serif"]
plt.rcParams["font.size"] = 11
plt.rcParams["axes.unicode_minus"] = False


def example_cost_trend(slug: str = "_template") -> Path:
    """例: コスト推移棒グラフ"""
    fig, ax = plt.subplots(figsize=(12, 5), dpi=120)
    fig.patch.set_facecolor(WHITE)

    years = ["2023", "2024", "2025 H1", "2025 H2", "2026 5月"]
    costs = [50, 18, 8, 4, 2.5]
    colors = [SLATE] * (len(costs) - 1) + [EMERALD]

    bars = ax.bar(years, costs, color=colors, width=0.55, zorder=3)

    # 数値ラベル
    for bar, c in zip(bars, costs):
        ax.text(
            bar.get_x() + bar.get_width() / 2, bar.get_height() + 1.5,
            f"¥{c}",
            ha="center", va="bottom",
            fontsize=14, fontweight="bold", color=NAVY,
        )

    ax.set_title("AI 営業 1 社あたり処理コスト推移", fontsize=18, fontweight="bold", color=NAVY, pad=20)
    ax.set_ylabel("円 / 社 (JPY=150 換算)", color=SLATE, fontsize=11)
    ax.set_ylim(0, 60)
    ax.grid(axis="y", color="#e2e8f0", linewidth=1, zorder=0)
    ax.set_axisbelow(True)
    for s in ["top", "right"]:
        ax.spines[s].set_visible(False)

    # 削減率ラベル
    ax.text(
        0.97, 0.95,
        "3 年で 95% 削減 (¥50 → ¥2.5)",
        transform=ax.transAxes,
        ha="right", va="top",
        fontsize=12, fontweight="bold", color=EMERALD,
        bbox=dict(boxstyle="round,pad=0.5", facecolor="white", edgecolor=EMERALD, linewidth=1.5),
    )

    plt.tight_layout()
    out_path = OUT_DIR / f"diagram-{slug}-cost-trend.png"
    plt.savefig(out_path, dpi=120, bbox_inches="tight", facecolor=WHITE)
    plt.close(fig)
    print(f"OK {out_path.relative_to(OUT_DIR.parents[2])}")
    return out_path


def example_timeline(slug: str = "_template") -> Path:
    """例: リリースタイムライン"""
    fig, ax = plt.subplots(figsize=(12, 3.5), dpi=120)
    fig.patch.set_facecolor(BG)
    ax.set_facecolor(BG)

    events = [
        ("4/16", "Claude Opus 4.7", ROSE),
        ("5/05", "GPT-5.5 Instant", "#3b82f6"),
        ("5/07", "Gemini 3.1 F-Lite", EMERALD),
        ("5/12", "Claude Code 2.1.139", AMBER),
        ("5/12", "Claude Code 2.1.140", "#a855f7"),
    ]
    xs = list(range(len(events)))

    ax.plot(xs, [0] * len(xs), color=SLATE_LIGHT, linewidth=2, zorder=1)
    for i, (date, label, color) in enumerate(events):
        ax.scatter(i, 0, s=180, color=color, zorder=3, edgecolors=WHITE, linewidth=2)
        offset = 0.3 if i % 2 == 0 else -0.3
        ax.annotate(
            f"{label}\n{date}", xy=(i, 0), xytext=(i, offset),
            ha="center", va="bottom" if offset > 0 else "top",
            fontsize=10, fontweight="bold", color=NAVY,
            bbox=dict(boxstyle="round,pad=0.4", facecolor=WHITE, edgecolor=color, linewidth=1.5),
            arrowprops=dict(arrowstyle="-", color=color, linewidth=1.2),
        )

    ax.set_xlim(-0.5, len(events) - 0.5)
    ax.set_ylim(-1, 1)
    ax.set_title("主要 AI 製品リリースタイムライン (2026年4-5月)", fontsize=15, fontweight="bold", color=NAVY, pad=15)
    ax.axis("off")
    plt.tight_layout()
    out_path = OUT_DIR / f"diagram-{slug}-timeline.png"
    plt.savefig(out_path, dpi=120, bbox_inches="tight", facecolor=BG)
    plt.close(fig)
    print(f"OK {out_path.relative_to(OUT_DIR.parents[2])}")
    return out_path


if __name__ == "__main__":
    example_cost_trend()
    example_timeline()
    print("\nDone.")

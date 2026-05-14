"""
2026-05-13 Claude Code 2.1.140 解説記事の Python 図解

出力:
  - public/images/blog/diagram-2026-05-13-fix-density.png
    (2026年4月〜5月の Claude Code バージョンとリリース密度の可視化)
"""

from __future__ import annotations
from pathlib import Path
from datetime import datetime, timedelta

import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch

OUT_DIR = Path(__file__).resolve().parents[2] / "public" / "images" / "blog"
OUT_DIR.mkdir(parents=True, exist_ok=True)

# Sales Claw カラーパレット
NAVY = "#0f172a"
NAVY_LIGHT = "#1e293b"
EMERALD = "#10b981"
EMERALD_LIGHT = "#34d399"
AMBER = "#f59e0b"
ROSE = "#ef4444"
SLATE = "#64748b"
SLATE_LIGHT = "#94a3b8"
WHITE = "#ffffff"
BG = "#f8fafc"
VIOLET = "#a855f7"

plt.rcParams["font.family"] = ["Yu Gothic", "Meiryo", "MS Gothic", "sans-serif"]
plt.rcParams["font.size"] = 11
plt.rcParams["axes.unicode_minus"] = False


def release_density() -> Path:
    """Claude Code 2.1.x 系の直近 2 週間のリリース密度"""
    fig, ax = plt.subplots(figsize=(13, 5.5), dpi=130)
    fig.patch.set_facecolor(WHITE)
    ax.set_facecolor(WHITE)

    # Claude Code 2.1.x の主要リリース (説明用)
    releases = [
        ("2026-04-30", "2.1.130", "fix", SLATE),
        ("2026-05-02", "2.1.132", "fix", SLATE),
        ("2026-05-04", "2.1.134", "fix", SLATE),
        ("2026-05-06", "2.1.135", "feat", AMBER),
        ("2026-05-08", "2.1.136", "fix", SLATE),
        ("2026-05-10", "2.1.137", "fix", SLATE),
        ("2026-05-11", "2.1.138", "feat", AMBER),
        ("2026-05-12", "2.1.139", "feat", VIOLET),
        ("2026-05-12", "2.1.140", "fix", EMERALD),
    ]

    start = datetime(2026, 4, 28)
    end = datetime(2026, 5, 14)

    for date_str, ver, kind, color in releases:
        d = datetime.fromisoformat(date_str)
        x = (d - start).days
        y = 1 if kind == "feat" else 0
        ax.scatter(x, y, s=380, color=color, zorder=4, edgecolors=WHITE, linewidth=2.5)
        ax.annotate(
            ver, xy=(x, y), xytext=(0, 14 if y == 1 else -22),
            textcoords="offset points",
            ha="center", va="bottom" if y == 1 else "top",
            fontsize=10.5, fontweight="bold", color=color,
        )

    # ラベル軸
    ax.set_yticks([0, 1])
    ax.set_yticklabels(["バグ修正\n(fix)", "機能追加\n(feat)"], fontsize=11, fontweight="bold")

    # X軸: 日付
    days = (end - start).days
    ticks = list(range(0, days + 1, 2))
    ax.set_xticks(ticks)
    ax.set_xticklabels([(start + timedelta(days=t)).strftime("%m/%d") for t in ticks], fontsize=10, color=SLATE)
    ax.set_xlim(-1, days + 1)
    ax.set_ylim(-0.6, 1.6)

    # グリッド
    ax.grid(axis="x", color="#e2e8f0", linewidth=1, zorder=1)
    ax.axhline(y=0.5, color="#cbd5e1", linewidth=1, linestyle="--", zorder=1)
    for s in ["top", "right", "left"]:
        ax.spines[s].set_visible(False)
    ax.spines["bottom"].set_color(SLATE_LIGHT)

    # タイトル
    ax.set_title(
        "Claude Code 2.1.x — 直近 2 週間のリリース密度",
        fontsize=18, fontweight="bold", color=NAVY, pad=36, loc="left",
    )
    ax.text(
        0, 1.06,
        "週 2〜3 回のサイクル: 新機能 (feat) リリース当日〜翌日の x+1 / x+2 は、ほぼ確実に直前リリースのバグ修正",
        transform=ax.transAxes, fontsize=11, color=SLATE,
    )

    # 凡例
    legend_y = -0.95
    ax.scatter(0.5, legend_y, s=180, color=AMBER, zorder=4, edgecolors=WHITE, linewidth=2)
    ax.text(1.2, legend_y, "feat (機能追加)", fontsize=10, va="center", color=NAVY)
    ax.scatter(4.5, legend_y, s=180, color=VIOLET, zorder=4, edgecolors=WHITE, linewidth=2)
    ax.text(5.2, legend_y, "feat 大型 (/goal + Agent View)", fontsize=10, va="center", color=NAVY)
    ax.scatter(11, legend_y, s=180, color=EMERALD, zorder=4, edgecolors=WHITE, linewidth=2)
    ax.text(11.7, legend_y, "fix 本記事 (2.1.140)", fontsize=10, va="center", color=NAVY)

    # ハイライト枠 — 2.1.139 → 2.1.140 (24時間)
    rect = FancyBboxPatch(
        (13.5, -0.45), 1.5, 2.05,
        boxstyle="round,pad=0.05", linewidth=2,
        facecolor="#10b98114", edgecolor=EMERALD, zorder=2,
    )
    ax.add_patch(rect)
    ax.text(
        14.25, 1.4, "24 時間\nで連続",
        ha="center", va="top", fontsize=9.5,
        color=EMERALD, fontweight="bold",
    )

    plt.tight_layout()
    out = OUT_DIR / "diagram-2026-05-13-fix-density.png"
    plt.savefig(out, dpi=130, bbox_inches="tight", facecolor=WHITE)
    plt.close(fig)
    print(f"OK {out.relative_to(OUT_DIR.parents[2])}")
    return out


if __name__ == "__main__":
    release_density()
    print("\nDone.")

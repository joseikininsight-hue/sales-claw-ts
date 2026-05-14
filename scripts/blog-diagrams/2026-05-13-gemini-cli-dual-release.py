"""
2026-05-13 Gemini CLI v0.42.0 + v0.43.0-preview.0 同日リリース解説の Python 図解

出力:
  - public/images/blog/diagram-2026-05-13-gemini-cli-channels.png
    (Stable / Preview / Nightly の 3 系統リリースチャネル可視化)
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
CYAN = "#06b6d4"
VIOLET = "#a855f7"
AMBER = "#f59e0b"
ROSE = "#ef4444"
SLATE = "#64748b"
SLATE_LIGHT = "#94a3b8"
WHITE = "#ffffff"
BG = "#f8fafc"

plt.rcParams["font.family"] = ["Yu Gothic", "Meiryo", "MS Gothic", "sans-serif"]
plt.rcParams["font.size"] = 11
plt.rcParams["axes.unicode_minus"] = False


def channels_compare() -> Path:
    """Gemini CLI 3 系統リリースチャネル比較"""
    fig, ax = plt.subplots(figsize=(13, 6), dpi=130)
    fig.patch.set_facecolor(WHITE)
    ax.set_facecolor(WHITE)
    ax.set_xlim(0, 100)
    ax.set_ylim(0, 100)
    ax.axis("off")

    # タイトル
    ax.text(50, 95, "Gemini CLI 3 系統リリースチャネル比較",
            ha="center", va="top", fontsize=20, fontweight="bold", color=NAVY)
    ax.text(50, 89, "2026-05-12 時点での Stable / Preview / Nightly の位置づけ",
            ha="center", va="top", fontsize=11, color=SLATE)

    # 3 カラムのボックス
    channels = [
        {
            "x": 5, "color": CYAN, "title": "Stable", "version": "v0.42.0",
            "audience": "本番運用 / SDR チーム",
            "stability": "★★★★★",
            "feature_age": "リリース済機能のみ",
            "risk": "低",
            "recommend": "○ 既存ユーザー全員に推奨",
        },
        {
            "x": 36, "color": VIOLET, "title": "Preview", "version": "v0.43.0-preview.0",
            "audience": "次世代機能を試す開発者",
            "stability": "★★★☆☆",
            "feature_age": "Subagent Protocol など",
            "risk": "中",
            "recommend": "△ 検証環境で先行試用",
        },
        {
            "x": 67, "color": AMBER, "title": "Nightly", "version": "未公開ビルド",
            "audience": "コントリビューター向け",
            "stability": "★☆☆☆☆",
            "feature_age": "PR マージ直後",
            "risk": "高",
            "recommend": "× 本番投入禁止",
        },
    ]

    box_w = 28
    box_h = 60
    box_y = 15

    for ch in channels:
        # 枠
        ax.add_patch(FancyBboxPatch(
            (ch["x"], box_y), box_w, box_h,
            boxstyle="round,pad=1.2",
            linewidth=2.5, edgecolor=ch["color"], facecolor=f"{ch['color']}11",
            zorder=2,
        ))

        # ヘッダー帯
        ax.add_patch(FancyBboxPatch(
            (ch["x"], box_y + box_h - 14), box_w, 12,
            boxstyle="round,pad=0.5",
            linewidth=0, facecolor=ch["color"], zorder=3,
        ))
        ax.text(ch["x"] + box_w / 2, box_y + box_h - 6,
                ch["title"], ha="center", va="center",
                fontsize=18, fontweight="bold", color=WHITE, zorder=4)
        ax.text(ch["x"] + box_w / 2, box_y + box_h - 16.5,
                ch["version"], ha="center", va="center",
                fontsize=12, fontweight="bold", color=ch["color"], zorder=4)

        # 詳細
        rows = [
            ("対象ユーザー", ch["audience"]),
            ("安定度", ch["stability"]),
            ("機能の新しさ", ch["feature_age"]),
            ("リスク", ch["risk"]),
        ]
        for i, (label, value) in enumerate(rows):
            y = box_y + box_h - 26 - i * 7
            ax.text(ch["x"] + 2, y, label,
                    fontsize=9, color=SLATE, va="center")
            ax.text(ch["x"] + box_w - 2, y, value,
                    fontsize=10, fontweight="bold", color=NAVY,
                    ha="right", va="center")

        # 推奨
        ax.text(ch["x"] + box_w / 2, box_y + 3,
                ch["recommend"],
                ha="center", va="center",
                fontsize=10, fontweight="bold", color=ch["color"])

    # 下部キャプション
    ax.text(50, 6,
            "Sales Claw の preferences.aiProvider = 'gemini' で接続するなら通常は Stable。新機能の検証は別環境で Preview を試す。",
            ha="center", va="center", fontsize=10.5, color=SLATE, style="italic")

    plt.tight_layout()
    out = OUT_DIR / "diagram-2026-05-13-gemini-cli-channels.png"
    plt.savefig(out, dpi=130, bbox_inches="tight", facecolor=WHITE)
    plt.close(fig)
    print(f"OK {out.relative_to(OUT_DIR.parents[2])}")
    return out


if __name__ == "__main__":
    channels_compare()
    print("\nDone.")

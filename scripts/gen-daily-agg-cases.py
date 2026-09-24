"""生成日聚合的对拍期望值（Python 侧真实函数算出来）。

用法：
    python scripts/gen-daily-agg-cases.py > scripts/daily-agg-expected.json
    node scripts/verify-daily-agg.mjs

覆盖：
- 常量（含保留天数）
- 部位 → 字段映射
- aggregate_day 的六个精确字段 + 两个派生量（日均分、各问题占比）
- 阈值边界（恰等于阈值**不算**问题、超一点点就算）
- 取整平局点（能把 pyRound1 与 Math.round 区分开，见 verify 脚本的灵敏度自检）
- merge_days 的合并（含空天跳过）
- 本地日边界与 ±N 天（localDay.ts ↔ services/retention.py 的两端口径）
"""

import json
import os
import sys
from datetime import datetime, timedelta

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "backend"))

from config import RETENTION_DAYS, HEAD_TILT_THRESHOLD, SHOULDER_DIFF_THRESHOLD, SPINE_ANGLE_THRESHOLD  # noqa: E402
from services.daily_agg import (  # noqa: E402
    EMPTY_DAY,
    PARTS,
    aggregate_day,
    daily_avg_score,
    daily_bad_pct,
    merge_days,
)
from services.retention import local_day_bounds_utc  # noqa: E402


def row(head, shoulder, spine, score):
    return {"head_angle": head, "shoulder_diff": shoulder, "spine_angle": spine, "score": score}


def expect(agg):
    """把聚合结果 + 两个派生量打包成期望值。"""
    return {
        **agg,
        "avg_score": daily_avg_score(agg),
        "bad_pct": {p: daily_bad_pct(agg, p) for p, _, _ in PARTS},
    }


CASES = []


def add(name, rows):
    CASES.append({"name": name, "rows": rows, "expected": expect(aggregate_day(rows))})


# ---------------- 空与退化 ----------------
add("空序列", [])
add("单条·全端正", [row(0.0, 0.0, 0.0, 100)])
add("单条·全超标", [row(20.0, 12.0, 30.0, 35)])

# ---------------- 阈值边界：「恰等于阈值」不算问题 ----------------
# 定义是严格大于（value > threshold），与 scorer.metric_deduction 的分支点一致。
H, S, P = HEAD_TILT_THRESHOLD, SHOULDER_DIFF_THRESHOLD, SPINE_ANGLE_THRESHOLD
add("边界·头部恰等于阈值（不算问题）", [row(H, 0.0, 0.0, 96)])
add("边界·头部刚超阈值（算问题）", [row(H + 0.1, 0.0, 0.0, 78)])
add("边界·肩部恰等于阈值（不算问题）", [row(0.0, S, 0.0, 96)])
add("边界·肩部刚超阈值（算问题）", [row(0.0, S + 0.001, 0.0, 78)])
add("边界·脊柱恰等于阈值（不算问题）", [row(0.0, 0.0, P, 96)])
add("边界·脊柱刚超阈值（算问题）", [row(0.0, 0.0, P + 0.1, 78)])
add(
    "边界·三项同时恰在阈值上（全天 0 个问题）",
    [row(H, S, P, 90)] * 20,
)
add(
    "边界·三项同时刚过阈值（全天 100% 问题）",
    [row(H + 0.2, S + 0.2, P + 0.2, 70)] * 20,
)

# ---------------- 负值 / 异常输入 ----------------
# 退化地标可能算出负角；负值必然不超标，不应被计成问题。
add("异常·指标为负值", [row(-1.0, -0.5, -3.0, 100)] * 3)

# ---------------- 混合：三项各有部分超标 ----------------
mixed = []
for i in range(10):
    mixed.append(row(H + (1.0 if i < 7 else -1.0), S + (1.0 if i < 3 else -1.0), P + (1.0 if i < 5 else -1.0), 70 + i))
add("混合·头部 7/10、肩部 3/10、脊柱 5/10 超标", mixed)

# ---------------- 取整平局点 ----------------
# 逐帧分数和 321 / 4 = 80.25 → ×10 = 802.5 恰好落在平局点：
#   本项目口径（平局取偶）→ 802 是偶数 → 80.2
#   Math.round                 → 803 → 80.3
# 没有这类用例，「取整实现被换成 Math.round」守卫是发现不了的。
add("取整平局点·日均分 80.25", [row(0, 0, 0, 80), row(0, 0, 0, 80), row(0, 0, 0, 80), row(0, 0, 0, 81)])
# 1/16 = 6.25% → ×10 = 62.5 平局（62 偶 → 62 → 6.2）；Math.round → 63 → 6.3
b16 = [row(0, 0, 0, 90)] * 15 + [row(H + 1.0, 0, 0, 70)]
add("取整平局点·问题占比 6.25%", b16)
# 3/8 = 37.5% → ×10 = 375.0（无小数）→ 不构成平局，用来确认正常路径也对
b8 = [row(0, 0, 0, 90)] * 5 + [row(H + 1.0, 0, 0, 70)] * 3
add("占比·3/8 = 37.5%", b8)

# ---------------- 浮点长链 / 大样本 ----------------
add("浮点长链·n=7 除不尽", [row(0, 0, 0, s) for s in (83, 84, 86, 79, 90, 95, 72)])
# 大样本的作用是放大「累加顺序/精度」差异：条数太少时两端即使实现不同也可能同分。
# 600 条足以暴露顺序差异，同时不让期望值文件膨胀（生成物是入库的）。
add("大样本·n=600", [row((i % 13) / 2.0, (i % 7) / 2.0, (i % 21) / 2.0, 60 + (i % 41)) for i in range(600)])
add("极值·全 0 分", [row(20.0, 12.0, 30.0, 0)] * 6)
add("极值·全 100 分", [row(0.0, 0.0, 0.0, 100)] * 6)
add("min_score·含一个 20 分", [row(0, 0, 0, 100)] * 9 + [row(20.0, 12.0, 30.0, 20)])

# ---------------- merge_days ----------------
d1 = aggregate_day([row(0, 0, 0, 90)] * 4)                 # 360/4
d2 = aggregate_day([row(H + 1.0, 0, 0, 70)] * 2)          # 140/2
d3 = aggregate_day([row(0, S + 1.0, 0, 60)] * 3)          # 180/3
MERGE_CASES = [
    {"name": "合并·三天", "days": [d1, d2, d3], "expected": expect(merge_days([d1, d2, d3]))},
    {"name": "合并·含空天（应被跳过）", "days": [d1, dict(EMPTY_DAY), d2], "expected": expect(merge_days([d1, dict(EMPTY_DAY), d2]))},
    {"name": "合并·全为空", "days": [dict(EMPTY_DAY), dict(EMPTY_DAY)], "expected": expect(merge_days([dict(EMPTY_DAY), dict(EMPTY_DAY)]))},
    {"name": "合并·单一", "days": [d1], "expected": expect(merge_days([d1]))},
]
# 合并后仍必须是精确量：和与计数直接相加
MERGE_SUMS = {
    "合并·三天": {
        "sample_count": 4 + 2 + 3,
        "score_sum": 360.0 + 140.0 + 180.0,
        "min_score": 60,
        "head_bad_count": 0 + 2 + 0,
        "shoulder_bad_count": 0 + 0 + 3,
        "spine_bad_count": 0 + 0 + 0,
    }
}

# ---------------- 本地日边界（两端口径） ----------------
DAY_BOUNDS = {
    d: list(local_day_bounds_utc(d))
    for d in ("2026-01-01", "2026-02-28", "2026-03-01", "2026-06-15", "2026-12-31", "2024-02-29")
}
# shiftDay(day, delta) 的期望：用 datetime 直接算，避免与实现同源
SHIFT_CASES = []
for base in ("2026-03-01", "2026-01-01", "2024-02-29", "2026-12-31"):
    for delta in (-1, 1, -7, 30):
        d = datetime.strptime(base, "%Y-%m-%d") + timedelta(days=delta)
        SHIFT_CASES.append({"day": base, "delta": delta, "expected": d.strftime("%Y-%m-%d")})

payload = {
    "constants": {
        "RETENTION_DAYS": RETENTION_DAYS,
        "HEAD_TILT_THRESHOLD": HEAD_TILT_THRESHOLD,
        "SHOULDER_DIFF_THRESHOLD": SHOULDER_DIFF_THRESHOLD,
        "SPINE_ANGLE_THRESHOLD": SPINE_ANGLE_THRESHOLD,
    },
    "parts": [list(p) for p in PARTS],
    "cases": CASES,
    "merge_cases": MERGE_CASES,
    "merge_sums": MERGE_SUMS,
    "day_bounds": DAY_BOUNDS,
    "shift_cases": SHIFT_CASES,
}

# 紧凑输出：生成物要入库，缩进版会凭空多出几倍体积（也没人会来读它）。
json.dump(payload, sys.stdout, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
sys.stdout.write("\n")

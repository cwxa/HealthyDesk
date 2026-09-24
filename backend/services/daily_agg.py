"""日粒度聚合 —— 把一天的姿态采样折成一行**精确**统计。

## 为什么只存精确量

`posture_daily` 是**归档**层：原始采样只保留最近若干天，之后被清理，而每天的这行
（或多年里每天一行，体量极小）长期保留。所以这里的口径必须经得起**跨天合并**：

- 存 `score_sum`（分数总和）而不是 `avg_score`：跨天求平均要 `Σscore_sum / Σcount`，
  若只存已取整的日均分，误差会随天数累积。
- 存 `head_bad_count` 等**计数**而不是百分比：占比可由 `count / sample_count` 现算，
  存百分比等于把"取整"烙进归档，同样会在合并时漂移。

派生量（日均分、各问题占比）由本模块的 `daily_avg_score` / `daily_bad_pct` 单点计算，
两端共用，不在别处再算一遍。

## 「坏值」的定义

某部位的一次采样算「有问题」，当且仅当该部位指标**超过自己的阈值**
（`value > threshold`，严格大于）。

这与 `scorer.metric_deduction` 的分支点一致（`excess <= 0` 时扣 0 分），
因此它等价于"这一帧该部位会不会被提醒"。注意**不要**把预警区（阈值 60% 起的那段
轻微扣分）算进来 —— 预警区扣分但**不产出 issues**，算进来会让"问题占比"与
"提醒"这两个数字对不上，而那正是本项目最忌讳的自相矛盾。
"""

from config import HEAD_TILT_THRESHOLD, SHOULDER_DIFF_THRESHOLD, SPINE_ANGLE_THRESHOLD
from services.rounding import round_1

# (输出字段前缀, 采样行字段名, 阈值)。阈值一律从自身模块取，不在这里写字面量。
PARTS: tuple[tuple[str, str, float], ...] = (
    ("head", "head_angle", HEAD_TILT_THRESHOLD),
    ("shoulder", "shoulder_diff", SHOULDER_DIFF_THRESHOLD),
    ("spine", "spine_angle", SPINE_ANGLE_THRESHOLD),
)

# 空一天的输出。整行都是确定值（不是 None），这样入库/相加都不需要额外分支。
EMPTY_DAY: dict = {
    "sample_count": 0,
    "score_sum": 0.0,
    "min_score": 0,
    "head_bad_count": 0,
    "shoulder_bad_count": 0,
    "spine_bad_count": 0,
}


def aggregate_day(rows) -> dict:
    """把一天内的姿态采样折成一行统计。纯函数：同样的行 → 同样的输出。

    `rows` 需带 `head_angle` / `shoulder_diff` / `spine_angle` / `score` 四个字段
    （`sqlite3.Row`、dict 均可）。
    """
    rows = list(rows)
    n = len(rows)
    if n == 0:
        return dict(EMPTY_DAY)

    total = 0.0
    scores: list[float] = []
    bad = {"head": 0, "shoulder": 0, "spine": 0}

    # 三段循环而不是一次遍历：与 TS 侧保持**同样的运算顺序**，
    # 浮点累加顺序一致才能保证逐位相同。
    for r in rows:
        scores.append(float(r["score"]))
    for s in scores:
        total += s
    for r in rows:
        for prefix, field, threshold in PARTS:
            if float(r[field]) > threshold:
                bad[prefix] += 1

    return {
        "sample_count": n,
        "score_sum": total,
        "min_score": min(scores),
        "head_bad_count": bad["head"],
        "shoulder_bad_count": bad["shoulder"],
        "spine_bad_count": bad["spine"],
    }


def daily_avg_score(day: dict) -> float:
    """日均分（一位小数）。空的一天返回 0.0 —— 与 `stats.py` 历史口径一致（无数据显示 0）。"""
    n = int(day.get("sample_count", 0))
    if n <= 0:
        return 0.0
    return round_1(float(day["score_sum"]) / n)


def daily_bad_pct(day: dict, part: str) -> float:
    """某部位「有问题」的采样占比（%，一位小数）。空的一天返回 0.0。"""
    keys = {"head": "head_bad_count", "shoulder": "shoulder_bad_count", "spine": "spine_bad_count"}
    if part not in keys:
        raise ValueError(f"unknown part: {part}")
    n = int(day.get("sample_count", 0))
    if n <= 0:
        return 0.0
    return round_1(float(day[keys[part]]) / n * 100.0)


def merge_days(days) -> dict:
    """把若干天合并成一行（用于周/月均分）。计数相加、和多加，**不做加权平均**。

    之所以能直接相加：`score_sum` 与各 `*_bad_count` 都是精确累加量。
    """
    out = dict(EMPTY_DAY)
    mins: list[float] = []
    for d in days:
        n = int(d.get("sample_count", 0))
        if n <= 0:
            continue
        out["sample_count"] += n
        out["score_sum"] += float(d["score_sum"])
        mins.append(float(d["min_score"]))
        out["head_bad_count"] += int(d["head_bad_count"])
        out["shoulder_bad_count"] += int(d["shoulder_bad_count"])
        out["spine_bad_count"] += int(d["spine_bad_count"])
    out["min_score"] = min(mins) if mins else 0
    return out

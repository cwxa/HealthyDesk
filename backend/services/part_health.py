"""部位健康度 —— 把 `posture_score` 的三个分项字段聚合为 0–100 的可比口径。

## 为什么需要它

`posture_score` 表本来就存了 `head_angle` / `shoulder_diff` / `spine_angle` 三个分项
（见 `db/database.py`），但 Dashboard 的「部位健康度」此前**没有一个是真实聚合**：
头部写死 85 分、肩部是今日总分 + 5、脊柱直接用今日总分。这导致

    「头部严重侧倾（真实 35 分）」在界面上显示为 **85 分**，比端正的肩部（40 分）还高。

即：最差的部位显示最高分，且头部数值与数据完全无关（恒定 85）。
健康类应用里，编造的数字比没有数字更糟 —— 本模块把这三个值改为**可追溯**的真实聚合。

## 口径（单点定义）

    某部位健康度 = 该部位在窗口内每一帧的「单项得分」的算术平均
    单项得分     = 100 − scorer.metric_deduction(该部位角度, 该部位阈值, 该部位档位边界)

## 为什么用「单项得分」而不是总分

总分是三档加权合成（最差项算满 + 其余 × SECONDARY_WEIGHT），一个部位差会连带压低
另外两项的呈现，三个部位之间就不可比了。单项得分只反映该部位自身的超标程度，
因此三个部位互相独立、可直接比较。

扣分函数与提醒分档共用 `scorer.metric_deduction`，所以「部位健康度偏低」与
「该部位会触发提醒」是同一套阈值判定的两种呈现，不会出现
「显示 90 分却提醒该部位」的自相矛盾。

## 双端一致

前端 `src/platform/partHealth.ts` 是本模块的逐位等价实现，
由 `scripts/verify-part-health.mjs` 用 Python 生成的期望值逐条对拍，
并已挂进 `npm run verify:parity`。改这里必须同步改前端，否则对拍会红。
"""

import logging

from services.scorer import (
    HEAD_MILD_HI,
    HEAD_MODERATE_HI,
    HEAD_TILT_THRESHOLD,
    SHOULDER_DIFF_THRESHOLD,
    SHOULDER_MILD_HI,
    SHOULDER_MODERATE_HI,
    SPINE_ANGLE_THRESHOLD,
    SPINE_MILD_HI,
    SPINE_MODERATE_HI,
    metric_deduction,
)
from services.rounding import round_1

logger = logging.getLogger("neckguardian.part_health")

# (输出字段, 数据表字段, 阈值, 轻微上界, 明显上界) —— 与 scorer 的三项一一对应
PARTS = (
    ("head", "head_angle", HEAD_TILT_THRESHOLD, HEAD_MILD_HI, HEAD_MODERATE_HI),
    ("shoulder", "shoulder_diff", SHOULDER_DIFF_THRESHOLD, SHOULDER_MILD_HI, SHOULDER_MODERATE_HI),
    ("spine", "spine_angle", SPINE_ANGLE_THRESHOLD, SPINE_MILD_HI, SPINE_MODERATE_HI),
)

EMPTY = {"head": None, "shoulder": None, "spine": None}


def compute_part_health(rows) -> dict:
    """把姿态采样行聚合为三个部位健康度（0–100，一位小数）。

    Args:
        rows: 可迭代对象，每项需支持 `row["head_angle"]` 形式的键访问
              （sqlite3.Row 与 dict 都可以）。

    Returns:
        {"head": float | None, "shoulder": float | None, "spine": float | None}

    ⚠️ 窗口内**没有任何采样**时返回全 None，而不是 0 —— 调用方据此显示
    「暂无数据」。用 0 会被误读成「部位健康度为 0（极差）」，这与「没有数据」
    是两件完全不同的事。
    """
    rows = list(rows)
    if not rows:
        return dict(EMPTY)

    out = {}
    for key, field, threshold, mild_hi, moderate_hi in PARTS:
        total = 0.0
        # 显式按下标顺序累加：浮点加法的结合顺序会影响末位，
        # 前端 TS 必须以完全相同的顺序累加，否则 `round(x, 1)` 可能差 0.1。
        for i in range(len(rows)):
            total += 100.0 - metric_deduction(float(rows[i][field]), threshold, mild_hi, moderate_hi)
        # 用 round_1 而不是内置 round()：内置 round 基于精确二进制值判定，
        # JS 无法复刻，会在平局点上让两端显示不同的数字（见 rounding.py）。
        out[key] = round_1(total / len(rows))

    logger.debug("part_health=%s (n=%d)", out, len(rows))
    return out

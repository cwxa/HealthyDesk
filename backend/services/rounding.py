"""全项目统一的取整口径（Python 侧）。

## 为什么不能用内置 `round()`

Python 的 `round(x, 1)` 是对 **x 的精确二进制值**做十进制舍入；而 JS 侧只能
`x * 10` 之后对浮点结果做整数舍入。两者在「恰好落在平局点」的输入上会分叉：

    平均分 = 99.45…（浮点实际落在平局点附近）
    Python round(x, 1) -> 99.5      # 基于精确值判定
    JS  x*10 后判定    -> 99.6      # 基于 x*10 的浮点判定

这不是理论推演 —— `scripts/verify-part-health.mjs` 的「取整平局点」用例
**实测**抓到了 3 处分叉（99.5/99.6、98.7/98.6、98.3/98.4）。

概率虽低（要求浮点结果精确落在半整数上），但后果是本项目的红线：
**同一份数据在手机与电脑上显示成不同的数字**。

## 统一口径

`round_1(x)` 明确定义为：

    先算 `x * 10`，再对这个浮点结果做「平局取偶」的整数舍入，最后除以 10

两端用**同一串浮点运算、同样的分支顺序**实现，因此逐位一致：

    Python  `services/rounding.py :: round_1`      ← 本文件
    JS      `src/platform/scoringModel.ts :: pyRound1`

由 `scripts/verify-part-health.mjs` 逐条对拍守住（含平局点用例）。
**改这里必须同步改前端**，否则对拍会红。

⚠️ 入参假定为**非负数**（分数、百分比、计数）。负数场景下 `floor` 与 `%` 的
语义在两端不一致，本项目用不到，如需支持要先补齐。
"""

import math


def round_1(x: float) -> float:
    """保留 1 位小数，平局取偶（等价于前端 `scoringModel.pyRound1`）。"""
    scaled = x * 10.0
    floor = math.floor(scaled)
    diff = scaled - floor
    if diff > 0.5:
        r = floor + 1
    elif diff < 0.5:
        r = floor
    else:
        r = floor if floor % 2 == 0 else floor + 1
    return r / 10.0


def round_int(x: float) -> int:
    """取整到整数，平局取偶（等价于前端 `scoringModel.pyRound`）。"""
    floor = math.floor(x)
    diff = x - floor
    if diff > 0.5:
        return floor + 1
    if diff < 0.5:
        return floor
    return floor if floor % 2 == 0 else floor + 1

"""姿态指标的指数滑动平均（EMA）平滑。

单独成模块的原因：它是评分链路（帧 → 角度 → **平滑** → 评分）里的一环，
必须与前端 `src/platform/localPoseEngine.ts` 的 `PoseSmoother` **完全等价**，
否则同一个姿势在手机和电脑上会得到不同的分数。
放在这里就能被 `scripts/gen-scoring-cases.py` 直接导入做逐帧对拍。

⚠️ 取整必须写成 `round(x * 100) / 100`，不能写成 `round(x, 2)`：
    前者 = 对 `x * 100` 做「银行家舍入」再除以 100，与前端 `pyRound()` 逐位等价；
    后者 = 把 x 的精确值舍入到 2 位小数，两者在 `x * 100` 恰好落在半整数时结果不同。
  例：x = 0.015 → `round(x, 2)` 得 0.01，`round(x * 100) / 100` 得 0.02（前端也是 0.02）。
"""

from typing import Optional

# smoothing factor: higher = faster response, lower = more stable
EMA_ALPHA = 0.35


class PoseSmoother:
    """Exponential moving average for pose metrics — reduces frame-to-frame jitter."""

    def __init__(self, alpha: float = EMA_ALPHA):
        self.alpha = alpha
        self._values: Optional[dict] = None

    def update(self, metrics: dict) -> dict:
        if self._values is None:
            self._values = {k: v for k, v in metrics.items() if isinstance(v, (int, float))}
            return dict(self._values)

        smoothed = {}
        for k, v in metrics.items():
            if isinstance(v, (int, float)) and k in self._values:
                smoothed[k] = round((self.alpha * v + (1 - self.alpha) * self._values[k]) * 100) / 100
                self._values[k] = smoothed[k]
            else:
                smoothed[k] = v
        return smoothed

    def reset(self):
        self._values = None

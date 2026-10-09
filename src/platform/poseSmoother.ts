import { pyRound } from './scoringModel'

export const EMA_ALPHA = 0.35
// 对齐旧版 5fps 的响应时间；生产路径按真实时间更新，测试/旧调用保留固定 alpha。
export const EMA_TIME_CONSTANT_MS = -200 / Math.log(1 - EMA_ALPHA)
export const MAX_SMOOTHING_GAP_MS = 1500

export class PoseSmoother {
  private values: Record<string, number> | null = null
  private lastTimestamp: number | null = null
  constructor(private alpha = EMA_ALPHA) {}

  update(metrics: Record<string, number>, timestampMs?: number): Record<string, number> {
    const dt = timestampMs !== undefined && this.lastTimestamp !== null ? timestampMs - this.lastTimestamp : null
    if (dt !== null && (dt <= 0 || dt > MAX_SMOOTHING_GAP_MS)) this.reset()
    const alpha = dt !== null && dt > 0 && dt <= MAX_SMOOTHING_GAP_MS ? 1 - Math.exp(-dt / EMA_TIME_CONSTANT_MS) : this.alpha
    this.lastTimestamp = timestampMs ?? null
    if (this.values === null) {
      this.values = { ...metrics }
      return { ...this.values }
    }
    const smoothed: Record<string, number> = {}
    for (const k of Object.keys(metrics)) {
      smoothed[k] = k in this.values ? pyRound((alpha * metrics[k] + (1 - alpha) * this.values[k]) * 100) / 100 : metrics[k]
    }
    // 缺失指标从状态中删除，恢复后不能继承遮挡前的旧值。
    this.values = { ...smoothed }
    return smoothed
  }

  reset() { this.values = null; this.lastTimestamp = null }
}

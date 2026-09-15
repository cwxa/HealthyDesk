import { getLocalSettings } from './localDb'

/**
 * 移动端本地提醒调度器。
 *
 * 桌面版由 Python 的 APScheduler 负责「每 N 分钟提醒一次」，
 * 移动端没有后端进程，这里用 JS 定时器复刻同样的行为：
 *   - 按 reminder_interval 周期触发
 *   - 支持 snooze（暂停 m 分钟）
 *   - 触发时通过回调通知 App 弹窗 + 播报
 *
 * 只在 App 处于前台时计时（移动端后台会被系统冻结），这是平台限制，
 * 但足以覆盖「打开 App 工作时被提醒」这一主要场景。
 */
export type ReminderCallback = (info: { isStartup: boolean }) => void

export class LocalReminderScheduler {
  private timer: number | null = null
  private intervalMin = 30
  private snoozeUntil = 0
  private breakActive = false
  private callback: ReminderCallback | null = null
  private startedAt = 0

  /** 启动调度：读取设置中的提醒间隔。 */
  async start(cb: ReminderCallback) {
    this.callback = cb
    const settings = await getLocalSettings()
    this.intervalMin = Math.max(1, parseInt(settings.reminder_interval) || 30)
    this.startedAt = Date.now()
    this.scheduleNext(this.intervalMin * 60_000)
  }

  stop() {
    if (this.timer) window.clearTimeout(this.timer)
    this.timer = null
  }

  /** 设置变更后热更新间隔。 */
  async updateInterval(minutes: number) {
    this.intervalMin = Math.max(1, minutes)
    if (!this.breakActive && Date.now() >= this.snoozeUntil) {
      this.scheduleNext(this.intervalMin * 60_000)
    }
  }

  /** 稍后提醒：暂停 m 分钟。 */
  snooze(minutes = 5) {
    this.snoozeUntil = Date.now() + minutes * 60_000
    this.scheduleNext(minutes * 60_000)
  }

  /** 进入休息（开始活动），暂停周期提醒，直到 endBreak。 */
  beginBreak() {
    this.breakActive = true
    if (this.timer) window.clearTimeout(this.timer)
    this.timer = null
  }

  /** 结束休息，重新开始周期提醒。 */
  endBreak() {
    this.breakActive = false
    this.snoozeUntil = 0
    this.scheduleNext(this.intervalMin * 60_000)
  }

  private scheduleNext(delayMs: number) {
    if (this.timer) window.clearTimeout(this.timer)
    this.timer = window.setTimeout(() => {
      this.fire()
    }, delayMs)
  }

  private fire() {
    if (this.breakActive) return
    const isStartup = Date.now() - this.startedAt < 1000
    this.callback?.({ isStartup })
    this.scheduleNext(this.intervalMin * 60_000)
  }

  /** 供设置页展示「下次提醒」。 */
  getNextReminderAt(): Date {
    if (this.breakActive) return new Date(Date.now() + this.intervalMin * 60_000)
    return new Date(Date.now() + (this.snoozeUntil > Date.now() ? this.snoozeUntil - Date.now() : this.intervalMin * 60_000))
  }
}

export const localReminder = new LocalReminderScheduler()

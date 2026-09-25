/**
 * 纯展示用的格式化助手。
 *
 * 只做"给人看"的字符串，不参与任何计算 —— 数值口径一律在 platform/ 里，
 * 这里取整不会影响数据（存储用量本来就是个估计值）。
 */

/** 把字节数格式化成人类可读的字符串。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i += 1
  }
  const rounded = Math.round(value * 10) / 10
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)} ${units[i]}`
}

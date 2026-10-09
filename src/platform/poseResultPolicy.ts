import type { PoseResult } from '../types'

/** 缺失项不补零；部分姿态只用于当前动作确实能观测到的维度。 */
export function canMeasureExercise(result: PoseResult, metric: string): boolean {
  const fields: Record<string, string[]> = {
    head: ['head_angle'], shoulder: ['shoulder_diff'], spine: ['spine_angle'],
    any: ['head_angle', 'shoulder_diff', 'spine_angle'],
  }
  if (result.type !== 'pose' && result.type !== 'partial_pose') return false
  return (fields[metric] ?? []).length > 0 && (fields[metric] ?? []).every(k =>
    Number.isFinite(result[k as 'head_angle']) && result.quality?.[k]?.valid !== false)
}

export function canRecordPosture(result: PoseResult): boolean {
  return result.type === 'pose' && (result.mode ?? 'monitor') === 'monitor' &&
    [result.head_angle, result.shoulder_diff, result.spine_angle, result.score].every(Number.isFinite)
}

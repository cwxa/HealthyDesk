/** 角度验证执行真实 TS/Python 几何与独立解析基准；不维护第三份公式。 */
import { verifyGeometry } from './verify-pose.mjs'
await verifyGeometry()
await import('./verify-pose-lifecycle.mjs')
await import('./verify-posture-calibration.mjs')

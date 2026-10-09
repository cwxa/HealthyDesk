import { useEffect, useRef, useState } from 'react'
import type { PoseResult } from '../types'
import { BASELINE_KEY, CALIBRATION_TIMEOUT_MS, PostureCalibrator, baselineDeviation, cameraMatches, parseBaseline,
  type CameraProfile, type CalibrationState, type PostureBaseline } from '../platform/postureCalibration'

function readBaseline(): PostureBaseline | null {
  try { return parseBaseline(localStorage.getItem(BASELINE_KEY)) }
  catch (error) { console.warn('[PostureCalibration] Baseline read failed', { error }); return null }
}

/** 两条识别链共用同一校准交互；采集状态通过 ref 反馈，避免重新启动摄像头。 */
export default function PostureCalibration({ result, camera, enabled, onCollectingChange }: {
  result: PoseResult | null; camera: CameraProfile | null; enabled: boolean; onCollectingChange: (value: boolean) => void
}) {
  const [baseline, setBaseline] = useState(readBaseline)
  const [collecting, setCollecting] = useState(false)
  const [state, setState] = useState<CalibrationState>({ progress: 0, message: '' })
  const [open, setOpen] = useState(false)
  const collector = useRef<PostureCalibrator | null>(null)
  const collectionCamera = useRef<CameraProfile | null>(null)

  useEffect(() => {
    onCollectingChange(collecting)
    return () => onCollectingChange(false)
  }, [collecting, onCollectingChange])

  useEffect(() => {
    if (baseline && camera && (!cameraMatches(baseline, camera) || !parseBaseline(JSON.stringify(baseline)))) {
      setBaseline(null)
      setState({ progress: 0, message: '摄像头、画面规格或有效期变化，请重新校准' })
      try { localStorage.removeItem(BASELINE_KEY) } catch (error) { console.warn('[PostureCalibration] Invalid baseline removal failed', { error }) }
      console.info('[PostureCalibration] Baseline invalidated', { reason: 'camera_profile_or_expiry' })
    }
  }, [baseline, camera, result])

  useEffect(() => {
    if (!collecting) return
    const cancel = (message: string) => {
      collector.current = null; setCollecting(false); setState({ progress: 0, message })
      console.info('[PostureCalibration] Collection cancelled', { reason: message === '校准超时，请调整机位后重试' ? 'timeout' : 'session_changed' })
    }
    if (!enabled || !camera || camera.key !== collectionCamera.current?.key || camera.aspect !== collectionCamera.current?.aspect) {
      cancel('检测或机位已变化，校准取消'); return
    }
    const timeout = window.setTimeout(() => cancel('校准超时，请调整机位后重试'), CALIBRATION_TIMEOUT_MS)
    const visibility = () => { if (document.hidden) cancel('页面已隐藏，校准取消') }
    document.addEventListener('visibilitychange', visibility)
    return () => { clearTimeout(timeout); document.removeEventListener('visibilitychange', visibility) }
  }, [collecting, enabled, camera])

  useEffect(() => {
    if (!collecting || !collector.current || !result || document.hidden) return
    const next = collector.current.push(result, performance.now())
    if (next.finished) { collector.current = null; setCollecting(false) }
    if (next.baseline) {
      try {
        localStorage.setItem(BASELINE_KEY, JSON.stringify(next.baseline))
        setBaseline(next.baseline)
        console.info('[PostureCalibration] Baseline saved', { samples: next.baseline.samples, baseline_version: 1 })
      } catch (error) {
        console.error('[PostureCalibration] Baseline save failed', { error })
        next.message = '保存失败，请检查本机存储后重试'
      }
    }
    setState(next)
  }, [result, collecting])

  const start = () => {
    if (!enabled || !camera || document.hidden) return
    collector.current = new PostureCalibrator(camera, performance.now())
    collectionCamera.current = camera
    setState({ progress: 0, message: '保持自然坐直，正在采集稳定姿势…' }); setCollecting(true)
    // 立即隔离语音和日统计，不等待 React effect 执行。
    onCollectingChange(true)
  }
  const reset = () => {
    if (collecting) {
      collector.current = null; setCollecting(false); onCollectingChange(false)
      setState({ progress: 0, message: '校准已取消，原基线保留' })
      console.info('[PostureCalibration] Collection cancelled', { reason: 'user_cancelled' })
      return
    }
    try {
      localStorage.removeItem(BASELINE_KEY); setBaseline(null); collector.current = null; setCollecting(false)
      onCollectingChange(false); setState({ progress: 0, message: '个人基线已重置' })
      console.info('[PostureCalibration] Baseline reset')
    } catch (error) { console.error('[PostureCalibration] Baseline reset failed', { error }); setState({ progress: 0, message: '重置失败，请重试' }) }
  }
  const current = baseline && parseBaseline(JSON.stringify(baseline)) ? baseline : null
  const delta = current && camera && enabled && result ? baselineDeviation(current, result, camera) : null
  const display = (v: number, unit: string) => `${v > 0 ? '+' : ''}${v.toFixed(1)}${unit}`
  return (
    <section aria-label="个人姿势基线" style={{ background: '#fff', borderRadius: 10, padding: '8px 12px', flexShrink: 0, fontSize: 12 }}>
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} style={{ border: 0, background: 'transparent', cursor: 'pointer', width: '100%', textAlign: 'left', color: '#555' }}>
        个人姿势基线 · {collecting ? `采集中 ${Math.round(state.progress * 100)}%` : current ? '已校准' : '未校准'} {open ? '▴' : '▾'}
      </button>
      {delta && <p style={{ marginTop: 6 }}>相对基线：头 {display(delta.head_angle, '°')} · 肩 {display(delta.shoulder_diff, '%')} · 躯干 {display(delta.spine_angle, '°')}</p>}
      {open && <div style={{ marginTop: 8, lineHeight: 1.6, maxHeight: 180, overflowY: 'auto' }}>
        <p>先摆正摄像头，让头、肩和髋部入镜，自然坐直约 10 秒。请勿用歪坐姿势校准。</p>
        <p>基线用于观察个人变化，通用评分仍按原标准。正负表示原始画面方向；不代表动作正确与否。</p>
        <p>移动、倾斜摄像头或更换使用者后请重新校准。基线仅保存在本机，有效期 30 天，不随健康备份导出。</p>
        {current && <p>校准于 {new Date(current.created_at).toLocaleString()} · {current.samples} 个样本</p>}
        <p role="status">{state.message || (!camera ? '等待摄像头设备与画面信息，暂不能校准' : enabled ? '可以开始校准' : '请先启动静息姿势检测')}</p>
        {collecting && <progress aria-label="校准进度" max={1} value={state.progress} style={{ width: '100%' }} />}
        <div style={{ display: 'flex', gap: 12, marginTop: 6 }}>
          <button type="button" onClick={start} disabled={!enabled || !camera || collecting}>{current ? '重新校准' : '开始校准'}</button>
          {(current || collecting) && <button type="button" onClick={reset}>{collecting ? '取消校准' : '重置基线'}</button>}
        </div>
      </div>}
    </section>
  )
}

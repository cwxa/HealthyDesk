import { useEffect, useRef, useState, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { usePoseEngine } from '../hooks/usePoseEngine'
import { useApi } from '../hooks/useApi'
import { data } from '../platform/dataLayer'
import { isMobile, platformLabel } from '../platform/runtime'
import { localReminder } from '../platform/localReminder'
import PostureSkeleton from '../components/PostureSkeleton'
import ScoreGauge from '../components/ScoreGauge'
import ExercisePanel, { exercises, type ExerciseState } from '../components/ExercisePanel'
import ExerciseGuide from '../components/ExerciseGuide'
import { speakPostureIssue, speak } from '../utils/speech'
import { judgeExercise, type ExerciseFrame, type ExerciseGrade } from '../platform/exerciseQuality'
import { nativeDiagAsync, describePermission, onNativePermissionChange } from '../platform/nativeDiag'
import { withTimeout } from '../utils/withTimeout'
import type { PoseResult } from '../types'

type Mode = 'monitor' | 'exercise' | 'done'

/**
 * 打开摄像头。
 *
 * 先按「前置 + 640×480」尝试（尺寸与桌面端发给后端的帧一致），
 * 若设备不支持该约束则降级为完全放开约束重试一次，
 * 避免因分辨率/facingMode 不被支持而整个功能不可用。
 */
async function openCameraStream(): Promise<MediaStream> {
  if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
    const err = new Error('navigator.mediaDevices 不可用（非安全上下文或 WebView 未开放该 API）')
    err.name = 'SecurityError'
    throw err
  }
  const attempts: MediaStreamConstraints[] = [
    { video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }, audio: false },
    { video: true, audio: false },
  ]
  let lastErr: unknown = null
  for (const constraints of attempts) {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints)
    } catch (e) {
      lastErr = e
      const name = (e as { name?: string })?.name
      // 只有「约束不满足 / 找不到指定设备」值得降级重试；权限类错误重试没有意义
      if (name !== 'OverconstrainedError' && name !== 'NotFoundError') break
    }
  }
  throw lastErr
}

/**
 * 取流 + 超时保护。
 *
 * ⚠️ 超时只是让**界面**失败，**并不能取消 `getUserMedia`**：用户可能在超时之后才点
 * 「允许」，那时这条流仍会成功返回，而调用方早已走了错误分支——没人接手的流会一直
 * 占着摄像头（指示灯常亮），并让下一次取流报 `NotReadableError`。
 * 所以这里挂一个「迟到清理」：超时之后若流最终还是来了，立刻关掉它。
 */
async function openCameraStreamWithinTimeout(ms: number): Promise<MediaStream> {
  const pending = openCameraStream()
  try {
    return await withTimeout(pending, ms, '打开摄像头')
  } catch (e) {
    void pending.then((late) => late.getTracks().forEach((t) => t.stop())).catch(() => {})
    throw e
  }
}

/** 把底层错误翻译成用户能照着做的提示。 */
function describeCameraError(e: unknown): string {
  const name = (e as { name?: string })?.name ?? 'Error'
  switch (name) {
    case 'NotAllowedError':
      return '相机权限被拒绝。请到「设置 → 应用 → NeckGuardian → 权限」允许相机后点重试。'
    case 'NotFoundError':
      return '未找到可用摄像头，请确认设备有前置摄像头。'
    case 'NotReadableError':
      return '摄像头无法启动：可能被其他应用占用，或被系统隐私开关拦截。请关闭其他相机应用后重试。'
    case 'OverconstrainedError':
      return '摄像头不支持被请求的分辨率，降级重试后仍失败。'
    case 'SecurityError':
      return '当前页面不是安全上下文，无法调用摄像头。'
    case 'AbortError':
      return '摄像头启动被中断，请重试。'
    case 'TimeoutError':
      return '打开摄像头长时间无响应：多半是被系统权限对话框挡住，或摄像头被其他应用占用。请确认已允许相机权限后重试。'
    default:
      return `摄像头启动失败（${name}）`
  }
}

/** 组装一行诊断信息，出问题时截图即可定位。 */
async function buildCameraDiag(e: unknown): Promise<string> {
  const parts: string[] = []
  const name = (e as { name?: string })?.name ?? 'Error'
  const message = (e as { message?: string })?.message
  parts.push(`错误 ${name}${message ? `: ${message}` : ''}`)
  parts.push(`安全上下文 ${window.isSecureContext ? '是' : '否'}`)
  const d = await nativeDiagAsync()
  if (d) {
    if (d.cameraPermission !== 'unknown') parts.push(describePermission(d.cameraPermission))
    if (d.version) {
      parts.push(`构建 v${d.version}${d.versionCode != null ? `(${d.versionCode})` : ''}`)
    }
    parts.push(`平台 ${platformLabel()}`)
  }
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    parts.push(`视频设备 ${devices.filter((x) => x.kind === 'videoinput').length} 个`)
  } catch {
    parts.push('设备枚举失败')
  }
  parts.push(navigator.userAgent.match(/Chrome\/[\d.]+/)?.[0] ?? 'WebView 版本未知')
  return parts.join(' · ')
}

export default function NeckActivity() {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const [cameraReady, setCameraReady] = useState(false)
  const [cameraError, setCameraError] = useState('')
  const [cameraDiag, setCameraDiag] = useState('')
  /** 当前所处阶段，直接显示在界面上 —— 卡住时能一眼看出断在哪一步。 */
  const [cameraStage, setCameraStage] = useState('')
  /** 安装包版本（安卓侧读取），用于确认用户实际装的是哪一版。 */
  const [buildTag, setBuildTag] = useState('')
  const [latestResult, setLatestResult] = useState<PoseResult | null>(null)
  const [mode, setMode] = useState<Mode>('monitor')
  const { connected, onPoseResult, backendError, resetBackendError, attachVideo, stop, sendFrame, connect, setScoreMode } = usePoseEngine()
  const { post, get } = useApi()
  const intervalRef = useRef<number>(0)
  const lastRecordRef = useRef(0)
  // 标记摄像头已卸载（StrictMode 双挂载 / 组件卸载），使未完成的 async 不再回写
  const cameraAbortRef = useRef(false)
  // 取流进行中标记，避免并发启动摄像头
  const startingRef = useRef(false)

  // Exercise state
  const [exCurrent, setExCurrent] = useState(0)
  const [exTimeLeft, setExTimeLeft] = useState(exercises[0].duration)
  const [exScores, setExScores] = useState<number[]>([])
  const exTimerRef = useRef<number>(0)
  const exScoresRef = useRef<number[]>([])
  /**
   * 活动期间的原始帧（带动作下标）。
   *
   * 为什么要留原始帧而不只留分数：完成度判定（`judgeExercise`）需要**活动量序列**
   * 才能算「幅度 / 保持时长 / 往复次数」，分数是它的单调映射、丢掉了这些信息。
   * 帧必须带 `action` 下标 —— 7 个动作的类型不同（保持类 / 往复类），
   * 用整段活动的帧去判单个动作是错的（12 秒的动作不该按 82 秒的标称时长算保持比例）。
   */
  const exFramesRef = useRef<Array<ExerciseFrame & { action: number }>>([])
  // 供 onPoseResult 回调读取当前动作下标：不能把 exCurrent 写进那个 effect 的依赖
  // （每换一个动作就重建订阅，会反复掐掉推理循环），所以用 ref 传。
  const exCurrentRef = useRef(0)
  useEffect(() => { exCurrentRef.current = exCurrent }, [exCurrent])
  // 类型直接从 ExerciseState 派生，避免两处各写一份形状（改一处忘另一处）
  const [exVerdict, setExVerdict] = useState<ExerciseState['verdict']>(null)

  const startCamera = useCallback(async () => {
    // 并发守卫：挂载自动启动 + 用户在系统对话框点「允许」触发的自动重取流可能撞在一起，
    // 同时开两次摄像头会让其中一路报 NotReadableError。
    if (startingRef.current) return
    startingRef.current = true
    setCameraError('')
    setCameraDiag('')
    try {
      setCameraStage('正在申请相机权限并取流…')
      // 超时保护：WebView 既不放行也不拒绝时 getUserMedia 会永久 pending，
      // 没有超时界面就会无限停在「正在启动摄像头...」
      const stream = await openCameraStreamWithinTimeout(30000)
      // 若在等待授权期间组件已卸载/重挂载，立即释放这条流，避免泄漏
      if (cameraAbortRef.current) {
        stream.getTracks().forEach((t) => t.stop())
        return
      }
      streamRef.current = stream

      // ⚠️ 先让 <video> 可见再 play()：`display:none` 的元素在部分安卓 WebView 上
      // play() 的 Promise 会一直不 resolve，从而把整个流程卡死。
      setCameraReady(true)
      setCameraStage('正在启动画面…')

      const video = videoRef.current
      if (video) {
        video.srcObject = stream
        // play() 不阻塞主流程：即使被策略拦下，本地引擎也会按 readyState 取帧，
        // 用户点一下画面就能重新 play。
        void Promise.resolve(video.play()).catch(() => {})
      }

      setCameraStage(isMobile() ? '正在加载姿态模型…' : '正在连接后端…')
      // 桌面端连 Python 后端；移动端启动本地姿态引擎
      if (isMobile() && video) {
        await attachVideo(video)
      } else {
        connect()
      }
      setCameraStage('')
    } catch (e) {
      if (cameraAbortRef.current) return
      setCameraReady(false)
      setCameraStage('')
      // 不再吞掉错误：把真实原因与现场信息一起展示，便于用户自查或反馈
      setCameraError(describeCameraError(e))
      setCameraDiag(await buildCameraDiag(e))
    } finally {
      startingRef.current = false
    }
  }, [connect, attachVideo])

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    if (videoRef.current) videoRef.current.srcObject = null
    setCameraReady(false)
    stop()
  }, [stop])

  useEffect(() => {
    let cancelled = false
    void nativeDiagAsync().then((d) => {
      if (cancelled || !d?.version) return
      setBuildTag(`v${d.version}${d.versionCode != null ? `(${d.versionCode})` : ''}`)
    })
    return () => {
      cancelled = true
    }
  }, [])

  // 用 ref 持有最新回调，让「启动摄像头」严格只在挂载时执行一次。
  // ⚠️ 绝不能把 startCamera / stopCamera 直接写进依赖数组：只要下层 hook 返回的函数
  // 标识发生变化，这个 effect 就会在**每次渲染**重跑一遍 —— 每次都先 stopCamera()
  // 掐掉摄像头、再重新 getUserMedia，于是「取流成功」与「置 cameraReady」之间
  // 任何一次渲染都会把流释放掉，界面永远停在「正在启动摄像头...」。
  const startCameraRef = useRef(startCamera)
  startCameraRef.current = startCamera
  const stopCameraRef = useRef(stopCamera)
  stopCameraRef.current = stopCamera

  useEffect(() => {
    cameraAbortRef.current = false
    startCameraRef.current()
    return () => {
      // 标记中止：使未完成的 getUserMedia 回调不再回写 state
      cameraAbortRef.current = true
      stopCameraRef.current()
      clearInterval(intervalRef.current)
      clearInterval(exTimerRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 用户在系统权限对话框点了「允许」时，自动重新取流，不必手动点「重试摄像头」
  useEffect(() => {
    return onNativePermissionChange((state) => {
      if (state !== 'granted' || cameraAbortRef.current) return
      // 已经有活跃画面就不重复开流（否则会占用第二次摄像头）
      const track = streamRef.current?.getVideoTracks()[0]
      if (track && track.readyState === 'live') return
      startCamera()
    })
  }, [startCamera])

  // Frame capture（仅桌面端：移动端由本地引擎直接读取 video 元素）
  const captureAndSend = useCallback(() => {
    if (isMobile()) return
    if (!canvasRef.current || !videoRef.current || !connected) return
    const canvas = canvasRef.current
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    canvas.width = 640
    canvas.height = 480
    ctx.drawImage(videoRef.current, 0, 0, 640, 480)
    sendFrame(canvas.toDataURL('image/jpeg', 0.7))
  }, [connected, sendFrame])

  useEffect(() => {
    if (isMobile()) return
    if (!cameraReady || !connected) return
    intervalRef.current = window.setInterval(captureAndSend, 200)
    return () => clearInterval(intervalRef.current)
  }, [cameraReady, connected, captureAndSend])

  /**
   * 把当前模式同步给姿态引擎。
   *
   * 运动态走**独立评分通道**：语义是「这个动作做到位了吗」，而不是「你对称吗」。
   * 不分通道时，用户把「颈部左侧屈」做到 20°（正常活动度约 45°）会被判
   * 「头部严重侧倾」、拿 45 分，还会被语音批评 —— 产品在惩罚用户做它要求做的事。
   */
  useEffect(() => {
    setScoreMode(mode === 'exercise' ? 'exercise' : 'monitor')
  }, [mode, setScoreMode])

  // Pose result handling
  useEffect(() => {
    onPoseResult((result: PoseResult) => {
      setLatestResult(result)
      // 语音批评**只在静息态**：运动态的 issues（"动作幅度不足"）不是姿态问题，
      // 更不该用「检测到头部严重侧倾，请注意调整坐姿。」去批评一个正在做拉伸的人。
      if (mode === 'monitor' && result.type === 'pose' && result.issues && result.issues.length > 0) {
        const severeOnly = result.issues.filter(i => i.includes('严重'))
        if (severeOnly.length > 0) speakPostureIssue(severeOnly)
      }
      if (result.type === 'pose' && result.score !== undefined) {
        if (mode === 'exercise') {
          // 收的是**运动态通道**的分数（动作达成度），不是活动期间的静息姿态分。
          setExScores(p => { const next = [...p, result.score!]; exScoresRef.current = next; return next })
          // 原始帧是完成度判定的输入。⚠️ 只推入**有姿态**的帧：
          // `judgeExercise` 把相邻帧的时间差当作"该帧的维持时长"，缺口必须留白而不是补 0。
          exFramesRef.current.push({
            t: Date.now(),
            action: exCurrentRef.current,
            head_angle: result.head_angle ?? 0,
            shoulder_diff: result.shoulder_diff ?? 0,
            spine_angle: result.spine_angle ?? 0,
          })
        } else {
          // 只记录**静息坐姿**采样。活动期间写库会同时污染两处：
          // 「今日平均分」与「部位健康度」会把"用户在做动作"当成"不良姿态"
          // （康复动作本就要求偏离中立位），进而显示成一片红色的差数据。
          const now = Date.now()
          if (now - lastRecordRef.current >= 1500) {
            lastRecordRef.current = now
            data.recordPosture({
              timestamp: result.timestamp,
              head_angle: result.head_angle!,
              shoulder_diff: result.shoulder_diff!,
              spine_angle: result.spine_angle!,
              score: result.score!,
            }).catch(() => {})
          }
        }
      }
    })
  }, [onPoseResult, post, mode])

  // Check for pending reminder on mount
  useEffect(() => {
    const checkPendingReminder = async () => {
      try {
        const status = await get<{pending: boolean, is_startup_reminder?: boolean}>('/api/reminder/status')
        if (status.pending) {
          window.dispatchEvent(new CustomEvent('show-reminder-modal'))
        }
      } catch (e) {
        console.error('Failed to check pending reminder:', e)
      }
    }
    checkPendingReminder()
  }, [get])

  // 监听来自 App / 托盘的「开始活动」意图。
  // 用 sessionStorage 兜底：若事件在组件挂载前已派发（跨路由跳转），
  // 挂载时读取标记并进入练习模式，避免意图丢失。
  useEffect(() => {
    const beginExerciseMode = () => {
      setMode('exercise')
      setExCurrent(0)
      setExTimeLeft(exercises[0].duration)
      setExScores([])
      exScoresRef.current = []
      exFramesRef.current = []
      setExVerdict(null)
      speak('请跟随引导完成肩颈活动')
    }
    const handleStartExerciseMode = () => {
      sessionStorage.removeItem('neckguardian:start-exercise')
      beginExerciseMode()
    }
    window.addEventListener('start-exercise-mode', handleStartExerciseMode)
    if (sessionStorage.getItem('neckguardian:start-exercise')) {
      sessionStorage.removeItem('neckguardian:start-exercise')
      beginExerciseMode()
    }
    return () => window.removeEventListener('start-exercise-mode', handleStartExerciseMode)
  }, [])

  // Start exercise
  const startExercise = useCallback(async () => {
    try {
      await data.endBreak()
    } catch (e) {
      console.error('End break failed:', e)
    }
    setMode('exercise')
    setExCurrent(0)
    setExTimeLeft(exercises[0].duration)
    setExScores([])
    exScoresRef.current = []
    exFramesRef.current = []
    setExVerdict(null)
    if (isMobile()) localReminder.beginBreak()
    speak('请跟随引导完成肩颈活动')
  }, [])

  /**
   * 逐动作完成度判定 —— 这是 S2 的核心：**结束不再等于完成**。
   *
   * 此前不管用户做没做，82 秒倒计时走完就宣布「活动完成!」并记一条记录。
   * 现在按动作分别判定：每个动作用自己的类型（保持类看幅度+保持时长，
   * 往复类看幅度+有效次数）与自己的标称时长去评它自己那一段帧。
   *
   * ⚠️ 只判**可判定**的动作（`measurable`）：
   *   - 没有采样的动作不判（摄像头没拍到人、用户中途离开画面都会零采样，
   *     这时下"你没做"的结论是冤枉用户）；
   *   - 三个指标测不到的动作不判（转颈 / 扩胸 / 头部后缩，见 ExercisePanel 的说明）——
   *     对它们说"没检测到动作"同样是冤枉正在做的用户。
   */
  const judgeSession = useCallback((): NonNullable<ExerciseState['verdict']> => {
    const frames = exFramesRef.current
    let completed = 0
    let moved = 0
    let judged = 0
    let notJudgeable = 0
    for (let i = 0; i < exercises.length; i++) {
      const e = exercises[i]
      if (!e.measurable) {
        notJudgeable++
        continue
      }
      const mine = frames.filter((f) => f.action === i)
      if (mine.length === 0) continue
      judged++
      const verdict = judgeExercise(mine, {
        kind: e.kind,
        duration_ms: e.duration * 1000,
        min_cycles: e.min_cycles,
      })
      if (verdict.grade === 'completed') completed++
      // 「动过但没到位」要单独计数：收尾文案靠它区分"没动"与"幅度不够"
      else if (verdict.grade === 'insufficient') moved++
    }
    return { completed, moved, judged, notJudgeable }
  }, [])

  const finishExercise = useCallback(async () => {
    clearInterval(exTimerRef.current)
    setMode('done')
    const ss = exScoresRef.current
    const avg = ss.length > 0 ? Math.round(ss.reduce((a, b) => a + b, 0) / ss.length) : 0
    const dur = exercises.reduce((s, e) => s + e.duration, 0)
    const verdict = judgeSession()
    setExVerdict(verdict)
    // 语音与收尾文案同源分三种：完成 / 动了但幅度不够 / 一次都没动。
    // judged === 0（摄像头没拍到人）时不做任何断言。
    speak(
      verdict.judged === 0 || verdict.completed > 0
        ? '活动完成！'
        : verdict.moved > 0
          ? '动作做到了，幅度再打开一点效果更好'
          : '本次没检测到动作，下次跟着引导一起做',
    )
    if (isMobile()) localReminder.endBreak()
    try {
      await data.recordActivity({
        timestamp: new Date().toISOString(),
        activity_type: 'exercise',
        exercise_count: exercises.length,
        duration_sec: dur,
        avg_score: avg,
      })
      await data.endBreak()
    } catch (e) {
      console.error('Activity record failed:', e)
    }
  }, [judgeSession])

  // 用 ref 持有最新的 finishExercise，供计时器回调调用，避免 stale closure
  const finishRef = useRef(finishExercise)
  useEffect(() => { finishRef.current = finishExercise }, [finishExercise])

  // Exercise timer
  useEffect(() => {
    if (mode !== 'exercise') return
    exTimerRef.current = window.setInterval(() => {
      setExTimeLeft(t => {
        if (t <= 1) {
          setExCurrent(c => {
            if (c < exercises.length - 1) {
              setExTimeLeft(exercises[c + 1].duration)
              return c + 1
            } else {
              finishRef.current()
              return c
            }
          })
          return 0
        }
        return t - 1
      })
    }, 1000)
    return () => clearInterval(exTimerRef.current)
  }, [mode])

  const skipCurrent = () => {
    setExCurrent(c => {
      if (c < exercises.length - 1) {
        setExTimeLeft(exercises[c + 1].duration)
        return c + 1
      } else {
        finishRef.current()
        return c
      }
    })
  }

  const endExercise = () => {
    clearInterval(exTimerRef.current)
    finishRef.current()
  }

  const score = latestResult?.type === 'pose' ? (latestResult.score ?? 0) : 0
  const issues = latestResult?.type === 'pose' ? (latestResult.issues ?? []) : []
  const hasPose = latestResult?.type === 'pose'
  const scoreColor = score >= 80 ? '#4CAF50' : score >= 60 ? '#FF9800' : score > 0 ? '#EF5350' : '#999'
  const scoreLabel = score > 0 ? (score >= 80 ? '姿态良好' : score >= 60 ? '需要注意' : '姿态异常') : '等待数据'
  const mobile = isMobile()

  const totalDur = exercises.reduce((s, e) => s + e.duration, 0)
  const elapsed = totalDur - exercises.slice(exCurrent).reduce((s, e, i) => s + (i === 0 ? exTimeLeft : e.duration), 0)
  const progress = (elapsed / totalDur) * 100

  /**
   * 实时引导：对**当前动作最近 GUIDE_WINDOW_MS 内的帧**做一次完成度判定。
   *
   * 为什么是滚动窗口而不是整段活动：
   *   1. 用户需要的是"此刻该怎么做"，把几十秒前的帧也算进来只会让提示迟钝；
   *   2. 每个动作的标称时长就是它自己那 10–12 秒，窗口正好对齐这个量级；
   *   3. 顺序读取 exFramesRef 不引入额外 state，不会因为"每帧都 setState"
   *      把渲染压力翻倍 —— 帧写进 ref、由既有的 latestResult 触发的渲染顺带读出来。
   */
  /**
   * 实时引导的滚动窗口长度。
   *
   * 取 5 秒而不是 3 秒，是因为往复类动作（肩部环绕）要求窗口内含**一次完整的
   * "到位→归位"**才计一环：慢慢画圈的人一次循环可能接近 3 秒，窗口太短就会一直
   * 卡在"再多做几次"的误报上。5 秒对保持类同样成立（0.6 的保持线 = 需要保持 3 秒）。
   */
  const GUIDE_WINDOW_MS = 5000
  const liveQuality: { grade: ExerciseGrade; hint: string } | null = (() => {
    if (mode !== 'exercise') return null
    // 指标测不到的动作不给判定 —— 见 ExercisePanel 里 `measurable` 的说明
    if (!exercises[exCurrent].measurable) return null
    const frames = exFramesRef.current
    if (frames.length < 2) return null
    const end = frames[frames.length - 1].t
    const win = frames.filter((f) => f.action === exCurrent && f.t > end - GUIDE_WINDOW_MS)
    if (win.length < 2) return null
    const e = exercises[exCurrent]
    const v = judgeExercise(win, {
      kind: e.kind,
      duration_ms: GUIDE_WINDOW_MS,
      // 窗口里只要求看到一次有效归位，整场判定才用动作自己的 min_cycles
      min_cycles: e.kind === 'cyclic' ? 1 : 0,
    })
    return { grade: v.grade, hint: v.hint }
  })()

  const exState: ExerciseState = {
    phase: mode === 'done' ? 'done' : 'active',
    current: exCurrent,
    timeLeft: exTimeLeft,
    // 活动期间这个分来自**运动态通道**（动作达成度），不是静息姿态分
    activityScore: score,
    hasPose: latestResult?.type === 'pose',
    sessionScores: exScores,
    totalDur,
    progress,
    qualityHint: liveQuality?.hint ?? '',
    qualityGrade: liveQuality?.grade ?? null,
    verdict: exVerdict,
  }

  // ---- 摄像头面板（两端共用）----
  const cameraPanel = (
        <div style={{
          position: 'relative', background: '#1a1a2e',
          borderRadius: 12, overflow: 'hidden',
          height: '100%',
          width: '100%',
          boxShadow: '0 2px 16px rgba(0,0,0,0.08)',
        }}>
          {!cameraReady && (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, zIndex: 5 }}>
              {cameraError ? (
                <>
                  <div style={{ width: 72, height: 72, borderRadius: '50%', background: '#FFF3E0', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <span style={{ fontSize: 32 }}>📷</span>
                  </div>
                  <p style={{ color: '#E65100', fontSize: 15, fontWeight: 500, textAlign: 'center', maxWidth: 320, lineHeight: 1.7 }}>{cameraError}</p>
                  {cameraDiag && (
                    <p style={{ color: 'rgba(255,255,255,0.45)', fontSize: 11, lineHeight: 1.6, textAlign: 'center', maxWidth: 340, wordBreak: 'break-all' }}>
                      {cameraDiag}
                    </p>
                  )}
                </>
              ) : (
                <>
                  <div style={{ width: 72, height: 72, borderRadius: '50%', background: 'rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <span style={{ fontSize: 32, filter: 'grayscale(0.5)' }}>📷</span>
                  </div>
                  <p style={{ color: 'rgba(255,255,255,0.5)', fontSize: 15, fontWeight: 500, textAlign: 'center' }}>{cameraStage || '正在启动摄像头...'}</p>
                  {buildTag && (
                    <p style={{ color: 'rgba(255,255,255,0.3)', fontSize: 11 }}>构建 {buildTag}</p>
                  )}
                </>
              )}
            </div>
          )}

          <video
            ref={videoRef}
            // 始终参与布局（不用 display:none）—— 未渲染的元素在部分安卓 WebView 上
            // play() 会不 resolve；未就绪时被上层遮罩盖住，观感不变。
            style={{ display: 'block', width: '100%', height: '100%', objectFit: 'cover', transform: 'scaleX(-1)' }}
            autoPlay
            playsInline
            muted
            // 万一自动播放被策略拦下，点一下画面即可恢复
            onClick={() => { videoRef.current?.play().catch(() => {}) }}
          />
          <canvas ref={canvasRef} style={{ display: 'none' }} />

          {cameraReady && latestResult?.type === 'pose' && latestResult.landmarks && (
            <div style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', transform: 'scaleX(-1)' }}>
              <PostureSkeleton landmarks={latestResult.landmarks} width={640} height={480} />
            </div>
          )}

          {!mobile && !connected && cameraReady && !backendError && (
            <div style={{ position: 'absolute', top: 12, left: 12, background: 'rgba(255,167,38,0.9)', color: '#fff', padding: '6px 14px', borderRadius: 20, fontSize: 12, fontWeight: 500, zIndex: 10 }}>
              {isMobile() ? '正在加载姿态模型...' : '正在连接后端...'}
            </div>
          )}

          {backendError && (
            <div style={{
              position: 'absolute', top: 12, left: 12, right: 12,
              background: 'rgba(198,40,40,0.92)', color: '#fff',
              padding: '10px 16px', borderRadius: 12, fontSize: 12, zIndex: 10,
              display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
            }}>
              <span style={{ lineHeight: 1.6 }}>
                ⚠ {isMobile() ? '姿态模型加载异常' : '姿态识别服务异常'}：{backendError}
              </span>
              <button
                onClick={() => { resetBackendError(); if (!isMobile()) connect() }}
                style={{
                  flexShrink: 0, padding: '6px 16px', borderRadius: 8, border: 'none',
                  background: 'rgba(255,255,255,0.9)', color: '#C62828',
                  fontSize: 12, fontWeight: 700, cursor: 'pointer',
                }}
              >
                重试
              </button>
            </div>
          )}

          {!mobile && connected && cameraReady && (
            <div style={{ position: 'absolute', top: 12, left: 12, display: 'flex', alignItems: 'center', gap: 6, zIndex: 10 }}>
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#4CAF50', boxShadow: '0 0 8px rgba(76,175,80,0.6)' }} />
              <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)' }}>实时检测中</span>
            </div>
          )}

          {/* ⚠ 姿态问题提示（手机端）—— 刻意做成**画面内浮层**而非摄像头之外的流式元素：
              它是随姿态结果高频出现/消失的，一旦参与布局就会不断改变摄像头高度，
              表现为画面上下跳动。浮层 + 淡入淡出可以彻底消除这种抖动。
              key 固定为字符串，避免 issues 内容变化时重播进出动画。 */}
          {mobile && mode === 'monitor' && !backendError && (
            <AnimatePresence>
              {issues.length > 0 && (
                <motion.div
                  key="issues-overlay"
                  initial={{ opacity: 0, y: -6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  transition={{ duration: 0.18 }}
                  style={{
                    position: 'absolute', top: 10, left: 10, right: 10, zIndex: 12,
                    display: 'flex', alignItems: 'center', gap: 6,
                    background: 'rgba(198,40,40,0.88)', backdropFilter: 'blur(6px)',
                    borderRadius: 10, padding: '6px 10px',
                    pointerEvents: 'none',
                  }}
                >
                  <span style={{ fontSize: 12, color: '#fff', flexShrink: 0 }}>⚠</span>
                  <span style={{
                    flex: 1, fontSize: 12, color: '#fff', lineHeight: 1.4,
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  }}>{issues.join(' · ')}</span>
                </motion.div>
              )}
            </AnimatePresence>
          )}

          {/* 实时引导（手机端）—— 与上面的姿态提示同一套做法：**画面内浮层**。
              它随判定结果（没动 / 幅度不够 / 到位）高频切换，做成流式元素会不断改变
              摄像头高度导致画面跳动；浮层 + 淡入淡出彻底消除这种抖动。
              right: 92 是为了避开右上角的动作示意（ExerciseGuide size=72）。 */}
          {mobile && mode === 'exercise' && liveQuality && (
            <AnimatePresence>
              <motion.div
                key="exercise-guide-overlay"
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.18 }}
                style={{
                  position: 'absolute', top: 10, left: 10, right: 92, zIndex: 12,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: liveQuality.grade === 'completed' ? 'rgba(46,125,50,0.88)' : 'rgba(239,108,0,0.9)',
                  backdropFilter: 'blur(6px)',
                  borderRadius: 10, padding: '6px 10px',
                  pointerEvents: 'none',
                }}
              >
                <span style={{
                  fontSize: 12, color: '#fff', lineHeight: 1.4,
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}>{liveQuality.hint}</span>
              </motion.div>
            </AnimatePresence>
          )}

          {/* 未检测到人体：放画面垂直居中，避开底部指标条（原来贴底会和指标叠在一起） */}
          {cameraReady && connected && latestResult?.type === 'no_pose' && (
            <div style={{
              position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
              background: 'rgba(0,0,0,0.65)', color: '#fff', padding: '8px 20px',
              borderRadius: 20, fontSize: 13, zIndex: 10,
              whiteSpace: 'nowrap', maxWidth: '90%', overflow: 'hidden', textOverflow: 'ellipsis',
            }}>
              未检测到人体，请面向摄像头
            </div>
          )}

          {/* Posture metrics overlay —— 手机端用紧凑等分模式铺满一行，两端都不会与浮层打架。
              warn / critical 必须与 scorer 的档位边界一致（warn=阈值，critical=严重档起点=阈值+「明显」上界），
              这样徽章颜色和提醒等级说的是同一件事。 */}
          {cameraReady && (
            <div style={{
              position: 'absolute', bottom: mobile ? 8 : 16,
              left: mobile ? 8 : 0, right: mobile ? 8 : 0,
              display: 'flex', justifyContent: 'center',
              gap: mobile ? 6 : 16, zIndex: 10,
            }}>
              <MetricBadge compact={mobile} label="头部侧倾" value={latestResult?.type === 'pose' ? latestResult.head_angle : undefined} unit="°" warn={5} critical={17} />
              <MetricBadge compact={mobile} label="肩部高差" value={latestResult?.type === 'pose' ? latestResult.shoulder_diff : undefined} unit="%" warn={4} critical={14} />
              <MetricBadge compact={mobile} label="脊柱倾斜" value={latestResult?.type === 'pose' ? latestResult.spine_angle : undefined} unit="°" warn={10} critical={26} />
            </div>
          )}
        </div>
  )

  // ==================== 手机端：整屏不滚动 ====================
  // 顶部「标题 + 状态」→ 紧凑指标条（固定在上半部分）→ 摄像头自适应剩余高度 → 底部操作
  if (mobile) {
    const statusText = cameraError
      ? '摄像头异常'
      : connected && cameraReady
        ? '实时检测中'
        : cameraStage || (cameraReady ? '启动中…' : '正在启动…')

    return (
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {/* 标题 + 状态 */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexShrink: 0 }}>
          <h2 style={{ fontSize: 18, fontWeight: 700 }}>🧘 肩颈活动</h2>
          {cameraError ? (
            <button onClick={() => startCamera()} style={{
              padding: '6px 14px', borderRadius: 8, border: 'none',
              background: '#4CAF50', color: '#fff', cursor: 'pointer',
              fontSize: 12, fontWeight: 600,
            }}>重试摄像头</button>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
              <div style={{
                width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
                background: connected && cameraReady ? '#4CAF50' : '#FFA726',
                boxShadow: connected && cameraReady ? '0 0 8px rgba(76,175,80,0.6)' : 'none',
              }} />
              <span style={{
                fontSize: 11, color: '#999',
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              }}>{statusText}</span>
            </div>
          )}
        </div>

        {mode === 'done' ? (
          <div style={{
            flex: 1, minHeight: 0, background: '#fff', borderRadius: 12,
            boxShadow: '0 1px 8px rgba(0,0,0,0.06)', padding: 16, display: 'flex',
          }}>
            <ExercisePanel state={exState} onSkipCurrent={skipCurrent} onEndExercise={endExercise} />
          </div>
        ) : (
          <>
            {mode === 'monitor' ? (
              /* ---- 实时指标条：评分 + 三项指标，压缩成一条固定在顶部 ---- */
              <div style={{
                display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0,
                background: '#fff', borderRadius: 12, padding: '8px 12px',
                boxShadow: '0 1px 8px rgba(0,0,0,0.06)',
              }}>
                <ScoreGauge score={score} size={44} hasData={hasPose} />
                <div style={{ minWidth: 44 }}>
                  <p style={{ fontSize: 10, color: '#999', lineHeight: 1.2 }}>实时评分</p>
                  <p style={{ fontSize: 12, fontWeight: 700, color: scoreColor, whiteSpace: 'nowrap' }}>{scoreLabel}</p>
                </div>
                <div style={{ width: 1, height: 30, background: '#eee', flexShrink: 0 }} />
                <div style={{ flex: 1, display: 'flex', gap: 6, minWidth: 0 }}>
                  <MiniMetric label="头部" value={hasPose ? latestResult?.head_angle : undefined} unit="°" warn={5} />
                  <MiniMetric label="肩部" value={hasPose ? latestResult?.shoulder_diff : undefined} unit="%" warn={4} />
                  <MiniMetric label="脊柱" value={hasPose ? latestResult?.spine_angle : undefined} unit="°" warn={10} />
                </div>
              </div>
            ) : (
              /* ---- 练习模式：倒计时 + 动作 + 进度 + 评分，同样压成一条 ---- */
              <div style={{
                display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0,
                background: '#fff', borderRadius: 12, padding: '8px 12px',
                boxShadow: '0 1px 8px rgba(0,0,0,0.06)',
              }}>
                <div style={{ position: 'relative', width: 46, height: 46, flexShrink: 0 }}>
                  <svg width={46} height={46} style={{ transform: 'rotate(-90deg)' }}>
                    <circle cx={23} cy={23} r={19} fill="none" stroke="#eee" strokeWidth={4} />
                    <circle
                      cx={23} cy={23} r={19} fill="none"
                      stroke={exTimeLeft <= 3 ? '#EF5350' : '#4CAF50'}
                      strokeWidth={4} strokeLinecap="round"
                      strokeDasharray={2 * Math.PI * 19}
                      strokeDashoffset={2 * Math.PI * 19 * (1 - exTimeLeft / exercises[exCurrent].duration)}
                      style={{ transition: 'stroke-dashoffset 1s linear, stroke 0.3s' }}
                    />
                  </svg>
                  <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <span style={{ fontSize: 17, fontWeight: 800, color: exTimeLeft <= 3 ? '#EF5350' : '#2E7D32' }}>{exTimeLeft}</span>
                  </div>
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{
                    fontSize: 14, fontWeight: 700, color: '#333', lineHeight: 1.3,
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  }}>{exercises[exCurrent].icon} {exercises[exCurrent].name}</p>
                  <p style={{
                    fontSize: 11, color: '#888', lineHeight: 1.35,
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  }}>{exercises[exCurrent].hint}</p>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
                    <div style={{ flex: 1, height: 4, background: '#eee', borderRadius: 2, overflow: 'hidden' }}>
                      <div style={{
                        width: `${progress}%`, height: '100%', borderRadius: 2,
                        background: 'linear-gradient(90deg, #4CAF50, #81C784)',
                        transition: 'width 0.3s',
                      }} />
                    </div>
                    <span style={{ fontSize: 10, color: '#999', flexShrink: 0 }}>{exCurrent + 1}/{exercises.length}</span>
                  </div>
                </div>
                <ScoreGauge score={score} size={44} hasData={hasPose} />
              </div>
            )}

            {/* 问题提示已改为摄像头画面内的浮层（见 cameraPanel），
                不再作为摄像头之外的独立一行 —— 它出现/消失会改变摄像头高度导致画面跳动 */}

            {/* 摄像头：吃掉剩余高度 */}
            <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
              {cameraPanel}
              {/* 动作示意：放画面右上角并缩小。原来在右下角会和底部那排指标徽章重叠 */}
              {mode === 'exercise' && (
                <div style={{
                  position: 'absolute', right: 8, top: 8, zIndex: 11,
                  background: 'rgba(255,255,255,0.92)', borderRadius: 12, padding: 4,
                  boxShadow: '0 2px 12px rgba(0,0,0,0.2)',
                }}>
                  <ExerciseGuide exerciseIndex={exCurrent} color={exercises[exCurrent].color} size={72} />
                </div>
              )}
            </div>

            {mode === 'monitor' ? (
              <button
                onClick={startExercise}
                style={{
                  width: '100%', padding: '12px 0', borderRadius: 12, border: 'none',
                  background: 'linear-gradient(135deg, #4CAF50 0%, #81C784 100%)',
                  color: '#fff', cursor: 'pointer', fontSize: 16, fontWeight: 700,
                  boxShadow: '0 4px 20px rgba(76,175,80,0.35)', letterSpacing: 2,
                  flexShrink: 0,
                }}
              >
                🧘 开 始 活 动
              </button>
            ) : (
              <div style={{ display: 'flex', gap: 10, flexShrink: 0 }}>
                <button onClick={skipCurrent} style={{
                  flex: 1, padding: '11px 16px', borderRadius: 10,
                  border: '1px solid #e0e0e0', background: '#fff',
                  color: '#666', cursor: 'pointer', fontSize: 14, fontWeight: 500,
                }}>跳过当前</button>
                <button onClick={endExercise} style={{
                  flex: 1, padding: '11px 16px', borderRadius: 10,
                  border: '1px solid #FFCDD2', background: '#fff',
                  color: '#EF5350', cursor: 'pointer', fontSize: 14, fontWeight: 500,
                }}>结束活动</button>
              </div>
            )}
          </>
        )}
      </div>
    )
  }

  // ==================== 桌面端：左画面 + 右侧栏 ====================
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h2 style={{ fontSize: 24, fontWeight: 700 }}>🧘 肩颈活动</h2>
        {cameraError && (
          <button onClick={() => startCamera()} style={{
            padding: '10px 24px', borderRadius: 8, border: 'none',
            background: '#4CAF50', color: '#fff', cursor: 'pointer',
            fontSize: 14, fontWeight: 600,
          }}>重试摄像头</button>
        )}
      </div>

      <div style={{ display: 'flex', gap: 16, height: 570 }}>
        {cameraPanel}

        {/* Right panel */}
        <div style={{ width: 300, minWidth: 300, height: '100%', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 12, overflow: 'auto' }}>
          {mode === 'monitor' ? (
            <>
              {/* Score card */}
              <div style={{ background: '#fff', borderRadius: 12, padding: '16px 16px 14px', boxShadow: '0 1px 8px rgba(0,0,0,0.06)', textAlign: 'center', flexShrink: 0 }}>
                <p style={{ fontSize: 12, color: '#999', marginBottom: 10, fontWeight: 600, letterSpacing: 1 }}>实时评分</p>
                <div style={{ display: 'flex', justifyContent: 'center' }}>
                  <ScoreGauge score={score} size={100} hasData={hasPose} />
                </div>
                <p style={{ marginTop: 8, fontSize: 13, fontWeight: 600, color: scoreColor }}>
                  {score > 0 ? scoreLabel : '等待数据...'}
                </p>
              </div>

              {/* Metrics */}
              <div style={{ background: '#fff', borderRadius: 12, padding: '14px 16px', boxShadow: '0 1px 8px rgba(0,0,0,0.06)', flex: 1, minHeight: 0 }}>
                <p style={{ fontSize: 12, color: '#999', marginBottom: 10, fontWeight: 600, letterSpacing: 1 }}>检测指标</p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <MetricRow icon="↕" label="头部侧倾角" value={latestResult?.type === 'pose' ? `${latestResult.head_angle?.toFixed(1)}°` : '--'} warn={latestResult?.type === 'pose' ? (latestResult.head_angle ?? 0) > 5 : false} okRange="≤5°" />
                  <MetricRow icon="⇔" label="肩部高度差" value={latestResult?.type === 'pose' ? `${latestResult.shoulder_diff?.toFixed(1)}%` : '--'} warn={latestResult?.type === 'pose' ? (latestResult.shoulder_diff ?? 0) > 4 : false} okRange="≤4%" />
                  <MetricRow icon="↻" label="脊柱倾斜角" value={latestResult?.type === 'pose' ? `${latestResult.spine_angle?.toFixed(1)}°` : '--'} warn={latestResult?.type === 'pose' ? (latestResult.spine_angle ?? 0) > 10 : false} okRange="≤10°" />
                </div>
              </div>

              {/* Issues */}
              <AnimatePresence>
                {issues.length > 0 && (
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    style={{ background: '#FFF5F5', borderRadius: 12, padding: '10px 14px', boxShadow: '0 1px 8px rgba(0,0,0,0.06)', border: '1px solid #FFCDD2', flexShrink: 0 }}
                  >
                    <p style={{ fontSize: 12, fontWeight: 600, color: '#C62828', marginBottom: 6 }}>⚠ 检测到问题</p>
                    {issues.map((issue, i) => (
                      <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 0' }}>
                        <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#EF5350', flexShrink: 0 }} />
                        <span style={{ fontSize: 13, color: '#C62828' }}>{issue}</span>
                      </div>
                    ))}
                  </motion.div>
                )}
              </AnimatePresence>
            </>
          ) : (
            <ExercisePanel state={exState} onSkipCurrent={skipCurrent} onEndExercise={endExercise} />
          )}
          </div>

          {/* Start exercise button (only in monitor mode) */}
          {mode === 'monitor' && (
            <button
              onClick={startExercise}
              style={{
                width: '100%', padding: '14px 0', borderRadius: 12, border: 'none',
                background: 'linear-gradient(135deg, #4CAF50 0%, #81C784 100%)',
                color: '#fff', cursor: 'pointer', fontSize: 16, fontWeight: 700,
                boxShadow: '0 4px 20px rgba(76,175,80,0.35)', letterSpacing: 2,
              }}
            >
              🧘 开 始 活 动
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function MiniMetric({ label, value, unit, warn }: {
  label: string; value: number | undefined; unit: string; warn: number
}) {
  const has = value !== undefined
  const bad = has && (value as number) > warn
  return (
    <div style={{
      flex: 1, minWidth: 0, textAlign: 'center',
      background: bad ? '#FFF5F5' : '#F7F8FA',
      borderRadius: 8, padding: '3px 2px',
      transition: 'background 0.3s',
    }}>
      <p style={{ fontSize: 10, color: '#999', lineHeight: 1.3 }}>{label}</p>
      <p style={{
        fontSize: 13, fontWeight: 700, fontVariantNumeric: 'tabular-nums',
        color: bad ? '#EF5350' : '#333', lineHeight: 1.3,
      }}>{has ? `${(value as number).toFixed(1)}${unit}` : '--'}</p>
    </div>
  )
}

function MetricRow({ icon, label, value, warn, okRange }: {
  icon: string; label: string; value: string; warn: boolean; okRange: string
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '8px 10px', borderRadius: 8,
      background: warn ? '#FFF5F5' : 'transparent',
      transition: 'background 0.3s',
    }}>
      <span style={{ fontSize: 16, opacity: 0.6 }}>{icon}</span>
      <span style={{ flex: 1, fontSize: 12, color: '#666' }}>{label}</span>
      <span style={{ fontSize: 14, fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: warn ? '#EF5350' : '#333' }}>{value}</span>
      <span style={{ fontSize: 11, color: '#bbb', minWidth: 32, textAlign: 'right' }}>{okRange}</span>
    </div>
  )
}

function MetricBadge({ label, value, unit, warn, critical, compact }: {
  label: string; value: number | undefined; unit: string; warn: number; critical: number; compact?: boolean
}) {
  const num = value ?? 0
  const hasValue = value !== undefined
  const status = !hasValue ? 'none' : num > critical ? 'danger' : num > warn ? 'warn' : 'ok'
  const bg = status === 'danger' ? 'rgba(239,83,80,0.85)' : status === 'warn' ? 'rgba(255,167,38,0.85)' : 'rgba(0,0,0,0.65)'
  const border = status === 'danger' ? 'rgba(239,83,80,0.5)' : status === 'warn' ? 'rgba(255,167,38,0.5)' : 'rgba(255,255,255,0.1)'

  return (
    <div style={{
      background: bg, backdropFilter: 'blur(8px)', borderRadius: 10,
      padding: compact ? '5px 4px' : '8px 16px',
      textAlign: 'center',
      // 紧凑模式：不给最小宽度，交给 flex 等分，否则三个徽章总宽会超出手机画面
      minWidth: compact ? 0 : 80,
      flex: compact ? 1 : undefined,
      border: `1px solid ${border}`,
      transition: 'background 0.3s, border-color 0.3s',
    }}>
      <p style={{
        fontSize: compact ? 9 : 10, color: 'rgba(255,255,255,0.7)',
        marginBottom: compact ? 1 : 3, whiteSpace: 'nowrap',
      }}>{label}</p>
      <p style={{
        fontSize: compact ? 14 : 18, fontWeight: 700, color: '#fff',
        fontVariantNumeric: 'tabular-nums', lineHeight: 1.25,
      }}>{hasValue ? `${num.toFixed(1)}${unit}` : '--'}</p>
    </div>
  )
}

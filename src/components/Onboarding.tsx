import { useCallback, useEffect, useMemo, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { isMobile } from '../platform/runtime'
import { markOnboardingDone, onboardingSteps } from '../platform/onboarding'

/**
 * 新手引导遮罩（首次打开时显示一次）。
 *
 * ## 它是什么，不是什么
 *
 * 是**上手说明**：四步把"这个应用怎么用"讲完，允许随时跳过。
 * 不是更新公告，也不是强制教程 —— 不要求用户真的开一次摄像头（那会把人挡在门外，
 * 且无头环境验不了）。所以它只读文案 + 一个进度点，唯一的副作用是关掉时落一次标志。
 *
 * ## 与其他遮罩的关系
 *
 * `zIndex` 高于提醒弹窗（`App.tsx` 里是 100）——两个遮罩同时出现等于让人在两个
 * 都关不掉的层之间猜。协调逻辑在 `App.tsx`：引导开着时**不渲染**提醒弹窗，
 * 引导关掉后若提醒仍待处理，它自己会再出现。
 *
 * ## 显隐由 `open` 控制，不是条件挂载
 *
 * 父级**常驻**渲染本组件。条件挂载（`{open && <Onboarding/>}`）会让这里的
 * `AnimatePresence` 跟着一起卸载，退场动画永远不播（遮罩一闪就没了）。
 *
 * ## 守卫怎么找到它
 *
 * 根节点挂 `data-ng="onboarding"`。`verify-ui-smoke.mjs` 靠这个属性判断
 * 「引导出现了 / 消失了」——比按文案找稳（文案会改、会在别处出现）。
 * 步骤标题（`h2`）的内容则用来断言"点击确实前进了"，两者缺一不可：
 * 只有前者会漏掉"卡在第 1 步不动"，只有后者会漏掉"该关的时候没关"。
 *
 * ## 「立即试一次」（v1.7.2）
 *
 * 最后一步除「开始使用」外多一个出口：关掉引导**并直接进第一个动作**。
 * 为什么要有它：引导该交付的不是"读完了"，而是"**第一次成功做一次**"——
 * 走完四步却还要自己去首页找「开始活动」，是最常见的断点。
 *
 * 🔴 触发动作**不由本组件做**：它只调 `onStartExercise`（`App.tsx` 里实现）。
 *    链接是由上往下传的（`Onboarding` 不认识路由、不认识 `dataLayer`），
 *    这样"从提醒弹窗开始"和"从引导开始"走的是**同一条**启动路径 ——
 *    两份实现必然分叉，而分叉的表现是"从引导进去时少了 beginBreak"这类**只在某条路上才有的缺陷**。
 * ⚠️ 没有 `onStartExercise` 时**不渲染**这个按钮（组件在别处被单独使用时不该多一个死按钮）。
 */
export default function Onboarding({
  open,
  onDone,
  onStartExercise,
}: {
  open: boolean
  onDone: () => void
  /** 「立即试一次」：关引导 + 直接进第一个动作。缺省时不渲染该出口。 */
  onStartExercise?: () => void
}) {
  const steps = useMemo(() => onboardingSteps(), [])
  const [step, setStep] = useState(0)
  const last = step === steps.length - 1
  const current = steps[step]

  /**
   * 每次**打开**都从第 1 步开始。
   *
   * `step` 是本组件的内部状态，而关闭走的是 `open=false`（不是卸载）——
   * 少了这一步，设置页「重新查看新手引导」会**停在上次走到的步骤**上。
   */
  useEffect(() => {
    if (open) setStep(0)
  }, [open])

  /**
   * 结束引导（走完最后一步 或 跳过）。两条出口都落标志 ——
   * "跳过了但没记下来"会让它下次启动再弹一次，用户会以为自己点了个假的跳过。
   */
  const finish = useCallback(() => {
    markOnboardingDone()
    onDone()
  }, [onDone])

  /**
   * 「立即试一次」——先关引导（落标志、遮罩消失），再交给父级去启动活动。
   *
   * ⚠️ 顺序不能反：`onStartExercise` 会 `navigate('/')`，
   *    而遮罩是**常驻渲染**的（父级用 `open` 控制显隐），先跳路由再关也行，
   *    但先关能让"遮罩消失"与"进入练习模式"这两件事在观感上分开，
   *    免得用户看到遮罩底下先闪一下练习界面。
   */
  const startNow = useCallback(() => {
    finish()
    onStartExercise?.()
  }, [finish, onStartExercise])

  // Esc 跳过：遮罩类界面不给键盘出口，用键盘的人就只能一路点到底。
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') finish()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, finish])

  const mobile = isMobile()

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          data-ng="onboarding"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(15,23,32,0.62)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 300,
            padding: mobile
              ? 'calc(16px + env(safe-area-inset-top)) 16px calc(16px + env(safe-area-inset-bottom))'
              : 24,
          }}
        >
          <motion.div
            key={step}
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ type: 'spring', stiffness: 320, damping: 26 }}
            style={{
              background: 'var(--bg-card)',
              borderRadius: mobile ? 20 : 24,
              padding: mobile ? '28px 22px 22px' : '36px 40px 28px',
              maxWidth: mobile ? 420 : 520,
              width: '100%',
              boxShadow: '0 24px 70px rgba(0,0,0,0.32)',
              border: '1px solid var(--border)',
              display: 'flex',
              flexDirection: 'column',
              // 🔴 小屏（375×667 这类）上第 4 步的文字最多，卡片会比视口还高 ——
              //    没有这两条，底部的主按钮会被推到屏幕外，**用户根本点不到「开始使用」**，
              //    而且遮罩挡着底层、页面又不能滚，直接卡死在引导里。
              //    （`verify-ui-smoke.mjs` 会把视口压到 375×340 断言卡片仍被限制在视口内且可滚动。）
              maxHeight: '100%',
              overflowY: 'auto',
            }}
          >
            <div
              style={{
                width: mobile ? 58 : 68,
                height: mobile ? 58 : 68,
                borderRadius: '50%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: mobile ? 28 : 32,
                marginBottom: 18,
                background: `${current.accent}1A`,
                border: `2px solid ${current.accent}40`,
              }}
            >
              {current.icon}
            </div>

            <h2 style={{ fontSize: mobile ? 20 : 23, fontWeight: 800, color: 'var(--text)', marginBottom: 14 }}>
              {current.title}
            </h2>

            {/* 示意图（按 `step.visual` 选，组件不认识"第几步"）—— 放在正文**之前**：
                这一步的正文是"落进画面"，图先给出"该占多大"的判据，正文再解释怎么做到。 */}
            {current.visual === 'framing' && <FramingDiagram color={current.accent} />}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minHeight: mobile ? 96 : 104 }}>
              {current.lines.map((line, i) => (
                <p
                  key={i}
                  style={{
                    fontSize: mobile ? 13.5 : 14,
                    lineHeight: 1.75,
                    color: 'var(--text-secondary)',
                  }}
                >
                  {line}
                </p>
              ))}
            </div>

            {/* 进度点：既是给用户的位置感，也是"当前第几步"的一条可断言证据 */}
            <div
              data-ng="onboarding-dots"
              data-ng-step={step}
              style={{ display: 'flex', gap: 6, margin: '22px 0 20px', alignItems: 'center' }}
            >
              {steps.map((s, i) => (
                <div
                  key={i}
                  style={{
                    width: i === step ? 20 : 7,
                    height: 7,
                    borderRadius: 4,
                    background: i === step ? current.accent : 'var(--border)',
                    transition: 'all 0.25s ease',
                  }}
                />
              ))}
              <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-secondary)' }}>
                {step + 1} / {steps.length}
              </span>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              {/* 最后一步不再显示「跳过」：那时"跳过"和"开始使用"是同一个动作，
                  两个按钮做同一件事只会让人犹豫。 */}
              {!last && (
                <button onClick={finish} style={ghostButtonStyle}>
                  跳过
                </button>
              )}
              {step > 0 && (
                <button onClick={() => setStep((s) => Math.max(0, s - 1))} style={ghostButtonStyle}>
                  上一步
                </button>
              )}
              <button
                onClick={() => (last ? finish() : setStep((s) => s + 1))}
                style={{
                  marginLeft: 'auto',
                  padding: '11px 26px',
                  borderRadius: 12,
                  border: 'none',
                  background: `linear-gradient(135deg, ${current.accent} 0%, ${current.accent}D9 100%)`,
                  color: '#fff',
                  fontSize: 14,
                  fontWeight: 700,
                  cursor: 'pointer',
                  boxShadow: `0 6px 18px ${current.accent}55`,
                }}
              >
                {last ? '开始使用' : '下一步'}
              </button>
            </div>

            {/* 「立即试一次」——只在最后一步、且父级给了回调时出现。
                ⚠️ 它**不是**「开始使用」的重复：后者只关掉引导，这个会直接进第一个动作。
                   与上面那条"最后一步不显示「跳过」"的理由不冲突 —— 被去掉的是**同义**按钮，
                   这里留下的是**不同结局**的出口。 */}
            {last && onStartExercise && (
              <button
                data-ng="onboarding-start-now"
                onClick={startNow}
                style={{
                  marginTop: 12,
                  width: '100%',
                  padding: '12px 0',
                  borderRadius: 12,
                  border: `1px solid ${current.accent}55`,
                  background: `${current.accent}14`,
                  color: current.accent,
                  fontSize: 14,
                  fontWeight: 700,
                  cursor: 'pointer',
                }}
              >
                ▶ 立即试一次
              </button>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

const ghostButtonStyle: React.CSSProperties = {
  padding: '11px 18px',
  borderRadius: 12,
  border: '1px solid var(--border)',
  background: 'transparent',
  color: 'var(--text-secondary)',
  fontSize: 14,
  fontWeight: 600,
  cursor: 'pointer',
}

/**
 * 取景示意（只给第 2 步用）。
 *
 * 为什么必须有：这一步的正文说"让头和两侧肩膀都落进画面"，但**没有一个新用户
 * 知道那意味着多远** —— 实测最常见的卡点是"坐太远，画面里只有一个很小的自己"，
 * 然后在练习里一路被判"没检测到动作"。文案给的是**距离**判据（一臂远），
 * 这张图给的是**占画面比例**判据，两者缺一个都会卡住人。
 *
 * 🔴 **纯图元，一个 `<text>` 都不要放**：引导段的守卫读的是 `root.innerText`
 *    （见 `verify-ui-smoke.mjs` 的 `readStep`），图里出现文字会被算进"第 2 步正文"，
 *    参与"形态措辞对不对"那几条断言 —— 那不是这张图该负责的东西，
 *    而且以后改图里一个字就会莫名其妙地弄红那几条。
 * 🔴 挂在 `data-ng="onboarding-framing"` 上，守卫要能断言"**锚点读得到**"
 *    （铁律 #70：读界面上的东西必须先证明锚点在，否则这张图被删掉时
 *    相关断言会静默空转，而不是报错）。
 * ⚠️ 颜色**不用主题变量**：卡片底色两端不同（深/浅），而这张图是"半透明强调色 + 描边"，
 *    在两种底色上可读性一致 —— 与 `ExerciseGuide` 同一套取色方式。
 */
function FramingDiagram({ color }: { color: string }) {
  /** 强调色 + 十六进制透明度后缀（`'12'` / `'55'` / `'CC'`）—— 与 `ExerciseGuide` 同套写法。 */
  const line = (o: string) => `${color}${o}`
  /** 人形各部件共用：一抹半透明填充 + 描边，和 `ExerciseGuide` 的观感保持一致。 */
  const person = { fill: 'none', stroke: line('CC'), strokeWidth: 3, strokeLinecap: 'round' as const }

  return (
    <div
      data-ng="onboarding-framing"
      style={{
        margin: '2px 0 16px',
        display: 'flex',
        justifyContent: 'center',
      }}
    >
      <svg width="100%" height="132" viewBox="0 0 220 132" role="img" aria-label="取景示意：头和两侧肩膀都要落在画面里">
        {/* 取景框 = 摄像头画面 */}
        <rect
          x="6" y="6" width="208" height="120" rx="10"
          fill={line('12')} stroke={line('55')} strokeWidth="2" strokeDasharray="6 5"
        />
        {/* 头顶安全区：贴着上边缘会被切掉 */}
        <line x1="6" y1="34" x2="214" y2="34" stroke={line('33')} strokeWidth="1.5" strokeDasharray="3 4" />
        {/* 人形：头 + 颈 + 双肩 + 躯干 */}
        <circle cx="110" cy="52" r="17" {...person} />
        <line x1="110" y1="69" x2="110" y2="76" {...person} />
        <line x1="78" y1="80" x2="142" y2="80" {...person} />
        <line x1="78" y1="80" x2="78" y2="116" {...person} />
        <line x1="142" y1="80" x2="142" y2="116" {...person} />
        <line x1="110" y1="76" x2="110" y2="120" {...person} />
      </svg>
    </div>
  )
}

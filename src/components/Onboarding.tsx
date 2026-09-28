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
 */
export default function Onboarding({ open, onDone }: { open: boolean; onDone: () => void }) {
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

import { useCallback, useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { useAI } from '../hooks/useAI'
import Markdown from './Markdown'

interface Props {
  /** 组装本次分析请求体的回调，返回 null 表示数据尚不完整。 */
  buildPayload: () => Record<string, unknown> | null
}

/**
 * AI 肩颈分析面板：调用 DeepSeek 生成结构化分析报告。
 * 未配置 / 调用失败时给出明确引导，不影响其余功能。
 */
export default function AIAnalysisPanel({ buildPayload }: Props) {
  const { loading, fetchConfig, analyze } = useAI()
  const [configured, setConfigured] = useState<boolean | null>(null)
  const [report, setReport] = useState('')
  const [model, setModel] = useState('')
  const [error, setError] = useState('')
  const [hasRun, setHasRun] = useState(false)

  useEffect(() => {
    fetchConfig()
      .then((cfg) => setConfigured(cfg.usable))
      .catch(() => setConfigured(false))
  }, [fetchConfig])

  const run = useCallback(async () => {
    setError('')
    setReport('')
    const payload = buildPayload()
    if (!payload) {
      setError('当前数据不足，请先在"肩颈活动"页面开启摄像头进行一段检测。')
      return
    }
    const res = await analyze(payload)
    setHasRun(true)
    if (res.source === 'ai' && res.report) {
      setReport(res.report)
      setModel(res.model || '')
    } else {
      setError(res.error || 'AI 分析暂不可用。')
    }
  }, [analyze, buildPayload])

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.2 }}
      style={{
        background: 'linear-gradient(145deg, #F1F8E9 0%, #FFFFFF 60%)',
        borderRadius: 14, padding: '20px 24px',
        boxShadow: '0 1px 8px rgba(0,0,0,0.06)', border: '1px solid #DCEDC8',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 18 }}>🤖</span>
          <p style={{ fontSize: 14, fontWeight: 600, color: '#333' }}>AI 肩颈分析</p>
          {model && (
            <span style={{
              fontSize: 11, color: '#558B2F', background: '#DCEDC8',
              padding: '2px 8px', borderRadius: 10,
            }}>
              {model}
            </span>
          )}
        </div>
        <button
          onClick={run}
          disabled={loading || configured === false}
          style={{
            padding: '8px 20px', borderRadius: 10, border: 'none',
            background: configured === false ? '#ccc' : 'linear-gradient(135deg, #4CAF50 0%, #81C784 100%)',
            color: '#fff', cursor: loading || configured === false ? 'not-allowed' : 'pointer',
            fontSize: 13, fontWeight: 600, boxShadow: '0 2px 10px rgba(76,175,80,0.3)',
          }}
        >
          {loading ? '分析中…' : hasRun ? '重新分析' : '生成分析'}
        </button>
      </div>

      {configured === false && (
        <div style={{
          padding: '10px 14px', borderRadius: 8, background: '#FFF8E1',
          border: '1px solid #FFE082', fontSize: 13, color: '#E65100', lineHeight: 1.7,
        }}>
          尚未启用 AI 分析。请前往「系统设置」开启 AI 增强模式，并填入 DeepSeek API Key。
        </div>
      )}

      {error && (
        <div style={{
          padding: '10px 14px', borderRadius: 8, background: '#FFF3E0',
          border: '1px solid #FFCC80', fontSize: 13, color: '#E65100', lineHeight: 1.7,
        }}>
          {error}
        </div>
      )}

      {loading && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '16px 0', color: '#7CB342' }}>
          <div style={{
            width: 16, height: 16, borderRadius: '50%',
            border: '2px solid #DCEDC8', borderTopColor: '#4CAF50',
            animation: 'spin 1s linear infinite',
          }} />
          <span style={{ fontSize: 13 }}>正在请求 DeepSeek 生成分析…</span>
        </div>
      )}

      {!loading && report && (
        <div style={{ maxHeight: 420, overflow: 'auto' }}>
          <Markdown text={report} />
        </div>
      )}

      {!loading && !report && !error && configured !== false && (
        <p style={{ fontSize: 13, color: '#999', lineHeight: 1.8 }}>
          点击「生成分析」，让 AI 结合你的实时姿态与近期使用数据，给出个性化的肩颈健康评估与改善建议。
        </p>
      )}
    </motion.div>
  )
}

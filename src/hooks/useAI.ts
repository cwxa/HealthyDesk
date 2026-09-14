import { useState } from 'react'
import { useApi } from './useApi'

export interface AIConfig {
  enabled: boolean
  has_api_key: boolean
  api_key_masked: string
  base_url: string
  model: string
  usable: boolean
  available_models?: string[]
}

export interface AIAnalyzeResult {
  source: 'ai' | 'unavailable' | 'error'
  report?: string
  model?: string
  error?: string
}

export function useAI() {
  const { get, put, post } = useApi()
  const [loading, setLoading] = useState(false)

  const fetchConfig = () => get<AIConfig>('/api/ai/config')

  const saveConfig = (patch: {
    enabled?: boolean
    api_key?: string
    base_url?: string
    model?: string
  }) => put<AIConfig>('/api/ai/config', patch)

  const testConnection = () => post<{ ok: boolean; model?: string; error?: string }>(
    '/api/ai/test',
    {},
  )

  const analyze = async (payload: Record<string, unknown>): Promise<AIAnalyzeResult> => {
    setLoading(true)
    try {
      return await post<AIAnalyzeResult>('/api/ai/analyze', payload)
    } finally {
      setLoading(false)
    }
  }

  return { loading, fetchConfig, saveConfig, testConnection, analyze }
}

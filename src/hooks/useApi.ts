import { useState, useCallback } from 'react'

const BACKEND_URL = 'http://127.0.0.1:18920'

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BACKEND_URL}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  })
  if (!res.ok) {
    throw new Error(`API error: ${res.status} ${res.statusText}`)
  }
  return res.json()
}

export function useApi() {
  const [loading, setLoading] = useState(false)

  const get = useCallback(async <T>(path: string): Promise<T> => {
    setLoading(true)
    try {
      return await request<T>(path)
    } finally {
      setLoading(false)
    }
  }, [])

  const post = useCallback(async <T>(path: string, body: unknown): Promise<T> => {
    setLoading(true)
    try {
      return await request<T>(path, {
        method: 'POST',
        body: JSON.stringify(body),
      })
    } finally {
      setLoading(false)
    }
  }, [])

  const put = useCallback(async <T>(path: string, body: unknown): Promise<T> => {
    setLoading(true)
    try {
      return await request<T>(path, {
        method: 'PUT',
        body: JSON.stringify(body),
      })
    } finally {
      setLoading(false)
    }
  }, [])

  return { get, post, put, loading }
}

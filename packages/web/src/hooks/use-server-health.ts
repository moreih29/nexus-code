import { useState, useEffect, useRef } from 'react'

const BASE_URL = import.meta.env.VITE_API_URL ?? ''
const POLL_INTERVAL_MS = 10_000
const FAILURE_THRESHOLD = 3

export type ServerHealthStatus = 'healthy' | 'unhealthy' | 'unknown'

export function useServerHealth(): ServerHealthStatus {
  const [status, setStatus] = useState<ServerHealthStatus>('unknown')
  const consecutiveFailures = useRef(0)

  useEffect(() => {
    let disposed = false
    let timerId: ReturnType<typeof setTimeout> | null = null

    async function check() {
      if (disposed) return

      try {
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), 5_000)

        const res = await fetch(`${BASE_URL}/api/health`, { signal: controller.signal })
        clearTimeout(timeoutId)

        if (disposed) return

        if (res.ok) {
          consecutiveFailures.current = 0
          setStatus('healthy')
        } else {
          consecutiveFailures.current += 1
          if (consecutiveFailures.current >= FAILURE_THRESHOLD) {
            setStatus('unhealthy')
          }
        }
      } catch {
        if (disposed) return
        consecutiveFailures.current += 1
        if (consecutiveFailures.current >= FAILURE_THRESHOLD) {
          setStatus('unhealthy')
        }
      }

      if (!disposed) {
        timerId = setTimeout(check, POLL_INTERVAL_MS)
      }
    }

    void check()

    return () => {
      disposed = true
      if (timerId) clearTimeout(timerId)
    }
  }, [])

  return status
}

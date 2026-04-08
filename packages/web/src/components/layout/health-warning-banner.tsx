import { AlertTriangle } from 'lucide-react'
import { useServerHealth } from '../../hooks/use-server-health'

export function HealthWarningBanner() {
  const health = useServerHealth()

  if (health !== 'unhealthy') return null

  return (
    <div
      className="flex items-center gap-2 px-3 py-2 text-xs font-medium select-none shrink-0"
      style={{
        background: 'color-mix(in srgb, var(--orange) 15%, var(--bg-surface))',
        borderBottom: '1px solid color-mix(in srgb, var(--orange) 40%, transparent)',
        color: 'var(--orange)',
      }}
    >
      <AlertTriangle className="size-3.5 shrink-0" />
      <span>권한 제어가 비활성 상태입니다. 서버 연결을 확인해주세요.</span>
    </div>
  )
}

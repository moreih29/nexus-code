import type { MockPermissionRequest } from '../../mock/data.js'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu.js'

interface PermissionBlockProps {
  permission: MockPermissionRequest
}

type ApproveScope = 'once' | 'session' | 'permanent'

function getDetail(permission: MockPermissionRequest): string {
  if (permission.toolName === 'Bash' && typeof permission.toolInput.command === 'string') {
    return permission.toolInput.command
  }
  return JSON.stringify(permission.toolInput)
}

export function PermissionBlock({ permission }: PermissionBlockProps) {
  function handleApprove(scope: ApproveScope) {
    console.log('approve', scope)
  }

  function handleDeny() {
    console.log('deny', permission.id)
  }

  return (
    <div
      className="rounded-md p-3 flex flex-col gap-2"
      style={{
        background: 'rgba(210,153,34,0.08)',
        border: '1px solid rgba(210,153,34,0.30)',
      }}
    >
      <div className="flex items-center gap-1.5">
        <span style={{ color: 'var(--color-yellow, #d29922)' }} className="text-xs">⚠</span>
        <span
          className="text-xs font-semibold"
          style={{ color: 'var(--color-yellow, #d29922)' }}
        >
          권한 요청 — {permission.toolName} 실행
        </span>
      </div>

      <div
        className="rounded px-2 py-1.5 text-xs font-mono break-all"
        style={{ background: 'var(--bg-base)', color: 'var(--text-secondary)' }}
      >
        {getDetail(permission)}
      </div>

      <div className="flex items-center gap-2">
        {/* Split approve button */}
        <div className="flex" style={{ border: '1px solid rgba(63,185,80,0.40)', borderRadius: '6px', overflow: 'hidden' }}>
          <button
            onClick={() => handleApprove('once')}
            className="px-3 py-1 text-xs font-medium transition-colors hover:opacity-80"
            style={{ background: 'rgba(63,185,80,0.15)', color: 'var(--color-green, #3fb950)', borderRight: '1px solid rgba(63,185,80,0.40)' }}
          >
            승인
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className="px-1.5 py-1 text-xs transition-colors hover:opacity-80"
                style={{ background: 'rgba(63,185,80,0.15)', color: 'var(--color-green, #3fb950)' }}
              >
                ▾
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem onClick={() => handleApprove('once')}>
                이번만 승인
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleApprove('session')}>
                이 세션 동안 허용
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleApprove('permanent')}>
                영구 허용
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <button
          onClick={handleDeny}
          className="px-3 py-1 text-xs font-medium rounded transition-colors hover:opacity-80"
          style={{
            background: 'rgba(248,81,73,0.10)',
            border: '1px solid rgba(248,81,73,0.30)',
            color: 'var(--color-red, #f85149)',
            borderRadius: '6px',
          }}
        >
          거부
        </button>
      </div>
    </div>
  )
}

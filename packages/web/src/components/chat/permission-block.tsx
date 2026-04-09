import { useState } from 'react'
import type { PermissionRequestState } from '../../adapters/session-adapter.js'
import { useRespondApproval } from '../../hooks/use-approval.js'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu.js'

interface PermissionBlockProps {
  permission: PermissionRequestState
  reason?: string
  source?: 'bypass' | 'mode' | 'rule' | 'protected' | 'user'
  protectedHint?: string[]
}

type ApproveScope = 'once' | 'session' | 'permanent'

function getDetail(permission: PermissionRequestState): string {
  if (permission.toolName === 'Bash' && typeof permission.toolInput.command === 'string') {
    return permission.toolInput.command
  }
  return JSON.stringify(permission.toolInput)
}

const sourceBg: Record<string, string> = {
  mode: 'rgba(234,179,8,0.05)',
  protected: 'rgba(239,68,68,0.05)',
  rule: 'rgba(107,114,128,0.05)',
  user: 'rgba(59,130,246,0.05)',
  bypass: '',
}

const sourceDotColor: Record<string, string> = {
  mode: '#facc15',
  protected: '#ef4444',
  rule: '#6b7280',
  user: '#60a5fa',
}

export function PermissionBlock({
  permission,
  reason: reasonProp,
  source: sourceProp,
  protectedHint: protectedHintProp,
}: PermissionBlockProps) {
  const [responded, setResponded] = useState<'allow' | 'deny' | null>(null)
  const { mutate } = useRespondApproval()

  // Prefer props over permission object fields for flexibility
  const reason = reasonProp ?? permission.reason
  const source = sourceProp ?? permission.source
  const protectedHint = protectedHintProp ?? permission.protectedHint

  const isProtected = (protectedHint?.length ?? 0) > 0

  function handleApprove(scope: ApproveScope) {
    mutate(
      { id: permission.id, decision: 'allow', scope },
      {
        onSuccess: () => setResponded('allow'),
        onError: () => {
          console.log('approve', scope, permission.id)
          setResponded('allow')
        },
      },
    )
  }

  function handleDeny() {
    mutate(
      { id: permission.id, decision: 'deny' },
      {
        onSuccess: () => setResponded('deny'),
        onError: () => {
          console.log('deny', permission.id)
          setResponded('deny')
        },
      },
    )
  }

  const bgColor = isProtected
    ? 'rgba(239,68,68,0.08)'
    : source && source !== 'bypass'
      ? (sourceBg[source] ?? 'rgba(210,153,34,0.08)')
      : 'rgba(210,153,34,0.08)'

  const borderStyle = isProtected
    ? { borderLeft: '2px solid #ef4444', borderTop: '1px solid rgba(239,68,68,0.30)', borderRight: '1px solid rgba(239,68,68,0.30)', borderBottom: '1px solid rgba(239,68,68,0.30)' }
    : { border: '1px solid rgba(210,153,34,0.30)' }

  return (
    <div
      className="rounded-md p-3 flex flex-col gap-2"
      style={{
        background: bgColor,
        ...borderStyle,
      }}
    >
      {/* Header */}
      <div className="flex items-center gap-1.5">
        {/* Source color dot */}
        {source && source !== 'bypass' && (
          <span
            className="inline-block w-1.5 h-1.5 rounded-full flex-shrink-0"
            style={{ background: sourceDotColor[source] ?? '#d29922' }}
          />
        )}
        <span style={{ color: 'var(--color-yellow, #d29922)' }} className="text-xs">⚠</span>
        <span
          className="text-xs font-semibold"
          style={{ color: 'var(--color-yellow, #d29922)' }}
        >
          권한 요청 — {permission.toolName} 실행
        </span>
        {/* Protected badge */}
        {isProtected && (
          <span
            className="ml-auto text-[10px] font-medium px-1.5 py-0.5 rounded"
            style={{ background: 'rgba(239,68,68,0.15)', color: '#f87171' }}
          >
            🔒 보호 경로
          </span>
        )}
      </div>

      {/* Reason line */}
      {reason && (
        <div
          className="text-[10px] line-clamp-1 mt-0.5"
          style={{ color: 'var(--text-muted, #8b949e)' }}
          title={reason}
        >
          이유: {reason}
        </div>
      )}

      {/* Tool detail */}
      <div
        className="rounded px-2 py-1.5 text-xs font-mono break-all"
        style={{ background: 'var(--bg-base)', color: 'var(--text-secondary)' }}
      >
        {getDetail(permission)}
      </div>

      {responded !== null ? (
        <div
          className="px-3 py-1 text-xs font-medium rounded"
          style={{
            color: responded === 'allow' ? 'var(--color-green, #3fb950)' : 'var(--color-red, #f85149)',
          }}
        >
          {responded === 'allow' ? '승인됨' : '거부됨'}
        </div>
      ) : (
        <div className="flex items-center gap-2">
          {isProtected ? (
            /* Protected path: single once-only approve button */
            <div className="flex flex-col gap-1">
              <button
                onClick={() => handleApprove('once')}
                className="px-3 py-1 text-xs font-medium rounded transition-colors hover:opacity-80"
                style={{
                  background: 'rgba(63,185,80,0.15)',
                  border: '1px solid rgba(63,185,80,0.40)',
                  color: 'var(--color-green, #3fb950)',
                  borderRadius: '6px',
                }}
              >
                승인 (1회)
              </button>
              <span
                className="text-[9px]"
                style={{ color: 'var(--text-muted, #8b949e)' }}
              >
                보호 경로는 매번 확인합니다
              </span>
            </div>
          ) : (
            /* Normal path: split approve button with scope dropdown */
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
          )}

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
      )}
    </div>
  )
}

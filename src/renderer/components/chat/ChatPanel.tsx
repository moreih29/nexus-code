import log from 'electron-log/renderer'
import { useEffect, useMemo, useRef, useState } from 'react'

const rlog = log.scope('renderer:chat-panel')
import { AlignJustify, AlignLeft, List } from 'lucide-react'
import { IpcChannel } from '../../../shared/ipc'
import type { ImageAttachment } from '../../../shared/types'
import { Button } from '@renderer/components/ui/button'
import { useActiveSession } from '../../stores/session-store'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { useCheckpointStore } from '../../stores/checkpoint-store'
import { useSettingsStore, type ToolDensity } from '../../stores/settings-store'
import { ChatInput } from './ChatInput'
import { MessageBubble } from './MessageBubble'
import { StatusBar } from './StatusBar'
import { PermissionList } from '../permission/PermissionList'

const DENSITY_CYCLE: ToolDensity[] = ['compact', 'normal', 'verbose']
const DENSITY_ICONS = {
  compact: AlignLeft,
  normal: List,
  verbose: AlignJustify,
}
const DENSITY_LABELS = {
  compact: '간략',
  normal: '보통',
  verbose: '상세',
}

export function ChatPanel() {
  const sessionId = useActiveSession((s) => s.sessionId)
  const status = useActiveSession((s) => s.status)
  const messages = useActiveSession((s) => s.messages)
  const systemEvents = useActiveSession((s) => s.systemEvents)
  const startSession = useActiveSession((s) => s.startSession)
  const setStatus = useActiveSession((s) => s.setStatus)
  const addUserMessage = useActiveSession((s) => s.addUserMessage)
  const dismissTimeout = useActiveSession((s) => s.dismissTimeout)

  const activeWorkspace = useWorkspaceStore((s) => s.activeWorkspace)
  const saveSessionId = useWorkspaceStore((s) => s.saveSessionId)
  const { reset: resetCheckpoints } = useCheckpointStore()
  const permissionMode = useSettingsStore((s) => s.permissionMode)
  const toolDensity = useSettingsStore((s) => s.toolDensity)
  const setToolDensity = useSettingsStore((s) => s.setToolDensity)
  const notificationsEnabled = useSettingsStore((s) => s.notificationsEnabled)
  const bottomRef = useRef<HTMLDivElement>(null)
  const [isGitRepo, setIsGitRepo] = useState(true)

  // sorted 아이템 + checkpointRef 사전 계산 (messages/systemEvents 변경 시에만 재계산)
  type SortedItem =
    | { kind: 'message'; timestamp: number; data: (typeof messages)[number]; checkpointRef?: string }
    | { kind: 'event'; timestamp: number; data: (typeof systemEvents)[number]; checkpointRef?: undefined }

  const sortedWithCheckpoints = useMemo((): SortedItem[] => {
    const sorted: SortedItem[] = [
      ...messages.map((m) => ({ kind: 'message' as const, timestamp: m.timestamp, data: m, checkpointRef: undefined as string | undefined })),
      ...systemEvents.map((e) => ({ kind: 'event' as const, timestamp: e.timestamp, data: e, checkpointRef: undefined as undefined })),
    ].sort((a, b) => a.timestamp - b.timestamp)

    // 각 assistant 메시지의 checkpointRef 사전 계산
    let lastUserCheckpointRef: string | undefined
    for (const item of sorted) {
      if (item.kind === 'message') {
        if (item.data.role === 'user') {
          lastUserCheckpointRef = item.data.checkpointRef
        } else {
          item.checkpointRef = lastUserCheckpointRef
        }
      }
    }

    return sorted
  }, [messages, systemEvents])

  // Auto-scroll on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // 워크스페이스 변경 시 git 저장소 여부 확인
  useEffect(() => {
    if (!activeWorkspace) {
      setIsGitRepo(true)
      return
    }
    window.electronAPI
      .invoke(IpcChannel.GIT_CHECK, { cwd: activeWorkspace })
      .then((res) => setIsGitRepo(res.isGitRepo))
      .catch(() => setIsGitRepo(true))
  }, [activeWorkspace])

  const handleSend = async (text: string, images?: ImageAttachment[]): Promise<void> => {
    if (!activeWorkspace) {
      rlog.warn('워크스페이스가 선택되지 않음')
      return
    }

    // 프롬프트 전송 직전 체크포인트 생성 (git stash create)
    let checkpointRef: string | undefined
    const currentSessionId = sessionId
    if (currentSessionId) {
      try {
        const cpRes = await window.electronAPI.invoke(
          IpcChannel.CHECKPOINT_CREATE,
          { cwd: activeWorkspace, sessionId: currentSessionId }
        )
        if (cpRes.ok && cpRes.checkpoint?.hash) {
          checkpointRef = cpRes.checkpoint.hash
        }
      } catch (err) {
        rlog.warn('체크포인트 생성 실패:', err)
      }
    }

    addUserMessage(text, checkpointRef)
    setStatus('running')
    rlog.info('전송:', { text: text.slice(0, 50), cwd: activeWorkspace, sessionId: currentSessionId })

    try {
      if (!currentSessionId) {
        resetCheckpoints()
        const res = await window.electronAPI.invoke(IpcChannel.START, {
          prompt: text,
          cwd: activeWorkspace,
          permissionMode,
          notificationsEnabled,
          images,
        })
        rlog.info('세션 시작:', res.sessionId)
        startSession(res.sessionId)
        await saveSessionId(activeWorkspace, res.sessionId)
      } else {
        const res = await window.electronAPI.invoke(IpcChannel.PROMPT, {
          sessionId: currentSessionId,
          message: text,
          images,
        })
        if (!res.ok) {
          // 프로세스가 죽었음 → START + --resume로 자동 복구
          rlog.warn('PROMPT failed — resuming session:', currentSessionId)
          const resumed = await window.electronAPI.invoke(IpcChannel.START, {
            prompt: text,
            cwd: activeWorkspace,
            permissionMode,
            sessionId: currentSessionId,
            notificationsEnabled,
            images,
          })
          rlog.info('세션 복구:', resumed.sessionId)
          startSession(resumed.sessionId)
        }
      }
    } catch (err) {
      rlog.error('IPC error:', err)
      setStatus('idle')
    }
  }

  const handleStop = async (): Promise<void> => {
    if (!sessionId) return
    try {
      await window.electronAPI.invoke(IpcChannel.CANCEL, { sessionId })
    } catch (err) {
      rlog.error('cancel error:', err)
    }
    setStatus('idle')
  }

  const handleTimeoutCancel = async (): Promise<void> => {
    await handleStop()
  }

  const handleRetry = (): void => {
    const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user')
    if (lastUserMsg) {
      void handleSend(lastUserMsg.content)
    }
  }

  const handleGitInit = async (): Promise<void> => {
    if (!activeWorkspace) return
    try {
      const res = await window.electronAPI.invoke(IpcChannel.GIT_INIT, { cwd: activeWorkspace })
      if (res.ok) setIsGitRepo(true)
    } catch (err) {
      rlog.error('git init error:', err)
    }
  }

  const isInputDisabled = !activeWorkspace || status === 'waiting_permission' || status === 'timeout'
  const isRunning = status === 'running'

  return (
    <div className="flex h-full flex-col">
      {/* git 저장소 아님 배너 */}
      {!isGitRepo && (
        <div className="mx-4 mt-2 flex items-center justify-between rounded-lg border border-yellow-600/40 bg-yellow-900/20 px-4 py-3">
          <p className="text-sm text-yellow-300">
            ⚠ 이 폴더는 git 저장소가 아닙니다. 체크포인트와 퍼미션 기능을 사용하려면 초기화가 필요합니다.
          </p>
          <button
            onClick={() => void handleGitInit()}
            className="ml-4 shrink-0 rounded bg-yellow-700/60 px-3 py-1 text-xs text-yellow-100 hover:bg-yellow-700"
          >
            초기화
          </button>
        </div>
      )}

      {/* Density toggle */}
      <div className="flex shrink-0 items-center justify-end border-b border-border px-4 py-1.5">
        <button
          onClick={() => {
            const idx = DENSITY_CYCLE.indexOf(toolDensity)
            setToolDensity(DENSITY_CYCLE[(idx + 1) % DENSITY_CYCLE.length])
          }}
          className="flex items-center gap-1.5 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          title={DENSITY_LABELS[toolDensity]}
        >
          {(() => { const Icon = DENSITY_ICONS[toolDensity]; return <Icon size={14} /> })()}
          <span>{DENSITY_LABELS[toolDensity]}</span>
        </button>
      </div>

      {/* Message list */}
      <div className="flex-1 overflow-y-auto px-4 py-4">
        {messages.length === 0 && !isRunning && status !== 'error' ? (
          <div className="flex h-full items-center justify-center">
            <p className="text-sm text-dim-foreground">
              {activeWorkspace
                ? '메시지를 입력하여 세션을 시작하세요.'
                : '좌측에서 워크스페이스를 선택하세요.'}
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {sortedWithCheckpoints.map((item) => {
              if (item.kind === 'event') {
                return (
                  <div key={item.data.id} className="relative flex items-center py-1">
                    <div className="flex-1 border-t border-border" />
                    <span className="mx-2 shrink-0 bg-background px-2 text-xs text-muted-foreground">
                      {item.data.label}
                    </span>
                    <div className="flex-1 border-t border-border" />
                  </div>
                )
              }

              return (
                <MessageBubble
                  key={item.data.id}
                  message={item.data}
                  checkpointRef={item.checkpointRef}
                  isStreaming={
                    item.data.role === 'assistant' &&
                    item.data.id === messages[messages.length - 1]?.id &&
                    status === 'running'
                  }
                />
              )
            })}
            {/* 에러 CTA */}
            {status === 'error' && (
              <div className="flex items-center gap-3 rounded-lg border border-red-800/40 bg-red-950/30 px-4 py-3">
                <span className="text-sm text-red-300">오류가 발생했습니다.</span>
                <Button size="sm" variant="outline" onClick={handleRetry}>
                  재시도
                </Button>
              </div>
            )}
            <div ref={bottomRef} />
          </div>
        )}
      </div>

      {/* 타임아웃 알림 */}
      {status === 'timeout' && (
        <div className="mx-4 mb-2 flex items-center justify-between rounded-lg border border-yellow-600/40 bg-yellow-900/20 px-4 py-3">
          <p className="text-sm text-yellow-300">
            응답 없음 — CLI가 2분 이상 반응하지 않습니다.
          </p>
          <div className="flex gap-2">
            <button
              onClick={dismissTimeout}
              className="rounded px-3 py-1 text-xs text-yellow-300 hover:bg-yellow-800/40"
            >
              계속 대기
            </button>
            <button
              onClick={handleTimeoutCancel}
              className="rounded bg-yellow-700/60 px-3 py-1 text-xs text-yellow-100 hover:bg-yellow-700"
            >
              취소
            </button>
          </div>
        </div>
      )}

      {/* 퍼미션 카드: 입력창 위 */}
      <PermissionList />

      {/* StatusBar: 메시지 목록과 입력창 사이 */}
      <StatusBar />

      {/* Input */}
      <ChatInput onSend={handleSend} onStop={handleStop} disabled={isInputDisabled} isRunning={isRunning} />
    </div>
  )
}

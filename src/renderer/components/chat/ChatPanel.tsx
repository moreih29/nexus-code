import log from 'electron-log/renderer'
import { useEffect, useRef, useState } from 'react'
import { IpcChannel } from '../../../shared/ipc'
import type { StartResponse, PromptResponse, CancelResponse, GitCheckResponse, GitInitResponse, ImageAttachment } from '../../../shared/types'
import { Button } from '@renderer/components/ui/button'
import { useSessionStore } from '../../stores/session-store'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { useCheckpointStore } from '../../stores/checkpoint-store'
import { useSettingsStore } from '../../stores/settings-store'
import { ChatInput } from './ChatInput'
import { CheckpointBar } from './CheckpointBar'
import { MessageBubble } from './MessageBubble'
import { StatusBar } from './StatusBar'
import { PermissionList } from '../permission/PermissionList'

export function ChatPanel() {
  const {
    sessionId,
    status,
    messages,
    systemEvents,
    startSession,
    setStatus,
    addUserMessage,
    dismissTimeout,
  } = useSessionStore()

  const activeWorkspace = useWorkspaceStore((s) => s.activeWorkspace)
  const saveSessionId = useWorkspaceStore((s) => s.saveSessionId)
  const { setCheckpoint, listCheckpoints, reset: resetCheckpoints } = useCheckpointStore()
  const permissionMode = useSettingsStore((s) => s.permissionMode)
  const notificationsEnabled = useSettingsStore((s) => s.notificationsEnabled)
  const bottomRef = useRef<HTMLDivElement>(null)
  const [isGitRepo, setIsGitRepo] = useState(true)

  // Auto-scroll on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // timeout IPC 이벤트 수신
  useEffect(() => {
    const onTimeout = (): void => {
      setStatus('timeout')
    }
    window.electronAPI.on(IpcChannel.TIMEOUT, onTimeout)
    return () => {
      window.electronAPI.off(IpcChannel.TIMEOUT, onTimeout)
    }
  }, [setStatus])

  // 워크스페이스 변경 시 git 저장소 여부 확인
  useEffect(() => {
    if (!activeWorkspace) {
      setIsGitRepo(true)
      return
    }
    window.electronAPI
      .invoke<GitCheckResponse>(IpcChannel.GIT_CHECK, { cwd: activeWorkspace })
      .then((res) => setIsGitRepo(res.isGitRepo))
      .catch(() => setIsGitRepo(true))
  }, [activeWorkspace])

  const handleSend = async (text: string, images?: ImageAttachment[]): Promise<void> => {
    if (!activeWorkspace) {
      log.warn('[ChatPanel] 워크스페이스가 선택되지 않음')
      return
    }

    addUserMessage(text)
    setStatus('running')
    log.info('[ChatPanel] 전송:', { text: text.slice(0, 50), cwd: activeWorkspace, sessionId })

    try {
      if (!sessionId) {
        resetCheckpoints()
        const res = await window.electronAPI.invoke<StartResponse>(IpcChannel.START, {
          prompt: text,
          cwd: activeWorkspace,
          permissionMode,
          notificationsEnabled,
          images,
        })
        log.info('[ChatPanel] 세션 시작:', res.sessionId)
        startSession(res.sessionId)
        await saveSessionId(activeWorkspace, res.sessionId)
        if (res.checkpoint) {
          setCheckpoint(res.checkpoint)
        }
      } else {
        const res = await window.electronAPI.invoke<PromptResponse>(IpcChannel.PROMPT, {
          sessionId,
          message: text,
          images,
        })
        // 기존 세션: 체크포인트 미로드 상태면 조회
        if (useCheckpointStore.getState().checkpoints.length === 0 && activeWorkspace) {
          void listCheckpoints(activeWorkspace, sessionId)
        }
        if (!res.ok) {
          // 프로세스가 죽었음 → START + --resume로 자동 복구
          log.warn('[ChatPanel] PROMPT failed — resuming session:', sessionId)
          const resumed = await window.electronAPI.invoke<StartResponse>(IpcChannel.START, {
            prompt: text,
            cwd: activeWorkspace,
            permissionMode,
            sessionId,
            notificationsEnabled,
            images,
          })
          log.info('[ChatPanel] 세션 복구:', resumed.sessionId)
          startSession(resumed.sessionId)
          if (resumed.checkpoint) {
            setCheckpoint(resumed.checkpoint)
          }
        }
      }
    } catch (err) {
      log.error('[ChatPanel] IPC error:', err)
      setStatus('idle')
    }
  }

  const handleStop = async (): Promise<void> => {
    if (!sessionId) return
    try {
      await window.electronAPI.invoke<CancelResponse>(IpcChannel.CANCEL, { sessionId })
    } catch (err) {
      log.error('[ChatPanel] cancel error:', err)
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
      const res = await window.electronAPI.invoke<GitInitResponse>(IpcChannel.GIT_INIT, { cwd: activeWorkspace })
      if (res.ok) setIsGitRepo(true)
    } catch (err) {
      log.error('[ChatPanel] git init error:', err)
    }
  }

  const isInputDisabled = !activeWorkspace || status === 'waiting_permission' || status === 'timeout'
  const isRunning = status === 'running'

  return (
    <div className="flex h-full flex-col">
      {/* git 저장소 아님 배너 / 체크포인트 바 */}
      {!isGitRepo ? (
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
      ) : (
        <CheckpointBar />
      )}

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
            {[
              ...messages.map((m) => ({ kind: 'message' as const, timestamp: m.timestamp, data: m })),
              ...systemEvents.map((e) => ({ kind: 'event' as const, timestamp: e.timestamp, data: e })),
            ]
              .sort((a, b) => a.timestamp - b.timestamp)
              .map((item) =>
                item.kind === 'message' ? (
                  <MessageBubble key={item.data.id} message={item.data} />
                ) : (
                  <div key={item.data.id} className="relative flex items-center py-1">
                    <div className="flex-1 border-t border-border" />
                    <span className="mx-2 shrink-0 bg-background px-2 text-xs text-muted-foreground">
                      {item.data.label}
                    </span>
                    <div className="flex-1 border-t border-border" />
                  </div>
                )
              )}
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

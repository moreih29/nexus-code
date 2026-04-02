import log from 'electron-log/renderer'
import { useEffect, useMemo, useRef, useState } from 'react'

const rlog = log.scope('renderer:chat-panel')
import { AlignJustify, AlignLeft, List, Hexagon } from 'lucide-react'
import { IpcChannel } from '../../../shared/ipc'
import type { ImageAttachment, AgentTimelineData } from '../../../shared/types'
import { Button } from '@renderer/components/ui/button'
import { useActiveSession } from '../../stores/session-store'
import { useContextStore } from '../../stores/context-store'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { useCheckpointStore } from '../../stores/checkpoint-store'
import { useSettingsStore, type ToolDensity } from '../../stores/settings-store'
import { usePanelData } from '../../stores/plugin-store'
import { ChatInput } from './ChatInput'
import { MessageBubble } from './MessageBubble'
import { StatusBar } from './StatusBar'
import { PermissionList } from '../permission/PermissionList'
import { InlineAgentCard } from '../agent/InlineAgentCard'

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

  const setPrefillText = useActiveSession((s) => s.setPrefillText)

  const activeWorkspace = useWorkspaceStore((s) => s.activeWorkspace)
  const addWorkspace = useWorkspaceStore((s) => s.addWorkspace)
  const saveSessionId = useWorkspaceStore((s) => s.saveSessionId)
  const { reset: resetCheckpoints } = useCheckpointStore()
  const model = useSettingsStore((s) => s.model)
  const permissionMode = useSettingsStore((s) => s.permissionMode)
  const effortLevel = useSettingsStore((s) => s.effective.effortLevel)
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
        if (cpRes.ok && cpRes.checkpoint) {
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
          model,
          effortLevel,
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
            model,
            effortLevel,
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

  // 컨텍스트 필터링
  const filterMode = useContextStore((s) => s.binding.filterMode)
  const selectedAgentIds = useContextStore((s) => s.binding.selectedAgentIds)

  // 에이전트 타임라인 데이터 (서브에이전트가 있을 때만 카드 표시)
  const timelineData = usePanelData<AgentTimelineData>('nexus', 'timeline')
  const subAgents = useMemo(() => {
    if (!timelineData) return []
    return timelineData.agents.filter((a) => a.agentId !== 'main')
  }, [timelineData])
  // 실행 중이거나 방금 완료(에이전트가 1명 이상)일 때 카드 표시
  const showAgentCard = subAgents.length > 0 && isRunning

  // 선택된 에이전트의 toolUseId 집합
  const agentToolUseIds = useMemo(() => {
    if (filterMode !== 'agent' || !selectedAgentIds || !timelineData) return null
    const ids = new Set<string>()
    for (const agent of timelineData.agents) {
      if (selectedAgentIds.includes(agent.agentId)) {
        for (const event of agent.events) {
          ids.add(event.toolUseId)
        }
      }
    }
    return ids
  }, [filterMode, selectedAgentIds, timelineData])

  // 메시지 필터링 — filterMode='agent'일 때 해당 에이전트 toolUseId 기준으로 필터
  const filteredItems = useMemo(() => {
    if (!agentToolUseIds) return sortedWithCheckpoints
    return sortedWithCheckpoints.filter((item) => {
      if (item.kind === 'event') return true
      const msg = item.data
      if (msg.role === 'user') return true
      if (!msg.toolCalls || msg.toolCalls.length === 0) return true
      return msg.toolCalls.some((tc) => agentToolUseIds.has(tc.toolUseId))
    })
  }, [sortedWithCheckpoints, agentToolUseIds])

  return (
    <div className="flex h-full flex-col">
      {/* git 저장소 아님 배너 */}
      {!isGitRepo && (
        <div className="mx-4 mt-2 flex items-center justify-between rounded-lg border border-warning/30 bg-warning/10 px-4 py-3">
          <p className="text-sm text-warning">
            ⚠ 이 폴더는 git 저장소가 아닙니다. 체크포인트와 퍼미션 기능을 사용하려면 초기화가 필요합니다.
          </p>
          <button
            onClick={() => void handleGitInit()}
            className="ml-4 shrink-0 rounded bg-warning/60 px-3 py-1 text-xs text-warning-foreground hover:bg-warning/80"
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
          status === 'suspended' ? (
            /* 일시정지 상태 */
            <div className="flex h-full flex-col items-center justify-center gap-3">
              <span className="text-3xl opacity-40">⏸</span>
              <p className="text-base text-foreground">세션이 일시정지되었습니다</p>
              <p className="text-sm text-muted-foreground text-center">
                30분 동안 활동이 없어 프로세스가 종료되었습니다.<br />
                메시지를 보내면 자동으로 재개됩니다.
              </p>
            </div>
          ) : activeWorkspace === null ? (
            /* 워크스페이스 미선택 상태 */
            <div className="flex h-full flex-col items-center justify-center gap-3">
              <Hexagon className="h-8 w-8 opacity-30 text-primary" />
              <p className="text-base text-foreground">워크스페이스를 선택하세요</p>
              <p className="text-sm text-muted-foreground">좌측에서 폴더를 선택하거나 새로 추가하세요</p>
              <button
                onClick={() => void addWorkspace()}
                className="mt-1 rounded-md px-3 py-1.5 text-sm text-primary hover:bg-primary/10 transition-colors"
              >
                + 폴더 추가
              </button>
              <span className="text-xs text-dim-foreground">
                <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 text-xs font-mono">⌘B</kbd>
                {' '}사이드바 열기
              </span>
            </div>
          ) : (
            /* 세션 없음 상태 */
            <div className="flex h-full flex-col items-center justify-center gap-4">
              <p className="text-lg font-medium text-foreground" style={{ marginTop: '-20%' }}>
                무엇을 도와드릴까요?
              </p>
              <div className="grid grid-cols-2 gap-2 w-full max-w-sm">
                {[
                  { title: '코드 리뷰', prompt: '이 코드를 리뷰해줘' },
                  { title: '버그 수정', prompt: '에러 원인을 찾아줘' },
                  { title: '기능 추가', prompt: '새 기능을 구현해줘' },
                  { title: '코드 설명', prompt: '이 함수가 뭘 하는지 설명해줘' },
                ].map(({ title, prompt }) => (
                  <button
                    key={title}
                    onClick={() => setPrefillText(prompt)}
                    className="rounded-xl border border-border bg-card hover:bg-accent/50 p-3 cursor-pointer transition-colors text-left"
                  >
                    <p className="text-sm font-medium text-foreground">{title}</p>
                    <p className="text-xs text-muted-foreground mt-1">{prompt}</p>
                  </button>
                ))}
              </div>
              <span className="text-xs text-dim-foreground">
                Enter 전송 · ⌘K 명령 팔레트
              </span>
            </div>
          )
        ) : (
          <div className="flex flex-col gap-4">
            {filteredItems.map((item) => {
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
            {/* 인라인 에이전트 카드: 서브에이전트 실행 중일 때 표시 */}
            {showAgentCard && (
              <InlineAgentCard agents={subAgents} />
            )}
            {/* 에러 CTA */}
            {status === 'error' && (
              <div className="flex items-center gap-3 rounded-lg border border-error/30 bg-error/10 px-4 py-3">
                <span className="text-sm text-error">오류가 발생했습니다.</span>
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
        <div className="mx-4 mb-2 flex items-center justify-between rounded-lg border border-warning/30 bg-warning/10 px-4 py-3">
          <p className="text-sm text-warning">
            응답 없음 — CLI가 2분 이상 반응하지 않습니다.
          </p>
          <div className="flex gap-2">
            <button
              onClick={dismissTimeout}
              className="rounded px-3 py-1 text-xs text-warning hover:bg-warning/20"
            >
              계속 대기
            </button>
            <button
              onClick={handleTimeoutCancel}
              className="rounded bg-warning/60 px-3 py-1 text-xs text-warning-foreground hover:bg-warning/80"
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

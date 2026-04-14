import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { WorkspaceGroup } from '../adapters/claude-code/workspace-group.js'
import type { CliProcess } from '../adapters/claude-code/cli-process.js'
import type { ApprovalBridge } from '../adapters/approval/bridge.js'
import type { WorkspaceLogger } from '../adapters/logging/workspace-logger.js'
import { logger } from '../middleware/logging.js'

/** Minimal interface for resolving a workspace's process group. Satisfied by ProcessSupervisor and ClaudeCodeHost. */
interface GroupLookup {
  getGroup(workspacePath: string): WorkspaceGroup | undefined
  onGroupCreated(handler: (workspacePath: string, group: WorkspaceGroup) => void): () => void
}

export function createEventsRouter(supervisor: GroupLookup, approvalBridge: ApprovalBridge, workspaceLogger?: WorkspaceLogger) {
  const router = new Hono()

  router.get('/:path{.+}/events', async (c) => {
    const workspacePath = '/' + c.req.param('path')

    // connectionId는 SSE 연결 1회 발급 — 서버 로그에서 연결 생애주기 추적용
    const connectionId = crypto.randomUUID()
    logger.info({ connectionId, workspacePath }, 'sse connection opened')

    return streamSSE(c, async (stream) => {
      const disposables: (() => void)[] = []
      let subscribedGroup: WorkspaceGroup | undefined

      workspaceLogger?.log(workspacePath, {
        type: 'sse_connect',
        data: { connectionId, initialGroupExists: !!supervisor.getGroup(workspacePath) },
      })

      // 부록 B.3: Bun 10초 idle timeout 방지 — 10초 주기 heartbeat
      void stream.writeSSE({ event: 'connected', data: '' })
      const heartbeatTimer = setInterval(() => {
        void stream.write(': heartbeat\n\n')
      }, 10000)

      function subscribeProcess(agentId: string, process_: CliProcess): void {
        // Read sessionId dynamically — may be set after process creation
        const getBase = () => ({
          sessionId: process_.nexusSessionId ?? null,
          agentId: process_.nexusAgentId ?? agentId,
        })

        disposables.push(
          process_.on('init', (data) => {
            void stream.writeSSE({
              event: 'session_init',
              data: JSON.stringify({ ...getBase(), cliSessionId: data.sessionId, model: data.model }),
            })
            workspaceLogger?.log(workspacePath, { type: 'sse_event', sessionId: getBase().sessionId ?? undefined, data: { event: 'session_init', cliSessionId: data.sessionId, model: data.model } })
          }),
          process_.on('text_delta', (data) => {
            void stream.writeSSE({
              event: 'text_delta',
              data: JSON.stringify({ ...getBase(), text: data.text }),
            })
            workspaceLogger?.log(workspacePath, { type: 'sse_event', sessionId: getBase().sessionId ?? undefined, data: { event: 'text_delta', text: data.text.slice(0, 100) } })
          }),
          process_.on('text_chunk', (data) => {
            void stream.writeSSE({
              event: 'text_chunk',
              data: JSON.stringify({ ...getBase(), text: data.text }),
            })
            workspaceLogger?.log(workspacePath, { type: 'sse_event', sessionId: getBase().sessionId ?? undefined, data: { event: 'text_chunk', text: data.text.slice(0, 100) } })
          }),
          process_.on('tool_call', (data) => {
            void stream.writeSSE({
              event: 'tool_call',
              data: JSON.stringify({ ...getBase(), toolCallId: data.toolCallId, toolName: data.toolName, toolInput: data.toolInput }),
            })
            workspaceLogger?.log(workspacePath, { type: 'sse_event', sessionId: getBase().sessionId ?? undefined, data: { event: 'tool_call', toolCallId: data.toolCallId, toolName: data.toolName } })
          }),
          process_.on('tool_result', (data) => {
            void stream.writeSSE({
              event: 'tool_result',
              data: JSON.stringify({ ...getBase(), toolCallId: data.toolCallId, result: data.result, isError: data.isError }),
            })
            workspaceLogger?.log(workspacePath, { type: 'sse_event', sessionId: getBase().sessionId ?? undefined, data: { event: 'tool_result', toolCallId: data.toolCallId, isError: data.isError } })
          }),
          process_.on('permission_request', (data) => {
            void stream.writeSSE({
              event: 'permission_request',
              data: JSON.stringify({ ...getBase(), permissionId: data.permissionId, toolName: data.toolName, toolInput: data.toolInput }),
            })
            workspaceLogger?.log(workspacePath, { type: 'sse_event', sessionId: getBase().sessionId ?? undefined, data: { event: 'permission_request', permissionId: data.permissionId, toolName: data.toolName } })
          }),
          process_.on('turn_end', (data) => {
            void stream.writeSSE({
              event: 'turn_end',
              data: JSON.stringify({ ...getBase(), totalCostUsd: data.totalCostUsd, usage: data.usage }),
            })
            workspaceLogger?.log(workspacePath, { type: 'sse_event', sessionId: getBase().sessionId ?? undefined, data: { event: 'turn_end', totalCostUsd: data.totalCostUsd } })
          }),
          process_.on('error', (data) => {
            void stream.writeSSE({
              event: 'error',
              data: JSON.stringify({ ...getBase(), message: data.message }),
            })
            workspaceLogger?.log(workspacePath, { type: 'sse_event', sessionId: getBase().sessionId ?? undefined, data: { event: 'error', message: data.message } })
          }),
          process_.on('rate_limit_info', (data) => {
            void stream.writeSSE({
              event: 'rate_limit',
              data: JSON.stringify({ ...getBase(), ...data }),
            })
            workspaceLogger?.log(workspacePath, { type: 'sse_event', sessionId: getBase().sessionId ?? undefined, data: { event: 'rate_limit', ...data } })
          }),
        )
      }

      // group이 아직 없어도 SSE 연결을 유지한다. resume/start API가 supervisor.createGroup을
      // 호출하는 순간 `onGroupCreated` 콜백이 이 핸들러 안에서 동기적으로 실행되어
      // process listener를 붙일 시간이 확보된다 (이전 polling race로 첫 이벤트 손실되던 문제 해소).
      function subscribeGroup(group: WorkspaceGroup): void {
        if (subscribedGroup) return
        subscribedGroup = group

        const entries = [...group.listProcessEntries()]
        workspaceLogger?.log(workspacePath, {
          type: 'sse_event',
          data: { event: '_diag_subscribe_group', connectionId, initialProcessCount: entries.length, agentIds: entries.map(([id]) => id) },
        })

        for (const [agentId, process_] of entries) {
          workspaceLogger?.log(workspacePath, { type: 'sse_event', data: { event: '_diag_subscribe_process_initial', connectionId, agentId } })
          subscribeProcess(agentId, process_)
        }

        disposables.push(
          group.onProcessAdded((agentId, process_) => {
            workspaceLogger?.log(workspacePath, { type: 'sse_event', data: { event: '_diag_process_added_cb', connectionId, agentId } })
            subscribeProcess(agentId, process_)
          }),
        )
      }

      const existingGroup = supervisor.getGroup(workspacePath)
      if (existingGroup) {
        workspaceLogger?.log(workspacePath, { type: 'sse_event', data: { event: '_diag_group_existed', connectionId } })
        subscribeGroup(existingGroup)
      } else {
        workspaceLogger?.log(workspacePath, { type: 'sse_event', data: { event: '_diag_group_missing_subscribing_onCreate', connectionId } })
        disposables.push(
          supervisor.onGroupCreated((ws, group) => {
            workspaceLogger?.log(workspacePath, { type: 'sse_event', data: { event: '_diag_group_created_cb', connectionId, ws, matches: ws === workspacePath } })
            if (ws !== workspacePath) return
            subscribeGroup(group)
          }),
        )
      }

      // permission_request → permission_settled requestId 전파를 위해 연결 단위 맵 유지
      const pendingRequestIds = new Map<string, string>()

      // Subscribe to approval bridge pending events for this workspace
      disposables.push(
        approvalBridge.onPendingAdded((info) => {
          if (info.workspacePath !== workspacePath) return
          if (info.requestId) pendingRequestIds.set(info.id, info.requestId)
          void stream.writeSSE({
            event: 'permission_request',
            data: JSON.stringify({
              sessionId: info.sessionId,
              agentId: null,
              permissionId: info.id,
              toolName: info.toolName,
              toolInput: info.toolInput,
              ...(info.requestId ? { requestId: info.requestId } : {}),
            }),
          })
          workspaceLogger?.log(workspacePath, { type: 'sse_event', sessionId: info.sessionId, data: { event: 'permission_request', permissionId: info.id, toolName: info.toolName } })
        }),
        approvalBridge.onPendingSettled((id, result) => {
          const requestId = pendingRequestIds.get(id)
          pendingRequestIds.delete(id)
          void stream.writeSSE({
            event: 'permission_settled',
            data: JSON.stringify({
              sessionId: null,
              permissionId: id,
              decision: result.decision,
              reason: result.reason,
              source: result.source,
              ...(requestId ? { requestId } : {}),
            }),
          })
          workspaceLogger?.log(workspacePath, { type: 'sse_event', data: { event: 'permission_settled', permissionId: id, decision: result.decision, source: result.source } })
        }),
      )

      stream.onAbort(() => {
        clearInterval(heartbeatTimer)
        for (const dispose of disposables) {
          dispose()
        }
        workspaceLogger?.log(workspacePath, { type: 'sse_disconnect', data: { connectionId } })
        logger.info({ connectionId, workspacePath }, 'sse connection closed')
      })

      // Keep the connection alive until client disconnects
      while (!stream.closed) {
        await stream.sleep(30000)
      }
    })
  })

  return router
}

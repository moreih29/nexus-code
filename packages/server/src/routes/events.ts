import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { ProcessSupervisor } from '../adapters/cli/process-supervisor.js'
import type { CliProcess } from '../adapters/cli/cli-process.js'
import type { ApprovalBridge } from '../adapters/hooks/approval-bridge.js'
import type { WorkspaceLogger } from '../adapters/logging/workspace-logger.js'

export function createEventsRouter(supervisor: ProcessSupervisor, approvalBridge: ApprovalBridge, workspaceLogger?: WorkspaceLogger) {
  const router = new Hono()

  router.get('/:path{.+}/events', async (c) => {
    const workspacePath = '/' + c.req.param('path')
    const group = supervisor.getGroup(workspacePath)
    if (!group) {
      return c.json({ error: { code: 'GROUP_NOT_FOUND', message: `No active session group for workspace '${workspacePath}'` } }, 404)
    }

    return streamSSE(c, async (stream) => {
      const disposables: (() => void)[] = []

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

      // Subscribe to all currently tracked processes
      for (const [agentId, process_] of group.listProcessEntries()) {
        subscribeProcess(agentId, process_)
      }

      // Subscribe to new processes as they are added
      disposables.push(
        group.onProcessAdded((agentId, process_) => {
          subscribeProcess(agentId, process_)
        }),
      )

      // Subscribe to approval bridge pending events for this workspace
      disposables.push(
        approvalBridge.onPendingAdded((info) => {
          if (info.workspacePath !== workspacePath) return
          void stream.writeSSE({
            event: 'permission_request',
            data: JSON.stringify({
              sessionId: info.sessionId,
              agentId: null,
              permissionId: info.id,
              toolName: info.toolName,
              toolInput: info.toolInput,
            }),
          })
          workspaceLogger?.log(workspacePath, { type: 'sse_event', sessionId: info.sessionId, data: { event: 'permission_request', permissionId: info.id, toolName: info.toolName } })
        }),
        approvalBridge.onPendingSettled((id, decision) => {
          void stream.writeSSE({
            event: 'permission_settled',
            data: JSON.stringify({ sessionId: null, permissionId: id, decision }),
          })
          workspaceLogger?.log(workspacePath, { type: 'sse_event', data: { event: 'permission_settled', permissionId: id, decision } })
        }),
      )

      stream.onAbort(() => {
        for (const dispose of disposables) {
          dispose()
        }
      })

      // Keep the connection alive until client disconnects
      while (!stream.closed) {
        await stream.sleep(30000)
      }
    })
  })

  return router
}

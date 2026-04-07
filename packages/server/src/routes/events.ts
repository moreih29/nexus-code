import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { ProcessSupervisor } from '../adapters/cli/process-supervisor.js'
import type { CliProcess } from '../adapters/cli/cli-process.js'

export function createEventsRouter(supervisor: ProcessSupervisor) {
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
        const sessionId = (process_.meta['sessionId'] as string | undefined) ?? null
        const base = { sessionId, agentId }

        disposables.push(
          process_.on('init', (data) => {
            void stream.writeSSE({
              event: 'session_init',
              data: JSON.stringify({ ...base, cliSessionId: data.sessionId, model: data.model }),
            })
          }),
          process_.on('text_delta', (data) => {
            void stream.writeSSE({
              event: 'text_delta',
              data: JSON.stringify({ ...base, text: data.text }),
            })
          }),
          process_.on('text_chunk', (data) => {
            void stream.writeSSE({
              event: 'text_chunk',
              data: JSON.stringify({ ...base, text: data.text }),
            })
          }),
          process_.on('tool_call', (data) => {
            void stream.writeSSE({
              event: 'tool_call',
              data: JSON.stringify({ ...base, toolCallId: data.toolCallId, toolName: data.toolName, toolInput: data.toolInput }),
            })
          }),
          process_.on('tool_result', (data) => {
            void stream.writeSSE({
              event: 'tool_result',
              data: JSON.stringify({ ...base, toolCallId: data.toolCallId, result: data.result, isError: data.isError }),
            })
          }),
          process_.on('permission_request', (data) => {
            void stream.writeSSE({
              event: 'permission_request',
              data: JSON.stringify({ ...base, permissionId: data.permissionId, toolName: data.toolName, toolInput: data.toolInput }),
            })
          }),
          process_.on('turn_end', (data) => {
            void stream.writeSSE({
              event: 'turn_end',
              data: JSON.stringify({ ...base, totalCostUsd: data.totalCostUsd, usage: data.usage }),
            })
          }),
          process_.on('error', (data) => {
            void stream.writeSSE({
              event: 'error',
              data: JSON.stringify({ ...base, message: data.message }),
            })
          }),
          process_.on('rate_limit_info', (data) => {
            void stream.writeSSE({
              event: 'rate_limit',
              data: JSON.stringify({ ...base, ...data }),
            })
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

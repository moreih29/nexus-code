import { describe, expect, test } from "bun:test";

import type { WorkspaceId } from "../../../contracts/workspace";
import { CodexAdapter } from "./CodexAdapter";

const workspaceId = "ws_codex" as WorkspaceId;
const fixedNow = new Date("2026-04-26T01:02:03.004Z");

async function* streamOf(events: unknown[]): AsyncIterable<unknown> {
  for (const event of events) {
    yield event;
  }
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const events: T[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

describe("CodexAdapter", () => {
  test("normalizes Codex hook events to tab badge and tool call observer events", async () => {
    const adapter = new CodexAdapter({
      now: () => fixedNow,
      eventStream: streamOf([
        {
          event: "PreToolUse",
          session_id: "codex-session-1",
          timestamp: "2026-04-26T01:00:00Z",
          tool_name: "Read",
          tool_use_id: "call-1",
          tool_input: { file_path: "hello.py" },
        },
        {
          event: "PermissionRequest",
          sessionId: "codex-session-1",
          timestamp: "2026-04-26T01:00:01Z",
          toolName: "Edit",
          toolUseId: "call-2",
          message: "Codex needs approval",
        },
        {
          event: "PostToolUse",
          sessionId: "codex-session-1",
          timestamp: "2026-04-26T01:00:02Z",
          toolName: "Edit",
          toolUseId: "call-2",
          tool_response: { success: true },
        },
        {
          event: "Stop",
          sessionId: "codex-session-1",
          timestamp: "2026-04-26T01:00:03Z",
        },
      ]),
    });

    await expect(collect(adapter.observe(workspaceId))).resolves.toEqual([
      {
        type: "harness/tab-badge",
        state: "running",
        sessionId: "codex-session-1",
        adapterName: "codex",
        workspaceId,
        timestamp: "2026-04-26T01:00:00Z",
      },
      {
        type: "harness/tool-call",
        status: "started",
        toolName: "Read",
        sessionId: "codex-session-1",
        adapterName: "codex",
        workspaceId,
        timestamp: "2026-04-26T01:00:00Z",
        toolCallId: "call-1",
        inputSummary: "file_path: hello.py",
      },
      {
        type: "harness/tab-badge",
        state: "awaiting-approval",
        sessionId: "codex-session-1",
        adapterName: "codex",
        workspaceId,
        timestamp: "2026-04-26T01:00:01Z",
      },
      {
        type: "harness/tool-call",
        status: "awaiting-approval",
        toolName: "Edit",
        sessionId: "codex-session-1",
        adapterName: "codex",
        workspaceId,
        timestamp: "2026-04-26T01:00:01Z",
        toolCallId: "call-2",
        message: "Codex needs approval",
      },
      {
        type: "harness/tool-call",
        status: "completed",
        toolName: "Edit",
        sessionId: "codex-session-1",
        adapterName: "codex",
        workspaceId,
        timestamp: "2026-04-26T01:00:02Z",
        toolCallId: "call-2",
        resultSummary: "success: true",
      },
      {
        type: "harness/tab-badge",
        state: "completed",
        sessionId: "codex-session-1",
        adapterName: "codex",
        workspaceId,
        timestamp: "2026-04-26T01:00:03Z",
      },
    ]);
  });

  test("maps Codex error payloads and session transcript references", async () => {
    const adapter = new CodexAdapter({
      eventStream: streamOf([
        {
          event: "PostToolUse",
          turn_id: "turn-1",
          timestamp: "2026-04-26T01:00:00Z",
          tool_name: "Bash",
          error: { message: "command failed" },
          transcript_path: "/Users/kih/.codex/sessions/turn-1.jsonl",
        },
      ]),
    });

    await expect(collect(adapter.observe(workspaceId))).resolves.toEqual([
      {
        type: "harness/tab-badge",
        state: "error",
        sessionId: "turn-1",
        adapterName: "codex",
        workspaceId,
        timestamp: "2026-04-26T01:00:00Z",
      },
      {
        type: "harness/tool-call",
        status: "error",
        toolName: "Bash",
        sessionId: "turn-1",
        adapterName: "codex",
        workspaceId,
        timestamp: "2026-04-26T01:00:00Z",
        message: "command failed",
      },
      {
        type: "harness/session-history",
        sessionId: "turn-1",
        adapterName: "codex",
        workspaceId,
        timestamp: "2026-04-26T01:00:00Z",
        transcriptPath: "/Users/kih/.codex/sessions/turn-1.jsonl",
      },
    ]);
  });

  test("passes through normalized Codex observer events and filters other adapters/workspaces", async () => {
    const adapter = new CodexAdapter({
      eventStream: streamOf([
        {
          type: "harness/tab-badge",
          state: "running",
          sessionId: "codex-normalized",
          adapterName: "codex",
          workspaceId,
          timestamp: "2026-04-26T01:00:00Z",
        },
        {
          type: "harness/tab-badge",
          state: "running",
          sessionId: "claude-normalized",
          adapterName: "claude-code",
          workspaceId,
          timestamp: "2026-04-26T01:00:00Z",
        },
        {
          type: "harness/tool-call",
          status: "started",
          toolName: "Read",
          sessionId: "codex-other-workspace",
          adapterName: "codex",
          workspaceId: "ws_other",
          timestamp: "2026-04-26T01:00:00Z",
        },
      ]),
    });

    await expect(collect(adapter.observe(workspaceId))).resolves.toEqual([
      {
        type: "harness/tab-badge",
        state: "running",
        sessionId: "codex-normalized",
        adapterName: "codex",
        workspaceId,
        timestamp: "2026-04-26T01:00:00Z",
      },
    ]);
  });

  test("describe returns metadata and dispose is idempotent", async () => {
    let capturedSignal: AbortSignal | undefined;
    const adapter = new CodexAdapter({
      eventStream: (_workspaceId, signal) => {
        capturedSignal = signal;
        return streamOf([]);
      },
    });

    expect(adapter.describe()).toEqual({
      name: "codex",
      version: "0.1.0",
      observationPath: "hooks-api",
    });
    expect(await collect(adapter.observe(workspaceId))).toEqual([]);
    expect(capturedSignal?.aborted).toBe(false);
    adapter.dispose();
    adapter.dispose();
    expect(capturedSignal?.aborted).toBe(true);
    expect(await collect(adapter.observe(workspaceId))).toEqual([]);
  });
});

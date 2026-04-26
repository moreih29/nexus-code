import { describe, expect, test } from "bun:test";

import type { WorkspaceId } from "../../../contracts/workspace";
import { OpenCodeAdapter } from "./OpenCodeAdapter";
import { mapOpenCodeInputToObserverEvents } from "./state-mapper";

const workspaceId = "ws_opencode" as WorkspaceId;
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

describe("OpenCodeAdapter", () => {
  test("normalizes opencode session and permission events", async () => {
    const adapter = new OpenCodeAdapter({
      now: () => fixedNow,
      eventStream: streamOf([
        {
          type: "session.status",
          session: { id: "opencode-session-1" },
          status: "busy",
          time: 1777194000,
        },
        {
          type: "permission.updated",
          sessionID: "opencode-session-1",
          title: "Edit hello.py",
          toolName: "Edit",
          id: "perm-1",
          time: "2026-04-26T01:00:01Z",
        },
        {
          type: "session.idle",
          sessionID: "opencode-session-1",
          timestamp: "2026-04-26T01:00:02Z",
        },
      ]),
    });

    await expect(collect(adapter.observe(workspaceId))).resolves.toEqual([
      {
        type: "harness/tab-badge",
        state: "running",
        sessionId: "opencode-session-1",
        adapterName: "opencode",
        workspaceId,
        timestamp: new Date(1777194000 * 1000).toISOString(),
      },
      {
        type: "harness/tab-badge",
        state: "awaiting-approval",
        sessionId: "opencode-session-1",
        adapterName: "opencode",
        workspaceId,
        timestamp: "2026-04-26T01:00:01Z",
      },
      {
        type: "harness/tool-call",
        status: "awaiting-approval",
        toolName: "Edit",
        sessionId: "opencode-session-1",
        adapterName: "opencode",
        workspaceId,
        timestamp: "2026-04-26T01:00:01Z",
        toolCallId: "perm-1",
        message: "Edit hello.py",
      },
      {
        type: "harness/tab-badge",
        state: "completed",
        sessionId: "opencode-session-1",
        adapterName: "opencode",
        workspaceId,
        timestamp: "2026-04-26T01:00:02Z",
      },
    ]);
  });

  test("normalizes opencode ToolPart updates to tool call events", async () => {
    const adapter = new OpenCodeAdapter({
      eventStream: streamOf([
        {
          type: "message.part.updated",
          sessionID: "opencode-session-1",
          timestamp: "2026-04-26T01:00:00Z",
          part: {
            id: "tool-1",
            type: "tool",
            tool: "bash",
            state: "running",
            input: { command: "printf hello" },
          },
        },
        {
          type: "message.part.updated",
          sessionID: "opencode-session-1",
          timestamp: "2026-04-26T01:00:01Z",
          part: {
            id: "tool-1",
            type: "tool",
            tool: "bash",
            state: "completed",
            output: "hello",
          },
        },
        {
          type: "message.part.updated",
          sessionID: "opencode-session-1",
          timestamp: "2026-04-26T01:00:02Z",
          part: {
            id: "tool-2",
            type: "tool",
            tool: "edit",
            state: "error",
            message: "edit failed",
          },
        },
      ]),
    });

    await expect(collect(adapter.observe(workspaceId))).resolves.toEqual([
      {
        type: "harness/tab-badge",
        state: "running",
        sessionId: "opencode-session-1",
        adapterName: "opencode",
        workspaceId,
        timestamp: "2026-04-26T01:00:00Z",
      },
      {
        type: "harness/tool-call",
        status: "started",
        toolName: "bash",
        sessionId: "opencode-session-1",
        adapterName: "opencode",
        workspaceId,
        timestamp: "2026-04-26T01:00:00Z",
        toolCallId: "tool-1",
        inputSummary: "command: printf hello",
      },
      {
        type: "harness/tool-call",
        status: "completed",
        toolName: "bash",
        sessionId: "opencode-session-1",
        adapterName: "opencode",
        workspaceId,
        timestamp: "2026-04-26T01:00:01Z",
        toolCallId: "tool-1",
        resultSummary: "hello",
      },
      {
        type: "harness/tab-badge",
        state: "error",
        sessionId: "opencode-session-1",
        adapterName: "opencode",
        workspaceId,
        timestamp: "2026-04-26T01:00:02Z",
      },
      {
        type: "harness/tool-call",
        status: "error",
        toolName: "edit",
        sessionId: "opencode-session-1",
        adapterName: "opencode",
        workspaceId,
        timestamp: "2026-04-26T01:00:02Z",
        toolCallId: "tool-2",
        message: "edit failed",
      },
    ]);
  });

  test("maps current OpenCode permission and session reference events", () => {
    const events = mapOpenCodeInputToObserverEvents(
      {
        type: "permission.asked",
        properties: {
          id: "perm-2",
          sessionID: "opencode-session-2",
          messageID: "msg-1",
          callID: "call-1",
          type: "bash",
          title: "Run git status",
          pattern: "git status*",
          time: { created: 1777194001 },
        },
      },
      {
        workspaceId,
        now: () => fixedNow,
        sessionTranscriptPath: (identity) =>
          `opencode://127.0.0.1:43106/session/${identity.sessionId}/message`,
      },
    );

    expect(events).toEqual([
      {
        type: "harness/tab-badge",
        state: "awaiting-approval",
        sessionId: "opencode-session-2",
        adapterName: "opencode",
        workspaceId,
        timestamp: new Date(1777194001 * 1000).toISOString(),
      },
      {
        type: "harness/tool-call",
        status: "awaiting-approval",
        toolName: "bash",
        sessionId: "opencode-session-2",
        adapterName: "opencode",
        workspaceId,
        timestamp: new Date(1777194001 * 1000).toISOString(),
        toolCallId: "call-1",
        inputSummary: "git status*",
        message: "Run git status",
      },
      {
        type: "harness/session-history",
        sessionId: "opencode-session-2",
        adapterName: "opencode",
        workspaceId,
        timestamp: new Date(1777194001 * 1000).toISOString(),
        transcriptPath: "opencode://127.0.0.1:43106/session/opencode-session-2/message",
      },
    ]);
  });

  test("maps OpenCode global event payload wrappers", () => {
    const events = mapOpenCodeInputToObserverEvents(
      {
        directory: "/tmp/project",
        payload: {
          type: "session.created",
          properties: {
            info: {
              id: "opencode-session-3",
              title: "New session",
              time: { created: 1777194002, updated: 1777194002 },
            },
          },
        },
      },
      {
        workspaceId,
        now: () => fixedNow,
        sessionTranscriptPath: (identity) =>
          `opencode://127.0.0.1:43106/session/${identity.sessionId}/message`,
      },
    );

    expect(events).toEqual([
      {
        type: "harness/session-history",
        sessionId: "opencode-session-3",
        adapterName: "opencode",
        workspaceId,
        timestamp: new Date(1777194002 * 1000).toISOString(),
        transcriptPath: "opencode://127.0.0.1:43106/session/opencode-session-3/message",
      },
    ]);
  });

  test("passes through normalized OpenCode observer events and filters other adapters", async () => {
    const adapter = new OpenCodeAdapter({
      eventStream: streamOf([
        {
          type: "harness/tool-call",
          status: "started",
          toolName: "Read",
          sessionId: "opencode-normalized",
          adapterName: "opencode",
          workspaceId,
          timestamp: "2026-04-26T01:00:00Z",
        },
        {
          type: "harness/tool-call",
          status: "started",
          toolName: "Read",
          sessionId: "codex-normalized",
          adapterName: "codex",
          workspaceId,
          timestamp: "2026-04-26T01:00:00Z",
        },
      ]),
    });

    await expect(collect(adapter.observe(workspaceId))).resolves.toEqual([
      {
        type: "harness/tool-call",
        status: "started",
        toolName: "Read",
        sessionId: "opencode-normalized",
        adapterName: "opencode",
        workspaceId,
        timestamp: "2026-04-26T01:00:00Z",
      },
    ]);
  });

  test("describe returns metadata and dispose is idempotent", async () => {
    let capturedSignal: AbortSignal | undefined;
    const adapter = new OpenCodeAdapter({
      eventStream: (_workspaceId, signal) => {
        capturedSignal = signal;
        return streamOf([]);
      },
    });

    expect(adapter.describe()).toEqual({
      name: "opencode",
      version: "0.1.0",
      observationPath: "mixed",
    });
    expect(await collect(adapter.observe(workspaceId))).toEqual([]);
    expect(capturedSignal?.aborted).toBe(false);
    adapter.dispose();
    adapter.dispose();
    expect(capturedSignal?.aborted).toBe(true);
    expect(await collect(adapter.observe(workspaceId))).toEqual([]);
  });
});

import { describe, expect, test } from "bun:test";

import type { HarnessObserverEvent, ToolCallEvent } from "../../../shared/src/contracts/harness-observer";
import type { WorkspaceId, WorkspaceRegistryEntry } from "../../../shared/src/contracts/workspace";
import {
  OpenCodeSseObserverService,
  consumeOpenCodeSseStream,
  openCodeInputFromSseMessage,
  openCodeSseUrl,
} from "./opencode-sse-observer-service";

describe("OpenCodeSseObserverService", () => {
  test("reconciles open workspaces, subscribes deterministic SSE URL, and emits mapped observer events", async () => {
    const workspace = createWorkspace("ws_opencode" as WorkspaceId);
    const store = new FakeWorkspaceSessionStore([workspace]);
    const emitted: HarnessObserverEvent[] = [];
    const fetchCalls: Array<{ url: string; signal?: AbortSignal }> = [];
    const fetchFn: typeof fetch = async (input, init) => {
      fetchCalls.push({ url: String(input), signal: init?.signal });
      return new Response(
        sseText([
          {
            event: "message.part.updated",
            data: {
              properties: {
                session: { id: "sess_1" },
                part: {
                  id: "tool_1",
                  type: "tool",
                  tool: "bash",
                  state: { status: "running" },
                  input: { command: "echo hi" },
                },
              },
              time: "2026-04-26T05:15:00.000Z",
            },
          },
        ]),
        { status: 200 },
      );
    };
    const service = new OpenCodeSseObserverService({
      workspaceSessionStore: store,
      emitObserverEvent: (event) => emitted.push(event),
      fetchFn,
      retryDelayMs: 60_000,
    });

    await service.reconcileOnce();

    await waitFor(() => {
      expect(fetchCalls).toHaveLength(1);
      expect(emitted.some((event) => event.type === "harness/tool-call")).toBe(true);
    });

    expect(fetchCalls[0]?.url).toBe(openCodeSseUrl(workspace.id));
    const toolCall = emitted.find((event): event is ToolCallEvent => event.type === "harness/tool-call");
    expect(toolCall).toMatchObject({
      type: "harness/tool-call",
      workspaceId: workspace.id,
      adapterName: "opencode",
      sessionId: "sess_1",
      status: "started",
      toolName: "bash",
      toolCallId: "tool_1",
    });

    store.openWorkspaces = [];
    await service.reconcileOnce();
    expect(fetchCalls[0]?.signal?.aborted).toBe(true);
    expect(service.listConnectedWorkspaceIds()).toEqual([]);
    service.dispose();
  });

  test("parses SSE blocks and attaches SSE event names to JSON payloads", async () => {
    const messages: Array<ReturnType<typeof openCodeInputFromSseMessage>> = [];
    await consumeOpenCodeSseStream(
      new Response(
        "event: permission.updated\n" +
          "data: {\"properties\":{\"session\":{\"id\":\"sess_2\"}}}\n\n",
      ).body!,
      (message) => messages.push(openCodeInputFromSseMessage(message)),
    );

    expect(messages).toEqual([
      {
        event: "permission.updated",
        properties: {
          session: { id: "sess_2" },
        },
      },
    ]);
  });
});

function createWorkspace(id: WorkspaceId): WorkspaceRegistryEntry {
  return {
    id,
    absolutePath: `/tmp/${id}`,
    displayName: id,
    createdAt: "2026-04-26T05:15:00.000Z",
    lastOpenedAt: "2026-04-26T05:15:00.000Z",
  };
}

function sseText(events: Array<{ event: string; data: unknown }>): string {
  return events
    .map((event) => {
      return `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
    })
    .join("");
}

class FakeWorkspaceSessionStore {
  public constructor(public openWorkspaces: WorkspaceRegistryEntry[]) {}

  public async restoreWorkspaceSession(): Promise<{ openWorkspaces: WorkspaceRegistryEntry[] }> {
    return { openWorkspaces: this.openWorkspaces };
  }
}

async function waitFor(assertion: () => void, timeoutMs = 250): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;

  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  if (lastError instanceof Error) {
    throw lastError;
  }
  throw new Error("Timed out waiting for assertion.");
}

import { describe, expect, spyOn, test } from "bun:test";
import type { ChatRun } from "../../../../../packages/remote-protocol/src";
import * as ipc from "../../../../../src/renderer/ipc/client";
import {
  emptyModel,
  type ImageBlock,
  type ToolCall,
} from "../../../../../src/renderer/services/chat/model";
import {
  agentRunOf,
  peerRunRows,
  RUN_READ_LIVE_MS,
  RUN_READ_SLOW_MS,
  readPeerRunTool,
  runImageLook,
  runReadAfter,
} from "../../../../../src/renderer/services/remote/peer-runs";

import { ipcErr, ipcOk } from "../../../../../src/shared/ipc/result";

const run = (over: Partial<ChatRun>): ChatRun => ({
  id: "r1",
  start: 100,
  state: "running",
  toolCount: 0,
  failedCount: 0,
  ...over,
});

describe("another computer's chat's runs", () => {
  test("are rows of its agents, oldest first, keyed apart from its subagents", () => {
    const rows = peerRunRows([
      run({
        id: "r2",
        start: 200,
        prompt: "Summarize\n  the log",
        current: "Bash wc -l",
        last: "Reading",
        toolCount: 3,
        state: "permissionPending",
      }),
      run({ id: "r1", program: "codex", end: 150, state: "completed", model: "gpt-5" }),
    ]);
    expect(rows.map((r) => r.toolUseId)).toEqual(["print:r1", "print:r2"]);
    expect(rows[0]).toMatchObject({
      description: "codex exec",
      subagentType: "codex exec",
      model: "gpt-5",
      status: "completed",
      endedAt: 150,
    });
    expect(rows[1]).toMatchObject({
      description: "Summarize the log",
      subagentType: "claude -p",
      status: "running",
      currentTool: "Bash wc -l",
      lastText: "Reading",
      toolCount: 3,
    });
    expect(rows[1]?.run).toMatchObject({ id: "r2", kind: "print", tools: [] });
  });

  test("a run read whole is the app's own record of one", () => {
    const tools = [{ id: "u1", name: "Read", start: 101, end: 102 }];
    expect(
      agentRunOf(
        run({ tools, messages: [{ at: 1, text: "hi" }], answer: "Done.", sessionId: "s1" }),
      ),
    ).toEqual({
      id: "r1",
      kind: "print",
      start: 100,
      state: "running",
      answer: "Done.",
      tools,
      messages: [{ at: 1, text: "hi" }],
      toolCount: 0,
      failedCount: 0,
      sessionId: "s1",
    });
  });

  test("a run is asked for again while it goes on, unless the other computer refused", () => {
    for (const failure of ["permission-denied", "unsupported"]) {
      expect(runReadAfter(failure, false)).toBeNull();
    }
    expect(runReadAfter(null, false)).toBe(RUN_READ_LIVE_MS);
    expect(runReadAfter("unavailable", false)).toBe(RUN_READ_LIVE_MS);
    expect(runReadAfter("not-found", false)).toBe(RUN_READ_SLOW_MS);
    for (const failure of [null, "unavailable", "not-found"]) {
      expect(runReadAfter(failure, true)).toBeNull();
    }
  });
});

test("a full tool result comes from its run and preserves the server's truncation marker", async () => {
  const result = { text: "run tool output", isError: false, images: [], truncated: true };
  const call = spyOn(ipc, "ipcCallResult").mockResolvedValue(ipcOk({ result }) as never);
  try {
    const ref = { deviceId: "d1", workspaceId: "w1", tabId: "t1", runId: "r1" };
    const signal = new AbortController().signal;
    expect(await readPeerRunTool(ref, "tool-1", signal)).toEqual(result);
    expect(call).toHaveBeenCalledWith(
      "remote",
      "peerChatTool",
      { ...ref, toolUseId: "tool-1" },
      { signal },
    );
    call.mockResolvedValue(ipcErr("not-found", "missing run") as never);
    await expect(readPeerRunTool(ref, "tool-1", signal)).rejects.toThrow("missing run");
  } finally {
    call.mockRestore();
  }
});

test("opens the gallery at the selected image across the run's tool results", () => {
  const first: ImageBlock = {
    data: "",
    mediaType: "image/png",
    remote: { kind: "tool", index: 0, toolUseId: "first" },
  };
  const second: ImageBlock = { ...first, remote: { kind: "tool", index: 0, toolUseId: "second" } };
  const model = emptyModel();
  model.items = [
    {
      key: "answer",
      kind: "assistant",
      blocks: [
        { type: "tool", toolUseId: "first" },
        { type: "tool", toolUseId: "second" },
      ],
    },
  ];
  const tool = (id: string, image: ImageBlock): ToolCall => ({
    id,
    name: "Read",
    input: { file_path: "/qa.png" },
    status: "done",
    parentToolUseId: null,
    result: { text: "", images: [image], isError: false },
  });
  model.tools = { first: tool("first", first), second: tool("second", second) };
  const look = runImageLook(model, "/", [{ ...second }], 0);
  expect(look.index).toBe(1);
  expect(look.files.map((key) => look.images[key])).toEqual([first, second]);
});

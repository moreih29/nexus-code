import { expect, spyOn, test } from "bun:test";
import { act } from "react";
import * as ipc from "../../../../../src/renderer/ipc/client";
import { RUN_READ_INTERVAL_MS } from "../../../../../src/renderer/services/chat/print-run-transcript";
import {
  subagentConversation,
  useSubagentConversation,
} from "../../../../../src/renderer/services/chat/subagent-conversation";
import type { AgentRun } from "../../../../../src/shared/claude/activity";
import { withTestDom } from "../../../../helpers/test-dom";

const agent = { id: "agent-1", prompt: "Find the bug", start: 1_000 };

const assistant = (uuid: string, content: unknown[]) => ({
  type: "assistant",
  uuid,
  timestamp: "2026-11-24T00:00:00.000Z",
  message: { id: `msg-${uuid}`, role: "assistant", content },
});

test("a subagent's transcript reads as its prompt and then what it wrote", () => {
  const read = subagentConversation(
    agent,
    [
      assistant("a", [{ type: "text", text: "Looking at the parser." }]),
      assistant("b", [{ type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "x" } }]),
    ],
    false,
  );
  expect(read?.items[0]).toMatchObject({ kind: "user", text: "Find the bug", at: 1_000 });
  expect(read?.items.slice(1).every((item) => item.kind === "assistant")).toBe(true);
  expect(Object.keys(read?.model.tools ?? {})).toContain("tool-1");
  expect(read?.truncated).toBe(false);
});

test("a subagent with nothing written yet has no conversation", () => {
  expect(subagentConversation(agent, [], false)).toBeNull();
});

test("a subagent without a prompt starts at what it wrote", () => {
  const read = subagentConversation(
    { ...agent, prompt: undefined },
    [assistant("a", [{ type: "text", text: "Done." }])],
    true,
  );
  expect(read?.items[0]?.kind).toBe("assistant");
  expect(read?.truncated).toBe(true);
});

test("a running subagent is not read again while the last read is still on its way", async () => {
  const reads: ((value: unknown) => void)[] = [];
  const call = spyOn(ipc, "ipcCallResult").mockImplementation(((
    _channel: string,
    method: string,
  ) =>
    method === "subagentTranscript"
      ? new Promise((resolve) => reads.push(resolve))
      : Promise.resolve({ ok: true, value: undefined })) as unknown as typeof ipc.ipcCallResult);
  const ticks: (() => void)[] = [];
  const realInterval = globalThis.setInterval;
  globalThis.setInterval = ((run: () => void, delay?: number) => {
    if (delay !== RUN_READ_INTERVAL_MS) return realInterval(run, delay);
    ticks.push(run);
    return 0 as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;
  const run: AgentRun = {
    id: "agent-1",
    kind: "subagent",
    start: 1_000,
    state: "running",
    tools: [],
    toolCount: 0,
    failedCount: 0,
  };
  const tick = () =>
    act(async () => {
      for (const next of ticks) next();
    });
  function Reader() {
    useSubagentConversation("w", "s", undefined, run, true);
    return null;
  }
  try {
    await withTestDom(async (_host, root) => {
      await act(async () => root.render(<Reader />));
      expect(reads).toHaveLength(1);

      await tick();
      await tick();
      expect(reads).toHaveLength(1);

      await act(async () =>
        reads[0]?.({ ok: true, value: { found: true, lines: [], truncated: false } }),
      );
      await tick();
      expect(reads).toHaveLength(2);
    });
  } finally {
    globalThis.setInterval = realInterval;
    call.mockRestore();
  }
});

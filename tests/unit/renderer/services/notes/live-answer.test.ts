import { expect, mock, spyOn, test } from "bun:test";
import * as ipc from "../../../../../src/renderer/ipc/client";
import { ChatController } from "../../../../../src/renderer/services/chat/claude/controller";
import { CodexController } from "../../../../../src/renderer/services/chat/codex/controller";
import { type ChatModel, emptyModel } from "../../../../../src/renderer/services/chat/model";
import { useChatStore } from "../../../../../src/renderer/services/chat/store";
import { liveAnswerOf } from "../../../../../src/renderer/services/notes/live-answer";

test("a snapshot is capped at 500 Unicode characters with no format controls", () => {
  const model: ChatModel = {
    ...emptyModel(),
    lastResult: { subtype: "success", isError: false, at: 100 },
    items: [
      {
        kind: "assistant",
        key: "answer",
        messageId: "answer",
        blocks: [
          { type: "thinking", text: "Private reasoning" },
          { type: "text", text: `${"a".repeat(499)}\u2066😀tail\u2069` },
        ],
      },
    ],
    tools: {
      edit: {
        id: "edit",
        name: "Edit",
        status: "done",
        parentToolUseId: null,
        input: { file_path: "one.ts" },
      },
      delete: {
        id: "delete",
        name: "Delete",
        status: "done",
        parentToolUseId: null,
        input: { file_path: "two.ts" },
      },
    },
  };
  expect(liveAnswerOf(model)).toEqual({ text: `${"a".repeat(499)}😀`, at: 100, files: 2 });
  expect(liveAnswerOf({ ...model, running: true })).toBeUndefined();
});

test.each([
  "claude",
  "codex",
] as const)("publishes %s snapshots at live turn completion, excluding replay", (agent) => {
  const listen = spyOn(ipc, "ipcListen").mockReturnValue(() => {});
  const call = spyOn(ipc, "ipcCallResult").mockResolvedValue({ ok: true, value: undefined });
  const onTurnEnd = mock((model: ChatModel) => liveAnswerOf(model));
  const target = { workspaceId: "live-card", tabId: agent, cwd: "/repo" };
  const controller =
    agent === "claude"
      ? new ChatController({ ...target, sessionId: "thread" }, { onTurnEnd })
      : new CodexController({ ...target, threadId: "thread" }, { onTurnEnd });
  useChatStore.getState().update(controller.key, (state) => ({
    ...state,
    model: { ...state.model, process: "running", threadId: "thread" },
  }));
  let seq = 0;
  const line = (message: unknown, replay = false) =>
    controller.receive({
      dir: "out",
      seq: ++seq,
      at: seq * 100,
      message,
      replay,
    });
  const codex = (method: string, params: object, replay = false) =>
    line({ method, params: { threadId: "thread", ...params } }, replay);
  const turn = (id: string, replay: boolean) => {
    if (agent === "claude") {
      line({ type: "assistant", message: { id, content: [{ type: "text", text: id }] } }, replay);
      controller.flushNow();
      expect(onTurnEnd).not.toHaveBeenCalled();
      line({ type: "result", subtype: "success", is_error: false }, replay);
    } else {
      codex("turn/started", { turn: { id } }, replay);
      codex("item/completed", { turnId: id, item: { id, type: "agentMessage", text: id } }, replay);
      controller.flushNow();
      expect(onTurnEnd).not.toHaveBeenCalled();
      codex("turn/completed", { turn: { id, status: "completed", items: [] } }, replay);
    }
    controller.flushNow();
  };
  try {
    turn("replayed answer", true);
    expect(onTurnEnd).not.toHaveBeenCalled();
    turn("new answer", false);
    expect(onTurnEnd).toHaveBeenCalledTimes(1);
    expect(onTurnEnd.mock.results[0].value).toEqual({ text: "new answer", at: seq * 100 });
  } finally {
    controller.dispose();
    call.mockRestore();
    listen.mockRestore();
  }
});

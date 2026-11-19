/**
 * Another device reading a Claude chat not open here sees its conversation
 * once the transcript is read, without waiting for the program started on
 * it to be ready. The real ipc client is spread under a spy, so later
 * files keep its other exports.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { historyModel } from "../../../../../../src/renderer/services/chat/claude/history";
import type { TranscriptPageResult } from "../../../../../../src/shared/ipc/contract";

let releaseStart: () => void = () => {};
let started = false;
let replyToInitialize: ((requestId: string) => void) | undefined;
let onStartRequested: (() => void) | undefined;
let transcriptPage: ((cursor?: string) => Promise<TranscriptPageResult>) | undefined;
let completeLines: readonly unknown[] | undefined;
let completeReads = 0;

const realIpc = await import("../../../../../../src/renderer/ipc/client");
mock.module("../../../../../../src/renderer/ipc/client", () => ({
  ...realIpc,
  ipcCallResult: (
    _channel: string,
    method: string,
    args: { message?: { request_id?: string }; cursor?: string },
  ) => {
    if (method === "replay") {
      return Promise.resolve({ ok: true, value: { found: false } });
    }
    if (method === "transcriptPage" && transcriptPage) {
      return transcriptPage(args.cursor).then((value) => ({ ok: true, value }));
    }
    if (method === "transcript") {
      completeReads++;
      return Promise.resolve({
        ok: true,
        value: {
          found: true,
          truncated: false,
          lines: completeLines ?? [
            {
              type: "user",
              uuid: "u1",
              timestamp: "2026-11-13T10:00:00.000Z",
              message: { role: "user", content: "Reply with just ok" },
            },
          ],
        },
      });
    }
    if (method === "start") {
      // The program takes its time: answered only when the test says.
      return new Promise((resolve) => {
        releaseStart = () => {
          started = true;
          resolve({ ok: true, value: { ok: true, version: "2.1.322", attached: false } });
        };
        onStartRequested?.();
      });
    }
    if (method === "send" && args.message?.request_id) {
      replyToInitialize?.(args.message.request_id);
    }
    return Promise.resolve({ ok: true, value: undefined });
  },
}));

const { ChatController } = await import(
  "../../../../../../src/renderer/services/chat/claude/controller"
);
const { useChatStore, chatKey } = await import(
  "../../../../../../src/renderer/services/chat/store"
);
type Controller = InstanceType<typeof ChatController>;

const live: Controller[] = [];

afterEach(() => {
  releaseStart();
  for (const c of live.splice(0)) c.dispose();
  started = false;
  replyToInitialize = undefined;
  onStartRequested = undefined;
  transcriptPage = undefined;
  completeLines = undefined;
  completeReads = 0;
});

describe("opening a Claude tab to read it", () => {
  test("comes back with the transcript shown while the program is still starting", async () => {
    const c = new ChatController({
      workspaceId: "ws-read",
      tabId: "t-read",
      cwd: "/p",
      sessionId: "s-read",
    });
    live.push(c);
    replyToInitialize = (requestId) =>
      c.receive({
        dir: "out",
        seq: 1,
        message: {
          type: "control_response",
          response: { subtype: "success", request_id: requestId, response: {} },
        },
      } as never);
    const requested = Promise.withResolvers<void>();
    onStartRequested = requested.resolve;
    const opening = c.open();
    await c.openToRead();
    expect(started).toBe(false);
    const state = useChatStore.getState().tabs[chatKey("ws-read", "t-read")];
    expect(state?.history?.items.some((item) => item.kind === "user")).toBe(true);
    expect(state?.phase).toBe("starting");
    await requested.promise;
    releaseStart();
    await opening;
    expect(started).toBe(true);
  });

  test("a new tab, with no session to read, comes back at once", async () => {
    const c = new ChatController({ workspaceId: "ws-read", tabId: "t-new", cwd: "/p" });
    live.push(c);
    await c.openToRead();
    expect(started).toBe(false);
    expect(useChatStore.getState().tabs[chatKey("ws-read", "t-new")]?.history ?? null).toBeNull();
  });
});

function user(uuid: string, content: string) {
  return { type: "user", uuid, message: { role: "user", content } };
}

function goal(condition: string) {
  return {
    type: "attachment",
    timestamp: "2026-11-10T13:52:53.172Z",
    attachment: { type: "goal_status", met: true, condition },
  };
}

function page(lines: unknown[], positions: number[], cursor?: string): TranscriptPageResult {
  return { found: true, truncated: false, snapshot: "same-snapshot", lines, positions, cursor };
}

function openTail(hooks = {}) {
  const controller = new ChatController(
    {
      workspaceId: "ws-tail",
      tabId: "tail",
      cwd: "/p",
      sessionId: "session-tail",
    },
    hooks,
  );
  live.push(controller);
  const started = Promise.withResolvers<void>();
  onStartRequested = started.resolve;
  void controller.open();
  return { controller, shown: started.promise };
}

test("the tail and previous pages reconstruct the full history while live output stays separate", async () => {
  const first = user("first", "first");
  const recent = user("recent", "recent");
  const call = {
    type: "assistant",
    uuid: "calling",
    message: {
      id: "tool-message",
      content: [{ type: "tool_use", id: "read", name: "Read", input: { file_path: "/p/a" } }],
    },
  };
  const result = {
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "read", content: "file result" }] },
  };
  const oldLines = [
    { type: "custom-title", customTitle: "old title" },
    goal("old goal"),
    first,
    call,
  ];
  const newLines = [
    result,
    recent,
    goal("new goal"),
    { type: "custom-title", customTitle: "new title" },
  ];
  const pending = Promise.withResolvers<TranscriptPageResult>();
  const requested: string[] = [];
  transcriptPage = (cursor) => {
    if (!cursor) return Promise.resolve(page(newLines, [500, 660, 750, 810], "older"));
    requested.push(cursor);
    return pending.promise;
  };
  completeLines = [...oldLines, ...newLines];

  const onTitle = mock((_title: string) => {});
  const onFirstMessage = mock((_text: string) => {});
  const { controller, shown } = openTail({ onTitle, onFirstMessage });
  await shown;
  expect(completeReads).toBe(0);
  expect(controller.state.history?.items.find((item) => item.kind === "user")?.key).toBe(
    "same-snapshot:u661",
  );
  expect(() => controller.forkPoint("recent", { before: true })).toThrow("Read earlier messages");
  await expect(controller.previewRewind("recent")).rejects.toThrow("Read earlier messages");
  const replayedUser = controller.state.history?.items[0];
  if (replayedUser?.kind !== "user") throw new Error("expected a recorded user item");
  await expect(controller.rewind(replayedUser, { files: true })).rejects.toThrow(
    "Read earlier messages",
  );

  const older = controller.loadEarlier();
  await controller.loadEarlier();
  expect(requested).toEqual(["older"]);
  controller.receive({
    dir: "out",
    seq: 50,
    message: {
      type: "assistant",
      uuid: "new-live",
      message: { id: "live", content: [{ type: "text", text: "new live output" }] },
    },
  });
  controller.flushNow();
  const liveModel = controller.state.model;
  pending.resolve(page(oldLines, [0, 100, 200, 350]));
  await older;

  const expected = historyModel(completeLines);
  const actual = controller.state.history;
  // File offsets give the private pages stable row keys when a prefix is added.
  const content = (model: ReturnType<typeof historyModel> | null) =>
    model?.items.map(({ key: _key, ...item }) => item);
  expect(content(actual)).toEqual(content(expected));
  expect(actual?.tools).toEqual(expected.tools);
  expect(actual?.goal).toEqual(expected.goal);
  expect(actual?.items.find((item) => item.kind === "user" && item.uuid === "recent")?.key).toBe(
    "same-snapshot:u661",
  );
  expect(controller.state.model).toBe(liveModel);
  expect(liveModel.goal?.condition).toBe("new goal");
  expect(onTitle.mock.calls).toEqual([["new title"]]);
  expect(onFirstMessage).not.toHaveBeenCalled();
  expect(controller.forkPoint("recent", { before: true })).toMatchObject({ at: "calling" });
  expect(controller.forkPoint("first", { before: true })).toBeNull();

  await controller.openToRead();
  expect(completeReads).toBe(1);
  expect(controller.state.history?.items.map((item) => item.key)).toEqual(
    expected.items.map((item) => item.key),
  );
});

test.each([
  "different snapshot",
  "conversation reset",
])("an earlier page cannot replace the current history after %s", async (change) => {
  const pending = Promise.withResolvers<TranscriptPageResult>();
  const continued = Promise.withResolvers<void>();
  const wire = Buffer.from(JSON.stringify(user("old", "old")));
  transcriptPage = async (cursor) => {
    if (!cursor) return page([user("recent", "recent")], [250], "older");
    if (cursor === "older") {
      return {
        ...page([], [], "finish-row"),
        fragment: {
          position: 0,
          data: wire.subarray(10).toString("base64"),
          first: false,
          last: true,
        },
      };
    }
    expect(cursor).toBe("finish-row");
    continued.resolve();
    return pending.promise;
  };
  const { controller, shown } = openTail();
  await shown;
  const older = controller.loadEarlier();
  await continued.promise;
  if (change === "conversation reset") {
    controller.receive({ dir: "out", seq: 1, message: { type: "conversation_reset" } });
    controller.flushNow();
  }
  const before = controller.state.history;
  pending.resolve({
    ...page([], []),
    fragment: {
      position: 0,
      data: wire.subarray(0, 10).toString("base64"),
      first: true,
      last: false,
    },
    snapshot: change === "different snapshot" ? "other-snapshot" : "same-snapshot",
  });
  if (change === "different snapshot") await expect(older).rejects.toThrow("no longer joins");
  else await older;
  expect(controller.state.history).toBe(before);
});

test.each([
  "opening",
  "earlier",
  "earlier with an answer before its question",
] as const)("%s completes a fragmented row in one action", async (action) => {
  const opening = action === "opening";
  const acrossTurn = action === "earlier with an answer before its question";
  const entry =
    opening || acrossTurn
      ? {
          type: "user",
          message: {
            content: [{ type: "tool_result", tool_use_id: "read", content: "large result" }],
          },
        }
      : user("fragmented", "large message");
  const bytes = Buffer.from(JSON.stringify(entry));
  const fragment = (start: number, end: number, cursor: string): TranscriptPageResult => ({
    ...page([], [], cursor),
    fragment: {
      position: 250,
      data: bytes.subarray(start, end).toString("base64"),
      first: start === 0,
      last: end === bytes.length,
    },
  });
  const trailing = fragment(20, bytes.length, "middle");
  const requested: (string | undefined)[] = [];
  transcriptPage = async (cursor) => {
    requested.push(cursor);
    switch (cursor) {
      case undefined:
        return opening ? trailing : page([user("recent", "recent")], [400], "large");
      case "large":
        return acrossTurn
          ? page(
              [
                {
                  type: "assistant",
                  uuid: "answer",
                  message: { id: "answer", content: [{ type: "text", text: "the answer" }] },
                },
              ],
              [350],
              "result",
            )
          : trailing;
      case "result":
        return trailing;
      case "middle":
        return fragment(10, 20, "beginning");
      case "beginning":
        return fragment(0, 10, "before-row");
      case "before-row":
        if (!opening && !acrossTurn) throw new Error("an earlier read went past the completed row");
        return page(
          [
            user("prompt", "read the file"),
            {
              type: "assistant",
              uuid: "calling",
              message: {
                id: "tool-message",
                content: [{ type: "tool_use", id: "read", name: "Read", input: {} }],
              },
            },
          ],
          [50, 100],
          "stop-at-turn",
        );
      default:
        throw new Error("the read went past the last turn");
    }
  };
  const { controller, shown } = openTail();
  await shown;
  if (!opening) {
    expect(controller.state.history?.items).toHaveLength(1);
    await controller.loadEarlier();
  }
  if (opening || acrossTurn) {
    expect(controller.state.history?.items.map((item) => item.kind)).toEqual(
      acrossTurn ? ["user", "assistant", "assistant", "user"] : ["user", "assistant"],
    );
    expect(controller.state.history?.tools.read).toMatchObject({
      name: "Read",
      status: "done",
      result: { text: "large result" },
    });
    expect(requested).toEqual(
      acrossTurn
        ? [undefined, "large", "result", "middle", "beginning", "before-row"]
        : [undefined, "middle", "beginning", "before-row"],
    );
  } else {
    expect(
      controller.state.history?.items.map((item) => item.kind === "user" && item.uuid),
    ).toEqual(["fragmented", "recent"]);
    expect(requested).toEqual([undefined, "large", "middle", "beginning"]);
  }
  expect(completeReads).toBe(0);
});

/**
 * Another device reading a Claude chat not open here sees its conversation
 * once the transcript is read, without waiting for the program started on
 * it to be ready. The real ipc client is spread under a spy, so later
 * files keep its other exports.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Composer } from "../../../../../../src/renderer/components/chat/composer";
import { historyModel } from "../../../../../../src/renderer/services/chat/claude/history";
import {
  borrowedClaudeModels,
  useClaudeModelCatalog,
} from "../../../../../../src/renderer/services/chat/claude/model-catalog";
import { claudeModelLabel } from "../../../../../../src/renderer/services/chat/claude/settings-defaults";
import { currentModelInfo } from "../../../../../../src/renderer/services/chat/model";
import { chatChoicesOf } from "../../../../../../src/renderer/services/cli/chat-settings";
import { chatCommandsOf } from "../../../../../../src/renderer/services/remote/chat-commands";
import type { TranscriptPageResult } from "../../../../../../src/shared/ipc/contract";

import { type IpcErrResult, ipcErr } from "../../../../../../src/shared/ipc/result";

let releaseStart: () => void = () => {};
let started = false;
let replyToInitialize: ((requestId: string) => void) | undefined;
let onStartRequested: (() => void) | undefined;
let replayLog:
  | (() => { found: boolean; truncated: boolean; running: boolean; lastSeq: number })
  | undefined;
let transcriptPage:
  | ((
      cursor?: string,
      beforeAnchor?: string,
      before?: string[],
    ) => Promise<TranscriptPageResult | IpcErrResult>)
  | undefined;
let completeLines: readonly unknown[] | undefined;
let completeReads = 0;

const realIpc = await import("../../../../../../src/renderer/ipc/client");
mock.module("../../../../../../src/renderer/ipc/client", () => ({
  ...realIpc,
  ipcCallResult: (
    _channel: string,
    method: string,
    args: {
      message?: { request_id?: string };
      cursor?: string;
      beforeAnchor?: string;
      before?: string[];
    },
  ) => {
    if (method === "replay") {
      return Promise.resolve({ ok: true, value: replayLog?.() ?? { found: false } });
    }
    if (method === "transcriptPage" && transcriptPage) {
      return transcriptPage(args.cursor, args.beforeAnchor, args.before).then((value) =>
        "ok" in value ? value : { ok: true, value },
      );
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
  replayLog = undefined;
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

test.each([
  true,
  false,
])("controls after a truncated replay with initialize retained=%s", async (initialized) => {
  const c = new ChatController({ workspaceId: "ws-replay", tabId: "controls", cwd: "/p" });
  live.push(c);
  replayLog = () => {
    if (initialized) {
      c.receive({ dir: "sys", seq: 1, replay: true, message: { event: "start" } });
      c.receive({
        dir: "in",
        seq: 2,
        replay: true,
        message: {
          type: "control_request",
          request_id: "init",
          request: { subtype: "initialize" },
        },
      });
      c.receive({
        dir: "out",
        seq: 3,
        replay: true,
        message: {
          type: "control_response",
          response: {
            request_id: "init",
            subtype: "success",
            response: {
              commands: [{ name: "compact", description: "Compact this conversation" }],
              models: [
                {
                  value: "opus",
                  resolvedModel: "claude-opus-5-5",
                  displayName: "Opus 5.5",
                  supportedEffortLevels: ["high", "xhigh"],
                },
              ],
            },
          },
        },
      });
    }
    c.receive({
      dir: "out",
      seq: 8_000,
      replay: true,
      message: {
        type: "system",
        subtype: "init",
        model: "claude-opus-5-5",
        permissionMode: "plan",
        slash_commands: ["compact"],
      },
    });
    if (initialized) {
      c.receive({
        dir: "in",
        seq: 8_005,
        replay: true,
        message: {
          type: "control_request",
          request_id: "effort",
          request: { subtype: "apply_flag_settings", settings: { effortLevel: "xhigh" } },
        },
      });
      c.receive({
        dir: "out",
        seq: 8_006,
        replay: true,
        message: {
          type: "control_response",
          response: { request_id: "effort", subtype: "success" },
        },
      });
    }
    return { found: true, running: true, truncated: true, lastSeq: initialized ? 8_006 : 8_000 };
  };

  await c.open();
  const { model } = c.state;
  expect(model.process).toBe("running");
  expect(model.permissionMode).toBe("plan");
  if (initialized) {
    const selected = currentModelInfo(model.init?.models ?? [], model.model, model.chosenModel);
    expect(selected?.displayName).toBe("Opus 5.5");
    expect(selected?.supportedEffortLevels).toEqual(["high", "xhigh"]);
    expect(model.effort).toBe("xhigh");
    expect(model.init?.commands[0]?.description).toBe("Compact this conversation");
  } else {
    expect(model.init).toBeUndefined();
    expect(claudeModelLabel(model.model ?? "")).toBe("Opus 5.5");
    expect(claudeModelLabel("private-model")).toBe("private-model");
    expect(model.slashCommands).toEqual([{ name: "compact" }]);
    expect(model.effort).toBeUndefined();
  }
});

test("a truncated tab borrows model and effort options from its profile until its own list arrives", async () => {
  const tab = (tabId: string, profileId: string) => {
    const c = new ChatController({ workspaceId: `ws-${tabId}`, tabId, cwd: "/p", profileId });
    live.push(c);
    return c;
  };
  const older = tab("catalog-older", "claude-catalog-shared");
  const different = tab("catalog-other", "claude-catalog-other");
  const donor = tab("catalog-donor", "claude-catalog-shared");
  for (const c of [older, different]) {
    replayLog = () => {
      c.receive({
        dir: "out",
        seq: 900,
        replay: true,
        message: {
          type: "system",
          subtype: "init",
          model: "claude-opus-5-5",
          slash_commands: ["compact"],
        },
      });
      return { found: true, running: true, truncated: true, lastSeq: 900 };
    };
    await c.open();
  }

  const borrowed = (c: Controller) =>
    borrowedClaudeModels(useClaudeModelCatalog.getState(), c.modelCatalogKey, c.key);
  const render = (c: Controller) =>
    renderToStaticMarkup(
      createElement(Composer, {
        controller: c,
        state: c.state,
        fallbackModels: borrowed(c),
        local: true,
      }),
    );
  const button = (html: string, label: "Model" | "Effort") =>
    html.match(new RegExp(`<button\\b[^>]*aria-label="${label}"[^>]*>`))?.[0];
  const disabled = /\sdisabled=""/;
  expect(button(render(older), "Model")).toMatch(disabled);
  expect(button(render(older), "Effort")).toBeUndefined();

  const initialize = (c: Controller, displayName: string, supportedEffortLevels: string[]) => {
    const seq = c.state.model.lastSeq;
    c.receive({
      dir: "in",
      seq: seq + 1,
      message: {
        type: "control_request",
        request_id: "catalog-init",
        request: { subtype: "initialize" },
      },
    });
    c.receive({
      dir: "out",
      seq: seq + 2,
      message: {
        type: "control_response",
        response: {
          request_id: "catalog-init",
          subtype: "success",
          response: {
            commands: [{ name: "only-in-initialize" }],
            models: [
              {
                value: "opus",
                resolvedModel: "claude-opus-5-5",
                displayName,
                supportedEffortLevels,
              },
            ],
          },
        },
      },
    });
    c.flushNow();
  };

  initialize(donor, "Profile Opus", ["high", "xhigh"]);
  const shared = render(older);
  expect(button(shared, "Model")).toContain("Profile Opus");
  expect(button(shared, "Model")).not.toMatch(disabled);
  expect(button(shared, "Effort")).toBeDefined();
  expect(button(shared, "Effort")).not.toMatch(disabled);
  expect(button(render(different), "Model")).toMatch(disabled);
  expect(button(render(different), "Effort")).toBeUndefined();
  expect(older.state.model.init).toBeUndefined();
  expect(chatChoicesOf("claude", older.state.model)).toMatchObject({ models: [], efforts: [] });
  expect(chatCommandsOf("claude", older.state.model).map(({ name }) => name)).not.toContain(
    "only-in-initialize",
  );

  donor.dispose();
  expect(button(render(older), "Model")).toMatch(disabled);
  expect(button(render(older), "Effort")).toBeUndefined();

  initialize(older, "This Tab's Opus", []);
  initialize(tab("catalog-new-donor", "claude-catalog-shared"), "Updated Profile Opus", ["xhigh"]);
  expect(borrowed(older)?.[0]?.displayName).toBe("Updated Profile Opus");
  expect(render(older)).toContain("This Tab&#x27;s Opus");
  expect(button(render(older), "Effort")).toBeUndefined();
});

test.each([
  "complete",
  "transcript capped",
  "no overlap",
  "legacy transcript",
])("a truncated log checks its prefix in a %s", async (kind) => {
  const c = new ChatController({
    workspaceId: "ws-replay",
    tabId: "history",
    cwd: "/p",
    sessionId: "s-history",
  });
  live.push(c);
  replayLog = () => {
    c.receive({
      dir: "out",
      seq: 900,
      replay: true,
      message: { ...user("live", "live"), isReplay: true },
    });
    return { found: true, truncated: true, running: true, lastSeq: 900 };
  };
  transcriptPage = async (cursor, _anchor, before) => {
    if (cursor)
      return { ...page([user("first", "first")], [10]), truncated: kind === "transcript capped" };
    expect(before).toEqual(["live"]);
    if (kind === "legacy transcript") {
      return {
        found: true,
        truncated: false,
        lines: [user("first", "first"), user("live", "live")],
      };
    }
    return {
      ...page([user("recent", "recent")], [40], "earlier"),
      cutMatched: kind !== "no overlap",
      truncated: kind === "transcript capped",
    };
  };

  await c.open();
  if (kind === "no overlap") {
    expect(c.state.history).toBeNull();
    expect(c.state.truncated).toBe(true);
    return;
  }
  if (kind !== "legacy transcript") {
    expect(c.state.historyPage?.hasEarlier).toBe(true);
    await c.loadEarlier();
    expect(c.state.historyPage?.hasEarlier).toBe(false);
  }
  expect(c.state.history?.items[0]).toMatchObject({ uuid: "first" });
  expect(c.state.truncated).toBe(kind === "transcript capped");
});

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

test.each([
  "agent replaced",
  "stale cursor",
  "anchor missing",
  "legacy agent",
] as const)("earlier history resumes at the displayed boundary after %s", async (cause) => {
  const recent = user("recent", "recent");
  const old = user("old", "old");
  const liveRow = {
    type: "assistant",
    uuid: "live",
    message: { id: "live", content: [{ type: "text", text: "live output" }] },
  };
  completeLines = [old, recent, liveRow];
  const answer = {
    type: "assistant",
    uuid: "answer",
    message: { id: "answer", content: [{ type: "text", text: "older answer" }] },
  };
  const requests: { cursor?: string; beforeAnchor?: string }[] = [];
  transcriptPage = async (cursor, beforeAnchor) => {
    requests.push({ cursor, beforeAnchor });
    if (beforeAnchor) {
      expect(beforeAnchor).toBe("displayed-boundary");
      if (cause === "anchor missing") return { found: false, truncated: false, lines: [] };
      if (cause === "legacy agent")
        return { found: true, truncated: false, lines: [old, recent, liveRow] };
      return { ...page([old, answer], [50, 150]), anchored: true, snapshot: "new-snapshot" };
    }
    if (cursor === "previous") {
      return { ...page([answer], [150], "next"), beforeAnchor: "unpublished-boundary" };
    }
    if (cursor === "next") return ipcErr("chat.transcript-cursor-stale", "expired");
    return { ...page([recent], [250], "previous"), beforeAnchor: "displayed-boundary" };
  };

  const { controller, shown } = openTail();
  await shown;
  const recentKey = controller.state.history?.items[0]?.key;
  if (cause !== "stale cursor") {
    controller.receive({
      dir: "out",
      seq: 1,
      message: liveRow,
    });
    await controller.resync();
    expect(controller.state.historyPage?.hasEarlier).toBe(true);
  }

  await controller.loadEarlier();
  const items = controller.state.history?.items ?? [];
  const uuid = (item: (typeof items)[number]) => "uuid" in item && item.uuid;
  const fallback = cause === "anchor missing" || cause === "legacy agent";
  expect(items.map(uuid)).toEqual([
    "old",
    ...(fallback ? [] : ["answer"]),
    "recent",
    ...(cause === "stale cursor" ? [] : ["live"]),
  ]);
  if (!fallback) expect(items.find((item) => uuid(item) === "recent")?.key).toBe(recentKey);
  expect(requests.map((request) => request.cursor ?? request.beforeAnchor)).toEqual(
    cause === "stale cursor"
      ? [undefined, "previous", "next", "displayed-boundary"]
      : [undefined, "displayed-boundary"],
  );
  expect(completeReads).toBe(cause === "anchor missing" ? 1 : 0);
  expect(controller.state.historyPage?.hasEarlier ?? false).toBe(false);
});

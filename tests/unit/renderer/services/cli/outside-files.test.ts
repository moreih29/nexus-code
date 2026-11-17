/** The files outside a workspace its chats name, which another device may then read there. */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";

const globals = globalThis as Record<string, unknown>;
const saved = globals.window;
globals.window = {
  ...((saved as object | undefined) ?? {}),
  ipc: { call: async () => ({}), cancel: () => {}, on: () => () => {}, listen: () => () => {} },
};
afterAll(() => {
  globals.window = saved;
});

const { chatHandlers } = await import("../../../../../src/renderer/services/cli/chat-actions");
const { useTabsStore } = await import("../../../../../src/renderer/state/stores/tabs");
const { useWorkspacesStore } = await import("../../../../../src/renderer/state/stores/workspaces");
const { chatKey, emptyTabState, useChatStore } = await import(
  "../../../../../src/renderer/services/chat/store"
);
const { emptyModel } = await import("../../../../../src/renderer/services/chat/model");

const ROOT = "/Users/me/work";

function tab(id: string, type: string) {
  return { id, type, title: id, props: { cwd: ROOT } };
}

function said(key: string, text: string, ...tools: string[]) {
  return {
    kind: "assistant",
    key,
    messageId: `m-${key}`,
    uuid: `u-${key}`,
    blocks: [{ type: "text", text }, ...tools.map((id) => ({ type: "tool", toolUseId: id }))],
  };
}

function read(id: string, path: string) {
  return { id, name: "Read", input: { file_path: path }, status: "done", parentToolUseId: null };
}

beforeEach(() => {
  useWorkspacesStore.setState({
    workspaces: [{ id: "w1", name: "work", rootPath: ROOT }],
  } as never);
  useTabsStore.setState({
    byWorkspace: { w1: { c1: tab("c1", "claude"), t1: tab("t1", "terminal") } },
  } as never);
  useChatStore.setState({
    tabs: {
      [chatKey("w1", "c1")]: {
        ...emptyTabState(),
        history: {
          ...emptyModel(),
          items: [said("a", "see [it](/tmp/scale/old.jpg)")],
          tools: {},
        },
        model: {
          ...emptyModel(),
          items: [said("b", "drawn: [chart](/tmp/scale/chart.png)", "r1")],
          tools: {
            r1: read("r1", "/tmp/cam/frame.jpg"),
            r2: read("r2", `${ROOT}/inside.txt`),
          },
        },
      },
    },
  } as never);
});

describe("chat.outsideFiles", () => {
  test("what the chats link or their tools took outside the workspace, their history's too", async () => {
    const { files } = await chatHandlers["chat.outsideFiles"]({ workspaceId: "w1" } as never);
    expect([...files].sort()).toEqual(
      ["/tmp/cam/frame.jpg", "/tmp/scale/chart.png", "/tmp/scale/old.jpg"].sort(),
    );
  });

  test("nothing for a workspace it doesn't know", async () => {
    const { files } = await chatHandlers["chat.outsideFiles"]({ workspaceId: "w9" } as never);
    expect(files).toEqual([]);
  });
});

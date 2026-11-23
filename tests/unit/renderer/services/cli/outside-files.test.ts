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
const { forgetAttachFolders, inAttachFolder, noteAttached } = await import(
  "../../../../../src/renderer/services/chat/attach-folders"
);
const { relayedText } = await import("../../../../../src/shared/chat/relay");

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

function sent(key: string, text: string) {
  return { kind: "user", key, text, images: [], state: "taken" };
}

function read(id: string, path: string) {
  return { id, name: "Read", input: { file_path: path }, status: "done", parentToolUseId: null };
}

beforeEach(() => {
  forgetAttachFolders();
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

  test("of the images the user attached, only those the app wrote in the tab's attach folder", async () => {
    const attach = "/Users/me/.nexus-code/attach";
    // The agent answered chat.attach with a file here, once: the tab's folder is known since.
    noteAttached("w1", "c1", `${attach}/w1/c1/1/first.png`);
    const ours = `${attach}/w1/c1/2/shot.png`;
    const chat = useChatStore.getState().tabs[chatKey("w1", "c1")];
    useChatStore.setState({
      tabs: {
        [chatKey("w1", "c1")]: {
          ...chat,
          model: {
            ...chat.model,
            items: [
              ...chat.model.items,
              sent("u1", `look\n\n@${ours}`),
              sent("u2", "and\n\n@/Users/me/Pictures/private.png"),
              sent("u3", `@${attach}/w1/other-tab/1/theirs.png`),
              sent("u4", `@${attach}/w1/c1/2/../../../other-tab/1/theirs.png`),
              sent(
                "u5",
                relayedText(
                  { kind: "tab", name: "Other", tabId: "t2" },
                  `@${attach}/w1/c1/3/x.png`,
                ),
              ),
            ],
          },
        },
      },
    } as never);
    const { files } = await chatHandlers["chat.outsideFiles"]({ workspaceId: "w1" } as never);
    expect([...files].sort()).toEqual(
      ["/tmp/cam/frame.jpg", "/tmp/scale/chart.png", "/tmp/scale/old.jpg", ours].sort(),
    );
  });

  test("an attach folder is the one the agent's answer names, for that tab only", () => {
    const attach = "/Users/me/.nexus-code/attach";
    noteAttached("w1", "c1", `${attach}/w1/c1/1/a.png`);
    // Of another shape, or another tab's: no folder.
    noteAttached("w1", "c1", "/tmp/w1/c1/1/a.png");
    noteAttached("w1", "c1", `${attach}/w1/c2/1/a.png`);
    expect(inAttachFolder("w1", "c1", `${attach}/w1/c1/7/b.png`)).toBe(true);
    expect(inAttachFolder("w1", "c1", `${attach}/w1/c1/b.png`)).toBe(false);
    expect(inAttachFolder("w1", "c1", `${attach}/w1/c1/7/sub/b.png`)).toBe(false);
    expect(inAttachFolder("w1", "c1", "/tmp/w1/c1/1/a.png")).toBe(false);
    expect(inAttachFolder("w1", "c2", `${attach}/w1/c2/1/a.png`)).toBe(false);
    // On Windows, as the agent there answers.
    noteAttached("w1", "c3", "C:\\Users\\me\\.nexus-code\\attach\\w1\\c3\\1\\a.png");
    expect(inAttachFolder("w1", "c3", "C:/Users/me/.nexus-code/attach/w1/c3/2/b.png")).toBe(true);
  });

  test("nothing for a workspace it doesn't know", async () => {
    const { files } = await chatHandlers["chat.outsideFiles"]({ workspaceId: "w9" } as never);
    expect(files).toEqual([]);
  });
});

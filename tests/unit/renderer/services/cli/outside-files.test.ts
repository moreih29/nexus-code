/** The files outside a workspace its chats name, which another device may then read there. */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";

const globals = globalThis as Record<string, unknown>;
const saved = globals.window;
/** The attach root main answers chat.attachRoot with. */
let attachRoot: string | null = null;
globals.window = {
  ...((saved as object | undefined) ?? {}),
  ipc: {
    call: async (channel: string, method: string) =>
      channel === "chat" && method === "attachRoot" ? { root: attachRoot } : {},
    cancel: () => {},
    on: () => () => {},
    listen: () => () => {},
  },
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
const { attachRootOf, attachShaped, inAttachFolder } = await import(
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
  attachRoot = null;
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

  const ATTACH = "/Users/me/.nexus-code/attach";

  /** The c1 tab's conversation with these messages the user sent after what it had. */
  function userSent(...texts: string[]) {
    const chat = useChatStore.getState().tabs[chatKey("w1", "c1")];
    const items = texts.map((text, i) => sent(`u${i}`, text));
    useChatStore.setState({
      tabs: {
        [chatKey("w1", "c1")]: {
          ...chat,
          model: { ...chat.model, items: [...chat.model.items, ...items] },
        },
      },
    } as never);
  }

  const NAMED = ["/tmp/cam/frame.jpg", "/tmp/scale/chart.png", "/tmp/scale/old.jpg"];

  test("of the images the user attached, only those in the tab's folder under the agent's attach root", async () => {
    attachRoot = ATTACH;
    const ours = `${ATTACH}/w1/c1/2/shot.png`;
    userSent(
      `look\n\n@${ours}`,
      "and\n\n@/Users/me/Pictures/private.png",
      `@${ATTACH}/w1/other-tab/1/theirs.png`,
      `@${ATTACH}/w1/c1/2/../../../other-tab/1/theirs.png`,
      `@/tmp/attach/w1/c1/1/elsewhere.png`,
      relayedText({ kind: "tab", name: "Other", tabId: "t2" }, `@${ATTACH}/w1/c1/3/x.png`),
    );
    const { files } = await chatHandlers["chat.outsideFiles"]({ workspaceId: "w1" } as never);
    expect([...files].sort()).toEqual([...NAMED, ours].sort());
  });

  test("a file's name, as another device chose it, takes nothing out of the tab's folder", async () => {
    attachRoot = ATTACH;
    userSent(
      // Read as a link, %2F is a "/": these name /tmp/attach/w1/c1/1/y.png and 7/e/f.png.
      `@${ATTACH}/w1/c1/1/x${"%2F..".repeat(12)}%2Ftmp%2Fattach%2Fw1%2Fc1%2F1%2Fy.png`,
      `@${ATTACH}/w1/c1/7/e%2Ff.png`,
      // A link ends at # and ?, and :12 is its line: these name 4/a, 5/c.png and 6/d.png.
      `@${ATTACH}/w1/c1/4/a#b.png`,
      `@${ATTACH}/w1/c1/5/c.png?x=1`,
      `@${ATTACH}/w1/c1/6/d.png:12`,
    );
    const { files } = await chatHandlers["chat.outsideFiles"]({ workspaceId: "w1" } as never);
    expect([...files].sort()).toEqual(
      [...NAMED, `${ATTACH}/w1/c1/5/c.png`, `${ATTACH}/w1/c1/6/d.png`].sort(),
    );
  });

  test("no attached image while main knows no attach root, as before an SSH host connects", async () => {
    userSent(`@${ATTACH}/w1/c1/2/shot.png`);
    const { files } = await chatHandlers["chat.outsideFiles"]({ workspaceId: "w1" } as never);
    expect([...files].sort()).toEqual(NAMED);
  });

  test("an attach folder is the tab's, right below the root, a file in a numbered folder of it", async () => {
    expect(inAttachFolder(ATTACH, "w1", "c1", `${ATTACH}/w1/c1/7/b.png`)).toBe(true);
    expect(inAttachFolder(ATTACH, "w1", "c1", `${ATTACH}/w1/c1/b.png`)).toBe(false);
    expect(inAttachFolder(ATTACH, "w1", "c1", `${ATTACH}/w1/c1/x/b.png`)).toBe(false);
    expect(inAttachFolder(ATTACH, "w1", "c1", `${ATTACH}/w1/c1/7/sub/b.png`)).toBe(false);
    expect(inAttachFolder(ATTACH, "w1", "c1", `${ATTACH}/w1/c2/7/b.png`)).toBe(false);
    expect(inAttachFolder(ATTACH, "w1", "c1", "/tmp/attach/w1/c1/7/b.png")).toBe(false);
    // A Windows root, as main answers it, is written as resolveFilePath writes paths.
    attachRoot = "c:\\Users\\me\\.nexus-code\\attach\\";
    const root = await attachRootOf("w1");
    expect(root).toBe("C:/Users/me/.nexus-code/attach");
    expect(
      inAttachFolder(root ?? "", "w1", "c1", "C:/Users/me/.nexus-code/attach/w1/c1/2/b.png"),
    ).toBe(true);
  });

  test("another computer's tab tells the attached files that computer serves by their place", () => {
    expect(attachShaped("w1", "c1", `${ATTACH}/w1/c1/2/b.png`)).toBe(true);
    expect(attachShaped("w1", "c1", "C:/Users/me/.nexus-code/attach/w1/c1/2/b.png")).toBe(true);
    expect(attachShaped("w1", "c1", "/Users/me/Desktop/b.png")).toBe(false);
    expect(attachShaped("w1", "c1", `${ATTACH}/w1/c2/2/b.png`)).toBe(false);
    expect(attachShaped("w1", "c1", `${ATTACH}/w1/c1/b.png`)).toBe(false);
  });

  test("nothing for a workspace it doesn't know", async () => {
    const { files } = await chatHandlers["chat.outsideFiles"]({ workspaceId: "w9" } as never);
    expect(files).toEqual([]);
  });
});

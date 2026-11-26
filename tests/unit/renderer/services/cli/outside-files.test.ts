import { afterAll, beforeEach, describe, expect, test } from "bun:test";

const globals = globalThis as Record<string, unknown>;
const saved = globals.window;
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
const { attachRootOf, attachShaped, attachSlotOf } = await import(
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

  test("of the files the user attached, only those in the workspace's attach folder under the agent's root", async () => {
    attachRoot = ATTACH;
    const ours = `${ATTACH}/w1/c1/2/shot.png`;
    const before = `${ATTACH}/w1/other-tab/1/theirs.pdf`;
    userSent(
      `look\n\n@${ours}`,
      "and\n\n@/Users/me/Documents/private.md",
      `@${before}`,
      `@${ATTACH}/w1/c1/2/../../../other-tab/1/theirs.pdf`,
      `@${ATTACH}/w2/c9/1/another-workspace.png`,
      `@/tmp/attach/w1/c1/1/elsewhere.png`,
      relayedText({ kind: "tab", name: "Other", tabId: "t2" }, `@${ATTACH}/w1/c1/3/x.png`),
    );
    const { files } = await chatHandlers["chat.outsideFiles"]({ workspaceId: "w1" } as never);
    expect([...files].sort()).toEqual([...NAMED, ours, before].sort());
  });

  test("an attached image of the workspace no message here names is not served", async () => {
    attachRoot = ATTACH;
    userSent("nothing attached");
    const { files } = await chatHandlers["chat.outsideFiles"]({ workspaceId: "w1" } as never);
    expect(files).not.toContain(`${ATTACH}/w1/other-tab/1/theirs.png`);
  });

  test("a file's name, as another device chose it, takes nothing out of the tab's folder", async () => {
    attachRoot = ATTACH;
    const attached = [
      `${ATTACH}/w1/c1/1/x${"%2F..".repeat(12)}%2Ftmp%2Fattach%2Fw1%2Fc1%2F1%2Fy.png`,
      `${ATTACH}/w1/c1/7/e%2Ff.png`,
      `${ATTACH}/w1/c1/4/a#b.png`,
      `${ATTACH}/w1/c1/5/c.png?x=1`,
      `${ATTACH}/w1/c1/6/d.png:12`,
    ];
    userSent(...attached.map((file) => `@${file}`));
    const { files } = await chatHandlers["chat.outsideFiles"]({ workspaceId: "w1" } as never);
    expect([...files].sort()).toEqual([...NAMED, ...attached].sort());
  });

  test("no attached image while main knows no attach root, as before an SSH host connects", async () => {
    userSent(`@${ATTACH}/w1/c1/2/shot.png`);
    const { files } = await chatHandlers["chat.outsideFiles"]({ workspaceId: "w1" } as never);
    expect([...files].sort()).toEqual(NAMED);
  });

  test("an attachment is a file right in a numbered folder of a tab's folder below the root", async () => {
    expect(attachSlotOf(ATTACH, "w1", `${ATTACH}/w1/c1/7/b.png`)).toBe("c1/7");
    expect(attachSlotOf(ATTACH, "w1", `${ATTACH}/w1/c2/7/b.png`)).toBe("c2/7");
    expect(attachSlotOf(ATTACH, "w1", `${ATTACH}/w1/c1/b.png`)).toBeNull();
    expect(attachSlotOf(ATTACH, "w1", `${ATTACH}/w1/c1/x/b.png`)).toBeNull();
    expect(attachSlotOf(ATTACH, "w1", `${ATTACH}/w1/c1/7/sub/b.png`)).toBeNull();
    expect(attachSlotOf(ATTACH, "w1", `${ATTACH}/w1/../7/b.png`)).toBeNull();
    expect(attachSlotOf(ATTACH, "w1", `${ATTACH}/w1/./7/b.png`)).toBeNull();
    expect(attachSlotOf(ATTACH, "w1", `${ATTACH}/w2/c1/7/b.png`)).toBeNull();
    expect(attachSlotOf(ATTACH, "w1", "/tmp/attach/w1/c1/7/b.png")).toBeNull();
    const long = "t".repeat(128);
    expect(attachSlotOf(ATTACH, "w1", `${ATTACH}/w1/${long}/123456789/b.png`)).toBe(
      `${long}/123456789`,
    );
    expect(attachSlotOf(ATTACH, "w1", `${ATTACH}/w1/${long}t/7/b.png`)).toBeNull();
    expect(attachSlotOf(ATTACH, "w1", `${ATTACH}/w1/c1/1234567890/b.png`)).toBeNull();
    expect(attachSlotOf(ATTACH, "w1", `${ATTACH}/w1/${"x".repeat(301)}/7/b.png`)).toBeNull();
    expect(attachSlotOf(ATTACH, "w1", `${ATTACH}/w1/c1./7/b.png`)).toBeNull();
    expect(attachSlotOf(ATTACH, "w1", `${ATTACH}/w1/c1:s/7/b.png`)).toBeNull();
    expect(attachSlotOf(ATTACH, "w1", `${ATTACH}/w1/c 1/7/b.png`)).toBeNull();
    attachRoot = "c:\\Users\\me\\.nexus-code\\attach\\";
    const root = await attachRootOf("w1");
    expect(root).toBe("C:/Users/me/.nexus-code/attach");
    expect(attachSlotOf(root ?? "", "w1", "C:/Users/me/.nexus-code/attach/w1/c1/2/b.png")).toBe(
      "c1/2",
    );
  });

  test("another computer's tab tells the attached files that computer serves by their place", () => {
    expect(attachShaped("w1", `${ATTACH}/w1/c1/2/b.png`)).toBe(true);
    expect(attachShaped("w1", "C:/Users/me/.nexus-code/attach/w1/c1/2/b.png")).toBe(true);
    expect(attachShaped("w1", `${ATTACH}/w1/c2/2/b.png`)).toBe(true);
    expect(attachShaped("w1", "/Users/me/Desktop/b.png")).toBe(false);
    expect(attachShaped("w1", `${ATTACH}/w2/c1/2/b.png`)).toBe(false);
    expect(attachShaped("w1", `${ATTACH}/w1/c1/b.png`)).toBe(false);
  });

  test("under a Windows network home, no attachment is served: links never reach a share", async () => {
    attachRoot = "\\\\server\\share\\Users\\k\\.nexus-code\\attach";
    useWorkspacesStore.setState({
      workspaces: [{ id: "w2", name: "win", rootPath: "C:\\work" }],
    } as never);
    useTabsStore.setState({
      byWorkspace: {
        w2: { c2: { id: "c2", type: "claude", title: "c2", props: { cwd: "C:\\work" } } },
      },
    } as never);
    const share = "\\\\server\\share\\Users\\k";
    useChatStore.setState({
      tabs: {
        [chatKey("w2", "c2")]: {
          ...emptyTabState(),
          model: {
            ...emptyModel(),
            items: [
              sent("u1", `@${share}\\.nexus-code\\attach\\w2\\c2\\1\\a.png`),
              sent("u2", `@${share}\\Pictures\\b.png`),
              sent("u3", `@${share}\\.nexus-code\\attach\\w2\\other\\1\\c.png`),
              sent("u4", "@\\\\server\\other\\Users\\k\\.nexus-code\\attach\\w2\\c2\\1\\d.png"),
            ],
            tools: {},
          },
        },
      },
    } as never);
    const { files } = await chatHandlers["chat.outsideFiles"]({ workspaceId: "w2" } as never);
    expect(files).toEqual([]);
    expect(await attachRootOf("w2")).toBeNull();
  });

  test("a Windows workspace tells a file its agent changed on a share by its network path", async () => {
    useWorkspacesStore.setState({
      workspaces: [{ id: "w3", name: "win", rootPath: "C:\\work" }],
    } as never);
    useTabsStore.setState({
      byWorkspace: {
        w3: { c3: { id: "c3", type: "claude", title: "c3", props: { cwd: "C:\\work" } } },
      },
    } as never);
    const tool = (id: string, name: string, path: string, status = "done") => ({
      id,
      name,
      input: { file_path: path },
      status,
      parentToolUseId: null,
    });
    useChatStore.setState({
      tabs: {
        [chatKey("w3", "c3")]: {
          ...emptyTabState(),
          model: {
            ...emptyModel(),
            items: [said("a", "see [it](\\\\linked\\share\\a.png)", "w", "e", "x", "r")],
            tools: {
              w: tool("w", "Write", "\\\\localhost\\C$\\tmp\\x\\unc.txt"),
              e: tool("e", "Edit", "C:\\tmp\\out\\lower.txt"),
              x: tool("x", "Write", "\\\\denied\\share\\x.txt", "error"),
              r: tool("r", "Read", "\\\\read\\share\\a.txt"),
            },
          },
        },
      },
    } as never);
    const { files } = await chatHandlers["chat.outsideFiles"]({ workspaceId: "w3" } as never);
    expect(files).toContain("//localhost/C$/tmp/x/unc.txt");
    expect(files).toContain("C:/tmp/out/lower.txt");
    expect(files.filter((file) => file.startsWith("//"))).toEqual(["//localhost/C$/tmp/x/unc.txt"]);
  });

  test("nothing for a workspace it doesn't know", async () => {
    const { files } = await chatHandlers["chat.outsideFiles"]({ workspaceId: "w9" } as never);
    expect(files).toEqual([]);
  });
});

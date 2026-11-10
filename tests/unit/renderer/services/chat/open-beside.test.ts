import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// The workspace's files, by their path from its root.
const files = new Set(["notes/a.ts:12", "src/a.ts"]);
const stats: string[] = [];
mock.module("../../../../../src/renderer/ipc/client", () => ({
  ipcCallResult: (channel: string, _method: string, args: { relPath: string }) => {
    // Activating a workspace, from the agent view, asks main to connect it.
    if (channel !== "fs") return Promise.resolve({ ok: true as const, value: undefined });
    stats.push(args.relPath);
    return Promise.resolve(
      files.has(args.relPath)
        ? { ok: true as const, value: { size: 1, mtime: 0, type: "file" } }
        : { ok: false as const, error: { code: "ENOENT" } },
    );
  },
  ipcListen: () => () => {},
  canUseIpcBridge: () => false,
}));

const { fileLinkTarget, openFileBeside } = await import(
  "../../../../../src/renderer/services/chat/open-beside"
);
const { resolveFileLink } = await import("../../../../../src/renderer/services/chat/links");
const { useActiveStore } = await import("../../../../../src/renderer/state/stores/active");
const { __resetAgentViewForTests, useAgentViewStore } = await import(
  "../../../../../src/renderer/state/stores/agent-view"
);
const { useLayoutStore } = await import("../../../../../src/renderer/state/stores/layout/store");
const { useTabsStore } = await import("../../../../../src/renderer/state/stores/tabs");
const { useWorkspacesStore } = await import("../../../../../src/renderer/state/stores/workspaces");
const { MANAGER_TAB_ID, MANAGER_WORKSPACE_ID } = await import(
  "../../../../../src/shared/manager/manager"
);

const target = (href: string) => {
  const link = resolveFileLink(href, "/w");
  if (!link) throw new Error(`no link: ${href}`);
  return fileLinkTarget("ws", "/w", link);
};

describe("the file a line link opens", () => {
  test("a file named with the colon is the one meant, when there is one", async () => {
    expect(await target("notes/a.ts:12")).toEqual({ path: "/w/notes/a.ts:12" });
  });

  test("otherwise the file before the colon, at the line", async () => {
    expect(await target("src/a.ts:12:3")).toEqual({
      path: "/w/src/a.ts",
      line: 12,
      column: 3,
      literal: "/w/src/a.ts:12:3",
    });
  });

  test("nothing is looked up for a link without a line, or one outside the workspace", async () => {
    stats.length = 0;
    expect(await target("src/a.ts")).toEqual({ path: "/w/src/a.ts" });
    expect(await target("/elsewhere/b.ts:4")).toMatchObject({ path: "/elsewhere/b.ts", line: 4 });
    expect(stats).toEqual([]);
  });
});

describe("what the agent manager's conversation opens", () => {
  const SHOWN = "00000000-0000-4000-8000-0000000000b1";
  const HOLDER = "00000000-0000-4000-8000-0000000000b2";
  const REMOTE = "00000000-0000-4000-8000-0000000000b3";
  const meta = (id: string, rootPath: string, kind: "local" | "ssh" = "local") => ({
    id,
    name: id.slice(-2),
    location:
      kind === "local"
        ? { kind, rootPath }
        : { kind, host: "h", user: "u", port: 22, remotePath: rootPath, authMode: "agent" },
    rootPath,
    colorTone: "default" as const,
    pinned: false,
    tabs: [],
    sortOrder: 0,
    pinnedSortOrder: 0,
  });
  const tabsOf = (workspaceId: string) =>
    Object.values(useTabsStore.getState().byWorkspace[workspaceId] ?? {});

  beforeEach(() => {
    useLayoutStore.setState({ byWorkspace: {} });
    useTabsStore.setState({ byWorkspace: {} });
    useWorkspacesStore.setState({
      workspaces: [
        meta(SHOWN, "/shown"),
        meta(HOLDER, "/repo"),
        meta(REMOTE, "/home/u/proj", "ssh"),
      ] as never,
    });
    useActiveStore.getState().setActiveWorkspaceId(SHOWN);
    useAgentViewStore.getState().setMode("agents");
  });

  afterEach(() => {
    __resetAgentViewForTests();
  });

  test("one no workspace holds opens read-only in the one shown", () => {
    openFileBeside(MANAGER_WORKSPACE_ID, MANAGER_TAB_ID, "/elsewhere/b.ts", {
      split: true,
      inside: false,
    });
    expect(useActiveStore.getState().activeWorkspaceId).toBe(SHOWN);
    expect(tabsOf(SHOWN)[0]?.props).toMatchObject({ origin: "external", readOnly: true });
    expect(tabsOf(MANAGER_WORKSPACE_ID)).toEqual([]);
  });
});

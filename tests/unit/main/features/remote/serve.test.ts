/** What this device serves the others: its sessions, as the CLI's services see them. */
import { describe, expect, test } from "bun:test";
import type { CliServices } from "../../../../../src/main/features/cli/context";
import { listSessions, serveWith } from "../../../../../src/main/features/remote/serve";

function services(): CliServices {
  const workspaces = [
    { id: "w1", name: "app", rootPath: "/src/app" },
    { id: "w2", name: "feat", rootPath: "/src/app-feat", task: { parentId: "w1", branch: "feat" } },
    { id: "w3", name: "closed", rootPath: "/src/closed" },
  ];
  const tabs: Record<string, { id: string; type: string; title: string }[]> = {
    w1: [
      { id: "t1", type: "claude", title: "Fix the build" },
      { id: "t2", type: "terminal", title: "zsh" },
      { id: "t3", type: "editor", title: "a.ts" },
    ],
    w2: [{ id: "t4", type: "codex", title: "Review" }],
  };
  return {
    listWorkspaces: () => workspaces,
    claudeStatus: (_w: string, tab: string) =>
      tab === "t2" ? { status: "permissionPending", message: "Allow rm?", since: 5 } : null,
    activity: () => null,
    ui: async (op: string, args: { workspaceId: string; tabId?: string }) => {
      if (op === "tabs.list") {
        const list = tabs[args.workspaceId];
        if (!list) throw new Error("not open");
        return { tabs: list };
      }
      if (args.tabId === "t1") {
        return {
          agent: "claude",
          state: "asking",
          message: "May I run\n  bun test?",
          since: 10,
          profile: "work",
          request: { id: "r1", tool: "Bash", input: "bun test" },
        };
      }
      return { agent: "codex", state: "working", since: 20 };
    },
  } as unknown as CliServices;
}

describe("serving the sessions", () => {
  test("lists the chats and terminals of every workspace, in the app's order", async () => {
    const list = await listSessions(services());
    expect(list.workspaces.map((w) => w.id)).toEqual(["w1", "w2", "w3"]);
    expect(list.workspaces[0]).toEqual({ id: "w1", name: "app", path: "/src/app" });
    expect(list.sessions).toEqual([
      {
        workspaceId: "w1",
        tabId: "t1",
        kind: "claude",
        title: "Fix the build",
        state: "needs-you",
        since: 10,
        last: "May I run bun test?",
        profile: "work",
        waiting: { kind: "permission", text: "bun test" },
      },
      {
        workspaceId: "w1",
        tabId: "t2",
        kind: "terminal",
        title: "zsh",
        state: "needs-you",
        since: 5,
        last: "Allow rm?",
      },
      {
        workspaceId: "w2",
        tabId: "t4",
        kind: "codex",
        title: "Review",
        state: "running",
        since: 20,
      },
    ]);
  });

  test("is unavailable until the app made its services, and serves nothing else yet", async () => {
    await expect(
      serveWith(() => null)({ from: "d", method: "sessions.list", params: {} }),
    ).rejects.toMatchObject({ code: 1003 });
    await expect(
      serveWith(services)({ from: "d", method: "chat.read", params: {} }),
    ).rejects.toMatchObject({ code: -32601 });
  });
});

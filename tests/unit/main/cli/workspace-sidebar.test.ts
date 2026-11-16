/**
 * nexus workspace pin, unpin and move: the sidebar's rows changed
 * from a terminal, another workspace's with the user's leave; and workspace
 * list, in the sidebar's order, here or on another computer.
 */
import { describe, expect, test } from "bun:test";
import { CLI_COMMANDS } from "../../../../src/main/features/cli/commands";
import type { CliDevice } from "../../../../src/main/features/cli/context";
import { runCli } from "../../../../src/main/features/cli/registry";
import { API, APP, contextFor, type FakeApp, FIX, fakeApp, SHELL_TAB } from "./fake-services";

/** A terminal of "api". */
const IN_API = { workspaceId: API, tabId: "bbbbbbbb-0000-4000-8000-000000000003" };
const MINI = "9b1e44d2-0000-4000-8000-000000000002";

async function nexus(
  app: FakeApp,
  argv: string[],
  caller = { workspaceId: APP, tabId: SHELL_TAB },
) {
  return runCli(CLI_COMMANDS, contextFor(app, argv, caller));
}

/** The sidebar's rows, top to bottom, as workspace list --json gives them. */
async function sidebar(app: FakeApp): Promise<string[]> {
  const listed = JSON.parse((await nexus(app, ["workspace", "list", "--json"])).stdout);
  return listed
    .filter((w: { worktree?: unknown }) => !w.worktree)
    .map((w: { name: string; pinned: boolean }) => `${w.name}${w.pinned ? " (pinned)" : ""}`);
}

describe("workspace pin and unpin", () => {
  test("pins another workspace with leave, to the top of the list", async () => {
    const app = fakeApp();
    app.answers.push("once");
    const result = await nexus(app, ["workspace", "pin", "api"]);
    expect(result.stdout).toBe("Pinned api (22222222).\n");
    expect(app.asked[0]).toMatchObject({ toWorkspaceId: API, change: { kind: "workspacePin" } });
    expect(await sidebar(app)).toEqual(["api (pinned)", "app"]);
    const listed = (await nexus(app, ["workspace", "list"])).stdout;
    expect(listed.split("\n")[1]).toMatch(/^22222222 {2}api +local +pinned +\/w\/api$/);
  });

  test("says so, asking nothing, when it is already as asked", async () => {
    const app = fakeApp();
    const result = await nexus(app, ["workspace", "unpin", "api"]);
    expect(result.stdout).toBe("api is not pinned.\n");
    expect(app.asked).toEqual([]);
    expect(app.sidebar).toEqual([]);
  });
});

describe("workspace move", () => {
  test("puts a workspace above another, and asks nothing for its own", async () => {
    const app = fakeApp();
    const result = await nexus(app, ["workspace", "move", "api", "--before", "app"], IN_API);
    expect(result.stdout).toBe("Moved api above app.\n");
    expect(app.sidebar).toEqual([{ id: API, to: { beforeId: APP, group: "unpinned" } }]);
    expect(app.asked).toEqual([]);
    expect(await sidebar(app)).toEqual(["api", "app"]);
  });

  test("next to a pinned one pins it; --top and --bottom keep it in its group", async () => {
    const app = fakeApp();
    app.settings.crossWorkspace = "allow";
    await nexus(app, ["workspace", "pin", "app"]);
    const pinned = await nexus(app, ["workspace", "move", "api", "--after", "app"]);
    expect(pinned.stdout).toBe("Moved api below app; it is pinned now.\n");
    expect(await sidebar(app)).toEqual(["app (pinned)", "api (pinned)"]);
    const top = await nexus(app, ["workspace", "move", "api", "--top"]);
    expect(top.stdout).toBe("Moved api first of the pinned workspaces.\n");
    expect(app.sidebar.at(-1)).toEqual({ id: API, to: { beforeId: APP, group: "pinned" } });
    expect(await sidebar(app)).toEqual(["api (pinned)", "app (pinned)"]);
    await nexus(app, ["workspace", "move", "api", "--bottom"]);
    expect(app.sidebar.at(-1)).toEqual({ id: API, to: { group: "pinned" } });
  });

  test("takes one place, not itself nor a worktree", async () => {
    const app = fakeApp();
    for (const flags of [[], ["--top", "--bottom"], ["--before", "app", "--top"]]) {
      const result = await nexus(app, ["workspace", "move", "api", ...flags]);
      expect(result.stderr).toContain("give one of --before, --after, --top or --bottom");
      expect(result.exitCode).toBe(2);
    }
    const itself = await nexus(app, ["workspace", "move", "api", "--before", "api"]);
    expect(itself.stderr).toBe("nexus: a workspace does not go next to itself\n");
    const worktree = await nexus(app, ["workspace", "move", "api", "--after", FIX]);
    expect(worktree.stderr).toBe("nexus: fix-login is a worktree, under app in the sidebar\n");
    expect(app.sidebar).toEqual([]);
  });
});

describe("workspace list --device", () => {
  function withPeer(): FakeApp {
    const app = fakeApp();
    const device = (over: Partial<CliDevice> & Pick<CliDevice, "id" | "name">): CliDevice => ({
      platform: "macos",
      self: false,
      online: true,
      serves: ["sessions", "agents"],
      ...over,
    });
    app.peers.devices = [
      device({ id: "3f2a91c0-0000-4000-8000-000000000001", name: "MacBook", self: true }),
      device({ id: MINI, name: "Mac mini" }),
    ];
    app.peers.answer = async (_d, method) => {
      if (method !== "sessions.list") throw new Error(`no answer for ${method}`);
      return {
        workspaces: [
          { id: "dddddddd-0000-4000-8000-0000000000aa", name: "site", path: "/s", pinned: true },
          {
            id: "eeeeeeee-0000-4000-8000-0000000000ab",
            name: "fix",
            path: "/w/fix",
            parentId: "dddddddd-0000-4000-8000-0000000000aa",
            git: { branch: "fix", ahead: 0, behind: 0, uncommitted: 0 },
          },
        ],
        sessions: [],
      };
    };
    return app;
  }

  test("lists the other computer's workspaces as it tells them", async () => {
    const app = withPeer();
    const result = await nexus(app, ["workspace", "list", "--device", "Mac mini"]);
    expect(result.stdout).toBe(
      [
        "ID        NAME   KIND                  PATH",
        "dddddddd  site   workspace     pinned  /s",
        "eeeeeeee    fix  worktree:fix          /w/fix",
        "",
      ].join("\n"),
    );
    const json = JSON.parse(
      (await nexus(app, ["workspace", "list", "--device", "Mac mini", "--json"])).stdout,
    );
    expect(json[0]).toMatchObject({ name: "site", device: { id: MINI, name: "Mac mini" } });
  });
});

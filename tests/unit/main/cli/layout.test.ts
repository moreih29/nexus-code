/**
 * nexus arranging the workbench: layout show/split/resize/even/close, tab
 * move/rename/pin, the panels, reveal and problems, against a fake app whose
 * "app" workspace is split in two columns: g1 (zsh, Claude) | g2 (index.ts,
 * Vite App).
 */
import { describe, expect, test } from "bun:test";
import { CLI_COMMANDS } from "../../../../src/main/features/cli/commands";
import { evenRatios, groupsOf } from "../../../../src/main/features/cli/commands/layout";
import { runCli } from "../../../../src/main/features/cli/registry";
import type { CliLayoutNode } from "../../../../src/shared/cli/ui";
import {
  API,
  APP,
  BROWSER_TAB,
  CLAUDE_TAB,
  contextFor,
  EDITOR_TAB,
  type FakeApp,
  fakeApp,
  SHELL_TAB,
} from "./fake-services";

async function nexus(app: FakeApp, argv: string[]) {
  return runCli(CLI_COMMANDS, contextFor(app, argv));
}

function lastCall(app: FakeApp, op: string): unknown {
  return app.uiCalls.filter((c) => c.op === op).at(-1)?.args;
}

const g = (id: string, tabIds: string[] = []): CliLayoutNode => ({
  kind: "group",
  id,
  tabIds,
  shownTabId: tabIds[0] ?? null,
});

describe("layout", () => {
  test("show draws the splits and numbers the groups", async () => {
    const result = await nexus(fakeApp(), ["layout", "show"]);
    expect(result.stdout).toBe(
      "side by side, 50% | 50%\n" +
        "  group 1 (g1), active: *zsh, ✳ Claude Code\n" +
        "  group 2 (g2): *index.ts, Vite App\n",
    );
  });

  test("split moves a tab into a new group on a side of its own, or of --of", async () => {
    const app = fakeApp();
    const result = await nexus(app, [
      "layout",
      "split",
      "aaaaaaaa-0000-4000-8000-000000000002",
      "down",
    ]);
    expect(result.stdout).toBe("Moved ✳ Claude Code into a new group below group 1.\n");
    expect(lastCall(app, "layout.split")).toEqual({
      workspaceId: APP,
      tabId: CLAUDE_TAB,
      groupId: "g1",
      side: "down",
    });
    await nexus(app, ["layout", "split", "index.ts", "right", "--of", "1"]);
    expect(lastCall(app, "layout.split")).toMatchObject({ tabId: EDITOR_TAB, groupId: "g1" });
    expect((await nexus(app, ["layout", "split", "zsh", "sideways"])).exitCode).toBe(2);
  });

  test("resize sets the share of the group's side of its split", async () => {
    const app = fakeApp();
    expect((await nexus(app, ["layout", "resize", "2", "30%"])).stdout).toBe(
      "Group 2 now takes 30% of the width it shares.\n",
    );
    expect(lastCall(app, "layout.ratios")).toEqual({
      workspaceId: APP,
      ratios: [{ splitId: "s1", ratio: 0.7 }],
    });
    await nexus(app, ["layout", "resize", ".", "25"]);
    expect(lastCall(app, "layout.ratios")).toMatchObject({
      ratios: [{ splitId: "s1", ratio: 0.25 }],
    });
    const tall = await nexus(app, ["layout", "resize", "1", "40%", "--height"]);
    expect(tall.stderr).toBe("nexus: group 1 is not above or below another group\n");
    expect((await nexus(app, ["layout", "resize", "1", "99%"])).exitCode).toBe(2);
  });

  test("a group is named by number, id or one of its tabs", async () => {
    const app = fakeApp();
    await nexus(app, ["layout", "resize", "Vite App", "60"]);
    expect(lastCall(app, "layout.ratios")).toMatchObject({ ratios: [{ ratio: 0.4 }] });
    expect((await nexus(app, ["layout", "resize", "3", "60"])).stderr).toBe(
      "nexus: app has no group 3; it has 2\n",
    );
  });

  test("evenRatios gives each group in a row the same share", () => {
    const root: CliLayoutNode = {
      kind: "split",
      id: "a",
      direction: "columns",
      ratio: 0.8,
      first: g("1"),
      second: {
        kind: "split",
        id: "b",
        direction: "columns",
        ratio: 0.3,
        first: g("2"),
        second: {
          kind: "split",
          id: "c",
          direction: "rows",
          ratio: 0.9,
          first: g("3"),
          second: g("4"),
        },
      },
    };
    expect(evenRatios(root)).toEqual([
      { splitId: "a", ratio: 1 / 3 },
      { splitId: "b", ratio: 0.5 },
      { splitId: "c", ratio: 0.5 },
    ]);
    expect(groupsOf(root).map((x) => [x.number, x.id, x.ancestors.length])).toEqual([
      [1, "1", 1],
      [2, "2", 2],
      [3, "3", 3],
      [4, "4", 3],
    ]);
  });

  test("close closes a group, but never this terminal's", async () => {
    const app = fakeApp();
    expect((await nexus(app, ["layout", "close", "2"])).stdout).toBe(
      "Closed group 2 and its 2 tabs.\n",
    );
    expect(lastCall(app, "group.close")).toEqual({ workspaceId: APP, groupId: "g2", force: false });
    expect((await nexus(app, ["layout", "close", "1"])).stderr).toBe(
      "nexus: group 1 holds this terminal; nexus does not close it\n",
    );
  });

  test("changing another workspace's layout asks the user", async () => {
    const app = fakeApp();
    const refused = await nexus(app, ["layout", "even", "--workspace", "api"]);
    expect(refused.stdout).toBe("api has one group.\n");
    await nexus(app, ["layout", "close", "1", "--workspace", "api"]);
    expect(app.asked.map((r) => [r.toWorkspaceId, r.change])).toEqual([
      [API, { kind: "groupClose", detail: "1" }],
    ]);
  });
});

describe("tabs", () => {
  test("move puts a tab in another group, or at a place in its own", async () => {
    const app = fakeApp();
    expect((await nexus(app, ["tab", "move", "Vite App", "1"])).stdout).toBe(
      "Moved Vite App to group 1.\n",
    );
    expect(lastCall(app, "tab.move")).toEqual({
      workspaceId: APP,
      tabId: BROWSER_TAB,
      groupId: "g1",
    });
    await nexus(app, ["tab", "move", "Vite App", "1", "--at", "1"]);
    expect(lastCall(app, "tab.move")).toMatchObject({ groupId: "g1", index: 0 });
    // Moving right within its own group: the slot past the tab now at that place.
    await nexus(app, ["tab", "move", "index.ts", "2", "--at", "2"]);
    expect(lastCall(app, "tab.move")).toMatchObject({ groupId: "g2", index: 2 });
    expect((await nexus(app, ["tab", "move", "index.ts", "2"])).exitCode).toBe(1);
  });

  test("rename names a tab, and --reset drops the name", async () => {
    const app = fakeApp();
    expect((await nexus(app, ["tab", "rename", CLAUDE_TAB, "reviewer", "bot"])).stdout).toBe(
      'aaaaaaaa is now "reviewer bot".\n',
    );
    expect(lastCall(app, "tab.rename")).toEqual({
      workspaceId: APP,
      tabId: CLAUDE_TAB,
      title: "reviewer bot",
    });
    await nexus(app, ["tab", "rename", "zsh", "--reset"]);
    expect(lastCall(app, "tab.rename")).toEqual({ workspaceId: APP, tabId: SHELL_TAB, title: "" });
    expect((await nexus(app, ["tab", "rename", "zsh"])).exitCode).toBe(2);
  });

  test("pin and unpin", async () => {
    const app = fakeApp();
    await nexus(app, ["tab", "pin", "index.ts"]);
    expect(lastCall(app, "tab.pin")).toEqual({ workspaceId: APP, tabId: EDITOR_TAB, pinned: true });
    await nexus(app, ["tab", "unpin", "index.ts"]);
    expect(lastCall(app, "tab.pin")).toMatchObject({ pinned: false });
  });
});

describe("panels, reveal and problems", () => {
  test("panel show, hide, resize and list", async () => {
    const app = fakeApp();
    expect((await nexus(app, ["panel", "show", "git"])).stdout).toBe("Showing git.\n");
    expect(lastCall(app, "panels.set")).toEqual({
      workspaceId: APP,
      panel: "files",
      visible: true,
      mode: "git",
    });
    await nexus(app, ["panel", "hide", "sidebar"]);
    expect((await nexus(app, ["panel", "resize", "files", "900px"])).stdout).toBe(
      "The files panel is 600px wide.\n",
    );
    expect((await nexus(app, ["panel", "list"])).stdout).toBe(
      "PANEL            WIDTH  VIEW\nsidebar  hidden  240px\nfiles    shown   600px  git\n",
    );
    expect((await nexus(app, ["panel", "show", "terminal"])).exitCode).toBe(2);
  });

  test("reveal shows a file in the tree when it exists", async () => {
    const app = fakeApp();
    expect((await nexus(app, ["reveal", "src/login.ts"])).stdout).toBe(
      "Revealed src/login.ts in app's files panel.\n",
    );
    expect(lastCall(app, "files.reveal")).toEqual({
      workspaceId: APP,
      filePath: "/w/app/src/login.ts",
    });
    expect((await nexus(app, ["reveal", "nope.ts"])).stderr).toBe(
      "nexus: no such file or folder: nope.ts\n",
    );
  });

  test("problems lists errors and warnings by file, relative to the root", async () => {
    const app = fakeApp();
    expect((await nexus(app, ["problems"])).stdout).toBe(
      "No problems in the files open in the editor.\n",
    );
    app.problems.push(
      {
        filePath: "/w/app/src/a.ts",
        line: 3,
        column: 7,
        severity: "error",
        message: "Cannot find name 'x'.",
        source: "ts",
        code: "2304",
      },
      { filePath: "/w/app/src/a.ts", line: 9, column: 1, severity: "warning", message: "Unused." },
      {
        filePath: "/w/app/src/a.ts",
        line: 10,
        column: 1,
        severity: "hint",
        message: "Could be const.",
      },
    );
    expect((await nexus(app, ["problems"])).stdout).toBe(
      "src/a.ts:3:7  error    Cannot find name 'x'.  (ts 2304)\n" +
        "src/a.ts:9:1  warning  Unused.\n" +
        "1 error, 1 warning in the files open in the editor.\n",
    );
    expect((await nexus(app, ["problems", "--errors"])).stdout).not.toContain("Unused");
    expect((await nexus(app, ["problems", "--all"])).stdout).toContain("Could be const.");
  });
});

/**
 * nexus view: the window's view and the agent view's panels, against a
 * fake app whose agent view is shown in two columns: p1 (app's Claude) |
 * p2 (api's codex), p1 active. Commands run from app's plain shell, which
 * the agent view does not hold.
 */
import { describe, expect, test } from "bun:test";
import { CLI_COMMANDS } from "../../../../src/main/features/cli/commands";
import { runCli } from "../../../../src/main/features/cli/registry";
import {
  API,
  APP,
  CLAUDE_TAB,
  CODEX_TAB,
  contextFor,
  type FakeApp,
  fakeApp,
  SHELL_TAB,
} from "./fake-services";

async function nexus(
  app: FakeApp,
  argv: string[],
  caller?: { workspaceId: string; tabId: string },
) {
  return runCli(CLI_COMMANDS, contextFor(app, argv, caller));
}

function lastCall(app: FakeApp, op: string): unknown {
  return app.uiCalls.filter((c) => c.op === op).at(-1)?.args;
}

describe("view", () => {
  test("tells the view shown, and switches it", async () => {
    const app = fakeApp();
    expect((await nexus(app, ["view"])).stdout).toBe("The window shows the agent view.\n");
    const shown = await nexus(app, ["view", "workspaces"]);
    expect(shown.stdout).toBe("Showing the workspaces.\n");
    expect(lastCall(app, "agentView.show")).toEqual({ view: "workspaces" });
    expect((await nexus(app, ["view"])).stdout).toBe("The window shows the workspaces.\n");
    expect((await nexus(app, ["view", "sideways"])).exitCode).toBe(2);
  });

  test("layout draws the panels, each session with its workspace", async () => {
    const result = await nexus(fakeApp(), ["view", "layout"]);
    expect(result.stdout).toBe(
      [
        "shown: the agent view",
        "side by side, 50% | 50%",
        "  panel 1 (p1), active: *✳ Claude Code [app]",
        "  panel 2 (p2): *codex [api]",
        "",
      ].join("\n"),
    );
    const json = JSON.parse((await nexus(fakeApp(), ["view", "layout", "--json"])).stdout);
    expect(json.panels[1]).toEqual({
      number: 2,
      id: "p2",
      sessions: [{ workspaceId: API, tabId: CODEX_TAB, title: "codex" }],
      shownTabId: CODEX_TAB,
    });
  });

  test("open shows a session it holds, or one of this workspace's, with the view", async () => {
    const app = fakeApp();
    const held = await nexus(app, ["view", "open", "codex"]);
    expect(held.stdout).toBe("Showing codex in the agent view.\n");
    expect(lastCall(app, "agentView.place")).toEqual({
      workspaceId: API,
      tabId: CODEX_TAB,
      show: true,
    });
    await nexus(app, ["view", "open", ".", "--panel", "2"]);
    expect(lastCall(app, "agentView.place")).toEqual({
      workspaceId: APP,
      tabId: SHELL_TAB,
      panelId: "p2",
      show: true,
    });
    const editor = await nexus(app, ["view", "open", "index.ts"]);
    expect(editor.stderr).toBe(
      "nexus: the agent view shows Claude and Codex tabs and terminals, and index.ts is none of them\n",
    );
  });

  test("split moves a session into a new panel, the active one staying", async () => {
    const app = fakeApp();
    const result = await nexus(app, ["view", "split", "zsh", "down"]);
    expect(result.stdout).toBe("Moved zsh into a new panel below panel 1.\n");
    expect(lastCall(app, "agentView.place")).toEqual({
      workspaceId: APP,
      tabId: SHELL_TAB,
      panelId: "p1",
      side: "down",
      show: false,
    });
    await nexus(app, ["view", "split", "codex", "left"]);
    expect(lastCall(app, "agentView.place")).toMatchObject({ tabId: CODEX_TAB, panelId: "p2" });
    await nexus(app, ["view", "split", "zsh", "right", "--of", "codex"]);
    expect(lastCall(app, "agentView.place")).toMatchObject({ tabId: SHELL_TAB, panelId: "p2" });
  });

  test("move puts a session into a panel, at a place among its sessions", async () => {
    const app = fakeApp();
    const result = await nexus(app, ["view", "move", "codex", "1", "--at", "1"]);
    expect(result.stdout).toBe("Moved codex to panel 1, place 1.\n");
    expect(lastCall(app, "agentView.place")).toEqual({
      workspaceId: API,
      tabId: CODEX_TAB,
      panelId: "p1",
      index: 0,
      show: false,
    });
    expect((await nexus(app, ["view", "move", "codex", "2"])).stderr).toBe(
      "nexus: codex is already in panel 2; --at moves it within it\n",
    );
  });

  test("remove and close take sessions out of the view", async () => {
    const app = fakeApp();
    expect((await nexus(app, ["view", "remove", "zsh"])).stderr).toBe(
      "nexus: zsh is not in the agent view\n",
    );
    await nexus(app, ["view", "remove", "✳ Claude Code"]);
    expect(lastCall(app, "agentView.remove")).toEqual({ workspaceId: APP, tabId: CLAUDE_TAB });
    const closed = await nexus(app, ["view", "close", "2"]);
    expect(closed.stdout).toBe("Closed panel 2; 1 session left the agent view.\n");
    expect(lastCall(app, "agentView.close")).toEqual({ panelId: "p2" });
  });

  test("resize, even and focus act on panels", async () => {
    const app = fakeApp();
    expect((await nexus(app, ["view", "resize", "2", "30"])).stdout).toBe(
      "Panel 2 now takes 30% of the width it shares.\n",
    );
    expect(lastCall(app, "agentView.ratios")).toEqual({ ratios: [{ splitId: "s9", ratio: 0.7 }] });
    expect((await nexus(app, ["view", "resize", "1", "30", "--height"])).stderr).toBe(
      "nexus: panel 1 is not above or below another panel\n",
    );
    await nexus(app, ["view", "even"]);
    expect(lastCall(app, "agentView.ratios")).toEqual({ ratios: [{ splitId: "s9", ratio: 0.5 }] });
    await nexus(app, ["view", "focus", "codex"]);
    expect(lastCall(app, "agentView.focus")).toEqual({ panelId: "p2" });
    // "." is the panel holding this terminal, else the active one.
    await nexus(app, ["view", "focus", "."], { workspaceId: API, tabId: CODEX_TAB });
    expect(lastCall(app, "agentView.focus")).toEqual({ panelId: "p2" });
    await nexus(app, ["view", "focus", "."]);
    expect(lastCall(app, "agentView.focus")).toEqual({ panelId: "p1" });
    expect((await nexus(app, ["view", "focus", "3"])).stderr).toBe(
      "nexus: the agent view has no panel 3; it has 2\n",
    );
  });
});

describe("status", () => {
  test("tells the view the window shows", async () => {
    const app = fakeApp();
    expect((await nexus(app, ["status"])).stdout).toContain(
      "view:      the agent view, 2 panels\n",
    );
    app.agentView.view = "workspaces";
    const json = JSON.parse((await nexus(app, ["status", "--json"])).stdout);
    expect(json.view).toBe("workspaces");
  });
});

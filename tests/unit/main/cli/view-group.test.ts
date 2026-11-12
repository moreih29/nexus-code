/**
 * nexus view group: how the agent view's list groups its agents, read and
 * set, against the fake app whose list is grouped by status.
 */
import { describe, expect, test } from "bun:test";
import { CLI_COMMANDS } from "../../../../src/main/features/cli/commands";
import { runCli } from "../../../../src/main/features/cli/registry";
import { contextFor, type FakeApp, fakeApp } from "./fake-services";

async function nexus(app: FakeApp, argv: string[]) {
  return runCli(CLI_COMMANDS, contextFor(app, argv));
}

const groupCalls = (app: FakeApp) => app.uiCalls.filter((c) => c.op === "agentView.group");

describe("view group", () => {
  test("tells the grouping, changing nothing", async () => {
    const app = fakeApp();
    expect((await nexus(app, ["view", "group"])).stdout).toBe(
      "The agent view lists its agents by status (needs you, running, new result, idle, ended).\n",
    );
    expect(groupCalls(app)).toEqual([]);
  });

  test("groups the list by workspace or by status, by either spelling", async () => {
    const app = fakeApp();
    expect((await nexus(app, ["view", "group", "workspaces"])).stdout).toBe(
      "The agent view lists its agents by workspace.\n",
    );
    await nexus(app, ["view", "group", "State"]);
    expect(groupCalls(app).map((c) => c.args)).toEqual([
      { grouping: "workspace" },
      { grouping: "status" },
    ]);
  });

  test("answers --json with the grouping", async () => {
    const app = fakeApp();
    const { stdout } = await nexus(app, ["view", "group", "workspace", "--json"]);
    expect(JSON.parse(stdout)).toEqual({ grouping: "workspace" });
  });

  test("refuses a grouping it does not know, or more than one", async () => {
    const app = fakeApp();
    expect((await nexus(app, ["view", "group", "branch"])).stderr).toContain(
      'the grouping is status or workspace, not "branch"',
    );
    expect((await nexus(app, ["view", "group", "status", "workspace"])).stderr).toContain(
      "give status or workspace",
    );
    // An object's own names are not groupings, nor views.
    expect((await nexus(app, ["view", "group", "constructor"])).stderr).toContain(
      'not "constructor"',
    );
    expect((await nexus(app, ["view", "toString"])).stderr).toContain('not "toString"');
    expect(groupCalls(app)).toEqual([]);
  });
});

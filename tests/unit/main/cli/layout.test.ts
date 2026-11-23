import { describe, expect, test } from "bun:test";
import { CLI_COMMANDS } from "../../../../src/main/features/cli/commands";
import { runCli } from "../../../../src/main/features/cli/registry";
import { APP, contextFor, type FakeApp, fakeApp, WORKSPACES } from "./fake-services";

async function nexus(app: FakeApp, argv: string[]) {
  return runCli(CLI_COMMANDS, contextFor(app, argv));
}

async function nexusOnWindows(app: FakeApp, argv: string[]) {
  const ctx = contextFor(app, argv, undefined, { cwd: "C:\\w\\app" });
  const workspaces = WORKSPACES.map((w) =>
    w.id === APP
      ? {
          ...w,
          rootPath: "C:\\w\\app",
          location: { kind: "local" as const, rootPath: "C:\\w\\app" },
        }
      : w,
  );
  return runCli(CLI_COMMANDS, {
    ...ctx,
    services: { ...ctx.services, listWorkspaces: () => workspaces },
  });
}

function lastCall(app: FakeApp, op: string): unknown {
  return app.uiCalls.filter((c) => c.op === op).at(-1)?.args;
}

describe("layout", () => {
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
});

describe("panels, reveal and problems", () => {
  test("panel show agents shows the files panel's agent list", async () => {
    const app = fakeApp();
    expect((await nexus(app, ["panel", "show", "agents"])).stdout).toContain("Showing agents.");
    expect(lastCall(app, "panels.set")).toEqual({
      workspaceId: APP,
      panel: "files",
      visible: true,
      mode: "agents",
    });
    expect((await nexus(app, ["panel", "list"])).stdout).toContain("agents");
  });

  test("reveal names a Windows workspace's file as the renderer does", async () => {
    const app = fakeApp();
    await nexusOnWindows(app, ["reveal", "src\\login.ts"]);
    expect(lastCall(app, "files.reveal")).toEqual({
      workspaceId: APP,
      filePath: "C:/w/app/src/login.ts",
    });
  });

  test("problems lists a Windows workspace's files relative to its root too", async () => {
    const app = fakeApp();
    app.problems.push({
      filePath: "C:/w/app/src/a.ts",
      line: 3,
      column: 7,
      severity: "error",
      message: "Cannot find name 'x'.",
    });
    expect((await nexusOnWindows(app, ["problems"])).stdout).toBe(
      "src/a.ts:3:7  error    Cannot find name 'x'.\n" +
        "1 error, 0 warnings in the files open in the editor.\n",
    );
  });
});

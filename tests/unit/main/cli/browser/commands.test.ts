/**
 * nexus browser snapshot, click, fill, type, press, screenshot, eval,
 * console, wait and pick, against a fake driver: which tab they act on,
 * what they print, where screenshots go, and that only the ones changing a
 * page ask leave for another workspace.
 */
import { describe, expect, test } from "bun:test";
import { CLI_COMMANDS } from "../../../../../src/main/features/cli/commands";
import { runCli } from "../../../../../src/main/features/cli/registry";
import { API, APP, contextFor, type FakeApp, fakeApp, SHELL_TAB } from "../fake-services";

async function nexus(
  app: FakeApp,
  argv: string[],
  invocation: { cwd?: string; stdin?: string } = {},
) {
  return runCli(
    CLI_COMMANDS,
    contextFor(app, argv, { workspaceId: APP, tabId: SHELL_TAB }, invocation),
  );
}

describe("reading a page", () => {
  test("a Windows terminal's screenshot path follows Windows rules", async () => {
    const app = fakeApp();
    const result = await nexus(app, ["browser", "screenshot", "--out", "a.png"], {
      cwd: "C:\\w\\app",
    });
    expect(result.files?.[0]?.path).toBe("C:\\w\\app\\a.png");
  });
});

describe("driving a page", () => {
  test("upload gives the input files from this directory, and only a local terminal's", async () => {
    const app = fakeApp();
    const result = await nexus(app, ["browser", "upload", "#avatar", "me.png", "/tmp/cv.pdf"], {
      cwd: "/w/app/assets",
    });
    expect(result.exitCode).toBe(0);
    expect(app.browser.calls.at(-1)?.args).toEqual([
      "#avatar",
      ["/w/app/assets/me.png", "/tmp/cv.pdf"],
    ]);
    await nexus(app, ["browser", "upload", "#avatar", ""]);
    expect(app.browser.calls.at(-1)?.args).toEqual(["#avatar", []]);
    expect((await nexus(app, ["browser", "upload", "#avatar"])).exitCode).toBe(2);
    app.workspaces[0] = {
      ...(app.workspaces[0] as (typeof app.workspaces)[number]),
      location: { kind: "ssh", host: "box", remotePath: "/srv/app" },
    };
    const remote = await nexus(app, ["browser", "upload", "#avatar", "me.png"]);
    expect(remote.stderr).toContain("upload takes files of the computer the app runs on");
  });

  test("changing another workspace's page asks; reading it does not", async () => {
    const app = fakeApp();
    app.tabs[API]?.push({
      id: "bbbbbbbb-0000-4000-8000-000000000001",
      type: "browser",
      title: "API docs",
      shown: true,
      url: "http://localhost:8080/docs",
    } as never);
    await nexus(app, ["browser", "snapshot", "--workspace", "api"]);
    await nexus(app, ["browser", "screenshot", "--workspace", "api"]);
    expect(app.asked).toEqual([]);
    const refused = await nexus(app, ["browser", "click", "e1", "--workspace", "api"]);
    expect(refused.exitCode).toBe(1);
    for (const argv of [
      ["hover", "e1"],
      ["drag", "e1", "e2"],
      ["scroll", "down"],
    ]) {
      await nexus(app, ["browser", ...argv, "--workspace", "api"]);
    }
    expect(app.asked.map((r) => r.change)).toEqual(
      Array(4).fill({ kind: "browserControl", detail: "API docs" }),
    );
  });
});

describe("picking an element", () => {
  test("the pick stops with the command: it gets the command's signal", async () => {
    const app = fakeApp();
    const controller = new AbortController();
    await runCli(CLI_COMMANDS, {
      ...contextFor(app, ["browser", "pick"]),
      signal: controller.signal,
    });
    expect(app.browser.calls.at(-1)?.args).toEqual([
      { timeoutMs: 120_000, signal: controller.signal },
    ]);
  });
});

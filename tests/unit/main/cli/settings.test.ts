/** nexus settings: the app's settings read and changed from a terminal. */
import { describe, expect, test } from "bun:test";
import { CLI_COMMANDS } from "../../../../src/main/features/cli/commands";
import { runCli } from "../../../../src/main/features/cli/registry";
import { contextFor, type FakeApp, fakeApp } from "./fake-services";

async function nexus(app: FakeApp, argv: string[]) {
  return runCli(CLI_COMMANDS, contextFor(app, argv));
}

describe("settings list and get", () => {
  test("list shows each value, a mark when changed, and what it takes", async () => {
    const result = await nexus(fakeApp(), ["settings", "list"]);
    expect(result.stdout).toBe(
      "KEY                      VALUE  TAKES\n" +
        "editor.fontSize          16     8..32\n" +
        "terminal.ligatures       on *   on|off\n" +
        "agentCli.crossWorkspace  ask    (in Settings)\n" +
        "appearance.theme         dark   12 choices (--json)\n",
    );
  });

  test("get prints the value alone, or all of it with --json", async () => {
    const app = fakeApp();
    expect((await nexus(app, ["settings", "get", "Terminal.Ligatures"])).stdout).toBe("on\n");
    const json = JSON.parse(
      (await nexus(app, ["settings", "get", "editor.fontSize", "--json"])).stdout,
    );
    expect(json).toMatchObject({ key: "editor.fontSize", value: 16, min: 8, max: 32 });
    expect((await nexus(app, ["settings", "get", "nope"])).stderr).toBe(
      'nexus: no setting "nope"; nexus settings list shows them\n',
    );
  });
});

describe("settings set and reset", () => {
  test("set sends the value as typed and says what it is now", async () => {
    const app = fakeApp();
    const result = await nexus(app, ["settings", "set", "editor.fontSize", "14"]);
    expect(result.stdout).toBe("editor.fontSize is 14.\n");
    expect(app.uiCalls.at(-1)).toEqual({
      op: "settings.set",
      args: { key: "editor.fontSize", value: "14" },
    });
    expect(app.asked).toEqual([]);
  });

  test("reset asks for the default", async () => {
    const app = fakeApp();
    const result = await nexus(app, ["settings", "reset", "terminal.ligatures"]);
    expect(result.stdout).toBe("terminal.ligatures is off.\n");
    expect(app.uiCalls.at(-1)?.args).toEqual({ key: "terminal.ligatures", value: null });
  });

  test("what the app refuses is said as it says it", async () => {
    const app = fakeApp();
    expect((await nexus(app, ["settings", "set", "editor.fontSize", "99"])).stderr).toBe(
      "nexus: editor.fontSize: 99 is not within 8..32\n",
    );
    expect((await nexus(app, ["settings", "set", "agentCli.crossWorkspace", "allow"])).stderr).toBe(
      "nexus: agentCli.crossWorkspace is the user's to change, in Settings\n",
    );
    expect((await nexus(app, ["settings", "set", "editor.fontSize"])).exitCode).toBe(2);
  });
});

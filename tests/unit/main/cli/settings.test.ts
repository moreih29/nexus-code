/**
 * nexus settings list and get over the renderer's settings: one asked for
 * by its key alone, and one that could not be read (the account's voice
 * terms, signed out) told as such rather than as empty.
 */
import { expect, test } from "bun:test";
import { CLI_COMMANDS } from "../../../../src/main/features/cli/commands";
import { runCli } from "../../../../src/main/features/cli/registry";
import type { CliSettingInfo, CliUiOps } from "../../../../src/shared/cli/ui";
import { API, contextFor, type FakeApp, fakeApp } from "./fake-services";

const SETTINGS: CliSettingInfo[] = [
  {
    key: "terminal.shell",
    summary: "The shell",
    type: "choice",
    choices: ["system", "zsh", "fish"],
    value: "fish",
    changed: true,
  },
  {
    key: "voice.terms",
    summary: "Words voice input should recognize",
    type: "text",
    value: "",
    changed: false,
    unavailable: "not signed in to NexusCode (Settings › Remote)",
  },
];

/** The app, its renderer answering settings.list with SETTINGS. */
function withSettings(): FakeApp {
  const app = fakeApp();
  const ui = app.services.ui;
  app.services = {
    ...app.services,
    ui: (async (op, args, timeoutMs) => {
      if (op !== "settings.list") return ui(op, args, timeoutMs);
      app.uiCalls.push({ op, args });
      const { key } = args as CliUiOps["settings.list"]["args"];
      return { settings: SETTINGS.filter((s) => key === undefined || s.key === key) };
    }) as typeof ui,
  };
  return app;
}

const nexus = (app: FakeApp, argv: string[]) => runCli(CLI_COMMANDS, contextFor(app, argv));

test("get asks for its key alone, and fails for one that could not be read", async () => {
  const app = withSettings();
  expect((await nexus(app, ["settings", "get", "terminal.shell"])).stdout).toBe("fish\n");
  expect(app.uiCalls.at(-1)?.args).toEqual({ key: "terminal.shell" });
  const unread = await nexus(app, ["settings", "get", "voice.terms"]);
  expect(unread.stderr).toBe(
    "nexus: voice.terms: not signed in to NexusCode (Settings › Remote)\n",
  );
  expect(unread.exitCode).toBe(1);
});

test("list says why a setting could not be read, in place of its value", async () => {
  const { stdout } = await nexus(withSettings(), ["settings", "list"]);
  expect(stdout.split("\n").slice(1, 3)).toEqual([
    "terminal.shell  fish *                                                       system|zsh|fish",
    "voice.terms     unavailable: not signed in to NexusCode (Settings › Remote)  text",
  ]);
});

test("settings instructions previews the workspace and agent layers without changing them", async () => {
  const app = withSettings();
  const layers = [{ scope: { kind: "all" }, title: "All agents", text: "Use tests." }];
  app.uiAnswers.set("settings.instructions", { layers, instructions: "## All agents\nUse tests." });
  const result = await nexus(app, [
    "settings",
    "instructions",
    "show",
    "--workspace",
    API,
    "--agent",
    "codex",
    "--json",
  ]);
  expect(JSON.parse(result.stdout)).toEqual({
    workspaceId: API,
    agent: "codex",
    layers,
    instructions: "## All agents\nUse tests.",
  });
  expect(app.uiCalls.at(-1)?.args).toEqual({ workspaceId: API, agent: "codex" });
  expect(app.asked).toEqual([]);
});

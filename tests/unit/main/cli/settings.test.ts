/**
 * nexus settings list and get over the renderer's settings: one asked for
 * by its key alone, and one that could not be read (the account's voice
 * terms, signed out) told as such rather than as empty.
 */
import { expect, test } from "bun:test";
import { SCHEMA_VERSION } from "../../../../packages/remote-protocol/src";
import { CLI_COMMANDS } from "../../../../src/main/features/cli/commands";
import type { CliDevice } from "../../../../src/main/features/cli/context";
import { runCli } from "../../../../src/main/features/cli/registry";
import type { CliSettingInfo, CliUiOps } from "../../../../src/shared/cli/ui";
import { API, APP, contextFor, type FakeApp, fakeApp, SHELL_TAB } from "./fake-services";

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

const MINI: CliDevice = {
  id: "9b1e44d2-0000-4000-8000-000000000002",
  name: "Mac mini",
  platform: "darwin",
  online: true,
  self: false,
  serves: ["sessions", "chat.read", "agents", "agents.cli", "settings.instructions"],
  schema: SCHEMA_VERSION,
};
const PEER_COMMAND = ["settings", "instructions", "show", "--device", MINI.name];
const SITE = "33333333-3333-4333-8333-333333333333";
const TOOLS = "44444444-4444-4444-8444-444444444444";

test("settings instructions shows peer layers in the local format and selects Codex", async () => {
  const app = fakeApp();
  const from = { kind: "terminal", workspaceId: APP, tabId: SHELL_TAB };
  const preview = {
    layers: [
      { scope: { kind: "all" }, title: "All agents", text: "Use tests." },
      { scope: { kind: "agent", agent: "codex" }, title: "Codex", text: "" },
      { scope: { kind: "profile", id: "work" }, title: "Profile: Work", text: "Use bun." },
      { scope: { kind: "workspace", id: TOOLS }, title: "Workspace: Tools", text: "Use fixtures." },
    ],
    instructions:
      "## All agents\nUse tests.\n\n## Profile: Work\nUse bun.\n\n## Workspace: Tools\nUse fixtures.",
  };
  app.peers.devices = [MINI];
  app.peers.answer = async (_device, method, params) => {
    if (method === "sessions.list") {
      expect(params).toEqual({ from });
      return {
        workspaces: [
          { id: SITE, name: "Site", path: "/site" },
          { id: TOOLS, name: "Tools", path: "/tools" },
        ],
        sessions: [],
      };
    }
    expect(method).toBe("settings.instructions");
    if ((params as { workspaceId: string }).workspaceId === SITE) {
      expect(params).toEqual({ workspaceId: SITE, agent: "claude", from });
      return { layers: [], instructions: "" };
    }
    expect(params).toEqual({ workspaceId: TOOLS, agent: "codex", from });
    return preview;
  };
  const command = [...PEER_COMMAND, "--workspace", "Tools", "--agent", "codex"];
  expect(await nexus(app, command)).toEqual({
    exitCode: 0,
    stderr: "",
    stdout: `Sources, in order:\n- All agents\n- Codex (empty)\n- Profile: Work\n- Workspace: Tools\n\n${preview.instructions}\n`,
  });
  const json = await nexus(app, [...command, "--json"]);
  expect(JSON.parse(json.stdout)).toEqual({
    workspaceId: TOOLS,
    agent: "codex",
    ...preview,
    device: { id: MINI.id, name: MINI.name },
  });
  expect((await nexus(app, PEER_COMMAND)).stdout).toBe("Sources, in order:\n\n(no instructions)\n");
  expect(app.uiCalls.some(({ op }) => op === "settings.instructions")).toBe(false);
  expect(app.asked).toEqual([]);
});

test("settings instructions shows update guidance for a 0.36.x peer before contacting it", async () => {
  const app = fakeApp();
  app.peers.devices = [
    { ...MINI, schema: "0.15.0", serves: MINI.serves.filter((c) => c !== "settings.instructions") },
  ];
  const result = await nexus(app, PEER_COMMAND);
  expect(result.exitCode).toBe(3);
  expect(result.stderr).toContain('Update NexusCode on "Mac mini"');
  expect(app.peers.requests).toEqual([]);
});

test("settings instructions refuses a peer that does not take agent requests", async () => {
  const app = fakeApp();
  app.peers.devices = [{ ...MINI, serves: MINI.serves.filter((c) => c !== "agents") }];
  const result = await nexus(app, PEER_COMMAND);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain('"Mac mini" does not take requests from agents');
  expect(app.peers.requests).toEqual([]);
});

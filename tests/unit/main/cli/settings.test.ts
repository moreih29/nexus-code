import { expect, test } from "bun:test";
import { SCHEMA_VERSION } from "../../../../packages/remote-protocol/src";
import { CLI_COMMANDS } from "../../../../src/main/features/cli/commands";
import type { CliDevice } from "../../../../src/main/features/cli/context";
import { runCli } from "../../../../src/main/features/cli/registry";
import type { CliSettingInfo, CliUiOps } from "../../../../src/shared/cli/ui";
import { API, APP, contextFor, type FakeApp, FIX, fakeApp, SHELL_TAB } from "./fake-services";

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

test("opens cross-workspace permissions by page name or setting key", async () => {
  const app = fakeApp();
  app.uiAnswers.set("settings.open", {});
  for (const page of ["cross-workspace", "agentCli.crossWorkspace"]) {
    expect((await nexus(app, ["settings", "open", page])).exitCode).toBe(0);
    expect(app.uiCalls.at(-1)).toEqual({
      op: "settings.open",
      args: { page: "cross-workspace" },
    });
  }
});

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

const WORK_PROFILE = { id: "work-codex", agent: "codex", name: "Work", isDefault: false };
const OTHER_PROFILE = { id: "work-claude", agent: "claude", name: "Work", isDefault: false };
const SET_PROFILE = ["settings", "instructions", "set", "profile"];
const SHOW_PROFILE = ["settings", "instructions", "show", "--profile"];

test("a profile id selects its agent and ambiguous names require the id", async () => {
  const app = fakeApp();
  app.uiAnswers.set("chat.profiles", { profiles: [WORK_PROFILE, OTHER_PROFILE] });
  const show = await nexus(app, [...SHOW_PROFILE, WORK_PROFILE.id, "--json"]);
  expect(JSON.parse(show.stdout)).toMatchObject({
    workspaceId: APP,
    agent: "codex",
    profileId: WORK_PROFILE.id,
  });
  expect(app.uiCalls.at(-1)).toEqual({
    op: "settings.instructions",
    args: { workspaceId: APP, agent: "codex", profileId: WORK_PROFILE.id },
  });
  for (const command of [
    [...SHOW_PROFILE, "work"],
    [...SET_PROFILE, "--profile", "work", "--clear"],
  ]) {
    const result = await nexus(app, command);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Use its id from nexus chat profiles");
  }
  expect(app.asked).toEqual([]);
});

test("local profile writes take stdin and clear with fresh approval each time", async () => {
  const app = fakeApp();
  app.settings.crossWorkspace = "allow";
  app.uiAnswers.set("chat.profiles", { profiles: [WORK_PROFILE, OTHER_PROFILE] });
  app.uiAnswers.set("settings.instructions.set", {});
  app.answers.push("once", "once", "deny");
  const command = [...SET_PROFILE, "--profile", WORK_PROFILE.id];
  const set = await runCli(
    CLI_COMMANDS,
    contextFor(app, [...command, "--file", "-", "--json"], undefined, { stdin: "Use bun." }),
  );
  const scope = { kind: "profile", id: WORK_PROFILE.id };
  expect(JSON.parse(set.stdout)).toEqual({ scope, text: "Use bun." });
  expect((await nexus(app, [...command, "--clear"])).exitCode).toBe(0);
  expect((await nexus(app, [...command, "--clear"])).exitCode).toBe(1);
  expect(app.asked.map(({ change }) => change)).toEqual(
    ["Use bun.", "", ""].map((body) => ({
      kind: "instructionsEdit",
      instructionEdit: {
        layer: { kind: "profile", agent: "codex", name: "Work", id: "work-codex" },
        clear: !body,
      },
      eachTime: true,
      body,
    })),
  );
  expect(app.uiCalls.filter(({ op }) => op === "settings.instructions.set")).toEqual(
    ["Use bun.", ""].map((text) => ({ op: "settings.instructions.set", args: { scope, text } })),
  );
});

test("local profile approvals include the id when the same agent has another profile with that name", async () => {
  const app = fakeApp();
  app.uiAnswers.set("chat.profiles", {
    profiles: [WORK_PROFILE, { ...WORK_PROFILE, id: "other-codex", name: "work" }],
  });
  app.uiAnswers.set("settings.instructions.set", {});
  app.answers.push("once");
  expect(
    (await nexus(app, [...SET_PROFILE, "--profile", WORK_PROFILE.id, "--clear"])).exitCode,
  ).toBe(0);
  expect(app.asked[0]?.change.instructionEdit?.layer).toEqual({
    kind: "profile",
    agent: "codex",
    name: "Work",
    id: WORK_PROFILE.id,
    showId: true,
  });
});

test("peer profile reads and writes resolve the receiving device's profiles", async () => {
  const app = fakeApp();
  app.peers.devices = [MINI];
  const from = { kind: "terminal", workspaceId: APP, tabId: SHELL_TAB };
  app.peers.answer = async (_device, method, params) => {
    switch (method) {
      case "sessions.list":
        return { workspaces: [{ id: SITE, name: "Site", path: "/site" }], sessions: [] };
      case "profiles.list":
        return { profiles: [WORK_PROFILE] };
      case "settings.instructions":
        expect(params).toEqual({
          workspaceId: SITE,
          agent: "codex",
          profileId: WORK_PROFILE.id,
          from,
        });
        return { layers: [], instructions: "Use bun." };
      case "settings.instructions.set":
        expect(params).toEqual({
          workspaceId: SITE,
          layer: "profile",
          profileId: WORK_PROFILE.id,
          text: "",
          from,
        });
        return {};
      default:
        throw new Error(`unexpected request ${method}`);
    }
  };
  const device = ["--device", MINI.name];
  const shown = await nexus(app, [
    ...SHOW_PROFILE,
    "Work",
    "--agent",
    "codex",
    ...device,
    "--json",
  ]);
  expect(JSON.parse(shown.stdout)).toMatchObject({
    profileId: WORK_PROFILE.id,
    instructions: "Use bun.",
  });
  expect(app.peers.requests.find(({ method }) => method === "profiles.list")?.params).toEqual({
    agent: "codex",
    from,
  });
  const set = await nexus(app, [
    ...SET_PROFILE,
    "--profile",
    "Work",
    ...device,
    "--clear",
    "--json",
  ]);
  expect(JSON.parse(set.stdout)).toMatchObject({ layer: "profile", profileId: WORK_PROFILE.id });
  expect(
    app.uiCalls.some(({ op }) => op === "chat.profiles" || op === "settings.instructions.set"),
  ).toBe(false);
  expect(app.asked).toEqual([]);
});

test("peer profile writes require the instruction capability before discovery", async () => {
  const app = fakeApp();
  app.peers.devices = [
    { ...MINI, schema: "0.15.0", serves: MINI.serves.filter((c) => c !== "settings.instructions") },
  ];
  const result = await nexus(app, [
    ...SET_PROFILE,
    "--profile",
    "Work",
    "--device",
    MINI.name,
    "--clear",
  ]);
  expect(result.exitCode).toBe(3);
  expect(result.stderr).toContain('Update NexusCode on "Mac mini"');
  expect(app.peers.requests).toEqual([]);
});

test("setting a task workspace's instructions asks to edit the parent and names it in the output", async () => {
  const app = fakeApp();
  app.tabs[FIX] = (app.tabs[APP] ?? []).filter((tab) => tab.id === SHELL_TAB);
  app.answers.push("once");
  const result = await runCli(
    CLI_COMMANDS,
    contextFor(
      app,
      ["settings", "instructions", "set", "workspace", "--workspace", FIX, "--clear"],
      { workspaceId: FIX, tabId: SHELL_TAB },
    ),
  );

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe('Cleared the workspace instruction layer for "app".\n');
  expect(app.asked).toMatchObject([
    {
      toWorkspaceId: APP,
      change: {
        kind: "instructionsEdit",
        instructionEdit: { layer: { kind: "workspace", name: "app" }, clear: true },
      },
    },
  ]);
  expect(app.uiCalls.at(-1)).toEqual({
    op: "settings.instructions.set",
    args: { scope: { kind: "workspace", id: APP }, text: "" },
  });
});

test("updates check looks for an update and prints what it found; logs path prints the folder", async () => {
  const app = fakeApp();
  app.uiAnswers.set("settings.updateCheck", {
    status: { kind: "newer", latest: "9.9.9", trigger: "manual" },
    progress: null,
  });
  app.uiAnswers.set("settings.logsPath", { path: "/Users/me/Library/Logs/NexusCode" });
  expect((await nexus(app, ["settings", "updates", "check"])).stdout).toBe("newer 9.9.9\n");
  expect((await nexus(app, ["settings", "logs", "path"])).stdout).toBe(
    "/Users/me/Library/Logs/NexusCode\n",
  );
  expect(app.uiCalls.map(({ op }) => op)).toEqual(["settings.updateCheck", "settings.logsPath"]);
});

test("settings keys set, unbind and reset send the change and print the shortcut and warnings", async () => {
  const app = fakeApp();
  app.uiAnswers.set("settings.keys.set", {
    bindings: [
      {
        command: "tab.closeAll",
        area: "app",
        primary: null,
        chord: ["CmdOrCtrl+K", "CmdOrCtrl+J"],
      },
    ],
    warnings: ["Also bound to “Close” (different focus scope)"],
  });
  const set = await nexus(app, [
    "settings",
    "keys",
    "set",
    "tab.closeAll",
    "CmdOrCtrl+K",
    "CmdOrCtrl+J",
  ]);
  expect(set.stdout).toContain("CmdOrCtrl+K CmdOrCtrl+J");
  expect(set.stdout).toContain("warning: Also bound to “Close” (different focus scope)");
  await nexus(app, ["settings", "keys", "set", "tab.closeOthers", "CmdOrCtrl+Alt+Y"]);
  await nexus(app, ["settings", "keys", "unbind", "tab.closeOthers"]);
  await nexus(app, ["settings", "keys", "reset", "--all"]);
  expect((await nexus(app, ["settings", "keys", "reset"])).exitCode).toBe(2);
  expect(app.uiCalls.map(({ args }) => args)).toEqual([
    { change: { op: "set", command: "tab.closeAll", keys: ["CmdOrCtrl+K", "CmdOrCtrl+J"] } },
    { change: { op: "set", command: "tab.closeOthers", keys: ["CmdOrCtrl+Alt+Y"] } },
    { change: { op: "unbind", command: "tab.closeOthers" } },
    { change: { op: "reset" } },
  ]);
});

test("settings set asks the user each time before turning on what sends or matches voices", async () => {
  const app = fakeApp();
  app.uiAnswers.set("settings.set", (args: CliUiOps["settings.set"]["args"]) => ({
    setting: {
      key: args.key,
      summary: "",
      type: "boolean",
      value: args.value === "on" || args.value === "yes",
      changed: true,
    },
  }));
  const denied = await nexus(app, ["settings", "set", "notes.summary", "on"]);
  expect(denied.exitCode).toBe(1);
  expect(denied.stderr).toBe("nexus: the user did not allow it\n");
  expect(app.uiCalls).toEqual([]);
  expect(app.asked.at(-1)?.change).toEqual({
    kind: "settingTurnOn",
    detail: "notes.summary",
    eachTime: true,
  });
  app.answers.push("once");
  expect((await nexus(app, ["settings", "set", "Notes.VoiceExpire", "yes"])).stdout).toBe(
    "Notes.VoiceExpire is on.\n",
  );
  expect(app.asked.at(-1)?.change.detail).toBe("notes.voiceExpire");
  expect(app.uiCalls.at(-1)?.args).toEqual({
    key: "Notes.VoiceExpire",
    value: "yes",
    approved: true,
  });
  const asked = app.asked.length;
  await nexus(app, ["settings", "set", "notes.voiceSuggest", "off"]);
  await nexus(app, ["settings", "set", "notes.summaryModel", "on"]);
  expect(app.asked.length).toBe(asked);
  expect(app.uiCalls.slice(-2).map(({ args }) => args)).toEqual([
    { key: "notes.voiceSuggest", value: "off" },
    { key: "notes.summaryModel", value: "on" },
  ]);
});

test("browser permissions revoke takes a global permission or a site's, never both", async () => {
  const app = fakeApp();
  app.uiAnswers.set("browser.permissions.revoke", { revoked: ["media"] });
  expect((await nexus(app, ["browser", "permissions", "revoke", "media", "--global"])).stdout).toBe(
    "Turned off media for every site.\n",
  );
  const site = await nexus(app, [
    "browser",
    "permissions",
    "revoke",
    "media",
    "--site",
    "https://a.test",
  ]);
  expect(site.stdout).toBe("Forgot that https://a.test was allowed media.\n");
  expect(app.uiCalls.map(({ args }) => args)).toEqual([
    { scope: "global", permission: "media" },
    { scope: "site", workspaceId: APP, origin: "https://a.test", permission: "media" },
  ]);
  expect((await nexus(app, ["browser", "permissions", "revoke", "media"])).exitCode).toBe(2);
  expect(
    (await nexus(app, ["browser", "permissions", "revoke", "media", "--global", "--site", "x"]))
      .exitCode,
  ).toBe(2);
  expect(app.asked).toEqual([]);
});

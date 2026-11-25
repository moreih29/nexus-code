import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { SCHEMA_VERSION } from "../../../../../packages/remote-protocol/src";
import { CLI_COMMANDS } from "../../../../../src/main/features/cli/commands";
import { runCli } from "../../../../../src/main/features/cli/registry";
import { AgentGate } from "../../../../../src/main/features/remote/agent-gate";
import { serveWith } from "../../../../../src/main/features/remote/serve";
import type { CliUiOps } from "../../../../../src/shared/cli/ui";
import { lspSettingsFromState } from "../../../../../src/shared/lsp/settings";
import { WorkspaceMetaSchema } from "../../../../../src/shared/types/workspace";
import { contextFor, fakeApp } from "../../../main/cli/fake-services";

const writes: unknown[] = [];

const answers: Record<string, (args: unknown) => unknown> = {
  "pty.listShells": () => ({
    ok: true,
    value: {
      shells: [
        { id: "/bin/zsh", name: "zsh", path: "/bin/zsh", args: [] },
        { id: "/opt/homebrew/bin/fish", name: "fish", path: "/opt/homebrew/bin/fish", args: [] },
      ],
      systemDefault: { id: "/bin/zsh", name: "zsh", path: "/bin/zsh", args: [] },
    },
  }),
};

const CLIENT = "../../../../../src/renderer/ipc/client";

const previousClient = { ...(await import(CLIENT)) };
mock.module(CLIENT, () => ({
  ...previousClient,
  ipcCallResult: (channel: string, method: string, args: unknown) => {
    const answer = answers[`${channel}.${method}`];
    if (answer) return Promise.resolve(answer(args));
    writes.push(args);
    return Promise.resolve({ ok: true, value: undefined });
  },
}));
afterAll(() => {
  mock.module(CLIENT, () => previousClient);
});

const { settingsHandlers } = await import("../../../../../src/renderer/services/cli/settings");
const { useAgentInstructionsStore } = await import(
  "../../../../../src/renderer/state/stores/agent-instructions"
);
const { useAgentProfilesStore } = await import(
  "../../../../../src/renderer/state/stores/agent-profiles"
);
const { useEditorFontStore } = await import("../../../../../src/renderer/state/stores/editor-font");
const { useNotificationsStore } = await import(
  "../../../../../src/renderer/state/stores/notifications"
);
const { useAgentCliStore } = await import("../../../../../src/renderer/state/stores/agent-cli");
const { useChatFontStore } = await import("../../../../../src/renderer/state/stores/chat-font");
const { usePreviewDefaultsStore } = await import(
  "../../../../../src/renderer/state/stores/preview-defaults"
);
const { useTerminalStore } = await import("../../../../../src/renderer/state/stores/terminal");
const { useWorkspacesStore } = await import("../../../../../src/renderer/state/stores/workspaces");
const { useVoiceStore } = await import("../../../../../src/renderer/state/stores/voice");
const { useLspSettingsStore } = await import(
  "../../../../../src/renderer/state/stores/lsp-settings"
);

const set = (key: string, value: string | null) => settingsHandlers["settings.set"]({ key, value });
const get = async (key: string) => (await settingsHandlers["settings.list"]({ key })).settings[0];

const previousDocument = globalThis.document;
afterAll(() => {
  globalThis.document = previousDocument;
});

beforeEach(() => {
  if (
    typeof window !== "undefined" &&
    typeof globalThis.document?.documentElement?.dispatchEvent !== "function"
  ) {
    globalThis.document = { documentElement: new EventTarget() } as unknown as Document;
  }
  useEditorFontStore.getState().hydrate({});
  useNotificationsStore.getState().hydrate({});
  useAgentCliStore.getState().hydrate({});
  useChatFontStore.getState().hydrate({});
  usePreviewDefaultsStore.getState().hydrate({});
  useTerminalStore.getState().hydrateShells({ customShells: [] });
  writes.length = 0;
});

afterEach(() => {
  usePreviewDefaultsStore.getState().hydrate({});
});

it("an explicit profile overrides workspace rules in an instruction preview", async () => {
  const profiles = useAgentProfilesStore.getState().config;
  const instructions = useAgentInstructionsStore.getState().config;
  const { workspaces } = useWorkspacesStore.getState();
  const workspace = WorkspaceMetaSchema.parse({
    id: "11111111-1111-4111-8111-111111111111",
    name: "Site",
    rootPath: "/site",
    pinned: false,
    tabs: [],
  });
  try {
    useWorkspacesStore.setState({ workspaces: [workspace] });
    useAgentProfilesStore.getState().hydrate({
      profiles: [{ id: "work", name: "Work", agent: "codex", color: "cyan", dir: "/codex-work" }],
      rules: [
        { id: "rule", target: { kind: "workspace", workspaceId: workspace.id }, codex: "work" },
      ],
      defaults: {},
    });
    useAgentInstructionsStore.setState({
      config: {
        profiles: { work: "Use bun.", "codex-default": "Use npm." },
        workspaces: { [workspace.id]: "Use fixtures." },
      },
    });
    const preview = settingsHandlers["settings.instructions"];
    const target = { workspaceId: workspace.id, agent: "codex" as const };
    expect((await preview(target)).instructions).toContain("## Profile: Work\nUse bun.");
    const override = await preview({ ...target, profileId: "codex-default" });
    expect(override.layers).toContainEqual({
      scope: { kind: "profile", id: "codex-default" },
      title: "Profile: Default",
      text: "Use npm.",
    });
    expect(override.instructions).toContain("## Profile: Default\nUse npm.");
    expect(override.instructions).toContain("## Workspace: Site\nUse fixtures.");
    await expect(preview({ ...target, profileId: "gone" })).rejects.toThrow(
      'no codex profile with id "gone"',
    );
  } finally {
    useWorkspacesStore.setState({ workspaces });
    useAgentProfilesStore.getState().hydrate(profiles);
    useAgentInstructionsStore.setState({ config: instructions });
  }
});

it("shows a task's parent workspace layer locally and through a peer", async () => {
  const defaults = { pinned: false, tabs: [] };
  const parent = WorkspaceMetaSchema.parse({
    ...defaults,
    id: "11111111-1111-4111-8111-111111111111",
    name: "Parent",
    rootPath: "/repo",
  });
  const task = WorkspaceMetaSchema.parse({
    ...defaults,
    id: "22222222-2222-4222-8222-222222222222",
    name: "Task",
    rootPath: "/worktree",
    task: { parentId: parent.id, branch: "task", worktreePath: "/worktree" },
  });
  const { workspaces } = useWorkspacesStore.getState();
  const { config } = useAgentInstructionsStore.getState();
  try {
    useWorkspacesStore.setState({ workspaces: [parent, task] });
    useAgentInstructionsStore.setState({
      config: { workspaces: { [parent.id]: "Parent rules", [task.id]: "Legacy rules" } },
    });
    const result = await settingsHandlers["settings.instructions"]({
      workspaceId: task.id,
      agent: "codex",
    });
    expect(result.layers.filter(({ scope }) => scope.kind === "workspace")).toEqual([
      {
        scope: { kind: "workspace", id: parent.id },
        title: "Workspace: Parent",
        text: "Parent rules",
      },
    ]);
    expect(result.instructions).toEndWith("## Workspace: Parent\nParent rules");

    const host = fakeApp();
    host.workspaces.splice(0, host.workspaces.length, parent, task);
    host.uiAnswers.set("settings.instructions", (args: CliUiOps["settings.instructions"]["args"]) =>
      settingsHandlers["settings.instructions"](args),
    );
    const serve = serveWith(() => host.services, {
      agents: new AgentGate({ policy: () => "ask" }),
    });
    const caller = fakeApp();
    caller.peers.devices = [
      {
        id: "33333333-3333-4333-8333-333333333333",
        name: "Peer",
        platform: "darwin",
        online: true,
        self: false,
        serves: ["sessions", "agents", "agents.cli", "settings.instructions"],
        schema: SCHEMA_VERSION,
      },
    ];
    caller.peers.answer = async (_device, method, params) => {
      if (method !== "sessions.list" && method !== "settings.instructions")
        throw new Error(`unexpected request ${method}`);
      return serve({ from: "caller", method, params });
    };
    const remote = await runCli(
      CLI_COMMANDS,
      contextFor(caller, [
        "settings",
        "instructions",
        "show",
        "--device",
        "Peer",
        "--workspace",
        task.name,
        "--agent",
        "codex",
        "--json",
      ]),
    );
    expect(remote.exitCode).toBe(0);
    expect(JSON.parse(remote.stdout)).toMatchObject({ workspaceId: task.id, ...result });
    expect(host.uiCalls.at(-1)).toEqual({
      op: "settings.instructions",
      args: { workspaceId: task.id, agent: "codex" },
    });
    expect(host.asked).toEqual([]);
  } finally {
    useWorkspacesStore.setState({ workspaces });
    useAgentInstructionsStore.setState({ config });
  }
});

describe("settings.set", () => {
  it('takes "" as the system\'s font', async () => {
    await set("editor.fontFamily", "JetBrains Mono");
    expect(useEditorFontStore.getState().family).toBe("JetBrains Mono");
    await set("editor.fontFamily", "");
    expect(useEditorFontStore.getState().family).toBeUndefined();
    await expect(set("editor.fontFamily", "x;}body{")).rejects.toThrow(
      "editor.fontFamily: a font family is letters, digits, spaces, commas and quotes",
    );
  });

  it("refuses what nexus may do, a value the setting does not take, and an unknown key", async () => {
    await expect(set("agentCli.crossWorkspace", "allow")).rejects.toThrow(
      "agentCli.crossWorkspace is the user's to change, in Settings",
    );
    expect(useAgentCliStore.getState().crossWorkspace).toBe("ask");
    await expect(set("editor.fontSize", "99")).rejects.toThrow(
      "editor.fontSize: 99 is not within 8..32",
    );
    await expect(set("editor.size", "14")).rejects.toThrow(
      'no setting "editor.size"; nexus settings list shows them',
    );
    expect(writes).toEqual([]);
  });
});

describe("usage-limit resume settings", () => {
  it.each([
    ["chat.limitResumeDelayMinutes", "chatLimitResumeDelayMinutes", 1, 0, "61", "0..60"],
    ["chat.limitResumeMaxTries", "chatLimitResumeMaxTries", 3, 10, "0", "1..10"],
    ["chat.limitResumeDeadlineHours", "chatLimitResumeDeadlineHours", 12, 168, "169", "1..168"],
  ] as const)("reads, sets and resets %s", async (key, field, initial, value, invalid, range) => {
    expect(await get(key)).toMatchObject({ value: initial, changed: false });
    expect((await set(key, String(value))).setting).toMatchObject({ value, changed: true });
    await expect(set(key, invalid)).rejects.toThrow(`${key}: ${invalid} is not within ${range}`);
    expect((await set(key, null)).setting).toMatchObject({ value: initial, changed: false });
    expect(writes).toEqual([{ [field]: value }, { [field]: initial }]);
  });

  it("sets and reads a one-line message through the CLI commands", async () => {
    const app = fakeApp();
    app.uiAnswers.set("settings.list", (args: CliUiOps["settings.list"]["args"]) =>
      settingsHandlers["settings.list"](args),
    );
    app.uiAnswers.set("settings.set", (args: CliUiOps["settings.set"]["args"]) =>
      settingsHandlers["settings.set"](args),
    );
    const command = (...args: string[]) =>
      runCli(CLI_COMMANDS, contextFor(app, ["settings", ...args]));
    const key = "chat.limitResumeMessage";
    expect((await command("set", key, "Continue the review")).exitCode).toBe(0);
    expect((await command("get", key)).stdout).toBe("Continue the review\n");
    await expect(set(key, "Continue\nfrom here")).rejects.toThrow(
      "the message must be on one line",
    );
    expect((await command("set", key, "")).exitCode).toBe(0);
    expect(await get(key)).toMatchObject({ value: "", changed: false });
    expect(writes).toEqual([
      { chatLimitResumeMessage: "Continue the review" },
      { chatLimitResumeMessage: "" },
    ]);
  });
});

describe("settings of the editor's views, the terminal's shell and voice terms", () => {
  it("sets the view a format opens in, as source or preview, and gives back its default", async () => {
    expect(await get("editor.openIn.markdown")).toMatchObject({ value: "preview", changed: false });
    expect(await get("editor.openIn.json")).toMatchObject({ value: "source", changed: false });
    const { setting } = await set("editor.openIn.markdown", "source");
    expect(setting).toMatchObject({
      value: "source",
      changed: true,
      choices: ["source", "preview"],
    });
    expect(usePreviewDefaultsStore.getState().byFormat).toEqual({ markdown: "raw" });
    await set("editor.openIn.markdown", null);
    expect(usePreviewDefaultsStore.getState().byFormat).toEqual({});
    await expect(set("editor.openIn.markdown", "raw")).rejects.toThrow(
      'editor.openIn.markdown: "raw" is not one of source, preview',
    );
  });

  it("sets the shell by the name or id terminal shells lists, or the system's", async () => {
    expect(await get("terminal.shell")).toMatchObject({
      value: "system",
      changed: false,
      choices: ["system", "zsh", "fish"],
    });
    expect((await set("terminal.shell", "Fish")).setting).toMatchObject({
      value: "fish",
      changed: true,
    });
    expect(useTerminalStore.getState().shell).toEqual({
      kind: "detected",
      id: "/opt/homebrew/bin/fish",
    });
    await set("terminal.shell", "/bin/zsh");
    expect(useTerminalStore.getState().shell).toEqual({ kind: "detected", id: "/bin/zsh" });
    await set("terminal.shell", "system");
    expect(useTerminalStore.getState().shell).toBeUndefined();
    await expect(set("terminal.shell", "nu")).rejects.toThrow(
      'terminal.shell: no shell is named "nu"; nexus terminal shells lists them',
    );
  });

  it("replaces the voice terms with a comma-separated list, each once", async () => {
    let kept: string[] = ["Nexus"];
    answers["remote.voiceTerms"] = () => ({ ok: true, value: kept });
    answers["remote.setVoiceTerms"] = (args) => {
      kept = (args as { terms: string[] }).terms;
      return { ok: true, value: kept };
    };
    try {
      expect(await get("voice.terms")).toMatchObject({ value: "Nexus", changed: true });
      const { setting } = await set("voice.terms", "NexusCode, Claude，넥서스\nclaude");
      expect(kept).toEqual(["NexusCode", "Claude", "넥서스"]);
      expect(setting).toMatchObject({ value: "NexusCode, Claude, 넥서스" });
      await set("voice.terms", null);
      expect(kept).toEqual([]);
      await expect(set("voice.terms", "x".repeat(81))).rejects.toThrow(
        "voice.terms: a term is longer than 80 characters",
      );
    } finally {
      delete answers["remote.voiceTerms"];
      delete answers["remote.setVoiceTerms"];
    }
  });

  it("tells why the voice terms cannot be read, signed out, without failing the list", async () => {
    answers["remote.voiceTerms"] = () => ({
      ok: false,
      kind: "session-expired",
      message: "signed out of NexusCode",
    });
    try {
      const { settings } = await settingsHandlers["settings.list"]({});
      expect(settings.find((s) => s.key === "voice.terms")).toMatchObject({
        value: "",
        unavailable: "not signed in to NexusCode (Settings › Remote)",
      });
    } finally {
      delete answers["remote.voiceTerms"];
    }
  });
});

describe("language server settings", () => {
  it("turns language servers, one language and TypeScript's memory saving on and off", async () => {
    useLspSettingsStore.getState().hydrate(lspSettingsFromState({}));
    expect(await get("lsp.enabled")).toMatchObject({ value: false, changed: false });
    expect((await set("lsp.enabled", "on")).setting).toMatchObject({ value: true, changed: true });
    expect(await get("lsp.go")).toMatchObject({ value: false, changed: false });
    expect(await get("lsp.python")).toMatchObject({ value: true, changed: false });
    expect((await set("lsp.python", "off")).setting).toMatchObject({
      value: false,
      changed: true,
    });
    expect((await set("lsp.typescript.lowMemory", "off")).setting).toMatchObject({
      value: false,
      changed: true,
    });
    expect((await set("lsp.maxActiveWorkspaces", "4")).setting).toMatchObject({ value: 4 });
    expect(useLspSettingsStore.getState().settings).toMatchObject({
      enabled: true,
      maxActiveWorkspaces: 4,
      languages: { python: { enabled: false }, typescript: { lowMemory: false } },
    });
    await expect(set("lsp.maxActiveWorkspaces", "17")).rejects.toThrow(
      "lsp.maxActiveWorkspaces: 17 is not within 1..16",
    );
    await set("lsp.python", null);
    expect(await get("lsp.python")).toMatchObject({ value: true, changed: false });
    writes.pop();
    await expect(set("lsp.python", "maybe")).rejects.toThrow(
      'lsp.python: "maybe" is not on or off',
    );
    expect(writes).toEqual([
      { enabled: true },
      { languageId: "python", settings: { enabled: false } },
      { languageId: "typescript", settings: { lowMemory: false } },
      { count: 4 },
    ]);
  });
});

describe("voice language and what other devices may do here", () => {
  it("sets the voice language and refuses one it does not take", async () => {
    useVoiceStore.getState().hydrate({});
    expect(await get("voice.language")).toMatchObject({ value: "app", changed: false });
    expect((await set("voice.language", "multi")).setting).toMatchObject({
      value: "multi",
      changed: true,
    });
    expect(useVoiceStore.getState().language).toBe("multi");
    await expect(set("voice.language", "ko")).rejects.toThrow(
      'voice.language: "ko" is not one of app, multi',
    );
    await set("voice.language", null);
    expect(writes).toEqual([{ voiceLanguage: "multi" }, { voiceLanguage: "app" }]);
  });

  it("reads the remote policies but leaves changing them to the user", async () => {
    answers["remote.allowControl"] = () => ({ ok: true, value: true });
    answers["remote.allowTerminal"] = () => ({ ok: true, value: false });
    answers["remote.agentsPolicy"] = () => ({ ok: true, value: "deny" });
    answers["remote.phonePushPolicy"] = () => ({ ok: false, kind: "unknown", message: "no" });
    try {
      expect(await get("remote.control")).toMatchObject({
        value: true,
        changed: true,
        readOnly: true,
      });
      expect(await get("remote.terminal")).toMatchObject({ value: false, changed: false });
      expect(await get("remote.agents")).toMatchObject({
        value: "deny",
        choices: ["ask", "allow", "deny"],
      });
      expect(await get("remote.phonePush")).toMatchObject({ unavailable: "no" });
      for (const key of ["remote.control", "remote.terminal", "remote.agents", "remote.phonePush"])
        await expect(set(key, "on")).rejects.toThrow(`${key} is the user's to change, in Settings`);
      expect(writes).toEqual([]);
    } finally {
      for (const method of ["allowControl", "allowTerminal", "agentsPolicy", "phonePushPolicy"])
        delete answers[`remote.${method}`];
    }
  });
});

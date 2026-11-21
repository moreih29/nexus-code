/**
 * nexus settings in the renderer: each setting read from and changed through
 * the store the Settings dialog uses, and saved as the dialog saves it.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { WorkspaceMetaSchema } from "../../../../../src/shared/types/workspace";

const writes: unknown[] = [];

/** What main answers, by "channel.method"; anything else is answered with nothing. */
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

// Other files mock the IPC client process-wide, so this file installs its
// own and puts back whatever it found when it is done.
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

const set = (key: string, value: string | null) => settingsHandlers["settings.set"]({ key, value });
const get = async (key: string) => (await settingsHandlers["settings.list"]({ key })).settings[0];

// The font stores tell the page of a change; a file before this one may
// leave a window with no page, or with a stub page that cannot be told.
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
  useNotificationsStore.getState().setOsEnabled(true);
  useNotificationsStore.getState().setRateLimitWarnings(true);
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

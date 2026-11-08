/**
 * nexus settings in the renderer: each setting read from and changed through
 * the store the Settings dialog uses, and saved as the dialog saves it.
 */

import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";

const writes: unknown[] = [];

const CLIENT = "../../../../../src/renderer/ipc/client";

// Other files mock the IPC client process-wide, so this file installs its
// own and puts back whatever it found when it is done.
const previousClient = { ...(await import(CLIENT)) };
mock.module(CLIENT, () => ({
  ...previousClient,
  ipcCallResult: (_channel: string, _method: string, args: unknown) => {
    writes.push(args);
    return Promise.resolve({ ok: true, value: undefined });
  },
}));
afterAll(() => {
  mock.module(CLIENT, () => previousClient);
});

const { settingsHandlers } = await import("../../../../../src/renderer/services/cli/settings");
const { useEditorFontStore } = await import("../../../../../src/renderer/state/stores/editor-font");
const { useNotificationsStore } = await import(
  "../../../../../src/renderer/state/stores/notifications"
);
const { useAgentCliStore } = await import("../../../../../src/renderer/state/stores/agent-cli");
const { useChatFontStore } = await import("../../../../../src/renderer/state/stores/chat-font");

const set = (key: string, value: string | null) => settingsHandlers["settings.set"]({ key, value });

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
  writes.length = 0;
});

describe("settings.list", () => {
  it("gives each setting with its value, its default when unchanged", async () => {
    const { settings } = await settingsHandlers["settings.list"]({});
    expect(settings.find((s) => s.key === "editor.fontSize")).toEqual({
      key: "editor.fontSize",
      summary: "The editor's font size, in pixels",
      type: "integer",
      min: 8,
      max: 32,
      value: 16,
      changed: false,
    });
    expect(settings.find((s) => s.key === "agentCli.crossWorkspace")).toMatchObject({
      value: "ask",
      readOnly: true,
    });
  });
});

describe("settings.set", () => {
  it("changes a setting through its store, which saves it", async () => {
    const { setting } = await set("Editor.FontSize", "14");
    expect(setting).toMatchObject({ key: "editor.fontSize", value: 14, changed: true });
    expect(useEditorFontStore.getState().size).toBe(14);
    expect(writes).toContainEqual({ editorFontSize: 14 });
  });

  it("gives a setting back its default when the value is null", async () => {
    await set("editor.lineHeight", "1.0");
    expect(useEditorFontStore.getState().lineHeight).toBe(1);
    const { setting } = await set("editor.lineHeight", null);
    expect(setting).toMatchObject({ value: "1.4", changed: false });
    expect(useEditorFontStore.getState().lineHeight).toBeUndefined();
  });

  it("sets the chat tabs' text size and font, a kind of font such as system-ui too", async () => {
    const { setting } = await set("chat.fontSize", "18");
    expect(setting).toMatchObject({ key: "chat.fontSize", value: 18, changed: true });
    expect(writes).toContainEqual({ chatFontSize: 18 });
    await expect(set("chat.fontSize", "30")).rejects.toThrow();
    await set("chat.fontFamily", "system-ui");
    expect(useChatFontStore.getState().family).toBe("system-ui");
    await set("chat.fontFamily", "");
    expect(useChatFontStore.getState().family).toBeUndefined();
    await expect(set("chat.fontFamily", "x;}body{")).rejects.toThrow(
      "chat.fontFamily: a font family is letters, digits, spaces, hyphens, commas and quotes",
    );
  });

  it('takes "" as the system\'s font', async () => {
    await set("editor.fontFamily", "JetBrains Mono");
    expect(useEditorFontStore.getState().family).toBe("JetBrains Mono");
    await set("editor.fontFamily", "");
    expect(useEditorFontStore.getState().family).toBeUndefined();
    await expect(set("editor.fontFamily", "x;}body{")).rejects.toThrow(
      "editor.fontFamily: a font family is letters, digits, spaces, commas and quotes",
    );
  });

  it("saves the settings whose panel saves them", async () => {
    await set("notifications.desktop", "off");
    expect(useNotificationsStore.getState().osEnabled).toBe(false);
    expect(writes).toContainEqual({ osNotificationsEnabled: false });
    await set("notifications.rateLimitWarning", "off");
    expect(useNotificationsStore.getState().rateLimitWarnings).toBe(false);
    expect(writes).toContainEqual({ rateLimitWarnings: false });
    await set("agentCli.agentContext", "off");
    expect(useAgentCliStore.getState().agentContext).toBe(false);
    expect(writes).toContainEqual({ cliAgentContext: false });
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

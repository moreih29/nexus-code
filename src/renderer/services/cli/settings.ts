/**
 * The app settings nexus settings reads and changes: each as the Settings
 * dialog shows and changes it, through the same store, which saves it.
 */

import { ipcCallResult } from "@/ipc/client";
import { useAgentCliStore } from "@/state/stores/agent-cli";
import { useChatFontStore } from "@/state/stores/chat-font";
import { useEditorFontStore } from "@/state/stores/editor-font";
import { ICON_THEMES, useIconThemeStore } from "@/state/stores/icon-theme";
import {
  INACTIVE_PANEL_DIM_DEFAULT,
  INACTIVE_PANEL_DIM_MAX,
  INACTIVE_PANEL_DIM_MIN,
  useInactivePanelDimStore,
} from "@/state/stores/inactive-panel-dim";
import { useLanguageStore } from "@/state/stores/language";
import { useNotificationsStore } from "@/state/stores/notifications";
import { useSessionsViewStore } from "@/state/stores/sessions-view";
import { useTerminalStore } from "@/state/stores/terminal";
import { useThemeStore } from "@/state/stores/theme";
import { useUpdatesStore } from "@/state/stores/updates";
import { useWindowOpacityStore } from "@/state/stores/window-opacity";
import { type CliSettingShape, parseSettingValue } from "../../../shared/cli/settings";
import type { CliSettingInfo, CliSettingValue } from "../../../shared/cli/ui";
import { DEFAULT_THEME } from "../../../shared/design-tokens";
import { SUPPORTED_LANGUAGES, type SupportedLanguage } from "../../../shared/i18n";
import {
  DEFAULT_TASK_AGENT,
  TASK_AGENTS,
  type TaskAgent,
} from "../../../shared/sessions/task-agent";
import { DEFAULT_SESSIONS_VIEW, SESSIONS_VIEWS } from "../../../shared/sessions/view";
import { type AppState, ThemePreferenceSchema } from "../../../shared/types/app-state";
import { CHAT_FONT_SIZE, CHAT_FONT_SIZE_MAX, CHAT_FONT_SIZE_MIN } from "../chat/chat-font";
import { type CliUiHandler, UiRequestError } from "./handler";

export interface CliSetting extends CliSettingShape {
  readonly key: string;
  readonly summary: string;
  /** What it is now, and whether that is other than its default. */
  get(): { value: CliSettingValue; changed: boolean };
  /** Changes it to a value parsed for its shape; absent for one only the user changes. */
  set?(value: CliSettingValue): void;
  /** Gives it back its default; absent for one that has none to go back to. */
  reset?(): void;
}

/** Settings whose store the dialog's panel, not the store, saves. */
function save(patch: Partial<AppState>): void {
  void ipcCallResult("appState", "set", patch);
}

const FONT_SIZE = { min: 8, max: 32 } as const;
/** As the app keeps a font family: CSS cannot be slipped into it. */
const FONT_FAMILY = {
  maxLength: 120,
  pattern: {
    test: /^[A-Za-z0-9\s,'"]*$/,
    says: "a font family is letters, digits, spaces, commas and quotes",
  },
} as const;
const EDITOR_FONT_SIZE = 16;
const TERMINAL_FONT_SIZE = 14;
const LINE_HEIGHTS = ["1.0", "1.2", "1.4"] as const;
const EDITOR_LINE_HEIGHT = 1.4;

/** A font family typed: "" for the system's. */
function family(value: CliSettingValue): string | undefined {
  const text = String(value).trim();
  return text === "" ? undefined : text;
}

export const CLI_SETTINGS: readonly CliSetting[] = [
  {
    key: "appearance.theme",
    summary: "The color theme",
    type: "choice",
    choices: ThemePreferenceSchema.options,
    get: () => {
      const value = useThemeStore.getState().preference;
      return { value, changed: value !== DEFAULT_THEME };
    },
    set: (value) => useThemeStore.getState().setPreference(value as typeof DEFAULT_THEME),
    reset: () => useThemeStore.getState().setPreference(DEFAULT_THEME),
  },
  {
    key: "appearance.language",
    summary: "The app's language",
    type: "choice",
    choices: SUPPORTED_LANGUAGES,
    get: () => ({ value: useLanguageStore.getState().preference, changed: false }),
    set: (value) => useLanguageStore.getState().setPreference(value as SupportedLanguage),
  },
  {
    key: "appearance.iconTheme",
    summary: "The file icons",
    type: "choice",
    choices: ICON_THEMES,
    get: () => {
      const value = useIconThemeStore.getState().preference;
      return { value, changed: value !== "minimal" };
    },
    set: (value) =>
      useIconThemeStore.getState().setPreference(value as (typeof ICON_THEMES)[number]),
    reset: () => useIconThemeStore.getState().setPreference("minimal"),
  },
  {
    key: "appearance.windowOpacity",
    summary: "How opaque the window is; some systems apply it on restart",
    type: "number",
    // Not down to 0, as the dialog goes: a window that cannot be seen cannot be set back.
    min: 0.2,
    max: 1,
    get: () => {
      const value = useWindowOpacityStore.getState().opacity;
      return { value, changed: value !== 1 };
    },
    set: (value) => useWindowOpacityStore.getState().setOpacity(value as number),
    reset: () => useWindowOpacityStore.getState().setOpacity(1),
  },
  {
    key: "appearance.inactivePanelDim",
    summary: "How much groups other than the focused one are dimmed, as a multiple",
    type: "number",
    min: INACTIVE_PANEL_DIM_MIN,
    max: INACTIVE_PANEL_DIM_MAX,
    get: () => {
      const value = useInactivePanelDimStore.getState().dim;
      return { value, changed: value !== INACTIVE_PANEL_DIM_DEFAULT };
    },
    set: (value) => useInactivePanelDimStore.getState().setDim(value as number),
    reset: () => useInactivePanelDimStore.getState().setDim(INACTIVE_PANEL_DIM_DEFAULT),
  },
  {
    key: "editor.fontSize",
    summary: "The editor's font size, in pixels",
    type: "integer",
    ...FONT_SIZE,
    get: () => {
      const size = useEditorFontStore.getState().size;
      return { value: size ?? EDITOR_FONT_SIZE, changed: size !== undefined };
    },
    set: (value) => useEditorFontStore.getState().setSize(value as number),
    reset: () => useEditorFontStore.getState().setSize(undefined),
  },
  {
    key: "editor.fontFamily",
    summary: "The editor's font, as CSS names it; \"\" for the system's",
    type: "text",
    ...FONT_FAMILY,
    get: () => {
      const value = useEditorFontStore.getState().family;
      return { value: value ?? "", changed: value !== undefined };
    },
    set: (value) => useEditorFontStore.getState().setFamily(family(value)),
    reset: () => useEditorFontStore.getState().setFamily(undefined),
  },
  {
    key: "editor.ligatures",
    summary: "Whether the editor joins characters such as => into ligatures",
    type: "boolean",
    get: () => {
      const value = useEditorFontStore.getState().ligatures;
      return { value: value ?? false, changed: value !== undefined };
    },
    set: (value) => useEditorFontStore.getState().setLigatures(value as boolean),
    reset: () => useEditorFontStore.getState().setLigatures(undefined),
  },
  {
    key: "editor.lineHeight",
    summary: "The editor's line height, as a multiple of the font size",
    type: "choice",
    choices: LINE_HEIGHTS,
    get: () => {
      const value = useEditorFontStore.getState().lineHeight;
      return { value: (value ?? EDITOR_LINE_HEIGHT).toFixed(1), changed: value !== undefined };
    },
    set: (value) => useEditorFontStore.getState().setLineHeight(Number(value) as 1.0 | 1.2 | 1.4),
    reset: () => useEditorFontStore.getState().setLineHeight(undefined),
  },
  {
    key: "terminal.fontSize",
    summary: "The terminal's font size, in pixels",
    type: "integer",
    ...FONT_SIZE,
    get: () => {
      const size = useTerminalStore.getState().fontSize;
      return { value: size ?? TERMINAL_FONT_SIZE, changed: size !== undefined };
    },
    set: (value) => useTerminalStore.getState().setFontSize(value as number),
    reset: () => useTerminalStore.getState().setFontSize(undefined),
  },
  {
    key: "terminal.fontFamily",
    summary: "The terminal's font, as CSS names it; \"\" for the system's",
    type: "text",
    ...FONT_FAMILY,
    get: () => {
      const value = useTerminalStore.getState().fontFamily;
      return { value: value ?? "", changed: value !== undefined };
    },
    set: (value) => useTerminalStore.getState().setFontFamily(family(value)),
    reset: () => useTerminalStore.getState().setFontFamily(undefined),
  },
  {
    key: "terminal.ligatures",
    summary: "Whether the terminal joins characters such as => into ligatures",
    type: "boolean",
    get: () => {
      const value = useTerminalStore.getState().fontLigatures;
      return { value: value ?? false, changed: value !== undefined };
    },
    set: (value) => useTerminalStore.getState().setFontLigatures(value as boolean),
    reset: () => useTerminalStore.getState().setFontLigatures(undefined),
  },
  {
    key: "terminal.cursorStyle",
    summary: "The terminal's cursor",
    type: "choice",
    choices: ["block", "underline", "bar"],
    get: () => {
      const value = useTerminalStore.getState().cursorStyle;
      return { value: value ?? "block", changed: value !== undefined };
    },
    set: (value) =>
      useTerminalStore.getState().setCursorStyle(value as "block" | "underline" | "bar"),
    reset: () => useTerminalStore.getState().setCursorStyle(undefined),
  },
  {
    key: "terminal.taskAgent",
    summary: "What a new task opens: a Claude or Codex tab given its prompt, or a terminal",
    type: "choice",
    choices: TASK_AGENTS,
    get: () => {
      const value = useTerminalStore.getState().taskAgent;
      return { value: value ?? DEFAULT_TASK_AGENT, changed: value !== undefined };
    },
    set: (value) => useTerminalStore.getState().setTaskAgent(value as TaskAgent),
    reset: () => useTerminalStore.getState().setTaskAgent(undefined),
  },
  {
    key: "chat.fontSize",
    summary:
      "The size of replies in Claude and Codex tabs, in pixels; their other text scales with it",
    type: "integer",
    min: CHAT_FONT_SIZE_MIN,
    max: CHAT_FONT_SIZE_MAX,
    get: () => {
      const size = useChatFontStore.getState().size;
      return { value: size ?? CHAT_FONT_SIZE, changed: size !== undefined };
    },
    set: (value) => useChatFontStore.getState().setSize(value as number),
    reset: () => useChatFontStore.getState().setSize(undefined),
  },
  {
    key: "chat.fontFamily",
    summary: 'The font of Claude and Codex tabs, as CSS names it; "" for the app\'s',
    type: "text",
    maxLength: FONT_FAMILY.maxLength,
    pattern: {
      test: /^[A-Za-z0-9\s,'"-]*$/,
      says: "a font family is letters, digits, spaces, hyphens, commas and quotes",
    },
    get: () => {
      const value = useChatFontStore.getState().family;
      return { value: value ?? "", changed: value !== undefined };
    },
    set: (value) => useChatFontStore.getState().setFamily(family(value)),
    reset: () => useChatFontStore.getState().setFamily(undefined),
  },
  {
    key: "sessions.defaultView",
    summary: "The view an agents tab opens in",
    type: "choice",
    choices: SESSIONS_VIEWS,
    get: () => {
      const value = useSessionsViewStore.getState().defaultView;
      return { value: value ?? DEFAULT_SESSIONS_VIEW, changed: value !== undefined };
    },
    set: (value) =>
      useSessionsViewStore.getState().setDefault(value as (typeof SESSIONS_VIEWS)[number]),
    reset: () => useSessionsViewStore.getState().setDefault(undefined),
  },
  {
    key: "notifications.desktop",
    summary: "Whether agents' notifications show on the desktop",
    type: "boolean",
    get: () => {
      const value = useNotificationsStore.getState().osEnabled;
      return { value, changed: !value };
    },
    set: (value) => {
      useNotificationsStore.getState().setOsEnabled(value as boolean);
      save({ osNotificationsEnabled: value as boolean });
    },
    reset: () => {
      useNotificationsStore.getState().setOsEnabled(true);
      save({ osNotificationsEnabled: true });
    },
  },
  {
    key: "notifications.rateLimitWarning",
    summary: "Whether Claude tabs warn when the usage limit is near",
    type: "boolean",
    get: () => {
      const value = useNotificationsStore.getState().rateLimitWarnings;
      return { value, changed: !value };
    },
    set: (value) => {
      useNotificationsStore.getState().setRateLimitWarnings(value as boolean);
      save({ rateLimitWarnings: value as boolean });
    },
    reset: () => {
      useNotificationsStore.getState().setRateLimitWarnings(true);
      save({ rateLimitWarnings: true });
    },
  },
  {
    key: "updates.autoCheck",
    summary: "Whether the app looks for updates by itself",
    type: "boolean",
    get: () => {
      const value = useUpdatesStore.getState().autoCheckEnabled;
      return { value, changed: !value };
    },
    set: (value) => {
      useUpdatesStore.getState().setAutoCheckEnabled(value as boolean);
      save({ autoCheckForUpdates: value as boolean });
    },
    reset: () => {
      useUpdatesStore.getState().setAutoCheckEnabled(true);
      save({ autoCheckForUpdates: true });
    },
  },
  {
    key: "agentCli.agentContext",
    summary: "Whether Claude Code sessions are told about nexus when they start",
    type: "boolean",
    get: () => {
      const value = useAgentCliStore.getState().agentContext;
      return { value, changed: !value };
    },
    set: (value) => {
      useAgentCliStore.getState().set({ agentContext: value as boolean });
      save({ cliAgentContext: value as boolean });
    },
    reset: () => {
      useAgentCliStore.getState().set({ agentContext: true });
      save({ cliAgentContext: true });
    },
  },
  // What nexus may do is the user's to say: these two are not changed from it.
  {
    key: "agentCli.crossWorkspace",
    summary: "Whether nexus may change other workspaces than its terminal's: ask, allow or deny",
    type: "choice",
    choices: ["ask", "allow", "deny"],
    get: () => {
      const value = useAgentCliStore.getState().crossWorkspace;
      return { value, changed: value !== "ask" };
    },
  },
  {
    key: "agentCli.enabled",
    summary: "Whether the nexus command works in the app's terminals",
    type: "boolean",
    get: () => {
      const value = useAgentCliStore.getState().enabled;
      return { value, changed: !value };
    },
  },
];

/** A setting as main gets it. */
export function settingInfo(setting: CliSetting): CliSettingInfo {
  const { value, changed } = setting.get();
  return {
    key: setting.key,
    summary: setting.summary,
    type: setting.type,
    ...(setting.choices ? { choices: setting.choices } : {}),
    ...(setting.min !== undefined ? { min: setting.min } : {}),
    ...(setting.max !== undefined ? { max: setting.max } : {}),
    value,
    changed,
    ...(setting.set ? {} : { readOnly: true }),
  };
}

export const settingsHandlers: {
  "settings.list": CliUiHandler<"settings.list">;
  "settings.set": CliUiHandler<"settings.set">;
} = {
  "settings.list": async () => ({ settings: CLI_SETTINGS.map(settingInfo) }),
  "settings.set": async ({ key, value }) => {
    const setting = CLI_SETTINGS.find((s) => s.key.toLowerCase() === key.toLowerCase());
    if (!setting) {
      throw new UiRequestError(`no setting "${key}"; nexus settings list shows them`);
    }
    if (!setting.set) {
      throw new UiRequestError(`${setting.key} is the user's to change, in Settings`);
    }
    if (value === null) {
      if (!setting.reset) throw new UiRequestError(`${setting.key} has no default to go back to`);
      setting.reset();
    } else {
      const parsed = parseSettingValue(setting, value);
      if ("error" in parsed) throw new UiRequestError(`${setting.key}: ${parsed.error}`);
      setting.set(parsed.value);
    }
    return { setting: settingInfo(setting) };
  },
};

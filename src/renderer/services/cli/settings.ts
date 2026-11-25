import i18next from "i18next";
import { ipcCallResult, unwrapIpcResult } from "@/ipc/client";
import { keybindingConflictMessage } from "@/keybindings/conflict-message";
import { borrowedClaudeModels, useClaudeModelCatalog } from "@/services/chat/claude/model-catalog";
import { summaryCatalogKey, summaryModels, summaryProfile } from "@/services/notes/summary-models";
import { loadVoiceMemory, voiceMemoryApi } from "@/services/notes/voice-memory";
import { checkForUpdates } from "@/services/updates/operations";
import { useAgentCliStore } from "@/state/stores/agent-cli";
import { saveInstructionEdits, useAgentInstructionsStore } from "@/state/stores/agent-instructions";
import { useAgentListViewStore } from "@/state/stores/agent-list-view";
import { resolveWorkspaceProfile, useAgentProfilesStore } from "@/state/stores/agent-profiles";
import { useChatFontStore } from "@/state/stores/chat-font";
import { useEditorFontStore } from "@/state/stores/editor-font";
import { ICON_THEMES, useIconThemeStore } from "@/state/stores/icon-theme";
import {
  INACTIVE_PANEL_DIM_DEFAULT,
  INACTIVE_PANEL_DIM_MAX,
  INACTIVE_PANEL_DIM_MIN,
  useInactivePanelDimStore,
} from "@/state/stores/inactive-panel-dim";
import { useKeybindingsStore } from "@/state/stores/keybindings";
import { useLanguageStore } from "@/state/stores/language";
import { useLspSettingsStore } from "@/state/stores/lsp-settings";
import { useLspStatusStore } from "@/state/stores/lsp-status";
import { useNoteSummarySettings } from "@/state/stores/note-summary";
import { useNotificationsStore } from "@/state/stores/notifications";
import { usePreviewDefaultsStore } from "@/state/stores/preview-defaults";
import { useTerminalStore } from "@/state/stores/terminal";
import { useThemeStore } from "@/state/stores/theme";
import { useUpdatesStore } from "@/state/stores/updates";
import { useVoiceStore, type VoiceLanguagePreference } from "@/state/stores/voice";
import { useWindowOpacityStore } from "@/state/stores/window-opacity";
import { useWorkspacesStore } from "@/state/stores/workspaces";
import { hostPlatform, isMac, isWindows } from "@/utils/platform";
import { AGENT_LIST_VIEWS, DEFAULT_AGENT_LIST_VIEW } from "../../../shared/agent-list/view";
import { profilesOf } from "../../../shared/agent-profiles/profiles";
import {
  mergeAgentInstructions,
  persistentInstructionLayers,
  workspaceInstructionTarget,
} from "../../../shared/chat/instructions";
import {
  LIMIT_RESUME_BOUNDS,
  LIMIT_RESUME_DEFAULTS,
  LIMIT_RESUME_MESSAGE_LINE,
} from "../../../shared/chat/limit-resume-settings";
import {
  type CliSettingShape,
  LSP_PATH_SHAPE,
  lspPathSetting,
  parseSettingValue,
  settingAskingToTurnOn,
} from "../../../shared/cli/settings";
import type {
  CliKeyBinding,
  CliKeyChange,
  CliSettingInfo,
  CliSettingValue,
} from "../../../shared/cli/ui";
import { DEFAULT_THEME } from "../../../shared/design-tokens";
import { SUPPORTED_LANGUAGES, type SupportedLanguage } from "../../../shared/i18n";
import {
  appBindingShape,
  BINDABLE_COMMANDS,
  type BindableCommandId,
  type BindingShape,
  editorConflictBindings,
  editorEffectivePrimary,
  isSevereConflict,
  proposedBindingConflicts,
} from "../../../shared/keybindings/edit";
import { EDITOR_COMMANDS } from "../../../shared/keybindings/editor-commands";
import {
  acceleratorToLabel,
  namesSuperKey,
  recordedAccelerator,
} from "../../../shared/keybindings/keybinding-parse";
import { AcceleratorStringSchema } from "../../../shared/keybindings/overrides";
import { BUILTIN_LSP_PRESETS, type BuiltinLspPresetLanguageId } from "../../../shared/lsp/config";
import {
  isLspLanguageChosen,
  isLspLowMemory,
  LSP_MAX_ACTIVE_WORKSPACES_LIMIT,
  LSP_PATH_LANGUAGES,
  type LspLanguageSettings,
  type LspSettings,
} from "../../../shared/lsp/settings";
import type { RecordingSummarySettings } from "../../../shared/notes/summary";
import { type ShellChoice, sameShellChoice } from "../../../shared/pty/shell";
import { MAX_VOICE_TERM_CHARS, MAX_VOICE_TERMS } from "../../../shared/remote/voice";
import {
  DEFAULT_TASK_AGENT,
  TASK_AGENTS,
  type TaskAgent,
} from "../../../shared/sessions/task-agent";
import { type AppState, ThemePreferenceSchema } from "../../../shared/types/app-state";
import { LSP_MAX_ACTIVE_WORKSPACES } from "../../../shared/util/timing-constants";
import { CHAT_FONT_SIZE, CHAT_FONT_SIZE_MAX, CHAT_FONT_SIZE_MIN } from "../chat/chat-font";
import { builtInViewMode, PREVIEW_FORMATS } from "../editor/preview/previewable";
import { loadShellMenu, shellNamed } from "../terminal/installed-shells";
import { addTerms, splitTerms } from "../voice/terms";
import { type CliUiHandler, UiRequestError } from "./handler";

export interface CliSettingNow {
  value: CliSettingValue;
  changed: boolean;
  choices?: readonly string[];
  unavailable?: string;
}

export interface CliSetting extends CliSettingShape {
  readonly key: string;
  readonly summary: string;
  get(): CliSettingNow | Promise<CliSettingNow>;
  set?(value: CliSettingValue): void | Promise<void>;
  reset?(): void | Promise<void>;
  parse?(input: string): Promise<{ value: CliSettingValue } | { error: string }>;
}

function save(patch: Partial<AppState>): void {
  void ipcCallResult("appState", "set", patch);
}

function limitResumeNumber(
  key: string,
  field: keyof typeof LIMIT_RESUME_BOUNDS,
  summary: string,
): CliSetting {
  const defaultValue = LIMIT_RESUME_DEFAULTS[field];
  return {
    key,
    summary,
    type: "integer",
    ...LIMIT_RESUME_BOUNDS[field],
    get: () => {
      const value = useNotificationsStore.getState().limitResumeOptions[field];
      return { value, changed: value !== defaultValue };
    },
    set: (value) =>
      useNotificationsStore.getState().setLimitResumeOptions({ [field]: value as number }),
    reset: () => useNotificationsStore.getState().setLimitResumeOptions({ [field]: defaultValue }),
  };
}

const FONT_SIZE = { min: 8, max: 32 } as const;
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

function family(value: CliSettingValue): string | undefined {
  const text = String(value).trim();
  return text === "" ? undefined : text;
}

const OPEN_IN = ["source", "preview"] as const;

const SYSTEM_SHELL = "system";

async function shellNamedNow(name: string): Promise<ShellChoice | undefined | null> {
  if (name.trim().toLowerCase() === SYSTEM_SHELL) return undefined;
  const { entries } = await loadShellMenu();
  return shellNamed(entries, name)?.choice ?? null;
}

const VOICE_TERMS_MS = 5_000;

function voiceTermsFailure(kind: string | undefined): string {
  return kind === "session-expired"
    ? "not signed in to NexusCode (Settings › Remote)"
    : "the NexusCode server did not answer";
}

async function voiceTerms(): Promise<{ terms: string[] } | { unavailable: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<{ unavailable: string }>((resolve) => {
    timer = setTimeout(
      () => resolve({ unavailable: voiceTermsFailure(undefined) }),
      VOICE_TERMS_MS,
    );
  });
  const asked = ipcCallResult("remote", "voiceTerms", undefined).then(
    (result) =>
      result.ok ? { terms: result.value } : { unavailable: voiceTermsFailure(result.kind) },
    () => ({ unavailable: voiceTermsFailure(undefined) }),
  );
  return Promise.race([asked, late]).finally(() => clearTimeout(timer));
}

async function saveVoiceTerms(terms: string[]): Promise<void> {
  const result = await ipcCallResult("remote", "setVoiceTerms", { terms });
  if (!result.ok) throw new UiRequestError(`voice.terms: ${voiceTermsFailure(result.kind)}`);
}

function changeLspSettings(change: (settings: LspSettings) => LspSettings): void {
  const store = useLspSettingsStore.getState();
  store.hydrate(change(store.settings));
}

async function setLspMaxActiveWorkspaces(count: number): Promise<void> {
  unwrapIpcResult(await ipcCallResult("lsp", "setMaxActiveWorkspaces", { count }));
  changeLspSettings((settings) => ({ ...settings, maxActiveWorkspaces: count }));
}

async function setLspLanguage(
  languageId: BuiltinLspPresetLanguageId,
  patch: LspLanguageSettings,
): Promise<void> {
  unwrapIpcResult(
    await ipcCallResult("lsp", "setLanguageSettings", { languageId, settings: patch }),
  );
  changeLspSettings((settings) => ({
    ...settings,
    languages: {
      ...settings.languages,
      [languageId]: { ...settings.languages[languageId], ...patch },
    },
  }));
}

function setVoiceLanguage(language: VoiceLanguagePreference): void {
  useVoiceStore.getState().setLanguage(language);
  save({ voiceLanguage: language });
}

function remoteReading(
  key: string,
  summary: string,
  method: "allowControl" | "allowTerminal" | "agentsPolicy" | "phonePushPolicy",
  defaultValue: CliSettingValue,
  choices?: readonly string[],
): CliSetting {
  return {
    key,
    summary,
    type: choices ? "choice" : "boolean",
    ...(choices ? { choices } : {}),
    get: async () => {
      const result = await ipcCallResult("remote", method, undefined);
      if (!result.ok) return { value: defaultValue, changed: false, unavailable: result.message };
      return { value: result.value, changed: result.value !== defaultValue };
    },
  };
}

async function saveSummary(next: RecordingSummarySettings): Promise<void> {
  unwrapIpcResult(await ipcCallResult("appState", "set", { noteSummary: next }));
  useNoteSummarySettings.setState(next, true);
}

function currentSummaryProfile() {
  return summaryProfile(useAgentProfilesStore.getState().config, useNoteSummarySettings.getState());
}

function currentSummaryModels() {
  const { profileId, profile } = currentSummaryProfile();
  const discovered = borrowedClaudeModels(
    useClaudeModelCatalog.getState(),
    summaryCatalogKey(profileId, profile),
    "",
  );
  return { profile, ...summaryModels(profile, discovered) };
}

const DEFAULT_SUMMARY_MODEL = "default";

function summaryProfileNamed(input: string): { value: CliSettingValue } | { error: string } {
  const { profiles } = currentSummaryProfile();
  const exact = profiles.find(({ id }) => id === input);
  if (exact) return { value: exact.id };
  const wanted = input.trim().toLowerCase();
  const found = profiles.filter(
    ({ id, name }) => id.toLowerCase() === wanted || name.trim().toLowerCase() === wanted,
  );
  if (found.length > 1) return { error: `more than one Claude profile is "${input}"; give its id` };
  const [profile] = found;
  if (!profile)
    return { error: `no Claude profile "${input}"; nexus chat profiles --agent claude lists them` };
  return { value: profile.id };
}

function summaryModelNamed(input: string): { value: CliSettingValue } | { error: string } {
  const { profile, choices } = currentSummaryModels();
  const text = input.trim();
  if (text.toLowerCase() === DEFAULT_SUMMARY_MODEL) return { value: DEFAULT_SUMMARY_MODEL };
  if (!profile) return { error: "its profile is gone; choose another with notes.summaryProfile" };
  const found =
    choices.find(({ value }) => value === text) ??
    choices.find(({ value }) => value.toLowerCase() === text.toLowerCase());
  if (found) return { value: found.value };
  return {
    error: `"${input}" is not a model of that profile: ${[DEFAULT_SUMMARY_MODEL, ...choices.map((c) => c.value)].join(", ")}`,
  };
}

function voiceMemorySetting(key: string, summary: string, field: "suggest" | "expire"): CliSetting {
  return {
    key,
    summary,
    type: "boolean",
    get: async () => {
      const status = await loadVoiceMemory();
      if (!status)
        return { value: true, changed: false, unavailable: "voice memory did not answer" };
      if (!status.available)
        return {
          value: status[field],
          changed: false,
          unavailable: "remembering voices is not available on this computer",
        };
      return { value: status[field], changed: !status[field] };
    },
    set: async (value) => {
      try {
        await voiceMemoryApi.configure({ [field]: value as boolean });
      } catch {
        throw new UiRequestError(
          `${key}: remembered voices could not be changed; their keychain may be locked`,
        );
      }
    },
  };
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
  ...PREVIEW_FORMATS.map(
    ({ engine, extensions }): CliSetting => ({
      key: `editor.openIn.${engine}`,
      summary: `What ${extensions.join(", ")} files open in: their source or their preview`,
      type: "choice",
      choices: OPEN_IN,
      get: () => {
        const chosen = usePreviewDefaultsStore.getState().byFormat[engine];
        const mode = chosen ?? builtInViewMode(engine);
        return { value: mode === "raw" ? "source" : "preview", changed: chosen !== undefined };
      },
      set: (value) =>
        usePreviewDefaultsStore
          .getState()
          .setDefault(engine, value === "source" ? "raw" : "preview"),
      reset: () => usePreviewDefaultsStore.getState().setDefault(engine, undefined),
    }),
  ),
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
    key: "terminal.shell",
    summary:
      'The shell new terminals of local workspaces run: a name or id "nexus terminal shells" lists, or system',
    type: "choice",
    get: async () => {
      const { entries } = await loadShellMenu();
      const { shell } = useTerminalStore.getState();
      const chosen = shell && entries.find((e) => sameShellChoice(e.choice, shell));
      const value =
        shell === undefined
          ? SYSTEM_SHELL
          : (chosen?.name ??
            `${shell.kind === "detected" ? shell.id : "a removed shell"} (not found)`);
      return {
        value,
        changed: shell !== undefined,
        choices: [SYSTEM_SHELL, ...entries.map((e) => e.name)],
      };
    },
    parse: async (input) =>
      (await shellNamedNow(input)) === null
        ? { error: `no shell is named "${input}"; nexus terminal shells lists them` }
        : { value: input.trim() },
    set: async (value) => {
      const shell = await shellNamedNow(String(value));
      if (shell !== null) useTerminalStore.getState().setShell(shell);
    },
    reset: () => useTerminalStore.getState().setShell(undefined),
  },
  {
    key: "terminal.taskAgent",
    summary: "What the agent list's [+] (Claude for a terminal) and a new task open",
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
    key: "chat.limitResume",
    summary: "Whether a subscription's chat tab goes on by itself once its usage limit resets",
    type: "boolean",
    get: () => {
      const value = useNotificationsStore.getState().limitResume;
      return { value, changed: !value };
    },
    set: (value) => {
      useNotificationsStore.getState().setLimitResume(value as boolean);
      save({ chatLimitResume: value as boolean });
    },
    reset: () => {
      useNotificationsStore.getState().setLimitResume(true);
      save({ chatLimitResume: true });
    },
  },
  limitResumeNumber(
    "chat.limitResumeDelayMinutes",
    "chatLimitResumeDelayMinutes",
    "Minutes to wait after the usage limit resets",
  ),
  limitResumeNumber(
    "chat.limitResumeMaxTries",
    "chatLimitResumeMaxTries",
    "Maximum attempts to resume after a usage limit",
  ),
  limitResumeNumber(
    "chat.limitResumeDeadlineHours",
    "chatLimitResumeDeadlineHours",
    "Hours after a stop during which the app may resume automatically",
  ),
  {
    key: "chat.limitResumeMessage",
    summary: 'The resume message; "" for the default in the app\'s language',
    type: "text",
    pattern: { test: LIMIT_RESUME_MESSAGE_LINE, says: "the message must be on one line" },
    get: () => {
      const value = useNotificationsStore
        .getState()
        .limitResumeOptions.chatLimitResumeMessage.trim();
      return { value, changed: value !== LIMIT_RESUME_DEFAULTS.chatLimitResumeMessage };
    },
    set: (value) =>
      useNotificationsStore
        .getState()
        .setLimitResumeOptions({ chatLimitResumeMessage: String(value).trim() }),
    reset: () =>
      useNotificationsStore.getState().setLimitResumeOptions({
        chatLimitResumeMessage: LIMIT_RESUME_DEFAULTS.chatLimitResumeMessage,
      }),
  },
  {
    key: "sessions.defaultView",
    summary: "The view an agent list opens in",
    type: "choice",
    choices: AGENT_LIST_VIEWS,
    get: () => {
      const value = useAgentListViewStore.getState().defaultView;
      return { value: value ?? DEFAULT_AGENT_LIST_VIEW, changed: value !== undefined };
    },
    set: (value) =>
      useAgentListViewStore.getState().setDefault(value as (typeof AGENT_LIST_VIEWS)[number]),
    reset: () => useAgentListViewStore.getState().setDefault(undefined),
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
    key: "lsp.enabled",
    summary: "Whether language servers are enabled",
    type: "boolean",
    get: () => {
      const { enabled } = useLspSettingsStore.getState().settings;
      return { value: enabled, changed: enabled };
    },
    set: async (value) => {
      const enabled = value as boolean;
      unwrapIpcResult(await ipcCallResult("lsp", "setEnabled", { enabled }));
      changeLspSettings((settings) => ({ ...settings, enabled }));
    },
    reset: async () => {
      unwrapIpcResult(await ipcCallResult("lsp", "setEnabled", { enabled: false }));
      changeLspSettings((settings) => ({ ...settings, enabled: false }));
    },
  },
  {
    key: "lsp.maxActiveWorkspaces",
    summary: "Maximum number of workspaces with active language servers",
    type: "integer",
    min: 1,
    max: LSP_MAX_ACTIVE_WORKSPACES_LIMIT,
    get: () => {
      const { maxActiveWorkspaces } = useLspSettingsStore.getState().settings;
      return {
        value: maxActiveWorkspaces,
        changed: maxActiveWorkspaces !== LSP_MAX_ACTIVE_WORKSPACES,
      };
    },
    set: (value) => setLspMaxActiveWorkspaces(value as number),
    reset: () => setLspMaxActiveWorkspaces(LSP_MAX_ACTIVE_WORKSPACES),
  },
  ...BUILTIN_LSP_PRESETS.map((preset): CliSetting => {
    const { languageId } = preset;
    const system = "system" in preset && preset.system === true;
    return {
      key: `lsp.${languageId}`,
      summary: system
        ? `Whether the ${languageId} language server you installed runs`
        : `Whether the bundled ${languageId} language server runs`,
      type: "boolean",
      get: () => {
        const settings = useLspSettingsStore.getState().settings.languages[languageId];
        const value = isLspLanguageChosen(languageId, settings);
        return { value, changed: value === system };
      },
      set: (value) => setLspLanguage(languageId, { enabled: value as boolean }),
      reset: () => setLspLanguage(languageId, { enabled: !system }),
    };
  }),
  {
    key: "lsp.typescript.lowMemory",
    summary: "Whether the TypeScript language server saves memory, skipping its syntax server",
    type: "boolean",
    get: () => {
      const settings = useLspSettingsStore.getState().settings.languages.typescript;
      return { value: isLspLowMemory(settings), changed: settings?.lowMemory === false };
    },
    set: (value) => setLspLanguage("typescript", { lowMemory: value as boolean }),
    reset: () => setLspLanguage("typescript", { lowMemory: true }),
  },
  ...LSP_PATH_LANGUAGES.map(
    (languageId): CliSetting => ({
      key: `lsp.${languageId}.path`,
      summary: `The ${languageId} language server you installed: its path, or "" to look on the PATH; setting a path asks the user`,
      ...LSP_PATH_SHAPE,
      get: () => {
        const settings = useLspSettingsStore.getState().settings.languages[languageId];
        const value = settings?.path?.trim() ?? "";
        return { value, changed: value !== "" };
      },
      set: (value) => setLspLanguage(languageId, { path: String(value).trim() }),
      reset: () => setLspLanguage(languageId, { path: "" }),
    }),
  ),
  {
    key: "updates.status",
    summary: "The status of the latest update check or download",
    type: "text",
    get: () => {
      const { status } = useUpdatesStore.getState();
      const version =
        status &&
        ("version" in status ? status.version : "latest" in status ? status.latest : undefined);
      return {
        value: status ? [status.kind, version].filter(Boolean).join(" ") : "unchecked",
        changed: false,
      };
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
  {
    key: "voice.terms",
    summary:
      "Words voice input should recognize, for all your computers: the whole list, comma-separated",
    type: "text",
    get: async () => {
      const read = await voiceTerms();
      if ("unavailable" in read) return { value: "", changed: false, ...read };
      return { value: read.terms.join(", "), changed: read.terms.length > 0 };
    },
    parse: async (input) => {
      const read = addTerms([], input);
      if (read.status === "too-long") {
        return { error: `a term is longer than ${MAX_VOICE_TERM_CHARS} characters` };
      }
      if (read.status === "too-many") return { error: `more than ${MAX_VOICE_TERMS} terms` };
      return { value: read.status === "ok" ? read.terms.join(", ") : "" };
    },
    set: (value) => saveVoiceTerms(splitTerms(String(value))),
    reset: () => saveVoiceTerms([]),
  },
  {
    key: "voice.language",
    summary: "What voice input listens for: the app's language, or many languages",
    type: "choice",
    choices: ["app", "multi"],
    get: () => {
      const value = useVoiceStore.getState().language;
      return { value, changed: value !== "app" };
    },
    set: (value) => setVoiceLanguage(value as VoiceLanguagePreference),
    reset: () => setVoiceLanguage("app"),
  },
  remoteReading(
    "remote.control",
    "Whether your other computers and phone may control this one's chats",
    "allowControl",
    false,
  ),
  remoteReading(
    "remote.terminal",
    "Whether your other computers and phone may type into this one's terminals",
    "allowTerminal",
    false,
  ),
  remoteReading(
    "remote.agents",
    "Whether agents on your other computers may act here: ask, allow or deny",
    "agentsPolicy",
    "ask",
    ["ask", "allow", "deny"],
  ),
  remoteReading(
    "remote.phonePush",
    "When your phone is notified: away, always or off",
    "phonePushPolicy",
    "away",
    ["away", "always", "off"],
  ),
  {
    key: "notes.summary",
    summary: "Whether finished recordings are summarized by Claude; turning it on asks the user",
    type: "boolean",
    get: () => {
      const { enabled } = useNoteSummarySettings.getState();
      return { value: enabled, changed: enabled };
    },
    set: (value) =>
      saveSummary({ ...useNoteSummarySettings.getState(), enabled: value as boolean }),
    reset: () => saveSummary({ ...useNoteSummarySettings.getState(), enabled: false }),
  },
  {
    key: "notes.summaryProfile",
    summary:
      "The Claude profile that summarizes recordings: an id or name nexus chat profiles lists",
    type: "choice",
    get: () => {
      const { profiles, profileId, defaultId } = currentSummaryProfile();
      return {
        value: profileId,
        changed: profileId !== defaultId,
        choices: profiles.map(({ id }) => id),
      };
    },
    parse: async (input) => summaryProfileNamed(input),
    set: (value) => {
      const { defaultId, profileId } = currentSummaryProfile();
      if (useNoteSummarySettings.getState().enabled && value !== profileId) {
        throw new UiRequestError(
          "notes.summaryProfile: turn notes.summary off before choosing another profile; turning it back on asks the user",
        );
      }
      return saveSummary({
        ...useNoteSummarySettings.getState(),
        profileId: value === defaultId ? undefined : String(value),
        model: undefined,
      });
    },
    reset: () => {
      const { defaultId, profileId } = currentSummaryProfile();
      if (useNoteSummarySettings.getState().enabled && profileId !== defaultId) {
        throw new UiRequestError(
          "notes.summaryProfile: turn notes.summary off before choosing another profile; turning it back on asks the user",
        );
      }
      return saveSummary({
        ...useNoteSummarySettings.getState(),
        profileId: undefined,
        model: undefined,
      });
    },
  },
  {
    key: "notes.summaryModel",
    summary: 'The model that summarizes recordings: one its profile has, or "default"',
    type: "choice",
    get: () => {
      const { model } = useNoteSummarySettings.getState();
      return {
        value: model ?? DEFAULT_SUMMARY_MODEL,
        changed: model !== undefined,
        choices: [DEFAULT_SUMMARY_MODEL, ...currentSummaryModels().choices.map((c) => c.value)],
      };
    },
    parse: async (input) => summaryModelNamed(input),
    set: (value) =>
      saveSummary({
        ...useNoteSummarySettings.getState(),
        model: value === DEFAULT_SUMMARY_MODEL ? undefined : String(value),
      }),
    reset: () => saveSummary({ ...useNoteSummarySettings.getState(), model: undefined }),
  },
  voiceMemorySetting(
    "notes.voiceSuggest",
    "Whether remembered voices suggest names in recordings; turning it on asks the user",
    "suggest",
  ),
  voiceMemorySetting(
    "notes.voiceExpire",
    "Whether a voice not heard in a recording for a year is forgotten; turning it on asks the user",
    "expire",
  ),
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

const UPDATE_CHECK_MS = 60_000;

function checked(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let stop = () => {};
    const timer = setTimeout(() => {
      stop();
      resolve();
    }, timeoutMs);
    const done = () => {
      clearTimeout(timer);
      stop();
      resolve();
    };
    stop = useUpdatesStore.subscribe(({ checking }) => {
      if (!checking) done();
    });
    if (!useUpdatesStore.getState().checking) done();
  });
}

function keyBindings(): CliKeyBinding[] {
  const { effectiveBindings, editorOverrides } = useKeybindingsStore.getState();
  return [
    ...effectiveBindings.map(({ command, primary, chord, when }) => ({
      command,
      area: "app" as const,
      primary: primary ? shownKey(primary) : null,
      ...(chord ? { chord: [shownKey(chord[0]), shownKey(chord[1])] as const } : {}),
      ...(when !== undefined ? { when } : {}),
    })),
    ...EDITOR_COMMANDS.map(({ id, defaultPrimary }) => {
      const primary = editorEffectivePrimary(editorOverrides, id, defaultPrimary);
      return {
        command: id,
        area: "editor" as const,
        primary: primary === null ? null : shownKey(primary),
      };
    }),
  ];
}

type KeyTarget =
  | { area: "app"; command: BindableCommandId; shape: BindingShape }
  | { area: "editor"; command: string; shape: BindingShape };

function keyTarget(command: string): KeyTarget {
  const app = BINDABLE_COMMANDS.find((id) => id === command);
  if (app) return { area: "app", command: app, shape: appBindingShape(app) };
  if (EDITOR_COMMANDS.some(({ id }) => id === command))
    return { area: "editor", command, shape: { kind: "primary", when: undefined } };
  throw new UiRequestError(
    `no command "${command}" takes a shortcut; nexus settings keys list shows them`,
  );
}

function checkedKeys(target: KeyTarget, keys: readonly string[]): string[] {
  const chord = target.shape.kind === "chord";
  if (keys.length !== (chord ? 2 : 1)) {
    throw new UiRequestError(
      chord
        ? `${target.command} takes a two-key chord, such as "CmdOrCtrl+K CmdOrCtrl+S"`
        : `${target.command} takes one key, such as "CmdOrCtrl+Shift+P"`,
    );
  }
  const mac = isMac();
  const superKey = isWindows() ? "Windows key" : "Super key";
  return keys.map((key) => {
    if (!mac && namesSuperKey(key)) {
      throw new UiRequestError(
        `"${key}": shortcuts can't use the ${superKey}, as Settings › Keyboard Shortcuts can't record it`,
      );
    }
    if (!AcceleratorStringSchema.safeParse(key).success)
      throw new UiRequestError(`"${key}" is not a key such as CmdOrCtrl+Shift+P`);
    if (mac) return key;
    const recorded = recordedAccelerator(key, false);
    if (recorded === null) {
      throw new UiRequestError(
        `"${key}": Cmd is Ctrl here, so Cmd+Ctrl would take the ${superKey}, which Settings › Keyboard Shortcuts can't record`,
      );
    }
    return recorded;
  });
}

function shownKey(accel: string): string {
  return isMac() ? accel : acceleratorToLabel(accel, { isMac: false, platform: hostPlatform() });
}

function changeKeys(change: CliKeyChange): string[] {
  const store = useKeybindingsStore.getState();
  if (change.op === "reset" && change.command === undefined) {
    store.resetAll();
    store.resetAllEditor();
    return [];
  }
  const target = keyTarget(change.command as string);
  const { command } = target;
  if (change.op === "reset") {
    if (target.area === "app") store.resetCommand(command);
    else store.resetEditorCommand(command);
    return [];
  }
  if (change.op === "unbind") {
    if (target.area === "editor") store.setEditorOverride({ command, primary: null });
    else if (target.shape.kind === "chord") store.setOverride({ command, chord: null });
    else store.setOverride({ command, primary: null });
    return [];
  }
  const keys = checkedKeys(target, change.keys);
  const conflicts = proposedBindingConflicts({
    command,
    ...target.shape,
    keys,
    bindings:
      target.area === "app"
        ? store.effectiveBindings
        : editorConflictBindings(store.editorOverrides),
    isMac: isMac(),
    isWindows: isWindows(),
  });
  const t = i18next.getFixedT("en", "settings");
  const blocking = conflicts.filter(isSevereConflict);
  if (blocking.length > 0) {
    throw new UiRequestError(
      `${keys.map(shownKey).join(" ")} for ${command}: ${blocking.map((c) => keybindingConflictMessage(t, c)).join("; ")}. ${t("keybindings.conflict.screenSaves")}`,
    );
  }
  if (target.area === "editor") store.setEditorOverride({ command, primary: keys[0] as string });
  else if (target.shape.kind === "chord")
    store.setOverride({ command, chord: [keys[0] as string, keys[1] as string] });
  else store.setOverride({ command, primary: keys[0] as string });
  return conflicts.map((c) => keybindingConflictMessage(t, c));
}

export async function settingInfo(setting: CliSetting): Promise<CliSettingInfo> {
  const { value, changed, choices = setting.choices, unavailable } = await setting.get();
  return {
    key: setting.key,
    summary: setting.summary,
    type: setting.type,
    ...(choices ? { choices } : {}),
    ...(setting.min !== undefined ? { min: setting.min } : {}),
    ...(setting.max !== undefined ? { max: setting.max } : {}),
    value,
    changed,
    ...(setting.set ? {} : { readOnly: true }),
    ...(unavailable ? { unavailable } : {}),
  };
}

const named = (key: string) => (setting: CliSetting) =>
  setting.key.toLowerCase() === key.toLowerCase();

export const settingsHandlers: {
  "settings.instructions": CliUiHandler<"settings.instructions">;
  "settings.instructions.set": CliUiHandler<"settings.instructions.set">;
  "settings.keys": CliUiHandler<"settings.keys">;
  "settings.keys.set": CliUiHandler<"settings.keys.set">;
  "settings.lspStatus": CliUiHandler<"settings.lspStatus">;
  "settings.updateStatus": CliUiHandler<"settings.updateStatus">;
  "settings.updateCheck": CliUiHandler<"settings.updateCheck">;
  "settings.logsPath": CliUiHandler<"settings.logsPath">;
  "settings.list": CliUiHandler<"settings.list">;
  "settings.set": CliUiHandler<"settings.set">;
} = {
  "settings.instructions": async ({ workspaceId, agent, profileId }) => {
    const { workspaces } = useWorkspacesStore.getState();
    const workspace = workspaces.find((w) => w.id === workspaceId);
    if (!workspace) throw new UiRequestError("that workspace is gone");
    const profile =
      profileId === undefined
        ? resolveWorkspaceProfile(agent, workspace, workspaces).profile
        : profilesOf(useAgentProfilesStore.getState().config, agent).find(
            (p) => p.id === profileId,
          );
    if (!profile) throw new UiRequestError(`no ${agent} profile with id "${profileId}"`);
    const config = useAgentInstructionsStore.getState().config;
    const target = { agent, workspace: workspaceInstructionTarget(workspace, workspaces), profile };
    return {
      layers: persistentInstructionLayers(config, target),
      instructions: mergeAgentInstructions(config, target),
    };
  },
  "settings.instructions.set": async ({ scope, text }) => {
    if (
      scope.kind === "workspace" &&
      !useWorkspacesStore.getState().workspaces.some((workspace) => workspace.id === scope.id)
    )
      throw new UiRequestError("that workspace is gone");
    await saveInstructionEdits([{ scope, text }]);
    return {};
  },
  "settings.lspStatus": async ({ workspaceId }) => {
    const { enabled, maxActiveWorkspaces } = useLspSettingsStore.getState().settings;
    const { statuses } = useLspStatusStore.getState();
    return {
      enabled,
      maxActiveWorkspaces,
      servers: Object.values(statuses)
        .filter((server) => server.workspaceId === workspaceId)
        .map((server) => ({ language: server.languageId, state: server.state })),
    };
  },
  "settings.updateStatus": async () =>
    unwrapIpcResult(await ipcCallResult("updates", "getStatus", undefined)),
  "settings.updateCheck": async () => {
    checkForUpdates();
    await checked(UPDATE_CHECK_MS);
    const { status, progress } = useUpdatesStore.getState();
    return { status, progress };
  },
  "settings.logsPath": async () =>
    unwrapIpcResult(await ipcCallResult("system", "logsPath", undefined)),
  "settings.keys": async () => ({ bindings: keyBindings() }),
  "settings.keys.set": async ({ change }) => {
    const warnings = changeKeys(change);
    const bindings = keyBindings().filter(
      ({ command }) => change.command === undefined || command === change.command,
    );
    return { bindings, warnings };
  },
  "settings.list": async ({ key }) => ({
    settings: await Promise.all(
      (key === undefined ? CLI_SETTINGS : CLI_SETTINGS.filter(named(key))).map(settingInfo),
    ),
  }),
  "settings.set": async ({ key, value, approved, expected }) => {
    const setting = CLI_SETTINGS.find(named(key));
    if (!setting) {
      throw new UiRequestError(`no setting "${key}"; nexus settings list shows them`);
    }
    if (!setting.set) {
      throw new UiRequestError(`${setting.key} is the user's to change, in Settings`);
    }
    if (value === null) {
      if (!setting.reset) throw new UiRequestError(`${setting.key} has no default to go back to`);
      await setting.reset();
    } else {
      const parsed = setting.parse ? await setting.parse(value) : parseSettingValue(setting, value);
      if ("error" in parsed) throw new UiRequestError(`${setting.key}: ${parsed.error}`);
      if (parsed.value === true && settingAskingToTurnOn(setting.key) && approved !== true) {
        throw new UiRequestError(
          `${setting.key}: turning it on needs the user's approval, which nexus settings set asks for`,
        );
      }
      if (lspPathSetting(setting.key) && String(parsed.value).trim() !== "" && approved !== true) {
        throw new UiRequestError(
          `${setting.key}: a server path names a program to run and needs the user's approval, which nexus settings set asks for`,
        );
      }
      if (expected !== undefined && (await setting.get()).value !== expected) {
        throw new UiRequestError(
          `${setting.key} changed while waiting for the user's approval; run the command again`,
        );
      }
      await setting.set(parsed.value);
    }
    return { setting: await settingInfo(setting) };
  },
};

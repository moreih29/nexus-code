import { LSP_PATH_LANGUAGES, LSP_SERVER_PATH_MAX, type LspPathLanguage } from "../lsp/settings";
import type { CliSettingType, CliSettingValue } from "./ui";

export interface CliSettingShape {
  readonly type: CliSettingType;
  readonly choices?: readonly string[];
  readonly min?: number;
  readonly max?: number;
  readonly maxLength?: number;
  readonly pattern?: { readonly test: RegExp; readonly says: string };
}

const TRUE_WORDS = ["on", "true", "yes", "1"];
const FALSE_WORDS = ["off", "false", "no", "0"];

export function describeShape(shape: CliSettingShape): string {
  switch (shape.type) {
    case "boolean":
      return "on|off";
    case "choice":
      return (shape.choices ?? []).join("|");
    case "integer":
    case "number":
      return `${shape.min ?? ""}..${shape.max ?? ""}`;
    case "text":
      return "text";
  }
}

export function formatSettingValue(value: CliSettingValue): string {
  if (typeof value === "boolean") return value ? "on" : "off";
  return String(value);
}

export function parseSettingValue(
  shape: CliSettingShape,
  input: string,
): { value: CliSettingValue } | { error: string } {
  const text = input.trim();
  switch (shape.type) {
    case "boolean": {
      const word = text.toLowerCase();
      if (TRUE_WORDS.includes(word)) return { value: true };
      if (FALSE_WORDS.includes(word)) return { value: false };
      return { error: `"${input}" is not on or off` };
    }
    case "choice": {
      const choices = shape.choices ?? [];
      const found =
        choices.find((choice) => choice === text) ??
        choices.find((choice) => choice.toLowerCase() === text.toLowerCase());
      if (found !== undefined) return { value: found };
      return { error: `"${input}" is not one of ${choices.join(", ")}` };
    }
    case "integer":
    case "number": {
      const value = text === "" ? Number.NaN : Number(text);
      if (!Number.isFinite(value)) return { error: `"${input}" is not a number` };
      if (shape.type === "integer" && !Number.isInteger(value)) {
        return { error: `"${input}" is not a whole number` };
      }
      if (
        (shape.min !== undefined && value < shape.min) ||
        (shape.max !== undefined && value > shape.max)
      ) {
        return { error: `${value} is not within ${describeShape(shape)}` };
      }
      return { value };
    }
    case "text": {
      if (shape.maxLength !== undefined && input.length > shape.maxLength) {
        return { error: `it is longer than ${shape.maxLength} characters` };
      }
      if (shape.pattern && !shape.pattern.test.test(input)) return { error: shape.pattern.says };
      return { value: input };
    }
  }
}

export const SETTINGS_ASKING_TO_TURN_ON = {
  "notes.summary": "noteSummary",
  "notes.voiceSuggest": "voiceSuggest",
  "notes.voiceExpire": "voiceExpire",
} as const;
export type SettingAskingToTurnOn = keyof typeof SETTINGS_ASKING_TO_TURN_ON;

export function settingAskingToTurnOn(key: string): SettingAskingToTurnOn | undefined {
  const wanted = key.toLowerCase();
  return (Object.keys(SETTINGS_ASKING_TO_TURN_ON) as SettingAskingToTurnOn[]).find(
    (asking) => asking.toLowerCase() === wanted,
  );
}

export function turnsOn(input: string): boolean {
  const parsed = parseSettingValue({ type: "boolean" }, input);
  return "value" in parsed && parsed.value === true;
}

export const LSP_PATH_SHAPE = {
  type: "text",
  maxLength: LSP_SERVER_PATH_MAX,
  pattern: { test: /^[^\p{Cc}]*$/u, says: "a path is one line, without control characters" },
} as const satisfies CliSettingShape;

export function lspPathSetting(key: string): LspPathLanguage | undefined {
  const wanted = key.toLowerCase();
  return LSP_PATH_LANGUAGES.find((language) => `lsp.${language}.path` === wanted);
}

export const SETTINGS_PAGES = [
  "appearance",
  "editor",
  "language-servers",
  "terminal",
  "notifications",
  "notes",
  "browser-permissions",
  "keybindings",
  "agent",
  "cross-workspace",
  "claude",
  "codex",
  "instructions",
  "profile-rules",
  "remote",
  "about",
] as const;
export type SettingsPage = (typeof SETTINGS_PAGES)[number];

const KEY_PAGES: readonly (readonly [string, SettingsPage])[] = [
  ["appearance.", "appearance"],
  ["editor.", "editor"],
  ["terminal.taskagent", "agent"],
  ["terminal.", "terminal"],
  ["sessions.", "agent"],
  ["chat.", "agent"],
  ["notifications.", "notifications"],
  ["updates.", "about"],
  ["agentcli.", "agent"],
  ["voice.", "remote"],
  ["lsp.", "language-servers"],
  ["remote.", "remote"],
  ["notes.", "notes"],
];

const PAGE_NAMES: Readonly<Record<string, SettingsPage>> = {
  "agentcli.crossworkspace": "cross-workspace",
  lsp: "language-servers",
  browser: "browser-permissions",
  keys: "keybindings",
  shortcuts: "keybindings",
  updates: "about",
};

export function settingsPageNamed(word: string): SettingsPage | undefined {
  const name = word.trim().toLowerCase();
  const page = SETTINGS_PAGES.find((id) => id === name) ?? PAGE_NAMES[name];
  if (page) return page;
  return KEY_PAGES.find(([prefix]) => name.startsWith(prefix))?.[1];
}

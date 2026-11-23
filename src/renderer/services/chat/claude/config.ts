import type { ModelInfo } from "../model";

export type ConfigGroup = "conversation" | "work" | "other";

export type ConfigValue = boolean | string;

export interface ConfigKey {
  key: string;
  group: ConfigGroup;
  kind: "boolean" | "choice" | "text";
  options?: readonly string[];
  setting?: string;
  global?: string;
  fallback?: ConfigValue;
}

export interface ConfigShown {
  keys: ConfigKey[];
  values: Record<string, ConfigValue | undefined>;
  effective: Record<string, unknown>;
  model?: string;
  effort: boolean;
  models: readonly ModelInfo[];
  outputStyles?: readonly string[];
}

export const BUILT_IN_OUTPUT_STYLES = [
  "default",
  "Proactive",
  "Concise",
  "Explanatory",
  "Learning",
];

// biome-ignore format: a table, one key to a line
export const CONFIG_KEYS: readonly ConfigKey[] = [
  { key: "model", group: "conversation", kind: "choice", setting: "model", fallback: "default" },
  { key: "autoCompact", group: "conversation", kind: "boolean", setting: "autoCompactEnabled", global: "autoCompactEnabled", fallback: true },
  { key: "idleCompaction", group: "conversation", kind: "boolean", setting: "idleCompaction", fallback: true },
  { key: "thinking", group: "conversation", kind: "boolean", setting: "alwaysThinkingEnabled", fallback: true },
  { key: "outputStyle", group: "conversation", kind: "choice", options: BUILT_IN_OUTPUT_STYLES, setting: "outputStyle", fallback: "default" },
  { key: "language", group: "conversation", kind: "text", setting: "language", fallback: "" },
  { key: "checkpoints", group: "conversation", kind: "boolean", setting: "fileCheckpointingEnabled", global: "fileCheckpointingEnabled", fallback: true },
  { key: "switchModelsOnFlag", group: "conversation", kind: "boolean", setting: "switchModelsOnFlag" },
  { key: "permissionMode", group: "work", kind: "choice", options: ["default", "plan", "acceptEdits", "auto", "dontAsk"], setting: "permissions.defaultMode", fallback: "default" },
  { key: "useAutoModeDuringPlan", group: "work", kind: "boolean", setting: "useAutoModeDuringPlan", fallback: true },
  { key: "gitignore", group: "work", kind: "boolean", global: "respectGitignore", fallback: true },
  { key: "worktreeBaseRef", group: "work", kind: "choice", options: ["fresh", "head"], setting: "worktree.baseRef", fallback: "fresh" },
  { key: "workflows", group: "work", kind: "boolean", setting: "enableWorkflows" },
  { key: "workflowKeywordTriggerEnabled", group: "work", kind: "boolean", setting: "workflowKeywordTriggerEnabled", fallback: true },
  { key: "workflowSizeGuideline", group: "work", kind: "choice", options: ["unrestricted", "small", "medium", "large"], global: "workflowSizeGuideline" },
  { key: "remoteControl", group: "work", kind: "choice", options: ["default", "true", "false"], setting: "remoteControlAtStartup", global: "remoteControlAtStartup", fallback: "default" },
  { key: "agentPushNotifEnabled", group: "work", kind: "boolean", setting: "agentPushNotifEnabled", global: "agentPushNotifEnabled", fallback: false },
  { key: "inputNeededNotifEnabled", group: "work", kind: "boolean", setting: "inputNeededNotifEnabled", global: "inputNeededNotifEnabled", fallback: false },
  { key: "theme", group: "other", kind: "choice", options: ["auto", "dark", "light", "light-daltonized", "dark-daltonized", "light-ansi", "dark-ansi"], setting: "theme", global: "theme", fallback: "dark" },
  { key: "editor", group: "other", kind: "choice", options: ["normal", "vim"], setting: "editorMode", global: "editorMode", fallback: "normal" },
  { key: "timeFormat", group: "other", kind: "choice", options: ["auto", "12-hour", "24-hour", "24-hour-utc"], setting: "timeFormat", fallback: "auto" },
  { key: "notifChannel", group: "other", kind: "choice", options: ["auto", "iterm2", "terminal_bell", "iterm2_with_bell", "kitty", "ghostty", "notifications_disabled"], setting: "preferredNotifChannel", global: "preferredNotifChannel", fallback: "auto" },
  { key: "verbose", group: "other", kind: "boolean", setting: "verbose", global: "verbose", fallback: false },
  { key: "autoScroll", group: "other", kind: "boolean", setting: "autoScrollEnabled", global: "autoScrollEnabled", fallback: true },
  { key: "turnDuration", group: "other", kind: "boolean", setting: "showTurnDuration", global: "showTurnDuration", fallback: true },
  { key: "progressBar", group: "other", kind: "boolean", setting: "terminalProgressBarEnabled", global: "terminalProgressBarEnabled", fallback: true },
  { key: "tips", group: "other", kind: "boolean", setting: "spinnerTipsEnabled", fallback: true },
  { key: "reduceMotion", group: "other", kind: "boolean", setting: "prefersReducedMotion", fallback: false },
  { key: "recap", group: "other", kind: "boolean", setting: "awaySummaryEnabled", fallback: true },
  { key: "prStatus", group: "other", kind: "boolean", global: "prStatusFooterEnabled", fallback: true },
  { key: "copyFullResponse", group: "other", kind: "boolean", global: "copyFullResponse", fallback: false },
  { key: "copyOnSelect", group: "other", kind: "boolean", global: "copyOnSelect", fallback: true },
  { key: "externalEditorContext", group: "other", kind: "boolean", global: "externalEditorContext", fallback: false },
  { key: "autoConnectIde", group: "other", kind: "boolean", global: "autoConnectIde", fallback: false },
  { key: "defaultToAgentsView", group: "other", kind: "boolean", global: "defaultToAgentsView", fallback: false },
  { key: "leftArrowOpensAgents", group: "other", kind: "boolean", global: "leftArrowOpensAgents", fallback: true },
  { key: "promptSuggestionEnabled", group: "other", kind: "boolean", setting: "promptSuggestionEnabled", global: "promptSuggestionEnabled", fallback: true },
  { key: "teammateMode", group: "other", kind: "choice", options: ["auto", "tmux", "iterm2", "in-process"], setting: "teammateMode", global: "teammateMode", fallback: "auto" },
];

export function configUsageOf(stdout: string): string {
  try {
    const answer = JSON.parse(stdout) as { result?: unknown };
    if (typeof answer?.result === "string") return answer.result;
  } catch {}
  return stdout;
}

export interface ListedKey {
  key: string;
  kind: ConfigKey["kind"];
  options?: string[];
}

export function parseConfigUsage(text: string): ListedKey[] {
  const keys: ListedKey[] = [];
  for (const line of text.split("\n")) {
    const match = /^\s+([A-Za-z][\w-]*)=(\S.*)$/.exec(line);
    if (!match) continue;
    const [, key, takes] = match;
    const options = takes.split("|").map((o) => o.trim());
    if (options.length === 2 && options.includes("true") && options.includes("false")) {
      keys.push({ key, kind: "boolean" });
    } else if (options.length === 1 && /^<.*>$/.test(options[0])) {
      keys.push({ key, kind: "text" });
    } else {
      keys.push({ key, kind: "choice", options });
    }
  }
  return keys;
}

export function configKeysOf(listed: readonly ListedKey[] | null): ConfigKey[] {
  if (!listed || listed.length === 0) return [...CONFIG_KEYS];
  const byKey = new Map(listed.map((k) => [k.key, k]));
  const known = CONFIG_KEYS.flatMap((key) => {
    const from = byKey.get(key.key);
    if (!from) return [];
    if (from.kind !== key.kind) return [{ ...key, kind: from.kind, options: from.options }];
    return [key.kind === "choice" && from.options ? { ...key, options: from.options } : key];
  });
  const knownNames = new Set(CONFIG_KEYS.map((k) => k.key));
  const unknown = listed
    .filter((k) => !knownNames.has(k.key))
    .map((k): ConfigKey => ({ key: k.key, group: "other", kind: k.kind, options: k.options }));
  return [...known, ...unknown];
}

export const LISTED_KEYS_STORAGE = "nexus.chat.configKeys";

type SavedLists = Record<string, { version: string; keys: ListedKey[] }>;

function savedLists(raw: string | null): SavedLists {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as SavedLists)
      : {};
  } catch {
    return {};
  }
}

function isListedKey(value: unknown): value is ListedKey {
  if (typeof value !== "object" || value === null) return false;
  const { key, kind, options } = value as Partial<ListedKey>;
  return (
    typeof key === "string" &&
    (kind === "boolean" || kind === "choice" || kind === "text") &&
    (options === undefined ||
      (Array.isArray(options) && options.every((o) => typeof o === "string")))
  );
}

export function savedListedKeys(
  raw: string | null,
  place: string,
  version: string,
): ListedKey[] | null {
  if (!version) return null;
  const saved = savedLists(raw)[place];
  if (!saved || saved.version !== version || !Array.isArray(saved.keys)) return null;
  if (saved.keys.length === 0 || !saved.keys.every(isListedKey)) return null;
  return saved.keys;
}

export function withListedKeys(
  raw: string | null,
  place: string,
  version: string,
  keys: readonly ListedKey[],
): string {
  return JSON.stringify({ ...savedLists(raw), [place]: { version, keys } });
}

const CONFIG_COMMAND_FOCUS: Readonly<Record<string, string>> = {
  "output-style": "outputStyle",
  autocompact: "autoCompact",
};

export function configCommandOf(text: string): { focus?: string } | null {
  const match = /^\/(\S+)$/.exec(text.trim());
  if (!match) return null;
  const name = match[1].toLowerCase();
  if (name === "config" || name === "settings") return {};
  const focus = CONFIG_COMMAND_FOCUS[name];
  return focus ? { focus } : null;
}

function at(record: Readonly<Record<string, unknown>>, path: string): unknown {
  let value: unknown = record;
  for (const part of path.split(".")) {
    if (typeof value !== "object" || value === null) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

function typedValue(key: ConfigKey, raw: unknown): ConfigValue | undefined {
  if (key.kind === "boolean") return typeof raw === "boolean" ? raw : undefined;
  if (key.kind === "choice" && typeof raw === "boolean") return String(raw);
  if (typeof raw !== "string") return undefined;
  if (key.key === "editor" && raw === "emacs") return "normal";
  return raw;
}

export function configValues(
  effective: Readonly<Record<string, unknown>>,
  global: Readonly<Record<string, unknown>>,
  keys: readonly ConfigKey[] = CONFIG_KEYS,
): Record<string, ConfigValue | undefined> {
  const values: Record<string, ConfigValue | undefined> = {};
  for (const key of keys) {
    let value = key.setting ? typedValue(key, at(effective, key.setting)) : undefined;
    if (key.key === "workflows" && effective.disableWorkflows === true) value = false;
    if (value === undefined && key.global) value = typedValue(key, global[key.global]);
    values[key.key] = value ?? key.fallback;
  }
  return values;
}

export function choicesOf(
  key: ConfigKey,
  current: ConfigValue | undefined,
  outputStyles?: readonly string[],
): string[] {
  const options = [
    ...((key.key === "outputStyle" && outputStyles?.length ? outputStyles : key.options) ?? []),
  ];
  if (typeof current === "string" && current && !options.includes(current)) options.push(current);
  return options;
}

function argOf(key: string, value: ConfigValue): string {
  if (typeof value === "boolean") return String(value);
  const text = value.replace(/\s+/g, " ").trim();
  return key === "language" && !text ? "default" : text;
}

export function configMessages(
  changes: Readonly<Record<string, ConfigValue>>,
  keys: readonly ConfigKey[] = CONFIG_KEYS,
): string[] {
  const words: string[] = [];
  const alone: string[] = [];
  for (const key of keys) {
    if (!(key.key in changes)) continue;
    const arg = argOf(key.key, changes[key.key]);
    (arg.includes(" ") ? alone : words).push(`${key.key}=${arg}`);
  }
  return [
    ...(words.length > 0 ? [`/config ${words.join(" ")}`] : []),
    ...alone.map((pair) => `/config ${pair}`),
  ];
}

export function changesOf(
  draft: Readonly<Record<string, ConfigValue>>,
  current: Readonly<Record<string, ConfigValue | undefined>>,
): Record<string, ConfigValue> {
  const changes: Record<string, ConfigValue> = {};
  for (const [key, value] of Object.entries(draft)) {
    const now = current[key];
    const same =
      typeof value === "string" && typeof now === "string"
        ? argOf(key, value) === argOf(key, now)
        : value === now;
    if (!same) changes[key] = value;
  }
  return changes;
}

export function defaultEffortLevels(levels: readonly string[] | undefined): string[] {
  return (levels ?? []).filter((level) => level !== "max");
}

export function defaultEffortOf(
  effective: Readonly<Record<string, unknown>>,
  modelId: string | undefined,
): string | undefined {
  const perModel = at(effective, "modelSettings");
  if (modelId && typeof perModel === "object" && perModel !== null) {
    const settings = perModel as Record<string, { effortLevel?: unknown } | undefined>;
    const own = (settings[modelId] ?? settings[modelId.replace(/\[1m\]$/i, "")])?.effortLevel;
    if (typeof own === "string" && own) return own;
  }
  const level = effective.effortLevel;
  return typeof level === "string" && level ? level : undefined;
}

interface ModelChoice {
  value: string;
  displayName?: string;
  resolvedModel?: string;
  supportedEffortLevels?: string[];
}

export function modelChoiceOf(
  choice: string,
  models: readonly ModelChoice[],
): { info?: ModelChoice; long: boolean } {
  const long = /\[1m\]$/i.test(choice);
  const base = choice.replace(/\[1m\]$/i, "");
  return { info: models.find((m) => m.value === base), long };
}

export function effortModelOf(
  changedModel: string | undefined,
  running: string | undefined,
  models: readonly ModelChoice[],
): { id: string; info?: ModelChoice } | undefined {
  if (changedModel !== undefined) {
    const { info } = modelChoiceOf(changedModel, models);
    return info ? { id: info.resolvedModel ?? info.value, info } : undefined;
  }
  if (!running) return undefined;
  return {
    id: running,
    info: models.find((m) => m.resolvedModel === running || m.value === running),
  };
}

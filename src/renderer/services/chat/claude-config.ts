// The settings Claude Code's /config changes, as the Claude tab's settings
// dialog shows them: where each one's value is read, what it can be, and
// the /config messages that set what was changed. Claude Code's headless
// mode has no /config panel, but runs `/config key=value` sent as a
// message, which saves the setting where its panel would. Pure, for the
// dialog and its tests.

export type ConfigGroup = "conversation" | "work" | "other";

export type ConfigValue = boolean | string;

export interface ConfigKey {
  /** The key /config takes. */
  key: string;
  group: ConfigGroup;
  kind: "boolean" | "choice" | "text";
  /** A choice's values, as /config takes them. */
  options?: readonly string[];
  /** Where get_settings' effective settings have it: a dotted path. */
  setting?: string;
  /**
   * Its key in Claude Code's global config file (~/.claude.json), which
   * has it when settings.json does not.
   */
  global?: string;
  /** What it is when it is set nowhere; left out when that is not known. */
  fallback?: ConfigValue;
}

/**
 * The output styles Claude Code comes with; a Claude Code's initialize
 * names those it has, the user's own among them.
 */
export const BUILT_IN_OUTPUT_STYLES = [
  "default",
  "Proactive",
  "Concise",
  "Explanatory",
  "Learning",
];

/**
 * /config's keys, as Claude Code 2.1.319 lists them, but `model`: the
 * composer's model chip sets it. Their fallbacks are its own.
 */
// biome-ignore format: a table, one key to a line
export const CONFIG_KEYS: readonly ConfigKey[] = [
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
];

/** The keys that /output-style and /autocompact, typed bare, show the dialog at. */
const CONFIG_COMMAND_FOCUS: Readonly<Record<string, string>> = {
  "output-style": "outputStyle",
  autocompact: "autoCompact",
};

/**
 * What a bare /config or /settings opens the dialog at (nothing in
 * particular), or a bare /output-style or /autocompact (its setting);
 * null for another message, as one with arguments, which the CLI runs.
 */
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
  if (typeof raw !== "string") return undefined;
  // /config shows the emacs mode it no longer has as normal.
  if (key.key === "editor" && raw === "emacs") return "normal";
  return raw;
}

/**
 * Each key's value now: what settings.json has (get_settings' effective
 * settings), else what the global config file has, else its fallback;
 * undefined when none says.
 */
export function configValues(
  effective: Readonly<Record<string, unknown>>,
  global: Readonly<Record<string, unknown>>,
): Record<string, ConfigValue | undefined> {
  const values: Record<string, ConfigValue | undefined> = {};
  for (const key of CONFIG_KEYS) {
    let value = key.setting ? typedValue(key, at(effective, key.setting)) : undefined;
    // Turned off by disableWorkflows, whatever enableWorkflows says.
    if (key.key === "workflows" && effective.disableWorkflows === true) value = false;
    if (value === undefined && key.global) value = typedValue(key, global[key.global]);
    values[key.key] = value ?? key.fallback;
  }
  return values;
}

/** A choice's values: its own, and the one it has when that is another (a custom theme). */
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

/** A value as /config takes it: the language left empty goes back to its default. */
function argOf(key: string, value: ConfigValue): string {
  if (typeof value === "boolean") return String(value);
  const text = value.replace(/\s+/g, " ").trim();
  return key === "language" && !text ? "default" : text;
}

/**
 * The /config messages that set the changes: one with every value that is
 * one word, and one for each value with a space, which /config takes only
 * as the message's one setting.
 */
export function configMessages(changes: Readonly<Record<string, ConfigValue>>): string[] {
  const words: string[] = [];
  const alone: string[] = [];
  for (const key of CONFIG_KEYS) {
    if (!(key.key in changes)) continue;
    const arg = argOf(key.key, changes[key.key]);
    (arg.includes(" ") ? alone : words).push(`${key.key}=${arg}`);
  }
  return [
    ...(words.length > 0 ? [`/config ${words.join(" ")}`] : []),
    ...alone.map((pair) => `/config ${pair}`),
  ];
}

/** The changes a draft makes: the keys whose values differ from what they are now. */
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

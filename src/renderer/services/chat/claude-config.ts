// The settings Claude Code's /config changes, as the Claude tab's settings
// dialog shows them: where each one's value is read, what it can be, and
// the /config messages that set what was changed. Claude Code's headless
// mode has no /config panel, but runs `/config key=value` sent as a
// message, which saves the setting where its panel would. The keys are
// those the CLI itself lists (a bare /config prints them), so that one
// that comes in a new Claude Code shows without the app knowing it; the
// table here only names where each is read and how it is grouped. Pure,
// for the dialog and its tests.

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
 * The /config keys the app knows, in the dialog's order: where each is
 * read and what it is when set nowhere (Claude Code's own fallbacks). The
 * model set here is the default a new conversation starts with; the
 * composer's chip sets only its tab's.
 */
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

/** The text of a `claude -p --output-format json` run's answer: its result, else what it printed. */
export function configUsageOf(stdout: string): string {
  try {
    const answer = JSON.parse(stdout) as { result?: unknown };
    if (typeof answer?.result === "string") return answer.result;
  } catch {
    // Not the JSON answer.
  }
  return stdout;
}

/** A key as a bare /config lists it ("  theme=auto|dark|light"). */
export interface ListedKey {
  key: string;
  kind: ConfigKey["kind"];
  options?: string[];
}

/**
 * The keys in a bare /config's answer: each line's `key=` and what it
 * takes, `true|false` an on/off setting, `<value>` any text, else the
 * choices named.
 */
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

/**
 * The keys the dialog shows: those the CLI lists, as the table has them
 * where it knows them (with what the CLI takes), and the others at the end
 * of the last group, read from nowhere; the table when the CLI's list is
 * not known. A key the CLI no longer lists is left out.
 */
export function configKeysOf(listed: readonly ListedKey[] | null): ConfigKey[] {
  if (!listed || listed.length === 0) return [...CONFIG_KEYS];
  const byKey = new Map(listed.map((k) => [k.key, k]));
  const known = CONFIG_KEYS.flatMap((key) => {
    const from = byKey.get(key.key);
    if (!from) return [];
    // What the CLI takes now, where it differs from what the table knew.
    if (from.kind !== key.kind) return [{ ...key, kind: from.kind, options: from.options }];
    return [key.kind === "choice" && from.options ? { ...key, options: from.options } : key];
  });
  const knownNames = new Set(CONFIG_KEYS.map((k) => k.key));
  const unknown = listed
    .filter((k) => !knownNames.has(k.key))
    .map((k): ConfigKey => ({ key: k.key, group: "other", kind: k.kind, options: k.options }));
  return [...known, ...unknown];
}

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
  // A choice of on, off or the default (remoteControl) is kept as true or false.
  if (key.kind === "choice" && typeof raw === "boolean") return String(raw);
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
  keys: readonly ConfigKey[] = CONFIG_KEYS,
): Record<string, ConfigValue | undefined> {
  const values: Record<string, ConfigValue | undefined> = {};
  for (const key of keys) {
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

/**
 * The effort levels a default can be: the model's, but max, which Claude
 * Code keeps for the session and does not save.
 */
export function defaultEffortLevels(levels: readonly string[] | undefined): string[] {
  return (levels ?? []).filter((level) => level !== "max");
}

/**
 * The default effort the settings give a model ("claude-opus-5-5"): its
 * own, under modelSettings, where Claude Code saves it (and which a
 * headless run takes), else effortLevel, which a headless run leaves out.
 */
export function defaultEffortOf(
  effective: Readonly<Record<string, unknown>>,
  modelId: string | undefined,
): string | undefined {
  const perModel = at(effective, "modelSettings");
  if (modelId && typeof perModel === "object" && perModel !== null) {
    const settings = perModel as Record<string, { effortLevel?: unknown } | undefined>;
    // The 1M window's model keeps the model's settings.
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

/** A model /config takes ("opus[1m]") as initialize's list has it, the 1M window aside. */
export function modelChoiceOf(
  choice: string,
  models: readonly ModelChoice[],
): { info?: ModelChoice; long: boolean } {
  const long = /\[1m\]$/i.test(choice);
  const base = choice.replace(/\[1m\]$/i, "");
  return { info: models.find((m) => m.value === base), long };
}

/**
 * The model whose default effort the dialog shows and saves: the new
 * default model when the draft changes it (the session switches to it
 * first), else the one the session runs ("claude-opus-5-5").
 */
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

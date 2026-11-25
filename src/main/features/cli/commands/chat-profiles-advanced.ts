import { readFile } from "node:fs/promises";
import {
  BEHAVIOR_FIELDS,
  BEHAVIOR_FILE,
  type BehaviorChanges,
  type BehaviorField,
  type BehaviorFile,
  type BehaviorValue,
} from "../../../../shared/agent-profiles/behavior";
import type {
  CustomConnection,
  ProfileConnection,
} from "../../../../shared/agent-profiles/connection";
import { isReservedProfileEnvName } from "../../../../shared/agent-profiles/env";
import {
  type AgentProfile,
  isDefaultProfileId,
  SHAREABLE,
  SHARED_BY_DEFAULT,
} from "../../../../shared/agent-profiles/profiles";
import type { AdvancedSetting, ProfileEditLine } from "../../../../shared/cli/consent-copy";
import type { ChatAgent } from "../../../../shared/sessions/task-agent";
import { readBehavior } from "../../agent-profiles/behavior";
import { inspectLocalFolder, localProfileDir } from "../../agent-profiles/local";
import { CliUsageError, type FlagSpec, type FlagValues } from "../args";
import { type CliContext, CliError } from "../context";
import { callerPath } from "../paths";
import { listFlag } from "./chat-profiles";

const MAX_LIMIT = 2_147_483_647;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const ADVANCED_FLAGS = {
  share: {
    type: "string",
    value: "NAME",
    description: "Share a file or folder with the default folder (repeatable)",
    repeat: true,
  },
  unshare: {
    type: "string",
    value: "NAME",
    description: "Stop sharing a file or folder (repeatable)",
    repeat: true,
  },
  "env-file": {
    type: "string",
    value: "FILE",
    description: "Set environment variables from KEY=VALUE lines in FILE or - for stdin",
  },
  "unset-env": {
    type: "string",
    value: "NAME",
    description: "Remove an environment variable (repeatable)",
    repeat: true,
  },
  "header-file": {
    type: "string",
    value: "FILE",
    description: "Custom connection: set extra headers from Name: value lines in FILE or -",
  },
  "unset-header": {
    type: "string",
    value: "NAME",
    description: "Remove an extra header (repeatable)",
    repeat: true,
  },
  "query-file": {
    type: "string",
    value: "FILE",
    description: "Codex custom connection: set query parameters from name=value lines in FILE or -",
  },
  "unset-query": {
    type: "string",
    value: "NAME",
    description: "Remove a query parameter (repeatable)",
    repeat: true,
  },
  timeout: {
    type: "string",
    value: "MS",
    description: "Claude custom connection: request timeout in ms, or auto",
  },
  "max-output-tokens": {
    type: "string",
    value: "N",
    description: "Claude custom connection: max output tokens, or auto",
  },
  "experimental-headers": {
    type: "string",
    value: "on|off",
    description: "Claude custom connection: off disables experimental headers",
  },
  retries: {
    type: "string",
    value: "N",
    description: "Codex custom connection: retry count from 0 to 100, or auto",
  },
  "stream-idle-timeout": {
    type: "string",
    value: "MS",
    description: "Codex custom connection: stream idle timeout in ms, or auto",
  },
  behavior: {
    type: "string",
    value: "ID=VALUE",
    description: "A behavior setting of settings.json or config.toml; default clears (repeatable)",
    repeat: true,
  },
} as const satisfies Record<string, FlagSpec>;

const FILE_FLAGS = ["key-file", "env-file", "header-file", "query-file"] as const;

const CONNECTION_ONLY = [
  "header-file",
  "unset-header",
  "query-file",
  "unset-query",
  "timeout",
  "max-output-tokens",
  "experimental-headers",
  "retries",
  "stream-idle-timeout",
] as const;

const AGENT_ONLY: Record<ChatAgent, readonly string[]> = {
  claude: ["query-file", "unset-query", "retries", "stream-idle-timeout"],
  codex: ["timeout", "max-output-tokens", "experimental-headers"],
};

const WIDTH: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  permissionMode: { plan: 0, dontAsk: 0, default: 1, acceptEdits: 2, auto: 3 },
  sandbox: { true: 0, false: 1 },
  approvalPolicy: { untrusted: 0, "on-request": 1, never: 2 },
  sandboxMode: { "read-only": 0, "workspace-write": 1, "danger-full-access": 2 },
  sandboxNetwork: { false: 0, true: 1 },
};

export function advancedGiven(flags: FlagValues): boolean {
  return Object.keys(ADVANCED_FLAGS).some((flag) => flags[flag] !== undefined);
}

export function checkStdin(flags: FlagValues): void {
  const fromStdin = FILE_FLAGS.filter((flag) => flags[flag] === "-");
  if (fromStdin.length > 1) {
    throw new CliUsageError(
      `Only one of --${fromStdin.join(", --")} can read stdin; give the others a FILE`,
    );
  }
}

async function readText(ctx: CliContext, flag: string, file: string): Promise<string> {
  try {
    const text =
      file === "-"
        ? (ctx.invocation.stdin ?? "")
        : new TextDecoder("utf-8", { fatal: true }).decode(await readFile(callerPath(ctx, file)));
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  } catch {
    throw new CliError(`Could not read the --${flag} input as UTF-8 text`);
  }
}

function lines(text: string): { at: number; line: string }[] {
  return text
    .split("\n")
    .map((line, i) => ({ at: i + 1, line: line.trim() }))
    .filter(({ line }) => line !== "" && !line.startsWith("#"));
}

function parseEnv(text: string): Map<string, string> {
  const env = new Map<string, string>();
  for (const { at, line } of lines(text)) {
    const eq = line.indexOf("=");
    const name = eq > 0 ? line.slice(0, eq).trim() : "";
    const value = line.slice(eq + 1);
    if (!ENV_NAME.test(name) || name.length > 128 || value.length > 4096) {
      throw new CliUsageError(
        `--env-file line ${at} is not KEY=VALUE (KEY is letters, digits and _, VALUE up to 4096 characters)`,
      );
    }
    if (isReservedProfileEnvName(name)) {
      throw new CliUsageError(`--env-file: ${name} starts with NEXUS_, which NexusCode uses`);
    }
    if (env.has(name)) throw new CliUsageError(`--env-file sets ${name} twice`);
    env.set(name, value);
  }
  return env;
}

function parsePairs(flag: string, text: string, separator: ":" | "="): Map<string, string> {
  const pairs = new Map<string, string>();
  const shape = separator === ":" ? "Name: value" : "name=value";
  for (const { at, line } of lines(text)) {
    const cut = line.indexOf(separator);
    const name = line.slice(0, cut).trim();
    const value = line.slice(cut + 1).trim();
    let valid = cut >= 1 && name !== "" && name.length <= 128 && value.length <= 4096;
    if (valid && separator === ":") {
      try {
        new Headers([[name, value]]);
      } catch {
        valid = false;
      }
    }
    if (!valid) throw new CliUsageError(`--${flag} line ${at} is not ${shape}`);
    if (pairs.has(name)) throw new CliUsageError(`--${flag} sets ${name} twice`);
    pairs.set(name, value);
  }
  return pairs;
}

function names(flag: string, values: readonly string[]): string[] {
  const out = values.map((value) => value.trim());
  for (const name of out) {
    if (!name || name.length > 128 || /[\s=:]|\p{Cc}/u.test(name)) {
      throw new CliUsageError(`--${flag} takes a name only; values go in a file`);
    }
  }
  return out;
}

function mergePairs(
  field: "env" | "header" | "query",
  current: Readonly<Record<string, string>> | undefined,
  set: ReadonlyMap<string, string> | undefined,
  unset: readonly string[],
  flag: string,
): { next: Record<string, string> | undefined; lines: ProfileEditLine[] } {
  const next: Record<string, string> = { ...(current ?? {}) };
  const out: ProfileEditLine[] = [];
  for (const name of unset) {
    if (set?.has(name)) throw new CliUsageError(`--${flag} ${name} is also in the file`);
    if (!Object.hasOwn(next, name)) throw new CliUsageError(`--${flag}: ${name} is not set`);
    delete next[name];
    out.push({ field, name, change: "removed" });
  }
  for (const [name, value] of set ?? []) {
    const had = Object.hasOwn(next, name);
    if (had && next[name] === value) continue;
    next[name] = value;
    out.push({ field, name, change: had ? "changed" : "added" });
  }
  return { next: Object.keys(next).length ? next : undefined, lines: out };
}

function limitFlag(flag: string, value: string, min: number, max: number): number | undefined {
  const text = value.trim();
  if (text === "auto") return undefined;
  const count = /^(0|[1-9][0-9]*)$/.test(text) ? Number(text) : Number.NaN;
  if (!(count >= min && count <= max)) {
    throw new CliUsageError(`--${flag} takes a whole number from ${min} to ${max}, or auto`);
  }
  return count;
}

type Advanced = NonNullable<CustomConnection["advanced"]>;

const NUMBER_FLAGS: readonly {
  flag: string;
  key: "timeoutMs" | "maxOutputTokens" | "retries" | "streamIdleTimeoutMs";
  setting: AdvancedSetting;
  min: number;
  max: number;
}[] = [
  { flag: "timeout", key: "timeoutMs", setting: "timeout", min: 1, max: MAX_LIMIT },
  {
    flag: "max-output-tokens",
    key: "maxOutputTokens",
    setting: "outputTokens",
    min: 1,
    max: MAX_LIMIT,
  },
  { flag: "retries", key: "retries", setting: "retries", min: 0, max: 100 },
  {
    flag: "stream-idle-timeout",
    key: "streamIdleTimeoutMs",
    setting: "streamTimeout",
    min: 1,
    max: MAX_LIMIT,
  },
];

function withoutEmpty(advanced: Advanced): Advanced | undefined {
  const kept = Object.fromEntries(
    Object.entries(advanced).filter(([, value]) => value !== undefined),
  ) as Advanced;
  return Object.keys(kept).length ? kept : undefined;
}

async function editedAdvanced(
  ctx: CliContext,
  connection: CustomConnection,
  flags: FlagValues,
): Promise<{ connection: CustomConnection; lines: ProfileEditLine[] }> {
  const current = connection.advanced ?? {};
  const next: Advanced = { ...current };
  const out: ProfileEditLine[] = [];
  for (const { flag, key, setting, min, max } of NUMBER_FLAGS) {
    const value = flags[flag];
    if (typeof value !== "string") continue;
    const parsed = limitFlag(flag, value, min, max);
    if (parsed === current[key]) continue;
    if (parsed === undefined) delete next[key];
    else next[key] = parsed;
    out.push({
      field: "advanced",
      setting,
      value: `${current[key] ?? "auto"} → ${parsed ?? "auto"}`,
    });
  }
  const headersFlag = flags["experimental-headers"];
  if (typeof headersFlag === "string") {
    if (headersFlag !== "on" && headersFlag !== "off") {
      throw new CliUsageError("--experimental-headers takes on or off");
    }
    const disable = headersFlag === "off";
    const disabled = current.disableExperimentalBetas ?? false;
    if (disable !== disabled) {
      next.disableExperimentalBetas = disable;
      out.push({
        field: "advanced",
        setting: "experimentalHeaders",
        from: !disabled,
        to: !disable,
      });
    }
  }
  const headerFile = flags["header-file"];
  const headers = mergePairs(
    "header",
    current.headers,
    typeof headerFile === "string"
      ? parsePairs("header-file", await readText(ctx, "header-file", headerFile), ":")
      : undefined,
    names("unset-header", listFlag(flags["unset-header"])),
    "unset-header",
  );
  const queryFile = flags["query-file"];
  const query = mergePairs(
    "query",
    current.query,
    typeof queryFile === "string"
      ? parsePairs("query-file", await readText(ctx, "query-file", queryFile), "=")
      : undefined,
    names("unset-query", listFlag(flags["unset-query"])),
    "unset-query",
  );
  next.headers = headers.next;
  next.query = query.next;
  const advanced = withoutEmpty(next);
  const edited: CustomConnection = { ...connection };
  if (advanced) edited.advanced = advanced;
  else delete edited.advanced;
  return { connection: edited, lines: [...out, ...headers.lines, ...query.lines] };
}

async function sharedLines(
  profile: AgentProfile,
  flags: FlagValues,
): Promise<{ shared?: string[]; copy?: boolean; lines: ProfileEditLine[] }> {
  const share = listFlag(flags.share).map((name) => name.trim());
  const unshare = listFlag(flags.unshare).map((name) => name.trim());
  if (!share.length && !unshare.length) return { lines: [] };
  const { agent } = profile;
  if (isDefaultProfileId(profile.id)) {
    throw new CliUsageError("The default profile uses the default folder; it shares nothing");
  }
  const allowed = SHAREABLE[agent];
  for (const name of [...share, ...unshare]) {
    if (!allowed.includes(name)) {
      throw new CliUsageError(`--share and --unshare take ${allowed.join(", ")} for ${agent}`);
    }
  }
  const both = share.find((name) => unshare.includes(name));
  if (both) throw new CliUsageError(`${both} is in both --share and --unshare`);
  const current = profile.shared ?? [...SHARED_BY_DEFAULT[agent]];
  const wanted = new Set([...current.filter((name) => !unshare.includes(name)), ...share]);
  const shared = allowed.filter((name) => wanted.has(name));
  const before = allowed.filter((name) => current.includes(name));
  if (shared.join("\n") === before.join("\n")) return { lines: [] };
  const list = (names: readonly string[]) => (names.length ? names.join(", ") : "-");
  const lines: ProfileEditLine[] = [
    { field: "shared", value: `${list(before)} → ${list(shared)}` },
  ];
  const stopped = before.filter((name) => !shared.includes(name));
  const linked: readonly string[] = stopped.length
    ? (await inspectLocalFolder(agent, localProfileDir(profile))).linked
    : [];
  const copy = stopped.includes(BEHAVIOR_FILE[agent]) && linked.includes(BEHAVIOR_FILE[agent]);
  if (copy) lines.push({ field: "sharedCopy", file: BEHAVIOR_FILE[agent] });
  const unlinked = stopped.filter((name) => name !== BEHAVIOR_FILE[agent] && linked.includes(name));
  if (unlinked.length) lines.push({ field: "sharedUnlinked", files: unlinked.join(", ") });
  return { shared, ...(copy ? { copy } : {}), lines };
}

function behaviorValue(
  field: BehaviorField,
  raw: string,
  file: BehaviorFile,
): BehaviorValue | null {
  const value = raw.trim();
  if (value === "default" || (value === "" && field.kind === "text")) return null;
  const current = file.values[field.id];
  switch (field.kind) {
    case "bool":
      if (["on", "true"].includes(value)) return true;
      if (["off", "false"].includes(value)) return false;
      throw new CliUsageError(`--behavior ${field.id} takes on, off or default`);
    case "int": {
      const count = /^(0|[1-9][0-9]*)$/.test(value) ? Number(value) : Number.NaN;
      if (!Number.isSafeInteger(count)) {
        throw new CliUsageError(`--behavior ${field.id} takes a whole number or default`);
      }
      return count;
    }
    case "text":
      if (value.length > 4096 || /\p{Cc}/u.test(value)) {
        throw new CliUsageError(`--behavior ${field.id} takes text without control characters`);
      }
      return value;
    default: {
      const options: string[] =
        field.id === "approvalPolicy"
          ? ["on-request", "never"]
          : [...(field.options ?? []), ...(field.id === "outputStyle" ? file.outputStyles : [])];
      if (typeof current === "string") options.push(current);
      const choices = [...new Set(options)].filter((option) => option !== field.fallback);
      if (value === field.fallback) return null;
      if (!choices.includes(value)) {
        throw new CliUsageError(
          `--behavior ${field.id} takes ${[...choices, "default"].join(", ")}`,
        );
      }
      return value;
    }
  }
}

function rank(field: BehaviorField, value: BehaviorValue | null): number {
  const ranks = WIDTH[field.id] ?? {};
  const effective = value ?? field.fallback;
  if (effective === undefined) return 0;
  return ranks[String(effective)] ?? 0;
}

function onPlatform(id: string, windows: boolean): boolean {
  return !(windows && id === "sandbox");
}

function locked(
  agent: ChatAgent,
  id: string,
  connection: ProfileConnection | undefined,
  windows: boolean,
): string | undefined {
  const custom = connection?.method === "custom";
  if (custom && (id === "model" || id === "codexModel")) {
    return "the custom connection's default model sets it; change it with --default-model";
  }
  if (custom && agent === "codex" && (id === "webSearch" || id === "verbosity")) {
    return "a custom connection does not use it";
  }
  if (!onPlatform(id, windows)) return "it is not available on Windows";
  return undefined;
}

export interface BehaviorEdit {
  version: string;
  changes: BehaviorChanges;
}

async function behaviorLines(
  profile: AgentProfile,
  connection: ProfileConnection | undefined,
  flags: FlagValues,
  windows: boolean,
  read: (profile: AgentProfile) => Promise<BehaviorFile>,
): Promise<{ edit?: BehaviorEdit; lines: ProfileEditLine[] }> {
  const given = listFlag(flags.behavior);
  if (!given.length) return { lines: [] };
  const { agent } = profile;
  const fields = BEHAVIOR_FIELDS.filter((field) => field.agent === agent);
  const parsed = given.map((pair) => {
    const eq = pair.indexOf("=");
    const id = eq > 0 ? pair.slice(0, eq).trim() : "";
    const field = fields.find((f) => f.id === id);
    if (!field) {
      const ids = fields.map((f) => f.id).filter((fieldId) => onPlatform(fieldId, windows));
      throw new CliUsageError(`--behavior takes ID=VALUE with ID one of ${ids.join(", ")}`);
    }
    const reason = locked(agent, id, connection, windows);
    if (reason) throw new CliUsageError(`--behavior ${id}: ${reason}`);
    return { field, raw: pair.slice(eq + 1) };
  });
  const ids = parsed.map(({ field }) => field.id);
  if (new Set(ids).size !== ids.length) throw new CliUsageError("--behavior IDs must be unique");
  const file = await read(profile);
  if (file.broken) {
    throw new CliError(
      `${file.name} of the profile cannot be read (${file.broken}); fix or open it from Settings`,
    );
  }
  const changes: BehaviorChanges = {};
  const out: ProfileEditLine[] = [];
  for (const { field, raw } of parsed) {
    if (file.unsupported.includes(field.id)) {
      throw new CliUsageError(
        `--behavior ${field.id}: ${file.name} holds a value of another kind there; edit the file`,
      );
    }
    const value = behaviorValue(field, raw, file);
    const to = value === field.fallback ? null : value;
    const from = file.values[field.id] ?? null;
    const shownFrom = from === field.fallback ? null : from;
    if (shownFrom === to) continue;
    changes[field.id] = to;
    const wider = rank(field, to) > rank(field, shownFrom);
    out.push({ field: "behavior", id: field.id, from: shownFrom, to, ...(wider ? { wider } : {}) });
  }
  if (!out.length) return { lines: [] };
  if (file.shared) out.push({ field: "behaviorShared", file: file.name });
  return { edit: { version: file.version, changes }, lines: out };
}

export interface AdvancedEdit {
  profile: AgentProfile;
  lines: ProfileEditLine[];
  behavior?: BehaviorEdit;
  copyBehaviorFile?: boolean;
}

export async function advancedEdit(
  ctx: CliContext,
  profile: AgentProfile,
  edited: AgentProfile,
  flags: FlagValues,
  {
    windows = process.platform === "win32",
    read = (p: AgentProfile) => readBehavior(p, { prepare: true }),
  }: { windows?: boolean; read?: (profile: AgentProfile) => Promise<BehaviorFile> } = {},
): Promise<AdvancedEdit> {
  if (!advancedGiven(flags)) return { profile: edited, lines: [] };
  const { agent } = profile;
  const wrongAgent = AGENT_ONLY[agent].find((flag) => flags[flag] !== undefined);
  if (wrongAgent) {
    throw new CliUsageError(
      `--${wrongAgent} is for ${agent === "claude" ? "Codex" : "Claude"} profiles`,
    );
  }
  const next: AgentProfile = { ...edited };
  const out: ProfileEditLine[] = [];
  const shared = await sharedLines(profile, flags);
  if (shared.shared) next.shared = shared.shared;
  out.push(...shared.lines);
  const envFile = flags["env-file"];
  const env = mergePairs(
    "env",
    profile.env,
    typeof envFile === "string" ? parseEnv(await readText(ctx, "env-file", envFile)) : undefined,
    names("unset-env", listFlag(flags["unset-env"])),
    "unset-env",
  );
  if (env.lines.length) {
    if (env.next) next.env = env.next;
    else delete next.env;
  }
  out.push(...env.lines);
  if (CONNECTION_ONLY.some((flag) => flags[flag] !== undefined)) {
    if (next.connection?.method !== "custom") {
      throw new CliUsageError(
        "Headers, query parameters, timeouts and retries need a custom connection",
      );
    }
    const advanced = await editedAdvanced(ctx, next.connection, flags);
    next.connection = advanced.connection;
    out.push(...advanced.lines);
  }
  if (flags.behavior !== undefined) {
    const touched = [...listFlag(flags.share), ...listFlag(flags.unshare)].map((n) => n.trim());
    if (touched.includes(BEHAVIOR_FILE[agent])) {
      throw new CliUsageError(
        `Change the sharing of ${BEHAVIOR_FILE[agent]} and its --behavior settings in two commands`,
      );
    }
  }
  const behavior = await behaviorLines(profile, next.connection, flags, windows, read);
  out.push(...behavior.lines);
  return {
    profile: next,
    lines: out,
    ...(behavior.edit ? { behavior: behavior.edit } : {}),
    ...(shared.copy ? { copyBehaviorFile: true } : {}),
  };
}

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  API_KEY_CONNECTION_URL,
  CONNECTION_AUTH,
  CONNECTION_METHODS,
  CONNECTION_PRESETS,
  ConnectionKeyChangeSchema,
  connectionPreset,
  connectionPresetsFor,
  type ProfileConnection,
  ProfileConnectionSchema,
} from "../../../../shared/agent-profiles/connection";
import {
  AgentProfileSchema,
  PROFILE_COLORS,
  portableProfileDir,
  profilesOf,
  SHARED_BY_DEFAULT,
  suggestedProfileDir,
} from "../../../../shared/agent-profiles/profiles";
import type { ChatAgent } from "../../../../shared/sessions/task-agent";
import { ProfileValidationError } from "../../agent-profiles/connection-save";
import { expandHome, inspectLocalFolder, localDefaultDir } from "../../agent-profiles/local";
import { CliUsageError, type FlagValues } from "../args";
import { type CliContext, CliError } from "../context";
import { table } from "../format";
import { callerPath, onAppMachine } from "../paths";
import { type CliCommand, output } from "../registry";
import { readInstructionsFile } from "./chat";

export function profileTable(
  rows: readonly {
    agent: ChatAgent;
    name: string;
    id: string;
    workspaceDefault: boolean;
    path?: string;
  }[],
): string {
  return table(
    ["AGENT", "NAME", "ID", "WORKSPACE DEFAULT", "PATH"],
    rows.map((row) => [
      row.agent,
      row.name,
      row.id,
      row.workspaceDefault ? "yes" : "",
      row.path ?? "",
    ]),
  );
}

function profileConnection(agent: ChatAgent, flags: FlagValues): ProfileConnection {
  const presetFlag = flags.preset;
  const address = flags["base-url"];
  const method =
    flags.method ?? (presetFlag !== undefined || address !== undefined ? "custom" : "account");
  if (method !== "account" && method !== "api-key" && method !== "custom") {
    throw new CliUsageError("--method must be account, api-key, or custom");
  }
  if (method !== "custom") {
    if (
      [
        presetFlag,
        address,
        flags.auth,
        flags.model,
        flags["default-model"],
        flags["light-model"],
      ].some((value) => value !== undefined)
    ) {
      throw new CliUsageError(
        "Address, authentication header, and model flags require a custom connection",
      );
    }
    return { method };
  }
  const presets = connectionPresetsFor(agent);
  const preset = presets.find((id) => id === presetFlag);
  if (presetFlag !== undefined && !preset) {
    throw new CliUsageError(`--preset for ${agent} must be one of ${presets.join(", ")}`);
  }
  const defaults = preset ? connectionPreset(agent, preset) : undefined;
  const baseUrl = address ?? defaults?.baseUrl;
  if (!baseUrl) throw new CliUsageError("A custom connection needs --base-url or --preset");
  if (agent === "codex" && (flags.auth === "x-api-key" || flags["light-model"] !== undefined)) {
    throw new CliUsageError("--auth x-api-key and --light-model are for Claude profiles");
  }
  const models = Array.isArray(flags.model) ? flags.model.map((id) => ({ id })) : [];
  const parsed = ProfileConnectionSchema.safeParse({
    method,
    preset,
    baseUrl,
    auth: flags.auth ?? defaults?.auth ?? "bearer",
    models,
    defaultModel: flags["default-model"] ?? models[0]?.id,
    lightModel: flags["light-model"],
  });
  if (!parsed.success) {
    throw new CliUsageError(
      "Give a valid API address, auth method, and one to 128 valid --model IDs",
    );
  }
  return parsed.data;
}

/** Store a home-relative path when possible so it can also be used on other workspace hosts. */
function profileDir(ctx: CliContext, input: string, home: string): string {
  const dir = portableProfileDir(input);
  if (!dir || /\p{Cc}/u.test(dir)) throw new CliUsageError("Give a valid folder with --dir");
  const absolute =
    dir === "~" || dir.startsWith("~/")
      ? path.resolve(expandHome(dir, home))
      : callerPath(ctx, dir);
  const relative = path.relative(home, absolute);
  if (relative === "") return "~";
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return absolute;
  }
  return `~/${relative.split(path.sep).join("/")}`;
}

async function readKey(ctx: CliContext, file: string): Promise<string> {
  let text: string;
  try {
    text =
      file === "-"
        ? (ctx.invocation.stdin ?? "")
        : new TextDecoder("utf-8", { fatal: true }).decode(await readFile(callerPath(ctx, file)));
  } catch {
    throw new CliError("Could not read the API key file as UTF-8 text");
  }
  const key = ConnectionKeyChangeSchema.safeParse(text);
  if (!key.success || key.data === null)
    throw new CliUsageError("Invalid API key in --key-file input");
  return key.data;
}

export const chatProfilesAdd: CliCommand = {
  path: ["chat", "profiles", "add"],
  summary: "Add an agent profile on this computer with the user's approval",
  details:
    "Give --agent and --name. Account profiles are signed in from Settings. A preset or\n" +
    "address selects a custom connection, which needs at least one --model. The first\n" +
    "model is the default unless you choose another. A base URL can override a preset's address.",
  flags: {
    agent: { type: "string", value: "AGENT", description: "claude or codex (required)" },
    name: { type: "string", value: "NAME", description: "Profile name (required)" },
    color: { type: "string", value: "COLOR", description: PROFILE_COLORS.join(", ") },
    dir: {
      type: "string",
      value: "PATH",
      description: "Config folder (suggested from the name by default)",
    },
    method: {
      type: "string",
      value: "METHOD",
      description: `${CONNECTION_METHODS.join(", ")} (account by default)`,
    },
    preset: {
      type: "string",
      value: "ID",
      description: `${CONNECTION_PRESETS.join(", ")} (Codex: LiteLLM and local presets)`,
    },
    "base-url": { type: "string", value: "URL", description: "Custom API address" },
    auth: {
      type: "string",
      value: "AUTH",
      description: `${CONNECTION_AUTH.join(" or ")} for custom APIs (Codex uses bearer)`,
    },
    model: {
      type: "string",
      value: "ID",
      description: "Custom model ID (repeatable)",
      repeat: true,
    },
    "default-model": { type: "string", value: "ID", description: "Default model from the list" },
    "light-model": {
      type: "string",
      value: "ID",
      description: "Claude's light model from the list",
    },
    "key-file": {
      type: "string",
      value: "FILE",
      description: "Read the API key from FILE or - for stdin",
    },
    "instructions-file": {
      type: "string",
      value: "FILE",
      description: "Read the profile instructions from a UTF-8 file",
    },
  },
  async run(ctx, { flags, positionals }) {
    if (positionals.length) throw new CliUsageError("Use flags to specify the profile");
    if (!onAppMachine(ctx)) throw new CliError("Run this command in a local workspace");
    const agent = flags.agent;
    if (agent !== "claude" && agent !== "codex")
      throw new CliUsageError("Give --agent claude or codex");
    const name = typeof flags.name === "string" ? flags.name.trim() : "";
    if (!name || name.length > 40 || /\p{Cc}/u.test(name)) {
      throw new CliUsageError(
        "Give a profile --name of 1 to 40 characters without control characters",
      );
    }
    const connections = ctx.services.profileConnections;
    const others = profilesOf(connections.config(), agent);
    const home = os.homedir();
    const dir =
      typeof flags.dir === "string"
        ? profileDir(ctx, flags.dir, home)
        : suggestedProfileDir(
            agent,
            name,
            [localDefaultDir(agent), ...others.map((profile) => profile.dir)],
            { home, windows: process.platform === "win32" },
          );
    if (flags.color !== undefined && !PROFILE_COLORS.some((color) => color === flags.color)) {
      throw new CliUsageError(`--color must be one of ${PROFILE_COLORS.join(", ")}`);
    }
    const connection = profileConnection(agent, flags);
    const keyFile = typeof flags["key-file"] === "string" ? flags["key-file"] : undefined;
    if (connection.method === "account" && keyFile !== undefined) {
      throw new CliUsageError("--key-file requires an API connection");
    }
    if (connection.method === "api-key" && keyFile === undefined) {
      throw new CliUsageError("--method api-key requires --key-file");
    }
    const parsed = AgentProfileSchema.safeParse({
      id: `${agent}-${randomUUID().slice(0, 8)}`,
      agent,
      name,
      color:
        flags.color ??
        PROFILE_COLORS.find((color) => !others.some((p) => p.color === color)) ??
        PROFILE_COLORS[0],
      dir,
      connection,
    });
    if (!parsed.success)
      throw new CliUsageError("The profile folder must be at most 1024 characters");
    const profile = validateNew(() => connections.checkNew(parsed.data));
    const instructionsFile = flags["instructions-file"];
    const instructions =
      typeof instructionsFile === "string"
        ? await readInstructionsFile(ctx, instructionsFile)
        : undefined;
    const key = keyFile === undefined ? undefined : await readKey(ctx, keyFile);
    const endpoint =
      profile.connection?.method === "custom"
        ? profile.connection.baseUrl
        : connection.method === "api-key"
          ? API_KEY_CONNECTION_URL[agent]
          : undefined;
    await ctx.services.askUser({
      fromWorkspaceId: ctx.caller.workspaceId,
      fromTabId: ctx.caller.tabId,
      toWorkspaceId: ctx.caller.workspaceId,
      change: {
        kind: "profileAdd",
        detail: name,
        profileAdd: {
          agent,
          folder: dir,
          connection: connection.method,
          ...(endpoint ? { endpoint } : {}),
        },
        eachTime: true,
      },
    });
    ctx.signal?.throwIfAborted();
    try {
      const folder = await inspectLocalFolder(agent, dir);
      profile.shared = folder.exists ? folder.linked : [...SHARED_BY_DEFAULT[agent]];
      await connections.save({ profile, key, instructions }, { signal: ctx.signal });
    } catch (error) {
      if (error instanceof ProfileValidationError) throw new CliUsageError(error.message);
      throw new CliError("Could not save the agent profile");
    }
    const row = { id: profile.id, name, agent: profile.agent, workspaceDefault: false, path: dir };
    const signIn = connection.method === "account" ? "Sign in from Settings › Agents." : undefined;
    const shown = profileTable([row]);
    return output(signIn ? `${shown}\n${signIn}` : shown, signIn ? { ...row, signIn } : row);
  },
};

function validateNew<T>(check: () => T): T {
  try {
    return check();
  } catch (error) {
    if (error instanceof ProfileValidationError) throw new CliUsageError(error.message);
    throw error;
  }
}

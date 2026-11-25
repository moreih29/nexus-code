import {
  CONNECTION_AUTH,
  type ConnectionModel,
  type CustomConnection,
  connectionPreset,
  connectionPresetsFor,
  type ProfileConnection,
  ProfileConnectionSchema,
} from "../../../../shared/agent-profiles/connection";
import {
  type AgentProfile,
  isDefaultProfileId,
  PROFILE_COLORS,
  profilesOf,
} from "../../../../shared/agent-profiles/profiles";
import type { ProfileEditLine } from "../../../../shared/cli/consent-copy";
import type { ChatAgent } from "../../../../shared/sessions/task-agent";
import { ProfileValidationError } from "../../agent-profiles/connection-save";
import { profileConnectionView } from "../../agent-profiles/connection-view";
import { CliUsageError, type FlagValues } from "../args";
import { CliError } from "../context";
import { oneLine } from "../format";
import { onAppMachine } from "../paths";
import { type CliCommand, output } from "../registry";
import { chatAgentFlag } from "./chat";
import {
  AGENT_FLAG,
  applyModelFlags,
  CONNECTION_FLAGS,
  connectionText,
  listFlag,
  localProfile,
  type ProfileRow,
  profileConnection,
  profileName,
  profileTable,
  readKey,
  validateNew,
} from "./chat-profiles";

const MODEL_ID = /^[^\s\p{Cc}]+$/u;

function arrow(from: string, to: string): string {
  return `${from} → ${to}`;
}

function quoted(text: string | undefined): string {
  return JSON.stringify(text ?? "");
}

function modelId(flag: string, value: string): string {
  const id = value.trim();
  if (!id || id.length > 256 || !MODEL_ID.test(id)) {
    throw new CliUsageError(`--${flag} takes a model ID without spaces or control characters`);
  }
  return id;
}

function renamePairs(values: readonly string[], ids: readonly string[]): [string, string][] {
  return values.map((value) => {
    const from = ids
      .filter((id) => value.startsWith(`${id}=`))
      .sort((a, b) => b.length - a.length)[0];
    if (from === undefined) {
      throw new CliUsageError("--rename-model takes OLD=NEW with OLD one of the profile's models");
    }
    return [from, modelId("rename-model", value.slice(from.length + 1))];
  });
}

const PATCH_FLAGS = [
  "preset",
  "base-url",
  "auth",
  "model",
  "add-model",
  "remove-model",
  "rename-model",
  "reasoning",
  "context-window",
  "label",
  "default-model",
  "light-model",
] as const;

function editedModels(current: CustomConnection, flags: FlagValues): ConnectionModel[] {
  const replace = listFlag(flags.model);
  const added = listFlag(flags["add-model"]).map((id) => modelId("add-model", id));
  const removed = listFlag(flags["remove-model"]).map((id) => id.trim());
  const renamed = renamePairs(
    listFlag(flags["rename-model"]),
    current.models.map(({ id }) => id),
  );
  if (replace.length && (added.length || removed.length || renamed.length)) {
    throw new CliUsageError(
      "Give --model to replace the list, or --add-model, --remove-model and --rename-model",
    );
  }
  if (replace.length) {
    return replace.map((value) => {
      const id = modelId("model", value);
      return current.models.find((model) => model.id === id) ?? { id };
    });
  }
  let models = current.models;
  for (const [from, to] of renamed) {
    if (models.some(({ id }) => id === to)) {
      throw new CliUsageError(`--rename-model: "${to}" is already a model of the profile`);
    }
    models = models.map((model) => (model.id === from ? { ...model, id: to } : model));
  }
  for (const id of removed) {
    if (!models.some((model) => model.id === id)) {
      throw new CliUsageError(`--remove-model: "${id}" is not a model of the profile`);
    }
    models = models.filter((model) => model.id !== id);
  }
  for (const id of added) {
    if (models.some((model) => model.id === id)) {
      throw new CliUsageError(`--add-model: "${id}" is already a model of the profile`);
    }
    models = [...models, { id }];
  }
  return models;
}

function patchedConnection(
  agent: ChatAgent,
  current: CustomConnection,
  flags: FlagValues,
): CustomConnection {
  let { baseUrl, auth, preset } = current;
  if (flags.preset !== undefined) {
    if (flags.preset === "none") preset = undefined;
    else {
      const presets = connectionPresetsFor(agent);
      preset = presets.find((id) => id === flags.preset);
      if (!preset) {
        throw new CliUsageError(
          `--preset for ${agent} must be one of ${presets.join(", ")}, or none`,
        );
      }
      const defaults = connectionPreset(agent, preset);
      baseUrl = defaults.baseUrl;
      auth = defaults.auth;
    }
  }
  if (typeof flags["base-url"] === "string") baseUrl = flags["base-url"].trim();
  if (flags.auth !== undefined) {
    if (!CONNECTION_AUTH.some((value) => value === flags.auth)) {
      throw new CliUsageError(`--auth must be ${CONNECTION_AUTH.join(" or ")}`);
    }
    auth = flags.auth as CustomConnection["auth"];
  }
  if (agent === "codex" && (auth === "x-api-key" || flags["light-model"] !== undefined)) {
    throw new CliUsageError("--auth x-api-key and --light-model are for Claude profiles");
  }
  const listed = editedModels(current, flags);
  if (!listed.length) throw new CliUsageError("A custom connection needs at least one model");
  const { models, contextWindow: window } = applyModelFlags(
    agent,
    listed,
    flags,
    "a model of the profile",
  );
  const renames = new Map(
    renamePairs(
      listFlag(flags["rename-model"]),
      current.models.map(({ id }) => id),
    ),
  );
  const ids = models.map(({ id }) => id);
  const defaultFlag =
    typeof flags["default-model"] === "string" ? flags["default-model"].trim() : undefined;
  const defaultModel = defaultFlag ?? renames.get(current.defaultModel) ?? current.defaultModel;
  if (!ids.includes(defaultModel)) {
    throw new CliUsageError(
      defaultFlag === undefined
        ? `The default model "${current.defaultModel}" is no longer listed; give --default-model`
        : "--default-model must be one of the profile's models",
    );
  }
  const lightFlag =
    typeof flags["light-model"] === "string" ? flags["light-model"].trim() : undefined;
  const keptLight = current.lightModel && (renames.get(current.lightModel) ?? current.lightModel);
  const lightModel =
    lightFlag === "auto" && !ids.includes("auto")
      ? undefined
      : (lightFlag ?? (keptLight && ids.includes(keptLight) ? keptLight : undefined));
  if (lightModel !== undefined && !ids.includes(lightModel)) {
    throw new CliUsageError("--light-model must be one of the profile's models, or auto");
  }
  const contextWindow = window === undefined ? current.contextWindow : (window ?? undefined);
  const parsed = ProfileConnectionSchema.safeParse({
    method: "custom",
    ...(preset ? { preset } : {}),
    baseUrl,
    ...(auth ? { auth } : {}),
    models,
    defaultModel,
    ...(lightModel ? { lightModel } : {}),
    ...(contextWindow ? { contextWindow } : {}),
    ...(current.advanced ? { advanced: current.advanced } : {}),
  });
  if (!parsed.success || parsed.data.method !== "custom") {
    throw new CliUsageError("Give a valid API address and one to 128 valid model IDs");
  }
  return parsed.data;
}

function connectionLines(
  agent: ChatAgent,
  before: ProfileConnection | undefined,
  after: ProfileConnection | undefined,
  renamed: ReadonlyMap<string, string> = new Map(),
): ProfileEditLine[] {
  const from = before?.method ?? "account";
  const to = after?.method ?? "account";
  const lines: ProfileEditLine[] = [];
  if (from !== to) lines.push({ field: "connection", from, to });
  if (after?.method !== "custom") return lines;
  const old = before?.method === "custom" ? before : undefined;
  const auth = (connection: CustomConnection | undefined) =>
    connection ? (agent === "codex" ? "bearer" : (connection.auth ?? "bearer")) : "";
  const pairs: [ProfileEditLine["field"], string | undefined, string | undefined][] = [
    ["address", old?.baseUrl, after.baseUrl],
    ["auth", old && auth(old), auth(after)],
    [
      "models",
      old?.models.map(({ id }) => id).join(", "),
      after.models.map(({ id }) => id).join(", "),
    ],
    ["defaultModel", old?.defaultModel, after.defaultModel],
    ["lightModel", old && (old.lightModel ?? "auto"), after.lightModel ?? "auto"],
  ];
  if (agent === "claude" || old?.contextWindow !== undefined || after.contextWindow !== undefined) {
    pairs.push([
      "context",
      old && (old.contextWindow === undefined ? "auto" : String(old.contextWindow)),
      after.contextWindow === undefined ? "auto" : String(after.contextWindow),
    ]);
  }
  for (const [field, was, now] of pairs) {
    if (was === now) continue;
    lines.push({
      field,
      value: was === undefined ? (now ?? "") : arrow(was, now ?? ""),
    } as ProfileEditLine);
  }
  if (old && old.preset !== after.preset) {
    lines.push({ field: "preset", value: arrow(old.preset ?? "none", after.preset ?? "none") });
  }
  for (const model of after.models) {
    const previous = renamed.get(model.id) ?? model.id;
    const was = old?.models.find(({ id }) => id === previous);
    const settings: [ProfileEditLine["field"], string, string][] = [
      ["context", String(was?.contextWindow ?? "auto"), String(model.contextWindow ?? "auto")],
      ["reasoning", was?.reasoning ?? "auto", model.reasoning ?? "auto"],
      ["label", quoted(was?.label), quoted(model.label)],
    ];
    for (const [field, a, b] of settings) {
      if (a === b) continue;
      lines.push({ field, value: `${model.id} ${arrow(a, b)}` } as ProfileEditLine);
    }
  }
  return lines;
}

export const chatProfilesEdit = {
  path: ["chat", "profiles", "edit"],
  summary: "Change an agent profile on this computer with the user's approval",
  args: "<profile>",
  details:
    "Give the profile's name or id (--agent when a Claude and a Codex profile share it) and the\n" +
    "settings to change. A custom connection keeps what you do not name: --add-model,\n" +
    "--remove-model and --rename-model OLD=NEW change its list, or --model replaces it. --reasoning,\n" +
    "--context-window and --label take auto (or empty text) to clear; --light-model auto uses the\n" +
    "default model. --method switches the connection and takes the add flags. Give a new key with\n" +
    "--key-file FILE or - for stdin, or --remove-key. A key stays with the address and auth header\n" +
    "it was saved for, so changing either needs the key again.",
  flags: {
    agent: AGENT_FLAG,
    name: { type: "string", value: "NAME", description: "New profile name" },
    color: { type: "string", value: "COLOR", description: PROFILE_COLORS.join(", ") },
    ...CONNECTION_FLAGS,
    method: {
      type: "string",
      value: "METHOD",
      description: "Switch to account, api-key, or custom",
    },
    preset: {
      type: "string",
      value: "ID",
      description: "A preset (sets its address and auth), or none",
    },
    model: {
      type: "string",
      value: "ID",
      description: "Replace the model list (repeatable)",
      repeat: true,
    },
    "add-model": {
      type: "string",
      value: "ID",
      description: "Add a model (repeatable)",
      repeat: true,
    },
    "remove-model": {
      type: "string",
      value: "ID",
      description: "Remove a model (repeatable)",
      repeat: true,
    },
    "rename-model": {
      type: "string",
      value: "OLD=NEW",
      description: "Change a model's ID, keeping its settings (repeatable)",
      repeat: true,
    },
    "light-model": {
      type: "string",
      value: "ID",
      description: "Claude's light model from the list, or auto",
    },
    "remove-key": { type: "boolean", description: "Delete the saved API key" },
  },
  async run(ctx, { flags, positionals }) {
    const [selector, ...extra] = positionals;
    if (selector === undefined || extra.length) throw new CliUsageError("Give one <profile>");
    if (!onAppMachine(ctx)) throw new CliError("Run this command in a local workspace");
    const agentFilter =
      flags.agent === undefined ? undefined : chatAgentFlag(flags.agent, "claude");
    const profile = localProfile(ctx, selector, agentFilter);
    const { agent } = profile;
    const lines: ProfileEditLine[] = [];
    let name = profile.name;
    if (flags.name !== undefined) {
      name = typeof flags.name === "string" ? flags.name.trim() : "";
      const empty = !name && !isDefaultProfileId(profile.id);
      if (empty || name.length > 40 || /\p{Cc}/u.test(name)) {
        throw new CliUsageError("Give a --name of 1 to 40 characters without control characters");
      }
      if (name !== profile.name) {
        lines.push({
          field: "name",
          value: arrow(profileName(profile), profileName({ id: profile.id, name })),
        });
      }
    }
    let color = profile.color;
    if (flags.color !== undefined) {
      if (!PROFILE_COLORS.some((value) => value === flags.color)) {
        throw new CliUsageError(`--color must be one of ${PROFILE_COLORS.join(", ")}`);
      }
      color = flags.color as string;
      if (color !== profile.color)
        lines.push({ field: "color", value: arrow(profile.color, color) });
    }
    const method = profile.connection?.method ?? "account";
    const switching = flags.method !== undefined && flags.method !== method;
    const patching = PATCH_FLAGS.some((flag) => flags[flag] !== undefined);
    let connection = profile.connection;
    if (switching) {
      if (["add-model", "remove-model", "rename-model"].some((flag) => flags[flag] !== undefined)) {
        throw new CliUsageError(
          "--method takes the flags of profiles add: give the models with --model",
        );
      }
      connection = profileConnection(agent, flags);
    } else if (patching) {
      if (profile.connection?.method !== "custom") {
        throw new CliUsageError(
          "Address, authentication header, and model flags require a custom connection",
        );
      }
      connection = patchedConnection(agent, profile.connection, flags);
    }
    const renamed =
      patching && profile.connection?.method === "custom"
        ? new Map(
            renamePairs(
              listFlag(flags["rename-model"]),
              profile.connection.models.map(({ id }) => id),
            ).map(([from, to]) => [to, from]),
          )
        : undefined;
    lines.push(...connectionLines(agent, profile.connection, connection, renamed));
    const keyFile = typeof flags["key-file"] === "string" ? flags["key-file"] : undefined;
    const removeKey = flags["remove-key"] === true;
    const nextMethod = connection?.method ?? "account";
    if (keyFile !== undefined && removeKey) {
      throw new CliUsageError("Give --key-file or --remove-key, not both");
    }
    if (keyFile !== undefined && nextMethod === "account") {
      throw new CliUsageError("--key-file requires an API connection");
    }
    if (removeKey && nextMethod !== "custom") {
      throw new CliUsageError(
        "--remove-key is for custom connections; an API key profile needs its key",
      );
    }
    if (nextMethod === "api-key" && method !== "api-key" && keyFile === undefined) {
      throw new CliUsageError("--method api-key requires --key-file");
    }
    if (keyFile !== undefined) lines.push({ field: "key", change: "replaced" });
    if (removeKey) lines.push({ field: "key", change: "removed" });
    if (!lines.length)
      throw new CliUsageError("Nothing to change. See nexus chat profiles edit --help");
    const edited: AgentProfile = { ...profile, name, color };
    if (connection) edited.connection = connection;
    else delete edited.connection;
    const next = validateNew(() => ctx.services.profileConnections.checkEdit(edited));
    const key =
      keyFile === undefined ? (removeKey ? null : undefined) : await readKey(ctx, keyFile);
    const before = JSON.stringify(profile);
    await ctx.services.askUser(
      {
        fromWorkspaceId: ctx.caller.workspaceId,
        fromTabId: ctx.caller.tabId,
        toWorkspaceId: ctx.caller.workspaceId,
        change: {
          kind: "profileEdit",
          detail: profileName(profile),
          profileEdit: { agent, lines },
          eachTime: true,
        },
      },
      ctx.signal,
    );
    ctx.signal?.throwIfAborted();
    const connections = ctx.services.profileConnections;
    const now = profilesOf(connections.config(), agent).find(({ id }) => id === profile.id);
    if (JSON.stringify(now) !== before) {
      throw new CliError("The profile changed while waiting for approval; run the command again");
    }
    try {
      await connections.save({ profile: next, ...(key !== undefined ? { key } : {}) });
    } catch (error) {
      if (error instanceof ProfileValidationError) throw new CliUsageError(error.message);
      throw new CliError("Could not save the agent profile");
    }
    const hasKey = await connections.keyPresent(next).catch(() => undefined);
    const row: ProfileRow = {
      id: next.id,
      name: profileName(next),
      agent,
      workspaceDefault: false,
      color: next.color,
      connection: profileConnectionView(next),
      ...(hasKey !== undefined ? { hasKey } : {}),
    };
    const moved =
      key === undefined &&
      before !== JSON.stringify(next) &&
      lines.some(({ field }) => field === "address" || field === "auth") &&
      hasKey === false;
    const note = moved
      ? "The saved API key stays with the old address and auth header; give it again with --key-file."
      : undefined;
    const changed = [...new Set(lines.map(({ field }) => field))];
    const details = connectionText([row]);
    return output([profileTable([row]), details, note].filter(Boolean).join("\n\n"), {
      ...row,
      changed,
      ...(note ? { note } : {}),
    });
  },
} satisfies CliCommand;

export const chatProfilesRemove = {
  path: ["chat", "profiles", "remove"],
  summary: "Remove an agent profile on this computer with the user's approval",
  args: "<profile>",
  details:
    "Give the profile's name or id (--agent when a Claude and a Codex profile share it). As in\n" +
    "Settings, its folder with the sign-ins and history in it stays, workspace rules and defaults\n" +
    "that chose it fall back, and its saved API key is deleted. Open tabs are not closed.\n" +
    "The default profile cannot be removed.",
  flags: { agent: AGENT_FLAG },
  async run(ctx, { flags, positionals }) {
    const [selector, ...extra] = positionals;
    if (selector === undefined || extra.length) throw new CliUsageError("Give one <profile>");
    if (!onAppMachine(ctx)) throw new CliError("Run this command in a local workspace");
    const agentFilter =
      flags.agent === undefined ? undefined : chatAgentFlag(flags.agent, "claude");
    const profile = localProfile(ctx, selector, agentFilter);
    if (isDefaultProfileId(profile.id)) {
      throw new CliUsageError("The default profile cannot be removed");
    }
    const name = profileName(profile);
    const before = JSON.stringify(profile);
    await ctx.services.askUser(
      {
        fromWorkspaceId: ctx.caller.workspaceId,
        fromTabId: ctx.caller.tabId,
        toWorkspaceId: ctx.caller.workspaceId,
        change: {
          kind: "profileRemove",
          detail: name,
          profileRemove: { agent: profile.agent, folder: profile.dir },
          eachTime: true,
        },
      },
      ctx.signal,
    );
    ctx.signal?.throwIfAborted();
    const connections = ctx.services.profileConnections;
    const now = profilesOf(connections.config(), profile.agent).find(({ id }) => id === profile.id);
    if (JSON.stringify(now) !== before) {
      throw new CliError("The profile changed while waiting for approval; run the command again");
    }
    try {
      connections.remove(profile.id);
    } catch (error) {
      if (error instanceof ProfileValidationError) throw new CliUsageError(error.message);
      throw new CliError("Could not remove the agent profile");
    }
    return output(
      `Removed the ${profile.agent} profile "${oneLine(name, 80)}" (${profile.id}). Its folder ${profile.dir} stays.`,
      { id: profile.id, name, agent: profile.agent, path: profile.dir, removed: true },
    );
  },
} satisfies CliCommand;

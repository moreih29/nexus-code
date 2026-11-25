import {
  type InstructionScope,
  workspaceInstructionTarget,
} from "../../../../shared/chat/instructions";
import { consentProfileLayer } from "../../../../shared/cli/consent-copy";
import {
  describeShape,
  formatSettingValue,
  LSP_PATH_SHAPE,
  lspPathSetting,
  parseSettingValue,
  SETTINGS_PAGES,
  settingAskingToTurnOn,
  settingsPageNamed,
  turnsOn,
} from "../../../../shared/cli/settings";
import type {
  CliChange,
  CliKeyBinding,
  CliKeyChange,
  CliSettingInfo,
  CliUiOps,
} from "../../../../shared/cli/ui";
import type { LspPathLanguage } from "../../../../shared/lsp/settings";
import type { ChatAgent } from "../../../../shared/sessions/task-agent";
import { CliUsageError, exactArgs } from "../args";
import { type CliContext, type CliDevice, CliError, resolveWorkspace } from "../context";
import { oneLine, table } from "../format";
import { type CliCommand, output } from "../registry";
import {
  agentSenderOf,
  askDevice,
  changePeerCli,
  DEVICE_FLAG,
  deviceFlag,
  deviceRef,
  peerSessions,
  pickPeerWorkspace,
  requirePeerCli,
  resolveDevice,
} from "../remote";
import { mayExecute } from "../sandbox";
import { chatAgentFlag, checkedInstructions, readInstructionsFile } from "./chat";
import { WORKSPACE_FLAG } from "./flags";

async function listSettings(ctx: CliContext, key?: string): Promise<CliSettingInfo[]> {
  return (await ctx.services.ui("settings.list", key === undefined ? {} : { key })).settings;
}

function shownValue(setting: CliSettingInfo): string {
  if (setting.unavailable) return `unavailable: ${setting.unavailable}`;
  return `${oneLine(formatSettingValue(setting.value), VALUE_WIDTH)}${setting.changed ? " *" : ""}`;
}

const TAKES_WIDTH = 40;
const VALUE_WIDTH = 60;

function takes(setting: CliSettingInfo): string {
  if (setting.readOnly) return "(in Settings)";
  const shape = describeShape(setting);
  return shape.length > TAKES_WIDTH ? `${setting.choices?.length} choices (--json)` : shape;
}

const settingsList: CliCommand = {
  path: ["settings", "list"],
  summary: "List the app's settings, their values and what each takes",
  details:
    'A "*" marks one changed from its default. --json gives what each is for, and every\n' +
    "choice of the ones with many.",
  async run(ctx, { positionals }) {
    exactArgs(positionals);
    const settings = await listSettings(ctx);
    const rows = settings.map((s) => [s.key, shownValue(s), takes(s)]);
    return output(table(["KEY", "VALUE", "TAKES"], rows), settings);
  },
};

const settingsGet: CliCommand = {
  path: ["settings", "get"],
  summary: "Print a setting's value",
  args: "<key>",
  async run(ctx, { positionals }) {
    const [key] = exactArgs(positionals, "key") as [string];
    const [setting] = await listSettings(ctx, key);
    if (!setting) throw new CliError(`no setting "${key}"; nexus settings list shows them`);
    if (setting.unavailable) throw new CliError(`${setting.key}: ${setting.unavailable}`);
    return output(formatSettingValue(setting.value), setting);
  },
};

function changed(setting: CliSettingInfo) {
  const value = formatSettingValue(setting.value);
  return output(`${setting.key} is ${value === "" ? '""' : value}.`, setting);
}

async function setLspPath(ctx: CliContext, key: string, language: LspPathLanguage, value: string) {
  const parsed = parseSettingValue(LSP_PATH_SHAPE, value);
  if ("error" in parsed) throw new CliUsageError(`${key}: ${parsed.error}`);
  const path = value.trim();
  const [setting] = await listSettings(ctx, key);
  if (!setting) throw new CliError(`no setting "${key}"; nexus settings list shows them`);
  const current = String(setting.value);
  if (path === current) return changed(setting);
  if (path !== "") {
    await ctx.services.askUser(
      {
        fromWorkspaceId: ctx.caller.workspaceId,
        fromTabId: ctx.caller.tabId,
        toWorkspaceId: ctx.caller.workspaceId,
        change: {
          kind: "lspPath",
          detail: language,
          settingsEdit: { language, lines: [{ field: "path", from: current, to: path }] },
          eachTime: true,
        },
      },
      ctx.signal,
    );
    ctx.signal?.throwIfAborted();
  }
  const { setting: after } = await ctx.services.ui("settings.set", {
    key,
    value: path,
    ...(path !== "" ? { approved: true, expected: current } : {}),
  });
  return changed(after);
}

const settingsSet: CliCommand = {
  path: ["settings", "set"],
  summary: "Change a setting, as the Settings dialog does",
  args: "<key> <value>",
  details:
    "The value is read as the setting takes it (nexus settings list): on or off, a number in\n" +
    "its range, one of its choices, or text; a list (voice.terms) whole, comma-separated. It\n" +
    "takes effect at once and is kept. Turning on notes.summary, notes.voiceSuggest or\n" +
    "notes.voiceExpire, or giving lsp.go.path or lsp.rust.path a path, asks the user each\n" +
    'time ("" goes back to the PATH without asking). Whether nexus may change other\n' +
    "workspaces, and whether it works at all, are the user's to set.",
  async run(ctx, { positionals }) {
    const [key, value] = exactArgs(positionals, "key", "value") as [string, string];
    const lspPath = lspPathSetting(key);
    if (lspPath !== undefined) return setLspPath(ctx, key, lspPath, value);
    const asking = settingAskingToTurnOn(key);
    const approved = asking !== undefined && turnsOn(value);
    if (approved) {
      await ctx.services.askUser(
        {
          fromWorkspaceId: ctx.caller.workspaceId,
          fromTabId: ctx.caller.tabId,
          toWorkspaceId: ctx.caller.workspaceId,
          change: { kind: "settingTurnOn", detail: asking, eachTime: true },
        },
        ctx.signal,
      );
      ctx.signal?.throwIfAborted();
    }
    const { setting } = await ctx.services.ui("settings.set", {
      key,
      value,
      ...(approved ? { approved } : {}),
    });
    return changed(setting);
  },
};

const settingsReset: CliCommand = {
  path: ["settings", "reset"],
  summary: "Give a setting back its default",
  args: "<key>",
  async run(ctx, { positionals }) {
    const [key] = exactArgs(positionals, "key") as [string];
    const { setting } = await ctx.services.ui("settings.set", { key, value: null });
    return changed(setting);
  },
};

const settingsOpen: CliCommand = {
  path: ["settings", "open"],
  summary: "Open the Settings dialog for the user, at a page",
  args: "[page|key]",
  details:
    `Pages: ${SETTINGS_PAGES.join(", ")}. A setting's key (nexus settings list) opens\n` +
    "the page that has it. With neither, the dialog opens where it was left. For what only\n" +
    "the user sets, such as granting a browser permission.",
  async run(ctx, { positionals }) {
    if (positionals.length > 1) {
      throw new CliUsageError(`unexpected argument "${positionals[1]}"`);
    }
    const [word] = positionals;
    const page = word === undefined ? undefined : settingsPageNamed(word);
    if (word !== undefined && !page) {
      throw new CliUsageError(
        `no page "${word}"; the pages are ${SETTINGS_PAGES.join(", ")}, or a setting's key`,
      );
    }
    await ctx.services.ui("settings.open", page ? { page } : {});
    return output(page ? `Opened Settings at ${page}.` : "Opened Settings.", page ? { page } : {});
  },
};

const INSTRUCTION_PROFILE_FLAG = {
  type: "string",
  value: "PROFILE",
  description: "A profile id or name from nexus chat profiles",
} as const;

async function instructionProfile(
  ctx: CliContext,
  device: CliDevice | null,
  selector: string,
  agent?: ChatAgent,
) {
  const filter = agent ? { agent } : {};
  const { profiles } = device
    ? await askDevice(ctx, device, "profiles.list", filter, ctx.signal)
    : await ctx.services.ui("chat.profiles", filter);
  const exact = profiles.find((profile) => profile.id === selector);
  if (exact) return consentProfileLayer(exact, profiles);
  const wanted = selector.trim().toLowerCase();
  const [match, ...others] = profiles.filter(
    ({ id, name }) => id.toLowerCase() === wanted || name.toLowerCase() === wanted,
  );
  if (others.length > 0)
    throw new CliError(
      `more than one profile matches "${selector}". Use its id from nexus chat profiles.`,
    );
  if (!match)
    throw new CliError(
      `no ${agent ? `${agent} ` : ""}profile "${selector}". See nexus chat profiles.`,
    );
  return consentProfileLayer(match, profiles);
}

const settingsInstructions: CliCommand = {
  path: ["settings", "instructions", "show"],
  summary: "Show the instruction layers for a new chat and their combined text",
  details:
    "The profile comes from the workspace's rules unless you give --profile. The agent defaults to Claude " +
    "or to the selected profile's agent. With --device, --workspace defaults to that computer's first listed workspace.",
  flags: {
    workspace: WORKSPACE_FLAG,
    agent: { type: "string", value: "AGENT", description: "claude or codex" },
    profile: INSTRUCTION_PROFILE_FLAG,
    device: DEVICE_FLAG,
  },
  async run(ctx, { positionals, flags }) {
    exactArgs(positionals);
    const selector = flags.workspace as string | undefined;
    const device = await resolveDevice(ctx, deviceFlag(flags));
    let workspaceId: string;
    if (device) {
      requirePeerCli(ctx, device, "settings.instructions");
      const { workspaces } = await peerSessions(ctx, device, ctx.signal);
      const workspace =
        selector === undefined ? workspaces[0] : pickPeerWorkspace(device, workspaces, selector);
      if (!workspace) throw new CliError(`no workspace on "${device.name}"`);
      workspaceId = workspace.id;
    } else {
      workspaceId = resolveWorkspace(ctx, selector).id;
    }
    const agent = flags.agent === undefined ? undefined : chatAgentFlag(flags.agent, "claude");
    const profile =
      typeof flags.profile === "string"
        ? await instructionProfile(ctx, device, flags.profile, agent)
        : undefined;
    const target = {
      workspaceId,
      agent: profile?.agent ?? agent ?? "claude",
      ...(profile ? { profileId: profile.id } : {}),
    };
    const result = device
      ? await askDevice(
          ctx,
          device,
          "settings.instructions",
          { ...target, from: await agentSenderOf(ctx) },
          ctx.signal,
        )
      : await ctx.services.ui("settings.instructions", target);
    const sources = result.layers.map((layer) => `- ${layer.title}${layer.text ? "" : " (empty)"}`);
    const text = ["Sources, in order:", ...sources, "", result.instructions || "(no instructions)"];
    return output(text.join("\n"), {
      ...target,
      ...result,
      ...(device ? { device: deviceRef(device) } : {}),
    });
  },
};

const settingsInstructionsSet: CliCommand = {
  path: ["settings", "instructions", "set"],
  args: "<all|claude|codex|profile|workspace>",
  summary: "Replace or clear a persistent instruction layer",
  details:
    "All, Claude, Codex, and profile changes need approval each time. Give --profile for the profile layer. " +
    "Workspace changes follow the workspace policy.",
  flags: {
    file: {
      type: "string",
      value: "FILE",
      description: "Read the new layer from UTF-8 FILE or - for stdin",
    },
    clear: { type: "boolean", description: "Clear the layer" },
    profile: INSTRUCTION_PROFILE_FLAG,
    workspace: WORKSPACE_FLAG,
    device: DEVICE_FLAG,
  },
  async run(ctx, { flags, positionals }) {
    const [layer] = exactArgs(positionals, "layer") as [string];
    if (
      layer !== "all" &&
      layer !== "claude" &&
      layer !== "codex" &&
      layer !== "profile" &&
      layer !== "workspace"
    )
      throw new CliUsageError("choose all, claude, codex, profile, or workspace");
    if (flags.workspace !== undefined && layer !== "workspace")
      throw new CliUsageError("--workspace goes with the workspace layer");
    const profileSelector = typeof flags.profile === "string" ? flags.profile : "";
    if (layer === "profile" && !profileSelector.trim())
      throw new CliUsageError("give --profile for the profile layer");
    if (layer !== "profile" && flags.profile !== undefined)
      throw new CliUsageError("--profile goes with the profile layer");
    const file = typeof flags.file === "string" ? flags.file : undefined;
    if ((file !== undefined) === (flags.clear === true))
      throw new CliUsageError("give --file or --clear");
    const text =
      file === "-"
        ? checkedInstructions(ctx.invocation.stdin ?? "")
        : file === undefined
          ? ""
          : await readInstructionsFile(ctx, file);
    const device = await resolveDevice(ctx, deviceFlag(flags));
    if (device)
      requirePeerCli(ctx, device, layer === "profile" ? "settings.instructions" : undefined);
    const edit =
      layer === "profile"
        ? ({ layer, profile: await instructionProfile(ctx, device, profileSelector) } as const)
        : ({ layer } as const);
    if (device) {
      const { workspaces } = await peerSessions(ctx, device, ctx.signal);
      const requested =
        layer === "workspace"
          ? pickPeerWorkspace(device, workspaces, flags.workspace as string | undefined)
          : workspaces[0];
      if (!requested) throw new CliError(`no workspace on "${device.name}"`);
      const workspace =
        layer === "workspace" ? workspaceInstructionTarget(requested, workspaces) : requested;
      if (!workspace) throw new CliError(`no parent workspace for "${requested.name}"`);
      const target =
        edit.layer === "profile" ? { layer: edit.layer, profileId: edit.profile.id } : edit;
      await changePeerCli(ctx, device, "settings.instructions.set", {
        workspaceId: workspace.id,
        ...target,
        text,
      });
      const destination = layer === "workspace" ? ` for "${workspace.name}"` : "";
      return output(`Updated the ${layer} instruction layer${destination} on "${device.name}".`, {
        ...target,
        device: deviceRef(device),
        ...(layer === "workspace"
          ? { workspaceId: workspace.id, workspaceName: workspace.name }
          : {}),
        text,
      });
    }
    const requested = resolveWorkspace(ctx, flags.workspace as string | undefined);
    const workspace =
      layer === "workspace"
        ? workspaceInstructionTarget(requested, ctx.services.listWorkspaces())
        : requested;
    if (!workspace) throw new CliError(`no parent workspace for "${requested.name}"`);
    const scope: InstructionScope =
      edit.layer === "profile"
        ? { kind: "profile", id: edit.profile.id }
        : edit.layer === "workspace"
          ? { kind: "workspace", id: workspace.id }
          : edit.layer === "all"
            ? { kind: "all" }
            : { kind: "agent", agent: edit.layer };
    const change: CliChange = {
      kind: "instructionsEdit",
      instructionEdit: {
        layer:
          edit.layer === "profile"
            ? edit.profile
            : edit.layer === "workspace"
              ? { kind: "workspace", name: workspace.name }
              : edit.layer === "all"
                ? { kind: "all" }
                : { kind: "agent", agent: edit.layer },
        clear: !text,
      },
      body: text,
    };
    const shared = layer !== "workspace";
    await mayExecute(
      ctx,
      workspace,
      {
        ...change,
        ...(shared ? { eachTime: true } : {}),
      },
      { alwaysAsk: shared },
    );
    await ctx.services.ui("settings.instructions.set", { scope, text });
    const target = layer === "workspace" ? ` for "${workspace.name}"` : "";
    return output(`${text ? "Updated" : "Cleared"} the ${layer} instruction layer${target}.`, {
      scope,
      ...(layer === "workspace" ? { workspaceName: workspace.name } : {}),
      text,
    });
  },
};

function keysTable(bindings: readonly CliKeyBinding[]): string {
  return table(
    ["AREA", "COMMAND", "KEYS", "WHEN"],
    bindings.map((binding) => [
      binding.area,
      binding.command,
      [binding.primary, binding.chord?.join(" ")].filter(Boolean).join(" / ") || "(unbound)",
      binding.when ?? "",
    ]),
  );
}

const settingsKeysList: CliCommand = {
  path: ["settings", "keys", "list"],
  summary: "List effective app and editor keybindings",
  async run(ctx, { positionals }) {
    exactArgs(positionals);
    const { bindings } = await ctx.services.ui("settings.keys", {});
    return output(keysTable(bindings), { bindings }, { records: bindings });
  },
};

async function changeKeys(ctx: CliContext, change: CliKeyChange) {
  const result = await ctx.services.ui("settings.keys.set", { change });
  const warnings = result.warnings.map((warning) => `warning: ${warning}`);
  return output([keysTable(result.bindings), ...warnings].filter(Boolean).join("\n"), result);
}

const settingsKeysSet: CliCommand = {
  path: ["settings", "keys", "set"],
  summary: "Give a command a keyboard shortcut, as Settings › Keyboard Shortcuts does",
  args: "<command> <keys>",
  details:
    "Keys are written as nexus settings keys list shows them, such as CmdOrCtrl+Shift+P (on\n" +
    "Windows and Linux, as the Settings page shows them, such as Ctrl+Shift+P; Cmd means Ctrl\n" +
    "there, and the Windows or Super key isn't taken). A\n" +
    "command bound to a chord takes its two keys, such as CmdOrCtrl+K CmdOrCtrl+S. A shortcut\n" +
    "another command already uses where both apply, or the system keeps, is refused with the\n" +
    "reason; one only shared in another focus or used by the editor or terminal is set, with a warning.",
  async run(ctx, { positionals }) {
    const [command, ...rest] = positionals;
    if (command === undefined) throw new CliUsageError("give a command and its keys");
    const keys = rest.flatMap((word) => word.split(/\s+/)).filter(Boolean);
    if (keys.length === 0) throw new CliUsageError("give the keys");
    return changeKeys(ctx, { op: "set", command, keys });
  },
};

const settingsKeysUnbind: CliCommand = {
  path: ["settings", "keys", "unbind"],
  summary: "Take a command's keyboard shortcut away",
  args: "<command>",
  async run(ctx, { positionals }) {
    const [command] = exactArgs(positionals, "command") as [string];
    return changeKeys(ctx, { op: "unbind", command });
  },
};

const settingsKeysReset: CliCommand = {
  path: ["settings", "keys", "reset"],
  summary: "Give a command, or with --all every command, its default shortcut back",
  args: "[command]",
  flags: { all: { type: "boolean", description: "Reset every shortcut" } },
  async run(ctx, { positionals, flags }) {
    if (flags.all === true) {
      exactArgs(positionals);
      return changeKeys(ctx, { op: "reset" });
    }
    if (positionals.length === 0) throw new CliUsageError("give a command or --all");
    const [command] = exactArgs(positionals, "command") as [string];
    return changeKeys(ctx, { op: "reset", command });
  },
};

const settingsLspStatus: CliCommand = {
  path: ["settings", "lsp", "status"],
  summary: "Show the current workspace's language server status",
  flags: { workspace: WORKSPACE_FLAG },
  async run(ctx, { positionals, flags }) {
    exactArgs(positionals);
    const workspace = resolveWorkspace(ctx, flags.workspace as string | undefined);
    const result = await ctx.services.ui("settings.lspStatus", { workspaceId: workspace.id });
    const text = table(
      ["LANGUAGE", "STATE"],
      result.servers.map(({ language, state }) => [language, state]),
    );
    return output(
      text ||
        (result.enabled ? "No language servers have started." : "Language servers are disabled."),
      result,
    );
  },
};

type UpdateState = CliUiOps["settings.updateStatus"]["result"];

function updateLine(result: UpdateState): string {
  const version =
    result.status &&
    ("version" in result.status
      ? result.status.version
      : "latest" in result.status
        ? result.status.latest
        : undefined);
  return result.status
    ? [result.status.kind, version].filter(Boolean).join(" ")
    : "No update check yet.";
}

const settingsUpdateStatus: CliCommand = {
  path: ["settings", "updates", "status"],
  summary: "Show the last app update check and download progress",
  async run(ctx, { positionals }) {
    exactArgs(positionals);
    const result = await ctx.services.ui("settings.updateStatus", {});
    return output(updateLine(result), result);
  },
};

const UPDATE_CHECK_TIMEOUT_MS = 75_000;

const settingsUpdateCheck: CliCommand = {
  path: ["settings", "updates", "check"],
  summary: "Look for an app update now and print what was found",
  details:
    "As Settings › About's button does. It only looks: downloading, installing and\n" +
    "restarting stay the user's, from the notice the app shows.",
  async run(ctx, { positionals }) {
    exactArgs(positionals);
    const result = await ctx.services.ui("settings.updateCheck", {}, UPDATE_CHECK_TIMEOUT_MS);
    return output(updateLine(result), result);
  },
};

const settingsLogsPath: CliCommand = {
  path: ["settings", "logs", "path"],
  summary: "Print the folder the app writes its logs to",
  async run(ctx, { positionals }) {
    exactArgs(positionals);
    const result = await ctx.services.ui("settings.logsPath", {});
    return output(result.path, result);
  },
};

export const settingsCommands: CliCommand[] = [
  settingsList,
  settingsGet,
  settingsSet,
  settingsReset,
  settingsOpen,
  settingsInstructions,
  settingsInstructionsSet,
  settingsKeysList,
  settingsKeysSet,
  settingsKeysUnbind,
  settingsKeysReset,
  settingsLspStatus,
  settingsUpdateStatus,
  settingsUpdateCheck,
  settingsLogsPath,
];

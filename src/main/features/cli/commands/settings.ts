/**
 * nexus settings list/get/set/reset/open: the app's settings, as the
 * Settings dialog shows and changes them. They are the app's, not a
 * workspace's, so changing one needs no leave; what nexus itself may do is
 * left to the user.
 */

import {
  type InstructionScope,
  workspaceInstructionTarget,
} from "../../../../shared/chat/instructions";
import {
  describeShape,
  formatSettingValue,
  SETTINGS_PAGES,
  settingsPageNamed,
} from "../../../../shared/cli/settings";
import type { CliChange, CliSettingInfo } from "../../../../shared/cli/ui";
import type { ChatAgent } from "../../../../shared/sessions/task-agent";
import { CliUsageError, exactArgs } from "../args";
import { type CliContext, type CliDevice, CliError, mayChange, resolveWorkspace } from "../context";
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
import { chatAgentFlag, checkedInstructions, readInstructionsFile } from "./chat";
import { WORKSPACE_FLAG } from "./flags";

/** The settings, or the one `key` names (none when it names none). */
async function listSettings(ctx: CliContext, key?: string): Promise<CliSettingInfo[]> {
  return (await ctx.services.ui("settings.list", key === undefined ? {} : { key })).settings;
}

/** Its value as the list shows it: why it could not be read, when it could not. */
function shownValue(setting: CliSettingInfo): string {
  if (setting.unavailable) return `unavailable: ${setting.unavailable}`;
  return `${oneLine(formatSettingValue(setting.value), VALUE_WIDTH)}${setting.changed ? " *" : ""}`;
}

/** A list of choices longer than this is left to --json. */
const TAKES_WIDTH = 40;
/** A value longer than this is cut in the list; settings get prints it whole. */
const VALUE_WIDTH = 60;

/** What it takes, as the list shows it. */
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

/** What a change made, as the user would read it. */
function changed(setting: CliSettingInfo) {
  const value = formatSettingValue(setting.value);
  return output(`${setting.key} is ${value === "" ? '""' : value}.`, setting);
}

const settingsSet: CliCommand = {
  path: ["settings", "set"],
  summary: "Change a setting, as the Settings dialog does",
  args: "<key> <value>",
  details:
    "The value is read as the setting takes it (nexus settings list): on or off, a number in\n" +
    "its range, one of its choices, or text; a list (voice.terms) whole, comma-separated. It\n" +
    "takes effect at once and is kept. Whether nexus may change other workspaces, and whether\n" +
    "it works at all, are the user's to set.",
  async run(ctx, { positionals }) {
    const [key, value] = exactArgs(positionals, "key", "value") as [string, string];
    const { setting } = await ctx.services.ui("settings.set", { key, value });
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
    "the user sets: language servers, keybindings, browser permissions.",
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
  if (exact) return exact;
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
  return match;
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
            ? {
                kind: "profile",
                agent: edit.profile.agent,
                name: edit.profile.name,
                id: edit.profile.id,
              }
            : edit.layer === "workspace"
              ? { kind: "workspace", name: workspace.name }
              : edit.layer === "all"
                ? { kind: "all" }
                : { kind: "agent", agent: edit.layer },
        clear: !text,
      },
      body: text,
    };
    if (layer === "workspace") await mayChange(ctx, workspace, change);
    else
      await ctx.services.askUser({
        fromWorkspaceId: ctx.caller.workspaceId,
        fromTabId: ctx.caller.tabId,
        toWorkspaceId: workspace.id,
        change: { ...change, eachTime: true },
      });
    await ctx.services.ui("settings.instructions.set", { scope, text });
    const target = layer === "workspace" ? ` for "${workspace.name}"` : "";
    return output(`${text ? "Updated" : "Cleared"} the ${layer} instruction layer${target}.`, {
      scope,
      ...(layer === "workspace" ? { workspaceName: workspace.name } : {}),
      text,
    });
  },
};

const settingsKeysList: CliCommand = {
  path: ["settings", "keys", "list"],
  summary: "List effective app and editor keybindings",
  async run(ctx, { positionals }) {
    exactArgs(positionals);
    const { bindings } = await ctx.services.ui("settings.keys", {});
    return output(
      table(
        ["AREA", "COMMAND", "KEYS", "WHEN"],
        bindings.map((binding) => [
          binding.area,
          binding.command,
          [binding.primary, binding.chord?.join(" ")].filter(Boolean).join(" / ") || "(unbound)",
          binding.when ?? "",
        ]),
      ),
      { bindings },
      { records: bindings },
    );
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

const settingsUpdateStatus: CliCommand = {
  path: ["settings", "updates", "status"],
  summary: "Show the last app update check and download progress",
  async run(ctx, { positionals }) {
    exactArgs(positionals);
    const result = await ctx.services.ui("settings.updateStatus", {});
    const version =
      result.status &&
      ("version" in result.status
        ? result.status.version
        : "latest" in result.status
          ? result.status.latest
          : undefined);
    return output(
      result.status
        ? [result.status.kind, version].filter(Boolean).join(" ")
        : "No update check yet.",
      result,
    );
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
  settingsLspStatus,
  settingsUpdateStatus,
];

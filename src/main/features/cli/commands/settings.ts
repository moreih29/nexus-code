/**
 * nexus settings list/get/set/reset/open: the app's settings, as the
 * Settings dialog shows and changes them. They are the app's, not a
 * workspace's, so changing one needs no leave; what nexus itself may do is
 * left to the user.
 */
import {
  describeShape,
  formatSettingValue,
  SETTINGS_PAGES,
  settingsPageNamed,
} from "../../../../shared/cli/settings";
import type { CliSettingInfo } from "../../../../shared/cli/ui";
import { CliUsageError, exactArgs } from "../args";
import { type CliContext, CliError } from "../context";
import { table } from "../format";
import { type CliCommand, output } from "../registry";

async function listSettings(ctx: CliContext): Promise<CliSettingInfo[]> {
  return (await ctx.services.ui("settings.list", {})).settings;
}

/** A list of choices longer than this is left to --json. */
const TAKES_WIDTH = 40;

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
    const rows = settings.map((s) => [
      s.key,
      `${formatSettingValue(s.value)}${s.changed ? " *" : ""}`,
      takes(s),
    ]);
    return output(table(["KEY", "VALUE", "TAKES"], rows), settings);
  },
};

const settingsGet: CliCommand = {
  path: ["settings", "get"],
  summary: "Print a setting's value",
  args: "<key>",
  async run(ctx, { positionals }) {
    const [key] = exactArgs(positionals, "key") as [string];
    const settings = await listSettings(ctx);
    const setting = settings.find((s) => s.key.toLowerCase() === key.toLowerCase());
    if (!setting) throw new CliError(`no setting "${key}"; nexus settings list shows them`);
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
    "its range, one of its choices, or text. It takes effect at once and is kept. Whether\n" +
    "nexus may change other workspaces, and whether it works at all, are the user's to set.",
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
    "the user sets: language servers, keybindings, browser permissions, the agent manager.",
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

export const settingsCommands: CliCommand[] = [
  settingsList,
  settingsGet,
  settingsSet,
  settingsReset,
  settingsOpen,
];

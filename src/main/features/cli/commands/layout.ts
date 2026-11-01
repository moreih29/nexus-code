/**
 * nexus layout show/split/resize/even/close and tab move/rename/pin/unpin:
 * arranging a workspace's editor area, its groups of tabs and the splits
 * between them, and naming and pinning tabs.
 *
 * A group is named by its number in `layout show` (1, 2, ...), by its id,
 * by "." for this terminal's group, or by one of its tabs.
 */
import type { CliLayoutNode, CliSplitSide, CliTabInfo } from "../../../../shared/cli/ui";
import type { WorkspaceMeta } from "../../../../shared/types/workspace";
import { CliUsageError, exactArgs } from "../args";
import {
  type CliContext,
  CliError,
  mayChange,
  resolveTab,
  resolveWorkspace,
  shortId,
} from "../context";
import { type CliCommand, output } from "../registry";
import { WORKSPACE_FLAG } from "./flags";
import { resolveAnyTab, workspaceTabs } from "./terminal";

type Split = Extract<CliLayoutNode, { kind: "split" }>;

/** A group, with its number and the splits it sits in, innermost last. */
export interface GroupInfo {
  readonly id: string;
  readonly number: number;
  readonly tabIds: readonly string[];
  readonly shownTabId: string | null;
  readonly ancestors: readonly { readonly split: Split; readonly side: "first" | "second" }[];
}

interface Layout {
  readonly root: CliLayoutNode;
  readonly activeGroupId: string;
  readonly groups: readonly GroupInfo[];
  readonly tabs: readonly CliTabInfo[];
}

/** The groups in reading order: left to right, top to bottom. */
export function groupsOf(root: CliLayoutNode): GroupInfo[] {
  const groups: GroupInfo[] = [];
  const walk = (node: CliLayoutNode, ancestors: GroupInfo["ancestors"]) => {
    if (node.kind === "group") {
      groups.push({
        id: node.id,
        number: groups.length + 1,
        tabIds: node.tabIds,
        shownTabId: node.shownTabId,
        ancestors,
      });
      return;
    }
    walk(node.first, [...ancestors, { split: node, side: "first" }]);
    walk(node.second, [...ancestors, { split: node, side: "second" }]);
  };
  walk(root, []);
  return groups;
}

async function layoutOf(ctx: CliContext, workspace: WorkspaceMeta): Promise<Layout> {
  const { root, activeGroupId } = await ctx.services.ui("layout.get", {
    workspaceId: workspace.id,
  });
  return {
    root,
    activeGroupId,
    groups: groupsOf(root),
    tabs: await workspaceTabs(ctx, workspace.id),
  };
}

function resolveGroup(
  ctx: CliContext,
  workspace: WorkspaceMeta,
  layout: Layout,
  selector: string,
): GroupInfo {
  const { groups } = layout;
  if (selector === ".") {
    const own =
      workspace.id === ctx.caller.workspaceId
        ? layout.tabs.find((t) => t.id === ctx.caller.tabId)
        : undefined;
    const id = own?.groupId ?? layout.activeGroupId;
    return groups.find((g) => g.id === id) ?? (groups[0] as GroupInfo);
  }
  if (/^\d+$/.test(selector)) {
    const group = groups[Number(selector) - 1];
    if (!group) {
      throw new CliError(`${workspace.name} has no group ${selector}; it has ${groups.length}`);
    }
    return group;
  }
  const lower = selector.toLowerCase();
  const byId = groups.filter(
    (g) => g.id === selector || (selector.length >= 4 && g.id.startsWith(lower)),
  );
  if (byId.length === 1) return byId[0] as GroupInfo;
  const tab = resolveTab(ctx, layout.tabs, selector, `group or tab in ${workspace.name}`);
  return groups.find((g) => g.id === tab.groupId) as GroupInfo;
}

const percent = (ratio: number) => `${Math.round(ratio * 100)}%`;

function describeLayout(layout: Layout): string[] {
  const titles = new Map(layout.tabs.map((t) => [t.id, t.title]));
  const lines: string[] = [];
  const numbers = new Map(layout.groups.map((g) => [g.id, g.number]));
  const walk = (node: CliLayoutNode, depth: number) => {
    const pad = "  ".repeat(depth);
    if (node.kind === "group") {
      const tabs = node.tabIds
        .map((id) => `${id === node.shownTabId ? "*" : ""}${titles.get(id) ?? shortId(id)}`)
        .join(", ");
      const active = node.id === layout.activeGroupId ? ", active" : "";
      lines.push(
        `${pad}group ${numbers.get(node.id)} (${shortId(node.id)})${active}: ${tabs || "(empty)"}`,
      );
      return;
    }
    const how =
      node.direction === "columns"
        ? `side by side, ${percent(node.ratio)} | ${percent(1 - node.ratio)}`
        : `one above the other, ${percent(node.ratio)} / ${percent(1 - node.ratio)}`;
    lines.push(`${pad}${how}`);
    walk(node.first, depth + 1);
    walk(node.second, depth + 1);
  };
  walk(layout.root, 0);
  return lines;
}

const layoutShow: CliCommand = {
  path: ["layout", "show"],
  summary: "Show how a workspace's editor area is split into groups of tabs",
  details: 'Groups are numbered as other layout commands take them; "*" marks the tab each shows.',
  flags: { workspace: WORKSPACE_FLAG },
  async run(ctx, { positionals, flags }) {
    exactArgs(positionals);
    const workspace = resolveWorkspace(ctx, flags.workspace as string | undefined);
    const layout = await layoutOf(ctx, workspace);
    return output(describeLayout(layout).join("\n"), {
      workspaceId: workspace.id,
      activeGroupId: layout.activeGroupId,
      root: layout.root,
      groups: layout.groups.map((g) => ({
        number: g.number,
        id: g.id,
        tabIds: g.tabIds,
        shownTabId: g.shownTabId,
      })),
    });
  },
};

const SIDES: Record<string, CliSplitSide> = {
  left: "left",
  right: "right",
  up: "up",
  top: "up",
  above: "up",
  down: "down",
  bottom: "down",
  below: "down",
};

const WHERE: Record<CliSplitSide, string> = {
  left: "left of",
  right: "right of",
  up: "above",
  down: "below",
};

const GROUP_HELP =
  'A group is its number in "nexus layout show", its id, "." for this terminal\'s group,\n' +
  "or one of its tabs. Numbers change as groups come and go; ids do not.";

const layoutSplit: CliCommand = {
  path: ["layout", "split"],
  summary: "Move a tab into a new group beside its group, or beside another",
  args: "<tab> <left|right|up|down>",
  details: `Splits the tab's own group unless --of names another.\n${GROUP_HELP}`,
  flags: {
    of: { type: "string", value: "GROUP", description: "Split this group instead" },
    workspace: WORKSPACE_FLAG,
  },
  async run(ctx, { positionals, flags }) {
    const [selector, sideWord] = exactArgs(positionals, "tab", "side") as [string, string];
    const side = SIDES[sideWord.toLowerCase()];
    if (!side) throw new CliUsageError(`the side is left, right, up or down, not "${sideWord}"`);
    const workspace = resolveWorkspace(ctx, flags.workspace as string | undefined);
    const layout = await layoutOf(ctx, workspace);
    const tab = resolveTab(ctx, layout.tabs, selector, `tab in ${workspace.name}`);
    const of =
      flags.of === undefined
        ? (layout.groups.find((g) => g.id === tab.groupId) as GroupInfo)
        : resolveGroup(ctx, workspace, layout, flags.of as string);
    await mayChange(ctx, workspace, { kind: "layout", detail: tab.title });
    const { groupId } = await ctx.services.ui("layout.split", {
      workspaceId: workspace.id,
      tabId: tab.id,
      groupId: of.id,
      side,
    });
    return output(`Moved ${tab.title} into a new group ${WHERE[side]} group ${of.number}.`, {
      workspaceId: workspace.id,
      tabId: tab.id,
      groupId,
    });
  },
};

/** Reads "30%" or "30" as 0.3. */
function share(text: string): number {
  const match = /^(\d+(?:\.\d+)?)%?$/.exec(text.trim());
  const value = match ? Number(match[1]) : Number.NaN;
  if (!(value >= 5 && value <= 95)) {
    throw new CliUsageError(`the size is a share from 5% to 95%, such as 30%, not "${text}"`);
  }
  return value / 100;
}

const layoutResize: CliCommand = {
  path: ["layout", "resize"],
  summary: "Set the share of the space a group takes beside its neighbor",
  args: "<group> <percent>",
  details:
    "Sets the group's share of the split it is in, the innermost one by default; --width\n" +
    `or --height picks the innermost split side by side, or one above the other.\n${GROUP_HELP}`,
  flags: {
    width: { type: "boolean", description: "The split it shares the width in" },
    height: { type: "boolean", description: "The split it shares the height in" },
    workspace: WORKSPACE_FLAG,
  },
  async run(ctx, { positionals, flags }) {
    const [selector, size] = exactArgs(positionals, "group", "percent") as [string, string];
    const ratio = share(size);
    if (flags.width === true && flags.height === true) {
      throw new CliUsageError("give --width or --height, not both");
    }
    const direction = flags.width === true ? "columns" : flags.height === true ? "rows" : undefined;
    const workspace = resolveWorkspace(ctx, flags.workspace as string | undefined);
    const layout = await layoutOf(ctx, workspace);
    const group = resolveGroup(ctx, workspace, layout, selector);
    const place = [...group.ancestors]
      .reverse()
      .find((a) => direction === undefined || a.split.direction === direction);
    if (!place) {
      const where =
        direction === "columns"
          ? "side by side with"
          : direction === "rows"
            ? "above or below"
            : "beside";
      throw new CliError(`group ${group.number} is not ${where} another group`);
    }
    await mayChange(ctx, workspace, { kind: "layout", detail: `group ${group.number}` });
    await ctx.services.ui("layout.ratios", {
      workspaceId: workspace.id,
      ratios: [{ splitId: place.split.id, ratio: place.side === "first" ? ratio : 1 - ratio }],
    });
    const dimension = place.split.direction === "columns" ? "width" : "height";
    return output(
      `Group ${group.number} now takes ${percent(ratio)} of the ${dimension} it shares.`,
      {
        workspaceId: workspace.id,
        groupId: group.id,
        splitId: place.split.id,
        share: ratio,
      },
    );
  },
};

/** How many groups `node` puts in a row along `direction`, for even shares. */
function across(node: CliLayoutNode, direction: Split["direction"]): number {
  if (node.kind === "group" || node.direction !== direction) return 1;
  return across(node.first, direction) + across(node.second, direction);
}

/** The ratios that give every group in a row the same share. */
export function evenRatios(root: CliLayoutNode): { splitId: string; ratio: number }[] {
  const ratios: { splitId: string; ratio: number }[] = [];
  const walk = (node: CliLayoutNode) => {
    if (node.kind === "group") return;
    const first = across(node.first, node.direction);
    ratios.push({ splitId: node.id, ratio: first / (first + across(node.second, node.direction)) });
    walk(node.first);
    walk(node.second);
  };
  walk(root);
  return ratios;
}

const layoutEven: CliCommand = {
  path: ["layout", "even"],
  summary: "Give every group the same share of its row or column",
  flags: { workspace: WORKSPACE_FLAG },
  async run(ctx, { positionals, flags }) {
    exactArgs(positionals);
    const workspace = resolveWorkspace(ctx, flags.workspace as string | undefined);
    const layout = await layoutOf(ctx, workspace);
    const ratios = evenRatios(layout.root);
    if (ratios.length > 0) {
      await mayChange(ctx, workspace, { kind: "layout", detail: "even" });
      await ctx.services.ui("layout.ratios", { workspaceId: workspace.id, ratios });
    }
    return output(
      ratios.length > 0
        ? `Evened out ${layout.groups.length} groups.`
        : `${workspace.name} has one group.`,
      { workspaceId: workspace.id, ratios },
    );
  },
};

const layoutClose: CliCommand = {
  path: ["layout", "close"],
  summary: "Close a group and its tabs",
  args: "<group>",
  details:
    "Refused for a group with unsaved changes or this terminal, and, unless --force, one\n" +
    `with a terminal running a program.\n${GROUP_HELP}`,
  flags: {
    force: { type: "boolean", description: "Close terminals even while a program runs in them" },
    workspace: WORKSPACE_FLAG,
  },
  async run(ctx, { positionals, flags }) {
    const [selector] = exactArgs(positionals, "group") as [string];
    const workspace = resolveWorkspace(ctx, flags.workspace as string | undefined);
    const layout = await layoutOf(ctx, workspace);
    const group = resolveGroup(ctx, workspace, layout, selector);
    if (group.tabIds.includes(ctx.caller.tabId)) {
      throw new CliError(`group ${group.number} holds this terminal; nexus does not close it`);
    }
    await mayChange(ctx, workspace, { kind: "groupClose", detail: `${group.number}` });
    const { closed } = await ctx.services.ui("group.close", {
      workspaceId: workspace.id,
      groupId: group.id,
      force: flags.force === true,
    });
    return output(`Closed group ${group.number} and its ${closed} tab${closed === 1 ? "" : "s"}.`, {
      workspaceId: workspace.id,
      groupId: group.id,
      closed,
    });
  },
};

const tabMove: CliCommand = {
  path: ["tab", "move"],
  summary: "Move a tab into another group, or to another place in its own",
  args: "<tab> <group>",
  details: `--at puts it at that place in the group's tab bar, counting from 1.\n${GROUP_HELP}`,
  flags: {
    at: { type: "number", value: "N", description: "Put it at place N of the group's tabs" },
    workspace: WORKSPACE_FLAG,
  },
  async run(ctx, { positionals, flags }) {
    const [tabSelector, groupSelector] = exactArgs(positionals, "tab", "group") as [string, string];
    const at = flags.at as number | undefined;
    if (at !== undefined && at < 1) throw new CliUsageError("--at counts from 1");
    const workspace = resolveWorkspace(ctx, flags.workspace as string | undefined);
    const layout = await layoutOf(ctx, workspace);
    const tab = resolveTab(ctx, layout.tabs, tabSelector, `tab in ${workspace.name}`);
    const group = resolveGroup(ctx, workspace, layout, groupSelector);
    if (group.id === tab.groupId && at === undefined) {
      throw new CliError(
        `${tab.title} is already in group ${group.number}; --at moves it within it`,
      );
    }
    await mayChange(ctx, workspace, { kind: "layout", detail: tab.title });
    await ctx.services.ui("tab.move", {
      workspaceId: workspace.id,
      tabId: tab.id,
      groupId: group.id,
      // An insertion slot: before the tab now at that place. Moving right within
      // its own group, the tab's own slot is freed first, so one further.
      ...(at === undefined
        ? {}
        : {
            index: group.id === tab.groupId && group.tabIds.indexOf(tab.id) < at - 1 ? at : at - 1,
          }),
    });
    return output(
      `Moved ${tab.title} to group ${group.number}${at === undefined ? "" : `, place ${at}`}.`,
      {
        workspaceId: workspace.id,
        tabId: tab.id,
        groupId: group.id,
      },
    );
  },
};

const tabRename: CliCommand = {
  path: ["tab", "rename"],
  summary: "Name a tab",
  args: "<tab> [<title...>]",
  details: "--reset gives it back the name the app chooses, such as a terminal's program.",
  flags: {
    reset: { type: "boolean", description: "Drop the name given to it" },
    workspace: WORKSPACE_FLAG,
  },
  async run(ctx, { positionals, flags }) {
    const [selector, ...words] = positionals;
    if (selector === undefined) throw new CliUsageError("missing <tab>");
    const title = words.join(" ").trim();
    if (flags.reset === true ? title !== "" : title === "") {
      throw new CliUsageError("give a title, or --reset");
    }
    const workspace = resolveWorkspace(ctx, flags.workspace as string | undefined);
    const tab = await resolveAnyTab(ctx, workspace, selector);
    await mayChange(ctx, workspace, { kind: "tabRename", detail: tab.title });
    const renamed = await ctx.services.ui("tab.rename", {
      workspaceId: workspace.id,
      tabId: tab.id,
      title,
    });
    return output(`${shortId(tab.id)} is now "${renamed.title}".`, {
      workspaceId: workspace.id,
      tabId: tab.id,
      title: renamed.title,
    });
  },
};

function pinCommand(pinned: boolean): CliCommand {
  return {
    path: ["tab", pinned ? "pin" : "unpin"],
    summary: pinned ? "Pin a tab to the front of its group" : "Unpin a tab",
    args: "<tab>",
    flags: { workspace: WORKSPACE_FLAG },
    async run(ctx, { positionals, flags }) {
      const [selector] = exactArgs(positionals, "tab") as [string];
      const workspace = resolveWorkspace(ctx, flags.workspace as string | undefined);
      const tab = await resolveAnyTab(ctx, workspace, selector);
      await mayChange(ctx, workspace, { kind: "tabPin", detail: tab.title });
      await ctx.services.ui("tab.pin", { workspaceId: workspace.id, tabId: tab.id, pinned });
      return output(`${pinned ? "Pinned" : "Unpinned"} ${tab.title}.`, {
        workspaceId: workspace.id,
        tabId: tab.id,
        pinned,
      });
    },
  };
}

export const tabArrangeCommands: CliCommand[] = [
  tabMove,
  tabRename,
  pinCommand(true),
  pinCommand(false),
];

export const layoutCommands: CliCommand[] = [
  layoutShow,
  layoutSplit,
  layoutResize,
  layoutEven,
  layoutClose,
];

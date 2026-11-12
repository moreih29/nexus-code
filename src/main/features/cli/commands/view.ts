/**
 * nexus view: which of its two views the window shows, the agent view or
 * the workspaces, and the agent view's panels: the sessions (Claude and
 * Codex tabs, terminals) of any workspace each shows, split as a
 * workspace's editor area is (nexus layout).
 *
 * A panel is named by its number in `view layout` (1, 2, ...), by its id,
 * by "." for the panel holding this terminal (else the active one), or by
 * a session it holds. A session is named as a tab is, among those the
 * agent view holds first, then among the tabs of this terminal's
 * workspace, or of --workspace.
 */
import type {
  CliAgentGrouping,
  CliAgentView,
  CliLayoutNode,
  CliSplitSide,
  CliView,
  CliViewAgent,
} from "../../../../shared/cli/ui";
import { CliUsageError, exactArgs } from "../args";
import { type CliContext, CliError, pick, resolveWorkspace, shortId } from "../context";
import { type CliCommand, output } from "../registry";
import { WORKSPACE_FLAG } from "./flags";
import { evenRatios, type GroupInfo, groupsOf, SIDES, share } from "./layout";
import { resolveAnyTab } from "./terminal";

/** The tabs a panel of the agent view can show. */
const VIEW_TAB_TYPES = new Set(["claude", "codex", "terminal"]);

const VIEWS: Record<string, CliView> = {
  agents: "agents",
  agent: "agents",
  workspaces: "workspaces",
  workspace: "workspaces",
};

const GROUPINGS: Record<string, CliAgentGrouping> = {
  status: "status",
  state: "status",
  workspace: "workspace",
  workspaces: "workspace",
};

/** What a word names in `table`, by its own keys only: "constructor" names nothing. */
function ownValue<T>(table: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

const GROUPING_NAME: Record<CliAgentGrouping, string> = {
  status: "by status (needs you, running, new result, idle, ended)",
  workspace: "by workspace",
};

const PANEL_HELP =
  'A panel is its number in "nexus view layout", its id, "." for the panel holding this\n' +
  "terminal (else the active one), or a session it holds.";

const SESSION_HELP =
  "A session is a Claude or Codex tab or a terminal, named as a tab is: among those the\n" +
  "agent view holds, then among the tabs of this terminal's workspace (or --workspace).";

interface View extends CliAgentView {
  readonly panels: readonly GroupInfo[];
}

async function viewOf(ctx: CliContext): Promise<View> {
  const view = await ctx.services.ui("agentView.get", {});
  return { ...view, panels: groupsOf(view.root) };
}

/** A session as the agent view knows it: by its workspace and tab. */
interface Session {
  readonly workspaceId: string;
  readonly tabId: string;
  readonly title: string;
  readonly type: string;
}

const keyOf = (s: { workspaceId: string; tabId: string }) => `${s.workspaceId}:${s.tabId}`;

/** The items `selector` names, by the rules of `pick`, without choosing among several. */
function named<T>(
  items: readonly T[],
  selector: string,
  id: (item: T) => string,
  name: (item: T) => string,
): T[] {
  const exact = items.filter((item) => id(item) === selector);
  if (exact.length > 0) return exact;
  const lower = selector.toLowerCase();
  const byPrefix = selector.length >= 4 ? items.filter((item) => id(item).startsWith(lower)) : [];
  if (byPrefix.length > 0) return byPrefix;
  return items.filter((item) => name(item).toLowerCase() === lower);
}

/**
 * The session a selector names: among those the agent view holds (of the
 * workspace --workspace names, if given), then among the tabs of the
 * workspace. "." is this terminal.
 */
async function resolveSession(
  ctx: CliContext,
  view: View,
  selector: string,
  workspaceFlag: string | undefined,
): Promise<Session> {
  const workspace = workspaceFlag === undefined ? undefined : resolveWorkspace(ctx, workspaceFlag);
  if (selector === ".") {
    const own = resolveWorkspace(ctx, undefined);
    return sessionOf(await resolveAnyTab(ctx, own, "."), own.id);
  }
  const held = view.agents.filter((a) => !workspace || a.workspaceId === workspace.id);
  const found = named(
    held,
    selector,
    (a) => a.tabId,
    (a) => a.title,
  );
  if (found.length === 1) return found[0] as CliViewAgent;
  if (found.length > 1) {
    return pick(
      found,
      selector,
      (a) => a.tabId,
      (a) => a.title,
      "session in the agent view",
    );
  }
  const target = workspace ?? resolveWorkspace(ctx, undefined);
  return sessionOf(await resolveAnyTab(ctx, target, selector), target.id);
}

function sessionOf(tab: { id: string; title: string; type: string }, workspaceId: string): Session {
  if (!VIEW_TAB_TYPES.has(tab.type)) {
    throw new CliError(
      `the agent view shows Claude and Codex tabs and terminals, and ${tab.title} is none of them`,
    );
  }
  return { workspaceId, tabId: tab.id, title: tab.title, type: tab.type };
}

function resolvePanel(ctx: CliContext, view: View, selector: string): GroupInfo {
  const { panels } = view;
  if (selector === ".") {
    const own = keyOf({ workspaceId: ctx.caller.workspaceId, tabId: ctx.caller.tabId });
    return (
      panels.find((p) => p.tabIds.includes(own)) ??
      panels.find((p) => p.id === view.activePanelId) ??
      (panels[0] as GroupInfo)
    );
  }
  if (/^\d+$/.test(selector)) {
    const panel = panels[Number(selector) - 1];
    if (!panel) {
      throw new CliError(`the agent view has no panel ${selector}; it has ${panels.length}`);
    }
    return panel;
  }
  const lower = selector.toLowerCase();
  const byId = panels.filter(
    (p) => p.id === selector || (selector.length >= 4 && p.id.startsWith(lower)),
  );
  if (byId.length === 1) return byId[0] as GroupInfo;
  const agent = pick(
    view.agents,
    selector,
    (a) => a.tabId,
    (a) => a.title,
    "panel or session in the agent view",
  );
  return panels.find((p) => p.tabIds.includes(agent.key)) as GroupInfo;
}

const percent = (ratio: number) => `${Math.round(ratio * 100)}%`;

const VIEW_NAME: Record<CliView, string> = {
  agents: "the agent view",
  workspaces: "the workspaces",
};

/** The panels drawn as layout show draws groups, each session with its workspace. */
function describeView(ctx: CliContext, view: View): string[] {
  const workspaces = new Map(ctx.services.listWorkspaces().map((w) => [w.id, w.name]));
  const agents = new Map(view.agents.map((a) => [a.key, a]));
  const numbers = new Map(view.panels.map((p) => [p.id, p.number]));
  const lines = [
    `shown: ${VIEW_NAME[view.view]}${view.view === "agents" ? "" : " (the agent view is hidden)"}`,
  ];
  const walk = (node: CliLayoutNode, depth: number) => {
    const pad = "  ".repeat(depth);
    if (node.kind === "group") {
      const sessions = node.tabIds
        .map((key) => {
          const agent = agents.get(key);
          const title = agent ? agent.title : shortId(key.split(":")[1] ?? key);
          const where = agent
            ? ` [${workspaces.get(agent.workspaceId) ?? shortId(agent.workspaceId)}]`
            : "";
          return `${key === node.shownTabId ? "*" : ""}${title}${where}`;
        })
        .join(", ");
      const active = node.id === view.activePanelId ? ", active" : "";
      lines.push(
        `${pad}panel ${numbers.get(node.id)} (${shortId(node.id)})${active}: ${sessions || "(empty)"}`,
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
  walk(view.root, 0);
  return lines;
}

function viewJson(view: View) {
  return {
    view: view.view,
    activePanelId: view.activePanelId,
    root: view.root,
    panels: view.panels.map((p) => ({
      number: p.number,
      id: p.id,
      sessions: p.tabIds.map((key) => {
        const agent = view.agents.find((a) => a.key === key);
        return agent
          ? { workspaceId: agent.workspaceId, tabId: agent.tabId, title: agent.title }
          : { key };
      }),
      shownTabId: p.shownTabId?.split(":")[1] ?? null,
    })),
  };
}

const viewShow: CliCommand = {
  path: ["view"],
  summary: "Show which view the window shows, or switch to the agent view or the workspaces",
  args: "[agents|workspaces]",
  details:
    "With no argument, tells the view shown. With one, shows that view, as the title bar's\n" +
    "toggle does; the keyboard goes to what is in front there.",
  async run(ctx, { positionals }) {
    const [word, ...rest] = positionals;
    if (rest.length > 0) throw new CliUsageError("give agents or workspaces");
    if (word === undefined) {
      const view = await viewOf(ctx);
      return output(`The window shows ${VIEW_NAME[view.view]}.`, { view: view.view });
    }
    const target = ownValue(VIEWS, word.toLowerCase());
    if (!target) throw new CliUsageError(`the view is agents or workspaces, not "${word}"`);
    await ctx.services.ui("agentView.show", { view: target });
    return output(`Showing ${VIEW_NAME[target]}.`, { view: target });
  },
};

const viewLayout: CliCommand = {
  path: ["view", "layout"],
  summary: "Show the agent view's panels and the sessions each holds",
  details:
    'Panels are numbered as other view commands take them; "*" marks the session each\n' +
    "shows, and each session's workspace follows it.",
  async run(ctx, { positionals }) {
    exactArgs(positionals);
    const view = await viewOf(ctx);
    return output(describeView(ctx, view).join("\n"), viewJson(view));
  },
};

const viewOpen: CliCommand = {
  path: ["view", "open"],
  summary: "Show a session in the agent view, and the agent view",
  args: "<session>",
  details:
    "Brings it to the front of the panel holding it, else adds it to --panel or the active\n" +
    `panel, which becomes the active one.\n${SESSION_HELP}\n${PANEL_HELP}`,
  flags: {
    panel: { type: "string", value: "PANEL", description: "Add it to this panel" },
    workspace: WORKSPACE_FLAG,
  },
  async run(ctx, { positionals, flags }) {
    const [selector] = exactArgs(positionals, "session") as [string];
    const view = await viewOf(ctx);
    const session = await resolveSession(
      ctx,
      view,
      selector,
      flags.workspace as string | undefined,
    );
    const panel =
      flags.panel === undefined ? undefined : resolvePanel(ctx, view, flags.panel as string);
    const { panelId } = await ctx.services.ui("agentView.place", {
      workspaceId: session.workspaceId,
      tabId: session.tabId,
      ...(panel ? { panelId: panel.id } : {}),
      show: true,
    });
    return output(`Showing ${session.title} in the agent view.`, {
      workspaceId: session.workspaceId,
      tabId: session.tabId,
      panelId,
    });
  },
};

const WHERE: Record<CliSplitSide, string> = {
  left: "left of",
  right: "right of",
  up: "above",
  down: "below",
};

const viewSplit: CliCommand = {
  path: ["view", "split"],
  summary: "Move a session into a new panel beside its panel, or beside another",
  args: "<session> <left|right|up|down>",
  details:
    "Splits the panel holding the session, or the active one if none does, unless --of\n" +
    "names another. The active panel stays as it was.\n" +
    `${SESSION_HELP}\n${PANEL_HELP}`,
  flags: {
    of: { type: "string", value: "PANEL", description: "Split this panel instead" },
    workspace: WORKSPACE_FLAG,
  },
  async run(ctx, { positionals, flags }) {
    const [selector, sideWord] = exactArgs(positionals, "session", "side") as [string, string];
    const side = SIDES[sideWord.toLowerCase()];
    if (!side) throw new CliUsageError(`the side is left, right, up or down, not "${sideWord}"`);
    const view = await viewOf(ctx);
    const session = await resolveSession(
      ctx,
      view,
      selector,
      flags.workspace as string | undefined,
    );
    const of =
      flags.of !== undefined
        ? resolvePanel(ctx, view, flags.of as string)
        : (view.panels.find((p) => p.tabIds.includes(keyOf(session))) ??
          (view.panels.find((p) => p.id === view.activePanelId) as GroupInfo));
    const { panelId } = await ctx.services.ui("agentView.place", {
      workspaceId: session.workspaceId,
      tabId: session.tabId,
      panelId: of.id,
      side,
      show: false,
    });
    return output(`Moved ${session.title} into a new panel ${WHERE[side]} panel ${of.number}.`, {
      workspaceId: session.workspaceId,
      tabId: session.tabId,
      panelId,
    });
  },
};

const viewMove: CliCommand = {
  path: ["view", "move"],
  summary: "Move a session into another panel, or to another place in its own",
  args: "<session> <panel>",
  details:
    "--at puts it at that place among the panel's sessions, counting from 1. The active\n" +
    `panel stays as it was.\n${SESSION_HELP}\n${PANEL_HELP}`,
  flags: {
    at: { type: "number", value: "N", description: "Put it at place N of the panel's sessions" },
    workspace: WORKSPACE_FLAG,
  },
  async run(ctx, { positionals, flags }) {
    const [selector, panelSelector] = exactArgs(positionals, "session", "panel") as [
      string,
      string,
    ];
    const at = flags.at as number | undefined;
    if (at !== undefined && at < 1) throw new CliUsageError("--at counts from 1");
    const view = await viewOf(ctx);
    const session = await resolveSession(
      ctx,
      view,
      selector,
      flags.workspace as string | undefined,
    );
    const panel = resolvePanel(ctx, view, panelSelector);
    const key = keyOf(session);
    if (panel.tabIds.includes(key) && at === undefined) {
      throw new CliError(
        `${session.title} is already in panel ${panel.number}; --at moves it within it`,
      );
    }
    await ctx.services.ui("agentView.place", {
      workspaceId: session.workspaceId,
      tabId: session.tabId,
      panelId: panel.id,
      // Its place among the panel's other sessions: the view takes it out
      // of its own panel before putting it back.
      ...(at === undefined ? {} : { index: at - 1 }),
      show: false,
    });
    return output(
      `Moved ${session.title} to panel ${panel.number}${at === undefined ? "" : `, place ${at}`}.`,
      { workspaceId: session.workspaceId, tabId: session.tabId, panelId: panel.id },
    );
  },
};

const viewRemove: CliCommand = {
  path: ["view", "remove"],
  summary: "Take a session out of the agent view; its tab stays in its workspace",
  args: "<session>",
  details: `A panel left empty closes, unless it is the only one.\n${SESSION_HELP}`,
  flags: { workspace: WORKSPACE_FLAG },
  async run(ctx, { positionals, flags }) {
    const [selector] = exactArgs(positionals, "session") as [string];
    const view = await viewOf(ctx);
    const session = await resolveSession(
      ctx,
      view,
      selector,
      flags.workspace as string | undefined,
    );
    if (!view.agents.some((a) => a.key === keyOf(session))) {
      throw new CliError(`${session.title} is not in the agent view`);
    }
    await ctx.services.ui("agentView.remove", {
      workspaceId: session.workspaceId,
      tabId: session.tabId,
    });
    return output(`Took ${session.title} out of the agent view.`, {
      workspaceId: session.workspaceId,
      tabId: session.tabId,
    });
  },
};

const viewClose: CliCommand = {
  path: ["view", "close"],
  summary: "Close a panel of the agent view; its sessions' tabs stay in their workspaces",
  args: "<panel>",
  details: `The only panel left is emptied instead.\n${PANEL_HELP}`,
  async run(ctx, { positionals }) {
    const [selector] = exactArgs(positionals, "panel") as [string];
    const view = await viewOf(ctx);
    const panel = resolvePanel(ctx, view, selector);
    const { removed } = await ctx.services.ui("agentView.close", { panelId: panel.id });
    return output(
      `Closed panel ${panel.number}; ${removed} session${removed === 1 ? "" : "s"} left the agent view.`,
      { panelId: panel.id, removed },
    );
  },
};

const viewResize: CliCommand = {
  path: ["view", "resize"],
  summary: "Set the share of the space a panel takes beside its neighbor",
  args: "<panel> <percent>",
  details:
    "Sets the panel's share of the split it is in, the innermost one by default; --width\n" +
    `or --height picks the innermost split side by side, or one above the other.\n${PANEL_HELP}`,
  flags: {
    width: { type: "boolean", description: "The split it shares the width in" },
    height: { type: "boolean", description: "The split it shares the height in" },
  },
  async run(ctx, { positionals, flags }) {
    const [selector, size] = exactArgs(positionals, "panel", "percent") as [string, string];
    const ratio = share(size);
    if (flags.width === true && flags.height === true) {
      throw new CliUsageError("give --width or --height, not both");
    }
    const direction = flags.width === true ? "columns" : flags.height === true ? "rows" : undefined;
    const view = await viewOf(ctx);
    const panel = resolvePanel(ctx, view, selector);
    const place = [...panel.ancestors]
      .reverse()
      .find((a) => direction === undefined || a.split.direction === direction);
    if (!place) {
      const where =
        direction === "columns"
          ? "side by side with"
          : direction === "rows"
            ? "above or below"
            : "beside";
      throw new CliError(`panel ${panel.number} is not ${where} another panel`);
    }
    await ctx.services.ui("agentView.ratios", {
      ratios: [{ splitId: place.split.id, ratio: place.side === "first" ? ratio : 1 - ratio }],
    });
    const dimension = place.split.direction === "columns" ? "width" : "height";
    return output(
      `Panel ${panel.number} now takes ${percent(ratio)} of the ${dimension} it shares.`,
      { panelId: panel.id, splitId: place.split.id, share: ratio },
    );
  },
};

const viewEven: CliCommand = {
  path: ["view", "even"],
  summary: "Give every panel of the agent view the same share of its row or column",
  async run(ctx, { positionals }) {
    exactArgs(positionals);
    const view = await viewOf(ctx);
    const ratios = evenRatios(view.root);
    if (ratios.length > 0) await ctx.services.ui("agentView.ratios", { ratios });
    return output(
      ratios.length > 0
        ? `Evened out ${view.panels.length} panels.`
        : "The agent view has one panel.",
      { ratios },
    );
  },
};

const viewFocus: CliCommand = {
  path: ["view", "focus"],
  summary: "Make a panel the active one, with the keyboard in it while the agent view shows",
  args: "<panel>",
  details: PANEL_HELP,
  async run(ctx, { positionals }) {
    const [selector] = exactArgs(positionals, "panel") as [string];
    const view = await viewOf(ctx);
    const panel = resolvePanel(ctx, view, selector);
    await ctx.services.ui("agentView.focus", { panelId: panel.id });
    return output(`Panel ${panel.number} is the active one.`, { panelId: panel.id });
  },
};

const viewGroup: CliCommand = {
  path: ["view", "group"],
  summary: "Show how the agent view's list groups its agents, or group them by status or workspace",
  args: "[status|workspace]",
  details:
    "With no argument, tells the grouping. With one, groups the list that way, as the\n" +
    "switch above it does; the app keeps it across restarts.",
  async run(ctx, { positionals }) {
    const [word, ...rest] = positionals;
    if (rest.length > 0) throw new CliUsageError("give status or workspace");
    if (word === undefined) {
      const view = await viewOf(ctx);
      return output(`The agent view lists its agents ${GROUPING_NAME[view.grouping]}.`, {
        grouping: view.grouping,
      });
    }
    const grouping = ownValue(GROUPINGS, word.toLowerCase());
    if (!grouping) throw new CliUsageError(`the grouping is status or workspace, not "${word}"`);
    await ctx.services.ui("agentView.group", { grouping });
    return output(`The agent view lists its agents ${GROUPING_NAME[grouping]}.`, { grouping });
  },
};

export const viewCommands: CliCommand[] = [
  viewShow,
  viewLayout,
  viewOpen,
  viewSplit,
  viewMove,
  viewRemove,
  viewClose,
  viewResize,
  viewEven,
  viewFocus,
  viewGroup,
];

import type { RpcParams, RpcResult } from "../../../../../packages/remote-protocol/src";
import type {
  CliAgentGrouping,
  CliAgentView,
  CliLayoutNode,
  CliSplitSide,
  CliView,
  CliViewAgent,
  CliViewHeldTab,
} from "../../../../shared/cli/ui";
import { CliUsageError, exactArgs } from "../args";
import {
  type CliContext,
  type CliDevice,
  CliError,
  mayChange,
  pick,
  resolveWorkspace,
  shortId,
} from "../context";
import { workspaceFile } from "../paths";
import { type CliCommand, output } from "../registry";
import {
  askPeerCli,
  changePeerCli,
  DEVICE_FLAG,
  deviceFlag,
  deviceRef,
  peerSessions,
  pickPeerWorkspace,
  requirePeerCli,
  resolveDevice,
  resolvePeerTab,
} from "../remote";
import { WORKSPACE_FLAG } from "./flags";
import { evenRatios, type GroupInfo, groupsOf, SIDES, share } from "./layout";
import { resolveAnyTab } from "./terminal";

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
  "agent view holds, then among the tabs of this terminal's workspace (or --workspace).\n" +
  "Use --key instead of a session to name a held tab by its full key from view layout --json.";

const KEY_FLAG = {
  type: "string",
  value: "KEY",
  description: "The full key of a tab held in the agent view",
} as const;

interface View extends CliAgentView {
  readonly panels: readonly GroupInfo[];
  readonly device?: CliDevice;
}

async function viewOf(ctx: CliContext, flags: Record<string, unknown> = {}): Promise<View> {
  const device = await resolveDevice(ctx, deviceFlag(flags));
  const view = device
    ? await askPeerCli(ctx, device, "agentView.get", {})
    : await ctx.services.ui("agentView.get", {});
  return { ...view, panels: groupsOf(view.root), ...(device ? { device } : {}) };
}

async function writeView(
  ctx: CliContext,
  flags: Record<string, unknown>,
  device: CliDevice | null | undefined,
  change: RpcParams<"agentView.change">["change"],
  workspaceId?: string,
): Promise<RpcResult<"agentView.change">> {
  if (device) {
    requirePeerCli(ctx, device);
    const selector = typeof flags.workspace === "string" ? flags.workspace : undefined;
    let target = workspaceId;
    if (!target || selector !== undefined) {
      const { workspaces } = await peerSessions(ctx, device, ctx.signal);
      target =
        selector !== undefined
          ? pickPeerWorkspace(device, workspaces, selector).id
          : workspaces[0]?.id;
    }
    if (!target) throw new CliError(`no workspace on "${device.name}"`);
    return changePeerCli(ctx, device, "agentView.change", { workspaceId: target, change });
  }
  switch (change.op) {
    case "show":
      return ctx.services.ui("agentView.show", { view: change.view });
    case "group":
      return ctx.services.ui("agentView.group", { grouping: change.grouping });
    case "place": {
      const { op: _, tab, ...placement } = change;
      return ctx.services.ui("agentView.place", { ...tab, ...placement });
    }
    case "remove":
      return ctx.services.ui("agentView.remove", change.tab);
    case "openFile":
      throw new CliError("use a workspace path to open a file");
    case "close":
      return ctx.services.ui("agentView.close", { panelId: change.panelId });
    case "focus":
      return ctx.services.ui("agentView.focus", { panelId: change.panelId });
    case "ratios":
      return ctx.services.ui("agentView.ratios", { ratios: change.ratios });
  }
}

interface Session {
  readonly workspaceId: string;
  readonly tabId: string;
  readonly title: string;
  readonly type: string;
}

const keyOf = (s: { workspaceId: string; tabId: string }) => `${s.workspaceId}:${s.tabId}`;

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

async function resolveSession(
  ctx: CliContext,
  view: View,
  selector: string,
  workspaceFlag: string | undefined,
): Promise<Session> {
  if (view.device) {
    const session = await resolvePeerTab(ctx, view.device, workspaceFlag, selector);
    return {
      workspaceId: session.workspace.id,
      tabId: session.session.tabId,
      title: session.session.title,
      type: session.session.kind,
    };
  }
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

function tabArgs(
  positionals: readonly string[],
  flags: Record<string, unknown>,
  ...rest: string[]
) {
  if (typeof flags.key === "string") {
    if (flags.workspace !== undefined && !flags.device)
      throw new CliUsageError("--key already names the workspace");
    return [flags.key, ...exactArgs(positionals, ...rest)] as [string, ...string[]];
  }
  return exactArgs(positionals, "session", ...rest) as [string, ...string[]];
}

async function viewTarget(
  ctx: CliContext,
  view: View,
  selector: string,
  flags: Record<string, unknown>,
) {
  if (flags.key !== undefined) {
    const tab = [...view.agents, ...view.held].find((tab) => tab.key === selector);
    if (!tab) throw new CliError("no held tab with that key; see nexus view layout --json");
    return {
      key: tab.key,
      title: tab.title,
      ref: { key: tab.key },
      json: { key: tab.key, workspaceId: tab.workspaceId },
    };
  }
  const { workspaceId, tabId, title } = await resolveSession(
    ctx,
    view,
    selector,
    flags.workspace as string | undefined,
  );
  return {
    key: keyOf({ workspaceId, tabId }),
    title,
    ref: { workspaceId, tabId },
    json: { workspaceId, tabId },
  };
}

function resolvePanel(ctx: CliContext, view: View, selector: string): GroupInfo {
  const { panels } = view;
  if (selector === ".") {
    const own = view.device
      ? ""
      : keyOf({ workspaceId: ctx.caller.workspaceId, tabId: ctx.caller.tabId });
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

type ViewTabs = ReadonlyMap<string, CliViewAgent | CliViewHeldTab>;

function describeView(ctx: CliContext, view: View, tabs: ViewTabs): string[] {
  const workspaces = new Map(ctx.services.listWorkspaces().map((w) => [w.id, w.name]));
  const numbers = new Map(view.panels.map((p) => [p.id, p.number]));
  const lines = [
    `shown: ${VIEW_NAME[view.view]}${view.view === "agents" ? "" : " (the agent view is hidden)"}`,
  ];
  const walk = (node: CliLayoutNode, depth: number) => {
    const pad = "  ".repeat(depth);
    if (node.kind === "group") {
      const labels = node.tabIds
        .map((key) => {
          const tab = tabs.get(key);
          const selected = key === node.shownTabId ? "*" : "";
          if (!tab) return `${selected}${shortId(key.split(":")[1] ?? key)}`;
          const source =
            "device" in tab
              ? tab.device
              : (workspaces.get(tab.workspaceId) ?? shortId(tab.workspaceId));
          return `${selected}${tab.title} [${source}]`;
        })
        .join(", ");
      const active = node.id === view.activePanelId ? ", active" : "";
      lines.push(
        `${pad}panel ${numbers.get(node.id)} (${shortId(node.id)})${active}: ${labels || "(empty)"}`,
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

function viewJson(view: View, tabs: ViewTabs) {
  return {
    view: view.view,
    ...(view.device ? { device: deviceRef(view.device) } : {}),
    activePanelId: view.activePanelId,
    root: view.root,
    panels: view.panels.map((p) => ({
      number: p.number,
      id: p.id,
      sessions: p.tabIds.map((key) => {
        const tab = tabs.get(key);
        if (!tab) return { key };
        if ("kind" in tab) return tab;
        return { workspaceId: tab.workspaceId, tabId: tab.tabId, title: tab.title };
      }),
      shownTabId: p.shownTabId?.split(":")[1] ?? null,
      shownTabKey: p.shownTabId ?? null,
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
  flags: { device: DEVICE_FLAG },
  async run(ctx, { positionals, flags }) {
    const [word, ...rest] = positionals;
    if (rest.length > 0) throw new CliUsageError("give agents or workspaces");
    if (word === undefined) {
      const view = await viewOf(ctx, flags);
      return output(`The window shows ${VIEW_NAME[view.view]}.`, { view: view.view });
    }
    const target = ownValue(VIEWS, word.toLowerCase());
    if (!target) throw new CliUsageError(`the view is agents or workspaces, not "${word}"`);
    await writeView(ctx, flags, await resolveDevice(ctx, deviceFlag(flags)), {
      op: "show",
      view: target,
    });
    return output(`Showing ${VIEW_NAME[target]}.`, { view: target });
  },
};

const viewLayout: CliCommand = {
  path: ["view", "layout"],
  summary: "Show the agent view's panels and the tabs each holds",
  details:
    'Panels are numbered as other view commands take them. "*" marks the tab each panel\n' +
    "shows. The workspace follows each local tab, and the device follows each remote tab.",
  flags: { device: DEVICE_FLAG },
  async run(ctx, { positionals, flags }) {
    exactArgs(positionals);
    const view = await viewOf(ctx, flags);
    const tabs = new Map([...view.agents, ...view.held].map((tab) => [tab.key, tab]));
    return output(describeView(ctx, view, tabs).join("\n"), viewJson(view, tabs));
  },
};

const viewOpen: CliCommand = {
  path: ["view", "open"],
  summary: "Show a session in the agent view, and the agent view",
  args: "<session|--key KEY>",
  details:
    "Brings it to the front of the panel holding it, else adds it to --panel or the active\n" +
    `panel, which becomes the active one.\n${SESSION_HELP}\n${PANEL_HELP}`,
  flags: {
    device: DEVICE_FLAG,
    panel: { type: "string", value: "PANEL", description: "Add it to this panel" },
    workspace: WORKSPACE_FLAG,
    key: KEY_FLAG,
  },
  async run(ctx, { positionals, flags }) {
    const [selector] = tabArgs(positionals, flags);
    const view = await viewOf(ctx, flags);
    const tab = await viewTarget(ctx, view, selector, flags);
    const panel =
      flags.panel === undefined ? undefined : resolvePanel(ctx, view, flags.panel as string);
    const { panelId } = await writeView(
      ctx,
      flags,
      view.device,
      {
        op: "place",
        tab: tab.ref,
        ...(panel ? { panelId: panel.id } : {}),
        show: true,
      },
      "workspaceId" in tab.ref ? tab.ref.workspaceId : undefined,
    );
    return output(`Showing ${tab.title} in the agent view.`, {
      ...tab.json,
      panelId,
    });
  },
};

const viewOpenFile: CliCommand = {
  path: ["view", "open-file"],
  summary: "Open a workspace file in an agent view panel",
  args: "<file>",
  details: `Uses the same path rules as nexus open. Opens in the active panel unless --panel is given.\n${PANEL_HELP}`,
  flags: {
    device: DEVICE_FLAG,
    panel: { type: "string", value: "PANEL", description: "Open the file in this panel" },
    workspace: WORKSPACE_FLAG,
  },
  async run(ctx, { positionals, flags }) {
    const [input] = exactArgs(positionals, "file") as [string];
    const device = await resolveDevice(ctx, deviceFlag(flags));
    if (device) {
      const panelId =
        typeof flags.panel === "string"
          ? resolvePanel(ctx, await viewOf(ctx, flags), flags.panel).id
          : undefined;
      const opened = await writeView(ctx, flags, device, {
        op: "openFile",
        path: input,
        ...(panelId ? { panelId } : {}),
      });
      return output(`Opened ${input} in the agent view on "${device.name}".`, {
        path: input,
        device: deviceRef(device),
        ...opened,
      });
    }
    const workspace = resolveWorkspace(ctx, flags.workspace as string | undefined);
    const { relPath, filePath } = workspaceFile(ctx, workspace, input);
    const kind = await ctx.services.stat(workspace.id, relPath);
    if (kind === null) throw new CliError(`no such file: ${relPath}`);
    if (kind === "dir") throw new CliError(`${relPath} is a folder`);
    const panelId =
      typeof flags.panel === "string"
        ? resolvePanel(ctx, await viewOf(ctx, flags), flags.panel).id
        : undefined;
    await mayChange(ctx, workspace, { kind: "open", detail: relPath });
    const opened = await ctx.services.ui("agentView.openFile", {
      workspaceId: workspace.id,
      filePath,
      ...(panelId !== undefined ? { panelId } : {}),
    });
    return output(`Opened ${relPath} in the agent view.`, {
      workspaceId: workspace.id,
      path: relPath,
      ...opened,
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
  args: "<session|--key KEY> <left|right|up|down>",
  details:
    "Splits the panel holding the session, or the active one if none does, unless --of\n" +
    "names another. The active panel stays as it was.\n" +
    `${SESSION_HELP}\n${PANEL_HELP}`,
  flags: {
    device: DEVICE_FLAG,
    of: { type: "string", value: "PANEL", description: "Split this panel instead" },
    workspace: WORKSPACE_FLAG,
    key: KEY_FLAG,
  },
  async run(ctx, { positionals, flags }) {
    const [selector, sideWord] = tabArgs(positionals, flags, "side") as [string, string];
    const side = SIDES[sideWord.toLowerCase()];
    if (!side) throw new CliUsageError(`the side is left, right, up or down, not "${sideWord}"`);
    const view = await viewOf(ctx, flags);
    const tab = await viewTarget(ctx, view, selector, flags);
    const of =
      flags.of !== undefined
        ? resolvePanel(ctx, view, flags.of as string)
        : (view.panels.find((p) => p.tabIds.includes(tab.key)) ??
          (view.panels.find((p) => p.id === view.activePanelId) as GroupInfo));
    const { panelId } = await writeView(
      ctx,
      flags,
      view.device,
      {
        op: "place",
        tab: tab.ref,
        panelId: of.id,
        side,
        show: false,
      },
      "workspaceId" in tab.ref ? tab.ref.workspaceId : undefined,
    );
    return output(`Moved ${tab.title} into a new panel ${WHERE[side]} panel ${of.number}.`, {
      ...tab.json,
      panelId,
    });
  },
};

const viewMove: CliCommand = {
  path: ["view", "move"],
  summary: "Move a session into another panel, or to another place in its own",
  args: "<session|--key KEY> <panel>",
  details:
    "--at puts it at that place among the panel's sessions, counting from 1. The active\n" +
    `panel stays as it was.\n${SESSION_HELP}\n${PANEL_HELP}`,
  flags: {
    device: DEVICE_FLAG,
    at: { type: "number", value: "N", description: "Put it at place N of the panel's sessions" },
    workspace: WORKSPACE_FLAG,
    key: KEY_FLAG,
  },
  async run(ctx, { positionals, flags }) {
    const [selector, panelSelector] = tabArgs(positionals, flags, "panel") as [string, string];
    const at = flags.at as number | undefined;
    if (at !== undefined && at < 1) throw new CliUsageError("--at counts from 1");
    const view = await viewOf(ctx, flags);
    const tab = await viewTarget(ctx, view, selector, flags);
    const panel = resolvePanel(ctx, view, panelSelector);
    const key = tab.key;
    if (panel.tabIds.includes(key) && at === undefined) {
      throw new CliError(
        `${tab.title} is already in panel ${panel.number}; --at moves it within it`,
      );
    }
    await writeView(
      ctx,
      flags,
      view.device,
      {
        op: "place",
        tab: tab.ref,
        panelId: panel.id,
        ...(at === undefined ? {} : { index: at - 1 }),
        show: false,
      },
      "workspaceId" in tab.ref ? tab.ref.workspaceId : undefined,
    );
    return output(
      `Moved ${tab.title} to panel ${panel.number}${at === undefined ? "" : `, place ${at}`}.`,
      { ...tab.json, panelId: panel.id },
    );
  },
};

const viewRemove: CliCommand = {
  path: ["view", "remove"],
  summary: "Take a session out of the agent view; its tab stays in its workspace",
  args: "<session|--key KEY>",
  details: `A panel left empty closes, unless it is the only one.\n${SESSION_HELP}`,
  flags: {
    device: DEVICE_FLAG,
    workspace: WORKSPACE_FLAG,
    key: KEY_FLAG,
  },
  async run(ctx, { positionals, flags }) {
    const [selector] = tabArgs(positionals, flags);
    const view = await viewOf(ctx, flags);
    const tab = await viewTarget(ctx, view, selector, flags);
    if (!view.panels.some((p) => p.tabIds.includes(tab.key))) {
      throw new CliError(`${tab.title} is not in the agent view`);
    }
    await writeView(
      ctx,
      flags,
      view.device,
      { op: "remove", tab: tab.ref },
      "workspaceId" in tab.ref ? tab.ref.workspaceId : undefined,
    );
    return output(`Took ${tab.title} out of the agent view.`, {
      ...tab.json,
    });
  },
};

const viewClose: CliCommand = {
  path: ["view", "close"],
  summary: "Close a panel of the agent view; its sessions' tabs stay in their workspaces",
  args: "<panel>",
  details: `The only panel left is emptied instead.\n${PANEL_HELP}`,
  flags: { device: DEVICE_FLAG },
  async run(ctx, { positionals, flags }) {
    const [selector] = exactArgs(positionals, "panel") as [string];
    const view = await viewOf(ctx, flags);
    const panel = resolvePanel(ctx, view, selector);
    const { removed = 0 } = await writeView(ctx, flags, view.device, {
      op: "close",
      panelId: panel.id,
    });
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
    device: DEVICE_FLAG,
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
    const view = await viewOf(ctx, flags);
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
    await writeView(ctx, flags, view.device, {
      op: "ratios",
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
  flags: { device: DEVICE_FLAG },
  async run(ctx, { positionals, flags }) {
    exactArgs(positionals);
    const view = await viewOf(ctx, flags);
    const ratios = evenRatios(view.root);
    if (ratios.length > 0) await writeView(ctx, flags, view.device, { op: "ratios", ratios });
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
  flags: { device: DEVICE_FLAG },
  async run(ctx, { positionals, flags }) {
    const [selector] = exactArgs(positionals, "panel") as [string];
    const view = await viewOf(ctx, flags);
    const panel = resolvePanel(ctx, view, selector);
    await writeView(ctx, flags, view.device, { op: "focus", panelId: panel.id });
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
  flags: { device: DEVICE_FLAG },
  async run(ctx, { positionals, flags }) {
    const [word, ...rest] = positionals;
    if (rest.length > 0) throw new CliUsageError("give status or workspace");
    if (word === undefined) {
      const view = await viewOf(ctx, flags);
      return output(`The agent view lists its agents ${GROUPING_NAME[view.grouping]}.`, {
        grouping: view.grouping,
      });
    }
    const grouping = ownValue(GROUPINGS, word.toLowerCase());
    if (!grouping) throw new CliUsageError(`the grouping is status or workspace, not "${word}"`);
    await writeView(ctx, flags, await resolveDevice(ctx, deviceFlag(flags)), {
      op: "group",
      grouping,
    });
    return output(`The agent view lists its agents ${GROUPING_NAME[grouping]}.`, { grouping });
  },
};

export const viewCommands: CliCommand[] = [
  viewShow,
  viewLayout,
  viewOpen,
  viewOpenFile,
  viewSplit,
  viewMove,
  viewRemove,
  viewClose,
  viewResize,
  viewEven,
  viewFocus,
  viewGroup,
];

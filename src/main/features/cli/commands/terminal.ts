/** nexus tab ..., nexus terminal ... and nexus session list. */
import type { CliTabInfo } from "../../../../shared/cli/ui";
import type { WorkspaceMeta } from "../../../../shared/types/workspace";
import { isAgentSession, type TerminalState, terminalState } from "../agent-state";
import { CliUsageError, exactArgs, type ParsedArgs, parseDuration } from "../args";
import {
  type CliContext,
  CliError,
  mayChange,
  placementFor,
  resolveTab,
  resolveWorkspace,
  shortId,
} from "../context";
import { ago, oneLine, table } from "../format";
import { KEY_NAMES_HELP, keySequence } from "../keys";
import { absolutePath } from "../paths";
import { type CliCommand, type CliOutput, output } from "../registry";
import {
  DEFAULT_QUIET_MS,
  DEFAULT_WAIT_MS,
  MAX_WAIT_MS,
  type WaitResult,
  type WaitTarget,
  waitOnTerminal,
} from "../wait";
import { WORKSPACE_FLAG } from "./flags";
import { orderedWorkspaces } from "./workspace";

/** The tabs of a workspace, as the renderer has them. */
export async function workspaceTabs(ctx: CliContext, workspaceId: string): Promise<CliTabInfo[]> {
  return (await ctx.services.ui("tabs.list", { workspaceId })).tabs;
}

/** The terminal a selector names in a workspace. */
export async function resolveTerminal(
  ctx: CliContext,
  workspace: WorkspaceMeta,
  selector: string,
): Promise<CliTabInfo> {
  const tabs = (await workspaceTabs(ctx, workspace.id)).filter((t) => t.type === "terminal");
  return resolveTab(ctx, tabs, selector, `terminal in ${workspace.name}`);
}

/** A tab a selector names in a workspace, of any type. */
async function resolveAnyTab(
  ctx: CliContext,
  workspace: WorkspaceMeta,
  selector: string,
): Promise<CliTabInfo> {
  return resolveTab(
    ctx,
    await workspaceTabs(ctx, workspace.id),
    selector,
    `tab in ${workspace.name}`,
  );
}

/**
 * Refuses to type into a terminal that is not another's to type into: the
 * caller's own, one that has exited, and a Claude Code waiting for the user
 * to allow a tool, which is the user's answer to give.
 */
function checkTypable(ctx: CliContext, workspace: WorkspaceMeta, tab: CliTabInfo): void {
  if (tab.id === ctx.caller.tabId) {
    throw new CliError("that is this terminal; nexus types only into other terminals");
  }
  if (tab.dead) throw new CliError(`${tab.title} has exited`);
  if (ctx.services.claudeStatus(workspace.id, tab.id)?.status === "permissionPending") {
    throw new CliError(
      "Claude Code there is waiting for the user to allow a tool; that is for the user to answer",
    );
  }
}

const WAIT_FLAGS = {
  timeout: {
    type: "string",
    value: "DURATION",
    description: "Stop waiting after DURATION, such as 90s or 5m (default 10m, at most 30m)",
  },
  quiet: {
    type: "string",
    value: "DURATION",
    description: "How long an agent told by its output must stay still to be idle (default 5s)",
  },
} as const;

const IDLE_DETAILS =
  "Idle means: Claude Code ended its turn or waits for the user; Codex and other agents raised\n" +
  "a notification or stopped printing; a shell is back at its prompt. When the wait runs out,\n" +
  "nexus exits with 124.";

function waitTimes(flags: ParsedArgs["flags"]): { timeoutMs: number; quietMs: number } {
  const timeoutMs =
    flags.timeout === undefined
      ? DEFAULT_WAIT_MS
      : parseDuration(flags.timeout as string, "timeout");
  if (timeoutMs > MAX_WAIT_MS) throw new CliUsageError("--timeout is at most 30m");
  const quietMs =
    flags.quiet === undefined ? DEFAULT_QUIET_MS : parseDuration(flags.quiet as string, "quiet");
  return { timeoutMs, quietMs };
}

/** A wait's result as the command prints it; exit 124 when the wait ran out. */
function waitOutput(text: string, json: Record<string, unknown>, result: WaitResult): CliOutput {
  return output(
    text,
    { ...json, state: result.state, ...(result.message ? { message: result.message } : {}) },
    result.done ? {} : { exitCode: 124 },
  );
}

/** The workspaces a listing covers: --all, --workspace, or the caller's. */
function scope(ctx: CliContext, flags: { all?: unknown; workspace?: unknown }): WorkspaceMeta[] {
  if (flags.all === true) return orderedWorkspaces(ctx.services.listWorkspaces());
  return [resolveWorkspace(ctx, flags.workspace as string | undefined)];
}

interface TerminalRow {
  readonly workspace: WorkspaceMeta;
  readonly tab: CliTabInfo;
  readonly state: TerminalState;
}

async function terminalRows(
  ctx: CliContext,
  workspaces: readonly WorkspaceMeta[],
): Promise<TerminalRow[]> {
  const rows: TerminalRow[] = [];
  for (const workspace of workspaces) {
    const tabs = await workspaceTabs(ctx, workspace.id);
    for (const tab of tabs) {
      if (tab.type !== "terminal") continue;
      rows.push({
        workspace,
        tab,
        state: terminalState(ctx.services, workspace.id, tab.id, tab.title),
      });
    }
  }
  return rows;
}

function rowJson(ctx: CliContext, row: TerminalRow) {
  return {
    id: row.tab.id,
    workspaceId: row.workspace.id,
    workspace: row.workspace.name,
    title: row.tab.title,
    cwd: row.tab.cwd,
    current: row.tab.id === ctx.caller.tabId,
    ...(row.tab.dead ? { exited: true } : {}),
    ...row.state,
  };
}

function stateText(row: TerminalRow): string {
  if (row.tab.dead) return "exited";
  return row.state.agent ? `${row.state.agent}:${row.state.state}` : row.state.state;
}

const tabList: CliCommand = {
  path: ["tab", "list"],
  summary: "List a workspace's tabs: terminals, editors, diffs and browsers",
  flags: { workspace: WORKSPACE_FLAG },
  async run(ctx, { flags }) {
    const workspace = resolveWorkspace(ctx, flags.workspace as string | undefined);
    const tabs = await workspaceTabs(ctx, workspace.id);
    const rows = tabs.map((t) => [
      shortId(t.id),
      t.type,
      t.id === ctx.caller.tabId ? `${t.title} (this terminal)` : t.title,
      t.url ?? t.filePath ?? t.cwd ?? "",
    ]);
    return output(table(["ID", "TYPE", "TITLE", "WHERE"], rows), tabs);
  },
};

const tabShow: CliCommand = {
  path: ["tab", "show"],
  summary: "Show a tab to the user, switching to its workspace if need be",
  args: "<tab>",
  flags: { workspace: WORKSPACE_FLAG },
  async run(ctx, { positionals, flags }) {
    const [selector] = exactArgs(positionals, "tab") as [string];
    const workspace = resolveWorkspace(ctx, flags.workspace as string | undefined);
    const tab = await resolveAnyTab(ctx, workspace, selector);
    await ctx.services.ui("tab.show", { workspaceId: workspace.id, tabId: tab.id });
    return output(`Showing ${tab.title} (${shortId(tab.id)}) in ${workspace.name}.`, {
      tabId: tab.id,
      workspaceId: workspace.id,
    });
  },
};

const tabClose: CliCommand = {
  path: ["tab", "close"],
  summary: "Close a tab",
  args: "<tab>",
  details:
    "A tab with unsaved changes is left open. So is a terminal running a program, unless --force.",
  flags: {
    workspace: WORKSPACE_FLAG,
    force: { type: "boolean", description: "Close a terminal even while a program runs in it" },
  },
  async run(ctx, { positionals, flags }) {
    const [selector] = exactArgs(positionals, "tab") as [string];
    const workspace = resolveWorkspace(ctx, flags.workspace as string | undefined);
    const tab = await resolveAnyTab(ctx, workspace, selector);
    if (tab.id === ctx.caller.tabId) {
      throw new CliError("that is this terminal; close it in the app or exit its shell");
    }
    await mayChange(ctx, workspace, { kind: "tabClose", detail: tab.title });
    await ctx.services.ui("tab.close", {
      workspaceId: workspace.id,
      tabId: tab.id,
      force: flags.force === true,
    });
    return output(`Closed ${tab.title} (${shortId(tab.id)}).`, {
      tabId: tab.id,
      workspaceId: workspace.id,
    });
  },
};

const terminalList: CliCommand = {
  path: ["terminal", "list"],
  summary: "List terminals and what runs in them",
  flags: {
    workspace: WORKSPACE_FLAG,
    all: { type: "boolean", description: "List every workspace's terminals" },
  },
  async run(ctx, { flags }) {
    const workspaces = scope(ctx, flags);
    const rows = await terminalRows(ctx, workspaces);
    const text = table(
      ["ID", ...(workspaces.length > 1 ? ["WORKSPACE"] : []), "TITLE", "STATE"],
      rows.map((r) => [
        shortId(r.tab.id),
        ...(workspaces.length > 1 ? [r.workspace.name] : []),
        r.tab.id === ctx.caller.tabId ? `${r.tab.title} (this terminal)` : r.tab.title,
        stateText(r),
      ]),
    );
    return output(
      text,
      rows.map((r) => rowJson(ctx, r)),
    );
  },
};

const terminalRead: CliCommand = {
  path: ["terminal", "read"],
  summary: "Print what a terminal shows, scrollback included",
  args: "[<tab>]",
  details: 'The tab defaults to this terminal (".").',
  flags: {
    workspace: WORKSPACE_FLAG,
    lines: { type: "number", value: "N", description: "How many of the last lines (default 100)" },
  },
  async run(ctx, { positionals, flags }) {
    const workspace = resolveWorkspace(ctx, flags.workspace as string | undefined);
    const tab = await resolveTerminal(ctx, workspace, positionals[0] ?? ".");
    const lines = (flags.lines as number | undefined) ?? 100;
    if (!Number.isInteger(lines) || lines < 1)
      throw new CliError("--lines takes a positive whole number", 2);
    const { text } = await ctx.services.ui("terminal.read", {
      workspaceId: workspace.id,
      tabId: tab.id,
      lines,
    });
    return output(text, { id: tab.id, workspaceId: workspace.id, text });
  },
};

const terminalNew: CliCommand = {
  path: ["terminal", "new"],
  summary: "Open a terminal, running a command if given",
  details: "It opens behind this terminal unless --show. Its id is printed for terminal send/read.",
  flags: {
    cwd: { type: "string", value: "DIR", description: "Start in DIR (default: this directory)" },
    command: {
      type: "string",
      value: "CMD",
      description: "Type CMD and Enter once the shell has started",
    },
    title: { type: "string", value: "TITLE", description: "Name the tab TITLE" },
    show: { type: "boolean", description: "Show it, beside this terminal" },
    workspace: WORKSPACE_FLAG,
  },
  async run(ctx, { positionals, flags }) {
    exactArgs(positionals);
    const workspace = resolveWorkspace(ctx, flags.workspace as string | undefined);
    const dir = flags.cwd as string | undefined;
    const cwd =
      dir !== undefined
        ? absolutePath(ctx, workspace, dir)
        : workspace.id === ctx.caller.workspaceId
          ? ctx.invocation.cwd
          : workspace.rootPath;
    const title = flags.title as string | undefined;
    const command = flags.command as string | undefined;
    await mayChange(ctx, workspace, { kind: "terminalNew" });
    const { tabId } = await ctx.services.ui("terminal.open", {
      workspaceId: workspace.id,
      cwd,
      ...(title ? { title } : {}),
      ...(command ? { command } : {}),
      placement: placementFor(ctx, workspace, flags.show !== true),
    });
    return output(`Opened terminal ${shortId(tabId)} in ${cwd}.`, {
      tabId,
      workspaceId: workspace.id,
      cwd,
    });
  },
};

const terminalSend: CliCommand = {
  path: ["terminal", "send"],
  summary: "Type text into a terminal, then Enter",
  args: "<tab> <text...>",
  details:
    'The text goes in as one paste, so an agent\'s prompt takes it whole. "-" reads it from\n' +
    "standard input. Refused for this terminal, and for a Claude Code waiting for the user\n" +
    "to allow a tool. --wait waits as terminal wait does and prints how it ended.",
  flags: {
    "no-enter": { type: "boolean", description: "Type the text without pressing Enter" },
    wait: { type: "boolean", description: "Then wait until the terminal is idle again" },
    ...WAIT_FLAGS,
    workspace: WORKSPACE_FLAG,
  },
  async run(ctx, { positionals, flags }) {
    const [selector, ...words] = positionals;
    if (selector === undefined) throw new CliUsageError("missing <tab>");
    const fromStdin = words.length === 1 && words[0] === "-";
    const text = fromStdin ? (ctx.invocation.stdin ?? "").replace(/\r?\n$/, "") : words.join(" ");
    const enter = flags["no-enter"] !== true;
    if (text === "" && !enter) throw new CliUsageError("nothing to send");
    const times = flags.wait === true ? waitTimes(flags) : null;
    const workspace = resolveWorkspace(ctx, flags.workspace as string | undefined);
    const tab = await resolveTerminal(ctx, workspace, selector);
    checkTypable(ctx, workspace, tab);
    await mayChange(ctx, workspace, { kind: "terminalInput", detail: tab.title });
    const startedAt = ctx.services.clock.now();
    await ctx.services.ui("terminal.input", {
      workspaceId: workspace.id,
      tabId: tab.id,
      text,
      mode: "paste",
      enter,
    });
    const sent = `Sent to ${tab.title} (${shortId(tab.id)}).`;
    const json = { tabId: tab.id, workspaceId: workspace.id, text, enter };
    if (!times) return output(sent, json);
    const result = await waitOnTerminal(ctx, workspace, tab, {
      target: { kind: "idle" },
      ...times,
      startedAt,
      afterInput: true,
    });
    return waitOutput(`${sent}\n${result.text}`, json, result);
  },
};

const terminalKey: CliCommand = {
  path: ["terminal", "key"],
  summary: "Press keys in a terminal, such as ctrl-c or down enter",
  args: "<tab> <key...>",
  details: KEY_NAMES_HELP,
  flags: { workspace: WORKSPACE_FLAG },
  async run(ctx, { positionals, flags }) {
    const [selector, ...keys] = positionals;
    if (selector === undefined) throw new CliUsageError("missing <tab>");
    if (keys.length === 0) throw new CliUsageError("missing <key>");
    const text = keys.map(keySequence).join("");
    const workspace = resolveWorkspace(ctx, flags.workspace as string | undefined);
    const tab = await resolveTerminal(ctx, workspace, selector);
    checkTypable(ctx, workspace, tab);
    await mayChange(ctx, workspace, { kind: "terminalInput", detail: tab.title });
    await ctx.services.ui("terminal.input", {
      workspaceId: workspace.id,
      tabId: tab.id,
      text,
      mode: "keys",
      enter: false,
    });
    return output(`Pressed ${keys.join(" ")} in ${tab.title} (${shortId(tab.id)}).`, {
      tabId: tab.id,
      workspaceId: workspace.id,
      keys,
    });
  },
};

const terminalWait: CliCommand = {
  path: ["terminal", "wait"],
  summary: "Wait until a terminal is idle, has exited, or shows a pattern",
  args: "<tab>",
  details:
    `${IDLE_DETAILS}\n` +
    "--match looks at the screen as it is, already printed lines and typed commands included;\n" +
    'anchor the pattern, as in "^ready", when the command line itself would match.',
  flags: {
    exit: { type: "boolean", description: "Wait until it exits instead" },
    match: {
      type: "string",
      value: "REGEX",
      description: "Wait until one of its last 200 lines matches REGEX instead",
    },
    ...WAIT_FLAGS,
    workspace: WORKSPACE_FLAG,
  },
  async run(ctx, { positionals, flags }) {
    const [selector] = exactArgs(positionals, "tab") as [string];
    let target: WaitTarget = { kind: "idle" };
    if (flags.exit === true && flags.match !== undefined) {
      throw new CliUsageError("--exit and --match do not go together");
    }
    if (flags.exit === true) target = { kind: "exit" };
    if (flags.match !== undefined) {
      try {
        target = { kind: "match", pattern: new RegExp(flags.match as string) };
      } catch (error) {
        throw new CliUsageError(`--match: ${(error as Error).message}`);
      }
    }
    const times = waitTimes(flags);
    const workspace = resolveWorkspace(ctx, flags.workspace as string | undefined);
    const tab = await resolveTerminal(ctx, workspace, selector);
    if (tab.id === ctx.caller.tabId) {
      throw new CliError("that is this terminal; it cannot wait on itself");
    }
    const result = await waitOnTerminal(ctx, workspace, tab, {
      target,
      ...times,
      startedAt: ctx.services.clock.now(),
      afterInput: false,
    });
    return waitOutput(result.text, { tabId: tab.id, workspaceId: workspace.id }, result);
  },
};

const sessionList: CliCommand = {
  path: ["session", "list"],
  summary: "List the agent sessions (Claude Code, Codex, ...) in every workspace",
  details:
    "Claude Code reports its state through the app's hooks. Other agents are told by their title\n" +
    "and the notifications they raise; their state is busy while they print and quiet after.",
  flags: {
    workspace: { ...WORKSPACE_FLAG, description: "Only this workspace (id, id prefix or name)" },
  },
  async run(ctx, { flags }) {
    const workspaces =
      flags.workspace === undefined
        ? orderedWorkspaces(ctx.services.listWorkspaces())
        : [resolveWorkspace(ctx, flags.workspace as string)];
    const rows = (await terminalRows(ctx, workspaces)).filter((r) => isAgentSession(r.state));
    const now = Date.now();
    const text = table(
      ["ID", "WORKSPACE", "AGENT", "STATE", "SINCE", "LAST"],
      rows.map((r) => [
        shortId(r.tab.id),
        r.workspace.name,
        r.state.agent ?? "?",
        r.tab.id === ctx.caller.tabId ? `${r.state.state} (you)` : r.state.state,
        r.state.since ? ago(r.state.since, now) : "",
        r.state.message ? oneLine(r.state.message, 60) : "",
      ]),
    );
    return output(
      text || "No agent sessions.",
      rows.map((r) => rowJson(ctx, r)),
    );
  },
};

export const terminalCommands: CliCommand[] = [
  tabList,
  tabShow,
  tabClose,
  terminalList,
  terminalRead,
  terminalNew,
  terminalSend,
  terminalKey,
  terminalWait,
  sessionList,
];

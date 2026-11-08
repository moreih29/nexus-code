/** nexus tab ..., nexus terminal ... and nexus session list. */
import type { CliChatInfo, CliTabInfo } from "../../../../shared/cli/ui";
import type { WorkspaceMeta } from "../../../../shared/types/workspace";
import { isAgentSession, type TerminalState, terminalState } from "../agent-state";
import { CliUsageError, exactArgs, type ParsedArgs, parseDuration } from "../args";
import {
  type CliContext,
  CliError,
  mayChange,
  noteDispatch,
  placementFor,
  resolveTab,
  resolveWorkspace,
  shortId,
} from "../context";
import { ago, oneLine, table } from "../format";
import { KEY_NAMES_HELP, keySequence } from "../keys";
import { absolutePath, rendererRoot } from "../paths";
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
export async function resolveAnyTab(
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

/** A task's branch and the workspace it is a task of, for a session's JSON. */
function taskJson(workspace: WorkspaceMeta) {
  return workspace.task
    ? { branch: workspace.task.branch, parentWorkspaceId: workspace.task.parentId }
    : {};
}

function rowJson(ctx: CliContext, row: TerminalRow) {
  return {
    id: row.tab.id,
    workspaceId: row.workspace.id,
    workspace: row.workspace.name,
    ...taskJson(row.workspace),
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
  details: 'An editor with changes not saved is marked "(unsaved)".',
  flags: {
    workspace: WORKSPACE_FLAG,
    unsaved: { type: "boolean", description: "Only the tabs with unsaved changes" },
  },
  async run(ctx, { flags }) {
    const workspace = resolveWorkspace(ctx, flags.workspace as string | undefined);
    const onlyUnsaved = flags.unsaved === true;
    const tabs = (await workspaceTabs(ctx, workspace.id)).filter(
      (t) => !onlyUnsaved || t.unsaved === true,
    );
    const rows = tabs.map((t) => [
      shortId(t.id),
      t.type,
      t.id === ctx.caller.tabId
        ? `${t.title} (this terminal)`
        : t.unsaved
          ? `${t.title} (unsaved)`
          : t.title,
      t.url ?? t.filePath ?? t.cwd ?? "",
    ]);
    const none = onlyUnsaved
      ? `No unsaved changes in ${workspace.name}'s tabs.`
      : `No tabs in ${workspace.name}.`;
    return output(table(["ID", "TYPE", "TITLE", "WHERE"], rows) || none, tabs);
  },
};

/** What `tab save` and `tab revert` act on: the tab named, or with --all each unsaved one. */
async function unsavedTargets(
  ctx: CliContext,
  workspace: WorkspaceMeta,
  positionals: readonly string[],
  all: boolean,
): Promise<CliTabInfo[]> {
  if (!all) {
    const [selector] = exactArgs(positionals, "tab") as [string];
    return [await resolveAnyTab(ctx, workspace, selector)];
  }
  exactArgs(positionals);
  return (await workspaceTabs(ctx, workspace.id)).filter((t) => t.unsaved === true);
}

/** A file's path as the user would write it: inside the workspace, from its root. */
function shownPath(workspace: WorkspaceMeta, filePath: string): string {
  const root = rendererRoot(workspace);
  return filePath.startsWith(`${root}/`) ? filePath.slice(root.length + 1) : filePath;
}

function fileTabCommand(verb: "save" | "revert"): CliCommand {
  const saving = verb === "save";
  return {
    path: ["tab", verb],
    summary: saving
      ? "Save an editor's unsaved changes to its file"
      : "Drop an editor's unsaved changes for what is on its file",
    args: "[tab]",
    details: saving
      ? "TAB is an editor, or a diff whose right side is the working tree. A file changed on\n" +
        "disk since it was opened is not overwritten: the user chooses in the app, or revert\n" +
        "takes what is on disk. An untitled tab is saved in the app, where it gets its name."
      : "TAB is an editor, or a diff whose right side is the working tree. What was typed and\n" +
        "not saved is lost.",
    flags: {
      workspace: WORKSPACE_FLAG,
      all: {
        type: "boolean",
        description: saving
          ? "Save every tab with unsaved changes"
          : "Revert every tab with unsaved changes",
      },
    },
    async run(ctx, { positionals, flags }) {
      const workspace = resolveWorkspace(ctx, flags.workspace as string | undefined);
      const all = flags.all === true;
      const targets = await unsavedTargets(ctx, workspace, positionals, all);
      if (targets.length === 0) {
        return output(`No unsaved changes in ${workspace.name}'s tabs.`, []);
      }
      await mayChange(ctx, workspace, {
        kind: saving ? "tabSave" : "tabRevert",
        detail: targets.map((t) => t.title).join('", "'),
      });
      const lines: string[] = [];
      const results: { tabId: string; filePath?: string; done: boolean; error?: string }[] = [];
      for (const tab of targets) {
        try {
          const args = { workspaceId: workspace.id, tabId: tab.id };
          const { filePath, done } = saving
            ? await ctx.services.ui("tab.save", args).then((r) => ({ ...r, done: r.saved }))
            : await ctx.services.ui("tab.revert", args).then((r) => ({ ...r, done: r.reverted }));
          const file = shownPath(workspace, filePath);
          lines.push(
            done
              ? `${saving ? "Saved" : "Reverted"} ${file} (tab ${shortId(tab.id)}).`
              : `${file} had no unsaved changes (tab ${shortId(tab.id)}).`,
          );
          results.push({ tabId: tab.id, filePath, done });
        } catch (error) {
          if (!all) throw error;
          const message = error instanceof Error ? error.message : String(error);
          lines.push(`Left ${tab.title} (tab ${shortId(tab.id)}): ${message}.`);
          results.push({ tabId: tab.id, done: false, error: message });
        }
      }
      const failed = results.some((r) => r.error !== undefined);
      return output(lines.join("\n"), all ? results : results[0], failed ? { exitCode: 1 } : {});
    },
  };
}

const tabSave = fileTabCommand("save");
const tabRevert = fileTabCommand("revert");

const tabShow: CliCommand = {
  path: ["tab", "show"],
  summary: "Show a tab to the user, switching to its workspace if need be",
  args: "<tab>",
  flags: { workspace: WORKSPACE_FLAG },
  async run(ctx, { positionals, flags }) {
    const [selector] = exactArgs(positionals, "tab") as [string];
    const workspace = resolveWorkspace(ctx, flags.workspace as string | undefined);
    const tab = await resolveAnyTab(ctx, workspace, selector);
    await ctx.services.ui("tab.show", {
      workspaceId: workspace.id,
      tabId: tab.id,
      caller: ctx.caller,
    });
    return output(`Showing ${tab.title} (${shortId(tab.id)}) in ${workspace.name}.`, {
      tabId: tab.id,
      workspaceId: workspace.id,
    });
  },
};

type BulkClose = "others" | "saved" | "all";

/** Which of --others, --saved and --all a tab close asks for; none for one tab. */
function bulkCloseFlag(flags: ParsedArgs["flags"]): BulkClose | null {
  const given = (["others", "saved", "all"] as const).filter((name) => flags[name] === true);
  if (given.length > 1) throw new CliUsageError("give one of --others, --saved and --all");
  return given[0] ?? null;
}

/**
 * The tabs a bulk close closes, as the tab bar's menu closes them: the
 * other tabs of `of`'s group but the pinned ones; the editors with nothing
 * unsaved; or every tab. Without `of`, of every group.
 */
function bulkTargets(
  tabs: readonly CliTabInfo[],
  bulk: BulkClose,
  of: CliTabInfo | undefined,
): CliTabInfo[] {
  const scoped = of ? tabs.filter((t) => t.groupId === of.groupId) : tabs;
  switch (bulk) {
    case "others":
      return scoped.filter((t) => t.id !== of?.id && t.pinned !== true);
    case "saved":
      return scoped.filter((t) => t.type === "editor" && t.unsaved !== true);
    case "all":
      return [...scoped];
  }
}

/** Closes tabs one by one, saying which were left open and why. */
async function closeTabs(
  ctx: CliContext,
  workspace: WorkspaceMeta,
  targets: readonly CliTabInfo[],
  force: boolean,
): Promise<CliOutput> {
  const closed: CliTabInfo[] = [];
  const left: { tab: CliTabInfo; reason: string }[] = [];
  for (const tab of targets) {
    if (tab.id === ctx.caller.tabId) {
      left.push({ tab, reason: "it is this terminal" });
      continue;
    }
    try {
      await ctx.services.ui("tab.close", { workspaceId: workspace.id, tabId: tab.id, force });
      closed.push(tab);
    } catch (error) {
      left.push({ tab, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  const lines = [
    `Closed ${closed.length} tab${closed.length === 1 ? "" : "s"} in ${workspace.name}.`,
    ...left.map(({ tab, reason }) => `Left ${tab.title} (${shortId(tab.id)}) open: ${reason}.`),
  ];
  return output(
    lines.join("\n"),
    {
      workspaceId: workspace.id,
      closed: closed.map((t) => t.id),
      left: left.map(({ tab, reason }) => ({ tabId: tab.id, reason })),
    },
    left.some(({ tab }) => tab.id !== ctx.caller.tabId) ? { exitCode: 1 } : {},
  );
}

const tabClose: CliCommand = {
  path: ["tab", "close"],
  summary: "Close a tab, or many as the tab bar's menu does",
  args: "[tab]",
  details:
    "A tab with unsaved changes is left open. So is a terminal running a program, unless --force.\n" +
    "--others closes the other tabs of TAB's group but the pinned ones; --saved, the editors\n" +
    "with nothing unsaved; --all, every tab. --saved and --all without TAB close those of\n" +
    "every group. This terminal is never closed; nexus exits 1 when it left another open.",
  flags: {
    workspace: WORKSPACE_FLAG,
    force: { type: "boolean", description: "Close a terminal even while a program runs in it" },
    others: { type: "boolean", description: "The other tabs of TAB's group, pinned ones aside" },
    saved: { type: "boolean", description: "The editors with nothing unsaved" },
    all: { type: "boolean", description: "Every tab, pinned ones too" },
  },
  async run(ctx, { positionals, flags }) {
    const bulk = bulkCloseFlag(flags);
    const force = flags.force === true;
    if (bulk !== null) {
      if (positionals.length > 1) {
        throw new CliUsageError(`unexpected argument "${positionals[1]}"`);
      }
      const [selector] = positionals;
      if (bulk === "others" && selector === undefined) {
        throw new CliUsageError("missing <tab>: --others closes the other tabs of its group");
      }
      const workspace = resolveWorkspace(ctx, flags.workspace as string | undefined);
      const tabs = await workspaceTabs(ctx, workspace.id);
      const of =
        selector === undefined
          ? undefined
          : resolveTab(ctx, tabs, selector, `tab in ${workspace.name}`);
      const targets = bulkTargets(tabs, bulk, of);
      if (targets.length === 0) return output("No tabs to close.", { closed: [], left: [] });
      await mayChange(ctx, workspace, {
        kind: "tabClose",
        detail: targets.map((t) => t.title).join('", "'),
      });
      return closeTabs(ctx, workspace, targets, force);
    }
    const [selector] = exactArgs(positionals, "tab") as [string];
    const workspace = resolveWorkspace(ctx, flags.workspace as string | undefined);
    const tab = await resolveAnyTab(ctx, workspace, selector);
    if (tab.id === ctx.caller.tabId) {
      throw new CliError("that is this terminal; close it in the app or exit its shell");
    }
    await mayChange(ctx, workspace, { kind: "tabClose", detail: tab.title });
    await ctx.services.ui("tab.close", { workspaceId: workspace.id, tabId: tab.id, force });
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
    const none =
      workspaces.length === 1 ? `No terminals in ${workspaces[0]?.name}.` : "No terminals.";
    return output(
      text || none,
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
    shell: {
      type: "string",
      value: "SHELL",
      description:
        'Run SHELL, by a name "terminal shells" lists (default: the one set; local workspaces only)',
    },
    show: { type: "boolean", description: "Show it, beside this terminal" },
    workspace: WORKSPACE_FLAG,
  },
  async run(ctx, { positionals, flags }) {
    exactArgs(positionals);
    const workspace = resolveWorkspace(ctx, flags.workspace as string | undefined);
    const shell = flags.shell as string | undefined;
    const { location } = workspace;
    if (shell !== undefined && location.kind !== "local") {
      const [kind, machine] =
        location.kind === "ssh" ? ["an SSH", location.host] : ["a WSL", location.distro];
      throw new CliError(
        `--shell is for local workspaces; ${workspace.name} is ${kind} workspace, whose terminals run ${machine}'s login shell`,
      );
    }
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
      ...(shell !== undefined ? { shell } : {}),
      placement: placementFor(ctx, workspace, flags.show !== true),
    });
    if (command) await noteDispatch(ctx, { workspaceId: workspace.id, tabId });
    return output(`Opened terminal ${shortId(tabId)} in ${cwd}.`, {
      tabId,
      workspaceId: workspace.id,
      cwd,
    });
  },
};

const terminalShells: CliCommand = {
  path: ["terminal", "shells"],
  summary: "List the shells a terminal can run, for terminal new --shell",
  details:
    "The shells found on the computer NexusCode runs on and those added in Settings ›\n" +
    'Terminal, as the tab bar\'s "New terminal with" lists them. They are for local\n' +
    "workspaces only: an SSH or WSL workspace's terminals run the login shell of its machine.",
  async run(ctx, { positionals }) {
    exactArgs(positionals);
    const { shells } = await ctx.services.ui("terminal.shells", {});
    const text = table(
      ["NAME", "ID", "PATH"],
      shells.map((s) => [s.isDefault ? `${s.name} (default)` : s.name, s.id, s.path]),
    );
    return output(text, { shells });
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
    if (enter && text.trim() !== "") {
      await noteDispatch(ctx, { workspaceId: workspace.id, tabId: tab.id }, text);
    }
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

interface ChatRow {
  readonly workspace: WorkspaceMeta;
  readonly tab: CliTabInfo;
  readonly info: CliChatInfo;
}

/** The Claude and Codex tabs of `workspaces`; one not opened since the app started reads idle. */
async function chatRows(ctx: CliContext, workspaces: readonly WorkspaceMeta[]): Promise<ChatRow[]> {
  const rows: ChatRow[] = [];
  for (const workspace of workspaces) {
    for (const tab of await workspaceTabs(ctx, workspace.id)) {
      if (tab.type !== "claude" && tab.type !== "codex") continue;
      const info = await ctx.services.ui("chat.state", {
        workspaceId: workspace.id,
        tabId: tab.id,
        peek: true,
      });
      rows.push({ workspace, tab, info });
    }
  }
  return rows;
}

const sessionList: CliCommand = {
  path: ["session", "list"],
  summary: "List the agent sessions (Claude Code, Codex, ...) in every workspace",
  details:
    "Claude Code in a terminal reports its state through the app's hooks. Other agents in\n" +
    "terminals are told by their title and the notifications they raise; their state is busy\n" +
    "while they print and quiet after. The app's Claude and Codex tabs (AGENT claude-tab or\n" +
    "codex-tab) are working, asking (the user), idle or error; chat read/send/wait reach them.\n" +
    "LAST is cut to a line; --json and --jsonl carry it whole, with a task's branch.\n" +
    'To follow the changes as they come, see "nexus events".',
  flags: {
    workspace: { ...WORKSPACE_FLAG, description: "Only this workspace (id, id prefix or name)" },
  },
  async run(ctx, { flags }) {
    const workspaces =
      flags.workspace === undefined
        ? orderedWorkspaces(ctx.services.listWorkspaces())
        : [resolveWorkspace(ctx, flags.workspace as string)];
    const now = Date.now();
    const you = (tab: CliTabInfo, state: string) =>
      tab.id === ctx.caller.tabId ? `${state} (you)` : state;
    // A workspace's terminals, then its Claude and Codex tabs.
    const sessions: Array<{ workspace: WorkspaceMeta; cells: string[]; json: object }> = [
      ...(await terminalRows(ctx, workspaces))
        .filter((r) => isAgentSession(r.state))
        .map((r) => ({
          workspace: r.workspace,
          cells: [
            shortId(r.tab.id),
            r.workspace.name,
            oneLine(r.tab.title, 30),
            r.state.agent ?? "?",
            you(r.tab, r.state.state),
            r.state.since ? ago(r.state.since, now) : "",
            r.state.message ? oneLine(r.state.message, 60) : "",
          ],
          json: rowJson(ctx, r),
        })),
      ...(await chatRows(ctx, workspaces)).map((c) => ({
        workspace: c.workspace,
        cells: [
          shortId(c.tab.id),
          c.workspace.name,
          oneLine(c.tab.title, 30),
          `${c.info.agent}-tab`,
          you(c.tab, c.info.state),
          c.info.since ? ago(c.info.since, now) : "",
          c.info.message ? oneLine(c.info.message, 60) : "",
        ],
        json: {
          id: c.tab.id,
          workspaceId: c.workspace.id,
          workspace: c.workspace.name,
          ...taskJson(c.workspace),
          title: c.tab.title,
          current: c.tab.id === ctx.caller.tabId,
          tab: c.tab.type,
          agent: c.info.agent,
          state: c.info.state,
          ...(c.info.message ? { message: c.info.message } : {}),
          ...(c.info.since !== undefined ? { since: c.info.since } : {}),
        },
      })),
    ];
    const order = (s: (typeof sessions)[number]) => workspaces.indexOf(s.workspace);
    sessions.sort((a, b) => order(a) - order(b));
    const text = table(
      ["ID", "WORKSPACE", "TITLE", "AGENT", "STATE", "SINCE", "LAST"],
      sessions.map((s) => s.cells),
    );
    return output(
      text || "No agent sessions.",
      sessions.map((s) => s.json),
    );
  },
};

export const terminalCommands: CliCommand[] = [
  tabList,
  tabShow,
  tabClose,
  tabSave,
  tabRevert,
  terminalList,
  terminalRead,
  terminalNew,
  terminalShells,
  terminalSend,
  terminalKey,
  terminalWait,
  sessionList,
];

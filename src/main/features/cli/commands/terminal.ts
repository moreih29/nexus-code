/** nexus tab list, nexus terminal list/read and nexus session list. */
import type { CliTabInfo } from "../../../../shared/cli/ui";
import type { WorkspaceMeta } from "../../../../shared/types/workspace";
import { isAgentSession, type TerminalState, terminalState } from "../agent-state";
import { type CliContext, CliError, resolveTab, resolveWorkspace, shortId } from "../context";
import { ago, oneLine, table } from "../format";
import { type CliCommand, output } from "../registry";
import { orderedWorkspaces } from "./workspace";

const WORKSPACE_FLAG = {
  type: "string",
  value: "WORKSPACE",
  description: "The workspace (id, id prefix or name); this terminal's by default",
} as const;

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

export const terminalCommands: CliCommand[] = [tabList, terminalList, terminalRead, sessionList];

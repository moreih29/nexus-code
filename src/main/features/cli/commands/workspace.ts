/** nexus status, nexus workspace ... and nexus worktree ... (the app's tasks). */
import type { CliTaskStart, CliView } from "../../../../shared/cli/ui";
import { isManager } from "../../../../shared/manager/manager";
import type { WorkspaceLocation, WorkspaceMeta } from "../../../../shared/types/workspace";
import { CliUsageError, exactArgs } from "../args";
import {
  type CliContext,
  CliError,
  describeLocation,
  mayChange,
  noteDispatch,
  pick,
  resolveWorkspace,
  shortId,
} from "../context";
import { table } from "../format";
import { absolutePath } from "../paths";
import { type CliCommand, output } from "../registry";
import { senderOf } from "../sender";
import { chatAgentFlag } from "./chat";
import { WORKSPACE_FLAG } from "./flags";
import { groupsOf } from "./layout";

/** A workspace as --json shows it. */
export function workspaceJson(ctx: CliContext, workspace: WorkspaceMeta) {
  const shown = ctx.services.shownTab();
  return {
    id: workspace.id,
    name: workspace.name,
    location: workspace.location,
    current: workspace.id === ctx.caller.workspaceId,
    shown: shown?.workspaceId === workspace.id,
    ...(workspace.task
      ? {
          worktree: {
            parentId: workspace.task.parentId,
            branch: workspace.task.branch,
            path: workspace.task.worktreePath,
          },
        }
      : {}),
  };
}

function marks(ctx: CliContext, workspace: WorkspaceMeta): string {
  const shown = ctx.services.shownTab();
  return [
    workspace.id === ctx.caller.workspaceId ? "current" : "",
    shown?.workspaceId === workspace.id ? "shown" : "",
  ]
    .filter(Boolean)
    .join(",");
}

/** Workspaces with each one's worktrees right under it. */
export function orderedWorkspaces(workspaces: readonly WorkspaceMeta[]): WorkspaceMeta[] {
  const roots = workspaces.filter((w) => !w.task);
  const ordered: WorkspaceMeta[] = [];
  for (const root of roots) {
    ordered.push(root, ...workspaces.filter((w) => w.task?.parentId === root.id));
  }
  // A worktree whose parent is gone still shows.
  for (const w of workspaces) if (!ordered.includes(w)) ordered.push(w);
  return ordered;
}

/**
 * The view the window shows, and in the agent view how many panels it
 * has; null when the window does not answer.
 */
async function viewSeen(ctx: CliContext): Promise<{ view: CliView; panels: number } | null> {
  try {
    const { view, root } = await ctx.services.ui("agentView.get", {});
    return { view, panels: groupsOf(root).length };
  } catch {
    return null;
  }
}

const status: CliCommand = {
  path: ["status"],
  summary: "Show where this terminal is and what the user is looking at",
  details:
    "In the agent view, the user sees the session in front of its active panel; nexus view\n" +
    "layout shows the rest.",
  async run(ctx) {
    const shown = ctx.services.shownTab();
    const shownWorkspace = shown
      ? ctx.services.listWorkspaces().find((w) => w.id === shown.workspaceId)
      : undefined;
    const seen = await viewSeen(ctx);
    const sees = `user sees: ${shownWorkspace ? `${shownWorkspace.name} (${shortId(shownWorkspace.id)}), tab ${shortId(shown?.tabId ?? "")}` : "nothing"}`;
    const viewLine = seen
      ? [
          `view:      ${
            seen.view === "agents"
              ? `the agent view, ${seen.panels} panel${seen.panels === 1 ? "" : "s"}`
              : "the workspaces"
          }`,
        ]
      : [];
    const viewJson = seen ? { view: seen.view } : {};
    if (isManager(ctx.caller)) {
      const text = [
        `NexusCode ${ctx.services.appVersion}`,
        "you are:   the agent manager, in no workspace",
        ...viewLine,
        sees,
      ].join("\n");
      return output(text, {
        version: ctx.services.appVersion,
        manager: true,
        ...viewJson,
        shown,
      });
    }
    const workspace = resolveWorkspace(ctx, undefined);
    const text = [
      `NexusCode ${ctx.services.appVersion}`,
      `workspace: ${workspace.name} (${shortId(workspace.id)}) ${describeLocation(workspace)}`,
      `terminal:  ${shortId(ctx.caller.tabId)}`,
      ...viewLine,
      sees,
    ].join("\n");
    return output(text, {
      version: ctx.services.appVersion,
      workspace: workspaceJson(ctx, workspace),
      tabId: ctx.caller.tabId,
      ...viewJson,
      shown,
    });
  },
};

const workspaceList: CliCommand = {
  path: ["workspace", "list"],
  summary: "List the workspaces and their worktrees",
  async run(ctx) {
    const workspaces = orderedWorkspaces(ctx.services.listWorkspaces());
    const rows = workspaces.map((w) => [
      shortId(w.id),
      w.task ? `  ${w.name}` : w.name,
      w.task ? `worktree:${w.task.branch}` : w.location.kind,
      marks(ctx, w),
      describeLocation(w),
    ]);
    return output(
      table(["ID", "NAME", "KIND", "", "LOCATION"], rows),
      workspaces.map((w) => workspaceJson(ctx, w)),
    );
  },
};

const workspaceCurrent: CliCommand = {
  path: ["workspace", "current"],
  summary: "Show this terminal's workspace",
  async run(ctx) {
    const workspace = resolveWorkspace(ctx, undefined);
    return output(
      `${workspace.name} (${workspace.id})\n${describeLocation(workspace)}`,
      workspaceJson(ctx, workspace),
    );
  },
};

/** Shows a workspace to the user. */
async function show(ctx: CliContext, workspace: WorkspaceMeta) {
  await ctx.services.ui("workspace.show", { workspaceId: workspace.id });
  return output(
    `Showing ${workspace.name} (${shortId(workspace.id)}).`,
    workspaceJson(ctx, workspace),
  );
}

const workspaceSwitch: CliCommand = {
  path: ["workspace", "switch"],
  summary: "Show a workspace or worktree to the user, as clicking it in the sidebar does",
  args: "<workspace>",
  async run(ctx, { positionals }) {
    const [selector] = exactArgs(positionals, "workspace") as [string];
    return show(ctx, resolveWorkspace(ctx, selector));
  },
};

/** A workspace and its worktrees: the one a worktree belongs to, or the workspace itself. */
function worktreeFamily(ctx: CliContext, workspace: WorkspaceMeta): WorkspaceMeta[] {
  const all = ctx.services.listWorkspaces();
  const root = workspace.task
    ? (all.find((w) => w.id === workspace.task?.parentId) ?? workspace)
    : workspace;
  return [root, ...all.filter((w) => w.task?.parentId === root.id)];
}

const worktreeList: CliCommand = {
  path: ["worktree", "list"],
  summary: "List a workspace's worktrees, the workspace itself first",
  flags: { workspace: WORKSPACE_FLAG },
  async run(ctx, { flags }) {
    const family = worktreeFamily(
      ctx,
      resolveWorkspace(ctx, flags.workspace as string | undefined),
    );
    const rows = family.map((w) => [
      shortId(w.id),
      w.name,
      w.task ? w.task.branch : "(workspace)",
      marks(ctx, w),
      w.task ? w.task.worktreePath : describeLocation(w),
    ]);
    return output(
      table(["ID", "NAME", "BRANCH", "", "PATH"], rows),
      family.map((w) => workspaceJson(ctx, w)),
    );
  },
};

const worktreeSwitch: CliCommand = {
  path: ["worktree", "switch"],
  summary: "Show one of this workspace's worktrees to the user",
  args: "<worktree>",
  details:
    "A worktree is named by id, id prefix, name or branch; the workspace they belong to, by\n" +
    "its id or name.",
  async run(ctx, { positionals }) {
    const [selector] = exactArgs(positionals, "worktree") as [string];
    return show(ctx, pickWorktree(worktreeFamily(ctx, resolveWorkspace(ctx, undefined)), selector));
  },
};

/** The one of a workspace and its worktrees `selector` names: by branch, id or name. */
function pickWorktree(family: readonly WorkspaceMeta[], selector: string): WorkspaceMeta {
  return (
    family.find((w) => w.task?.branch === selector) ??
    pick(
      family,
      selector,
      (w) => w.id,
      (w) => w.name,
      "worktree",
    )
  );
}

/** Making or removing a worktree waits on git, which a big repository keeps busy. */
const TASK_TIMEOUT_MS = 5 * 60_000;

const worktreeNew: CliCommand = {
  path: ["worktree", "new"],
  summary: "Make a worktree on a new branch, with an agent started in it",
  args: "<name>",
  details:
    "As New Task in the app: a branch named after <name> from the workspace's HEAD, its worktree,\n" +
    "and a Claude or Codex tab there that is sent --prompt as its first message: --agent's, else\n" +
    "the task agent's (Settings › Agents; Claude by default). --command runs a command in a\n" +
    "terminal instead, with --prompt as its last argument; an empty one opens a plain shell. It\n" +
    "starts behind the user's view unless --show. The tab's id is printed for chat wait/read/send\n" +
    "(a terminal's for terminal wait/read/send), which reach it with --workspace <its id>.",
  flags: {
    prompt: { type: "string", value: "TEXT", description: "The agent's first prompt" },
    agent: {
      type: "string",
      value: "AGENT",
      description: "Open a claude or codex tab instead of the task agent's",
    },
    command: {
      type: "string",
      value: "CMD",
      description: 'Run CMD in a terminal instead, as "gemini" or "claude --model opus"',
    },
    show: { type: "boolean", description: "Switch the user to it" },
    workspace: WORKSPACE_FLAG,
  },
  async run(ctx, { positionals, flags }) {
    const [name] = exactArgs(positionals, "name") as [string];
    const prompt = (flags.prompt as string | undefined) ?? "";
    if (flags.agent !== undefined && flags.command !== undefined) {
      throw new CliUsageError("--agent and --command do not go together");
    }
    const start: CliTaskStart | undefined =
      flags.command !== undefined
        ? { command: flags.command as string }
        : flags.agent !== undefined
          ? { agent: chatAgentFlag(flags.agent, "claude") }
          : undefined;
    // A worktree of a worktree branches off the workspace they belong to.
    const [parent] = worktreeFamily(
      ctx,
      resolveWorkspace(ctx, flags.workspace as string | undefined),
    ) as [WorkspaceMeta];
    // What the task would run and be told, shown whole to a user asked.
    const body = [flags.command as string | undefined, prompt]
      .filter((part): part is string => part !== undefined && part.trim() !== "")
      .join("\n\n");
    await mayChange(ctx, parent, {
      kind: "worktreeNew",
      detail: name,
      ...(body !== "" ? { body } : {}),
    });
    // An agent's prompt shows as its in the task's tab, and the agent there is told.
    const from = prompt.trim() !== "" ? await senderOf(ctx) : undefined;
    const created = await ctx.services.ui(
      "task.create",
      {
        parentId: parent.id,
        name,
        prompt,
        ...(start ? { start } : {}),
        show: flags.show === true,
        createdBy: ctx.caller,
        ...(from ? { from } : {}),
      },
      TASK_TIMEOUT_MS,
    );
    const { workspaceId, tabId } = created;
    const prompted = prompt.trim() !== "";
    if (prompted || ("command" in created.start && created.start.command !== "")) {
      await noteDispatch(ctx, { workspaceId, tabId }, prompted ? prompt.trim() : undefined);
    }
    const command = "command" in created.start ? created.start.command : undefined;
    if (command !== undefined && command !== "" && prompted) {
      ctx.services.startedAgents.mark({ workspaceId, tabId }, ctx.services.clock.now());
    }
    const made = ctx.services.listWorkspaces().find((w) => w.id === workspaceId);
    const where = made?.task ? ` on branch ${made.task.branch}, at ${made.task.worktreePath}` : "";
    // Its tab is in another workspace, which tab commands are told.
    const reach = `--workspace ${shortId(workspaceId)}`;
    const id = shortId(tabId);
    let runs: string;
    if ("agent" in created.start) {
      const tab = `Its ${created.start.agent === "claude" ? "Claude" : "Codex"} tab ${id}`;
      runs = prompted
        ? `${tab} was sent the prompt. To wait for it:\n  nexus chat wait ${id} ${reach}`
        : `${tab} waits for a message; chat commands reach it with ${reach}.`;
    } else if (command === "" || command === undefined) {
      runs = `Its terminal is ${id}; terminal commands reach it with ${reach}.`;
    } else {
      runs =
        `Its terminal ${id} runs ${command}${prompted ? " with the prompt" : ""}. To wait for it:\n` +
        `  nexus terminal wait ${id} ${reach}`;
    }
    return output(
      `Made worktree ${made?.name ?? name} (${shortId(workspaceId)})${where}.\n${runs}`,
      {
        ...(made ? workspaceJson(ctx, made) : { id: workspaceId, name }),
        tabId,
        ...created.start,
      },
    );
  },
};

/**
 * A task name for the worktree Claude Code names: a subagent's worktree is
 * "agent-" and its long id, which keeps its first seven characters, as a short
 * commit id does.
 */
export function claudeWorktreeName(name: string): string {
  const agent = /^agent-([0-9a-f]{8,})$/i.exec(name);
  return agent ? `agent-${agent[1].slice(0, 7)}` : name;
}

/** The folder Claude Code is to work in: the task's own, on its host. */
function taskFolder(task: WorkspaceMeta): string {
  return task.location.kind === "local" ? task.location.rootPath : task.location.remotePath;
}

/** The text of `key` in a Claude Code hook's JSON on stdin. */
function hookField(ctx: CliContext, event: string, key: string): string {
  let value: unknown;
  try {
    value = (JSON.parse(ctx.invocation.stdin ?? "") as Record<string, unknown>)[key];
  } catch {
    throw new CliError(`stdin is not the ${event} hook's JSON`);
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw new CliError(`the ${event} hook's JSON has no ${key}`);
  }
  return value.trim();
}

/** A folder as written, without the separators it may end in. */
const bare = (folder: string) => folder.replace(/(?<=.)[\\/]+$/, "");

const worktreeClaudeCreate: CliCommand = {
  path: ["worktree", "claude-create"],
  summary: "Make the worktree Claude Code asks for, as a task, and print its folder",
  args: "-",
  details:
    "Claude Code's WorktreeCreate hook, which the claude wrapper adds: the hook's JSON comes on\n" +
    "stdin. As worktree new with an empty --command, a task with a plain shell behind the\n" +
    "user's view; Claude Code works in the folder printed, so a worktree it makes for itself or\n" +
    "a subagent shows as a task.",
  hidden: true,
  async run(ctx, { positionals }) {
    const [source] = exactArgs(positionals, "-") as [string];
    if (source !== "-") throw new CliUsageError('give "-" to read the hook\'s JSON from stdin');
    const name = hookField(ctx, "WorktreeCreate", "name");
    const [parent] = worktreeFamily(ctx, resolveWorkspace(ctx, undefined)) as [WorkspaceMeta];
    await mayChange(ctx, parent, { kind: "worktreeNew", detail: name });
    const { workspaceId } = await ctx.services.ui(
      "task.create",
      {
        parentId: parent.id,
        name: claudeWorktreeName(name),
        prompt: "",
        start: { command: "" },
        show: false,
        createdBy: ctx.caller,
      },
      TASK_TIMEOUT_MS,
    );
    const made = ctx.services.listWorkspaces().find((w) => w.id === workspaceId);
    if (!made) throw new CliError("the worktree's task is gone");
    const folder = taskFolder(made);
    return output(folder, { ...workspaceJson(ctx, made), folder });
  },
};

const worktreeClaudeRemove: CliCommand = {
  path: ["worktree", "claude-remove"],
  summary: "Delete the worktree Claude Code is done with, made by claude-create",
  args: "-",
  details:
    "Claude Code's WorktreeRemove hook, which the claude wrapper adds: the hook's JSON comes on\n" +
    "stdin. Claude Code asks for it when a subagent's worktree is left with no changes, or when\n" +
    "the user has a worktree removed. The task at that folder goes as worktree remove takes it,\n" +
    "without --force, and its branch only if git finds it merged. One this terminal did not make\n" +
    "asks the user first. A folder no task has fails, so Claude Code keeps it.",
  hidden: true,
  async run(ctx, { positionals }) {
    const [source] = exactArgs(positionals, "-") as [string];
    if (source !== "-") throw new CliUsageError('give "-" to read the hook\'s JSON from stdin');
    const folder = bare(hookField(ctx, "WorktreeRemove", "worktree_path"));
    const target = worktreeFamily(ctx, resolveWorkspace(ctx, undefined)).find(
      (w) => w.task && [taskFolder(w), w.task.worktreePath].some((f) => bare(f) === folder),
    );
    const task = target?.task;
    if (!target || !task) throw new CliError(`no worktree of this workspace is at ${folder}`);
    if (target.id === ctx.caller.workspaceId) {
      throw new CliError("this terminal is in that worktree; remove it from another terminal");
    }
    const made = task.createdBy;
    if (made?.workspaceId !== ctx.caller.workspaceId || made.tabId !== ctx.caller.tabId) {
      await mayChange(ctx, target, { kind: "worktreeRemove" });
    }
    await ctx.services.ui(
      "task.remove",
      { taskId: target.id, force: false, deleteBranch: "merged" },
      TASK_TIMEOUT_MS,
    );
    return output(`Removed worktree ${target.name} (${shortId(target.id)}).`, {
      id: target.id,
      name: target.name,
      branch: task.branch,
      path: task.worktreePath,
    });
  },
};

const worktreeRemove: CliCommand = {
  path: ["worktree", "remove"],
  summary: "Delete a worktree with its terminals, and its branch if asked",
  args: "<worktree>",
  details:
    "As Delete Task in the app: its terminals close, programs running in them included, and its\n" +
    "folder is deleted. It is refused with uncommitted changes unless --force, and with unsaved\n" +
    "files. The branch stays unless --delete-branch. The user is asked first, as for other\n" +
    "changes outside this terminal's workspace.",
  flags: {
    force: {
      type: "boolean",
      description: "Delete it with its uncommitted changes, which are lost",
    },
    "delete-branch": { type: "boolean", description: "Delete its branch too" },
    workspace: WORKSPACE_FLAG,
  },
  async run(ctx, { positionals, flags }) {
    const [selector] = exactArgs(positionals, "worktree") as [string];
    const target = pickWorktree(
      worktreeFamily(ctx, resolveWorkspace(ctx, flags.workspace as string | undefined)),
      selector,
    );
    const task = target.task;
    if (!task) throw new CliError(`${target.name} is a workspace, not a worktree`);
    if (target.id === ctx.caller.workspaceId) {
      throw new CliError("this terminal is in that worktree; remove it from another terminal");
    }
    const deleteBranch = flags["delete-branch"] === true;
    await mayChange(ctx, target, {
      kind: deleteBranch ? "worktreeRemoveBranch" : "worktreeRemove",
    });
    await ctx.services.ui(
      "task.remove",
      { taskId: target.id, force: flags.force === true, deleteBranch },
      TASK_TIMEOUT_MS,
    );
    const removed = `Removed worktree ${target.name} (${shortId(target.id)})`;
    const text = deleteBranch
      ? `${removed} and branch ${task.branch}.`
      : `${removed}; branch ${task.branch} is kept.`;
    return output(text, {
      id: target.id,
      name: target.name,
      branch: task.branch,
      path: task.worktreePath,
      branchDeleted: deleteBranch,
    });
  },
};

/** A folder on the host `beside`'s workspace is on, reached the same way. */
function locationBeside(beside: WorkspaceLocation, folder: string): WorkspaceLocation {
  return beside.kind === "local"
    ? { kind: "local", rootPath: folder }
    : { ...beside, remotePath: folder };
}

const workspaceAdd: CliCommand = {
  path: ["workspace", "add"],
  summary: "Add a folder to the app as a workspace, on this terminal's host",
  args: "<folder>",
  details:
    "As Add Workspace in the app: the folder, from this terminal's directory, goes at the end\n" +
    "of the sidebar, named after it unless --name. An SSH or WSL terminal adds a folder on its\n" +
    "own host, reached as its workspace is. It connects once it is first shown, so --show it\n" +
    "or click it. A folder already in the list gives that workspace.",
  flags: {
    name: { type: "string", value: "NAME", description: "The name the sidebar shows" },
    show: { type: "boolean", description: "Show it to the user" },
  },
  async run(ctx, { positionals, flags }) {
    const [input] = exactArgs(positionals, "folder") as [string];
    const caller = resolveWorkspace(ctx, undefined);
    const location = locationBeside(caller.location, absolutePath(ctx, caller, input));
    const name = (flags.name as string | undefined)?.trim() || undefined;
    const { workspace, added } = await ctx.services.addWorkspace(location, name);
    if (flags.show === true) await ctx.services.ui("workspace.show", { workspaceId: workspace.id });
    const what = added ? "Added" : "Already listed";
    return output(
      `${what}: ${workspace.name} (${shortId(workspace.id)}) ${describeLocation(workspace)}`,
      { ...workspaceJson(ctx, workspace), added },
    );
  },
};

const workspaceRemove: CliCommand = {
  path: ["workspace", "remove"],
  summary: "Remove a workspace and its worktrees' tasks from the app, keeping the folders",
  args: "<workspace>",
  details:
    "As Remove Workspace in the app: its terminals and those of its worktrees close, programs\n" +
    "running in them included, and they leave the sidebar. No folder is deleted: the\n" +
    "worktrees stay on disk with their branches. It is refused with unsaved files, and for\n" +
    "this terminal's own workspace. The user is asked first, as for other changes outside\n" +
    "this terminal's workspace. A worktree goes with nexus worktree remove.",
  async run(ctx, { positionals }) {
    const [selector] = exactArgs(positionals, "workspace") as [string];
    const target = resolveWorkspace(ctx, selector);
    if (target.task) {
      throw new CliError(`${target.name} is a worktree; remove it with nexus worktree remove`);
    }
    const family = worktreeFamily(ctx, target);
    if (family.some((w) => w.id === ctx.caller.workspaceId)) {
      throw new CliError("this terminal is in that workspace; remove it from another terminal");
    }
    await mayChange(ctx, target, { kind: "workspaceRemove" });
    await ctx.services.ui("workspace.remove", { workspaceId: target.id }, TASK_TIMEOUT_MS);
    const tasks = family.length - 1;
    const withTasks = tasks > 0 ? ` with its ${tasks} worktree task${tasks === 1 ? "" : "s"}` : "";
    return output(
      `Removed workspace ${target.name} (${shortId(target.id)})${withTasks}; folders are kept.`,
      {
        id: target.id,
        name: target.name,
        location: target.location,
        tasks: family.slice(1).map((w) => w.id),
      },
    );
  },
};

export const workspaceCommands: CliCommand[] = [
  status,
  workspaceList,
  workspaceCurrent,
  workspaceSwitch,
  workspaceAdd,
  workspaceRemove,
  worktreeList,
  worktreeSwitch,
  worktreeNew,
  worktreeClaudeCreate,
  worktreeClaudeRemove,
  worktreeRemove,
];

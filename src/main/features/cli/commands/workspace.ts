/** nexus status, nexus workspace ... and nexus worktree ... (the app's tasks). */
import type { WorkspaceMeta } from "../../../../shared/types/workspace";
import { exactArgs } from "../args";
import {
  type CliContext,
  CliError,
  describeLocation,
  mayChange,
  pick,
  resolveWorkspace,
  shortId,
} from "../context";
import { table } from "../format";
import { type CliCommand, output } from "../registry";
import { WORKSPACE_FLAG } from "./flags";

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

const status: CliCommand = {
  path: ["status"],
  summary: "Show where this terminal is and what the user is looking at",
  async run(ctx) {
    const workspace = resolveWorkspace(ctx, undefined);
    const shown = ctx.services.shownTab();
    const shownWorkspace = shown
      ? ctx.services.listWorkspaces().find((w) => w.id === shown.workspaceId)
      : undefined;
    const text = [
      `NexusCode ${ctx.services.appVersion}`,
      `workspace: ${workspace.name} (${shortId(workspace.id)}) ${describeLocation(workspace)}`,
      `terminal:  ${shortId(ctx.caller.tabId)}`,
      `user sees: ${shownWorkspace ? `${shownWorkspace.name} (${shortId(shownWorkspace.id)}), tab ${shortId(shown?.tabId ?? "")}` : "nothing"}`,
    ].join("\n");
    return output(text, {
      version: ctx.services.appVersion,
      workspace: workspaceJson(ctx, workspace),
      tabId: ctx.caller.tabId,
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
    "and a terminal there running the task agent command (Settings › Terminal; claude by\n" +
    "default), or --command, with --prompt as its last argument; an empty --command opens a\n" +
    "plain shell. It starts behind the user's view unless --show. Its terminal's id is printed\n" +
    "for terminal wait/read/send, which reach it with --workspace <its id>.",
  flags: {
    prompt: { type: "string", value: "TEXT", description: "The agent's first prompt" },
    command: {
      type: "string",
      value: "CMD",
      description: 'Run CMD, as "codex -m MODEL", instead of the task agent command',
    },
    show: { type: "boolean", description: "Switch the user to it" },
    workspace: WORKSPACE_FLAG,
  },
  async run(ctx, { positionals, flags }) {
    const [name] = exactArgs(positionals, "name") as [string];
    const prompt = (flags.prompt as string | undefined) ?? "";
    // A worktree of a worktree branches off the workspace they belong to.
    const [parent] = worktreeFamily(
      ctx,
      resolveWorkspace(ctx, flags.workspace as string | undefined),
    ) as [WorkspaceMeta];
    await mayChange(ctx, parent, { kind: "worktreeNew", detail: name });
    const { workspaceId, tabId, command } = await ctx.services.ui(
      "task.create",
      {
        parentId: parent.id,
        name,
        prompt,
        ...(flags.command === undefined ? {} : { command: flags.command as string }),
        show: flags.show === true,
        createdBy: ctx.caller,
      },
      TASK_TIMEOUT_MS,
    );
    const made = ctx.services.listWorkspaces().find((w) => w.id === workspaceId);
    const where = made?.task ? ` on branch ${made.task.branch}, at ${made.task.worktreePath}` : "";
    // Its terminal is in another workspace, which terminal commands are told.
    const reach = `--workspace ${shortId(workspaceId)}`;
    const runs =
      command === ""
        ? `Its terminal is ${shortId(tabId)}; terminal commands reach it with ${reach}.`
        : `Its terminal ${shortId(tabId)} runs ${command}${prompt.trim() === "" ? "" : " with the prompt"}. To wait for it:\n` +
          `  nexus terminal wait ${shortId(tabId)} ${reach}`;
    return output(
      `Made worktree ${made?.name ?? name} (${shortId(workspaceId)})${where}.\n${runs}`,
      {
        ...(made ? workspaceJson(ctx, made) : { id: workspaceId, name }),
        tabId,
        command,
      },
    );
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
    force: { type: "boolean", description: "Delete it with its uncommitted changes, which are lost" },
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

export const workspaceCommands: CliCommand[] = [
  status,
  workspaceList,
  workspaceCurrent,
  workspaceSwitch,
  worktreeList,
  worktreeSwitch,
  worktreeNew,
  worktreeRemove,
];

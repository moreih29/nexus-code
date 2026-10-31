/** nexus status, nexus workspace ... and nexus worktree ... . */
import type { WorkspaceMeta } from "../../../../shared/types/workspace";
import { exactArgs } from "../args";
import { type CliContext, describeLocation, pick, resolveWorkspace, shortId } from "../context";
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
    const family = worktreeFamily(ctx, resolveWorkspace(ctx, undefined));
    const target =
      family.find((w) => w.task?.branch === selector) ??
      pick(
        family,
        selector,
        (w) => w.id,
        (w) => w.name,
        "worktree",
      );
    return show(ctx, target);
  },
};

export const workspaceCommands: CliCommand[] = [
  status,
  workspaceList,
  workspaceCurrent,
  workspaceSwitch,
  worktreeList,
  worktreeSwitch,
];

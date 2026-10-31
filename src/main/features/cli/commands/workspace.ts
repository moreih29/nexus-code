/** nexus status, nexus workspace list and nexus workspace current. */
import type { WorkspaceMeta } from "../../../../shared/types/workspace";
import { type CliContext, describeLocation, resolveWorkspace, shortId } from "../context";
import { table } from "../format";
import { type CliCommand, output } from "../registry";

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

export const workspaceCommands: CliCommand[] = [status, workspaceList, workspaceCurrent];

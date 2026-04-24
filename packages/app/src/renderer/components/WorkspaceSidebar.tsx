import type { WorkspaceId } from "../../../../shared/src/contracts/workspace";
import type { WorkspaceSidebarState } from "../../../../shared/src/contracts/workspace-shell";
import { cn } from "../lib/utils";

export interface WorkspaceSidebarProps {
  sidebarState: WorkspaceSidebarState;
  onOpenFolder(): Promise<void>;
  onActivateWorkspace(workspaceId: WorkspaceId): Promise<void>;
  onCloseWorkspace(workspaceId: WorkspaceId): Promise<void>;
}

export function WorkspaceSidebar({
  sidebarState,
  onOpenFolder,
  onActivateWorkspace,
  onCloseWorkspace,
}: WorkspaceSidebarProps): JSX.Element {
  return (
    <section data-component="workspace-sidebar" className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center justify-between gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-200">Workspaces</h2>
        <button
          type="button"
          data-action="open-folder"
          className="rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-[11px] font-semibold text-slate-200 hover:border-slate-500"
          onClick={() => {
            void onOpenFolder();
          }}
        >
          Open Folder…
        </button>
      </header>

      <ol className="mt-3 flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
        {sidebarState.openWorkspaces.map((workspace) => {
          const isActive = workspace.id === sidebarState.activeWorkspaceId;

          return (
            <li key={workspace.id} className="rounded-md border border-slate-800 bg-slate-900/60 p-1">
              <div className="flex items-start gap-1">
                <button
                  type="button"
                  data-action="activate-workspace"
                  data-workspace-id={workspace.id}
                  data-active={isActive ? "true" : "false"}
                  aria-current={isActive ? "page" : "false"}
                  className={cn(
                    "flex min-w-0 flex-1 flex-col items-start rounded px-2 py-1 text-left text-xs text-slate-300 hover:bg-slate-800",
                    isActive && "bg-slate-800 text-sky-200",
                  )}
                  onClick={() => {
                    void onActivateWorkspace(workspace.id);
                  }}
                >
                  <span className="w-full truncate font-semibold">{workspace.displayName}</span>
                  <small className="w-full truncate text-[10px] text-slate-400">{workspace.absolutePath}</small>
                </button>
                <button
                  type="button"
                  data-action="close-workspace"
                  data-workspace-id={workspace.id}
                  aria-label={`Close ${workspace.displayName}`}
                  className="rounded px-2 py-1 text-xs text-slate-400 hover:bg-slate-800 hover:text-slate-200"
                  onClick={() => {
                    void onCloseWorkspace(workspace.id);
                  }}
                >
                  ×
                </button>
              </div>
            </li>
          );
        })}

        {sidebarState.openWorkspaces.length === 0 ? (
          <li className="rounded-md border border-dashed border-slate-700 bg-slate-900/40 px-3 py-2 text-xs text-slate-400">
            No workspace is open yet.
          </li>
        ) : null}
      </ol>
    </section>
  );
}

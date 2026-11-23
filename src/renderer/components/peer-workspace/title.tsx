// The title bar's name of a workspace on another computer, as a local
// one's task switcher: the workspace, then the task shown after a branch
// mark, and the computer it is on; always a menu. The menu lists the
// workspace and its tasks, each with its state and branch, then the agent
// list. A task is not made or removed from here.

import { Check, ChevronDown, GitBranch } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { RemoteSession, RemoteWorkspace } from "../../../../packages/remote-protocol/src/rpc";
import { selectPeerWorkspace } from "../../state/operations/workspace-selection";
import {
  type PeerWorkspaceTarget,
  peerTargetId,
  usePeerWorkspaceStore,
} from "../../state/stores/peer-workspace";
import { useUIStore } from "../../state/stores/ui";
import { cn } from "../../utils/cn";
import { WorkspaceStatusGlyph } from "../sidebar/workspace-status-glyph";
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRoot,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { PeerDeviceIcon, PeerWorkspaceBranch } from "./sidebar";
import { peerWorkspaceStatus } from "./workspace-status";

export function PeerWorkspaceTitle({
  target,
  workspaces,
  sessions,
  canSelectTask,
  maxWidth,
}: {
  target: PeerWorkspaceTarget;
  workspaces?: readonly RemoteWorkspace[];
  /** That computer's sessions, for each workspace's state in the menu. */
  sessions?: readonly RemoteSession[];
  canSelectTask: boolean;
  maxWidth?: number;
}) {
  const { t } = useTranslation();
  const { workspace, deviceName, platform } = target;
  const parentId = workspace.parentId ?? workspace.id;
  const listed = workspaces?.filter((item) => item.id === parentId || item.parentId === parentId);
  const choices: readonly RemoteWorkspace[] = listed?.length ? listed : [workspace];
  const root = choices.find((item) => item.id === parentId);
  const isTask = workspace.parentId !== undefined;
  const rootName = root?.name ?? (isTask ? undefined : workspace.name);
  const style = maxWidth === undefined ? undefined : { maxWidth: `min(40%, ${maxWidth}px)` };

  return (
    <DropdownMenuRoot>
      <DropdownMenuTrigger>
        <button
          type="button"
          aria-label={t("task.switcher_aria")}
          title={rootName ?? workspace.name}
          className={cn(
            "app-no-drag absolute left-1/2 flex h-7 max-w-[40%] -translate-x-1/2 items-center gap-1.5 whitespace-nowrap rounded-(--radius-control) px-2 text-app-body-emphasis text-foreground",
            "transition-colors duration-150 hover:bg-[var(--state-hover-bg)] data-[state=open]:bg-[var(--state-active-bg)]",
          )}
          style={style}
        >
          {rootName && <span className="truncate">{rootName}</span>}
          {isTask && (
            <>
              {rootName && (
                <GitBranch className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              )}
              <span className="truncate">{workspace.name}</span>
            </>
          )}
          {/* Which computer it is on, and that it is only looked at, as the workbench tells. */}
          <span
            className="inline-flex h-[18px] min-w-0 items-center gap-1 rounded-full border border-border px-1.5 text-app-micro text-muted-foreground"
            title={`${deviceName} · ${t("peerWorkspace.readOnly")}`}
          >
            <PeerDeviceIcon platform={platform} className="size-3 shrink-0" />
            <span className="max-w-32 truncate">{deviceName}</span>
          </span>
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="center">
        {choices.map((item) => {
          const status = sessions ? peerWorkspaceStatus(sessions, new Set([item.id])) : null;
          return (
            <DropdownMenuItem
              key={item.id}
              disabled={!canSelectTask && item.id !== workspace.id}
              onSelect={() =>
                selectPeerWorkspace({ ...target, workspace: item, workspaceId: item.id })
              }
            >
              <span className="flex min-w-0 items-center gap-2">
                <span className="inline-flex size-3.5 shrink-0 items-center justify-center">
                  {item.id === workspace.id && <Check className="size-3.5" aria-hidden="true" />}
                </span>
                <span className="max-w-60 truncate">{item.name}</span>
                {status && <WorkspaceStatusGlyph status={status} />}
              </span>
              <span className="ml-3 max-w-40">
                <PeerWorkspaceBranch git={item.git} />
              </span>
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => {
            usePeerWorkspaceStore.getState().setFilesMode(peerTargetId(target), "agents");
            useUIStore.getState().setPanelHidden("files", false);
          }}
        >
          {t("task.show_agent_list")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenuRoot>
  );
}

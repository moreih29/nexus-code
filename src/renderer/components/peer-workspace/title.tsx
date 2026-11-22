import { Check, ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { RemoteWorkspace } from "../../../../packages/remote-protocol/src/rpc";
import { selectPeerWorkspace } from "../../state/operations/workspace-selection";
import type { PeerWorkspaceTarget } from "../../state/stores/peer-workspace";
import { cn } from "../../utils/cn";
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRoot,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { PeerDeviceIcon, PeerWorkspaceBranch } from "./sidebar";

export function PeerWorkspaceTitle({
  target,
  workspaces,
  canSelectTask,
  maxWidth,
}: {
  target: PeerWorkspaceTarget;
  workspaces?: readonly RemoteWorkspace[];
  canSelectTask: boolean;
  maxWidth?: number;
}) {
  const { t } = useTranslation();
  const { workspace, deviceName, platform } = target;
  const parentId = workspace.parentId ?? workspace.id;
  const choices = workspaces?.filter((item) => item.id === parentId || item.parentId === parentId);
  const hasMenu = canSelectTask && choices !== undefined && choices.length > 1;
  const className = cn(
    "absolute left-1/2 flex h-7 max-w-[40%] -translate-x-1/2 items-center gap-1.5 whitespace-nowrap rounded-(--radius-control) px-2 text-app-body-emphasis text-foreground",
    hasMenu &&
      "app-no-drag hover:bg-[var(--state-hover-bg)] data-[state=open]:bg-[var(--state-active-bg)]",
  );
  const style = maxWidth === undefined ? undefined : { maxWidth: `min(40%, ${maxWidth}px)` };
  const label = (
    <>
      <span className="truncate" title={workspace.name}>
        {workspace.name}
      </span>
      <span
        className="app-no-drag inline-flex h-[18px] min-w-0 items-center gap-1 rounded-full border border-border px-1.5 text-app-micro text-muted-foreground"
        title={`${deviceName} · ${t("peerWorkspace.readOnly")}`}
      >
        <PeerDeviceIcon platform={platform} className="size-3 shrink-0" />
        <span className="max-w-32 truncate">{deviceName}</span>
      </span>
    </>
  );
  if (!hasMenu)
    return (
      <div className={className} style={style}>
        {label}
      </div>
    );

  return (
    <DropdownMenuRoot>
      <DropdownMenuTrigger>
        <button
          type="button"
          aria-label={t("task.switcher_aria")}
          className={className}
          style={style}
        >
          {label}
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="center">
        {choices.map((item) => (
          <DropdownMenuItem
            key={item.id}
            onSelect={() =>
              selectPeerWorkspace({ ...target, workspace: item, workspaceId: item.id })
            }
          >
            <span className="flex min-w-0 items-center gap-2">
              <span className="inline-flex size-3.5 shrink-0 items-center justify-center">
                {item.id === workspace.id && <Check className="size-3.5" aria-hidden="true" />}
              </span>
              <span className="max-w-60 truncate">{item.name}</span>
            </span>
            <span className="ml-3 max-w-40">
              <PeerWorkspaceBranch git={item.git} />
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenuRoot>
  );
}

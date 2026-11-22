import { Folder } from "lucide-react";
import { useTranslation } from "react-i18next";
import { type PeerWorkspaceTarget, peerTargetId } from "../../state/stores/peer-workspace";
import { Button } from "../ui/button";
import { EmptyState } from "../ui/empty-state";
import { PeerFileTree } from "./file-tree";

export function PeerFilesPanel({
  target,
  missing,
  canRead,
  updateNeeded,
  rejoin,
}: {
  target: PeerWorkspaceTarget;
  missing: boolean;
  canRead: boolean;
  updateNeeded: boolean;
  rejoin: number;
}) {
  const { t } = useTranslation();
  const label = t("files:panel.tab.tree");
  return (
    <>
      <div className="flex items-center border-b border-border/50 px-2 py-2">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          title={label}
          aria-pressed
          className="relative bg-[var(--sidebar-item-selected-bg)] text-foreground after:absolute after:inset-x-1.5 after:bottom-0 after:h-0.5 after:rounded-full after:bg-[var(--state-selected-indicator)]"
          onClick={(event) =>
            event.currentTarget
              .closest("aside")
              ?.querySelector<HTMLElement>('[role="tree"]')
              ?.focus()
          }
        >
          <Folder aria-hidden="true" />
        </Button>
      </div>
      {missing || updateNeeded ? (
        <EmptyState
          title={t(missing ? "peerWorkspace.missingWorkspace" : "peerWorkspace.updateNeeded")}
          tone="status"
        />
      ) : (
        <PeerFileTree
          key={JSON.stringify([peerTargetId(target), target.workspace.path])}
          target={target}
          canRead={canRead}
          rejoin={rejoin}
        />
      )}
    </>
  );
}

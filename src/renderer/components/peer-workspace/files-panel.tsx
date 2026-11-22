import { Folder, Search } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { PeerWorkspaceTarget } from "../../state/stores/peer-workspace";
import { cn } from "../../utils/cn";
import { Button } from "../ui/button";
import { EmptyState } from "../ui/empty-state";
import { KeptMounted } from "../ui/kept-mounted";
import { PeerFileTree } from "./file-tree";
import { PeerSearchPanel } from "./search-panel";

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
  const [mode, setMode] = useState<"tree" | "search">("tree");
  return (
    <>
      <div className="flex items-center gap-1 border-b border-border/50 px-2 py-2">
        {(
          [
            { value: "tree", label: t("files:panel.tab.tree"), Icon: Folder },
            { value: "search", label: t("files:panel.tab.search"), Icon: Search },
          ] as const
        ).map(({ value, label, Icon }) => (
          <Button
            key={value}
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            title={label}
            aria-pressed={mode === value}
            className={cn(
              "relative",
              mode === value &&
                "bg-[var(--sidebar-item-selected-bg)] text-foreground after:absolute after:inset-x-1.5 after:bottom-0 after:h-0.5 after:rounded-full after:bg-[var(--state-selected-indicator)]",
            )}
            onClick={() => setMode(value)}
          >
            <Icon aria-hidden="true" />
          </Button>
        ))}
      </div>
      {missing || updateNeeded ? (
        <EmptyState
          title={t(missing ? "peerWorkspace.missingWorkspace" : "peerWorkspace.updateNeeded")}
          tone="status"
        />
      ) : (
        <>
          <KeptMounted shown={mode === "tree"}>
            <PeerFileTree target={target} canRead={canRead && mode === "tree"} rejoin={rejoin} />
          </KeptMounted>
          <KeptMounted shown={mode === "search"}>
            <PeerSearchPanel
              target={target}
              canRead={canRead && mode === "search"}
              rejoin={rejoin}
            />
          </KeptMounted>
        </>
      )}
    </>
  );
}

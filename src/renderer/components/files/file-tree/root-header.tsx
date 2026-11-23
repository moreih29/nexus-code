import { ChevronRight, ChevronsDownUp, FilePlus, FolderPlus, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import { basename } from "@/utils/path";
import { toNativeDrivePath } from "../../../../shared/fs/drive-path";
import { IconButton } from "../../ui/icon-button";

interface WorkspaceRootHeaderProps {
  rootAbsPath: string;
  isExpanded: boolean;
  onToggle: () => void;
  onNewFile?: () => void;
  onNewFolder?: () => void;
  onRefresh: () => void;
  onCollapseAll: () => void;
  onContextMenu: (e: React.MouseEvent<HTMLDivElement>) => void;
}

interface ActionButtonProps {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}

function ActionButton({ label, onClick, children }: ActionButtonProps) {
  return (
    <IconButton
      label={label}
      size="xs"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="active:bg-[var(--state-active-bg)]"
    >
      {children}
    </IconButton>
  );
}

export function WorkspaceRootHeader({
  rootAbsPath,
  isExpanded,
  onToggle,
  onNewFile,
  onNewFolder,
  onRefresh,
  onCollapseAll,
  onContextMenu,
}: WorkspaceRootHeaderProps) {
  const { t } = useTranslation("files");
  const name = basename(rootAbsPath) || rootAbsPath;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: right-click delegation on a header strip — keyboard users access the same context menu via Menu key on the focused button below.
    <header
      className={cn(
        "flex h-6 shrink-0 items-center gap-1 pl-2 pr-1.5",
        "border-b border-border/50 select-none",
      )}
      onContextMenu={onContextMenu}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isExpanded}
        title={toNativeDrivePath(rootAbsPath)}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-1 text-left",
          "outline-none focus-visible:ring-[2px] focus-visible:ring-ring/50 rounded-(--radius-control)",
        )}
      >
        <ChevronRight
          aria-hidden="true"
          strokeWidth={1.5}
          className={cn(
            "size-3 shrink-0 text-muted-foreground transition-transform",
            isExpanded && "rotate-90",
          )}
        />
        <span className="truncate text-app-ui-sm font-medium">{name}</span>
      </button>

      <div
        className={cn(
          "flex shrink-0 items-center gap-0.5",
          "opacity-0 transition-opacity",
          "group-hover/filetree:opacity-100 focus-within:opacity-100",
        )}
      >
        {onNewFile && (
          <ActionButton label={t("fileTree.header.newFile")} onClick={onNewFile}>
            <FilePlus aria-hidden className="size-3.5" />
          </ActionButton>
        )}
        {onNewFolder && (
          <ActionButton label={t("fileTree.header.newFolder")} onClick={onNewFolder}>
            <FolderPlus aria-hidden className="size-3.5" />
          </ActionButton>
        )}
        <ActionButton label={t("fileTree.header.refresh")} onClick={onRefresh}>
          <RefreshCw aria-hidden className="size-3.5" />
        </ActionButton>
        <ActionButton label={t("fileTree.header.collapse")} onClick={onCollapseAll}>
          <ChevronsDownUp aria-hidden className="size-3.5" />
        </ActionButton>
      </div>
    </header>
  );
}

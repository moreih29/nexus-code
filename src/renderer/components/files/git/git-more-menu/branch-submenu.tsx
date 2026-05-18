/**
 * Branch flyout for GitMoreMenu. Items are driven by the shared menu model so
 * enablement (e.g. requires HEAD) lives next to other Git menu decisions
 * rather than inline in this view.
 */
import { ChevronRight } from "lucide-react";
import { useRef } from "react";
import { createPortal } from "react-dom";
import { useSubmenuPlacement } from "../../../ui/use-submenu-placement";
import {
  buildGitBranchMenuModel,
  type GitBranchMenuActionHandlers,
  runGitBranchMenuAction,
} from "../utils/git-more-menu-model";
import { MenuButton, MenuSeparator, PORTAL_MARKER } from "./menu-primitives";

export function BranchSubmenu({
  open,
  disabled,
  hasHead,
  onOpenChange,
  onMergeBranch,
  onRebaseBranch,
  onCreateBranch,
  onCreateBranchFrom,
  onRenameBranch,
  onDeleteBranch,
  onDeleteRemoteBranch,
}: {
  open: boolean;
  disabled?: boolean;
  hasHead: boolean;
  onOpenChange: (open: boolean) => void;
  onMergeBranch: () => void;
  onRebaseBranch: () => void;
  onCreateBranch: () => void;
  onCreateBranchFrom: () => void;
  onRenameBranch: () => void;
  onDeleteBranch: () => void;
  onDeleteRemoteBranch: () => void;
}) {
  const model = buildGitBranchMenuModel({ disabled, hasHead });
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const { panelRef, style } = useSubmenuPlacement(open, triggerRef);
  const handlers: GitBranchMenuActionHandlers = {
    onMergeBranch,
    onRebaseBranch,
    onCreateBranch,
    onCreateBranchFrom,
    onRenameBranch,
    onDeleteBranch,
    onDeleteRemoteBranch,
  };

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        className="flex w-full items-center justify-between gap-3 rounded-(--radius-control) px-2 py-1 text-left text-app-ui-sm text-foreground hover:bg-[var(--state-hover-bg)] focus-visible:bg-[var(--state-hover-bg)] focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
        onClick={() => onOpenChange(!open)}
      >
        <span>Branch</span>
        <ChevronRight className="size-3.5" aria-hidden="true" />
      </button>
      {open
        ? createPortal(
            <div
              ref={panelRef}
              role="menu"
              data-popover-root={PORTAL_MARKER}
              style={style}
              className="z-50 max-h-[40vh] min-w-[220px] overflow-y-auto rounded border border-border bg-popover p-1 text-popover-foreground shadow-none"
            >
              {model.map((item) =>
                item.kind === "separator" ? (
                  <MenuSeparator key={item.id} />
                ) : (
                  <MenuButton
                    key={item.id}
                    label={item.label}
                    disabled={item.disabled}
                    title={item.title}
                    onClick={() => runGitBranchMenuAction(item.id, handlers)}
                  />
                ),
              )}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

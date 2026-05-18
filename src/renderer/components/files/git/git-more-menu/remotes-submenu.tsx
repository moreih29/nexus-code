/**
 * Remotes flyout for GitMoreMenu, including the read-only current-remote
 * list, the Add Remote action, and a nested Remove Remote picker that lets
 * the user explicitly choose which remote to delete before the parent
 * dialog appears.
 */
import { ChevronRight } from "lucide-react";
import { useRef } from "react";
import { createPortal } from "react-dom";
import { useSubmenuPlacement } from "../../../ui/use-submenu-placement";
import { buildGitRemotesMenuModel } from "../utils/git-more-menu-model";
import { MenuButton, MenuSeparator, PORTAL_MARKER } from "./menu-primitives";

export function RemotesSubmenu({
  open,
  removeOpen,
  remotes,
  disabled,
  onOpenChange,
  onRemoveOpenChange,
  onAddRemote,
  onRemoveRemote,
}: {
  open: boolean;
  removeOpen: boolean;
  remotes: readonly string[];
  disabled?: boolean;
  onOpenChange: (open: boolean) => void;
  onRemoveOpenChange: (open: boolean) => void;
  onAddRemote: () => void;
  onRemoveRemote: (remote: string) => void;
}) {
  const model = buildGitRemotesMenuModel(remotes);
  const currentRemotes = model.filter((item) => item.kind === "remote" || item.kind === "empty");
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const { panelRef, style } = useSubmenuPlacement(open, triggerRef);

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
        <span>Remote</span>
        <ChevronRight className="size-3.5" aria-hidden="true" />
      </button>
      {open
        ? createPortal(
            <div
              ref={panelRef}
              role="menu"
              data-popover-root={PORTAL_MARKER}
              style={style}
              className="floating-panel z-50 min-w-[188px] p-1"
            >
              <div className="max-h-[40vh] overflow-y-auto">
                {currentRemotes.map((item) =>
                  item.kind === "remote" ? (
                    <RemoteLabel key={item.remote} label={item.label} />
                  ) : (
                    <RemoteLabel key="empty" label={item.label} muted />
                  ),
                )}
              </div>
              <MenuSeparator />
              <MenuButton label="Add remote…" onClick={onAddRemote} disabled={disabled} />
              <RemoveRemoteSubmenu
                open={removeOpen}
                remotes={remotes}
                disabled={disabled || remotes.length === 0}
                onOpenChange={onRemoveOpenChange}
                onRemoveRemote={onRemoveRemote}
              />
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

/** Renders a non-clickable current-remote row in the Remotes submenu. */
function RemoteLabel({ label, muted = false }: { label: string; muted?: boolean }) {
  return (
    <div
      className={
        muted
          ? "flex w-full rounded-(--radius-control) px-2 py-1 text-left text-app-ui-sm text-muted-foreground"
          : "flex w-full rounded-(--radius-control) px-2 py-1 text-left text-app-ui-sm text-foreground"
      }
    >
      {label}
    </div>
  );
}

/**
 * Renders the remove-remote picker nested under the Remotes flyout.
 * This component is rendered inside the RemotesSubmenu portal, so it does
 * NOT need its own portal — it is already in the body-level stacking
 * context. Its nested submenu panel IS portaled separately.
 */
function RemoveRemoteSubmenu({
  open,
  remotes,
  disabled,
  onOpenChange,
  onRemoveRemote,
}: {
  open: boolean;
  remotes: readonly string[];
  disabled?: boolean;
  onOpenChange: (open: boolean) => void;
  onRemoveRemote: (remote: string) => void;
}) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const { panelRef, style } = useSubmenuPlacement(open, triggerRef);

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        title={remotes.length === 0 ? "No remotes configured." : undefined}
        className="flex w-full items-center justify-between gap-3 rounded-(--radius-control) px-2 py-1 text-left text-app-ui-sm text-foreground hover:bg-[var(--state-hover-bg)] focus-visible:bg-[var(--state-hover-bg)] focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
        onClick={() => onOpenChange(!open)}
      >
        <span>Remove remote…</span>
        <ChevronRight className="size-3.5" aria-hidden="true" />
      </button>
      {open
        ? createPortal(
            <div
              ref={panelRef}
              role="menu"
              data-popover-root={PORTAL_MARKER}
              style={style}
              className="floating-panel z-50 max-h-[40vh] min-w-[152px] overflow-y-auto p-1"
            >
              {remotes.map((remote) => (
                <MenuButton key={remote} label={remote} onClick={() => onRemoveRemote(remote)} />
              ))}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

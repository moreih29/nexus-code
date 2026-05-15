/**
 * Tag flyout for GitMoreMenu plus its two nested remote-picker submenus.
 * Tag entries route to either the existing picker dialog or, when multiple
 * remotes are configured, into a second-level remote chooser that becomes
 * the next click target.
 */
import { ChevronRight } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useSubmenuPlacement } from "../../../ui/use-submenu-placement";
import {
  buildGitTagMenuModel,
  type GitTagMenuActionHandlers,
  type GitTagMenuItemId,
  type GitTagPickerMenuMode,
  resolveGitDeleteRemoteTagAction,
  resolveGitPushTagsAction,
  runGitTagMenuAction,
} from "../git-more-menu-model";
import { MenuButton, MenuSeparator, PORTAL_MARKER } from "./menu-primitives";

export function TagSubmenu({
  open,
  disabled,
  hasHead,
  remotes,
  onOpenChange,
  onOpenTags,
  onPushTags,
}: {
  open: boolean;
  disabled?: boolean;
  hasHead: boolean;
  remotes: readonly string[];
  onOpenChange: (open: boolean) => void;
  onOpenTags: (mode: GitTagPickerMenuMode, remote?: string) => void;
  onPushTags: (remote: string) => void;
}) {
  const model = buildGitTagMenuModel({ disabled, hasHead, remotes });
  const deleteRemoteTagAction = resolveGitDeleteRemoteTagAction({ disabled, hasHead, remotes });
  const pushTagsAction = resolveGitPushTagsAction({ disabled, hasHead, remotes });
  // Mirror the top-level rule: only one Tag-level remote picker open at a time.
  const [openL2, setOpenL2] = useState<"delete-remote" | "push-tags" | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const { panelRef, style } = useSubmenuPlacement(open, triggerRef);
  const tagHandlers: GitTagMenuActionHandlers = { onOpenTags };
  const handleL2OpenChange = useCallback(
    (kind: "delete-remote" | "push-tags") => (next: boolean) => {
      setOpenL2(next ? kind : (prev) => (prev === kind ? null : prev));
    },
    [],
  );

  useEffect(() => {
    if (!open) setOpenL2(null);
  }, [open]);

  function select(id: GitTagMenuItemId): void {
    if (id === "delete-remote" && deleteRemoteTagAction.kind === "open-picker") {
      runGitTagMenuAction(id, tagHandlers, deleteRemoteTagAction.remote);
      return;
    }
    if (id === "push-tags" && pushTagsAction.kind === "push") {
      onPushTags(pushTagsAction.remote);
      return;
    }
    if (id !== "push-tags") runGitTagMenuAction(id, tagHandlers);
  }

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        className="flex w-full items-center justify-between gap-3 rounded-[3px] px-2 py-1 text-left text-app-ui-sm text-foreground hover:bg-frosted-veil-strong focus-visible:bg-frosted-veil-strong focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
        onClick={() => onOpenChange(!open)}
      >
        <span>Tag</span>
        <ChevronRight className="size-3.5" aria-hidden="true" />
      </button>
      {open
        ? createPortal(
            <div
              ref={panelRef}
              role="menu"
              data-popover-root={PORTAL_MARKER}
              style={style}
              className="z-50 max-h-[40vh] min-w-[188px] overflow-y-auto rounded border border-mist-border bg-popover p-1 text-popover-foreground shadow-sm"
            >
              {model.map((item) =>
                item.kind === "separator" ? (
                  <MenuSeparator key={item.id} />
                ) : item.id === "delete-remote" &&
                  deleteRemoteTagAction.kind === "choose-remote" ? (
                  <DeleteRemoteTagRemoteSubmenu
                    key={item.id}
                    open={openL2 === "delete-remote"}
                    remotes={deleteRemoteTagAction.remotes}
                    onOpenChange={handleL2OpenChange("delete-remote")}
                    onOpenTags={onOpenTags}
                  />
                ) : item.id === "push-tags" && pushTagsAction.kind === "choose-remote" ? (
                  <PushTagsRemoteSubmenu
                    key={item.id}
                    open={openL2 === "push-tags"}
                    remotes={pushTagsAction.remotes}
                    onOpenChange={handleL2OpenChange("push-tags")}
                    onPushTags={onPushTags}
                  />
                ) : (
                  <MenuButton
                    key={item.id}
                    label={item.label}
                    disabled={item.disabled}
                    title={item.title}
                    onClick={() => select(item.id)}
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

/**
 * Renders the Delete Remote Tag multi-remote chooser nested under Tag.
 */
function DeleteRemoteTagRemoteSubmenu({
  open,
  remotes,
  onOpenChange,
  onOpenTags,
}: {
  open: boolean;
  remotes: readonly string[];
  onOpenChange: (open: boolean) => void;
  onOpenTags: (mode: GitTagPickerMenuMode, remote?: string) => void;
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
        className="flex w-full items-center justify-between gap-3 rounded-[3px] px-2 py-1 text-left text-app-ui-sm text-foreground hover:bg-frosted-veil-strong focus-visible:bg-frosted-veil-strong focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
        onClick={() => onOpenChange(!open)}
      >
        <span>Delete Remote Tag…</span>
        <ChevronRight className="size-3.5" aria-hidden="true" />
      </button>
      {open
        ? createPortal(
            <div
              ref={panelRef}
              role="menu"
              data-popover-root={PORTAL_MARKER}
              style={style}
              className="z-50 max-h-[40vh] min-w-[152px] overflow-y-auto rounded border border-mist-border bg-popover p-1 text-popover-foreground shadow-sm"
            >
              {remotes.map((remote) => (
                <MenuButton
                  key={remote}
                  label={remote}
                  onClick={() => onOpenTags("delete-remote", remote)}
                />
              ))}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

/**
 * Renders the Push Tags multi-remote chooser nested under the Tag flyout.
 */
function PushTagsRemoteSubmenu({
  open,
  remotes,
  onOpenChange,
  onPushTags,
}: {
  open: boolean;
  remotes: readonly string[];
  onOpenChange: (open: boolean) => void;
  onPushTags: (remote: string) => void;
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
        className="flex w-full items-center justify-between gap-3 rounded-[3px] px-2 py-1 text-left text-app-ui-sm text-foreground hover:bg-frosted-veil-strong focus-visible:bg-frosted-veil-strong focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
        onClick={() => onOpenChange(!open)}
      >
        <span>Push Tags</span>
        <ChevronRight className="size-3.5" aria-hidden="true" />
      </button>
      {open
        ? createPortal(
            <div
              ref={panelRef}
              role="menu"
              data-popover-root={PORTAL_MARKER}
              style={style}
              className="z-50 max-h-[40vh] min-w-[152px] overflow-y-auto rounded border border-mist-border bg-popover p-1 text-popover-foreground shadow-sm"
            >
              {remotes.map((remote) => (
                <MenuButton key={remote} label={remote} onClick={() => onPushTags(remote)} />
              ))}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

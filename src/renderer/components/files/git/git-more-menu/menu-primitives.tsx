/**
 * Shared primitives for `GitMoreMenu` and its submenu flyouts. The portal
 * marker is exported so each submenu can stamp the same `data-popover-root`
 * attribute on its portaled panel, keeping all panels inside one
 * outside-click region.
 */

/** Marker value shared by all portal panels in the GitMoreMenu family. */
export const PORTAL_MARKER = "git-more";

/**
 * Renders one clickable menu row. The `destructive` variant uses the panel's
 * destructive token so dangerous actions (Discard All) stand out from
 * benign ones (Refresh, Fetch) at a glance.
 */
export function MenuButton({
  label,
  disabled,
  destructive,
  title,
  onClick,
}: {
  label: string;
  disabled?: boolean;
  destructive?: boolean;
  title?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      title={title}
      className={
        destructive
          ? "flex w-full rounded-(--radius-control) px-2 py-1 text-left text-app-ui-sm git-destructive-text hover:bg-[var(--state-hover-bg)] focus-visible:bg-[var(--state-hover-bg)] focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
          : "flex w-full rounded-(--radius-control) px-2 py-1 text-left text-app-ui-sm text-foreground hover:bg-[var(--state-hover-bg)] focus-visible:bg-[var(--state-hover-bg)] focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
      }
      onClick={onClick}
    >
      {label}
    </button>
  );
}

/** Renders a 1px horizontal rule used between logical groups in the menu. */
export function MenuSeparator() {
  return <hr className="my-1 h-px border-0 bg-border" />;
}

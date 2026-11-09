/**
 * Thin wrapper over Radix `ContextMenu` that fixes the visual style for the
 * whole app. Callers compose menus declaratively using {@link ContextMenuItem}
 * children and `<ContextMenuSeparator />`. Keeps every menu visually
 * consistent and avoids re-typing the long Tailwind className for each item.
 *
 * BROWSER-OVERLAY SUSPEND
 * Handled centrally by `state/operations/browser-suspend-auto.ts` — see
 * that module for the rationale.
 */
import { Check, ChevronRight } from "lucide-react";
import { ContextMenu as RadixContextMenu } from "radix-ui";

const CONTENT_CLASS =
  "bg-popover text-popover-foreground border border-border rounded-(--radius-control) shadow-none py-1 min-w-[180px] z-(--layer-floating)";

const ITEM_CLASS =
  "flex items-center justify-between px-2 py-1 rounded-(--radius-control) cursor-default outline-none text-app-ui-sm text-foreground data-[highlighted]:bg-[var(--state-hover-bg)] data-[disabled]:opacity-50 data-[disabled]:pointer-events-none";

const SEPARATOR_CLASS = "h-px bg-border my-1";

interface ContextMenuRootProps {
  children: React.ReactNode;
  onOpenChange?: (open: boolean) => void;
}

export function ContextMenuRoot({ children, onOpenChange }: ContextMenuRootProps) {
  return <RadixContextMenu.Root onOpenChange={onOpenChange}>{children}</RadixContextMenu.Root>;
}

interface ContextMenuTriggerProps {
  children: React.ReactNode;
}

export function ContextMenuTrigger({ children }: ContextMenuTriggerProps) {
  return <RadixContextMenu.Trigger asChild>{children}</RadixContextMenu.Trigger>;
}

interface ContextMenuContentProps {
  children: React.ReactNode;
  /**
   * Forwarded to Radix's `ContextMenu.Content`. Radix's default behavior
   * is to return focus to the trigger element after the menu closes,
   * which races with — and steals focus from — any element that an
   * `onSelect` handler just mounted (e.g. the file-tree's inline-edit
   * row for "New File"). Consumers that hand focus off to a fresh
   * element should pass `(e) => e.preventDefault()` (usually
   * conditionally, gated on a "handoff in flight" flag) so Radix steps
   * out of the way. Surfacing the hook here, rather than keeping it
   * private to the wrapper, makes the focus-handoff contract part of
   * the module's public surface.
   */
  onCloseAutoFocus?: (event: Event) => void;
}

export function ContextMenuContent({ children, onCloseAutoFocus }: ContextMenuContentProps) {
  return (
    <RadixContextMenu.Portal>
      <RadixContextMenu.Content className={CONTENT_CLASS} onCloseAutoFocus={onCloseAutoFocus}>
        {children}
      </RadixContextMenu.Content>
    </RadixContextMenu.Portal>
  );
}

interface ContextMenuItemProps {
  label: string;
  shortcut?: string;
  disabled?: boolean;
  onSelect: () => void;
}

function ContextMenuItem({ label, shortcut, disabled, onSelect }: ContextMenuItemProps) {
  return (
    <RadixContextMenu.Item className={ITEM_CLASS} disabled={disabled} onSelect={onSelect}>
      <span>{label}</span>
      {shortcut ? <span className="text-muted-foreground ml-4 font-mono">{shortcut}</span> : null}
    </RadixContextMenu.Item>
  );
}

function ContextMenuSeparator() {
  return <RadixContextMenu.Separator className={SEPARATOR_CLASS} />;
}

// ---------------------------------------------------------------------------
// Data-driven menu rendering
//
// For menus that branch on context (e.g. file tree showing a different set
// for files vs directories), call sites build a `MenuItemSpec[]` and hand
// it to {@link ContextMenuItems}. This keeps the branching logic in a
// pure function (testable, easy to read) while the JSX wiring stays in
// one place.
// ---------------------------------------------------------------------------

export type MenuItemSpec =
  | {
      kind: "item";
      label: string;
      shortcut?: string;
      disabled?: boolean;
      onSelect: () => void;
    }
  | { kind: "separator" };

interface ContextMenuItemsProps {
  items: MenuItemSpec[];
}

/**
 * Render a list of menu specs. Consecutive separators and leading/trailing
 * separators are collapsed so callers can build the spec list with simple
 * concatenation without worrying about visual artefacts (e.g. when a whole
 * group is hidden, its trailing separator should disappear too).
 */
export function ContextMenuItems({ items }: ContextMenuItemsProps) {
  const cleaned = collapseSeparators(items);
  return cleaned.map((spec, idx) => {
    if (spec.kind === "separator") {
      // Stable key: anchor the separator to the label of the preceding
      // item. Within a single menu render the labels are unique, so this
      // keeps Radix from confusing two separators if the spec list grows
      // or shrinks across renders. Falls back to "sep-leading" when a
      // separator somehow lands at index 0 (collapseSeparators guards
      // against that today, but the fallback keeps the key non-empty).
      const prev = cleaned[idx - 1];
      const anchor = prev && prev.kind === "item" ? prev.label : "leading";
      return <ContextMenuSeparator key={`sep-${anchor}`} />;
    }
    return (
      <ContextMenuItem
        key={spec.label}
        label={spec.label}
        shortcut={spec.shortcut}
        disabled={spec.disabled}
        onSelect={spec.onSelect}
      />
    );
  });
}

function collapseSeparators(items: MenuItemSpec[]): MenuItemSpec[] {
  const out: MenuItemSpec[] = [];
  for (const spec of items) {
    if (spec.kind === "separator") {
      // skip leading separators and back-to-back separators
      if (out.length === 0 || out[out.length - 1].kind === "separator") continue;
    }
    out.push(spec);
  }
  // strip trailing separator
  while (out.length > 0 && out[out.length - 1].kind === "separator") out.pop();
  return out;
}

// ---------------------------------------------------------------------------
// Submenus and choices, for a menu built by hand beside ContextMenuItems
// ---------------------------------------------------------------------------

export function ContextMenuSub({ children }: { children: React.ReactNode }) {
  return <RadixContextMenu.Sub>{children}</RadixContextMenu.Sub>;
}

export function ContextMenuSubTrigger({ children }: { children: React.ReactNode }) {
  return (
    <RadixContextMenu.SubTrigger
      className={`${ITEM_CLASS} data-[state=open]:bg-[var(--state-hover-bg)]`}
    >
      {children}
      <ChevronRight className="ml-4 size-3.5 text-muted-foreground" aria-hidden="true" />
    </RadixContextMenu.SubTrigger>
  );
}

export function ContextMenuSubContent({ children }: { children: React.ReactNode }) {
  return (
    <RadixContextMenu.Portal>
      <RadixContextMenu.SubContent className={CONTENT_CLASS} sideOffset={4}>
        {children}
      </RadixContextMenu.SubContent>
    </RadixContextMenu.Portal>
  );
}

/** A section's name inside a menu. */
export function ContextMenuLabel({ children }: { children: React.ReactNode }) {
  return (
    <RadixContextMenu.Label className="px-2 pt-1.5 pb-0.5 text-app-label uppercase text-muted-foreground">
      {children}
    </RadixContextMenu.Label>
  );
}

/** One choice of a set: a check marks the one in effect, a note may follow it. */
export function ContextMenuChoice({
  checked,
  onSelect,
  children,
  note,
  noteClassName,
}: {
  checked: boolean;
  onSelect: () => void;
  children: React.ReactNode;
  note?: React.ReactNode;
  noteClassName?: string;
}) {
  return (
    <RadixContextMenu.Item className={ITEM_CLASS} onSelect={onSelect}>
      <span className="flex min-w-0 items-center gap-2">
        <span className="flex size-3.5 shrink-0 items-center justify-center">
          {checked && <Check className="size-3" aria-hidden="true" />}
        </span>
        {children}
      </span>
      {note ? (
        <span className={noteClassName ?? "ml-4 max-w-[16rem] truncate text-muted-foreground"}>
          {note}
        </span>
      ) : null}
    </RadixContextMenu.Item>
  );
}

/** A plain item, for a menu built by hand. */
export function ContextMenuAction({
  onSelect,
  children,
  disabled,
}: {
  onSelect: () => void;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <RadixContextMenu.Item className={ITEM_CLASS} disabled={disabled} onSelect={onSelect}>
      {children}
    </RadixContextMenu.Item>
  );
}

export { ContextMenuSeparator };

/**
 * Thin wrapper over Radix `DropdownMenu` that fixes the visual style for the
 * whole app. Mirrors the structure of {@link ContextMenuRoot} / {@link ContextMenuContent}
 * / {@link ContextMenuItem} so the two menus stay visually consistent.
 *
 * Public surface: DropdownMenuRoot · DropdownMenuTrigger · DropdownMenuContent
 *                 DropdownMenuItem · DropdownMenuShortcut · DropdownMenuSeparator
 */
import { DropdownMenu as RadixDropdownMenu } from "radix-ui";

const CONTENT_CLASS =
  "bg-popover text-popover-foreground border border-border rounded-(--radius-control) shadow-none py-1 min-w-[180px] z-50";

const ITEM_CLASS =
  "flex items-center justify-between px-2 py-1 rounded-(--radius-control) cursor-default outline-none text-app-ui-sm text-foreground data-[highlighted]:bg-[var(--state-hover-bg)] data-[disabled]:opacity-50 data-[disabled]:pointer-events-none";

const SEPARATOR_CLASS = "h-px bg-border my-1";

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

interface DropdownMenuRootProps {
  children: React.ReactNode;
  onOpenChange?: (open: boolean) => void;
}

export function DropdownMenuRoot({ children, onOpenChange }: DropdownMenuRootProps) {
  return (
    <RadixDropdownMenu.Root onOpenChange={onOpenChange}>{children}</RadixDropdownMenu.Root>
  );
}

// ---------------------------------------------------------------------------
// Trigger
// ---------------------------------------------------------------------------

interface DropdownMenuTriggerProps {
  children: React.ReactNode;
}

export function DropdownMenuTrigger({ children }: DropdownMenuTriggerProps) {
  return <RadixDropdownMenu.Trigger asChild>{children}</RadixDropdownMenu.Trigger>;
}

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

interface DropdownMenuContentProps {
  children: React.ReactNode;
  /**
   * Forwarded to Radix `DropdownMenu.Content`. Radix's default behavior
   * is to return focus to the trigger element after the menu closes.
   * Consumers that hand focus off to a freshly-mounted element should pass
   * `(e) => e.preventDefault()` to prevent the focus race.
   */
  onCloseAutoFocus?: (event: Event) => void;
  /** Alignment relative to the trigger. Defaults to "start". */
  align?: "start" | "center" | "end";
  /** Side the menu appears on. Defaults to "bottom". */
  side?: "top" | "right" | "bottom" | "left";
  /** Gap between trigger and menu. Defaults to 4. */
  sideOffset?: number;
}

export function DropdownMenuContent({
  children,
  onCloseAutoFocus,
  align = "start",
  side = "bottom",
  sideOffset = 4,
}: DropdownMenuContentProps) {
  return (
    <RadixDropdownMenu.Portal>
      <RadixDropdownMenu.Content
        className={CONTENT_CLASS}
        align={align}
        side={side}
        sideOffset={sideOffset}
        onCloseAutoFocus={onCloseAutoFocus}
      >
        {children}
      </RadixDropdownMenu.Content>
    </RadixDropdownMenu.Portal>
  );
}

// ---------------------------------------------------------------------------
// Shortcut hint (inline-end of an item)
// ---------------------------------------------------------------------------

interface DropdownMenuShortcutProps {
  children: React.ReactNode;
}

export function DropdownMenuShortcut({ children }: DropdownMenuShortcutProps) {
  return (
    <span className="text-muted-foreground ml-4 font-mono text-app-ui-sm">{children}</span>
  );
}

// ---------------------------------------------------------------------------
// Item
// ---------------------------------------------------------------------------

interface DropdownMenuItemProps {
  children: React.ReactNode;
  disabled?: boolean;
  onSelect?: () => void;
}

export function DropdownMenuItem({ children, disabled, onSelect }: DropdownMenuItemProps) {
  return (
    <RadixDropdownMenu.Item
      className={ITEM_CLASS}
      disabled={disabled}
      onSelect={onSelect != null ? () => onSelect() : undefined}
    >
      {children}
    </RadixDropdownMenu.Item>
  );
}

// ---------------------------------------------------------------------------
// Separator
// ---------------------------------------------------------------------------

export function DropdownMenuSeparator() {
  return <RadixDropdownMenu.Separator className={SEPARATOR_CLASS} />;
}

/**
 * Thin wrapper over Radix `DropdownMenu` that fixes the visual style for the
 * whole app. Mirrors the structure of {@link ContextMenuRoot} / {@link ContextMenuContent}
 * / {@link ContextMenuItem} so the two menus stay visually consistent.
 *
 * BROWSER-OVERLAY SUSPEND
 * Handled centrally by `state/operations/browser-suspend-auto.ts`'s
 * MutationObserver — it watches body for any Radix popper container and
 * claims a suspend slot while one is present, so embedded browser views
 * are hidden under DOM menus without per-wrapper wiring.
 *
 * Public surface: DropdownMenuRoot · DropdownMenuTrigger · DropdownMenuContent
 *                 DropdownMenuAtPoint
 *                 DropdownMenuItem · DropdownMenuCheckboxItem
 *                 DropdownMenuRadioGroup · DropdownMenuRadioItem
 *                 DropdownMenuShortcut · DropdownMenuLabel · DropdownMenuText
 *                 DropdownMenuSeparator
 *                 DropdownMenuSub · DropdownMenuSubTrigger · DropdownMenuSubContent
 */
import { Check, ChevronRight } from "lucide-react";
import { DropdownMenu as RadixDropdownMenu } from "radix-ui";
import { useLayoutEffect, useRef } from "react";
import { cn } from "@/utils/cn";
import { tooltipProps } from "./tooltip";

// A menu taller than the room the window gives it scrolls (a long list of
// hidden tabs, say) instead of running off the window.
const CONTENT_CLASS =
  "bg-popover text-popover-foreground border border-border rounded-(--radius-control) shadow-none py-1 min-w-[180px] z-(--layer-floating) max-h-(--radix-dropdown-menu-content-available-height) overflow-y-auto app-scrollbar";

// A disabled item still takes the pointer, for the tooltip that says why it
// is off; Radix neither highlights nor selects it.
const ITEM_CLASS =
  "flex items-center justify-between px-2 py-1 rounded-(--radius-control) cursor-default outline-none text-app-ui-sm text-foreground data-[highlighted]:bg-[var(--state-hover-bg)] data-[disabled]:opacity-50";

const SEPARATOR_CLASS = "h-px bg-border my-1";

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

interface DropdownMenuRootProps {
  children: React.ReactNode;
  onOpenChange?: (open: boolean) => void;
  /** Set to open and close the menu from code; left out, the trigger does. */
  open?: boolean;
  /**
   * Whether the open menu holds the keyboard and blocks the page under it.
   * Defaults to true. A menu whose items open a picker or a dialog sets it
   * to false: a held keyboard pulls the focus back from what the item
   * opened, and the menu's trigger takes it when the menu closes.
   */
  modal?: boolean;
}

export function DropdownMenuRoot({
  children,
  onOpenChange,
  open,
  modal = true,
}: DropdownMenuRootProps) {
  return (
    <RadixDropdownMenu.Root open={open} onOpenChange={onOpenChange} modal={modal}>
      {children}
    </RadixDropdownMenu.Root>
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
   * Forwarded to Radix `DropdownMenu.Content`. Left out, closing puts the
   * keyboard back on the trigger only when nothing else took it: an item
   * that opened a dialog or a picker keeps the keyboard there. Consumers
   * that hand focus off later than that should pass
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
        onCloseAutoFocus={onCloseAutoFocus ?? keepFocusTakenElsewhere}
      >
        {children}
      </RadixDropdownMenu.Content>
    </RadixDropdownMenu.Portal>
  );
}

/** Lets the trigger have the keyboard back only when it went nowhere else. */
function keepFocusTakenElsewhere(event: Event): void {
  const focused = document.activeElement;
  if (focused && focused !== document.body) event.preventDefault();
}

// ---------------------------------------------------------------------------
// Menu at a point
// ---------------------------------------------------------------------------

export interface DropdownMenuPoint {
  readonly x: number;
  readonly y: number;
  /**
   * The menu's top corner on the point: its start (the default) or its
   * end, for a menu that drops from a button and lines up with its right.
   */
  readonly align?: "start" | "end";
}

/**
 * A menu that opens at a point rather than under its own trigger: where a
 * row was right-clicked, or under a button its caller measured. It is open
 * while `point` is set; a pick, Escape or a click elsewhere calls `onClose`.
 *
 * Non-modal, so an item that opens a dialog or a picker keeps the keyboard
 * there. Otherwise closing puts the keyboard back where it was when the
 * menu opened: the row, or the button.
 */
export function DropdownMenuAtPoint({
  point,
  onClose,
  children,
}: {
  point: DropdownMenuPoint | null;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const open = point !== null;
  const returnFocusTo = useRef<HTMLElement | null>(null);
  // Before the menu takes the keyboard: its content mounts after this.
  useLayoutEffect(() => {
    if (!open) return;
    const focused = document.activeElement;
    returnFocusTo.current = focused instanceof HTMLElement ? focused : null;
  }, [open]);

  return (
    <RadixDropdownMenu.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      modal={false}
    >
      <RadixDropdownMenu.Trigger asChild>
        <span
          aria-hidden
          className="pointer-events-none fixed size-0"
          style={point ? { left: point.x, top: point.y } : undefined}
        />
      </RadixDropdownMenu.Trigger>
      <RadixDropdownMenu.Portal>
        <RadixDropdownMenu.Content
          className={CONTENT_CLASS}
          align={point?.align ?? "start"}
          side="bottom"
          sideOffset={0}
          collisionPadding={4}
          onContextMenu={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const target = returnFocusTo.current;
            returnFocusTo.current = null;
            const focused = document.activeElement;
            if (focused && focused !== document.body) return;
            if (target?.isConnected) target.focus();
          }}
        >
          {children}
        </RadixDropdownMenu.Content>
      </RadixDropdownMenu.Portal>
    </RadixDropdownMenu.Root>
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
  /** Its tooltip: why a disabled item is off. */
  tooltip?: string;
  /** Over the item's text, as a destructive action's colour. */
  className?: string;
}

export function DropdownMenuItem({
  children,
  disabled,
  onSelect,
  tooltip,
  className,
}: DropdownMenuItemProps) {
  return (
    <RadixDropdownMenu.Item
      className={cn(ITEM_CLASS, className)}
      disabled={disabled}
      onSelect={onSelect != null ? () => onSelect() : undefined}
      {...(tooltip ? tooltipProps(tooltip) : {})}
    >
      {children}
    </RadixDropdownMenu.Item>
  );
}

// ---------------------------------------------------------------------------
// Checkbox and radio items
// ---------------------------------------------------------------------------

/** The check before a checkbox or radio item, its place kept when unset. */
function ItemCheck() {
  return (
    <span className="flex size-3.5 shrink-0 items-center justify-center">
      <RadixDropdownMenu.ItemIndicator>
        <Check aria-hidden className="size-3.5" />
      </RadixDropdownMenu.ItemIndicator>
    </span>
  );
}

/**
 * An option that is on or off. Setting it leaves the menu open, so several
 * can be set in one go.
 */
export function DropdownMenuCheckboxItem({
  children,
  checked,
  onCheckedChange,
}: {
  children: React.ReactNode;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <RadixDropdownMenu.CheckboxItem
      className={cn(ITEM_CLASS, "justify-start gap-2")}
      checked={checked}
      onCheckedChange={onCheckedChange}
      onSelect={(event) => event.preventDefault()}
    >
      <ItemCheck />
      {children}
    </RadixDropdownMenu.CheckboxItem>
  );
}

/** One choice of several; picking one closes the menu. */
export function DropdownMenuRadioGroup({
  children,
  value,
  onValueChange,
}: {
  children: React.ReactNode;
  value: string;
  onValueChange: (value: string) => void;
}) {
  return (
    <RadixDropdownMenu.RadioGroup value={value} onValueChange={onValueChange}>
      {children}
    </RadixDropdownMenu.RadioGroup>
  );
}

export function DropdownMenuRadioItem({
  children,
  value,
}: {
  children: React.ReactNode;
  value: string;
}) {
  return (
    <RadixDropdownMenu.RadioItem className={cn(ITEM_CLASS, "justify-start gap-2")} value={value}>
      <ItemCheck />
      {children}
    </RadixDropdownMenu.RadioItem>
  );
}

// ---------------------------------------------------------------------------
// Label
// ---------------------------------------------------------------------------

/** A heading over the items after it; not an item, so arrow keys skip it. */
export function DropdownMenuLabel({ children }: { children: React.ReactNode }) {
  return (
    <RadixDropdownMenu.Label className="px-2 pt-1.5 pb-0.5 text-app-label text-muted-foreground uppercase">
      {children}
    </RadixDropdownMenu.Label>
  );
}

// ---------------------------------------------------------------------------
// Separator
// ---------------------------------------------------------------------------

/** A line of text in the menu that is not an item: a list it shows, a note. */
export function DropdownMenuText({
  children,
  muted = false,
}: {
  children: React.ReactNode;
  muted?: boolean;
}) {
  return (
    <div
      className={cn(
        "px-2 py-1 text-app-ui-sm",
        muted ? "text-muted-foreground" : "text-foreground",
      )}
    >
      {children}
    </div>
  );
}

export function DropdownMenuSeparator() {
  return <RadixDropdownMenu.Separator className={SEPARATOR_CLASS} />;
}

// ---------------------------------------------------------------------------
// Submenu
// ---------------------------------------------------------------------------

export function DropdownMenuSub({ children }: { children: React.ReactNode }) {
  return <RadixDropdownMenu.Sub>{children}</RadixDropdownMenu.Sub>;
}

/** An item that opens its submenu, with a chevron at the end. */
export function DropdownMenuSubTrigger({
  children,
  disabled,
  tooltip,
}: {
  children: React.ReactNode;
  disabled?: boolean;
  /** Its tooltip: why a disabled submenu is off. */
  tooltip?: string;
}) {
  return (
    <RadixDropdownMenu.SubTrigger
      className={`${ITEM_CLASS} data-[state=open]:bg-[var(--state-hover-bg)]`}
      disabled={disabled}
      {...(tooltip ? tooltipProps(tooltip) : {})}
    >
      {children}
      <ChevronRight aria-hidden className="ml-4 size-3.5 shrink-0 text-muted-foreground" />
    </RadixDropdownMenu.SubTrigger>
  );
}

export function DropdownMenuSubContent({ children }: { children: React.ReactNode }) {
  return (
    <RadixDropdownMenu.Portal>
      <RadixDropdownMenu.SubContent className={CONTENT_CLASS} sideOffset={4}>
        {children}
      </RadixDropdownMenu.SubContent>
    </RadixDropdownMenu.Portal>
  );
}

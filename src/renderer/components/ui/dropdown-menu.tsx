import { Check, ChevronRight } from "lucide-react";
import { DropdownMenu as RadixDropdownMenu } from "radix-ui";
import { createContext, useCallback, useContext, useLayoutEffect, useRef } from "react";
import { cn } from "@/utils/cn";
import { tooltipProps } from "./tooltip";

const CONTENT_CLASS =
  "bg-popover text-popover-foreground border border-border rounded-(--radius-control) shadow-none py-1 min-w-[180px] z-(--layer-floating) max-h-(--radix-dropdown-menu-content-available-height) overflow-y-auto app-scrollbar";

const ITEM_CLASS =
  "flex items-center justify-between px-2 py-1 rounded-(--radius-control) cursor-default outline-none text-app-ui-sm text-foreground data-[highlighted]:bg-[var(--state-hover-bg)] data-[disabled]:opacity-50";

const SEPARATOR_CLASS = "h-px bg-border my-1";

interface DropdownMenuRootProps {
  children: React.ReactNode;
  onOpenChange?: (open: boolean) => void;
  open?: boolean;
}

export function DropdownMenuRoot({ children, onOpenChange, open }: DropdownMenuRootProps) {
  return (
    <RadixDropdownMenu.Root open={open} onOpenChange={onOpenChange}>
      {children}
    </RadixDropdownMenu.Root>
  );
}

interface DropdownMenuTriggerProps {
  children: React.ReactNode;
}

export function DropdownMenuTrigger({ children }: DropdownMenuTriggerProps) {
  return <RadixDropdownMenu.Trigger asChild>{children}</RadixDropdownMenu.Trigger>;
}

type RunItem = (action: () => void) => void;

function runNow(action: () => void): void {
  action();
}

const RunItemContext = createContext<RunItem>(runNow);

function useQueuedItemAction(): {
  queue: RunItem;
  take: () => (() => void) | null;
} {
  const queued = useRef<(() => void) | null>(null);
  const queue = useCallback<RunItem>((action) => {
    queued.current = action;
  }, []);
  const take = useCallback(() => {
    const action = queued.current;
    queued.current = null;
    return action;
  }, []);
  return { queue, take };
}

interface DropdownMenuContentProps {
  children: React.ReactNode;
  onCloseAutoFocus?: (event: Event) => void;
  align?: "start" | "center" | "end";
  side?: "top" | "right" | "bottom" | "left";
  sideOffset?: number;
}

export function DropdownMenuContent({
  children,
  onCloseAutoFocus,
  align = "start",
  side = "bottom",
  sideOffset = 4,
}: DropdownMenuContentProps) {
  const itemAction = useQueuedItemAction();
  return (
    <RadixDropdownMenu.Portal>
      <RadixDropdownMenu.Content
        className={CONTENT_CLASS}
        align={align}
        side={side}
        sideOffset={sideOffset}
        onCloseAutoFocus={
          onCloseAutoFocus ??
          ((event) => {
            const action = itemAction.take();
            if (action) queueMicrotask(action);
            else keepFocusTakenElsewhere(event);
          })
        }
      >
        <RunItemContext.Provider value={onCloseAutoFocus ? runNow : itemAction.queue}>
          {children}
        </RunItemContext.Provider>
      </RadixDropdownMenu.Content>
    </RadixDropdownMenu.Portal>
  );
}

function keepFocusTakenElsewhere(event: Event): void {
  const focused = document.activeElement;
  if (focused && focused !== document.body) event.preventDefault();
}

export interface DropdownMenuPoint {
  readonly x: number;
  readonly y: number;
  readonly align?: "start" | "end";
}

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
  const itemAction = useQueuedItemAction();
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
            if ((!focused || focused === document.body) && target?.isConnected) target.focus();
            itemAction.take()?.();
          }}
        >
          <RunItemContext.Provider value={itemAction.queue}>{children}</RunItemContext.Provider>
        </RadixDropdownMenu.Content>
      </RadixDropdownMenu.Portal>
    </RadixDropdownMenu.Root>
  );
}

interface DropdownMenuShortcutProps {
  children: React.ReactNode;
}

export function DropdownMenuShortcut({ children }: DropdownMenuShortcutProps) {
  return <span className="text-muted-foreground ml-4 font-mono text-app-ui-sm">{children}</span>;
}

interface DropdownMenuItemProps {
  children: React.ReactNode;
  disabled?: boolean;
  onSelect?: () => void;
  tooltip?: string;
  className?: string;
}

export function DropdownMenuItem({
  children,
  disabled,
  onSelect,
  tooltip,
  className,
}: DropdownMenuItemProps) {
  const run = useContext(RunItemContext);
  return (
    <RadixDropdownMenu.Item
      className={cn(ITEM_CLASS, className)}
      disabled={disabled}
      onSelect={onSelect != null ? () => run(onSelect) : undefined}
      {...(tooltip ? tooltipProps(tooltip) : {})}
    >
      {children}
    </RadixDropdownMenu.Item>
  );
}

function ItemCheck() {
  return (
    <span className="flex size-3.5 shrink-0 items-center justify-center">
      <RadixDropdownMenu.ItemIndicator>
        <Check aria-hidden className="size-3.5" />
      </RadixDropdownMenu.ItemIndicator>
    </span>
  );
}

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

export function DropdownMenuLabel({ children }: { children: React.ReactNode }) {
  return (
    <RadixDropdownMenu.Label className="px-2 pt-1.5 pb-0.5 text-app-label text-muted-foreground uppercase">
      {children}
    </RadixDropdownMenu.Label>
  );
}

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

export function DropdownMenuSub({ children }: { children: React.ReactNode }) {
  return <RadixDropdownMenu.Sub>{children}</RadixDropdownMenu.Sub>;
}

export function DropdownMenuSubTrigger({
  children,
  disabled,
  tooltip,
}: {
  children: React.ReactNode;
  disabled?: boolean;
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

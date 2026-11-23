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

export function ContextMenuItems({ items }: ContextMenuItemsProps) {
  const cleaned = collapseSeparators(items);
  return cleaned.map((spec, idx) => {
    if (spec.kind === "separator") {
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
      if (out.length === 0 || out[out.length - 1].kind === "separator") continue;
    }
    out.push(spec);
  }
  while (out.length > 0 && out[out.length - 1].kind === "separator") out.pop();
  return out;
}

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

export function ContextMenuLabel({ children }: { children: React.ReactNode }) {
  return (
    <RadixContextMenu.Label className="px-2 pt-1.5 pb-0.5 text-app-label uppercase text-muted-foreground">
      {children}
    </RadixContextMenu.Label>
  );
}

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

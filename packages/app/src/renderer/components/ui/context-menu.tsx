import * as React from "react";
import { createPortal } from "react-dom";
import { CheckIcon, ChevronRightIcon, CircleIcon } from "lucide-react";

import { cn } from "@/lib/utils";

interface ContextMenuState {
  open: boolean;
  x: number;
  y: number;
}

interface ContextMenuContextValue extends ContextMenuState {
  openAt(x: number, y: number): void;
  close(): void;
}

const ContextMenuContext = React.createContext<ContextMenuContextValue | null>(null);

function ContextMenu({ children }: { children?: React.ReactNode }) {
  const [state, setState] = React.useState<ContextMenuState>({ open: false, x: 0, y: 0 });
  const close = React.useCallback(() => {
    setState((current) => (current.open ? { ...current, open: false } : current));
  }, []);
  const openAt = React.useCallback((x: number, y: number) => {
    setState({ open: true, x, y });
  }, []);
  const contextValue = React.useMemo(
    () => ({ ...state, openAt, close }),
    [close, openAt, state],
  );

  React.useEffect(() => {
    if (!state.open) {
      return;
    }

    const handlePointerDown = () => {
      close();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      }
    };

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("blur", close);
    };
  }, [close, state.open]);

  return (
    <ContextMenuContext.Provider value={contextValue}>
      <div data-slot="context-menu" className="contents">
        {children}
      </div>
    </ContextMenuContext.Provider>
  );
}

function ContextMenuTrigger({
  asChild,
  children,
  onContextMenu,
  ...props
}: React.ComponentProps<"span"> & {
  asChild?: boolean;
}) {
  const context = useContextMenuContext("ContextMenuTrigger");
  const handleContextMenu = React.useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      onContextMenu?.(event as React.MouseEvent<HTMLSpanElement>);
      if (event.defaultPrevented) {
        return;
      }
      event.preventDefault();
      context.openAt(event.clientX, event.clientY);
    },
    [context, onContextMenu],
  );

  if (asChild && React.isValidElement(children)) {
    const child = React.Children.only(children) as React.ReactElement<{
      onContextMenu?: React.MouseEventHandler<HTMLElement>;
      "data-slot"?: string;
    }>;
    return React.cloneElement(child, {
      ...props,
      "data-slot": child.props["data-slot"] ?? "context-menu-trigger",
      onContextMenu: (event: React.MouseEvent<HTMLElement>) => {
        child.props.onContextMenu?.(event);
        if (!event.defaultPrevented) {
          handleContextMenu(event);
        }
      },
    });
  }

  return (
    <span data-slot="context-menu-trigger" onContextMenu={handleContextMenu} {...props}>
      {children}
    </span>
  );
}

function ContextMenuGroup({ ...props }: React.ComponentProps<"div">) {
  return <div data-slot="context-menu-group" role="group" {...props} />;
}

function ContextMenuPortal({ children }: { children?: React.ReactNode }) {
  return <>{children}</>;
}

function ContextMenuSub({ children }: { children?: React.ReactNode }) {
  return <>{children}</>;
}

function ContextMenuRadioGroup({ ...props }: React.ComponentProps<"div">) {
  return <div data-slot="context-menu-radio-group" role="group" {...props} />;
}

function ContextMenuSubTrigger({
  className,
  inset,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  inset?: boolean;
}) {
  return (
    <div
      data-slot="context-menu-sub-trigger"
      data-inset={inset}
      className={cn(
        "focus:bg-accent focus:text-accent-foreground data-[state=open]:bg-accent data-[state=open]:text-accent-foreground flex cursor-default items-center rounded-sm px-2 py-1.5 text-sm outline-hidden select-none data-[inset]:pl-8",
        className,
      )}
      {...props}
    >
      {children}
      <ChevronRightIcon className="ml-auto size-4" />
    </div>
  );
}

function ContextMenuSubContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="context-menu-sub-content"
      className={cn(
        "bg-popover text-popover-foreground z-50 min-w-32 overflow-hidden rounded-md border p-1 shadow-md",
        className,
      )}
      {...props}
    />
  );
}

function ContextMenuContent({
  className,
  style,
  children,
  ...props
}: React.ComponentProps<"div">) {
  const context = useContextMenuContext("ContextMenuContent");
  const contentRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    if (!context.open) {
      return;
    }
    contentRef.current?.focus({ preventScroll: true });
  }, [context.open]);

  if (!context.open || typeof document === "undefined") {
    return null;
  }

  return createPortal(
    <ContextMenuPortal>
      <div
        ref={contentRef}
        data-slot="context-menu-content"
        role="menu"
        tabIndex={-1}
        className={cn(
          "bg-popover text-popover-foreground z-50 max-h-[min(28rem,calc(100vh-1rem))] min-w-48 overflow-x-hidden overflow-y-auto rounded-md border p-1 shadow-md outline-none",
          className,
        )}
        style={{
          position: "fixed",
          left: context.x,
          top: context.y,
          ...style,
        }}
        onContextMenu={(event) => {
          event.preventDefault();
        }}
        onPointerDown={(event) => {
          event.stopPropagation();
        }}
        {...props}
      >
        {children}
      </div>
    </ContextMenuPortal>,
    document.body,
  );
}

function ContextMenuItem({
  className,
  inset,
  variant = "default",
  disabled,
  onSelect,
  onClick,
  ...props
}: Omit<React.ComponentProps<"div">, "onSelect"> & {
  inset?: boolean;
  variant?: "default" | "destructive";
  disabled?: boolean;
  onSelect?: (event: ContextMenuSelectEvent) => void;
}) {
  const context = useContextMenuContext("ContextMenuItem");
  return (
    <div
      data-slot="context-menu-item"
      data-inset={inset}
      data-variant={variant}
      data-disabled={disabled ? "" : undefined}
      role="menuitem"
      aria-disabled={disabled ? "true" : undefined}
      tabIndex={disabled ? undefined : -1}
      className={cn(
        "focus:bg-accent focus:text-accent-foreground data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 dark:data-[variant=destructive]:focus:bg-destructive/20 data-[variant=destructive]:focus:text-destructive data-[disabled]:pointer-events-none data-[disabled]:opacity-50 relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none data-[inset]:pl-8 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
        className,
      )}
      onClick={(event) => {
        if (disabled) {
          event.preventDefault();
          return;
        }
        onClick?.(event);
        if (event.defaultPrevented) {
          return;
        }
        const selectEvent = createContextMenuSelectEvent(event);
        onSelect?.(selectEvent);
        if (!selectEvent.defaultPrevented) {
          context.close();
        }
      }}
      onKeyDown={(event) => {
        if ((event.key === "Enter" || event.key === " ") && !disabled) {
          event.preventDefault();
          event.currentTarget.click();
        }
      }}
      {...props}
    />
  );
}

function ContextMenuCheckboxItem({
  className,
  children,
  checked,
  ...props
}: React.ComponentProps<typeof ContextMenuItem> & {
  checked?: boolean;
}) {
  return (
    <ContextMenuItem
      data-slot="context-menu-checkbox-item"
      className={cn("relative pl-8", className)}
      {...props}
    >
      <span className="pointer-events-none absolute left-2 flex size-3.5 items-center justify-center">
        {checked ? <CheckIcon className="size-4" /> : null}
      </span>
      {children}
    </ContextMenuItem>
  );
}

function ContextMenuRadioItem({
  className,
  children,
  checked,
  ...props
}: React.ComponentProps<typeof ContextMenuItem> & {
  checked?: boolean;
}) {
  return (
    <ContextMenuItem
      data-slot="context-menu-radio-item"
      className={cn("relative pl-8", className)}
      {...props}
    >
      <span className="pointer-events-none absolute left-2 flex size-3.5 items-center justify-center">
        {checked ? <CircleIcon className="size-2 fill-current" /> : null}
      </span>
      {children}
    </ContextMenuItem>
  );
}

function ContextMenuLabel({
  className,
  inset,
  ...props
}: React.ComponentProps<"div"> & {
  inset?: boolean;
}) {
  return (
    <div
      data-slot="context-menu-label"
      data-inset={inset}
      className={cn("text-foreground px-2 py-1.5 text-sm font-medium data-[inset]:pl-8", className)}
      {...props}
    />
  );
}

function ContextMenuSeparator({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="context-menu-separator"
      role="separator"
      className={cn("bg-border -mx-1 my-1 h-px", className)}
      {...props}
    />
  );
}

function ContextMenuShortcut({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="context-menu-shortcut"
      className={cn("ml-auto text-xs tracking-widest text-muted-foreground", className)}
      {...props}
    />
  );
}

interface ContextMenuSelectEvent {
  defaultPrevented: boolean;
  preventDefault(): void;
  nativeEvent?: {
    isComposing?: boolean;
    keyCode?: number;
  };
  isComposing?: boolean;
  keyCode?: number;
}

function createContextMenuSelectEvent(event: React.MouseEvent<HTMLElement>): ContextMenuSelectEvent {
  let defaultPrevented = false;
  const nativeEvent = event.nativeEvent as MouseEvent & {
    isComposing?: boolean;
    keyCode?: number;
  };
  return {
    get defaultPrevented() {
      return defaultPrevented;
    },
    preventDefault() {
      defaultPrevented = true;
      event.preventDefault();
    },
    nativeEvent,
    isComposing: nativeEvent.isComposing,
    keyCode: nativeEvent.keyCode,
  };
}

function useContextMenuContext(componentName: string): ContextMenuContextValue {
  const context = React.useContext(ContextMenuContext);
  if (!context) {
    throw new Error(`${componentName} must be used within ContextMenu.`);
  }
  return context;
}

export {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuCheckboxItem,
  ContextMenuRadioItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuGroup,
  ContextMenuPortal,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuRadioGroup,
};

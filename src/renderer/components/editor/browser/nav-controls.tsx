/**
 * NavControls — Back / Forward / Reload buttons for the browser tab toolbar.
 *
 * Disabled states are derived from the BrowserRuntimeStore:
 *   - Back button  → disabled when `canGoBack` is false
 *   - Forward button → disabled when `canGoForward` is false
 *   - Reload button → always enabled (v1 does not implement stop)
 *
 * All actions are fire-and-forget IPC calls; errors are silently swallowed at
 * this layer (the WebContents error event will update the runtime store).
 */
import { ChevronLeft, ChevronRight, RotateCcw } from "lucide-react";
import { ipcCallResult } from "@/ipc/client";
import { cn } from "@/utils/cn";

interface NavControlsProps {
  tabId: string;
  canGoBack: boolean;
  canGoForward: boolean;
  /** When true, renders the button group in a dimmed state (no pointer events). */
  disabled?: boolean;
}

function NavButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex items-center justify-center size-7 rounded-(--radius-control)",
        "text-muted-foreground transition-colors outline-none",
        "hover:bg-[var(--state-hover-bg)] hover:text-foreground",
        "active:bg-[var(--state-active-bg)]",
        "focus-visible:ring-[3px] focus-visible:ring-ring/50",
        "disabled:pointer-events-none disabled:opacity-40",
        "[&_svg]:size-4 [&_svg]:pointer-events-none",
      )}
    >
      {children}
    </button>
  );
}

export function NavControls({ tabId, canGoBack, canGoForward, disabled = false }: NavControlsProps) {
  function handleBack() {
    void ipcCallResult("browser", "goBack", { tabId });
  }

  function handleForward() {
    void ipcCallResult("browser", "goForward", { tabId });
  }

  function handleReload() {
    void ipcCallResult("browser", "reload", { tabId });
  }

  return (
    <div
      className={cn("flex items-center gap-0.5", disabled && "pointer-events-none opacity-40")}
      role="toolbar"
      aria-label="Navigation controls"
    >
      <NavButton label="Go back" disabled={!canGoBack} onClick={handleBack}>
        <ChevronLeft aria-hidden="true" />
      </NavButton>
      <NavButton label="Go forward" disabled={!canGoForward} onClick={handleForward}>
        <ChevronRight aria-hidden="true" />
      </NavButton>
      <NavButton label="Reload page" disabled={false} onClick={handleReload}>
        <RotateCcw aria-hidden="true" />
      </NavButton>
    </div>
  );
}

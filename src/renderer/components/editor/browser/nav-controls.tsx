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
import { useTranslation } from "react-i18next";
import { IconButton } from "@/components/ui/icon-button";
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
    <IconButton
      label={label}
      size="md"
      disabled={disabled}
      onClick={onClick}
      className="active:bg-[var(--state-active-bg)] [&_svg]:size-4 [&_svg]:pointer-events-none"
    >
      {children}
    </IconButton>
  );
}

export function NavControls({ tabId, canGoBack, canGoForward, disabled = false }: NavControlsProps) {
  const { t } = useTranslation();
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
      aria-label={t("browser.nav_controls")}
    >
      <NavButton label={t("browser.go_back")} disabled={!canGoBack} onClick={handleBack}>
        <ChevronLeft aria-hidden="true" />
      </NavButton>
      <NavButton label={t("browser.go_forward")} disabled={!canGoForward} onClick={handleForward}>
        <ChevronRight aria-hidden="true" />
      </NavButton>
      <NavButton label={t("browser.reload_page")} disabled={false} onClick={handleReload}>
        <RotateCcw aria-hidden="true" />
      </NavButton>
    </div>
  );
}

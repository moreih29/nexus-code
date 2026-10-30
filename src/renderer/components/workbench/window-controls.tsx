import { Copy, Minus, Square, X } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import { ipcCallResult, ipcListen } from "../../ipc/client";

// ---------------------------------------------------------------------------
// WindowControls — minimize / maximize / close drawn by the renderer
//
// Only the transparent Linux window uses them: Electron draws no frame, and
// so no titleBarOverlay controls, around a transparent window on Linux (see
// main/features/window). Each button calls the window channel, which acts on
// this window.
// ---------------------------------------------------------------------------

export function WindowControls() {
  const { t } = useTranslation();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let active = true;
    void ipcCallResult("window", "isMaximized", undefined).then((result) => {
      if (active && result.ok) setMaximized(result.value);
    });
    const unsubscribe = ipcListen("window", "maximizedChanged", (event) => {
      setMaximized(event.maximized);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  return (
    <div className="app-no-drag ml-2 flex items-center gap-1">
      <ControlButton
        label={t("titleBar.minimize")}
        onClick={() => void ipcCallResult("window", "minimize", undefined)}
      >
        <Minus className="size-4" aria-hidden="true" />
      </ControlButton>
      <ControlButton
        label={maximized ? t("titleBar.restore") : t("titleBar.maximize")}
        onClick={() => void ipcCallResult("window", "toggleMaximize", undefined)}
      >
        {maximized ? (
          <Copy className="size-3.5" aria-hidden="true" />
        ) : (
          <Square className="size-3.5" aria-hidden="true" />
        )}
      </ControlButton>
      <ControlButton
        label={t("titleBar.close")}
        onClick={() => void ipcCallResult("window", "close", undefined)}
      >
        <X className="size-4" aria-hidden="true" />
      </ControlButton>
    </div>
  );
}

function ControlButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn(
        "flex items-center justify-center",
        "size-7 rounded-(--radius-control)",
        "text-muted-foreground",
        "hover:bg-[var(--state-hover-bg)] hover:text-foreground",
        "transition-colors duration-150",
      )}
    >
      {children}
    </button>
  );
}

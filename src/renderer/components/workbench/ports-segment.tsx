// ports-segment.tsx — the status bar's listening ports item.
//
// Shows the TCP ports the programs started in this workspace's terminals
// listen on — a dev server's — as ":5174 :8787". Clicking it opens a menu
// with each port's program and terminal, and the actions on it: open it in
// a browser tab, copy its URL. An SSH workspace's ports are on its host,
// which the app forwards nothing from, so they can only be copied. Renders
// nothing while no program listens.

import { Globe } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import { type ListeningPort, portsLabel, portUrl } from "../../../shared/pty/ports";
import { canOpenPorts, openPortInBrowser } from "../../state/operations/ports";
import { NO_PORTS, usePortsStore } from "../../state/stores/ports";
import { useTabsStore } from "../../state/stores/tabs";
import { copyText } from "../../utils/clipboard";
import { useDismissOnOutsideClick } from "../ui/use-dismiss-on-outside-click";

/** How many ports the segment lists before "+N". */
const SHOWN_PORTS = 3;

export function PortsSegment({ workspaceId }: { workspaceId: string }): React.JSX.Element | null {
  const ports = usePortsStore((s) => s.byWorkspace[workspaceId] ?? NO_PORTS);
  return <PortsSegmentView workspaceId={workspaceId} ports={ports} />;
}

export function PortsSegmentView({
  workspaceId,
  ports,
}: {
  workspaceId: string;
  ports: readonly ListeningPort[];
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  if (ports.length === 0) return null;

  const label = portsLabel(ports, SHOWN_PORTS);
  const title = t("statusBar.ports_title", { ports: portsLabel(ports, ports.length) });

  return (
    <div ref={wrapperRef} className="relative inline-flex h-full">
      <button
        type="button"
        title={title}
        aria-label={title}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "inline-flex items-center gap-1 h-full px-2",
          "text-app-ui-sm font-sans leading-none tabular-nums",
          "hover:bg-[var(--status-bar-item-hover-bg)] focus-visible:bg-[var(--status-bar-item-hover-bg)] focus-visible:outline-none transition-colors",
        )}
      >
        <Globe className="size-3 shrink-0" aria-hidden="true" />
        <span className="truncate max-w-40">{label}</span>
      </button>
      {open ? (
        <PortsPopover
          workspaceId={workspaceId}
          ports={ports}
          wrapperRef={wrapperRef}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </div>
  );
}

const MENU_ITEM_CLASS =
  "flex w-full items-center px-2 py-1 rounded-(--radius-control) text-left text-app-ui-sm text-foreground hover:bg-[var(--state-hover-bg)] focus-visible:bg-[var(--state-hover-bg)] focus-visible:outline-none disabled:text-muted-foreground disabled:hover:bg-transparent";

function PortsPopover({
  workspaceId,
  ports,
  wrapperRef,
  onClose,
}: {
  workspaceId: string;
  ports: readonly ListeningPort[];
  wrapperRef: React.RefObject<HTMLDivElement | null>;
  onClose: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const tabs = useTabsStore((s) => s.byWorkspace[workspaceId]);
  const openable = canOpenPorts(workspaceId);

  useDismissOnOutsideClick(wrapperRef, true, onClose);

  function act(action: () => void): void {
    action();
    onClose();
  }

  return (
    <div
      role="dialog"
      aria-label={t("statusBar.ports_menu_title")}
      className={cn(
        "absolute bottom-full right-0 z-40 mb-1",
        "w-[280px] max-w-[min(280px,calc(100vw-2rem))]",
        "floating-panel p-1",
      )}
    >
      <div className="px-2 pt-1 pb-1.5 flex flex-col gap-0.5">
        <span className="text-app-ui-sm text-foreground font-medium">
          {t("statusBar.ports_menu_title")}
        </span>
        {!openable && (
          <span className="text-app-ui-sm text-muted-foreground">
            {t("statusBar.ports_ssh_note")}
          </span>
        )}
      </div>
      {ports.map((port) => {
        const terminal = tabs?.[port.tabId]?.title;
        return (
          <div key={port.port}>
            <div className="h-px bg-border my-1" />
            <div className="px-2 py-1 flex items-baseline gap-2 min-w-0">
              <span className="text-app-ui-sm text-foreground tabular-nums">
                localhost:{port.port}
              </span>
              <span className="text-app-ui-sm text-muted-foreground truncate">
                {terminal ? `${port.process} · ${terminal}` : port.process}
              </span>
            </div>
            <button
              type="button"
              className={MENU_ITEM_CLASS}
              disabled={!openable}
              onClick={() => act(() => openPortInBrowser(workspaceId, port.port))}
            >
              {t("statusBar.ports_open")}
            </button>
            <button
              type="button"
              className={MENU_ITEM_CLASS}
              onClick={() => act(() => copyText(portUrl(port.port)))}
            >
              {t("statusBar.ports_copy")}
            </button>
          </div>
        );
      })}
    </div>
  );
}

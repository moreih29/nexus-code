// ports-segment.tsx — the status bar's listening ports item.
//
// Shows the TCP ports the programs started in this workspace's terminals
// listen on — a dev server's — as ":5174 :8787". Clicking it opens a menu
// with each port's program and terminal, and the actions on it: open it in
// a browser tab, copy its URL. An SSH workspace's ports are on its host:
// opening or copying one forwards it to this machine, the menu shows where
// each forward listens here, and a forward can be started and stopped by
// hand. Ports forwarded but no longer listed stay in the menu until
// stopped. Renders nothing while no program listens and nothing is
// forwarded.

import { Globe } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import {
  type ListeningPort,
  type PortForward,
  portsLabel,
  portUrl,
} from "../../../shared/pty/ports";
import {
  forwardPort,
  openPortInBrowser,
  portUrlHere,
  sshHostOf,
  unforwardPort,
} from "../../state/operations/ports";
import { NO_FORWARDS, NO_PORTS, useForwardsStore, usePortsStore } from "../../state/stores/ports";
import { useTabsStore } from "../../state/stores/tabs";
import { copyText } from "../../utils/clipboard";
import { useDismissOnOutsideClick } from "../ui/use-dismiss-on-outside-click";

/** How many ports the segment lists before "+N". */
const SHOWN_PORTS = 3;

export function PortsSegment({ workspaceId }: { workspaceId: string }): React.JSX.Element | null {
  const ports = usePortsStore((s) => s.byWorkspace[workspaceId] ?? NO_PORTS);
  const forwards = useForwardsStore((s) => s.byWorkspace[workspaceId] ?? NO_FORWARDS);
  return <PortsSegmentView workspaceId={workspaceId} ports={ports} forwards={forwards} />;
}

/** A row of the menu: a listening port, a forwarded one, or both. */
interface PortRow {
  port: number;
  listening?: ListeningPort;
  forward?: PortForward;
}

function rowsOf(
  ports: readonly ListeningPort[],
  forwards: readonly PortForward[],
): readonly PortRow[] {
  const rows = new Map<number, PortRow>();
  for (const listening of ports) rows.set(listening.port, { port: listening.port, listening });
  for (const forward of forwards) {
    const row = rows.get(forward.remotePort);
    rows.set(forward.remotePort, { ...row, port: forward.remotePort, forward });
  }
  return [...rows.values()].sort((a, b) => a.port - b.port);
}

export function PortsSegmentView({
  workspaceId,
  ports,
  forwards = NO_FORWARDS,
}: {
  workspaceId: string;
  ports: readonly ListeningPort[];
  forwards?: readonly PortForward[];
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  const rows = rowsOf(ports, forwards);
  if (rows.length === 0) return null;

  const label = portsLabel(rows, SHOWN_PORTS);
  const title = t("statusBar.ports_title", { ports: portsLabel(rows, rows.length) });

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
          rows={rows}
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
  rows,
  wrapperRef,
  onClose,
}: {
  workspaceId: string;
  rows: readonly PortRow[];
  wrapperRef: React.RefObject<HTMLDivElement | null>;
  onClose: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const tabs = useTabsStore((s) => s.byWorkspace[workspaceId]);
  const host = sshHostOf(workspaceId);

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
        "absolute bottom-full right-0 z-(--layer-in-panel) mb-1",
        "w-[280px] max-w-[min(280px,calc(100vw-2rem))]",
        "floating-panel p-1",
      )}
    >
      <div className="px-2 pt-1 pb-1.5 flex flex-col gap-0.5">
        <span className="text-app-ui-sm text-foreground font-medium">
          {t("statusBar.ports_menu_title")}
        </span>
        {host !== null && (
          <span className="text-app-ui-sm text-muted-foreground">
            {t("statusBar.ports_ssh_note", { host })}
          </span>
        )}
      </div>
      {rows.map(({ port, listening, forward }) => {
        const terminal = listening ? tabs?.[listening.tabId]?.title : undefined;
        const program = listening
          ? terminal
            ? `${listening.process} · ${terminal}`
            : listening.process
          : t("statusBar.ports_not_listed");
        return (
          <div key={port}>
            <div className="h-px bg-border my-1" />
            <div className="px-2 py-1 flex items-baseline gap-2 min-w-0">
              <span className="text-app-ui-sm text-foreground tabular-nums">localhost:{port}</span>
              <span className="text-app-ui-sm text-muted-foreground truncate">{program}</span>
            </div>
            {forward ? (
              <div className="px-2 pb-1 text-app-ui-sm text-muted-foreground tabular-nums">
                {forward.active
                  ? t("statusBar.ports_forwarded", { url: portUrl(forward.localPort) })
                  : t("statusBar.ports_forward_paused", { url: portUrl(forward.localPort) })}
              </div>
            ) : null}
            <button
              type="button"
              className={MENU_ITEM_CLASS}
              onClick={() => act(() => openPortInBrowser(workspaceId, port))}
            >
              {t("statusBar.ports_open")}
            </button>
            <button
              type="button"
              className={MENU_ITEM_CLASS}
              onClick={() =>
                act(() => {
                  void portUrlHere(workspaceId, port).then((url) => {
                    if (url) copyText(url);
                  });
                })
              }
            >
              {t("statusBar.ports_copy")}
            </button>
            {host !== null ? (
              <button
                type="button"
                className={MENU_ITEM_CLASS}
                onClick={() =>
                  act(() => {
                    if (forward) unforwardPort(workspaceId, port);
                    else void forwardPort(workspaceId, port);
                  })
                }
              >
                {forward ? t("statusBar.ports_unforward") : t("statusBar.ports_forward")}
              </button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

import { useEffect, useRef } from "react";

import type { TerminalServiceStore, TerminalTabId } from "../../services/terminal-service";

export interface TerminalPaneAdapterProps {
  sessionId: TerminalTabId;
  terminalService: TerminalServiceStore;
  active?: boolean;
}

export interface AttachTerminalPaneAdapterHostInput {
  sessionId: TerminalTabId;
  host: HTMLElement;
  terminalService: TerminalServiceStore;
}

export function TerminalPaneAdapter({
  sessionId,
  terminalService,
  active = true,
}: TerminalPaneAdapterProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }

    return attachTerminalPaneAdapterHost({ sessionId, host, terminalService });
  }, [sessionId, terminalService]);

  useEffect(() => {
    if (active) {
      terminalService.getState().focusSession(sessionId);
    }
  }, [active, sessionId, terminalService]);

  return (
    <div
      ref={hostRef}
      data-component="terminal-pane-adapter"
      data-terminal-tab-id={sessionId}
      className="h-full min-h-0 w-full overflow-hidden bg-background"
    />
  );
}

export function attachTerminalPaneAdapterHost({
  sessionId,
  host,
  terminalService,
}: AttachTerminalPaneAdapterHostInput): () => void {
  terminalService.getState().attachToHost(sessionId, host);

  let detached = false;
  return () => {
    if (detached) {
      return;
    }

    detached = true;
    if (terminalService.getState().getMountedHost(sessionId) === host) {
      terminalService.getState().detachFromHost(sessionId);
    }
  };
}

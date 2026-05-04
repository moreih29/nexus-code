import { useEffect, useRef } from "react";
import "@xterm/xterm/css/xterm.css";
import { createTerminalController } from "@/services/terminal";
import type { TerminalController } from "@/services/terminal/types";

interface TerminalViewProps {
  tabId: string;
  cwd: string;
  /**
   * Identifies which layout leaf currently owns the tab. Used as one signal
   * for "DOM was moved → refresh".
   */
  ownerLeafId: string | null;
  /**
   * The current parent into which ContentHost has reparented the stable
   * per-tab portal element. When this element identity changes (slot →
   * hidden, hidden → slot, or slot-A → slot-B during a hoist), the xterm
   * canvas has been reparented and any WebGL/Canvas renderer can lose its
   * rasterized buffer in transit. We refresh xterm to repaint from the
   * in-memory line buffer; without this the viewport stays black until the
   * next data byte arrives.
   *
   * `ownerLeafId` does NOT cover this: a hoist that promotes the surviving
   * sibling reuses the same leaf id, but the DOM still moves because
   * GroupView's React tree position changes.
   */
  parentEl: HTMLElement | null;
  /**
   * Whether the tab is currently the active tab in its group AND the
   * workspace itself is the active workspace. visibility:hidden suspends
   * rendering for canvas/webgl; on becoming visible we must refresh to
   * repaint from the line buffer. Mirrors VSCode's setVisible() pattern.
   */
  isVisible: boolean;
}

export function TerminalView({
  tabId,
  cwd,
  ownerLeafId,
  parentEl,
  isVisible,
}: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<TerminalController | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const controller = createTerminalController({ tabId, cwd, container });
    controllerRef.current = controller;
    return () => {
      controllerRef.current = null;
      controller.dispose();
    };
  }, [tabId, cwd]);

  // Refresh xterm whenever the DOM was reparented or visibility flipped
  // back to true. Each of these can leave the renderer with a stale
  // rasterized buffer that must be rebuilt from the line buffer.
  useEffect(() => {
    if (!parentEl) return;
    if (!isVisible) return;
    controllerRef.current?.refresh();
  }, [ownerLeafId, parentEl, isVisible]);

  return <div ref={containerRef} className="w-full h-full bg-background" />;
}

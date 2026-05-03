import { CanvasAddon } from "@xterm/addon-canvas";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef } from "react";
import "@xterm/xterm/css/xterm.css";
import { color, fontFamily, typeScale } from "../../../../shared/design-tokens";
import { ipcCall, ipcListen } from "../../../ipc/client";

// ---------------------------------------------------------------------------
// FlowControl constants (must match utility/pty-host/flowControl.ts)
// ---------------------------------------------------------------------------
const CHAR_COUNT_ACK_SIZE = 5000;

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface TerminalViewProps {
  tabId: string;
  cwd: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function TerminalView({ tabId, cwd }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const pendingRafRef = useRef<number | null>(null);
  const lastDimsRef = useRef<{ cols: number; rows: number } | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;
    let dispose: (() => void) | null = null;

    (async () => {
      // xterm measures cell metrics synchronously inside term.open() and
      // never re-measures after font swap. With font-display:swap the first
      // mount can lock onto fallback metrics — wait for the actual fonts
      // before opening so cell baseline matches across all terminals.
      const fontSize = typeScale.codeUi.fontSize;
      try {
        await Promise.all([
          document.fonts.load(`${fontSize}px "JetBrains Mono Nerd Font"`),
          document.fonts.load(`${fontSize}px "Sarasa Term K"`),
        ]);
      } catch {
        // If the font loading API rejects, fall through and render with
        // whatever metrics the browser has — better degraded than blank.
      }
      if (disposed) return;

      const term = new Terminal({
        cursorBlink: true,
        fontFamily: fontFamily.monoDisplay,
        fontSize,
        // Match xterm canvas background to our app --background so the
        // terminal area blends with the surrounding chrome (no inset frame).
        // xterm API needs a literal string; CSS var would not resolve here.
        theme: { background: color.bgCanvas },
      });

      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);

      // Attempt WebGL, fall back to Canvas
      let rendererAddon: WebglAddon | CanvasAddon | null = null;
      try {
        const webgl = new WebglAddon();
        // WebglAddon throws synchronously if WebGL is unavailable
        webgl.onContextLoss(() => {
          webgl.dispose();
          const canvas = new CanvasAddon();
          term.loadAddon(canvas);
          rendererAddon = canvas;
        });
        term.loadAddon(webgl);
        rendererAddon = webgl;
      } catch {
        try {
          const canvas = new CanvasAddon();
          term.loadAddon(canvas);
          rendererAddon = canvas;
        } catch {
          // proceed with DOM renderer
          rendererAddon = null;
        }
      }

      term.open(container);

      const runFit = () => {
        if (container.clientWidth === 0 || container.clientHeight === 0) return;
        const d = fitAddon.proposeDimensions();
        if (!d) return;
        const { cols, rows } = d;
        if (lastDimsRef.current?.cols === cols && lastDimsRef.current?.rows === rows) return;
        fitAddon.fit();
        ipcCall("pty", "resize", { tabId, cols, rows }).catch(() => {});
        lastDimsRef.current = { cols, rows };
      };

      // Initial fit — captures spawn dims and seeds lastDimsRef
      runFit();

      const dims = fitAddon.proposeDimensions();
      const cols = dims?.cols ?? 80;
      const rows = dims?.rows ?? 24;
      // Seed lastDimsRef with the dims used at spawn so the first RO callback
      // is a no-op when the container hasn't actually changed size.
      lastDimsRef.current = { cols, rows };

      let pendingAckChars = 0;
      const encoder = new TextEncoder();

      // Handle user input — encode as UTF-8 string and forward to PTY
      const onDataDispose = term.onData((data) => {
        ipcCall("pty", "write", { tabId, data }).catch(() => {});
      });

      // Spawn the PTY
      ipcCall("pty", "spawn", { tabId, cwd, cols, rows }).catch((err) => {
        term.write(`\r\n[spawn failed: ${String(err)}]\r\n`);
      });

      // Listen for data from the PTY
      const unlistenData = ipcListen("pty", "data", (args) => {
        if (args.tabId !== tabId) return;
        const chunk = args.chunk;
        term.write(chunk);

        // Accumulate and send flow-control ack
        pendingAckChars += encoder.encode(chunk).length;
        if (pendingAckChars >= CHAR_COUNT_ACK_SIZE) {
          const toAck = pendingAckChars;
          pendingAckChars = 0;
          ipcCall("pty", "ack", { tabId, bytesConsumed: toAck }).catch(() => {});
        }
      });

      // Listen for PTY exit
      const unlistenExit = ipcListen("pty", "exit", (args) => {
        if (args.tabId !== tabId) return;
        term.write("\r\n[Process exited]\r\n");
      });

      // Resize observer — RAF coalesces burst callbacks; 0-dim and idempotency
      // guards are applied inside runFit.
      const resizeObserver = new ResizeObserver(() => {
        if (pendingRafRef.current != null) return;
        pendingRafRef.current = requestAnimationFrame(() => {
          pendingRafRef.current = null;
          runFit();
        });
      });
      resizeObserver.observe(container);

      dispose = () => {
        if (pendingRafRef.current != null) {
          cancelAnimationFrame(pendingRafRef.current);
          pendingRafRef.current = null;
        }
        onDataDispose.dispose();
        unlistenData();
        unlistenExit();
        resizeObserver.disconnect();
        rendererAddon?.dispose();
        fitAddon.dispose();
        term.dispose();
        ipcCall("pty", "kill", { tabId }).catch(() => {});
      };

      // If unmount fired while we were awaiting fonts, run cleanup now.
      if (disposed) {
        dispose();
        dispose = null;
      }
    })();

    return () => {
      disposed = true;
      dispose?.();
      dispose = null;
    };
  }, [tabId, cwd]);

  return <div ref={containerRef} className="w-full h-full bg-background" />;
}

import { CanvasAddon } from "@xterm/addon-canvas";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef } from "react";
import "@xterm/xterm/css/xterm.css";
import { color, fontFamily, typeScale } from "../../shared/design-tokens";
import { ipcCall, ipcListen } from "../ipc/client";

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

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: fontFamily.monoDisplay,
      fontSize: typeScale.codeUi.fontSize,
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
    fitAddon.fit();

    const dims = fitAddon.proposeDimensions();
    const cols = dims?.cols ?? 80;
    const rows = dims?.rows ?? 24;

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

    // Resize observer
    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
      const d = fitAddon.proposeDimensions();
      if (!d) return;
      ipcCall("pty", "resize", { tabId, cols: d.cols, rows: d.rows }).catch(() => {});
    });
    resizeObserver.observe(container);

    return () => {
      onDataDispose.dispose();
      unlistenData();
      unlistenExit();
      resizeObserver.disconnect();
      rendererAddon?.dispose();
      fitAddon.dispose();
      term.dispose();
      ipcCall("pty", "kill", { tabId }).catch(() => {});
    };
  }, [tabId, cwd]);

  return <div ref={containerRef} className="w-full h-full bg-background" />;
}

import { useEffect, useRef } from "react";
import "@xterm/xterm/css/xterm.css";
import { createTerminalController } from "@/services/terminal";

interface TerminalViewProps {
  tabId: string;
  cwd: string;
}

export function TerminalView({ tabId, cwd }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const controller = createTerminalController({ tabId, cwd, container });
    return () => controller.dispose();
  }, [tabId, cwd]);

  return <div ref={containerRef} className="w-full h-full bg-background" />;
}

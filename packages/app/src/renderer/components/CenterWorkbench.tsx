import type { ReactNode } from "react";
import { Code2, SquareTerminal } from "lucide-react";

import type { CenterWorkbenchMode } from "../stores/editor-store";
import { cn } from "@/lib/utils";

export interface CenterWorkbenchProps {
  mode: CenterWorkbenchMode;
  onModeChange(mode: CenterWorkbenchMode): void;
  editorPane: ReactNode;
  terminalPane: ReactNode;
}

export function CenterWorkbench(props: CenterWorkbenchProps): JSX.Element {
  return <CenterWorkbenchView {...props} />;
}

export function CenterWorkbenchView({
  mode,
  onModeChange,
  editorPane,
  terminalPane,
}: CenterWorkbenchProps): JSX.Element {
  return (
    <main data-component="center-workbench" className="flex h-full min-h-0 flex-col border-r border-border bg-background/80 p-4">
      <header className="flex shrink-0 items-center justify-between gap-3">
        <h2 className="text-xs font-semibold uppercase tracking-[0.16em] text-foreground">Center Workbench</h2>
        <div className="flex rounded-md border border-border bg-card p-0.5" role="tablist" aria-label="Center mode">
          <ModeButton mode="editor" activeMode={mode} onModeChange={onModeChange} />
          <ModeButton mode="terminal" activeMode={mode} onModeChange={onModeChange} />
        </div>
      </header>

      <div className="mt-3 grid min-h-0 flex-1 grid-cols-1 grid-rows-1">
        <div
          data-center-mode-panel="editor"
          data-visible={mode === "editor" ? "true" : "false"}
          className={cn("min-h-0 min-w-0", mode !== "editor" && "hidden")}
        >
          {editorPane}
        </div>
        <div
          data-center-mode-panel="terminal"
          data-visible={mode === "terminal" ? "true" : "false"}
          className={cn("min-h-0 min-w-0", mode !== "terminal" && "hidden")}
        >
          <div className="h-full min-h-0 rounded-md border border-border bg-card p-3">
            {terminalPane}
          </div>
        </div>
      </div>
    </main>
  );
}

function ModeButton({
  mode,
  activeMode,
  onModeChange,
}: {
  mode: CenterWorkbenchMode;
  activeMode: CenterWorkbenchMode;
  onModeChange(mode: CenterWorkbenchMode): void;
}): JSX.Element {
  const active = activeMode === mode;
  const Icon = mode === "editor" ? Code2 : SquareTerminal;
  const label = mode === "editor" ? "Editor" : "Terminal";

  return (
    <button
      type="button"
      role="tab"
      data-action="center-mode-switch"
      data-mode={mode}
      data-active={active ? "true" : "false"}
      aria-selected={active}
      className={cn(
        "inline-flex h-8 items-center gap-1.5 rounded px-2 text-xs font-medium text-muted-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active ? "bg-accent text-accent-foreground" : "hover:bg-accent/50 hover:text-foreground",
      )}
      onClick={() => onModeChange(mode)}
    >
      <Icon aria-hidden="true" className="size-3.5" strokeWidth={1.75} />
      {label}
    </button>
  );
}

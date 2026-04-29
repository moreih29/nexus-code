import type { ReactNode } from "react";

import { TerminalPane, type TerminalPaneProps } from "../../components/TerminalPane";
import { Button } from "../../components/ui/button";
import { cn } from "../../lib/utils";
import { OutputPanel } from "./OutputPanel";
import { ProblemsPanel } from "./ProblemsPanel";

export type BottomPanelPosition = "left" | "right" | "top" | "bottom";
export type BottomPanelViewId = "terminal" | "output" | "problems" | string;

export interface BottomPanelView {
  id: BottomPanelViewId;
  label: string;
}

const DEFAULT_BOTTOM_PANEL_VIEWS: BottomPanelView[] = [
  { id: "terminal", label: "Terminal" },
  { id: "output", label: "Output" },
  { id: "problems", label: "Problems" },
];

export interface BottomPanelPartProps extends TerminalPaneProps {
  active?: boolean;
  views?: BottomPanelView[];
  activeViewId?: BottomPanelViewId | null;
  position?: BottomPanelPosition;
  expanded?: boolean;
  onActiveViewChange?(viewId: BottomPanelViewId): void;
  viewPanels?: Partial<Record<BottomPanelViewId, ReactNode>>;
}

export function BottomPanelPart({
  sidebarState,
  terminalService,
  detachedTerminalIds,
  onMoveTerminalToEditorArea,
  onDropTerminalTab,
  active = true,
  views = DEFAULT_BOTTOM_PANEL_VIEWS,
  activeViewId = "terminal",
  position = "bottom",
  expanded = true,
  onActiveViewChange,
  viewPanels,
}: BottomPanelPartProps): JSX.Element {
  return (
    <BottomPanelPartView
      views={views}
      active={active}
      activeViewId={activeViewId}
      position={position}
      expanded={expanded}
      onActiveViewChange={onActiveViewChange}
      viewPanels={{
        terminal: (
          <TerminalPane
            sidebarState={sidebarState}
            terminalService={terminalService}
            detachedTerminalIds={detachedTerminalIds}
            onMoveTerminalToEditorArea={onMoveTerminalToEditorArea}
            onDropTerminalTab={onDropTerminalTab}
          />
        ),
        output: <OutputPanel />,
        problems: <ProblemsPanel />,
        ...viewPanels,
      }}
    />
  );
}

export interface BottomPanelPartViewProps {
  views: BottomPanelView[];
  active?: boolean;
  activeViewId: BottomPanelViewId | null;
  position: BottomPanelPosition;
  expanded: boolean;
  onActiveViewChange?(viewId: BottomPanelViewId): void;
  viewPanels: Partial<Record<BottomPanelViewId, ReactNode>>;
}

export function BottomPanelPartView({
  views,
  active = true,
  activeViewId,
  position,
  expanded,
  onActiveViewChange,
  viewPanels,
}: BottomPanelPartViewProps): JSX.Element {
  const resolvedActiveViewId = activeViewId && views.some((view) => view.id === activeViewId)
    ? activeViewId
    : views[0]?.id ?? null;

  return (
    <section
      data-component="bottom-panel"
      data-bottom-panel-position={position}
      data-bottom-panel-expanded={expanded ? "true" : "false"}
      data-active={active ? "true" : "false"}
      data-bottom-panel-active-view={resolvedActiveViewId ?? ""}
      className="flex h-full min-h-0 min-w-0 flex-col bg-background text-foreground"
    >
      <header
        data-bottom-panel-header="true"
        className={cn(
          "flex h-10 shrink-0 items-center gap-2 border-b border-border px-3",
          active ? "bg-card" : "bg-card/60",
        )}
      >
        <div
          role="tablist"
          aria-orientation="horizontal"
          aria-label="Bottom panel views"
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
        >
          {views.map((view) => {
            const active = view.id === resolvedActiveViewId;
            return (
              <Button
                key={view.id}
                type="button"
                role="tab"
                data-action="bottom-panel-select-view"
                data-bottom-panel-view={view.id}
                data-active={active ? "true" : "false"}
                aria-selected={active}
                variant="ghost"
                size="sm"
                className={cn(
                  "h-8 px-2 text-xs text-muted-foreground hover:text-foreground",
                  active && "bg-accent text-foreground",
                )}
                onClick={() => onActiveViewChange?.(view.id)}
              >
                {view.label}
              </Button>
            );
          })}
        </div>
        <div
          data-bottom-panel-dock-zone="true"
          data-bottom-panel-dock-positions="left right top bottom"
          className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground"
        >
          {position}
        </div>
      </header>

      <div className="relative min-h-0 flex-1 overflow-hidden">
        {views.map((view) => {
          const active = view.id === resolvedActiveViewId;
          return (
            <div
              key={view.id}
              data-bottom-panel-view-panel={view.id}
              data-visible={active ? "true" : "false"}
              className={cn(
                "absolute inset-0 min-h-0 min-w-0 bg-background",
                !active && "pointer-events-none invisible",
              )}
              aria-hidden={active ? undefined : true}
            >
              {viewPanels[view.id] ?? null}
            </div>
          );
        })}
      </div>
    </section>
  );
}

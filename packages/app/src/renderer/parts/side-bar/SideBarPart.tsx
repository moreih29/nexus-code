import { Eye } from "lucide-react";
import type { ReactNode } from "react";

import { EmptyState } from "../../components/EmptyState";
import type { ActivityBarSideBarRoute } from "../../services/activity-bar-service";

export interface SideBarPartProps {
  route: ActivityBarSideBarRoute | null;
  explorer: ReactNode;
  search: ReactNode;
  sourceControl: ReactNode;
  tool: ReactNode;
  session: ReactNode;
  preview?: ReactNode;
}

export function SideBarPart({
  route,
  explorer,
  search,
  sourceControl,
  tool,
  session,
  preview = <PreviewEmptyState />,
}: SideBarPartProps): JSX.Element {
  const contentId = route?.contentId ?? "missing";
  const content = selectContent(contentId, {
    explorer,
    search,
    sourceControl,
    tool,
    session,
    preview,
  });

  return (
    <aside
      data-component="side-bar"
      data-active-content-id={contentId}
      className="flex h-full min-h-0 min-w-0 flex-col border-r border-border bg-sidebar/70 text-sidebar-foreground"
    >
      <header className="shrink-0 border-b border-sidebar-border px-3 py-2">
        <h2 className="truncate text-xs font-semibold uppercase tracking-[0.16em] text-sidebar-foreground">
          {route?.title ?? "Side Bar"}
        </h2>
      </header>
      <div className="min-h-0 flex-1 p-3">
        {content}
      </div>
    </aside>
  );
}

function selectContent(
  contentId: string,
  content: {
    explorer: ReactNode;
    search: ReactNode;
    sourceControl: ReactNode;
    tool: ReactNode;
    session: ReactNode;
    preview: ReactNode;
  },
): ReactNode {
  switch (contentId) {
    case "explorer":
      return <div className="flex h-full min-h-0">{content.explorer}</div>;
    case "search":
      return <SideBarPanelShell>{content.search}</SideBarPanelShell>;
    case "source-control":
      return <SideBarPanelShell>{content.sourceControl}</SideBarPanelShell>;
    case "tool":
      return <SideBarPanelShell>{content.tool}</SideBarPanelShell>;
    case "session":
      return <SideBarPanelShell>{content.session}</SideBarPanelShell>;
    case "preview":
      return <SideBarPanelShell>{content.preview}</SideBarPanelShell>;
    default:
      return (
        <SideBarPanelShell>
          <EmptyState
            icon={Eye}
            title="View unavailable"
            description="Select another Activity Bar view."
          />
        </SideBarPanelShell>
      );
  }
}

function SideBarPanelShell({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="h-full min-h-0 overflow-hidden rounded-md border border-border bg-card text-card-foreground">
      {children}
    </div>
  );
}

function PreviewEmptyState(): JSX.Element {
  return (
    <EmptyState
      icon={Eye}
      title="Preview unavailable"
      description="Markdown or localhost preview will appear here when a preview source is selected."
    />
  );
}

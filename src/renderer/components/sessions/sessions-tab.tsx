// Sessions tab — the agent sessions of a workspace and its tasks in one
// place: a header with their counts, the view switch and New Task, the
// chosen view, and the detail panel of the chosen session.
//
// The view is the workspace's own when it was switched, else the default
// from Settings (state/stores/sessions-view.ts). Data is read only while
// the tab is shown.

import { Bot, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { SESSIONS_VIEWS, type SessionsView } from "../../../shared/sessions/view";
import { newTask } from "../../services/sessions/actions";
import { type ActivityByKey, findAgent, runningAgentCount } from "../../services/sessions/agents";
import { phaseCounts, SESSION_PHASES, type SessionFamily } from "../../services/sessions/model";
import {
  useSessionActivity,
  useSessionFamily,
  useTerminalWaits,
  useWorktreeChanges,
} from "../../services/sessions/use-family";
import { selectSessionsView, useSessionsViewStore } from "../../state/stores/sessions-view";
import { SegmentedControl } from "../settings/segmented-control";
import { Button } from "../ui/button";
import { BoardView } from "./board-view";
import { LineageView } from "./lineage-view";
import { resolveSelection, type SessionsSelection } from "./selection";
import { SessionDetail } from "./session-detail";
import { TimelineView } from "./timeline-view";
import { TreeView } from "./tree-view";

interface SessionsTabViewProps {
  workspaceId: string;
  isVisible: boolean;
}

export function SessionsTabView({ workspaceId, isVisible }: SessionsTabViewProps) {
  const family = useSessionFamily(workspaceId, isVisible);
  const ids = useMemo(() => family?.worktrees.map((w) => w.workspace.id) ?? [], [family]);
  const changes = useWorktreeChanges(ids, isVisible);
  const activity = useSessionActivity(ids, isVisible);
  const rootId = family?.root.id ?? workspaceId;
  const view = useSessionsViewStore((s) => selectSessionsView(s, rootId));
  const waits = useTerminalWaits(isVisible && view === "lineage");

  const [picked, setPicked] = useState<SessionsSelection | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const selection = family
    ? resolveSelection(
        family,
        picked,
        (key, agentId) => findAgent(activity, key, agentId) !== undefined,
      )
    : null;
  // Keep what was shown first, so the panel doesn't jump as states change;
  // move on only when it is gone.
  const selectionKey = selection && keyOf(selection);
  useEffect(() => {
    if (selection && (picked === null || keyOf(picked) !== selectionKey)) setPicked(selection);
  }, [selection, selectionKey, picked]);

  if (!family || !selection) return null;

  const select = (next: SessionsSelection) => {
    setPicked(next);
    setDetailOpen(true);
  };
  const showDetail = view === "tree" || detailOpen;

  return (
    <div className="absolute inset-0 flex flex-col bg-background">
      <SessionsHeader family={family} activity={activity} view={view} rootId={rootId} />
      <div className="flex min-h-0 flex-1">
        <div
          className={
            view === "tree"
              ? "app-scrollbar w-[min(320px,40%)] shrink-0 overflow-auto border-r border-border"
              : "app-scrollbar min-w-0 flex-1 overflow-auto"
          }
        >
          {view === "tree" ? (
            <TreeView
              family={family}
              changes={changes}
              activity={activity}
              selection={selection}
              onSelect={select}
            />
          ) : view === "board" ? (
            <BoardView
              family={family}
              changes={changes}
              activity={activity}
              selection={detailOpen ? selection : null}
              onSelect={select}
            />
          ) : view === "lineage" ? (
            <LineageView
              family={family}
              changes={changes}
              waits={waits}
              activity={activity}
              selection={detailOpen ? selection : null}
              onSelect={select}
            />
          ) : (
            <TimelineView
              family={family}
              activity={activity}
              selection={detailOpen ? selection : null}
              onSelect={select}
              visible={isVisible}
            />
          )}
        </div>
        {showDetail && (
          <div
            className={
              view === "tree"
                ? "app-scrollbar min-w-0 flex-1 overflow-auto"
                : "app-scrollbar relative w-[min(400px,45%)] shrink-0 overflow-auto border-l border-border"
            }
          >
            {view !== "tree" && <CloseDetail onClose={() => setDetailOpen(false)} />}
            <SessionDetail
              family={family}
              selection={selection}
              changes={changes}
              activity={activity}
              visible={isVisible}
              onSelect={select}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function keyOf(selection: SessionsSelection): string {
  switch (selection.kind) {
    case "session":
      return selection.key;
    case "agent":
      return `agent:${selection.key}:${selection.agentId}`;
    case "worktree":
      return `worktree:${selection.workspaceId}`;
  }
}

function SessionsHeader({
  family,
  activity,
  view,
  rootId,
}: {
  family: SessionFamily;
  activity: ActivityByKey;
  view: SessionsView;
  rootId: string;
}) {
  const { t } = useTranslation();
  const counts = phaseCounts(family);
  const shownCounts = SESSION_PHASES.filter((phase) => counts[phase] > 0);
  const agents = runningAgentCount(family, activity);
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-3 py-2">
      <span className="truncate text-app-body-emphasis text-foreground">{family.root.name}</span>
      <span className="text-app-ui-sm text-muted-foreground">
        {shownCounts.length === 0
          ? t("sessions.none")
          : shownCounts
              .map((phase) =>
                t("sessions.count", { label: t(`sessions.phase.${phase}`), count: counts[phase] }),
              )
              .join(" · ")}
      </span>
      {agents > 0 && (
        <span className="flex items-center gap-1 text-app-ui-sm text-muted-foreground">
          <Bot aria-hidden className="size-3.5 shrink-0" />
          {t("sessions.agents.running_count", { count: agents })}
        </span>
      )}
      <div className="ml-auto flex items-center gap-2">
        <SegmentedControl
          label={t("sessions.view_label")}
          options={SESSIONS_VIEWS.map((value) => ({ value, label: t(`sessions.view.${value}`) }))}
          value={view}
          onChange={(next) => useSessionsViewStore.getState().setForWorkspace(rootId, next)}
        />
        <Button size="sm" variant="outline" onClick={() => newTask(rootId)}>
          {t("task.new")}
        </Button>
      </div>
    </div>
  );
}

function CloseDetail({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <Button
      size="icon-sm"
      variant="ghost"
      aria-label={t("sessions.detail.close")}
      onClick={onClose}
      className="absolute top-2 right-2"
    >
      <X aria-hidden className="size-3.5" />
    </Button>
  );
}

// Sessions tab — the agent sessions of a workspace and its tasks in one
// place: a header with their counts, the view switch and New Task, the
// chosen view, and the detail panel of the chosen session.
//
// The view is the workspace's own when it was switched, else the default
// from Settings (state/stores/sessions-view.ts). Data is read only while
// the tab is shown.

import { Bot, ChevronDown, GitBranchPlus, Plus, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import { SESSIONS_VIEWS, type SessionsView } from "../../../shared/sessions/view";
import type { WorkspaceMeta } from "../../../shared/types/workspace";
import { newTask } from "../../services/sessions/actions";
import { type ActivityByKey, findAgent, runningAgentCount } from "../../services/sessions/agents";
import { phaseCounts, SESSION_PHASES, type SessionFamily } from "../../services/sessions/model";
import {
  useSessionActivity,
  useSessionFamily,
  useTerminalWaits,
  useWorktreeChanges,
} from "../../services/sessions/use-family";
import { openClaudeTab, openCodexTab } from "../../state/operations/tabs";
import { selectSessionsView, useSessionsViewStore } from "../../state/stores/sessions-view";
import { ClaudeIcon, CodexIcon } from "../chat/agent-icons";
import { SegmentedControl } from "../settings/segmented-control";
import { Button } from "../ui/button";
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRoot,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { BoardView } from "./board-view";
import { LineageView } from "./lineage-view";
import { resolveSelection, type SessionsSelection } from "./selection";
import { SessionDetail } from "./session-detail";
import { StatusView } from "./status-view";
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
  const [query, setQuery] = useState("");
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
  // A list beside the detail it opens, rather than a board the detail covers.
  // Where the tab is narrow, the detail takes the list's place until closed.
  const listed = view === "tree" || view === "status";
  const showDetail = listed || detailOpen;
  const close = () => setDetailOpen(false);

  return (
    <div className="absolute inset-0 flex flex-col bg-background">
      <SessionsHeader
        family={family}
        activity={activity}
        view={view}
        rootId={rootId}
        query={query}
        onQuery={setQuery}
      />
      <div className="@container/agents flex min-h-0 flex-1">
        <div
          className={cn(
            "app-scrollbar overflow-auto",
            listed
              ? cn(
                  "shrink-0 border-r border-border @max-2xl/agents:w-full @max-2xl/agents:border-r-0",
                  view === "tree" ? "w-[min(320px,40%)]" : "w-[min(480px,50%)]",
                  detailOpen && "@max-2xl/agents:hidden",
                )
              : "min-w-0 flex-1",
          )}
        >
          {view === "status" ? (
            <StatusView
              family={family}
              changes={changes}
              activity={activity}
              selection={selection}
              onSelect={select}
              query={query}
            />
          ) : view === "tree" ? (
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
              listed
                ? cn("min-w-0 flex-1", !detailOpen && "@max-2xl/agents:hidden")
                : "w-[min(400px,45%)] shrink-0 border-l border-border"
            }
          >
            <SessionDetail
              family={family}
              selection={selection}
              changes={changes}
              activity={activity}
              visible={isVisible}
              onSelect={select}
              onBack={listed ? close : undefined}
              onClose={listed ? undefined : close}
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
  query,
  onQuery,
}: {
  family: SessionFamily;
  activity: ActivityByKey;
  view: SessionsView;
  rootId: string;
  query: string;
  onQuery: (query: string) => void;
}) {
  const { t } = useTranslation();
  const counts = phaseCounts(family);
  const shownCounts = SESSION_PHASES.filter((phase) => counts[phase] > 0);
  const agents = runningAgentCount(family, activity);
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-3 py-2">
      {view === "status" ? (
        // The groups count the conversations; the header finds them.
        <label className="flex h-8 min-w-40 flex-1 items-center gap-1.5 rounded-(--radius-control) border border-border bg-background px-2 focus-within:border-ring">
          <Search aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            type="search"
            value={query}
            onChange={(event) => onQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && query !== "") {
                event.preventDefault();
                onQuery("");
              }
            }}
            aria-label={t("sessions.list.search")}
            className="min-w-0 flex-1 bg-transparent text-app-ui-sm text-foreground outline-none"
          />
        </label>
      ) : (
        <>
          <span className="truncate text-app-body-emphasis text-foreground">
            {family.root.name}
          </span>
          <span className="text-app-ui-sm text-muted-foreground">
            {shownCounts.length === 0
              ? t("sessions.none")
              : shownCounts
                  .map((phase) =>
                    t("sessions.count", {
                      label: t(`sessions.phase.${phase}`),
                      count: counts[phase],
                    }),
                  )
                  .join(" · ")}
          </span>
          {agents > 0 && (
            <span className="flex items-center gap-1 text-app-ui-sm text-muted-foreground">
              <Bot aria-hidden className="size-3.5 shrink-0" />
              {t("sessions.agents.running_count", { count: agents })}
            </span>
          )}
        </>
      )}
      <div className="ml-auto flex items-center gap-2">
        <SegmentedControl
          label={t("sessions.view_label")}
          options={SESSIONS_VIEWS.map((value) => ({ value, label: t(`sessions.view.${value}`) }))}
          value={view}
          onChange={(next) => useSessionsViewStore.getState().setForWorkspace(rootId, next)}
        />
        <NewChat workspace={family.root} />
        <Button
          size="icon-sm"
          variant="outline"
          title={t("task.new")}
          aria-label={t("task.new")}
          onClick={() => newTask(rootId)}
        >
          <GitBranchPlus aria-hidden className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}

/** A new conversation in the workspace: Claude at once, or Codex from the menu. */
function NewChat({ workspace }: { workspace: WorkspaceMeta }) {
  const { t } = useTranslation();
  const open = (agent: "claude" | "codex") =>
    agent === "claude"
      ? openClaudeTab(workspace.id, { cwd: workspace.rootPath })
      : openCodexTab(workspace.id, { cwd: workspace.rootPath });
  return (
    <div className="flex">
      <Button
        size="icon-sm"
        className="rounded-r-none"
        title={t("sessions.list.new_claude")}
        aria-label={t("sessions.list.new_claude")}
        onClick={() => open("claude")}
      >
        <Plus aria-hidden className="size-3.5" />
      </Button>
      <DropdownMenuRoot>
        <DropdownMenuTrigger>
          <Button
            size="icon-sm"
            className="w-6 rounded-l-none border-l border-primary-foreground/25"
            aria-label={t("sessions.list.new_chat")}
            title={t("sessions.list.new_chat")}
          >
            <ChevronDown aria-hidden className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => open("claude")}>
            <ClaudeIcon aria-hidden className="size-3.5" />
            Claude
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => open("codex")}>
            <CodexIcon aria-hidden className="size-3.5" />
            Codex
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenuRoot>
    </div>
  );
}

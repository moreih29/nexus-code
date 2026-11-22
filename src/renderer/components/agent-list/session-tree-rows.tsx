import { ChevronDown, ChevronRight, ListTree } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TerminalOpener } from "../../../shared/chat/relay";
import type { AgentSession } from "../../services/agent-sessions/model";
import {
  familyFoldKey,
  MAX_SESSION_INDENT,
  type SessionCounts,
  type SessionTreeNode,
  sessionChildren,
} from "../../services/agent-sessions/session-tree";
import { useSessionParent } from "../../services/agent-sessions/use-session-parent";
import { useAgentViewStore } from "../../state/stores/agent-view";
import { cn } from "../../utils/cn";
import { GROUP_STATE, GROUP_TINT, StateGlyph } from "./session-status";

const SUMMED = ["attention", "running", "done"] as const;

interface TreeBranchProps {
  node: SessionTreeNode;
  last?: boolean;
  folded: ReadonlySet<string>;
  searching: boolean;
  groupIdle?: boolean;
  testPrefix: "agent-sidebar" | "agent-list";
  renderRow: (node: SessionTreeNode, collapsed: boolean) => ReactNode;
}

/** The shared disclosure and indentation rules for a conversation tree. */
export function SessionTreeBranch({
  node,
  last = true,
  folded,
  searching,
  groupIdle = false,
  testPrefix,
  renderRow,
}: TreeBranchProps) {
  const { t } = useTranslation();
  const [idleOpen, setIdleOpen] = useState(false);
  const { session, depth } = node;
  const collapsed = !searching && folded.has(familyFoldKey(session));
  const { rows, idle } = sessionChildren(node, {
    folded: collapsed,
    groupIdle: groupIdle && !searching,
    showIdle: idleOpen,
  });
  return (
    <TreeLine indent={depth > 0 && depth <= MAX_SESSION_INDENT} last={last} testPrefix={testPrefix}>
      {renderRow(node, collapsed)}
      {rows.map((child, index) => (
        <SessionTreeBranch
          key={child.session.key}
          node={child}
          last={index === rows.length - 1 && idle === 0}
          folded={folded}
          searching={searching}
          groupIdle={groupIdle && !(idleOpen && child.group === "idle")}
          testPrefix={testPrefix}
          renderRow={renderRow}
        />
      ))}
      {idle > 0 && (
        <TreeLine indent={depth < MAX_SESSION_INDENT} last testPrefix={testPrefix}>
          <button
            type="button"
            aria-expanded={idleOpen}
            onClick={() => setIdleOpen(!idleOpen)}
            className="flex h-6 items-center gap-1.5 rounded-(--radius-control) px-2 text-app-micro text-muted-foreground hover:bg-[var(--state-hover-bg)] focus-visible:ring-1 focus-visible:ring-ring"
            data-testid={`${testPrefix}-idle`}
          >
            <StateGlyph state="idle" />
            {t("agentView.list.idle_children", { count: idle })}
            <FoldChevron folded={!idleOpen} />
          </button>
        </TreeLine>
      )}
    </TreeLine>
  );
}

export function FamilyFold({
  session,
  count,
  collapsed,
  testPrefix,
}: {
  session: AgentSession;
  count: number;
  collapsed: boolean;
  testPrefix: string;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      className="pointer-events-auto ml-auto inline-flex shrink-0 items-center gap-0.5 whitespace-nowrap rounded-full border border-border px-1.5 text-muted-foreground hover:bg-[var(--state-hover-bg)] hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
      aria-expanded={!collapsed}
      title={t("agentView.list.toggle_children")}
      onClick={() => useAgentViewStore.getState().toggleFolded(familyFoldKey(session))}
      data-testid={`${testPrefix}-fold-family`}
    >
      <ListTree aria-hidden className="size-3" />
      {t("agentView.list.children", { count })}
      <FoldChevron folded={collapsed} />
    </button>
  );
}

export function visibleParentName(node: SessionTreeNode): string | undefined {
  return node.session.parent?.device || node.parentClosed || node.depth > MAX_SESSION_INDENT
    ? node.parentName
    : undefined;
}

export function useParentCaption(
  name: string | undefined,
  device: TerminalOpener["device"],
  closed: boolean | undefined,
) {
  const { t } = useTranslation();
  if (!name) return undefined;
  const label = device
    ? t("agentView.list.remote_parent", { device: device.name || device.id, name })
    : closed
      ? t("agentView.list.closed_parent", { name })
      : t("agentView.list.parent", { name });
  return { label, hint: device || closed ? label : t("agentView.list.parent_hint", { name }) };
}

export function SessionRelations({
  node,
  collapsed,
}: {
  node: SessionTreeNode;
  collapsed: boolean;
}) {
  const { open } = useSessionParent(node.parentClosed ? node.session.parent : undefined);
  const closed = node.parentClosed && !open;
  const parent = useParentCaption(
    open?.title || visibleParentName(node),
    node.session.parent?.device,
    closed,
  );
  if (!parent && node.count === 0) return null;
  return (
    <div className="pointer-events-none relative flex min-w-0 items-center gap-1.5 text-app-micro">
      {parent && (
        <span
          className={cn("min-w-0 truncate text-muted-foreground", closed && "opacity-70")}
          title={parent.hint}
          data-testid="agent-list-parent"
        >
          {parent.label}
        </span>
      )}
      {node.count > 0 && (
        <FamilyFold
          session={node.session}
          count={node.count}
          collapsed={collapsed}
          testPrefix="agent-list"
        />
      )}
      {collapsed && <StateSummary counts={node.counts} compact testPrefix="agent-list" />}
    </div>
  );
}

export function StateSummary({
  counts,
  compact = false,
  testPrefix = "agent-sidebar",
}: {
  counts: SessionCounts;
  compact?: boolean;
  testPrefix?: string;
}) {
  const { t } = useTranslation();
  const shown = SUMMED.filter((group) => counts[group] > 0);
  if (shown.length === 0) return null;
  return (
    <span
      className={cn(
        "flex shrink-0 items-center text-app-micro whitespace-nowrap tabular-nums",
        compact ? "gap-1" : "gap-2",
      )}
    >
      {shown.map((group) => (
        <span
          key={group}
          className={cn("inline-flex items-center gap-0.5", GROUP_TINT[group])}
          title={`${t(`agentList.group.${group}`)} ${counts[group]}`}
          data-testid={`${testPrefix}-summary`}
        >
          <StateGlyph state={GROUP_STATE[group]} />
          {counts[group]}
        </span>
      ))}
    </span>
  );
}

function TreeLine({
  indent,
  last,
  children,
  testPrefix,
}: {
  indent: boolean;
  last: boolean;
  children: ReactNode;
  testPrefix: string;
}) {
  if (!indent) return children;
  return (
    <div className="relative pl-4" data-testid={`${testPrefix}-tree-line`}>
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute top-0 left-1.5 border-border border-l",
          last ? "h-4 w-2.5 rounded-bl-sm border-b" : "bottom-0",
        )}
      />
      {!last && (
        <span
          aria-hidden
          className="pointer-events-none absolute top-4 left-1.5 w-2.5 border-border border-t"
        />
      )}
      {children}
    </div>
  );
}

export function FoldChevron({ folded }: { folded: boolean }) {
  const Icon = folded ? ChevronRight : ChevronDown;
  return <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />;
}

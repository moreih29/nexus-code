// Sessions tab — lineage view: the workspace and its tasks as cards, laid
// out as a tree of which session made which task (nexus worktree new), with
// dashed lines for terminals waiting on others (nexus terminal wait). Tasks
// made in the app sit apart. The agents a card's sessions run hang under it
// on a dotted line. Choosing a card or an agent shows it in the detail panel
// beside. Positions come from services/sessions/lineage.ts.

import { useId, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import type { AgentRun } from "../../../shared/claude/activity";
import type { TerminalWait } from "../../../shared/sessions/agent-state";
import { type ActivityByKey, agentsOfSessions, isLive } from "../../services/sessions/agents";
import {
  AGENT_ROW_GAP,
  AGENT_ROW_HEIGHT,
  AGENT_ROWS_TOP,
  CARD_HEIGHT,
  CARD_WIDTH,
  COLUMN_GAP,
  type LineageCard,
  type LineageEdge,
  layoutLineage,
} from "../../services/sessions/lineage";
import type { AgentSession, SessionFamily, WorktreeEntry } from "../../services/sessions/model";
import type { WorktreeChanges } from "../../services/sessions/use-family";
import { AgentGlyph, agentKindParts, agentLabel } from "./agent-status";
import { isAgentSelected, type SessionsSelection } from "./selection";
import { AgentBadge, SessionState, useDurationLabel } from "./session-status";

interface LineageViewProps {
  family: SessionFamily;
  changes: ReadonlyMap<string, WorktreeChanges>;
  waits: readonly TerminalWait[];
  activity: ActivityByKey;
  selection: SessionsSelection | null;
  onSelect: (selection: SessionsSelection) => void;
}

/** How far below a card's middle a waiting line runs, clear of a "made" line. */
const WAIT_OFFSET = 16;
/** How many running agents hang under a card; the rest, and the ended ones, are counted. */
const AGENTS_LISTED = 3;
/** Where the dotted line the agents hang on runs, from a card's left. */
const SPINE_X = 12;
const AGENT_INDENT = 24;

interface CardAgents {
  readonly listed: readonly { session: AgentSession; agent: AgentRun }[];
  /** Running agents not listed. */
  readonly moreLive: number;
  readonly ended: number;
  /** The session the count row opens. */
  readonly session: AgentSession | undefined;
}

function cardAgents(worktree: WorktreeEntry, activity: ActivityByKey): CardAgents {
  const all = agentsOfSessions(worktree.sessions, activity);
  const live = all.filter(({ agent }) => isLive(agent));
  const listed = live.slice(0, AGENTS_LISTED);
  return {
    listed,
    moreLive: live.length - listed.length,
    ended: all.length - live.length,
    session: all[0]?.session,
  };
}

function rowsOf(agents: CardAgents): number {
  return agents.listed.length + (agents.moreLive + agents.ended > 0 ? 1 : 0);
}

export function LineageView({
  family,
  changes,
  waits,
  activity,
  selection,
  onSelect,
}: LineageViewProps) {
  const { t } = useTranslation();
  // Marker ids must be unique in the document: hidden sessions tabs stay mounted.
  const markerId = useId().replace(/[^\w-]/g, "");
  const agentsOf = useMemo(
    () => new Map(family.worktrees.map((w) => [w.workspace.id, cardAgents(w, activity)])),
    [family, activity],
  );
  const layout = useMemo(
    () =>
      layoutLineage(family, waits, (w) => {
        const agents = agentsOf.get(w.workspace.id);
        return agents ? rowsOf(agents) : 0;
      }),
    [family, waits, agentsOf],
  );
  const cardOf = new Map(layout.cards.map((card) => [card.worktree.workspace.id, card]));
  const drawn = layout.edges.flatMap((edge) => {
    const from = cardOf.get(edge.from);
    const to = cardOf.get(edge.to);
    return from && to ? [{ edge, d: edgePath(edge, from, to) }] : [];
  });

  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-app-micro text-muted-foreground">
        <span className="flex items-center gap-1.5" title={t("sessions.lineage.legend_created_hint")}>
          <span aria-hidden className="h-px w-6 bg-muted-foreground" />
          {t("sessions.lineage.legend_created")}
        </span>
        <span className="flex items-center gap-1.5" title={t("sessions.lineage.legend_waits_hint")}>
          <span aria-hidden className="w-6 border-t border-dashed border-(--state-warning-fg)" />
          {t("sessions.lineage.legend_waits")}
        </span>
      </div>
      <div className="relative shrink-0" style={{ width: layout.width, height: layout.height }}>
        {/* biome-ignore lint/a11y/noSvgWithoutTitle: the lines repeat what the legend says, hidden via aria-hidden */}
        <svg
          aria-hidden
          className="absolute inset-0 overflow-visible"
          width={layout.width}
          height={layout.height}
        >
          <defs>
            <marker
              id={`${markerId}-made`}
              viewBox="0 0 8 8"
              refX="8"
              refY="4"
              markerWidth="7"
              markerHeight="7"
              orient="auto"
            >
              <path d="M0,0 L8,4 L0,8 z" className="fill-muted-foreground" />
            </marker>
            <marker
              id={`${markerId}-waits`}
              viewBox="0 0 8 8"
              refX="8"
              refY="4"
              markerWidth="7"
              markerHeight="7"
              orient="auto"
            >
              <path d="M0,0 L8,4 L0,8 z" className="fill-(--state-warning-fg)" />
            </marker>
          </defs>
          {layout.cards.map((card) =>
            card.agentRows > 0 ? (
              <path
                key={`spine:${card.worktree.workspace.id}`}
                d={spinePath(card)}
                fill="none"
                strokeWidth={1}
                strokeDasharray="2 3"
                className="stroke-muted-foreground"
              />
            ) : null,
          )}
          {drawn.map(({ edge, d }) => (
            <path
              key={`${edge.kind}:${edge.from}:${edge.to}`}
              d={d}
              fill="none"
              strokeWidth={1.5}
              markerEnd={`url(#${markerId}-${edge.kind === "created" ? "made" : "waits"})`}
              {...(edge.kind === "waits" ? { strokeDasharray: "5 4" } : {})}
              className={
                edge.kind === "created" ? "stroke-muted-foreground" : "stroke-(--state-warning-fg)"
              }
            />
          ))}
        </svg>
        {layout.separateTop !== null && (
          <span
            className="absolute left-0 text-app-label text-muted-foreground"
            style={{ top: layout.separateTop }}
          >
            {t("sessions.lineage.separate")}
          </span>
        )}
        {layout.cards.map((card) => {
          const agents = agentsOf.get(card.worktree.workspace.id);
          return agents && card.agentRows > 0 ? (
            <AgentRows
              key={`agents:${card.worktree.workspace.id}`}
              card={card}
              agents={agents}
              selection={selection}
              onSelect={onSelect}
            />
          ) : null;
        })}
        {layout.cards.map((card) => (
          <CardButton
            key={card.worktree.workspace.id}
            card={card}
            changedFiles={changes.get(card.worktree.workspace.id)?.files.length ?? 0}
            selected={isSelected(card, selection)}
            onSelect={() =>
              onSelect(
                card.session
                  ? { kind: "session", key: card.session.key }
                  : { kind: "worktree", workspaceId: card.worktree.workspace.id },
              )
            }
          />
        ))}
      </div>
    </div>
  );
}

function isSelected(card: LineageCard, selection: SessionsSelection | null): boolean {
  if (selection?.kind === "worktree") return selection.workspaceId === card.worktree.workspace.id;
  return (
    selection?.kind === "session" && card.worktree.sessions.some((s) => s.key === selection.key)
  );
}

/** The top of a card's agent row `index`. */
function agentRowTop(card: LineageCard, index: number): number {
  return card.y + CARD_HEIGHT + AGENT_ROWS_TOP + index * (AGENT_ROW_HEIGHT + AGENT_ROW_GAP);
}

/** The dotted line down from a card, with a short arm to each agent row. */
function spinePath(card: LineageCard): string {
  const x = card.x + SPINE_X;
  const middles = Array.from(
    { length: card.agentRows },
    (_, i) => agentRowTop(card, i) + AGENT_ROW_HEIGHT / 2,
  );
  const last = middles[middles.length - 1] ?? card.y + CARD_HEIGHT;
  const arms = middles.map((y) => `M ${x} ${y} H ${card.x + AGENT_INDENT}`).join(" ");
  return `M ${x} ${card.y + CARD_HEIGHT} V ${last} ${arms}`;
}

/** The agents under a card: the running ones by name, then a count of the rest. */
function AgentRows({
  card,
  agents,
  selection,
  onSelect,
}: {
  card: LineageCard;
  agents: CardAgents;
  selection: SessionsSelection | null;
  onSelect: (selection: SessionsSelection) => void;
}) {
  const { t } = useTranslation();
  const place = (index: number) => ({
    left: card.x + AGENT_INDENT,
    top: agentRowTop(card, index),
    width: CARD_WIDTH - AGENT_INDENT,
    height: AGENT_ROW_HEIGHT,
  });
  const rest = [
    agents.moreLive > 0 && t("sessions.agents.more", { count: agents.moreLive }),
    agents.ended > 0 && t("sessions.agents.count_ended", { count: agents.ended }),
  ].filter((part): part is string => typeof part === "string");
  return (
    <>
      {agents.listed.map(({ session, agent }, index) => {
        const selected = isAgentSelected(selection, session.key, agent.id);
        return (
          <button
            key={`${session.key}:${agent.id}`}
            type="button"
            onClick={() => onSelect({ kind: "agent", key: session.key, agentId: agent.id })}
            aria-pressed={selected}
            style={place(index)}
            className={cn(
              "absolute flex min-w-0 items-center gap-1.5 rounded-full border bg-background px-2 text-left transition-colors",
              selected
                ? "border-[var(--state-selected-indicator)]"
                : agent.state === "permissionPending"
                  ? "border-(--state-warning-fg) hover:bg-[var(--state-hover-bg)]"
                  : "border-border hover:bg-[var(--state-hover-bg)]",
            )}
          >
            <AgentGlyph state={agent.state} />
            <span className="min-w-0 flex-1 truncate text-app-micro text-foreground">
              {agentLabel(agent)}
            </span>
            <span className="max-w-[35%] shrink-0 truncate font-mono text-app-micro text-muted-foreground">
              {agentKindParts(agent)[0]}
            </span>
          </button>
        );
      })}
      {rest.length > 0 && agents.session && (
        <button
          type="button"
          onClick={() => agents.session && onSelect({ kind: "session", key: agents.session.key })}
          style={place(agents.listed.length)}
          className="absolute flex items-center truncate rounded-full px-2 text-left text-app-micro text-muted-foreground transition-colors hover:bg-[var(--state-hover-bg)]"
        >
          {rest.join(" · ")}
        </button>
      )}
    </>
  );
}

/**
 * Where an edge runs. A "made" line leaves its maker's right side and turns
 * down or up into the task's left side; a waiting line curves from the
 * waiter to the terminal it waits on, round the right when they share a
 * column. How long the wait has lasted is on the waiter's card.
 */
function edgePath(edge: LineageEdge, from: LineageCard, to: LineageCard): string {
  const middle = (card: LineageCard) => card.y + CARD_HEIGHT / 2;
  if (edge.kind === "created") {
    const x1 = from.x + CARD_WIDTH;
    const turn = x1 + COLUMN_GAP / 2;
    return `M ${x1} ${middle(from)} H ${turn} V ${middle(to)} H ${to.x}`;
  }
  const y1 = middle(from) + WAIT_OFFSET;
  const y2 = middle(to) + WAIT_OFFSET;
  if (from.x === to.x) {
    const x = from.x + CARD_WIDTH;
    const bulge = (COLUMN_GAP * 3) / 4;
    return `M ${x} ${y1} C ${x + bulge} ${y1}, ${x + bulge} ${y2}, ${x} ${y2}`;
  }
  const rightward = to.x > from.x;
  const x1 = rightward ? from.x + CARD_WIDTH : from.x;
  const x2 = rightward ? to.x : to.x + CARD_WIDTH;
  const pull = (x2 - x1) / 2;
  return `M ${x1} ${y1} C ${x1 + pull} ${y1}, ${x2 - pull} ${y2}, ${x2} ${y2}`;
}

function CardButton({
  card,
  changedFiles,
  selected,
  onSelect,
}: {
  card: LineageCard;
  changedFiles: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  const { worktree, session } = card;
  const line = session?.prompt ?? session?.message;
  const waiting = useDurationLabel(card.waitingSince);
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      style={{ left: card.x, top: card.y, width: CARD_WIDTH, height: CARD_HEIGHT }}
      className={cn(
        "absolute flex flex-col gap-1.5 overflow-hidden rounded-(--radius-control) border bg-muted p-2 text-left transition-colors",
        selected
          ? "border-[var(--state-selected-indicator)]"
          : session?.phase === "attention"
            ? "border-(--state-warning-fg) hover:bg-[var(--state-hover-bg)]"
            : "border-border hover:bg-[var(--state-hover-bg)]",
      )}
    >
      <span className="flex w-full min-w-0 items-center gap-2">
        <span className="truncate text-app-body-emphasis text-foreground">
          {worktree.workspace.name}
        </span>
        {session && (
          <span className="ml-auto">
            <AgentBadge agent={session.agent} />
          </span>
        )}
      </span>
      {session ? (
        <SessionState session={session} />
      ) : (
        <span className="text-app-ui-sm text-muted-foreground">{t("sessions.no_sessions")}</span>
      )}
      {line && <span className="w-full truncate text-app-ui-sm text-foreground">{line}</span>}
      <span className="mt-auto flex min-w-0 items-center gap-2 text-app-micro text-muted-foreground">
        {changedFiles > 0 && <span>{t("sessions.changed_files", { count: changedFiles })}</span>}
        {worktree.sessions.length > 1 && (
          <span>{t("sessions.lineage.sessions", { count: worktree.sessions.length })}</span>
        )}
        {card.waitingSince !== undefined && (
          <span className="truncate text-(--state-warning-fg)">
            {t("sessions.lineage.waiting", { duration: waiting })}
          </span>
        )}
      </span>
    </button>
  );
}

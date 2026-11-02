/**
 * The lineage view's layout: each worktree of a family as a card, placed as
 * a tree of which session made which task (nexus worktree new), with lines
 * for the terminals waiting on others (nexus terminal wait). Tasks no
 * session made, or whose maker is gone, are placed apart. Pure: positions
 * are worked out here so the view only draws them.
 */

import type { TerminalWait } from "../../../shared/sessions/agent-state";
import {
  type AgentSession,
  allSessions,
  leadSession,
  type SessionFamily,
  sessionKey,
  type WorktreeEntry,
} from "./model";

export const CARD_WIDTH = 232;
export const CARD_HEIGHT = 120;
export const COLUMN_GAP = 72;
export const ROW_GAP = 16;
/** The room above the tasks placed apart, for their heading. */
export const SEPARATE_LABEL_HEIGHT = 32;
/** The rows under a card for the agents its sessions run. */
export const AGENT_ROW_HEIGHT = 24;
export const AGENT_ROW_GAP = 4;
/** The room between a card and its first agent row. */
export const AGENT_ROWS_TOP = 8;

/** How tall the agent rows under a card are. */
export function agentRowsHeight(rows: number): number {
  return rows === 0 ? 0 : AGENT_ROWS_TOP + rows * AGENT_ROW_HEIGHT + (rows - 1) * AGENT_ROW_GAP;
}

export interface LineageCard {
  readonly worktree: WorktreeEntry;
  /** The session the card shows: the one most in need of the user. */
  readonly session: AgentSession | undefined;
  /** Top-left corner, in pixels. */
  readonly x: number;
  readonly y: number;
  /** Since when one of its terminals has been waiting on a terminal, if one is. */
  readonly waitingSince: number | undefined;
  /** How many agent rows are under it. */
  readonly agentRows: number;
}

export interface LineageEdge {
  /** "created": `from`'s session made `to`; "waits": a terminal of `from` waits on one of `to`. */
  readonly kind: "created" | "waits";
  /** Workspace ids of the two cards. */
  readonly from: string;
  readonly to: string;
  /** When the wait began, for a waiting line. */
  readonly since?: number;
}

export interface LineageLayout {
  readonly cards: readonly LineageCard[];
  readonly edges: readonly LineageEdge[];
  /** The top of the tasks placed apart, when there are any. */
  readonly separateTop: number | null;
  readonly width: number;
  readonly height: number;
}

/**
 * The waits among a family's terminals that still hold: a waiting agent
 * session that is no longer running has been interrupted, whatever the
 * registry says.
 */
function liveWaits(family: SessionFamily, waits: readonly TerminalWait[]): TerminalWait[] {
  const ids = new Set(family.worktrees.map((w) => w.workspace.id));
  const sessions = new Map(allSessions(family).map((s) => [s.key, s]));
  return waits.filter((wait) => {
    if (!ids.has(wait.waiter.workspaceId) || !ids.has(wait.target.workspaceId)) return false;
    const waiter = sessions.get(sessionKey(wait.waiter.workspaceId, wait.waiter.tabId));
    return waiter === undefined || waiter.phase === "running";
  });
}

/**
 * `agentRows` tells how many rows of agents go under a worktree's card;
 * the cards below make room for them.
 */
export function layoutLineage(
  family: SessionFamily,
  waits: readonly TerminalWait[],
  agentRows: (worktree: WorktreeEntry) => number = () => 0,
): LineageLayout {
  const byId = new Map(family.worktrees.map((w) => [w.workspace.id, w]));
  const makerOf = (worktree: WorktreeEntry): string | undefined => {
    const maker = worktree.workspace.task?.createdBy?.workspaceId;
    return maker !== undefined && maker !== worktree.workspace.id && byId.has(maker)
      ? maker
      : undefined;
  };
  const children = new Map<string, string[]>();
  for (const worktree of family.worktrees) {
    const maker = makerOf(worktree);
    if (maker) children.set(maker, [...(children.get(maker) ?? []), worktree.workspace.id]);
  }

  const held = liveWaits(family, waits);
  const waitingSince = new Map<string, number>();
  for (const wait of held) {
    const id = wait.waiter.workspaceId;
    waitingSince.set(id, Math.min(waitingSince.get(id) ?? wait.since, wait.since));
  }

  const cards: LineageCard[] = [];
  const placed = new Set<string>();
  let top = 0;
  let depthMax = 0;
  // Leaves stack down; a parent sits level with the middle of its children.
  const place = (id: string, depth: number): number => {
    placed.add(id);
    depthMax = Math.max(depthMax, depth);
    const ys: number[] = [];
    for (const kid of children.get(id) ?? []) {
      if (!placed.has(kid)) ys.push(place(kid, depth + 1));
    }
    const worktree = byId.get(id) as WorktreeEntry;
    const rows = agentRows(worktree);
    const height = CARD_HEIGHT + agentRowsHeight(rows);
    let y: number;
    if (ys.length === 0) {
      y = top;
      top += height + ROW_GAP;
    } else {
      y = ((ys[0] ?? 0) + (ys[ys.length - 1] ?? 0)) / 2;
      // Its agent rows may reach below its children.
      top = Math.max(top, y + height + ROW_GAP);
    }
    cards.push({
      worktree,
      session: leadSession(worktree.sessions),
      x: depth * (CARD_WIDTH + COLUMN_GAP),
      y,
      waitingSince: waitingSince.get(id),
      agentRows: rows,
    });
    return y;
  };

  place(family.root.id, 0);
  const apart = family.worktrees.filter((w) => !placed.has(w.workspace.id) && !makerOf(w));
  const stray = family.worktrees.filter((w) => !placed.has(w.workspace.id) && makerOf(w));
  let separateTop: number | null = null;
  if (apart.length + stray.length > 0) {
    separateTop = top;
    top += SEPARATE_LABEL_HEIGHT;
    for (const worktree of [...apart, ...stray]) {
      if (!placed.has(worktree.workspace.id)) place(worktree.workspace.id, 0);
    }
  }

  const edges: LineageEdge[] = [];
  for (const worktree of family.worktrees) {
    const maker = makerOf(worktree);
    if (maker) edges.push({ kind: "created", from: maker, to: worktree.workspace.id });
  }
  const waitEdges = new Map<string, LineageEdge>();
  for (const wait of held) {
    const from = wait.waiter.workspaceId;
    const to = wait.target.workspaceId;
    if (from === to) continue;
    const key = `${from}>${to}`;
    const since = Math.min(waitEdges.get(key)?.since ?? wait.since, wait.since);
    waitEdges.set(key, { kind: "waits", from, to, since });
  }
  edges.push(...waitEdges.values());

  return {
    cards,
    edges,
    separateTop,
    width: (depthMax + 1) * (CARD_WIDTH + COLUMN_GAP) - COLUMN_GAP,
    height: Math.max(0, top - ROW_GAP),
  };
}

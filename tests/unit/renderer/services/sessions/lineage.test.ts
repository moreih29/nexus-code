/**
 * The lineage view's layout: worktrees placed as a tree of which session
 * made which task, tasks no session made placed apart, and lines for the
 * terminals waiting on others.
 */
import { describe, expect, it } from "bun:test";
import {
  agentRowsHeight,
  CARD_HEIGHT,
  CARD_WIDTH,
  COLUMN_GAP,
  layoutLineage,
  ROW_GAP,
  SEPARATE_LABEL_HEIGHT,
} from "../../../../../src/renderer/services/sessions/lineage";
import type {
  AgentSession,
  SessionFamily,
  WorktreeEntry,
} from "../../../../../src/renderer/services/sessions/model";
import type { WorkspaceMeta } from "../../../../../src/shared/types/workspace";

const ROOT = "00000000-0000-4000-8000-000000000001";
const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const C = "00000000-0000-4000-8000-00000000000c";
const UI = "00000000-0000-4000-8000-0000000000ff";

const COLUMN = CARD_WIDTH + COLUMN_GAP;
const ROW = CARD_HEIGHT + ROW_GAP;

function worktree(
  id: string,
  createdBy?: string,
  sessions: Array<Partial<AgentSession>> = [],
): WorktreeEntry {
  const workspace = {
    id,
    name: id.slice(-2),
    ...(id === ROOT
      ? {}
      : {
          task: {
            parentId: ROOT,
            branch: id.slice(-2),
            worktreePath: `/w/${id}`,
            ...(createdBy ? { createdBy: { workspaceId: createdBy, tabId: "maker" } } : {}),
          },
        }),
  } as WorkspaceMeta;
  return {
    workspace,
    isRoot: id === ROOT,
    branch: undefined,
    sessions: sessions.map(
      (s) =>
        ({
          key: `${id}:${s.tabId}`,
          workspaceId: id,
          phase: "idle",
          state: "idle",
          ...s,
        }) as AgentSession,
    ),
  };
}

function family(...worktrees: WorktreeEntry[]): SessionFamily {
  return { root: worktrees[0]?.workspace as WorkspaceMeta, worktrees };
}

const position = (layout: ReturnType<typeof layoutLineage>, id: string) => {
  const card = layout.cards.find((c) => c.worktree.workspace.id === id);
  return card && [card.x, card.y];
};

describe("layoutLineage", () => {
  it("places the tasks a session made right of its worktree, the maker level with their middle", () => {
    const layout = layoutLineage(
      family(worktree(ROOT), worktree(A, ROOT), worktree(B, ROOT), worktree(C, A)),
      [],
    );
    expect(position(layout, C)).toEqual([2 * COLUMN, 0]);
    expect(position(layout, A)).toEqual([COLUMN, 0]);
    expect(position(layout, B)).toEqual([COLUMN, ROW]);
    expect(position(layout, ROOT)).toEqual([0, ROW / 2]);
    expect(layout.edges).toEqual([
      { kind: "created", from: ROOT, to: A },
      { kind: "created", from: ROOT, to: B },
      { kind: "created", from: A, to: C },
    ]);
    expect(layout.separateTop).toBeNull();
    expect(layout.width).toBe(3 * COLUMN - COLUMN_GAP);
    expect(layout.height).toBe(2 * ROW - ROW_GAP);
  });

  it("places tasks made in the app, or by a worktree that is gone, apart", () => {
    const layout = layoutLineage(
      family(worktree(ROOT), worktree(UI), worktree(B, "gone"), worktree(C, UI)),
      [],
    );
    expect(layout.separateTop).toBe(ROW);
    expect(position(layout, UI)).toEqual([0, ROW + SEPARATE_LABEL_HEIGHT]);
    expect(position(layout, C)).toEqual([COLUMN, ROW + SEPARATE_LABEL_HEIGHT]);
    expect(position(layout, B)).toEqual([0, 2 * ROW + SEPARATE_LABEL_HEIGHT]);
    expect(layout.edges).toEqual([{ kind: "created", from: UI, to: C }]);
  });

  it("makes room under a card for the agents its sessions run", () => {
    const rows = new Map([
      [A, 2],
      [ROOT, 5],
    ]);
    const layout = layoutLineage(
      family(worktree(ROOT), worktree(A, ROOT), worktree(B, ROOT), worktree(C)),
      [],
      (w) => rows.get(w.workspace.id) ?? 0,
    );
    const aHeight = CARD_HEIGHT + agentRowsHeight(2);
    expect(position(layout, A)).toEqual([COLUMN, 0]);
    expect(position(layout, B)).toEqual([COLUMN, aHeight + ROW_GAP]);
    const rootY = (aHeight + ROW_GAP) / 2;
    expect(position(layout, ROOT)).toEqual([0, rootY]);
    expect(layout.cards.find((c) => c.worktree.workspace.id === ROOT)?.agentRows).toBe(5);
    // The root's agent rows reach below its children: the cards apart start under them.
    expect(layout.separateTop).toBe(rootY + CARD_HEIGHT + agentRowsHeight(5) + ROW_GAP);
  });

  it("shows the session most in need of the user on each card", () => {
    const layout = layoutLineage(
      family(
        worktree(ROOT, undefined, [
          { tabId: "idle", phase: "idle" },
          { tabId: "ask", phase: "attention" },
        ]),
      ),
      [],
    );
    expect(layout.cards[0]?.session?.tabId).toBe("ask");
  });

  it("draws the waits that hold, earliest first, and marks the waiting card", () => {
    const layout = layoutLineage(
      family(
        worktree(ROOT, undefined, [
          { tabId: "lead", phase: "running" },
          { tabId: "stopped", phase: "done" },
        ]),
        worktree(A, ROOT, [{ tabId: "a" }]),
        worktree(B, ROOT, [{ tabId: "b" }]),
      ),
      [
        {
          waiter: { workspaceId: ROOT, tabId: "lead" },
          target: { workspaceId: A, tabId: "a" },
          since: 9,
        },
        {
          waiter: { workspaceId: ROOT, tabId: "shell" },
          target: { workspaceId: A, tabId: "a" },
          since: 5,
        },
        // An agent no longer running was interrupted while it waited.
        {
          waiter: { workspaceId: ROOT, tabId: "stopped" },
          target: { workspaceId: B, tabId: "b" },
          since: 1,
        },
        // Outside the family.
        {
          waiter: { workspaceId: "x", tabId: "y" },
          target: { workspaceId: A, tabId: "a" },
          since: 1,
        },
      ],
    );
    expect(layout.edges.filter((e) => e.kind === "waits")).toEqual([
      { kind: "waits", from: ROOT, to: A, since: 5 },
    ]);
    const root = layout.cards.find((c) => c.worktree.isRoot);
    expect(root?.waitingSince).toBe(5);
    expect(layout.cards.find((c) => c.worktree.workspace.id === A)?.waitingSince).toBeUndefined();
  });
});

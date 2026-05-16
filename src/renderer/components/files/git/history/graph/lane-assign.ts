/**
 * Pure git history lane assignment for the History graph canvas.
 */
import type { LogEntry } from "../../../../../../shared/git/types";

export const MAX_LANES = 24;
const SPILL_LANE = MAX_LANES - 1;

export type LaneSlot = string | null;
export type LaneEdgeKind = "parent" | "merge";
export type LaneCommit = Pick<LogEntry, "sha" | "parents">;

export interface LaneEdge {
  readonly from: string;
  readonly to: string;
  readonly fromLane: number;
  readonly toLane: number;
  readonly kind: LaneEdgeKind;
  readonly spilled?: true;
}

export interface LaneSpill {
  readonly from: string;
  readonly lane: number;
  readonly to?: string;
  readonly parentIndex?: number;
}

export interface LaneState {
  readonly openLanes: readonly LaneSlot[];
  readonly laneByCommit: ReadonlyMap<string, number>;
  readonly edges: readonly LaneEdge[];
  readonly spills: readonly LaneSpill[];
}

interface LaneDraft {
  readonly openLanes: LaneSlot[];
  readonly laneByCommit: Map<string, number>;
  readonly edges: LaneEdge[];
  readonly spills: LaneSpill[];
}

interface ClaimedLane {
  readonly index: number;
  readonly tracked: boolean;
}

interface ParentLane {
  readonly sha: string;
  readonly lane: number;
  readonly spilled: boolean;
}

/** Creates an empty reducer state for a new history query or scope. */
export function initialLaneState(): LaneState {
  return {
    openLanes: [],
    laneByCommit: new Map(),
    edges: [],
    spills: [],
  };
}

/** Assigns lanes for the next log page without mutating the previous state. */
export function reduceLanes(prev: LaneState, page: readonly LaneCommit[]): LaneState {
  const draft: LaneDraft = {
    openLanes: normalizeOpenLanes(prev.openLanes),
    laneByCommit: new Map(prev.laneByCommit),
    edges: [...prev.edges],
    spills: [...prev.spills],
  };

  for (const commit of page) {
    assignCommit(draft, commit);
  }

  return {
    openLanes: normalizeOpenLanes(draft.openLanes),
    laneByCommit: draft.laneByCommit,
    edges: draft.edges,
    spills: draft.spills,
  };
}

/** Assigns one commit, then advances open lanes to its parent commits. */
function assignCommit(draft: LaneDraft, commit: LaneCommit): void {
  const parents = uniqueParents(commit.parents);
  const claimedLane = claimCommitLane(draft, commit.sha);
  const parentLanes = settleParentLanes(draft, commit.sha, claimedLane, parents);

  draft.laneByCommit.set(commit.sha, claimedLane.index);
  appendParentEdges(draft, commit.sha, claimedLane.index, parentLanes);
}

/** Reserves the lane where the current commit node is rendered. */
function claimCommitLane(draft: LaneDraft, sha: string): ClaimedLane {
  const existingLane = findLane(draft.openLanes, sha);
  if (existingLane >= 0) return { index: existingLane, tracked: true };

  const freeLane = findEmptyLane(draft.openLanes);
  if (freeLane >= 0) {
    draft.openLanes[freeLane] = sha;
    return { index: freeLane, tracked: true };
  }

  if (draft.openLanes.length < MAX_LANES) {
    const nextLane = draft.openLanes.length;
    draft.openLanes.push(sha);
    return { index: nextLane, tracked: true };
  }

  draft.spills.push({ from: sha, lane: SPILL_LANE });
  return { index: SPILL_LANE, tracked: false };
}

/** Replaces the current commit with parents while preserving existing deduped lanes. */
function settleParentLanes(
  draft: LaneDraft,
  commitSha: string,
  claimedLane: ClaimedLane,
  parents: readonly string[],
): ParentLane[] {
  if (parents.length === 0) {
    if (claimedLane.tracked) releaseLane(draft.openLanes, claimedLane.index);
    return [];
  }

  const firstParent = parents[0];
  if (claimedLane.tracked) settleFirstParent(draft.openLanes, claimedLane.index, firstParent);

  const parentLanes: ParentLane[] = [resolveVisibleParentLane(draft, commitSha, firstParent, 0)];

  for (let index = 1; index < parents.length; index += 1) {
    parentLanes.push(reserveMergeParentLane(draft, commitSha, parents[index], index));
  }

  trimTrailingEmptyLanes(draft.openLanes);
  return parentLanes;
}

/** Keeps the first parent in the child lane unless that parent is already visible. */
function settleFirstParent(openLanes: LaneSlot[], claimedLane: number, firstParent: string): void {
  const existingParentLane = findLane(openLanes, firstParent);
  if (existingParentLane >= 0 && existingParentLane !== claimedLane) {
    releaseLane(openLanes, claimedLane);
    return;
  }

  openLanes[claimedLane] = firstParent;
}

/** Resolves a parent lane or records that the edge must end at the spill indicator. */
function resolveVisibleParentLane(
  draft: LaneDraft,
  commitSha: string,
  parentSha: string,
  parentIndex: number,
): ParentLane {
  const lane = findLane(draft.openLanes, parentSha);
  if (lane >= 0) return { sha: parentSha, lane, spilled: false };

  draft.spills.push({ from: commitSha, to: parentSha, lane: SPILL_LANE, parentIndex });
  return { sha: parentSha, lane: SPILL_LANE, spilled: true };
}

/** Reuses an existing merge parent lane or opens a capped new lane for it. */
function reserveMergeParentLane(
  draft: LaneDraft,
  commitSha: string,
  parentSha: string,
  parentIndex: number,
): ParentLane {
  const existingLane = findLane(draft.openLanes, parentSha);
  if (existingLane >= 0) return { sha: parentSha, lane: existingLane, spilled: false };

  const freeLane = findEmptyLane(draft.openLanes);
  if (freeLane >= 0) {
    draft.openLanes[freeLane] = parentSha;
    return { sha: parentSha, lane: freeLane, spilled: false };
  }

  if (draft.openLanes.length < MAX_LANES) {
    const lane = draft.openLanes.length;
    draft.openLanes.push(parentSha);
    return { sha: parentSha, lane, spilled: false };
  }

  draft.spills.push({ from: commitSha, to: parentSha, lane: SPILL_LANE, parentIndex });
  return { sha: parentSha, lane: SPILL_LANE, spilled: true };
}

/** Appends graph edges after all destination lanes for the row are known. */
function appendParentEdges(
  draft: LaneDraft,
  commitSha: string,
  fromLane: number,
  parentLanes: readonly ParentLane[],
): void {
  for (let index = 0; index < parentLanes.length; index += 1) {
    const parentLane = parentLanes[index];
    draft.edges.push({
      from: commitSha,
      to: parentLane.sha,
      fromLane,
      toLane: parentLane.lane,
      kind: index === 0 ? "parent" : "merge",
      ...(parentLane.spilled ? { spilled: true } : {}),
    });
  }
}

/** Returns parents in git's first-parent order with duplicate shas removed. */
function uniqueParents(parents: readonly string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];

  for (const parent of parents) {
    if (!parent || seen.has(parent)) continue;
    seen.add(parent);
    unique.push(parent);
  }

  return unique;
}

/** Copies caller-provided lanes into the reducer's compact capped shape. */
function normalizeOpenLanes(openLanes: readonly LaneSlot[]): LaneSlot[] {
  const seen = new Set<string>();
  const normalized: LaneSlot[] = [];

  for (const lane of openLanes.slice(0, MAX_LANES)) {
    if (!lane || seen.has(lane)) {
      normalized.push(null);
      continue;
    }

    seen.add(lane);
    normalized.push(lane);
  }

  trimTrailingEmptyLanes(normalized);
  return normalized;
}

/** Finds the lane that is currently waiting for the requested commit. */
function findLane(openLanes: readonly LaneSlot[], sha: string): number {
  return openLanes.indexOf(sha);
}

/** Finds the first reusable lane gap left by a closed branch. */
function findEmptyLane(openLanes: readonly LaneSlot[]): number {
  return openLanes.indexOf(null);
}

/** Marks a lane as closed while keeping lower-index active lanes stable. */
function releaseLane(openLanes: LaneSlot[], lane: number): void {
  openLanes[lane] = null;
  trimTrailingEmptyLanes(openLanes);
}

/** Removes empty lanes from the right edge so graph width can shrink. */
function trimTrailingEmptyLanes(openLanes: LaneSlot[]): void {
  while (openLanes.at(-1) === null) {
    openLanes.pop();
  }
}

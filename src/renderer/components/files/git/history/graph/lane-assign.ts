/**
 * Pure git history lane assignment for the History graph canvas.
 *
 * The first commit's first-parent line keeps lane 0. Every other line keeps
 * its own lane until it reaches the commit it leads to, and joins it there,
 * so a branch reads as one rail from where it starts to where it merges.
 */
import type { LogEntry } from "../../../../../../shared/git/types";

export const MAX_LANES = 24;
const SPILL_LANE = MAX_LANES - 1;
/** The color of the first commit's first-parent line. */
export const MAINLINE_COLOR = 0;

export type LaneEdgeKind = "parent" | "merge";
export type LaneCommit = Pick<LogEntry, "sha" | "parents">;

/** A lane waiting for a commit, with the color of the line it carries. */
export interface OpenLane {
  readonly sha: string;
  readonly color: number;
}

export type LaneSlot = OpenLane | null;

export interface LaneEdge {
  readonly from: string;
  readonly to: string;
  /** The lane of `from`. */
  readonly fromLane: number;
  /** The lane the line runs down in; it joins `to` in whatever lane that commit takes. */
  readonly toLane: number;
  readonly kind: LaneEdgeKind;
  readonly color: number;
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
  readonly colorByCommit: ReadonlyMap<string, number>;
  readonly edges: readonly LaneEdge[];
  readonly spills: readonly LaneSpill[];
  /** The next commit on the first commit's first-parent line; null once that line ends. */
  readonly mainline: string | null;
  /** The color the next new line takes. */
  readonly nextColor: number;
}

interface LaneDraft {
  readonly openLanes: LaneSlot[];
  readonly laneByCommit: Map<string, number>;
  readonly colorByCommit: Map<string, number>;
  readonly edges: LaneEdge[];
  readonly spills: LaneSpill[];
  mainline: string | null;
  nextColor: number;
}

interface ClaimedLane {
  readonly index: number;
  readonly color: number;
  readonly tracked: boolean;
}

/** Creates an empty reducer state for a new history query or scope. */
export function initialLaneState(): LaneState {
  return {
    openLanes: [],
    laneByCommit: new Map(),
    colorByCommit: new Map(),
    edges: [],
    spills: [],
    mainline: null,
    nextColor: MAINLINE_COLOR + 1,
  };
}

/** Assigns lanes for the next log page without mutating the previous state. */
export function reduceLanes(prev: LaneState, page: readonly LaneCommit[]): LaneState {
  const draft: LaneDraft = {
    openLanes: normalizeOpenLanes(prev.openLanes),
    laneByCommit: new Map(prev.laneByCommit),
    colorByCommit: new Map(prev.colorByCommit),
    edges: [...prev.edges],
    spills: [...prev.spills],
    mainline: prev.mainline,
    nextColor: prev.nextColor,
  };

  for (const commit of page) {
    assignCommit(draft, commit);
  }

  return {
    openLanes: normalizeOpenLanes(draft.openLanes),
    laneByCommit: draft.laneByCommit,
    colorByCommit: draft.colorByCommit,
    edges: draft.edges,
    spills: draft.spills,
    mainline: draft.mainline,
    nextColor: draft.nextColor,
  };
}

/** Assigns one commit, then leaves its lanes waiting for its parent commits. */
function assignCommit(draft: LaneDraft, commit: LaneCommit): void {
  const parents = uniqueParents(commit.parents);
  const onMainline = draft.laneByCommit.size === 0 || commit.sha === draft.mainline;
  const waiting = lanesWaitingFor(draft.openLanes, commit.sha);
  const claimedLane = claimCommitLane(draft, commit.sha, onMainline, waiting);

  // Every line that led here ends at this commit.
  for (const lane of waiting) draft.openLanes[lane] = null;
  draft.laneByCommit.set(commit.sha, claimedLane.index);
  draft.colorByCommit.set(commit.sha, claimedLane.color);
  if (onMainline) draft.mainline = parents[0] ?? null;

  if (parents.length > 0) continueFirstParent(draft, commit.sha, claimedLane, parents[0]);
  for (let index = 1; index < parents.length; index += 1) {
    openMergeParent(draft, commit.sha, claimedLane, parents[index], index);
  }

  trimTrailingEmptyLanes(draft.openLanes);
}

/** Picks the lane the commit's node is drawn in. */
function claimCommitLane(
  draft: LaneDraft,
  sha: string,
  onMainline: boolean,
  waiting: readonly number[],
): ClaimedLane {
  if (onMainline) return { index: 0, color: MAINLINE_COLOR, tracked: true };

  const waitingLane = waiting[0];
  const waitingSlot = waitingLane === undefined ? null : draft.openLanes[waitingLane];
  if (waitingLane !== undefined && waitingSlot) {
    return { index: waitingLane, color: waitingSlot.color, tracked: true };
  }

  const color = takeColor(draft);
  const freeLane = reserveLane(draft);
  if (freeLane !== null) return { index: freeLane, color, tracked: true };

  draft.spills.push({ from: sha, lane: SPILL_LANE });
  return { index: SPILL_LANE, color, tracked: false };
}

/** Keeps the first parent in the commit's own lane, so the line runs on until it gets there. */
function continueFirstParent(
  draft: LaneDraft,
  commitSha: string,
  claimedLane: ClaimedLane,
  parentSha: string,
): void {
  if (claimedLane.tracked) {
    setLane(draft.openLanes, claimedLane.index, { sha: parentSha, color: claimedLane.color });
    draft.edges.push({
      from: commitSha,
      to: parentSha,
      fromLane: claimedLane.index,
      toLane: claimedLane.index,
      kind: "parent",
      color: claimedLane.color,
    });
    return;
  }

  // A spilled commit has no lane to keep; it joins a line already waiting for the parent.
  const lane = draft.openLanes.findIndex((slot) => slot?.sha === parentSha);
  const slot = lane >= 0 ? draft.openLanes[lane] : null;
  if (slot) {
    draft.edges.push({
      from: commitSha,
      to: parentSha,
      fromLane: claimedLane.index,
      toLane: lane,
      kind: "parent",
      color: slot.color,
    });
    return;
  }
  pushSpilledEdge(draft, commitSha, claimedLane, parentSha, 0);
}

/** Joins a line already waiting for the merge parent, or opens a new one for it. */
function openMergeParent(
  draft: LaneDraft,
  commitSha: string,
  claimedLane: ClaimedLane,
  parentSha: string,
  parentIndex: number,
): void {
  const existingLane = draft.openLanes.findIndex((slot) => slot?.sha === parentSha);
  const existingSlot = existingLane >= 0 ? draft.openLanes[existingLane] : null;
  if (existingSlot) {
    draft.edges.push({
      from: commitSha,
      to: parentSha,
      fromLane: claimedLane.index,
      toLane: existingLane,
      kind: "merge",
      color: existingSlot.color,
    });
    return;
  }

  const freeLane = reserveLane(draft);
  if (freeLane === null) {
    pushSpilledEdge(draft, commitSha, claimedLane, parentSha, parentIndex);
    return;
  }

  const color = takeColor(draft);
  setLane(draft.openLanes, freeLane, { sha: parentSha, color });
  draft.edges.push({
    from: commitSha,
    to: parentSha,
    fromLane: claimedLane.index,
    toLane: freeLane,
    kind: "merge",
    color,
  });
}

/** Records a parent edge that ends at the spill indicator because every lane is taken. */
function pushSpilledEdge(
  draft: LaneDraft,
  commitSha: string,
  claimedLane: ClaimedLane,
  parentSha: string,
  parentIndex: number,
): void {
  draft.spills.push({ from: commitSha, to: parentSha, lane: SPILL_LANE, parentIndex });
  draft.edges.push({
    from: commitSha,
    to: parentSha,
    fromLane: claimedLane.index,
    toLane: SPILL_LANE,
    kind: parentIndex === 0 ? "parent" : "merge",
    color: claimedLane.color,
    spilled: true,
  });
}

/** Finds a free lane for a new line, leaving lane 0 to the mainline while it lasts. */
function reserveLane(draft: LaneDraft): number | null {
  const firstLane = draft.mainline === null ? 0 : 1;
  for (let lane = firstLane; lane < draft.openLanes.length; lane += 1) {
    if (draft.openLanes[lane] === null) return lane;
  }
  const nextLane = Math.max(firstLane, draft.openLanes.length);
  return nextLane < MAX_LANES ? nextLane : null;
}

/** Hands out the next line color. */
function takeColor(draft: LaneDraft): number {
  const color = draft.nextColor;
  draft.nextColor += 1;
  return color;
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

/** Copies caller-provided lanes into the reducer's capped shape. */
function normalizeOpenLanes(openLanes: readonly LaneSlot[]): LaneSlot[] {
  const normalized = openLanes.slice(0, MAX_LANES).map((slot) => slot ?? null);
  trimTrailingEmptyLanes(normalized);
  return normalized;
}

/** Lists every lane waiting for the commit; several lines may lead to one commit. */
function lanesWaitingFor(openLanes: readonly LaneSlot[], sha: string): number[] {
  const lanes: number[] = [];
  openLanes.forEach((slot, lane) => {
    if (slot?.sha === sha) lanes.push(lane);
  });
  return lanes;
}

/** Fills a lane, padding any lanes before it so the array has no holes. */
function setLane(openLanes: LaneSlot[], lane: number, slot: OpenLane): void {
  while (openLanes.length < lane) openLanes.push(null);
  openLanes[lane] = slot;
}

/** Removes empty lanes from the right edge so graph width can shrink. */
function trimTrailingEmptyLanes(openLanes: LaneSlot[]): void {
  while (openLanes.at(-1) === null) {
    openLanes.pop();
  }
}

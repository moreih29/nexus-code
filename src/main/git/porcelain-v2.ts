/**
 * Pure parser for `git status --porcelain=v2 -z` output.
 *
 * Single responsibility: convert the raw text produced by git into the typed
 * `GitStatus` value consumed by the Source Control panel. No I/O, no class
 * state, no side-effects — every exported symbol is a pure function or
 * a parser-only constant.
 */
import {
  type BranchInfo,
  DEFAULT_REPO_CAPABILITIES,
  DEFAULT_GIT_OPERATION_STATE,
  type GitConflictType,
  type GitStatus,
  type GitStatusEntry,
} from "../../shared/types/git";

/** XY codes that git status emits for unmerged (conflict) entries. */
const CONFLICT_XY_CODES = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

/** Semantic conflict labels keyed by porcelain-v2 unmerged XY code. */
const CONFLICT_TYPE_BY_XY: ReadonlyMap<string, NonNullable<GitConflictType>> = new Map([
  ["DD", "both-deleted"],
  ["AU", "added-by-us"],
  ["UD", "deleted-by-them"],
  ["UA", "added-by-them"],
  ["DU", "deleted-by-us"],
  ["AA", "both-added"],
  ["UU", "both-modified"],
]);

/** Index-column codes that indicate a change is staged. */
const STAGED_STATUS_CODES = new Set(["M", "A", "D", "R", "C"]);

/** Worktree-column codes that indicate a change is unstaged. */
const WORKING_STATUS_CODES = new Set(["M", "D", "T"]);

/** Accumulated branch header fields parsed from `# branch.*` records. */
interface BranchHeaders {
  head?: string;
  oid?: string;
  upstream?: string;
  ahead: number;
  behind: number;
}

/** Intermediate representation of a single porcelain v2 status record. */
interface ParsedStatusRecord {
  readonly relPath: string;
  readonly oldRelPath?: string;
  readonly xy: string;
  readonly conflictType: GitConflictType;
}

/**
 * Parses porcelain v2 status output into Source Control panel groups.
 */
export function parseV2Porcelain(text: string): GitStatus {
  // Capabilities are populated by GitRepository.readStatus() after this pure
  // parser returns; the parser only fills the porcelain-derived fields.
  const status: GitStatus = {
    merge: [],
    staged: [],
    working: [],
    untracked: [],
    branch: null,
    capabilities: { ...DEFAULT_REPO_CAPABILITIES },
    operationState: DEFAULT_GIT_OPERATION_STATE,
    lastFetchedAt: null,
  };
  const branch: BranchHeaders = { ahead: 0, behind: 0 };
  const records = splitPorcelainRecords(text);
  const nulDelimited = text.includes("\0");

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;

    if (record.startsWith("# ")) {
      parseBranchHeader(record, branch);
      continue;
    }

    if (record.startsWith("1 ")) {
      const entry = parseTrackedRecord(record, 8);
      if (entry) appendTrackedEntry(status, entry);
      continue;
    }

    if (record.startsWith("2 ")) {
      const entry = parseRenamedOrCopiedRecord(
        record,
        nulDelimited ? records[index + 1] : undefined,
      );
      if (entry) appendTrackedEntry(status, entry);
      if (nulDelimited) index += 1;
      continue;
    }

    if (record.startsWith("u ")) {
      const entry = parseTrackedRecord(record, 10);
      if (entry) status.merge.push(entry);
      continue;
    }

    if (record.startsWith("? ")) {
      status.untracked.push({ relPath: record.slice(2), xy: "??", conflictType: null });
    }
  }

  status.branch = buildBranchInfo(branch);
  return status;
}

/**
 * Splits porcelain output while preserving rename old-path records in -z mode.
 */
function splitPorcelainRecords(text: string): string[] {
  if (text.includes("\0")) return text.split("\0").filter((record) => record.length > 0);
  return text.split(/\r?\n/).filter((record) => record.length > 0);
}

/**
 * Extracts branch metadata headers emitted by `git status -b`.
 */
function parseBranchHeader(record: string, branch: BranchHeaders): void {
  const line = record.slice(2);
  if (line.startsWith("branch.head ")) {
    branch.head = line.slice("branch.head ".length);
    return;
  }
  if (line.startsWith("branch.oid ")) {
    branch.oid = line.slice("branch.oid ".length);
    return;
  }
  if (line.startsWith("branch.upstream ")) {
    branch.upstream = line.slice("branch.upstream ".length);
    return;
  }
  if (line.startsWith("branch.ab ")) {
    const match = /^branch\.ab \+(\d+) -(\d+)$/.exec(line);
    if (match) {
      branch.ahead = Number(match[1]);
      branch.behind = Number(match[2]);
    }
  }
}

/**
 * Builds the branch object required by the shared status schema.
 * isUnborn is true when branch.oid is "(initial)", which git emits for
 * repositories that have no commits yet.
 */
function buildBranchInfo(headers: BranchHeaders): BranchInfo | null {
  if (!headers.head) return null;
  return {
    current: headers.head,
    upstream: headers.upstream ?? null,
    ahead: headers.ahead,
    behind: headers.behind,
    isUnborn: headers.oid === "(initial)",
  };
}

/**
 * Parses ordinary and unmerged records where the path is the trailing field.
 */
function parseTrackedRecord(record: string, prefixFieldCount: number): ParsedStatusRecord | null {
  const parsed = splitPrefixAndPath(record, prefixFieldCount);
  if (!parsed) return null;
  const xy = parsed.fields[1];
  if (!xy || xy.length !== 2) return null;
  return { relPath: parsed.path, xy, conflictType: conflictTypeFromXy(xy) };
}

/**
 * Parses rename/copy records, whose old path is a second record in -z mode.
 */
function parseRenamedOrCopiedRecord(
  record: string,
  nulOldPath: string | undefined,
): ParsedStatusRecord | null {
  const parsed = splitPrefixAndPath(record, 9);
  if (!parsed) return null;
  const xy = parsed.fields[1];
  if (!xy || xy.length !== 2) return null;

  if (nulOldPath !== undefined) {
    return {
      relPath: parsed.path,
      oldRelPath: nulOldPath,
      xy,
      conflictType: conflictTypeFromXy(xy),
    };
  }

  const conflictType = conflictTypeFromXy(xy);
  const tabIndex = parsed.path.indexOf("\t");
  if (tabIndex === -1) return { relPath: parsed.path, xy, conflictType };
  return {
    relPath: parsed.path.slice(0, tabIndex),
    oldRelPath: parsed.path.slice(tabIndex + 1),
    xy,
    conflictType,
  };
}

/**
 * Splits a status record into fixed leading fields and a free-form path tail.
 */
function splitPrefixAndPath(
  record: string,
  prefixFieldCount: number,
): { fields: string[]; path: string } | null {
  const fields: string[] = [];
  let cursor = 0;

  for (let index = 0; index < prefixFieldCount; index += 1) {
    const nextSpace = record.indexOf(" ", cursor);
    if (nextSpace === -1) return null;
    fields.push(record.slice(cursor, nextSpace));
    cursor = nextSpace + 1;
  }

  const path = record.slice(cursor);
  if (path.length === 0) return null;
  return { fields, path };
}

/**
 * Applies porcelain grouping rules while preserving the original xy cell.
 */
function appendTrackedEntry(status: GitStatus, entry: GitStatusEntry): void {
  if (CONFLICT_XY_CODES.has(entry.xy)) {
    status.merge.push(entry);
    return;
  }

  const stagedCode = entry.xy[0] ?? ".";
  const workingCode = entry.xy[1] ?? ".";

  if (STAGED_STATUS_CODES.has(stagedCode)) {
    status.staged.push(entry);
  }
  if (WORKING_STATUS_CODES.has(workingCode)) {
    status.working.push(entry);
  }
}

/**
 * Converts porcelain conflict XY codes into stable renderer-facing labels.
 */
function conflictTypeFromXy(xy: string): GitConflictType {
  return CONFLICT_TYPE_BY_XY.get(xy) ?? null;
}

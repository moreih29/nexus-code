/**
 * Derives the file-tree decoration maps from the git session's status.
 *
 * Why a separate module: callers (file-tree row, breadcrumbs, future
 * decorations consumers) all want the same precomputed `Map<absPath, kind>`
 * lookups. Building those once per `statusChanged` push beats every row
 * recomputing them at render.
 *
 * Memoization strategy: the result is keyed by the GitSession object
 * identity. `git.statusChanged` allocates a fresh session each event, so a
 * `WeakMap<GitSession, Decorations>` cache invalidates automatically and
 * never grows beyond the live sessions count.
 *
 * Folder propagation rule lives in `git-decoration.ts` — keep that file pure
 * and dependency-free so it can be unit-tested without the zustand store.
 */
import type { GitStatus, GitStatusEntry } from "../../../../shared/git/types";
import {
  type GitDecorationKind,
  kindFromEntry,
  maxKind,
  propagateToAncestors,
} from "../../../components/files/file-tree/git-decoration";
import type { useGitStore } from "./index";
import type { GitSession } from "./types";

/**
 * Two complementary maps:
 *   - `files`  : absPath → kind for entries reported by porcelain v2.
 *   - `folders`: absPath → kind inherited from descendants (propagation).
 *
 * Both are keyed by the absolute path the file-tree row already knows
 * (workspace-root-relative path joined with the repository topLevel).
 */
export interface GitDecorationMaps {
  readonly files: ReadonlyMap<string, GitDecorationKind>;
  readonly folders: ReadonlyMap<string, GitDecorationKind>;
}

const EMPTY: GitDecorationMaps = {
  files: new Map(),
  folders: new Map(),
};

// ---------------------------------------------------------------------------
// Cache — one entry per live GitSession reference.
// ---------------------------------------------------------------------------

const cache = new WeakMap<GitSession, GitDecorationMaps>();

/**
 * Returns the decoration maps for the given workspace's git session.
 *
 * Reads the session synchronously from the zustand store rather than taking
 * `workspaceId` only — that keeps the function pure relative to its input
 * (workspaceId resolves to a session reference once per call) and lets us
 * cache against the session reference instead of the workspace string.
 *
 * Returns the empty maps when:
 *   - the workspace has no git session yet (loadInitial pending), or
 *   - the workspace is not a git repository, or
 *   - status has not arrived yet.
 */
export function selectGitDecorations(
  state: ReturnType<typeof useGitStore.getState>,
  workspaceId: string,
  rootAbsPath: string,
): GitDecorationMaps {
  const session = state.sessions.get(workspaceId);
  if (!session) return EMPTY;
  if (session.repoInfo.kind !== "repo") return EMPTY;
  if (!session.status) return EMPTY;

  const cached = cache.get(session);
  if (cached) return cached;

  // Use the repository's topLevel for path resolution — the workspace root
  // may sit inside the repo (e.g. opening a sub-folder) and `entry.relPath`
  // is always relative to topLevel.
  const repoRoot = session.repoInfo.topLevel;
  const built = buildDecorations(session.status, repoRoot, rootAbsPath);
  cache.set(session, built);
  return built;
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

function buildDecorations(
  status: GitStatus,
  repoRoot: string,
  rootAbsPath: string,
): GitDecorationMaps {
  const files = new Map<string, GitDecorationKind>();
  const folders = new Map<string, GitDecorationKind>();

  const visit = (entry: GitStatusEntry): void => {
    const kind = kindFromEntry(entry);
    if (kind === null) return;
    const absPath = joinAbsPath(repoRoot, entry.relPath);
    upsertFile(files, absPath, kind);
    propagateToAncestors(folders, absPath, kind, rootAbsPath);

    // Renames carry both endpoints. Mark the old path as deleted so the
    // user sees the move in both the source and destination rows during
    // the brief window before the next status refresh prunes the old path.
    if (entry.oldRelPath !== undefined && entry.oldRelPath !== entry.relPath) {
      const oldAbs = joinAbsPath(repoRoot, entry.oldRelPath);
      upsertFile(files, oldAbs, "renamed");
      propagateToAncestors(folders, oldAbs, "renamed", rootAbsPath);
    }
  };

  // The merge group is the highest-priority signal (conflicts), but it lives
  // alongside the other groups in the snapshot. We visit all four — the
  // priority comparison in `upsertFile` resolves any overlap.
  status.merge.forEach(visit);
  status.staged.forEach(visit);
  status.working.forEach(visit);
  status.untracked.forEach(visit);

  return { files, folders };
}

function upsertFile(
  files: Map<string, GitDecorationKind>,
  absPath: string,
  kind: GitDecorationKind,
): void {
  const existing = files.get(absPath);
  files.set(absPath, existing === undefined ? kind : maxKind(existing, kind));
}

/**
 * Joins repository topLevel with a Git slash-separated relPath. The
 * file-tree uses forward slashes throughout (TreeNode.absPath), and Git
 * always emits forward slashes regardless of platform, so this stays
 * simple. Windows path separators are not introduced here — the tree's
 * existing convention is preserved.
 */
function joinAbsPath(repoRoot: string, relPath: string): string {
  const normalizedRoot = repoRoot.replace(/[\\/]+$/, "");
  return `${normalizedRoot}/${relPath}`;
}

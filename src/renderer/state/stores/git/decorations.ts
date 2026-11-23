import type { GitStatus, GitStatusEntry } from "../../../../shared/git/types";
import {
  type GitDecorationKind,
  kindFromEntry,
  maxKind,
  propagateToAncestors,
} from "../../../components/files/file-tree/git-decoration";
import type { useGitStore } from "./index";
import type { GitSession } from "./types";

export interface GitDecorationMaps {
  readonly files: ReadonlyMap<string, GitDecorationKind>;
  readonly folders: ReadonlyMap<string, GitDecorationKind>;
}

const EMPTY: GitDecorationMaps = {
  files: new Map(),
  folders: new Map(),
};

const cache = new WeakMap<GitSession, GitDecorationMaps>();

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

  const repoRoot = session.repoInfo.topLevel;
  const built = buildDecorations(session.status, repoRoot, rootAbsPath);
  cache.set(session, built);
  return built;
}

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

    if (entry.oldRelPath !== undefined && entry.oldRelPath !== entry.relPath) {
      const oldAbs = joinAbsPath(repoRoot, entry.oldRelPath);
      upsertFile(files, oldAbs, "renamed");
      propagateToAncestors(folders, oldAbs, "renamed", rootAbsPath);
    }
  };

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

function joinAbsPath(repoRoot: string, relPath: string): string {
  const normalizedRoot = repoRoot.replace(/[\\/]+$/, "");
  return `${normalizedRoot}/${relPath}`;
}

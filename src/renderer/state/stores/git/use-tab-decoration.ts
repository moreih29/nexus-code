/**
 * `useTabGitDecoration` — single-path git decoration lookup for editor tabs.
 *
 * The file-tree builds a full Map<absPath, kind> because it renders hundreds
 * of rows. Tabs only ever care about one path each, so a per-row hook is
 * lighter weight: subscribe to the git session + ignored version, run one
 * lookup, return `{ decoration, isIgnored }`.
 *
 * Editor tabs (`type === "editor"`) carry an absolute `filePath` directly.
 * Diff tabs (`type === "editor.diff"`) carry a repo-relative `relPath`
 * that we join with the repository topLevel to get the same absPath the
 * status entries use — the diff is opened from the source-control panel
 * for a flagged file in the working tree, so the same decoration applies.
 * Other tab types (terminal / browser / git.commit / untitled) have no
 * on-disk path and return the empty result.
 */
import { useMemo } from "react";
import type { GitDecorationKind } from "../../../components/files/file-tree/git-decoration";
import type { Tab } from "../tabs";
import { selectGitDecorations } from "./decorations";
import { useIgnoredStore } from "./ignored";
import { useGitSession, useGitStore } from "./index";

export interface TabGitDecoration {
  /** Status kind for the tab's file, or undefined when not flagged. */
  decoration: GitDecorationKind | undefined;
  /** True when the file is under .gitignore (lazy resolution). */
  isIgnored: boolean;
}

const EMPTY: TabGitDecoration = { decoration: undefined, isIgnored: false };

/**
 * Subscribes the calling component to the workspace's git session and
 * ignored-cache version so any `statusChanged` or batched check-ignore
 * flush triggers a re-render.
 */
export function useTabGitDecoration(tab: Tab): TabGitDecoration {
  // Editor + diff tabs both map to a single working-tree file. Other types
  // return the empty result up-front — but the hooks below must still run
  // on every render (no conditional hooks), so we subscribe unconditionally
  // and gate the computation on tab type.
  const workspaceId =
    tab.type === "editor" || tab.type === "editor.diff" ? tab.props.workspaceId : null;

  const gitSession = useGitSession(workspaceId ?? "");
  const ignoredVersion = useIgnoredStore((s) =>
    workspaceId ? (s.byWorkspace.get(workspaceId)?.version ?? 0) : 0,
  );

  // absPath resolution depends on tab type. editor tabs have an absolute
  // filePath already; diff tabs only carry the repo-relative path, so we
  // join with the repository topLevel (read from the session).
  const repoTopLevel = gitSession?.repoInfo.kind === "repo" ? gitSession.repoInfo.topLevel : null;
  const absPath: string | null =
    tab.type === "editor"
      ? tab.props.filePath
      : tab.type === "editor.diff" && repoTopLevel
        ? `${repoTopLevel.replace(/[\\/]+$/, "")}/${tab.props.relPath}`
        : null;

  return useMemo<TabGitDecoration>(() => {
    if (!workspaceId || !absPath) return EMPTY;
    if (!gitSession || gitSession.repoInfo.kind !== "repo") return EMPTY;
    if (!gitSession.status) return EMPTY;

    const sessionTopLevel = gitSession.repoInfo.topLevel;
    // selectGitDecorations is keyed on the GitSession reference via WeakMap,
    // so calling it here shares the same maps that the file tree built —
    // no duplicate work per status push.
    const maps = selectGitDecorations(useGitStore.getState(), workspaceId, sessionTopLevel);
    const decoration = maps.files.get(absPath);

    // Ignored is only checked when there is no explicit status entry — a
    // file cannot be untracked-and-ignored simultaneously in porcelain v2.
    let isIgnored = false;
    if (decoration === undefined) {
      const flag = useIgnoredStore.getState().isIgnored(workspaceId, absPath);
      if (flag === undefined) {
        const root = sessionTopLevel.replace(/[\\/]+$/, "");
        if (absPath.startsWith(`${root}/`)) {
          const relPath = absPath.slice(root.length + 1);
          useIgnoredStore.getState().enqueueCheck(workspaceId, absPath, relPath);
        }
      } else {
        isIgnored = flag;
      }
    }

    // Reference ignoredVersion so the memo invalidates on batch flushes.
    void ignoredVersion;
    return { decoration, isIgnored };
  }, [workspaceId, absPath, gitSession, ignoredVersion]);
}

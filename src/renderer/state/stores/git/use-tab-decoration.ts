import { useMemo } from "react";
import type { GitDecorationKind } from "../../../components/files/file-tree/git-decoration";
import type { Tab } from "../tabs";
import { selectGitDecorations } from "./decorations";
import { useIgnoredStore } from "./ignored";
import { useGitSession, useGitStore } from "./index";

export interface TabGitDecoration {
  decoration: GitDecorationKind | undefined;
  isIgnored: boolean;
}

const EMPTY: TabGitDecoration = { decoration: undefined, isIgnored: false };

export function useTabGitDecoration(tab: Tab): TabGitDecoration {
  const workspaceId =
    tab.type === "editor" || tab.type === "editor.diff" ? tab.props.workspaceId : null;

  const gitSession = useGitSession(workspaceId ?? "");
  const ignoredVersion = useIgnoredStore((s) =>
    workspaceId ? (s.byWorkspace.get(workspaceId)?.version ?? 0) : 0,
  );

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
    const maps = selectGitDecorations(useGitStore.getState(), workspaceId, sessionTopLevel);
    const decoration = maps.files.get(absPath);

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

    void ignoredVersion;
    return { decoration, isIgnored };
  }, [workspaceId, absPath, gitSession, ignoredVersion]);
}

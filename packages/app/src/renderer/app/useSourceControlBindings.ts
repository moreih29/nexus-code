import { useCallback, useMemo } from "react";
import { useStore } from "zustand";

import type { WorkspaceId } from "../../../../shared/src/contracts/workspace/workspace";
import type { EditorDocumentsServiceStore } from "../services/editor-documents-service";
import type { EditorGroupsServiceStore } from "../services/editor-groups-service";
import type { WorkspaceServiceStore } from "../services/workspace-service";
import type { SourceControlStore, SourceControlWorkspaceState } from "../stores/source-control-store";
import { openEditorDiffInServices, runEditorMutation } from "./useEditorBindings";

export interface SourceControlBindingsWorkspace {
  id: WorkspaceId;
  absolutePath: string;
}

export interface UseSourceControlBindingsInput {
  activeWorkspace: SourceControlBindingsWorkspace | null;
  documentsService: EditorDocumentsServiceStore;
  groupsService: EditorGroupsServiceStore;
  sourceControlStore: SourceControlStore;
  workspaceService: WorkspaceServiceStore;
}

export interface SourceControlBindings {
  branchLine: string | null;
  discardPath(path: string): void;
  openDiffTab(path: string, staged?: boolean): void;
  stagePath(path: string): void;
  viewDiff(path: string): void;
}

export function useSourceControlBindings({
  activeWorkspace,
  documentsService,
  groupsService,
  sourceControlStore,
  workspaceService,
}: UseSourceControlBindingsInput): SourceControlBindings {
  const workspaceState = useStore(sourceControlStore, (state) =>
    activeWorkspace ? state.workspaceById[activeWorkspace.id] : null,
  );
  const branchLine = useMemo(() => formatFileTreeBranchLine(workspaceState), [workspaceState]);

  const stagePath = useCallback((path: string) => {
    if (!activeWorkspace) {
      return;
    }
    const input = { workspaceId: activeWorkspace.id, cwd: activeWorkspace.absolutePath };
    void sourceControlStore.getState().stagePaths(input, [path]).catch((error) => {
      console.error("Source Control: failed to stage context-menu path.", error);
    });
  }, [activeWorkspace, sourceControlStore]);

  const discardPath = useCallback((path: string) => {
    if (!activeWorkspace) {
      return;
    }
    const input = { workspaceId: activeWorkspace.id, cwd: activeWorkspace.absolutePath };
    void sourceControlStore.getState().discardPaths(input, [path]).catch((error) => {
      console.error("Source Control: failed to discard context-menu path.", error);
    });
  }, [activeWorkspace, sourceControlStore]);

  const openDiffTab = useCallback((path: string, staged = false) => {
    void runEditorMutation(() => openSourceControlDiffTab({
      activeWorkspace,
      documentsService,
      groupsService,
      path,
      sourceControlStore,
      staged,
      workspaceService,
    }));
  }, [activeWorkspace, documentsService, groupsService, sourceControlStore, workspaceService]);

  const viewDiff = useCallback((path: string) => {
    if (!activeWorkspace) {
      return;
    }
    const input = { workspaceId: activeWorkspace.id, cwd: activeWorkspace.absolutePath };
    void runEditorMutation(async () => {
      await sourceControlStore.getState().viewDiff(input, path);
      await openSourceControlDiffTab({
        activeWorkspace,
        documentsService,
        groupsService,
        path,
        sourceControlStore,
        staged: false,
        workspaceService,
      });
    }).catch((error) => {
      console.error("Source Control: failed to diff context-menu path.", error);
    });
  }, [activeWorkspace, documentsService, groupsService, sourceControlStore, workspaceService]);

  return useMemo(() => ({
    branchLine,
    discardPath,
    openDiffTab,
    stagePath,
    viewDiff,
  }), [branchLine, discardPath, openDiffTab, stagePath, viewDiff]);
}

export function unifiedDiffToSideContents(diffText: string): { left: string; right: string } {
  const leftLines: string[] = [];
  const rightLines: string[] = [];
  for (const line of diffText.split(/\r?\n/)) {
    if (
      line.startsWith("diff --git") ||
      line.startsWith("index ") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ") ||
      line.startsWith("@@")
    ) {
      continue;
    }

    if (line.startsWith("-")) {
      leftLines.push(line.slice(1));
      continue;
    }

    if (line.startsWith("+")) {
      rightLines.push(line.slice(1));
      continue;
    }

    if (line.startsWith(" ")) {
      const contextLine = line.slice(1);
      leftLines.push(contextLine);
      rightLines.push(contextLine);
    }
  }

  return {
    left: leftLines.join("\n"),
    right: rightLines.join("\n"),
  };
}

async function openSourceControlDiffTab({
  activeWorkspace,
  documentsService,
  groupsService,
  path,
  sourceControlStore,
  staged,
  workspaceService,
}: {
  activeWorkspace: SourceControlBindingsWorkspace | null;
  documentsService: EditorDocumentsServiceStore;
  groupsService: EditorGroupsServiceStore;
  path: string;
  sourceControlStore: SourceControlStore;
  staged: boolean;
  workspaceService: WorkspaceServiceStore;
}): Promise<void> {
  if (!activeWorkspace) {
    return;
  }
  const diffState = sourceControlStore.getState().workspaceById[activeWorkspace.id]?.diff;
  const sideContents = unifiedDiffToSideContents(diffState?.text ?? "");
  await openEditorDiffInServices(
    documentsService,
    groupsService,
    workspaceService,
    {
      workspaceId: activeWorkspace.id,
      path: `HEAD/${path}`,
      title: `HEAD ${basenameForWorkspacePath(path)}`,
      content: sideContents.left,
    },
    {
      workspaceId: activeWorkspace.id,
      path,
      title: staged ? `Index ${basenameForWorkspacePath(path)}` : `Working Tree ${basenameForWorkspacePath(path)}`,
      content: sideContents.right,
    },
    {
      source: "source-control",
      title: `${basenameForWorkspacePath(path)} ↔ ${staged ? "Index" : "Working Tree"}`,
    },
  );
}

function formatFileTreeBranchLine(workspaceState: SourceControlWorkspaceState | null | undefined): string | null {
  const summary = workspaceState?.summary;
  if (!summary?.branch) {
    return null;
  }

  const sync = summary.ahead > 0 || summary.behind > 0 ? ` ↑${summary.ahead} ↓${summary.behind}` : "";
  return `${summary.branch}${sync}`;
}

function basenameForWorkspacePath(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

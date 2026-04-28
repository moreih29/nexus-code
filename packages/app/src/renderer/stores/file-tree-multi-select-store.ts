import { createStore, type StoreApi } from "zustand/vanilla";

import type { WorkspaceFileKind } from "../../../../shared/src/contracts/editor/editor-bridge";
import type { WorkspaceId } from "../../../../shared/src/contracts/workspace/workspace";

export interface FileTreeCompareAnchor {
  workspaceId: WorkspaceId;
  path: string;
  name: string;
  kind: WorkspaceFileKind;
}

export interface FileTreeMultiSelectState {
  selectedPaths: Set<string>;
  lastAnchor: string | null;
  compareAnchor: FileTreeCompareAnchor | null;
  toggleSelect(path: string): void;
  rangeSelect(anchorPath: string | null, targetPath: string, visiblePaths: readonly string[]): void;
  clearSelect(): void;
  selectAll(paths: readonly string[]): void;
  setCompareAnchor(anchor: FileTreeCompareAnchor): void;
  clearCompareAnchor(): void;
}

export type FileTreeMultiSelectStore = StoreApi<FileTreeMultiSelectState>;

export function createFileTreeMultiSelectStore(): FileTreeMultiSelectStore {
  return createStore<FileTreeMultiSelectState>((set) => ({
    selectedPaths: new Set<string>(),
    lastAnchor: null,
    compareAnchor: null,
    toggleSelect(path) {
      set((state) => {
        const selectedPaths = new Set(state.selectedPaths);
        if (selectedPaths.has(path)) {
          selectedPaths.delete(path);
        } else {
          selectedPaths.add(path);
        }
        return {
          selectedPaths,
          lastAnchor: path,
        };
      });
    },
    rangeSelect(anchorPath, targetPath, visiblePaths) {
      const range = fileTreeSelectionRange(anchorPath, targetPath, visiblePaths);
      set({
        selectedPaths: new Set(range),
        lastAnchor: anchorPath ?? targetPath,
      });
    },
    clearSelect() {
      set({
        selectedPaths: new Set<string>(),
        lastAnchor: null,
      });
    },
    selectAll(paths) {
      const selectedPaths = new Set(paths);
      set({
        selectedPaths,
        lastAnchor: paths[0] ?? null,
      });
    },
    setCompareAnchor(anchor) {
      set({ compareAnchor: anchor });
    },
    clearCompareAnchor() {
      set({ compareAnchor: null });
    },
  }));
}

export function fileTreeSelectionRange(
  anchorPath: string | null,
  targetPath: string,
  visiblePaths: readonly string[],
): string[] {
  if (!anchorPath) {
    return [targetPath];
  }

  const anchorIndex = visiblePaths.indexOf(anchorPath);
  const targetIndex = visiblePaths.indexOf(targetPath);
  if (anchorIndex < 0 || targetIndex < 0) {
    return [targetPath];
  }

  const startIndex = Math.min(anchorIndex, targetIndex);
  const endIndex = Math.max(anchorIndex, targetIndex);
  return visiblePaths.slice(startIndex, endIndex + 1);
}

export const fileTreeMultiSelectStore = createFileTreeMultiSelectStore();

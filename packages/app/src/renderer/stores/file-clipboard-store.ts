import { createStore, type StoreApi } from "zustand/vanilla";

import type { WorkspaceFileKind } from "../../../../shared/src/contracts/editor/editor-bridge";
import type { WorkspaceId } from "../../../../shared/src/contracts/workspace/workspace";
import type {
  FileActionsRequest,
  FileActionsResult,
  FileClipboardOperation,
  FilePasteCollision,
  FilePasteConflictStrategy,
  FilePasteRequest,
  FilePasteResult,
} from "../../common/file-actions";
export interface FileClipboardBridge {
  invoke<TRequest extends FileActionsRequest>(request: TRequest): Promise<FileActionsResult>;
}

export interface FileClipboardItem {
  workspaceId: WorkspaceId;
  path: string;
  kind: WorkspaceFileKind;
}

export interface FileClipboardStateValue {
  operation: FileClipboardOperation;
  items: FileClipboardItem[];
}

export interface FileClipboardPendingCollision {
  request: FilePasteRequest;
  collisions: FilePasteCollision[];
}

export interface FileClipboardPasteTarget {
  workspaceId: WorkspaceId;
  targetDirectory: string | null;
}

export interface FileClipboardStoreState {
  clipboard: FileClipboardStateValue | null;
  pendingCollision: FileClipboardPendingCollision | null;
  copy(items: FileClipboardItem[]): void;
  cut(items: FileClipboardItem[]): void;
  clear(): void;
  clearPendingCollision(): void;
  hasClipboardItems(): boolean;
  paste(target: FileClipboardPasteTarget, conflictStrategy?: FilePasteConflictStrategy): Promise<FilePasteResult | null>;
  resolvePendingCollision(strategy: Exclude<FilePasteConflictStrategy, "prompt">): Promise<FilePasteResult | null>;
}

export type FileClipboardStore = StoreApi<FileClipboardStoreState>;

export function createFileClipboardStore(bridge: FileClipboardBridge): FileClipboardStore {
  return createStore<FileClipboardStoreState>((set, get) => ({
    clipboard: null,
    pendingCollision: null,
    copy(items) {
      set({
        clipboard: createClipboardState("copy", items),
        pendingCollision: null,
      });
    },
    cut(items) {
      set({
        clipboard: createClipboardState("cut", items),
        pendingCollision: null,
      });
    },
    clear() {
      set({ clipboard: null, pendingCollision: null });
    },
    clearPendingCollision() {
      set({ pendingCollision: null });
    },
    hasClipboardItems() {
      return (get().clipboard?.items.length ?? 0) > 0;
    },
    async paste(target, conflictStrategy = "prompt") {
      const clipboard = get().clipboard;
      if (!clipboard || clipboard.items.length === 0) {
        return null;
      }

      const request = createPasteRequest(target, clipboard, conflictStrategy);
      return invokePasteRequest(bridge, set, get, request);
    },
    async resolvePendingCollision(strategy) {
      const pendingCollision = get().pendingCollision;
      if (!pendingCollision) {
        return null;
      }

      const request: FilePasteRequest = {
        ...pendingCollision.request,
        conflictStrategy: strategy,
      };
      return invokePasteRequest(bridge, set, get, request);
    },
  }));
}

function createClipboardState(
  operation: FileClipboardOperation,
  items: readonly FileClipboardItem[],
): FileClipboardStateValue | null {
  const normalizedItems = dedupeClipboardItems(items);
  if (normalizedItems.length === 0) {
    return null;
  }

  return {
    operation,
    items: normalizedItems,
  };
}

function dedupeClipboardItems(items: readonly FileClipboardItem[]): FileClipboardItem[] {
  const seen = new Set<string>();
  const nextItems: FileClipboardItem[] = [];
  for (const item of items) {
    const key = `${item.workspaceId}\u0000${item.path}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    nextItems.push(item);
  }
  return nextItems;
}

function createPasteRequest(
  target: FileClipboardPasteTarget,
  clipboard: FileClipboardStateValue,
  conflictStrategy: FilePasteConflictStrategy,
): FilePasteRequest {
  return {
    type: "file-actions/clipboard/paste",
    workspaceId: target.workspaceId,
    targetDirectory: target.targetDirectory,
    operation: clipboard.operation,
    entries: clipboard.items,
    conflictStrategy,
  };
}

async function invokePasteRequest(
  bridge: FileClipboardBridge,
  set: StoreApi<FileClipboardStoreState>["setState"],
  get: StoreApi<FileClipboardStoreState>["getState"],
  request: FilePasteRequest,
): Promise<FilePasteResult> {
  const result = await bridge.invoke(request);
  if (!isFilePasteResult(result)) {
    throw new Error("File clipboard paste returned an unexpected result.");
  }

  if (result.collisions.length > 0) {
    set({
      pendingCollision: {
        request,
        collisions: result.collisions,
      },
    });
    return result;
  }

  set({ pendingCollision: null });
  if (request.operation === "cut" && result.applied.length > 0) {
    get().clear();
  }

  return result;
}

function isFilePasteResult(result: FileActionsResult): result is FilePasteResult {
  return result.type === "file-actions/clipboard/paste/result";
}

import { createLogger } from "../../shared/log/renderer";
import { ipcListen } from "../ipc/client";

const log = createLogger("workspace-cleanup");

export type WorkspaceCleanupFn = (workspaceId: string) => void;

const cleanupFns = new Set<WorkspaceCleanupFn>();
let unlisten: (() => void) | null = null;

export function registerWorkspaceCleanup(fn: WorkspaceCleanupFn): () => void {
  cleanupFns.add(fn);
  return () => {
    cleanupFns.delete(fn);
  };
}

export function initializeWorkspaceLifecycle(): void {
  if (unlisten) return;
  if (typeof window === "undefined") return;
  unlisten = ipcListen("workspace", "removed", ({ id }) => {
    for (const fn of cleanupFns) {
      try {
        fn(id);
      } catch (error) {
        log.error(`handler threw: ${(error as Error).message}`);
      }
    }
  });
}

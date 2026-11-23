import { createLogger } from "../../../../shared/log/renderer";
import { createKeyedDebouncer } from "../../../../shared/util/keyed-debouncer";
import {
  GIT_COMMIT_DRAFT_SAVE_DEBOUNCE_MS,
  GIT_STATUS_HINT_DEBOUNCE_MS,
} from "../../../../shared/util/timing-constants";
import { ipcCallResult, unwrapGitResult } from "../../../ipc/client";
import { useGitStore } from "./index";
import { persistPanelState } from "./panel-state-io";

const log = createLogger("git");

const draftSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pendingDraftSaves = new Map<string, string>();
const statusHints = createKeyedDebouncer<string>({ delayMs: GIT_STATUS_HINT_DEBOUNCE_MS });

export function scheduleCommitDraftSave(workspaceId: string, commitDraft: string): void {
  pendingDraftSaves.set(workspaceId, commitDraft);

  const existing = draftSaveTimers.get(workspaceId);
  if (existing) {
    clearTimeout(existing);
  }

  const handle = setTimeout(() => {
    flushCommitDraftSave(workspaceId);
  }, GIT_COMMIT_DRAFT_SAVE_DEBOUNCE_MS);
  draftSaveTimers.set(workspaceId, handle);
}

export function cancelCommitDraftSave(workspaceId: string): void {
  const existing = draftSaveTimers.get(workspaceId);
  if (existing) {
    clearTimeout(existing);
    draftSaveTimers.delete(workspaceId);
  }
  pendingDraftSaves.delete(workspaceId);
}

export function flushCommitDraftSave(workspaceId: string): void {
  const existing = draftSaveTimers.get(workspaceId);
  if (existing) {
    clearTimeout(existing);
    draftSaveTimers.delete(workspaceId);
  }

  if (!pendingDraftSaves.has(workspaceId)) return;

  const commitDraft = pendingDraftSaves.get(workspaceId) ?? "";
  pendingDraftSaves.delete(workspaceId);
  persistPanelState(workspaceId, { commitDraft });
}

export function flushAllCommitDraftSaves(): void {
  for (const workspaceId of Array.from(pendingDraftSaves.keys())) {
    flushCommitDraftSave(workspaceId);
  }
}

export function scheduleStatusHintRefresh(workspaceId: string): void {
  statusHints.schedule(workspaceId, () => {
    void refreshStatusFromHint(workspaceId);
  });
}

export function cancelStatusHintRefresh(workspaceId: string): void {
  statusHints.cancel(workspaceId);
}

async function refreshStatusFromHint(workspaceId: string): Promise<void> {
  const current = useGitStore.getState().sessions.get(workspaceId);
  if (!current || current.repoInfo.kind !== "repo") return;

  try {
    const status = unwrapGitResult(await ipcCallResult("git", "getStatus", { workspaceId }));
    useGitStore.setState((state) => {
      const session = state.sessions.get(workspaceId);
      if (!session || session.repoInfo.kind !== "repo") return state;

      const next = new Map(state.sessions);
      next.set(workspaceId, {
        ...session,
        status,
        branchInfo: status.branch,
      });
      return { sessions: next };
    });
  } catch (error) {
    log.warn(`passive status refresh failed: ${(error as Error).message}`);
  }
}

export function installCommitDraftFlushListeners(): void {
  if (typeof window === "undefined" || typeof window.addEventListener !== "function") return;

  window.addEventListener("blur", flushAllCommitDraftSaves);

  if (typeof document === "undefined" || typeof document.addEventListener !== "function") return;

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      flushAllCommitDraftSaves();
    }
  });
}

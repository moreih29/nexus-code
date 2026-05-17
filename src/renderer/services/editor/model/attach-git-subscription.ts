/**
 * Subscribes to git.statusChanged events for the entry's workspace and
 * triggers external-change reconciliation after app-initiated git workflow
 * mutations (merge, rebase, cherry-pick, etc.).
 *
 * Why this is needed: the fs.changed path (attach-fs-subscription.ts) only
 * fires when the file's parent directory is watched by the file-tree watcher.
 * A merge can rewrite files whose parent directories are collapsed in the tree,
 * so fs.changed never arrives for those files and the open editor model keeps
 * the pre-merge content. git.statusChanged, by contrast, is always broadcast
 * by the main process after every workflow mutation, making it a reliable
 * secondary trigger for reconciliation.
 *
 * The reconcileExternalChange callback is safe to call unconditionally:
 * - It is a no-op when the on-disk content matches the buffer.
 * - It respects dirty buffers (sets diskDiverged instead of overwriting).
 */

import type { TimerScheduler } from "../../../../shared/util/timer-scheduler";
import { defaultTimerScheduler } from "../../../../shared/util/timer-scheduler";

/** Debounce window in milliseconds. Coalesces a burst of git.statusChanged
 *  events (e.g. rapid successive operations) into a single reconcile call. */
const GIT_RECONCILE_DEBOUNCE_MS = 120;

export interface AttachGitSubscriptionDeps {
  subscribeGitStatusChanged: (
    input: { workspaceId: string; filePath: string },
    onChanged: () => void,
  ) => () => void;
  scheduler?: TimerScheduler;
}

export const defaultAttachGitSubscriptionDeps: Pick<
  AttachGitSubscriptionDeps,
  "scheduler"
> = {
  scheduler: defaultTimerScheduler,
};

export function attachGitSubscription(
  entry: { input: { workspaceId: string; filePath: string } },
  deps: AttachGitSubscriptionDeps,
  onChanged: () => void,
): () => void {
  const scheduler = deps.scheduler ?? defaultTimerScheduler;
  let timer: unknown = null;

  const scheduled = (): void => {
    if (timer !== null) scheduler.clearTimeout(timer);
    timer = scheduler.setTimeout(() => {
      timer = null;
      onChanged();
    }, GIT_RECONCILE_DEBOUNCE_MS);
  };

  const unsubscribe = deps.subscribeGitStatusChanged(entry.input, scheduled);

  return () => {
    if (timer !== null) {
      scheduler.clearTimeout(timer);
      timer = null;
    }
    unsubscribe();
  };
}

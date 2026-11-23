import type { TimerScheduler } from "../../../../shared/util/timer-scheduler";
import { defaultTimerScheduler } from "../../../../shared/util/timer-scheduler";

const GIT_RECONCILE_DEBOUNCE_MS = 120;

export interface AttachGitSubscriptionDeps {
  subscribeGitStatusChanged: (
    input: { workspaceId: string; filePath: string },
    onChanged: () => void,
  ) => () => void;
  scheduler?: TimerScheduler;
}

export const defaultAttachGitSubscriptionDeps: Pick<AttachGitSubscriptionDeps, "scheduler"> = {
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

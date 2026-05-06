import { subscribeOnRelease } from "../../../services/editor/model-cache";
import { bindOutlineToModelRelease } from "../../../state/stores/outline";

let unsubscribe: (() => void) | null = null;

export function ensureOutlineModelReleaseSubscription(): void {
  if (unsubscribe) return;
  unsubscribe = bindOutlineToModelRelease(subscribeOnRelease);
}

export function resetOutlineModelReleaseSubscriptionForTests(): void {
  unsubscribe?.();
  unsubscribe = null;
}

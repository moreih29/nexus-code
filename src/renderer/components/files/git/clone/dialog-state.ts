/**
 * Singleton open-state for the workspace-agnostic Clone dialog. Commands,
 * menus, and welcome-screen affordances all route through this tiny bus so the
 * dialog root can stay mounted once in GlobalRoots.
 */
import { createListenerBus } from "../../../../../shared/util/listener-bus";

let open = false;
const bus = createListenerBus();

/** Opens the Clone Repository dialog. */
export function openCloneDialog(): void {
  if (open) return;
  open = true;
  bus.notify();
}

/** Closes the Clone Repository dialog. */
export function closeCloneDialog(): void {
  if (!open) return;
  open = false;
  bus.notify();
}

/** Returns the current Clone dialog open-state snapshot. */
export function isCloneDialogOpen(): boolean {
  return open;
}

/** Subscribes to Clone dialog open-state changes. */
export function subscribeCloneDialog(listener: () => void): () => void {
  return bus.subscribe(listener);
}

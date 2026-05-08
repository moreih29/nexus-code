// Central registry for "what to do when a workspace is removed".
//
// Replaces the per-store pattern of each module calling
// `ipcListen("workspace", "removed", ...)` on its own. Modules now register
// a cleanup function; `initializeWorkspaceLifecycle()` (called once from
// bootstrap) installs a single IPC listener that fans out to every
// registered function.
//
// Why a registry: with N stores subscribing independently, adding
// workspace-keyed state to a new store requires remembering to wire the
// IPC listener too. Three real leaks (files/store, server-ux-router, ui)
// demonstrated this is easy to forget. Registration is now the *one*
// step a new store cannot skip without losing functionality, and the
// central handler logs broken handlers rather than letting one failure
// silently swallow the rest.

import { ipcListen } from "../../ipc/client";

export type WorkspaceCleanupFn = (workspaceId: string) => void;

const cleanupFns = new Set<WorkspaceCleanupFn>();
let unlisten: (() => void) | null = null;

/**
 * Register a function called when any workspace is removed. Returns an
 * unsubscribe function. Registering the same `fn` twice is a no-op (Set).
 *
 * Safe to call before `initializeWorkspaceLifecycle()` — registrations
 * sit in memory until the central listener is installed.
 */
export function registerWorkspaceCleanup(fn: WorkspaceCleanupFn): () => void {
  cleanupFns.add(fn);
  return () => {
    cleanupFns.delete(fn);
  };
}

/**
 * Install the single `workspace:removed` IPC listener that fans out to
 * all registered cleanup functions. Idempotent — a second call is a no-op.
 *
 * The `typeof window` guard keeps this safe to call from bun:test, where
 * `window.ipc` isn't installed.
 */
export function initializeWorkspaceLifecycle(): void {
  if (unlisten) return;
  if (typeof window === "undefined") return;
  unlisten = ipcListen("workspace", "removed", ({ id }) => {
    for (const fn of cleanupFns) {
      try {
        fn(id);
      } catch (error) {
        // One handler's failure must not block the others.
        console.error("[workspace-cleanup] handler threw:", error);
      }
    }
  });
}

/**
 * Tear down the listener and clear all registrations. Intended for tests
 * that need a clean slate; production code does not call this.
 */
export function disposeWorkspaceLifecycle(): void {
  unlisten?.();
  unlisten = null;
  cleanupFns.clear();
}

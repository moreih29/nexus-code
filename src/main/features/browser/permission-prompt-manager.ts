/**
 * BrowserPermissionPromptManager — coalesces permission request callbacks,
 * broadcasts prompts to the renderer, and resolves/cancels them when the user
 * responds.
 *
 * DESIGN: Zero direct Electron dependencies.  All external I/O (broadcast,
 * setRemembered) is injected at construction time so the manager can be unit-
 * tested without any Electron mock.
 *
 * COALESCING: Simultaneous requests for the same (workspaceId, origin,
 * permission) triple are coalesced into a single prompt broadcast.  Each
 * subsequent request only adds a waiter to the existing pending entry without
 * firing another broadcast.
 *
 * LIFECYCLE: Callers must invoke disposeByWebContents() when a WebContents is
 * destroyed to deny any callbacks it is waiting on and prevent stale-closure
 * leaks.
 */

type BroadcastFn = (channelName: string, event: string, args: unknown) => void;
type SetRememberedFn = (
  workspaceId: string,
  origin: string,
  permission: string,
  decision: "allow" | "block",
) => void;
type GenerateIdFn = () => string;

export interface PermissionPromptManagerDeps {
  readonly broadcast: BroadcastFn;
  readonly setRemembered: SetRememberedFn;
  readonly generateId?: GenerateIdFn;
}

interface Waiter {
  readonly callback: (allow: boolean) => void;
  readonly webContentsId: number;
}

interface PendingEntry {
  readonly promptId: string;
  readonly workspaceId: string;
  readonly origin: string;
  readonly permission: string;
  readonly waiters: Waiter[];
}

/**
 * Handles permission request callbacks from Electron's
 * `setPermissionRequestHandler`, coalescing identical requests and routing
 * renderer decisions back to waiting callbacks.
 */
export class BrowserPermissionPromptManager {
  private readonly broadcast: BroadcastFn;
  private readonly setRemembered: SetRememberedFn;
  private readonly generateId: GenerateIdFn;

  /**
   * pending map — key is `${workspaceId}::${origin}::${permission}`,
   * value is the live PendingEntry (shared across all coalesced waiters).
   */
  private readonly pendingByKey = new Map<string, PendingEntry>();
  /**
   * Reverse-index: promptId → coalesce key, for O(1) respond/cancel look-up.
   */
  private readonly keyByPromptId = new Map<string, string>();

  constructor(deps: PermissionPromptManagerDeps) {
    this.broadcast = deps.broadcast;
    this.setRemembered = deps.setRemembered;
    this.generateId = deps.generateId ?? (() => crypto.randomUUID());
  }

  /**
   * Called by the security adapter for every Electron permission request after
   * the decision has been evaluated.
   *
   * - decision === 'allow'  → callback(true) immediately, no prompt.
   * - decision === 'block'  → callback(false) immediately, no prompt.
   * - decision === 'ask'    → coalesce into a pending group; broadcast prompt
   *                           (only once per unique key).
   */
  handlePermissionRequest(
    input: {
      workspaceId: string;
      origin: string;
      permission: string;
      webContentsId: number;
      decision: "allow" | "block" | "ask";
    },
    callback: (allow: boolean) => void,
  ): void {
    const { workspaceId, origin, permission, webContentsId, decision } = input;

    if (decision === "allow") {
      callback(true);
      return;
    }
    if (decision === "block") {
      callback(false);
      return;
    }

    // decision === 'ask' → coalesce
    const key = `${workspaceId}::${origin}::${permission}`;
    const existing = this.pendingByKey.get(key);

    if (existing) {
      // Coalesce: just append another waiter, no new broadcast.
      existing.waiters.push({ callback, webContentsId });
      return;
    }

    // First request for this key — create a new pending entry.
    const promptId = this.generateId();
    const entry: PendingEntry = {
      promptId,
      workspaceId,
      origin,
      permission,
      waiters: [{ callback, webContentsId }],
    };
    this.pendingByKey.set(key, entry);
    this.keyByPromptId.set(promptId, key);

    this.broadcast("browserPermission", "prompt", {
      promptId,
      workspaceId,
      origin,
      permissions: [permission],
    });
  }

  /**
   * Called when the renderer sends a `browserPermission.respond` IPC call.
   *
   * Resolves all coalesced waiters with the user's decision, and if `remember`
   * is true persists the decision via the injected `setRemembered` callback.
   *
   * No-op when `promptId` is unknown (already resolved or cancelled).
   */
  respond(promptId: string, decision: "allow" | "block", remember: boolean): void {
    const key = this.keyByPromptId.get(promptId);
    if (key === undefined) return;

    const entry = this.pendingByKey.get(key);
    if (!entry) return;

    this.pendingByKey.delete(key);
    this.keyByPromptId.delete(promptId);

    if (remember) {
      this.setRemembered(entry.workspaceId, entry.origin, entry.permission, decision);
    }

    const allow = decision === "allow";
    for (const waiter of entry.waiters) {
      waiter.callback(allow);
    }
  }

  /**
   * Called when the renderer sends a `browserPermission.cancel` IPC call.
   *
   * Denies all waiters as a one-time block without persisting any remembered
   * rule.  No-op when `promptId` is unknown.
   */
  cancel(promptId: string): void {
    const key = this.keyByPromptId.get(promptId);
    if (key === undefined) return;

    const entry = this.pendingByKey.get(key);
    if (!entry) return;

    this.pendingByKey.delete(key);
    this.keyByPromptId.delete(promptId);

    for (const waiter of entry.waiters) {
      waiter.callback(false);
    }
  }

  /**
   * Removes all waiters belonging to `webContentsId` from every pending entry,
   * denying their callbacks immediately.  Pending entries that become empty
   * after the purge are also removed.
   *
   * Must be called when a WebContents is destroyed to prevent callback
   * leaks and stale-closure bugs.
   */
  disposeByWebContents(webContentsId: number): void {
    for (const [key, entry] of this.pendingByKey) {
      const keep: Waiter[] = [];
      const deny: Waiter[] = [];
      for (const waiter of entry.waiters) {
        if (waiter.webContentsId === webContentsId) {
          deny.push(waiter);
        } else {
          keep.push(waiter);
        }
      }

      for (const waiter of deny) {
        waiter.callback(false);
      }

      if (keep.length === 0) {
        this.pendingByKey.delete(key);
        this.keyByPromptId.delete(entry.promptId);
      } else {
        // Mutate the waiters array in place — entry.waiters is the live array.
        entry.waiters.splice(0, entry.waiters.length, ...keep);
      }
    }
  }
}

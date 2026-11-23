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

export class BrowserPermissionPromptManager {
  private readonly broadcast: BroadcastFn;
  private readonly setRemembered: SetRememberedFn;
  private readonly generateId: GenerateIdFn;

  private readonly pendingByKey = new Map<string, PendingEntry>();
  private readonly keyByPromptId = new Map<string, string>();

  constructor(deps: PermissionPromptManagerDeps) {
    this.broadcast = deps.broadcast;
    this.setRemembered = deps.setRemembered;
    this.generateId = deps.generateId ?? (() => crypto.randomUUID());
  }

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

    const key = `${workspaceId}::${origin}::${permission}`;
    const existing = this.pendingByKey.get(key);

    if (existing) {
      existing.waiters.push({ callback, webContentsId });
      return;
    }

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

      if (deny.length === 0) continue;

      if (keep.length === 0) {
        this.pendingByKey.delete(key);
        this.keyByPromptId.delete(entry.promptId);
        this.broadcast("browserPermission", "dismissed", { promptId: entry.promptId });
      } else {
        entry.waiters.splice(0, entry.waiters.length, ...keep);
      }
    }
  }
}

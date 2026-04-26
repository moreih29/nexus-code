import type { HarnessObserverEvent } from "../../../shared/src/contracts/harness-observer";

export interface HarnessNotificationPayload {
  title: string;
  body: string;
}

export interface HarnessNotificationLike {
  show(): void;
}

export interface HarnessNotificationServiceOptions {
  isSupported?: () => boolean;
  createNotification?: (payload: HarnessNotificationPayload) => HarnessNotificationLike;
}

export class HarnessNotificationService {
  private readonly isSupported: () => boolean;
  private readonly createNotification: (
    payload: HarnessNotificationPayload,
  ) => HarnessNotificationLike;
  private readonly emittedKeys = new Set<string>();

  public constructor(options: HarnessNotificationServiceOptions = {}) {
    this.isSupported = options.isSupported ?? (() => false);
    this.createNotification =
      options.createNotification ??
      (() => ({
        show: () => undefined,
      }));
  }

  public handleObserverEvent(event: HarnessObserverEvent): void {
    const payload = notificationPayloadForEvent(event);
    if (!payload || !this.isSupported()) {
      return;
    }

    const key = notificationDedupeKey(event);
    if (this.emittedKeys.has(key)) {
      return;
    }
    this.emittedKeys.add(key);

    this.createNotification(payload).show();
  }
}

export function notificationPayloadForEvent(
  event: HarnessObserverEvent,
): HarnessNotificationPayload | null {
  const displayName = adapterDisplayName(event.adapterName);
  if (!displayName) {
    return null;
  }

  if (event.type === "harness/tool-call") {
    if (event.status === "awaiting-approval") {
      return {
        title: `${displayName} approval needed`,
        body: `${event.toolName} is waiting for approval.`,
      };
    }
    if (event.status === "error") {
      return {
        title: `${displayName} observer error`,
        body: `${event.toolName} failed or reported an error.`,
      };
    }
    return null;
  }

  if (event.type === "harness/tab-badge") {
    if (event.state === "completed") {
      return {
        title: `${displayName} turn completed`,
        body: `${displayName} finished the current turn.`,
      };
    }
    if (event.state === "error") {
      return {
        title: `${displayName} observer error`,
        body: `${displayName} reported an error.`,
      };
    }
  }

  return null;
}

function notificationDedupeKey(event: HarnessObserverEvent): string {
  const status = event.type === "harness/tool-call" ? event.status : event.state;
  return [
    event.type,
    event.workspaceId,
    event.sessionId,
    status,
    event.timestamp,
  ].join(":");
}

function adapterDisplayName(adapterName: string): string | null {
  switch (adapterName) {
    case "claude-code":
      return "Claude Code";
    case "opencode":
      return "OpenCode";
    case "codex":
      return "Codex";
    default:
      return null;
  }
}

/**
 * The session of another computer the agent view shows over its panels,
 * opened from its list's Other computers; none when it shows its own.
 * Not kept: the other computer may be gone when the app starts again.
 */

import { create } from "zustand";

/** A session of another computer, with the names to tell it by. */
export interface RemoteTarget {
  deviceId: string;
  deviceName: string;
  workspaceId: string;
  workspaceName: string;
  /** The workspace's folder on that computer. */
  path: string;
  tabId: string;
  kind: "claude" | "codex" | "terminal";
  title: string;
}

interface RemoteViewState {
  shown: RemoteTarget | null;
  show(target: RemoteTarget): void;
  close(): void;
}

export const useRemoteViewStore = create<RemoteViewState>((set) => ({
  shown: null,
  show: (target) => set({ shown: target }),
  close: () => set({ shown: null }),
}));

export function sameTarget(
  a: RemoteTarget | null,
  b: { deviceId: string; tabId: string; workspaceId: string },
): boolean {
  return (
    a !== null &&
    a.deviceId === b.deviceId &&
    a.workspaceId === b.workspaceId &&
    a.tabId === b.tabId
  );
}

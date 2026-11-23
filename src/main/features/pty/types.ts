type EventCallback = (args: unknown) => void;

export interface PtyHostHandle {
  call: (method: string, args: unknown) => Promise<unknown>;
  on: (event: string, cb: EventCallback) => () => void;
  isAlive: () => boolean;
  dispose: () => void;
  hasWorkspaceSessions?: (workspaceId: string) => boolean;
  closeWorkspaceSessions: (workspaceId: string) => void;
  restoreAfterReauth: (workspaceId: string) => Promise<void>;
  releaseHeld: (workspaceId: string) => void;
}

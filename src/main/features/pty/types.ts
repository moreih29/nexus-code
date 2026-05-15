// Shared PTY host interface used by agent-host and the IPC bridge.

type EventCallback = (args: unknown) => void;

/**
 * Minimal handle exposed by any PTY host implementation. Callers use `call` to
 * send RPCs and `on` to subscribe to push events (`data`, `exit`).
 */
export interface PtyHostHandle {
  call: (method: string, args: unknown) => Promise<unknown>;
  on: (event: string, cb: EventCallback) => () => void;
  isAlive: () => boolean;
  dispose: () => void;
}

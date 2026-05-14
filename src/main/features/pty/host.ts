// PTY host launcher — main process side.
// Forks out/main/pty-host.js as an Electron utilityProcess and establishes
// a bidirectional MessagePort channel for PTY traffic.

import { createUtilityHost } from "../../infra/hosts/utility-host";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type EventCallback = (args: unknown) => void;

export interface PtyHostHandle {
  call: (method: string, args: unknown) => Promise<unknown>;
  on: (event: string, cb: EventCallback) => () => void;
  isAlive: () => boolean;
  dispose: () => void;
}

// Internal message shape — utility → main (over MessagePort)
interface PtyMessage {
  type: string;
  tabId?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// startPtyHost
// ---------------------------------------------------------------------------

export function startPtyHost(): PtyHostHandle {
  const pendingSpawn = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();

  const host = createUtilityHost<PtyMessage>({
    serviceName: "pty-host",
    entryRelative: "pty-host.js",
    logPrefix: "pty-host",
    onMessage(msg, ctx) {
      switch (msg.type) {
        case "spawned": {
          const pending = pendingSpawn.get(msg.tabId as string);
          if (pending) {
            pendingSpawn.delete(msg.tabId as string);
            pending.resolve({ pid: msg.pid as number });
          }
          break;
        }
        case "data":
          ctx.emit("data", { tabId: msg.tabId, chunk: msg.chunk as string });
          break;
        case "exit":
          ctx.emit("exit", { tabId: msg.tabId, code: msg.code as number | null });
          {
            const pending = pendingSpawn.get(msg.tabId as string);
            if (pending) {
              pendingSpawn.delete(msg.tabId as string);
              pending.reject(new Error("PTY exited during spawn"));
            }
          }
          break;
      }
    },
    onRestart() {
      for (const [, pending] of pendingSpawn) {
        pending.reject(new Error("PTY host restarted"));
      }
      pendingSpawn.clear();
    },
  });

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  function call(method: string, args: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const a = args as Record<string, unknown>;
      if (method === "spawn") {
        const tabId = a.tabId as string;
        pendingSpawn.set(tabId, { resolve, reject });
        host.post({ type: "spawn", ...a });
      } else if (method === "write") {
        host.post({ type: "write", ...a });
        resolve(undefined);
      } else if (method === "resize") {
        host.post({ type: "resize", ...a });
        resolve(undefined);
      } else if (method === "ack") {
        host.post({ type: "ack", ...a });
        resolve(undefined);
      } else if (method === "kill") {
        host.post({ type: "kill", ...a });
        resolve(undefined);
      } else {
        reject(new Error(`ptyHost.call: unknown method: ${method}`));
      }
    });
  }

  return {
    call,
    on: host.on,
    isAlive: host.isAlive,
    dispose: host.dispose,
  };
}

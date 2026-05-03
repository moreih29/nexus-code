// PTY host launcher — main process side.
// Forks out/main/pty-host.js as an Electron utilityProcess and establishes
// a bidirectional MessagePort channel for PTY traffic.
//
// Electron is required lazily (via require) so the module is testable without
// a running Electron context — the same pattern used in ipc/router.ts.

import path from "node:path";

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

// Minimal structural types so we don't need electron types at compile time
interface IPort {
  on: (event: "message", handler: (e: { data: unknown }) => void) => void;
  start: () => void;
  close: () => void;
  postMessage: (data: unknown, transfer?: unknown[]) => void;
}

interface IProc {
  stdout?: { on: (event: string, handler: (chunk: Buffer) => void) => void } | null;
  stderr?: { on: (event: string, handler: (chunk: Buffer) => void) => void } | null;
  once: (event: "exit", handler: (code: number | null) => void) => void;
  postMessage: (data: unknown, transfer?: unknown[]) => void;
  kill: () => void;
}

interface IChannel {
  port1: IPort;
  port2: IPort;
}

// ---------------------------------------------------------------------------
// startPtyHost
// ---------------------------------------------------------------------------

export function startPtyHost(): PtyHostHandle {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const electron = require("electron") as {
    app: { getAppPath: () => string };
    utilityProcess: { fork: (entry: string, args: string[], opts: object) => IProc };
    MessageChannelMain: new () => IChannel;
  };

  let disposed = false;

  // Event subscribers keyed by event type string
  const subscribers = new Map<string, Set<EventCallback>>();

  function emit(event: string, args: unknown): void {
    const set = subscribers.get(event);
    if (set) {
      for (const cb of set) {
        cb(args);
      }
    }
  }

  // Pending call resolvers for spawn (one per tabId)
  const pendingSpawn = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();

  const entryPoint = path.join(electron.app.getAppPath(), "out", "main", "pty-host.js");

  let proc = electron.utilityProcess.fork(entryPoint, [], {
    serviceName: "pty-host",
    stdio: "pipe",
  });

  pipeStdio(proc);

  let mainPort: IPort;
  const ch = new electron.MessageChannelMain();
  wirePort(ch.port1, ch.port2);

  proc.once("exit", onProcExit);

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  function pipeStdio(p: IProc): void {
    p.stdout?.on("data", (chunk: Buffer) => {
      process.stdout.write(`[pty-host] ${chunk}`);
    });
    p.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(`[pty-host] ${chunk}`);
    });
  }

  function wirePort(p1: IPort, p2: IPort): void {
    mainPort = p1;

    mainPort.on("message", (event) => {
      const msg = event.data as PtyMessage;
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
          emit("data", { tabId: msg.tabId, chunk: msg.chunk as string });
          break;
        case "exit":
          emit("exit", { tabId: msg.tabId, code: msg.code as number | null });
          {
            const pending = pendingSpawn.get(msg.tabId as string);
            if (pending) {
              pendingSpawn.delete(msg.tabId as string);
              pending.reject(new Error("PTY exited during spawn"));
            }
          }
          break;
      }
    });

    mainPort.start();
    proc.postMessage({ type: "port" }, [p2]);
  }

  function onProcExit(_code: number | null): void {
    if (disposed) return;
    console.warn("[pty-host] utility process exited — restarting");

    for (const [, pending] of pendingSpawn) {
      pending.reject(new Error("PTY host restarted"));
    }
    pendingSpawn.clear();

    try {
      mainPort.close();
    } catch {
      /* ignore */
    }

    proc = electron.utilityProcess.fork(entryPoint, [], {
      serviceName: "pty-host",
      stdio: "pipe",
    });
    pipeStdio(proc);

    const newCh = new electron.MessageChannelMain();
    wirePort(newCh.port1, newCh.port2);

    proc.once("exit", onProcExit);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  function call(method: string, args: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const a = args as Record<string, unknown>;
      if (method === "spawn") {
        const tabId = a.tabId as string;
        pendingSpawn.set(tabId, { resolve, reject });
        mainPort.postMessage({ type: "spawn", ...a });
      } else if (method === "write") {
        mainPort.postMessage({ type: "write", ...a });
        resolve(undefined);
      } else if (method === "resize") {
        mainPort.postMessage({ type: "resize", ...a });
        resolve(undefined);
      } else if (method === "ack") {
        mainPort.postMessage({ type: "ack", ...a });
        resolve(undefined);
      } else if (method === "kill") {
        mainPort.postMessage({ type: "kill", ...a });
        resolve(undefined);
      } else {
        reject(new Error(`ptyHost.call: unknown method: ${method}`));
      }
    });
  }

  function on(event: string, cb: EventCallback): () => void {
    let set = subscribers.get(event);
    if (!set) {
      set = new Set();
      subscribers.set(event, set);
    }
    set.add(cb);
    return () => {
      subscribers.get(event)?.delete(cb);
    };
  }

  function isAlive(): boolean {
    return !disposed;
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    try {
      mainPort.close();
    } catch {
      /* ignore */
    }
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
  }

  return { call, on, isAlive, dispose };
}

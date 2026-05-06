// LSP host launcher — main process side.
// Forks out/main/lsp-host.js as an Electron utilityProcess and establishes
// a bidirectional MessagePort channel for LSP traffic.
//
// Mirrors the PtyHostHandle pattern from hosts/ptyHost.ts exactly.

import path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type EventCallback = (args: unknown) => void;

export interface LspHostCallOptions {
  signal?: AbortSignal;
}

export interface LspHostHandle {
  call: (method: string, args: unknown, opts?: LspHostCallOptions) => Promise<unknown>;
  notify: (method: string, args: unknown) => void;
  respondServerRequest: (id: string | number, result: unknown) => void;
  rejectServerRequest: (id: string | number, message: string) => void;
  on: (event: string, cb: EventCallback) => () => void;
  isAlive: () => boolean;
  dispose: () => void;
}

// Internal message shape — utility → main (over MessagePort)
interface LspMessage {
  type: string;
  id?: string | number;
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
// startLspHost
// ---------------------------------------------------------------------------

export function startLspHost(): LspHostHandle {
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

  // Pending call resolvers keyed by request id
  let nextId = 1;
  const pendingCalls = new Map<
    string | number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; cleanup: () => void }
  >();

  const entryPoint = path.join(electron.app.getAppPath(), "out", "main", "lsp-host.js");

  let proc = electron.utilityProcess.fork(entryPoint, [], {
    serviceName: "lsp-host",
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
      process.stdout.write(`[lsp-host] ${chunk}`);
    });
    p.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(`[lsp-host] ${chunk}`);
    });
  }

  function wirePort(p1: IPort, p2: IPort): void {
    mainPort = p1;

    mainPort.on("message", (event) => {
      const msg = event.data as LspMessage;
      switch (msg.type) {
        case "response": {
          const id = msg.id as string | number;
          const pending = pendingCalls.get(id);
          if (pending) {
            pendingCalls.delete(id);
            pending.cleanup();
            if (msg.error) {
              pending.reject(new Error(msg.error as string));
            } else {
              pending.resolve(msg.result);
            }
          }
          break;
        }
        case "diagnostics":
          emit("diagnostics", { uri: msg.uri, diagnostics: msg.diagnostics });
          break;
        case "serverRequest":
          emit("serverRequest", {
            id: msg.id,
            method: msg.method,
            params: msg.params,
          });
          break;
        case "serverEvent":
          emit("serverEvent", {
            workspaceId: msg.workspaceId,
            languageId: msg.languageId,
            method: msg.method,
            params: msg.params,
          });
          break;
      }
    });

    mainPort.start();
    proc.postMessage({ type: "port" }, [p2]);
  }

  function onProcExit(_code: number | null): void {
    if (disposed) return;
    console.warn("[lsp-host] utility process exited — restarting");

    for (const [, pending] of pendingCalls) {
      pending.cleanup();
      pending.reject(new Error("LSP host restarted"));
    }
    pendingCalls.clear();

    try {
      mainPort.close();
    } catch {
      /* ignore */
    }

    proc = electron.utilityProcess.fork(entryPoint, [], {
      serviceName: "lsp-host",
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

  function call(method: string, args: unknown, opts: LspHostCallOptions = {}): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const signal = opts.signal;
      const onAbort = () => {
        if (pendingCalls.has(id)) {
          mainPort.postMessage({ type: "cancel", id });
        }
      };
      const cleanup = () => {
        signal?.removeEventListener("abort", onAbort);
      };

      if (signal && !signal.aborted) {
        signal.addEventListener("abort", onAbort, { once: true });
      }

      pendingCalls.set(id, { resolve, reject, cleanup });
      mainPort.postMessage({ type: "call", id, method, args });
      if (signal?.aborted) {
        onAbort();
      }
    });
  }

  function notify(method: string, args: unknown): void {
    if (disposed) return;
    mainPort.postMessage({ type: "notify", method, args });
  }

  function respondServerRequest(id: string | number, result: unknown): void {
    if (disposed) return;
    mainPort.postMessage({ type: "serverResponse", id, result });
  }

  function rejectServerRequest(id: string | number, message: string): void {
    if (disposed) return;
    mainPort.postMessage({ type: "serverResponse", id, error: message });
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

  return { call, notify, respondServerRequest, rejectServerRequest, on, isAlive, dispose };
}

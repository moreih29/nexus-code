// Shared utility-process host factory.
// Handles forking, stdio piping, MessagePort wiring, restart loop, and event
// pub/sub. Domain-specific message dispatch is injected via onMessage callback.

import path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type EventCallback = (args: unknown) => void;

export interface UtilityHostContext {
  post: (data: unknown) => void;
  emit: (event: string, args: unknown) => void;
  isDisposed: () => boolean;
}

export interface UtilityHostOptions<TInbound> {
  serviceName: string;
  entryRelative: string;
  logPrefix: string;
  onMessage: (msg: TInbound, ctx: UtilityHostContext) => void;
  onRestart?: (ctx: UtilityHostContext) => void;
}

export interface UtilityHostHandle {
  post: (data: unknown) => void;
  on: (event: string, cb: EventCallback) => () => void;
  isAlive: () => boolean;
  dispose: () => void;
}

// Minimal structural types — avoid importing electron types at compile time
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
// createUtilityHost
// ---------------------------------------------------------------------------

export function createUtilityHost<TInbound>(
  opts: UtilityHostOptions<TInbound>,
): UtilityHostHandle {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const electron = require("electron") as {
    app: { getAppPath: () => string };
    utilityProcess: { fork: (entry: string, args: string[], opts: object) => IProc };
    MessageChannelMain: new () => IChannel;
  };

  let disposed = false;

  const subscribers = new Map<string, Set<EventCallback>>();

  function emit(event: string, args: unknown): void {
    const set = subscribers.get(event);
    if (set) {
      for (const cb of set) {
        cb(args);
      }
    }
  }

  const ctx: UtilityHostContext = {
    post: (data) => mainPort.postMessage(data),
    emit,
    isDisposed: () => disposed,
  };

  const entryPoint = path.join(
    electron.app.getAppPath(),
    "out",
    "main",
    opts.entryRelative,
  );

  let proc = electron.utilityProcess.fork(entryPoint, [], {
    serviceName: opts.serviceName,
    stdio: "pipe",
  });

  pipeStdio(proc);

  // mainPort is assigned in wirePort — always valid after first wirePort call
  let mainPort: IPort;
  const ch = new electron.MessageChannelMain();
  wirePort(ch.port1, ch.port2);

  proc.once("exit", onProcExit);

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  function pipeStdio(p: IProc): void {
    p.stdout?.on("data", (chunk: Buffer) => {
      process.stdout.write(`[${opts.logPrefix}] ${chunk}`);
    });
    p.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(`[${opts.logPrefix}] ${chunk}`);
    });
  }

  function wirePort(p1: IPort, p2: IPort): void {
    mainPort = p1;

    mainPort.on("message", (event) => {
      opts.onMessage(event.data as TInbound, ctx);
    });

    mainPort.start();
    proc.postMessage({ type: "port" }, [p2]);
  }

  function onProcExit(_code: number | null): void {
    if (disposed) return;
    console.warn(`[${opts.logPrefix}] utility process exited — restarting`);

    opts.onRestart?.(ctx);

    try {
      mainPort.close();
    } catch {
      /* ignore */
    }

    proc = electron.utilityProcess.fork(entryPoint, [], {
      serviceName: opts.serviceName,
      stdio: "pipe",
    });
    pipeStdio(proc);

    const newCh = new electron.MessageChannelMain();
    wirePort(newCh.port1, newCh.port2);

    proc.once("exit", onProcExit);
  }

  // -------------------------------------------------------------------------
  // Public handle
  // -------------------------------------------------------------------------

  function post(data: unknown): void {
    mainPort.postMessage(data);
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

  return { post, on, isAlive, dispose };
}

// LSP host launcher — main process side.
// Forks out/main/lsp-host.js as an Electron utilityProcess and establishes
// a bidirectional MessagePort channel for LSP traffic.

import { createUtilityHost } from "../../infra/hosts/utility-host";

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

// ---------------------------------------------------------------------------
// startLspHost
// ---------------------------------------------------------------------------

export function startLspHost(): LspHostHandle {
  let nextId = 1;
  const pendingCalls = new Map<
    string | number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; cleanup: () => void }
  >();

  const host = createUtilityHost<LspMessage>({
    serviceName: "lsp-host",
    entryRelative: "lsp-host.js",
    logPrefix: "lsp-host",
    onMessage(msg, ctx) {
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
          ctx.emit("diagnostics", { uri: msg.uri, diagnostics: msg.diagnostics });
          break;
        case "serverRequest":
          ctx.emit("serverRequest", {
            id: msg.id,
            method: msg.method,
            params: msg.params,
          });
          break;
        case "serverEvent":
          ctx.emit("serverEvent", {
            workspaceId: msg.workspaceId,
            languageId: msg.languageId,
            method: msg.method,
            params: msg.params,
          });
          break;
      }
    },
    onRestart() {
      for (const [, pending] of pendingCalls) {
        pending.cleanup();
        pending.reject(new Error("LSP host restarted"));
      }
      pendingCalls.clear();
    },
  });

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  function call(method: string, args: unknown, opts: LspHostCallOptions = {}): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const signal = opts.signal;
      const onAbort = () => {
        if (pendingCalls.has(id)) {
          host.post({ type: "cancel", id });
        }
      };
      const cleanup = () => {
        signal?.removeEventListener("abort", onAbort);
      };

      if (signal && !signal.aborted) {
        signal.addEventListener("abort", onAbort, { once: true });
      }

      pendingCalls.set(id, { resolve, reject, cleanup });
      host.post({ type: "call", id, method, args });
      if (signal?.aborted) {
        onAbort();
      }
    });
  }

  function notify(method: string, args: unknown): void {
    if (host.isAlive()) {
      host.post({ type: "notify", method, args });
    }
  }

  function respondServerRequest(id: string | number, result: unknown): void {
    if (host.isAlive()) {
      host.post({ type: "serverResponse", id, result });
    }
  }

  function rejectServerRequest(id: string | number, message: string): void {
    if (host.isAlive()) {
      host.post({ type: "serverResponse", id, error: message });
    }
  }

  return {
    call,
    notify,
    respondServerRequest,
    rejectServerRequest,
    on: host.on,
    isAlive: host.isAlive,
    dispose: host.dispose,
  };
}

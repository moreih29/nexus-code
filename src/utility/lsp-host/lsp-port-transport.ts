/**
 * MessagePort transport layer for the LSP utility process.
 *
 * Owns the single IMessagePort that connects the utility process to the main
 * process.  Exposes `send` for fire-and-forget outbound messages and
 * `requestMain` for round-trip calls where the main process is expected to
 * reply with a matching `serverResponse` message.  The pending-reply map and
 * the auto-incrementing request id are encapsulated here so no other module
 * needs to touch them.
 */

import { PendingRequestMap } from "../../shared/pending-request-map";

// ---------------------------------------------------------------------------
// Inbound message shapes (main → utility)
// ---------------------------------------------------------------------------

export interface CallMsg {
  type: "call";
  id: string | number;
  method: string;
  args: unknown;
}

export interface CancelMsg {
  type: "cancel";
  id: string | number;
}

export interface NotifyMsg {
  type: "notify";
  method: string;
  args: unknown;
}

export interface ServerResponseMsg {
  type: "serverResponse";
  id: string | number;
  result?: unknown;
  error?: unknown;
}

export type InboundMsg = CallMsg | CancelMsg | NotifyMsg | ServerResponseMsg;

// MessagePort structural type (no electron import in utility)
export interface IMessagePort {
  on: (event: "message", handler: (e: { data: unknown }) => void) => void;
  start: () => void;
  postMessage: (data: unknown) => void;
}

const MAIN_SERVER_REQUEST_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// LspPortTransport
// ---------------------------------------------------------------------------

export class LspPortTransport {
  private port: IMessagePort | null = null;
  private readonly pendingMainRequests = new PendingRequestMap<string | number, unknown>();
  private nextMainRequestId = 1;

  /** Callback invoked for every inbound message received on the port. */
  onMessage: ((msg: InboundMsg) => void) | null = null;

  attachPort(port: IMessagePort): void {
    this.port = port;
    port.on("message", (event) => {
      this.handleMessage(event.data as InboundMsg);
    });
    port.start();
  }

  send(msg: unknown): void {
    if (this.port) {
      this.port.postMessage(msg);
    }
  }

  requestMain(method: string, params: unknown): Promise<unknown> {
    if (!this.port) {
      return Promise.reject(new Error("main port is not attached"));
    }

    const id = `server-${this.nextMainRequestId++}`;
    const promise = this.pendingMainRequests.register({
      key: id,
      timeoutMs: MAIN_SERVER_REQUEST_TIMEOUT_MS,
      onTimeout: () => new Error(`server request timed out: ${method}`),
    });
    this.send({ type: "serverRequest", id, method, params });
    return promise;
  }

  clearPending(reason: string): void {
    this.pendingMainRequests.clearAll(reason);
  }

  private handleMessage(msg: InboundMsg): void {
    if (msg.type === "serverResponse") {
      this.handleMainResponse(msg);
      return;
    }
    this.onMessage?.(msg);
  }

  private handleMainResponse(msg: ServerResponseMsg): void {
    if (msg.error) {
      this.pendingMainRequests.reject(msg.id, new Error(String(msg.error)));
    } else {
      this.pendingMainRequests.resolve(msg.id, msg.result ?? null);
    }
  }
}

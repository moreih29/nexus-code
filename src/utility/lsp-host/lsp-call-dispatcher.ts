/**
 * Call dispatcher — routes inbound IPC calls to the correct LSP adapter.
 *
 * Knows how to parse handler metadata, invoke a registered server handler, and
 * fan-out a single call across multiple adapters (workspace/symbol).  It is
 * deliberately ignorant of port transport, adapter lifecycle, and idle-timer
 * policy — it only knows how to pick the right adapter and call it.
 *
 * The dispatcher writes responses back via the `send` callback injected at
 * construction time, keeping it decoupled from `LspPortTransport`.
 */

import {
  type HandlerMeta,
  handlerMetadata,
  invokeLspHandler,
  type LspManagerContext,
  type MethodName,
  parseHandlerOutput,
  type RoutedAdapter,
} from "./lsp-handlers";
import type { CallMsg } from "./lsp-port-transport";

// ---------------------------------------------------------------------------
// LspCallDispatcher
// ---------------------------------------------------------------------------

export class LspCallDispatcher {
  private readonly inFlightCalls = new Map<string | number, AbortController>();

  constructor(
    private readonly context: LspManagerContext,
    private readonly send: (msg: unknown) => void,
  ) {}

  /**
   * Handle a `call` message: track it as in-flight for cancellation, dispatch
   * it, and ensure a response is always sent.
   */
  handleCall(msg: CallMsg): void {
    const { id } = msg;
    const abortController = new AbortController();
    this.inFlightCalls.set(id, abortController);

    this.dispatchCall(msg, abortController.signal)
      .catch((err: unknown) => {
        this.send({
          type: "response",
          id,
          error: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        this.inFlightCalls.delete(id);
      });
  }

  /** Cancel the in-flight call with the given id. */
  cancel(id: string | number): void {
    this.inFlightCalls.get(id)?.abort();
  }

  private async dispatchCall(msg: CallMsg, signal: AbortSignal): Promise<void> {
    const { id, method } = msg;
    const meta = handlerMetadata[method as MethodName];
    if (!meta) {
      this.send({ type: "response", id, error: `unknown method: ${method}` });
      return;
    }
    const parsed = meta.inSchema.safeParse(msg.args);
    if (!parsed.success) {
      this.send({ type: "response", id, error: parsed.error.message });
      return;
    }

    const routed = await meta.route(this.context, parsed.data);
    if (!routed) {
      const result = meta.outSchema.parse(meta.emptyResponse);
      this.send({ type: "response", id, result: result ?? null });
      return;
    }

    if (Array.isArray(routed)) {
      await this.dispatchFanOutCall(id, meta, parsed.data, routed, signal);
      return;
    }

    if (meta.capabilityKey && !routed.adapter.hasCapability(meta.capabilityKey)) {
      const result = meta.outSchema.parse(meta.emptyResponse);
      this.send({ type: "response", id, result: result ?? null });
      return;
    }

    this.context.resetIdleTimer(routed.workspaceId, routed.languageId);
    const result = parseHandlerOutput(
      meta,
      await invokeLspHandler(meta, routed.adapter, parsed.data, signal),
    );
    meta.after?.(this.context, parsed.data, routed);
    this.send({ type: "response", id, result: result ?? null });
  }

  private async dispatchFanOutCall(
    id: string | number,
    meta: HandlerMeta,
    args: unknown,
    routedAdapters: RoutedAdapter[],
    signal: AbortSignal,
  ): Promise<void> {
    if (routedAdapters.length === 0) {
      const result = meta.outSchema.parse(meta.emptyResponse);
      this.send({ type: "response", id, result: result ?? null });
      return;
    }

    for (const routed of routedAdapters) {
      this.context.resetIdleTimer(routed.workspaceId, routed.languageId);
    }

    const supportedAdapters = routedAdapters.filter(
      (routed) => !meta.capabilityKey || routed.adapter.hasCapability(meta.capabilityKey),
    );
    if (supportedAdapters.length === 0) {
      const result = meta.outSchema.parse(meta.emptyResponse);
      this.send({ type: "response", id, result: result ?? null });
      return;
    }

    const settled = await Promise.allSettled(
      supportedAdapters.map(async (routed) =>
        parseHandlerOutput(meta, await invokeLspHandler(meta, routed.adapter, args, signal)),
      ),
    );

    const merged: unknown[] = [];
    for (const item of settled) {
      if (item.status === "fulfilled") {
        if (Array.isArray(item.value)) {
          merged.push(...item.value);
        } else {
          merged.push(item.value);
        }
      } else {
        console.warn(`[lsp-manager] ${meta.lspMethod} fan-out request failed`, item.reason);
      }
    }

    const result = meta.outSchema.parse(merged);
    this.send({ type: "response", id, result: result ?? null });
  }
}

import type { CliUiOp, CliUiOps, CliUiRespondArgs } from "../../../shared/cli/ui";
import { PendingRequestMap } from "../../../shared/ipc/pending-request-map";
import { limitLog } from "../../../shared/log/limit";
import { createLogger } from "../../../shared/log/main";
import { CliError } from "./context";

const timeouts = limitLog(createLogger("cli-bridge"));

const UI_TIMEOUT_MS = 15_000;

export interface UiWindow {
  readonly webContents: {
    readonly id?: number;
    send(channel: string, ...args: unknown[]): void;
    focus(): void;
    on?(event: RendererGoneEvent, listener: () => void): unknown;
    removeListener?(event: RendererGoneEvent, listener: () => void): unknown;
  };
}

type RendererGoneEvent = "did-navigate" | "render-process-gone" | "destroyed";
const RENDERER_GONE_EVENTS: readonly RendererGoneEvent[] = [
  "did-navigate",
  "render-process-gone",
  "destroyed",
];

const replyKey = (requestId: string, senderId?: number): string =>
  senderId === undefined ? requestId : `${senderId}:${requestId}`;

export class RendererBridge {
  private readonly pending = new PendingRequestMap<string, CliUiRespondArgs>();
  private nextId = 1;

  constructor(private readonly getWindow: () => UiWindow | null) {}

  ask<K extends CliUiOp>(
    op: K,
    args: CliUiOps[K]["args"],
    timeoutMs = UI_TIMEOUT_MS,
    signal?: AbortSignal,
  ): Promise<CliUiOps[K]["result"]> {
    return this.askIn(this.getWindow()?.webContents, op, args, timeoutMs, signal);
  }

  async askIn<K extends CliUiOp>(
    contents: Pick<UiWindow["webContents"], "id" | "send" | "on" | "removeListener"> | undefined,
    op: K,
    args: CliUiOps[K]["args"],
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<CliUiOps[K]["result"]> {
    signal?.throwIfAborted();
    if (!contents) throw new CliError("NexusCode has no window open");
    const requestId = `cli-ui-${this.nextId++}`;
    const key = replyKey(requestId, contents.id);
    const answer = this.pending.register({
      key,
      timeoutMs,
      onTimeout: () => {
        timeouts.log(
          "warn",
          `ui:${op}`,
          `the window did not answer a cli request: op=${op} waited=${timeoutMs}ms`,
        );
        return new CliError("NexusCode's window did not answer");
      },
    });
    const cancel = () =>
      this.pending.reject(
        key,
        signal?.reason instanceof Error ? signal.reason : new CliError("the command was cancelled"),
      );
    signal?.addEventListener("abort", cancel, { once: true });
    const gone = () =>
      this.pending.reject(key, new CliError("NexusCode's window was reloaded or closed"));
    const watchGone = !Number.isFinite(timeoutMs);
    if (watchGone) for (const event of RENDERER_GONE_EVENTS) contents.on?.(event, gone);
    try {
      contents.send("ipc:event", "cli", "uiRequest", { requestId, op, args });
    } catch (error) {
      this.pending.reject(key, error instanceof Error ? error : new Error(String(error)));
    }
    const response = await answer.finally(() => {
      signal?.removeEventListener("abort", cancel);
      if (watchGone)
        for (const event of RENDERER_GONE_EVENTS) contents.removeListener?.(event, gone);
    });
    if (!response.ok) throw new CliError(response.error ?? `${op} failed`);
    return response.value as CliUiOps[K]["result"];
  }

  resolve(response: CliUiRespondArgs, senderId?: number): void {
    this.pending.resolve(replyKey(response.requestId, senderId), response);
  }

  dispose(): void {
    this.pending.clearAll("NexusCode is closing");
  }
}

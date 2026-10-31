/**
 * Asks the renderer to do what only it can for a nexus command, and waits
 * for its answer: main sends "cli:uiRequest" to the app's window and the
 * renderer calls cli.uiRespond.
 */
import type { CliUiOp, CliUiOps, CliUiRespondArgs } from "../../../shared/cli/ui";
import { PendingRequestMap } from "../../../shared/ipc/pending-request-map";
import { CliError } from "./context";

/** How long the renderer has to answer. */
const UI_TIMEOUT_MS = 15_000;

export interface UiWindow {
  readonly webContents: { send(channel: string, ...args: unknown[]): void };
}

export class RendererBridge {
  private readonly pending = new PendingRequestMap<string, CliUiRespondArgs>();
  private nextId = 1;

  constructor(private readonly getWindow: () => UiWindow | null) {}

  async ask<K extends CliUiOp>(
    op: K,
    args: CliUiOps[K]["args"],
    timeoutMs = UI_TIMEOUT_MS,
  ): Promise<CliUiOps[K]["result"]> {
    const win = this.getWindow();
    if (!win) throw new CliError("NexusCode has no window open");
    const requestId = `cli-ui-${this.nextId++}`;
    const answer = this.pending.register({
      key: requestId,
      timeoutMs,
      onTimeout: () => new CliError("NexusCode's window did not answer"),
    });
    win.webContents.send("ipc:event", "cli", "uiRequest", { requestId, op, args });
    const response = await answer;
    if (!response.ok) throw new CliError(response.error ?? `${op} failed`);
    return response.value as CliUiOps[K]["result"];
  }

  /** Takes the renderer's answer to one request. */
  resolve(response: CliUiRespondArgs): void {
    this.pending.resolve(response.requestId, response);
  }

  dispose(): void {
    this.pending.clearAll("NexusCode is closing");
  }
}

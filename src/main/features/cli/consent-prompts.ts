/**
 * The consent prompts waiting on the user, wherever they came from: a
 * nexus command changing another workspace, an agent of another computer
 * of theirs. The renderer shows them one at a time; this
 * keeps them by id meanwhile, so another device of the user's can list
 * them (the remote's sessions.list) and answer one (consent.answer), which
 * closes it here as the user's own answer would.
 */
import { randomUUID } from "node:crypto";
import type { CliConsentAnswer, CliUiOps } from "../../../shared/cli/ui";
import type { CliConsents, PendingConsent } from "./context";

type AskArgs = CliUiOps["consent.ask"]["args"];

export interface ConsentPromptsDeps {
  ask(
    args: AskArgs,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<{ answer: CliConsentAnswer }>;
  /** Answers a prompt shown (consent.settle); false when it no longer waits. */
  settle(id: string, answer: "once" | "session" | "deny", by?: string): Promise<boolean>;
  onChange?(): void;
  now?: () => number;
}

export class ConsentPrompts implements CliConsents {
  /** By id, in the order asked. */
  private readonly pending = new Map<string, PendingConsent>();

  constructor(private readonly deps: ConsentPromptsDeps) {}

  async ask(
    args: AskArgs,
    bridgeTimeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<{ answer: CliConsentAnswer }> {
    signal?.throwIfAborted();
    const id = randomUUID();
    const at = this.deps.now?.() ?? Date.now();
    const request = { ...args, id };
    const { timeoutMs } = args;
    this.pending.set(id, {
      id,
      at,
      ...(timeoutMs !== undefined ? { expiresAt: at + timeoutMs } : {}),
      request,
    });
    this.deps.onChange?.();
    const cancel = () => {
      this.remove(id);
      void this.deps.settle(id, "deny").catch(() => false);
    };
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      const answer = await this.deps.ask(
        request,
        bridgeTimeoutMs ??
          (timeoutMs !== undefined ? timeoutMs + 10_000 : Number.POSITIVE_INFINITY),
        signal,
      );
      signal?.throwIfAborted();
      return answer;
    } finally {
      signal?.removeEventListener("abort", cancel);
      this.remove(id);
    }
  }

  list(): readonly PendingConsent[] {
    return [...this.pending.values()];
  }

  async answer(id: string, answer: "once" | "session" | "deny", by: string): Promise<boolean> {
    if (!this.pending.has(id)) return false;
    const settled = await this.deps.settle(id, answer, by).catch(() => false);
    if (settled) this.remove(id);
    return settled;
  }

  private remove(id: string): void {
    if (this.pending.delete(id)) this.deps.onChange?.();
  }
}

/**
 * The consent prompts waiting on the user, wherever they came from: a
 * nexus command changing another workspace, the agent manager, an agent of
 * another computer of theirs. The renderer shows them one at a time; this
 * keeps them by id meanwhile, so another device of the user's can list
 * them (the remote's sessions.list) and answer one (consent.answer), which
 * closes it here as the user's own answer would.
 */
import { randomUUID } from "node:crypto";
import type { CliConsentAnswer, CliUiOps } from "../../../shared/cli/ui";
import type { CliConsents, PendingConsent } from "./context";

type AskArgs = CliUiOps["consent.ask"]["args"];

export interface ConsentPromptsDeps {
  /** Shows the prompt (the renderer's consent.ask), waiting up to `timeoutMs` for the answer. */
  ask(args: AskArgs, timeoutMs: number): Promise<{ answer: CliConsentAnswer }>;
  /** Answers a prompt shown (consent.settle); false when it no longer waits. */
  settle(id: string, answer: "once" | "session" | "deny", by: string): Promise<boolean>;
  now?: () => number;
}

export class ConsentPrompts implements CliConsents {
  /** By id, in the order asked. */
  private readonly pending = new Map<string, PendingConsent>();

  constructor(private readonly deps: ConsentPromptsDeps) {}

  /**
   * Asks the user, as consent.ask does, keeping the prompt listed until it
   * is answered or runs out. The renderer takes it down at its timeout; the
   * wait for the answer, `bridgeTimeoutMs`, is a little longer by default.
   */
  async ask(args: AskArgs, bridgeTimeoutMs?: number): Promise<{ answer: CliConsentAnswer }> {
    const id = randomUUID();
    const at = this.deps.now?.() ?? Date.now();
    const request = { ...args, id };
    this.pending.set(id, { id, at, expiresAt: at + args.timeoutMs, request });
    try {
      return await this.deps.ask(request, bridgeTimeoutMs ?? args.timeoutMs + 10_000);
    } finally {
      this.pending.delete(id);
    }
  }

  list(): readonly PendingConsent[] {
    return [...this.pending.values()];
  }

  async answer(id: string, answer: "once" | "session" | "deny", by: string): Promise<boolean> {
    if (!this.pending.has(id)) return false;
    return this.deps.settle(id, answer, by).catch(() => false);
  }
}

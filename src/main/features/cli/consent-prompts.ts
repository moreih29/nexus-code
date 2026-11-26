import { randomUUID } from "node:crypto";
import {
  MAX_CONSENT_RESOLUTIONS,
  type RemoteConsentResolution,
} from "../../../../packages/remote-protocol/src";
import type { CliConsentAnswer, CliUiOps } from "../../../shared/cli/ui";
import type { CliConsents, PendingConsent } from "./context";

type AskArgs = CliUiOps["consent.ask"]["args"];
const RESOLUTION_RETENTION_MS = 60_000;

export interface ConsentPromptsDeps {
  ask(
    args: AskArgs,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<{ answer: CliConsentAnswer }>;
  settle(id: string, answer: "once" | "session" | "deny", by?: string): Promise<boolean>;
  onChange?(): void;
  now?: () => number;
}

export class ConsentPrompts implements CliConsents {
  private readonly pending = new Map<string, PendingConsent>();
  private readonly resolutions: { resolution: RemoteConsentResolution; expiresAt: number }[] = [];

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
    const cancel = () => {
      if (!this.finish(id, "cancelled")) return;
      void this.deps.settle(id, "deny").catch(() => false);
    };
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      this.deps.onChange?.();
      signal?.throwIfAborted();
      const answer = await this.deps.ask(
        request,
        bridgeTimeoutMs ??
          (timeoutMs !== undefined ? timeoutMs + 10_000 : Number.POSITIVE_INFINITY),
        signal,
      );
      signal?.throwIfAborted();
      this.finish(id, answer.answer === "timeout" ? "timeout" : "answered");
      return answer;
    } catch (error) {
      this.finish(id, "cancelled");
      throw error;
    } finally {
      signal?.removeEventListener("abort", cancel);
    }
  }

  list(): readonly PendingConsent[] {
    return [...this.pending.values()];
  }

  listResolutions(): RemoteConsentResolution[] {
    this.pruneResolutions(this.deps.now?.() ?? Date.now());
    return this.resolutions.map(({ resolution }) => resolution);
  }

  async answer(id: string, answer: "once" | "session" | "deny", by: string): Promise<boolean> {
    if (!this.pending.has(id)) return false;
    const settled = await this.deps.settle(id, answer, by).catch(() => false);
    if (settled) this.finish(id, "answered");
    return settled;
  }

  private finish(id: string, reason: RemoteConsentResolution["reason"]): boolean {
    if (!this.pending.delete(id)) return false;
    const now = this.deps.now?.() ?? Date.now();
    this.pruneResolutions(now);
    if (this.resolutions.length === MAX_CONSENT_RESOLUTIONS) this.resolutions.shift();
    this.resolutions.push({ resolution: { id, reason }, expiresAt: now + RESOLUTION_RETENTION_MS });
    this.deps.onChange?.();
    return true;
  }

  private pruneResolutions(now: number): void {
    while (this.resolutions[0] && this.resolutions[0].expiresAt <= now) this.resolutions.shift();
  }
}

/**
 * Whether nexus may change a workspace other than its terminal's own. The
 * Agents setting answers, or, set to "ask", the user does: for this once,
 * or for every change from that workspace to that one until the app
 * restarts.
 */
import type { CliChange, CliConsentAnswer } from "../../../shared/cli/ui";
import type { AppState } from "../../../shared/types/app-state";
import { tryGetMainT } from "../../i18n";
import { CliError } from "./context";

export type CrossWorkspacePolicy = AppState["cliCrossWorkspace"];

/** How long the user has to answer before the change is turned down. */
export const CONSENT_TIMEOUT_MS = 90_000;

export interface ChangeRequest {
  readonly fromWorkspaceId: string;
  readonly fromTabId: string;
  readonly toWorkspaceId: string;
  readonly change: CliChange;
  readonly sandbox?: {
    readonly verified: boolean;
    readonly workspaceChange: CliChange;
  };
}

export interface ConsentDeps {
  policy(): CrossWorkspacePolicy;
  ask(request: ChangeRequest, timeoutMs: number, signal?: AbortSignal): Promise<CliConsentAnswer>;
  sandboxSession(workspaceId: string, tabId: string, signal?: AbortSignal): Promise<string | null>;
}

function refusal(answer: CliConsentAnswer, sandbox: boolean): CliError {
  if (sandbox) {
    const t = tryGetMainT();
    return new CliError(
      answer === "timeout"
        ? (t?.("settings:agentCli.consent.sandbox_timeout") ??
            "The approval to run this command outside the sandbox timed out. Try again when the user can approve it in NexusCode.")
        : (t?.("settings:agentCli.consent.sandbox_denied") ??
            "The user denied running this command outside the sandbox."),
    );
  }
  return new CliError(
    answer === "timeout"
      ? "the user did not answer in time; nothing was changed"
      : "the user did not allow it",
  );
}

export class CrossWorkspaceConsent {
  /** "from>to" pairs of workspaces the user allowed until restart. */
  private readonly allowed = new Set<string>();
  /** Caller tab and destination to the caller's approved session. */
  private readonly sandboxAllowed = new Map<string, string>();

  constructor(private readonly deps: ConsentDeps) {}

  /** Resolves when the change may go ahead; a CliError saying why when not. */
  async check(request: ChangeRequest, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const policy = this.deps.policy();
    if (policy === "deny") {
      throw new CliError(
        "changing other workspaces is turned off in NexusCode's settings (Agents)",
      );
    }
    if (request.change.kind === "sandboxExecution") {
      await this.askSandbox(request, policy === "ask", signal);
    } else if (policy === "ask") {
      await this.ask(request, signal);
    }
  }

  /**
   * Asks the user about `request` whatever the setting, unless they allowed
   * that workspace's changes to that one until restart: for what the setting
   * does not let through, as an answer to another session's permission
   * request, a looser mode or another profile, in the caller's own workspace
   * too. Resolves when allowed; a CliError saying why when not.
   */
  async ask(request: ChangeRequest, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (request.change.kind === "sandboxExecution") {
      return this.askSandbox(request, false, signal);
    }
    const pair = `${request.fromWorkspaceId}>${request.toWorkspaceId}`;
    if (!request.change.eachTime && this.allowed.has(pair)) return;
    if ((await this.prompt(request, signal)) === "session") this.allowed.add(pair);
  }

  private async askSandbox(
    request: ChangeRequest,
    checkWorkspace: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    const { fromWorkspaceId, fromTabId, toWorkspaceId, change, sandbox } = request;
    const readSession = () =>
      this.deps.sandboxSession(fromWorkspaceId, fromTabId, signal).catch(() => null);
    const session = sandbox?.verified && !change.eachTime ? await readSession() : null;
    signal?.throwIfAborted();
    const key = JSON.stringify([fromWorkspaceId, fromTabId, toWorkspaceId]);
    if (sandbox && session && this.sandboxAllowed.get(key) === session) {
      if (checkWorkspace) {
        await this.ask(
          { fromWorkspaceId, fromTabId, toWorkspaceId, change: sandbox.workspaceChange },
          signal,
        );
        // The workspace prompt may have waited across a conversation change.
        if ((await readSession()) !== session) {
          signal?.throwIfAborted();
          return this.askSandbox(request, false, signal);
        }
        signal?.throwIfAborted();
      }
      return;
    }

    // A fresh sandbox prompt also authorizes this one change under the workspace policy.
    const approval = session ? request : { ...request, change: { ...change, eachTime: true } };
    const answer = await this.prompt(approval, signal);
    if (answer === "session" && session) {
      const current = await readSession();
      signal?.throwIfAborted();
      if (current === session) this.sandboxAllowed.set(key, session);
    }
  }

  private async prompt(request: ChangeRequest, signal?: AbortSignal): Promise<"once" | "session"> {
    signal?.throwIfAborted();
    const sandbox = request.change.kind === "sandboxExecution";
    const answer = await this.deps.ask(request, CONSENT_TIMEOUT_MS, signal).catch((error) => {
      if (!sandbox) throw error;
      return "timeout" as const;
    });
    signal?.throwIfAborted();
    if (answer === "once" || (answer === "session" && !request.change.eachTime)) return answer;
    throw refusal(answer, sandbox);
  }
}

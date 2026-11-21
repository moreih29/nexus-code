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
}

export interface ConsentDeps {
  policy(): CrossWorkspacePolicy;
  ask(request: ChangeRequest, timeoutMs: number, signal?: AbortSignal): Promise<CliConsentAnswer>;
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

  constructor(private readonly deps: ConsentDeps) {}

  /** Resolves when the change may go ahead; a CliError saying why when not. */
  async check(request: ChangeRequest, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const policy = this.deps.policy();
    if (policy === "allow" && request.change.kind !== "sandboxExecution") return;
    if (policy === "deny") {
      throw new CliError(
        "changing other workspaces is turned off in NexusCode's settings (Agents)",
      );
    }
    await this.ask(request, signal);
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
    const pair = `${request.fromWorkspaceId}>${request.toWorkspaceId}`;
    if (!request.change.eachTime && this.allowed.has(pair)) return;
    const sandbox = request.change.kind === "sandboxExecution";
    const answer = await this.deps.ask(request, CONSENT_TIMEOUT_MS, signal).catch((error) => {
      if (!sandbox) throw error;
      return "timeout" as const;
    });
    signal?.throwIfAborted();
    if (answer === "session" && !request.change.eachTime) this.allowed.add(pair);
    if (answer === "once" || (answer === "session" && !request.change.eachTime)) return;
    throw refusal(answer, sandbox);
  }
}

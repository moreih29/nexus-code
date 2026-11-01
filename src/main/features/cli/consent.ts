/**
 * Whether nexus may change a workspace other than its terminal's own. The
 * Agent CLI setting answers, or, set to "ask", the user does: for this once,
 * or for that pair of workspaces until the app restarts.
 */
import type { CliChange, CliConsentAnswer } from "../../../shared/cli/ui";
import type { AppState } from "../../../shared/types/app-state";
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
  ask(request: ChangeRequest, timeoutMs: number): Promise<CliConsentAnswer>;
}

export class CrossWorkspaceConsent {
  /** "from>to" pairs the user allowed until restart. */
  private readonly allowed = new Set<string>();

  constructor(private readonly deps: ConsentDeps) {}

  /** Resolves when the change may go ahead; a CliError saying why when not. */
  async check(request: ChangeRequest): Promise<void> {
    const policy = this.deps.policy();
    if (policy === "allow") return;
    if (policy === "deny") {
      throw new CliError(
        "changing other workspaces is turned off in NexusCode's settings (Agent CLI)",
      );
    }
    const pair = `${request.fromWorkspaceId}>${request.toWorkspaceId}`;
    if (this.allowed.has(pair)) return;
    const answer = await this.deps.ask(request, CONSENT_TIMEOUT_MS);
    if (answer === "session") this.allowed.add(pair);
    if (answer === "once" || answer === "session") return;
    throw new CliError(
      answer === "timeout"
        ? "the user did not answer in time; nothing was changed"
        : "the user did not allow it",
    );
  }
}

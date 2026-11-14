/**
 * Whether nexus may change a workspace other than its terminal's own. The
 * Agents setting answers, or, set to "ask", the user does: for this once,
 * or for that kind of change from that workspace to that one until the app
 * restarts. What is typed, sent or run is asked about each time
 * (askedEachTime).
 */
import { askedEachTime, type CliChange, type CliConsentAnswer } from "../../../shared/cli/ui";
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

/**
 * Asks the user about `request` whatever the setting: for what is not to be
 * allowed for good, as an answer to another session's permission request.
 * Resolves when allowed; a CliError saying why when not.
 */
export async function askEachTime(request: ChangeRequest, ask: ConsentDeps["ask"]): Promise<void> {
  const answer = await ask(request, CONSENT_TIMEOUT_MS);
  if (answer === "once" || answer === "session") return;
  throw refusal(answer);
}

function refusal(answer: CliConsentAnswer): CliError {
  return new CliError(
    answer === "timeout"
      ? "the user did not answer in time; nothing was changed"
      : "the user did not allow it",
  );
}

export class CrossWorkspaceConsent {
  /**
   * The kinds of change the user allowed until restart, by the workspace
   * asking and the one changed: opening a file there says nothing of
   * closing its tabs.
   */
  private readonly allowed = new Set<string>();

  constructor(private readonly deps: ConsentDeps) {}

  /** Resolves when the change may go ahead; a CliError saying why when not. */
  async check(request: ChangeRequest): Promise<void> {
    const policy = this.deps.policy();
    if (policy === "allow") return;
    if (policy === "deny") {
      throw new CliError(
        "changing other workspaces is turned off in NexusCode's settings (Agents)",
      );
    }
    const key = `${request.fromWorkspaceId}>${request.toWorkspaceId}>${request.change.kind}`;
    const eachTime = askedEachTime(request.change);
    if (!eachTime && this.allowed.has(key)) return;
    const answer = await this.deps.ask(request, CONSENT_TIMEOUT_MS);
    // What is asked each time is allowed for this once, however the answer came.
    if (answer === "session" && !eachTime) this.allowed.add(key);
    if (answer === "once" || answer === "session") return;
    throw refusal(answer);
  }
}

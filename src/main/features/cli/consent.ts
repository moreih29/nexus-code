import { randomUUID } from "node:crypto";
import type { CliChange, CliConsentAnswer } from "../../../shared/cli/ui";
import type { AppState } from "../../../shared/types/app-state";
import type { WorkspaceMeta } from "../../../shared/types/workspace";
import { tryGetMainT } from "../../i18n";
import { CliError } from "./context";

export type CrossWorkspacePolicy = AppState["cliCrossWorkspace"];

export interface ChangeRequest {
  readonly fromWorkspaceId: string;
  readonly fromTabId: string;
  readonly toWorkspaceId: string;
  readonly change: CliChange;
  readonly verified?: boolean;
  readonly otherWorkspaces?: boolean;
  readonly sandbox?: {
    readonly verified: boolean;
    readonly workspaceChange: CliChange;
  };
}

export interface ConsentDeps {
  policy(): CrossWorkspacePolicy;
  preallowed(): readonly string[];
  workspaces(): readonly WorkspaceMeta[];
  ask(request: ChangeRequest, signal?: AbortSignal): Promise<CliConsentAnswer>;
  chatSession(workspaceId: string, tabId: string, signal?: AbortSignal): Promise<string | null>;
  sandboxSession(workspaceId: string, tabId: string, signal?: AbortSignal): Promise<string | null>;
}

interface SessionGrant {
  readonly id: string;
  readonly workspaceId: string;
  readonly fromWorkspaceId: string;
  readonly fromTabId: string;
}

export function grantWorkspaceId(workspaces: readonly WorkspaceMeta[], id: string) {
  const workspace = workspaces.find((item) => item.id === id);
  const root = workspace?.task?.parentId ?? workspace?.id;
  return workspaces.find((item) => item.id === root && !item.task)?.id;
}

function refusal(sandbox: boolean, unasked = false): CliError {
  if (!sandbox) return new CliError("the user did not allow it");
  const t = tryGetMainT();
  return new CliError(
    unasked
      ? (t?.("settings:agentCli.consent.sandbox_unasked") ??
          "NexusCode could not ask for approval to run this command outside the sandbox. Try again when the user can approve it in NexusCode.")
      : (t?.("settings:agentCli.consent.sandbox_denied") ??
          "The user denied running this command outside the sandbox."),
  );
}

function crossWorkspaceOff(): CliError {
  return new CliError("changing other workspaces is turned off in NexusCode's settings (Agents)");
}

export class CrossWorkspaceConsent {
  private readonly allowed = new Map<string, { grant: SessionGrant; session: string }>();
  private readonly sandboxAllowed = new Map<string, string>();

  constructor(private readonly deps: ConsentDeps) {}

  async grants(signal?: AbortSignal): Promise<SessionGrant[]> {
    const grants = await Promise.all(
      [...this.allowed.entries()].map(async ([key, entry]) => {
        const { grant, session } = entry;
        const current = await this.deps
          .chatSession(grant.fromWorkspaceId, grant.fromTabId, signal)
          .catch(() => undefined);
        signal?.throwIfAborted();
        if (this.allowed.get(key) !== entry) return undefined;
        if (current !== session || this.workspaceId(grant.workspaceId) !== grant.workspaceId) {
          if (current !== undefined) this.allowed.delete(key);
          return undefined;
        }
        return grant;
      }),
    );
    return grants.filter((grant) => grant !== undefined);
  }

  revoke(id: string): void {
    for (const [key, { grant }] of this.allowed) {
      if (grant.id === id) this.allowed.delete(key);
    }
  }

  private workspaceId(id: string) {
    return grantWorkspaceId(this.deps.workspaces(), id);
  }

  private checkDeny(): void {
    if (this.deps.policy() === "deny") throw crossWorkspaceOff();
  }

  async check(request: ChangeRequest, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    this.checkDeny();
    const crossWorkspace = { ...request, otherWorkspaces: true };
    if (request.change.kind === "sandboxExecution") {
      await this.askSandbox(crossWorkspace, signal);
    } else if (this.deps.policy() === "ask") {
      await this.askWorkspace(crossWorkspace, signal);
    }
  }

  async ask(request: ChangeRequest, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (request.otherWorkspaces) this.checkDeny();
    if (request.change.kind === "sandboxExecution") {
      return this.askSandbox(request, signal);
    }
    await this.prompt({ ...request, change: { ...request.change, eachTime: true } }, signal);
  }

  private async askWorkspace(request: ChangeRequest, signal?: AbortSignal): Promise<void> {
    const { fromWorkspaceId, fromTabId, toWorkspaceId, change } = request;
    const workspaceId = this.workspaceId(toWorkspaceId);
    const isAllowed = () =>
      !change.eachTime &&
      (this.deps.policy() === "allow" ||
        (workspaceId !== undefined && this.deps.preallowed().includes(workspaceId)));
    if (isAllowed()) return;
    const readSession = () =>
      this.deps.chatSession(fromWorkspaceId, fromTabId, signal).catch(() => null);
    const session =
      workspaceId && request.verified && !change.eachTime ? await readSession() : null;
    signal?.throwIfAborted();
    this.checkDeny();
    const key = JSON.stringify([fromWorkspaceId, fromTabId, workspaceId]);
    const previous = this.allowed.get(key);
    if (session && previous && previous.session !== session) this.allowed.delete(key);
    if (isAllowed() || (session && previous?.session === session)) return;
    const approval = session ? request : { ...request, change: { ...change, eachTime: true } };
    const answer = await this.prompt(approval, signal);
    if (session && (await readSession()) !== session) {
      signal?.throwIfAborted();
      throw new CliError("the calling chat session changed while waiting for approval");
    }
    signal?.throwIfAborted();
    this.checkDeny();
    if (workspaceId && this.workspaceId(toWorkspaceId) !== workspaceId) {
      throw new CliError("the destination workspace changed while waiting for approval");
    }
    if (answer === "session" && session && workspaceId && !this.allowed.has(key)) {
      this.allowed.set(key, {
        grant: { id: randomUUID(), workspaceId, fromWorkspaceId, fromTabId },
        session,
      });
    }
  }

  private async askSandbox(request: ChangeRequest, signal?: AbortSignal): Promise<void> {
    const { fromWorkspaceId, fromTabId, toWorkspaceId, change, sandbox } = request;
    const readSession = () =>
      this.deps.sandboxSession(fromWorkspaceId, fromTabId, signal).catch(() => null);
    const session = sandbox?.verified && !change.eachTime ? await readSession() : null;
    signal?.throwIfAborted();
    if (request.otherWorkspaces) this.checkDeny();
    const key = JSON.stringify([fromWorkspaceId, fromTabId, toWorkspaceId]);
    if (sandbox && session && this.sandboxAllowed.get(key) === session) {
      if (request.otherWorkspaces && this.deps.policy() === "ask") {
        await this.askWorkspace({ ...request, change: sandbox.workspaceChange }, signal);
        if ((await readSession()) !== session) {
          signal?.throwIfAborted();
          throw new CliError("the calling session changed while waiting for approval");
        }
        signal?.throwIfAborted();
        this.checkDeny();
      }
      return;
    }

    const approval = session ? request : { ...request, change: { ...change, eachTime: true } };
    const answer = await this.prompt(approval, signal);
    if (session) {
      const current = await readSession();
      signal?.throwIfAborted();
      if (current !== session)
        throw new CliError("the calling session changed while waiting for approval");
      if (request.otherWorkspaces) this.checkDeny();
      if (answer === "session") this.sandboxAllowed.set(key, session);
    }
  }

  private async prompt(request: ChangeRequest, signal?: AbortSignal): Promise<"once" | "session"> {
    signal?.throwIfAborted();
    if (request.otherWorkspaces) this.checkDeny();
    const sandbox = request.change.kind === "sandboxExecution";
    const answer = await this.deps.ask(request, signal).catch((error) => {
      signal?.throwIfAborted();
      if (!sandbox) throw error;
      return null;
    });
    signal?.throwIfAborted();
    if (request.otherWorkspaces) this.checkDeny();
    if (answer === "timeout") {
      throw new CliError("approval in NexusCode timed out; nothing was done", 1, {
        error: "approval-timeout",
      });
    }
    if (answer === "once" || (answer === "session" && !request.change.eachTime)) return answer;
    throw refusal(sandbox, answer === null);
  }
}

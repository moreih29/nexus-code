import { type Capability, RpcErrorCode } from "../../../../../packages/remote-protocol/src";
import type { WorkspaceMeta } from "../../../../shared/types/workspace";
import type { CliServices } from "../../cli/context";
import { fitsInFrame, RpcFailure } from "../room";

export const SERVES: readonly Capability[] = [
  "sessions",
  "sessions.reorder",
  "sessions.markSeen",
  "chat.read",
  "chat.control",
  "terminal.read",
  "terminal.control",
  "files",
  "files.write",
  "git",
  "notes",
  "workspace.create",
  "agents",
  "agents.cli",
  "settings.instructions",
  "profiles.usage",
  "push",
  "system.stats",
  "chat.peek",
  "profiles.usage.people",
];

export function servesWith(
  allowControl: boolean,
  allowTerminal = false,
  allowAgents = false,
  allowPush = false,
  servesFiles = true,
): readonly Capability[] {
  return SERVES.filter(
    (c) =>
      ((c !== "chat.control" && c !== "workspace.create") || allowControl) &&
      (c !== "files.write" || (allowControl && allowAgents)) &&
      (c !== "terminal.control" || allowTerminal) &&
      (c !== "agents" || allowAgents) &&
      (c !== "push" || allowPush) &&
      ((c !== "files" && c !== "files.write" && c !== "system.stats") || servesFiles),
  ).filter((c, _i, served) => c !== "chat.peek" || served.includes("chat.read"));
}

export { oneLine } from "../../../../shared/remote/one-line";

export async function tabOf(
  services: CliServices,
  workspaceId: string,
  tabId: string,
  kinds: readonly string[],
  reader: Pick<CliServices, "ui"> = services,
): Promise<{ id: string; type: string; title: string }> {
  if (!workspaceOf(services, workspaceId)) {
    throw new RpcFailure(RpcErrorCode.NotFound, "no such workspace");
  }
  const { tabs } = await reader.ui("tabs.list", { workspaceId }).catch((error: unknown) => {
    if (error instanceof RpcFailure) throw error;
    return { tabs: [] };
  });
  const tab = tabs.find((t) => t.id === tabId);
  if (!tab || !kinds.includes(tab.type)) {
    throw new RpcFailure(RpcErrorCode.NotFound, `no such ${kinds.join(" or ")} tab`);
  }
  return tab;
}

export const NO_RUN_SESSION = /^no session of run /;

export function chatRunOf(
  services: CliServices,
  workspaceId: string,
  tabId: string,
  runId: string,
): { noSession: () => RpcFailure } {
  const run = services.claudeAgents
    .list(workspaceId, tabId)
    .find((agent) => agent.kind === "print" && agent.id === runId);
  if (!run) throw new RpcFailure(RpcErrorCode.NotFound, `no run ${runId}: it is not kept`);
  const mayCome =
    run.end === undefined &&
    (services.claudeAgents.keepsSession?.(workspaceId, tabId, runId) ?? false);
  return {
    noSession: () =>
      mayCome
        ? new RpcFailure(RpcErrorCode.Unavailable, `run ${runId} has no session to read yet`)
        : new RpcFailure(RpcErrorCode.NotFound, `run ${runId} keeps no session to read`),
  };
}

export function workspaceOf(services: CliServices, workspaceId: string): WorkspaceMeta | undefined {
  return services.listWorkspaces().find((w) => w.id === workspaceId);
}

export function unavailable(error: unknown): never {
  throw new RpcFailure(
    RpcErrorCode.Unavailable,
    error instanceof Error ? error.message : String(error),
  );
}

export const ENVELOPE_BYTES = 1024;

export function fitsAsResult(result: unknown): boolean {
  return fitsInFrame({ result, pad: "x".repeat(ENVELOPE_BYTES) });
}

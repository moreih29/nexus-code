import { type Capability, RpcErrorCode } from "../../../../../packages/remote-protocol/src";
import type { WorkspaceMeta } from "../../../../shared/types/workspace";
import type { CliServices } from "../../cli/context";
import { fitsInFrame, RpcFailure } from "../room";

/** What this version serves; a hello says so, and the others ask for nothing more. */
export const SERVES: readonly Capability[] = [
  "sessions",
  "sessions.reorder",
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
];

/**
 * What this device serves as the user set it: its chats' controls, and
 * its terminals', each only when the user lets other devices have them
 * (Settings › Remote), else they may only look; agents' requests unless
 * the user turned them down.
 */
export function servesWith(
  allowControl: boolean,
  allowTerminal = false,
  allowAgents = false,
  allowPush = false,
): readonly Capability[] {
  return SERVES.filter(
    (c) =>
      ((c !== "chat.control" && c !== "workspace.create") || allowControl) &&
      (c !== "files.write" || (allowControl && allowAgents)) &&
      (c !== "terminal.control" || allowTerminal) &&
      (c !== "agents" || allowAgents) &&
      (c !== "push" || allowPush),
  );
}

export function oneLine(text: string, max = 200): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** The tab, when the workspace holds one of that kind; else NotFound. */
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

/** A workspace the sessions' list shows. */
export function workspaceOf(services: CliServices, workspaceId: string): WorkspaceMeta | undefined {
  return services.listWorkspaces().find((w) => w.id === workspaceId);
}

/**
 * The app failing or refusing to do it as the session stands (nothing to
 * stop, a request answered since), as another device is told it.
 */
export function unavailable(error: unknown): never {
  throw new RpcFailure(
    RpcErrorCode.Unavailable,
    error instanceof Error ? error.message : String(error),
  );
}

/** Room left in a frame for the answer's envelope around a result. */
export const ENVELOPE_BYTES = 1024;

export function fitsAsResult(result: unknown): boolean {
  return fitsInFrame({ result, pad: "x".repeat(ENVELOPE_BYTES) });
}

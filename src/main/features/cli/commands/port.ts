/** nexus port list: the ports a workspace's dev servers listen on. */
import { type ListeningPort, portUrl } from "../../../../shared/pty/ports";
import type { WorkspaceMeta } from "../../../../shared/types/workspace";
import { exactArgs } from "../args";
import { type CliContext, CliError, resolveWorkspace, shortId } from "../context";
import { table } from "../format";
import { type CliCommand, output } from "../registry";
import { WORKSPACE_FLAG } from "./flags";
import { workspaceTabs } from "./terminal";

/** The ports the programs in a workspace's terminals listen on, as they are now. */
export async function workspacePorts(
  ctx: CliContext,
  workspace: WorkspaceMeta,
): Promise<readonly ListeningPort[]> {
  try {
    return await ctx.services.listeningPorts(workspace.id);
  } catch (error) {
    throw new CliError(`could not look at ${workspace.name}'s ports: ${(error as Error).message}`);
  }
}

/** ":5173 (node), :8787 (workerd)" */
export function describePorts(ports: readonly ListeningPort[]): string {
  return ports.map((p) => `:${p.port} (${p.process})`).join(", ");
}

const portList: CliCommand = {
  path: ["port", "list"],
  summary: "List the ports the programs in a workspace's terminals listen on",
  details:
    "The TCP ports a dev server or another program started in the workspace's terminals\n" +
    "listens on, as the status bar shows them. Ports from 49152 up, and ports Docker\n" +
    "publishes, are not listed. An SSH workspace's ports are on its host.",
  flags: { workspace: WORKSPACE_FLAG },
  async run(ctx, { positionals, flags }) {
    exactArgs(positionals);
    const workspace = resolveWorkspace(ctx, flags.workspace as string | undefined);
    const ports = await workspacePorts(ctx, workspace);
    if (ports.length === 0) {
      return output(`No program in ${workspace.name}'s terminals listens on a port.`, []);
    }
    const tabs = await workspaceTabs(ctx, workspace.id);
    const title = (tabId: string) => tabs.find((t) => t.id === tabId)?.title ?? "";
    const rows = ports.map((p) => [
      String(p.port),
      String(p.pid),
      p.process,
      shortId(p.tabId),
      title(p.tabId),
      portUrl(p.port),
    ]);
    const where =
      workspace.location.kind === "ssh"
        ? `\nThese are on ${workspace.location.host}; the app forwards none of them.`
        : "";
    return output(
      table(["PORT", "PID", "PROCESS", "TERMINAL", "TITLE", "URL"], rows) + where,
      ports.map((p) => ({
        port: p.port,
        pid: p.pid,
        process: p.process,
        tabId: p.tabId,
        url: portUrl(p.port),
      })),
    );
  },
};

export const portCommands: CliCommand[] = [portList];

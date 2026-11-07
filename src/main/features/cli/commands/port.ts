/**
 * nexus port list: the ports a workspace's dev servers listen on; nexus port
 * forward and unforward: an SSH workspace's ports on this machine.
 */
import { type ListeningPort, portUrl } from "../../../../shared/pty/ports";
import type { WorkspaceMeta } from "../../../../shared/types/workspace";
import { ForwardError } from "../../pty/forwards";
import { CliUsageError, exactArgs } from "../args";
import { type CliContext, CliError, mayChange, resolveWorkspace, shortId } from "../context";
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

/**
 * Where each port opens on this machine: itself for a local workspace, its
 * forward's local end for an SSH one (none while it is not forwarded).
 */
function localUrls(ctx: CliContext, workspace: WorkspaceMeta): (port: number) => string | null {
  if (workspace.location.kind !== "ssh") return portUrl;
  const forwards = ctx.services.forwards.list(workspace.id);
  return (port) => {
    const forward = forwards.find((f) => f.remotePort === port && f.active);
    return forward ? portUrl(forward.localPort) : null;
  };
}

const portList: CliCommand = {
  path: ["port", "list"],
  summary: "List the ports the programs in a workspace's terminals listen on",
  details:
    "The TCP ports a dev server or another program started in the workspace's terminals\n" +
    "listens on, as the status bar shows them. Ports from 49152 up, and ports Docker\n" +
    "publishes, are not listed. An SSH workspace's ports are on its host; the URL is\n" +
    "where one forwarded to this machine opens (nexus port forward).",
  flags: { workspace: WORKSPACE_FLAG },
  async run(ctx, { positionals, flags }) {
    exactArgs(positionals);
    const workspace = resolveWorkspace(ctx, flags.workspace as string | undefined);
    const ports = await workspacePorts(ctx, workspace);
    const others = forwardedOnly(ctx, workspace, ports);
    if (ports.length === 0) {
      return output(`No program in ${workspace.name}'s terminals listens on a port.${others}`, []);
    }
    const tabs = await workspaceTabs(ctx, workspace.id);
    const title = (tabId: string) => tabs.find((t) => t.id === tabId)?.title ?? "";
    const urlOf = localUrls(ctx, workspace);
    const rows = ports.map((p) => [
      String(p.port),
      String(p.pid),
      p.process,
      shortId(p.tabId),
      title(p.tabId),
      urlOf(p.port) ?? "",
    ]);
    const unforwarded = ports.filter((p) => urlOf(p.port) === null);
    const where =
      workspace.location.kind === "ssh" && unforwarded.length > 0
        ? `\nThese are on ${workspace.location.host}; nexus port forward ${unforwarded[0].port} opens one here.`
        : "";
    return output(
      table(["PORT", "PID", "PROCESS", "TERMINAL", "TITLE", "URL"], rows) + where + others,
      ports.map((p) => ({
        port: p.port,
        pid: p.pid,
        process: p.process,
        tabId: p.tabId,
        url: urlOf(p.port),
      })),
    );
  },
};

/**
 * The SSH workspace's forwards of ports its terminals' programs do not
 * listen on, as a server started some other way: "\nAlso forwarded: …".
 */
function forwardedOnly(
  ctx: CliContext,
  workspace: WorkspaceMeta,
  ports: readonly ListeningPort[],
): string {
  if (workspace.location.kind !== "ssh") return "";
  const listed = new Set(ports.map((p) => p.port));
  const others = ctx.services.forwards
    .list(workspace.id)
    .filter((f) => !listed.has(f.remotePort))
    .map(
      (f) => `${f.remotePort} at ${portUrl(f.localPort)}${f.active ? "" : " (once reconnected)"}`,
    );
  return others.length > 0 ? `\nAlso forwarded: ${others.join(", ")}.` : "";
}

/** A port number as given on the command line. */
function portArg(text: string): number {
  const port = Number(text.replace(/^:/, ""));
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new CliUsageError(`"${text}" is not a port number`);
  }
  return port;
}

/** The SSH workspace a forward is asked of; a local one needs none. */
function sshWorkspace(ctx: CliContext, flag: unknown): { workspace: WorkspaceMeta; host: string } {
  const workspace = resolveWorkspace(ctx, flag as string | undefined);
  if (workspace.location.kind !== "ssh") {
    throw new CliError(`${workspace.name} is on this machine; its ports need no forwarding`);
  }
  return { workspace, host: workspace.location.host };
}

/** A ForwardError in the CLI's words. */
export function forwardFailed(error: unknown): never {
  if (error instanceof ForwardError) throw new CliError(error.message);
  throw error;
}

const portForward: CliCommand = {
  path: ["port", "forward"],
  summary: "Forward a port of an SSH workspace's host to this machine",
  args: "<port>",
  details:
    "Listens on this machine's 127.0.0.1, on the same port when it is free here and on\n" +
    "another one when not, and reaches the port on the host's localhost, over the\n" +
    "workspace's SSH connection. The forward closes while the workspace is disconnected\n" +
    "and comes back when it connects again; nexus port unforward stops it. Opening a\n" +
    "local address in the workspace's browser tabs forwards its port by itself.",
  flags: { workspace: WORKSPACE_FLAG },
  async run(ctx, { positionals, flags }) {
    const [given] = exactArgs(positionals, "port") as [string];
    const port = portArg(given);
    const { workspace, host } = sshWorkspace(ctx, flags.workspace);
    await mayChange(ctx, workspace, { kind: "portForward", detail: String(port) });
    const forward = await ctx.services.forwards.forward(workspace.id, port).catch(forwardFailed);
    const url = portUrl(forward.localPort);
    return output(`${host}:${port} is at ${url}.`, {
      workspaceId: workspace.id,
      port,
      localPort: forward.localPort,
      url,
    });
  },
};

const portUnforward: CliCommand = {
  path: ["port", "unforward"],
  summary: "Stop forwarding a port of an SSH workspace's host",
  args: "<port>",
  flags: { workspace: WORKSPACE_FLAG },
  async run(ctx, { positionals, flags }) {
    const [given] = exactArgs(positionals, "port") as [string];
    const port = portArg(given);
    const { workspace, host } = sshWorkspace(ctx, flags.workspace);
    const forwarded = ctx.services.forwards.list(workspace.id).some((f) => f.remotePort === port);
    if (!forwarded) {
      throw new CliError(`${host}:${port} is not forwarded`);
    }
    await mayChange(ctx, workspace, { kind: "portForward", detail: String(port) });
    await ctx.services.forwards.stop(workspace.id, port);
    return output(`Stopped forwarding ${host}:${port}.`, {
      workspaceId: workspace.id,
      port,
    });
  },
};

export const portCommands: CliCommand[] = [portList, portForward, portUnforward];

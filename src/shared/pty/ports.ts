/**
 * The TCP ports the programs started in a workspace's terminals listen on,
 * as the workspace's agent finds them (pty.listeningPorts): a dev server's,
 * for the status bar and the task switcher to show and open.
 */
import { z } from "zod";

export const ListeningPortSchema = z.object({
  port: z.number().int().positive(),
  pid: z.number().int(),
  /** The program's file name. */
  process: z.string(),
  /** The terminal the program was started in. */
  tabId: z.string(),
});
export type ListeningPort = z.infer<typeof ListeningPortSchema>;

/** pty.listeningPorts' answer, in port order. */
export const ListeningPortsResultSchema = z.object({ ports: z.array(ListeningPortSchema) });

/** A workspace's ports; none once its servers have stopped. */
export const WorkspacePortsSchema = z.object({
  workspaceId: z.string(),
  ports: z.array(ListeningPortSchema),
});
export type WorkspacePorts = z.infer<typeof WorkspacePortsSchema>;

/** Where a port is opened in a browser. */
export function portUrl(port: number): string {
  return `http://localhost:${port}`;
}

/** The ports as ":5173 :8787", the ones past the first `max` as "+N". */
export function portsLabel(ports: readonly { port: number }[], max: number): string {
  const shown = ports.slice(0, max).map((p) => `:${p.port}`);
  if (ports.length > max) shown.push(`+${ports.length - max}`);
  return shown.join(" ");
}

/**
 * A port of an SSH workspace's host forwarded to this machine: its
 * 127.0.0.1:localPort reaches the host's localhost:remotePort. An inactive
 * one waits for the workspace to connect again.
 */
export const PortForwardSchema = z.object({
  remotePort: z.number().int().positive(),
  localPort: z.number().int().positive(),
  active: z.boolean(),
});
export type PortForward = z.infer<typeof PortForwardSchema>;

/** A workspace's forwards, in remote port order; none once all are stopped. */
export const WorkspaceForwardsSchema = z.object({
  workspaceId: z.string(),
  forwards: z.array(PortForwardSchema),
});
export type WorkspaceForwards = z.infer<typeof WorkspaceForwardsSchema>;

/**
 * The port of an http(s) URL to this machine's own address (localhost and
 * its subdomains, the loopback addresses, 0.0.0.0), or null for another URL.
 */
export function loopbackPort(url: string): number | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const host = parsed.hostname.toLowerCase();
  const loopback =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "[::1]" ||
    host === "0.0.0.0" ||
    /^127(\.\d{1,3}){3}$/.test(host);
  if (!loopback) return null;
  if (parsed.port !== "") return Number(parsed.port);
  return parsed.protocol === "https:" ? 443 : 80;
}

/** `url` with its port changed. */
export function withPort(url: string, port: number): string {
  const parsed = new URL(url);
  parsed.port = String(port);
  return parsed.toString();
}

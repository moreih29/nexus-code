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

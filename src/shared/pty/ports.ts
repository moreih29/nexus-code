import { z } from "zod";
import {
  IntegerSchema,
  PositiveIntegerSchema,
} from "../../../packages/remote-protocol/src/validation";

export const ListeningPortSchema = z.object({
  port: PositiveIntegerSchema,
  pid: IntegerSchema,
  process: z.string(),
  tabId: z.string(),
});
export type ListeningPort = z.infer<typeof ListeningPortSchema>;

export const ListeningPortsResultSchema = z.object({ ports: z.array(ListeningPortSchema) });

export const WorkspacePortsSchema = z.object({
  workspaceId: z.string(),
  ports: z.array(ListeningPortSchema),
});
export type WorkspacePorts = z.infer<typeof WorkspacePortsSchema>;

export function portUrl(port: number): string {
  return `http://localhost:${port}`;
}

export function portsLabel(ports: readonly { port: number }[], max: number): string {
  const shown = ports.slice(0, max).map((p) => `:${p.port}`);
  if (ports.length > max) shown.push(`+${ports.length - max}`);
  return shown.join(" ");
}

export const PortForwardSchema = z.object({
  remotePort: PositiveIntegerSchema,
  localPort: PositiveIntegerSchema,
  active: z.boolean(),
});
export type PortForward = z.infer<typeof PortForwardSchema>;

export const WorkspaceForwardsSchema = z.object({
  workspaceId: z.string(),
  forwards: z.array(PortForwardSchema),
});
export type WorkspaceForwards = z.infer<typeof WorkspaceForwardsSchema>;

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

export function withPort(url: string, port: number): string {
  const parsed = new URL(url);
  parsed.port = String(port);
  return parsed.toString();
}

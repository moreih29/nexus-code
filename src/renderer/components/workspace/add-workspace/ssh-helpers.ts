import type { SshConfigHost } from "./types";

export function parseSshDestination(input: string): { host: string; user?: string } | null {
  const value = input.trim();
  if (!value) return null;
  const atIndex = value.lastIndexOf("@");
  if (atIndex > 0 && atIndex < value.length - 1) {
    const user = value.slice(0, atIndex).trim();
    const host = value.slice(atIndex + 1).trim();
    if (!host || hostHasWhitespace(host) || user.length === 0) return null;
    if (user.includes("@") || /\s/.test(user)) return null;
    return { host, user };
  }
  if (value.includes("@")) return null;
  if (hostHasWhitespace(value)) return null;
  return { host: value };
}

export function parseSshPort(value: string): number | undefined | null {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (!/^\d+$/.test(trimmed)) return null;
  const port = Number(trimmed);
  return port >= 1 && port <= 65_535 ? port : null;
}

export function filterSshConfigHosts(
  hosts: readonly SshConfigHost[],
  query: string,
): SshConfigHost[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return hosts.slice(0, 8);
  return hosts
    .filter((host) =>
      [host.alias, host.host, host.user]
        .filter((value): value is string => typeof value === "string")
        .some((value) => value.toLowerCase().includes(normalized)),
    )
    .slice(0, 8);
}

export function findSshConfigHost(
  hosts: readonly SshConfigHost[],
  hostInput: string,
  selectedAlias: string | null,
): SshConfigHost | null {
  const alias = selectedAlias ?? hostInput.trim();
  if (!alias || alias.includes("@")) return null;
  return hosts.find((host) => host.alias === alias) ?? null;
}

function hostHasWhitespace(host: string): boolean {
  return /\s/.test(host);
}

export function clampHostIndex(index: number, length: number): number {
  if (length === 0) return -1;
  if (index < 0) return 0;
  if (index >= length) return length - 1;
  return index;
}

export function sshHostOptionId(host: SshConfigHost | undefined, index: number): string {
  return `add-workspace-new-conn-host-options-${host?.alias.replace(/[^A-Za-z0-9_-]/g, "_") ?? "item"}-${index}`;
}

export function formatSshHostSummary(host: SshConfigHost): string {
  const destination = host.host ?? host.alias;
  const userPrefix = host.user ? `${host.user}@` : "";
  const portSuffix = host.port ? `:${host.port}` : "";
  return `${userPrefix}${destination}${portSuffix}`;
}

export function formatProfileSubtitle(profile: {
  user?: string | null;
  host: string;
  port?: number | null;
}): string {
  const userPrefix = profile.user ? `${profile.user}@` : "";
  const portSuffix = profile.port !== 22 ? `:${profile.port}` : "";
  return `${userPrefix}${profile.host}${portSuffix}`;
}

export function folderName(absPath: string): string {
  const clean = absPath.replace(/[\\/]+$/, "");
  const idx = Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\"));
  return idx >= 0 ? clean.slice(idx + 1) : clean;
}

export function formatSshSecondaryLine(params: { user?: string | null; host: string }): string {
  return params.user ? `${params.user}@${params.host}` : params.host;
}

export function formatSshTooltip(params: {
  user?: string | null;
  host: string;
  port?: number | null;
  remotePath: string;
}): string {
  const { user, host, port, remotePath } = params;
  const userPrefix = user ? `${user}@` : "";
  const resolvedPort = port ?? 22;
  return `${userPrefix}${host}:${resolvedPort}  ${remotePath}`;
}

export function formatRemotePath(params: {
  user?: string | null;
  host: string;
  port?: number | null;
  remotePath: string;
  maxHostChars?: number;
}): { display: string; full: string } {
  const { user, host, port, remotePath, maxHostChars = 24 } = params;

  const userPrefix = user ? `${user}@` : "";
  const portInfix = port && port !== 22 ? `:${port}` : "";
  const full = `${userPrefix}${host}${portInfix}:${remotePath}`;

  const truncatedHost = middleTruncate(host, maxHostChars);
  const display = `${userPrefix}${truncatedHost}${portInfix}:${remotePath}`;

  return { display, full };
}

function middleTruncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  const keep = Math.max(4, Math.floor((maxLen - 1) / 2));
  return `${str.slice(0, keep)}…${str.slice(-keep)}`;
}

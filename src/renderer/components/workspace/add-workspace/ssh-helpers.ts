// ---------------------------------------------------------------------------
// Pure SSH utility functions — exported for unit tests.
// ---------------------------------------------------------------------------

import type { SshConfigHost } from "./types";

export function parseSshDestination(input: string): { host: string; user?: string } | null {
  const value = input.trim();
  if (!value) return null;
  const atIndex = value.lastIndexOf("@");
  if (atIndex > 0 && atIndex < value.length - 1) {
    const user = value.slice(0, atIndex).trim();
    const host = value.slice(atIndex + 1).trim();
    if (!host || hostHasWhitespace(host) || user.length === 0) return null;
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

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// SSH error humanisation
// ---------------------------------------------------------------------------

/**
 * Maps raw IPC error messages (which embed SshErrorCode strings) to
 * human-readable cause + recovery sentences.
 * raw error.message is never surfaced directly in UI.
 */
export function humanizeSshError(error: unknown): string {
  if (!(error instanceof Error)) {
    return "Something went wrong. Please try again.";
  }
  const msg = error.message;
  if (msg.includes("ssh.connect-failed")) {
    return "Couldn't connect to the host. Check the address and your network, then retry.";
  }
  if (msg.includes("ssh.auth-failed")) {
    return "Authentication failed. Verify your credentials or identity file and try again.";
  }
  if (msg.includes("ssh.session-expired")) {
    return "The SSH session has expired. Go back and reconnect.";
  }
  if (msg.includes("server.spawn-failed")) {
    return "The remote agent couldn't start. Ensure the host is reachable and you have shell access.";
  }
  if (msg.includes("server.protocol-version-mismatch")) {
    return "Remote agent version is incompatible. Update Nexus on the remote host.";
  }
  if (msg.includes("server.protocol-error")) {
    return "A protocol error occurred with the remote agent. Try reconnecting.";
  }
  if (msg.includes("transport.unknown") || msg.includes("ssh.unknown")) {
    return "An unknown SSH error occurred. Check connectivity and retry.";
  }
  // Fallback — intentionally generic, no raw message leak
  return "Connection failed. Check your settings and try again.";
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** Returns the last path segment (folder name) from an absolute path. */
export function folderName(absPath: string): string {
  const clean = absPath.replace(/[\\/]+$/, "");
  const idx = Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\"));
  return idx >= 0 ? clean.slice(idx + 1) : clean;
}

/**
 * Formats an SSH remote bookmark's second display line: `user@host:/path`
 * - Port 22 is omitted; non-22 port appended as `user@host:PORT:/path`
 * - Host is middle-truncated in JS when longer than maxHostChars (CSS middle-truncation
 *   is not supported; JS truncation preserves the tail for recognition).
 * - Full untruncated string is also returned as `full` for the title tooltip.
 */
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

  // Middle-truncate host if necessary
  const truncatedHost = middleTruncate(host, maxHostChars);
  const display = `${userPrefix}${truncatedHost}${portInfix}:${remotePath}`;

  return { display, full };
}

/**
 * Middle-truncates a string: keeps leading and trailing chars, replaces middle with `…`.
 * Used for long hostnames where the tail (TLD / IP suffix) matters for recognition.
 */
function middleTruncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  const keep = Math.max(4, Math.floor((maxLen - 1) / 2));
  return `${str.slice(0, keep)}…${str.slice(-keep)}`;
}

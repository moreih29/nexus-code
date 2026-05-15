/**
 * Shared remote URL validation for main-process preflight and renderer inline
 * forms. This intentionally checks only accepted local patterns and never
 * probes the network.
 */

const REMOTE_URL_PREFIXES = ["https://", "git@", "ssh://", "file://"] as const;

/**
 * Returns true when a remote URL starts with one of the accepted Git remote
 * forms used by the Source Control remote-management dialog.
 */
export function isAllowedGitRemoteUrl(value: string): boolean {
  const trimmed = value.trim();
  const lower = trimmed.toLowerCase();
  return REMOTE_URL_PREFIXES.some((prefix) =>
    prefix === "git@" ? trimmed.startsWith(prefix) : lower.startsWith(prefix),
  );
}

/**
 * Produces the inline validation message for the Add Remote form, or null when
 * the provided value is accepted.
 */
export function validateGitRemoteUrl(value: string): string | null {
  if (value.trim().length === 0) return "Remote URL is required.";
  if (isAllowedGitRemoteUrl(value)) return null;
  return "Use https://, git@, ssh://, or file://.";
}

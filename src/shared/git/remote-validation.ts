const REMOTE_URL_PREFIXES = ["https://", "git@", "ssh://", "file://"] as const;

export function isAllowedGitRemoteUrl(value: string): boolean {
  const trimmed = value.trim();
  const lower = trimmed.toLowerCase();
  return REMOTE_URL_PREFIXES.some((prefix) =>
    prefix === "git@" ? trimmed.startsWith(prefix) : lower.startsWith(prefix),
  );
}

export function validateGitRemoteUrl(value: string): string | null {
  if (value.trim().length === 0) return "Remote URL is required.";
  if (isAllowedGitRemoteUrl(value)) return null;
  return "Use https://, git@, ssh://, or file://.";
}

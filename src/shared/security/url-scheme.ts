export const EXTERNAL_SCHEME_ALLOWLIST = ["http:", "https:", "mailto:"] as const;

export function isExternalSchemeAllowed(rawUrl: string): boolean {
  if (!rawUrl) return false;

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }

  return (EXTERNAL_SCHEME_ALLOWLIST as readonly string[]).includes(parsed.protocol);
}

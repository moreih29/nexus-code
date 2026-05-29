/**
 * Pure name-validation rules used by the inline-create row.
 *
 * Returns null on valid, error message on invalid. UI shows the message
 * inline / disables commit.
 *
 * VSCode parity (fileActions.ts `validateFileName`):
 *   - leading "/" or "\" → rejected (absolute path).
 *   - the name is split on /[\\/]/ into segments; each segment is then
 *     validated individually. This is what makes `src/components/foo.ts`
 *     work as a single inline-create input — the IPC layer recursively
 *     creates intermediate directories.
 *   - A single trailing slash is tolerated (VSCode uses it as a folder
 *     hint); empty interior segments ("a//b") and reserved names (".",
 *     "..") inside any segment are rejected.
 */

const FORBIDDEN_NAMES = new Set([".", ".."]);

export function validateNewEntryName(
  name: string,
  t?: (key: string) => string,
): string | null {
  const msg = (key: string, fallback: string) => (t ? t(`fileTree.validation.${key}`) : fallback);
  if (name.trim().length === 0) return msg("cannotBeEmpty", "Name cannot be empty.");
  if (name.startsWith("/") || name.startsWith("\\")) {
    return msg("cannotStartWithSlash", "Name cannot start with a slash.");
  }
  if (name.includes("\0")) return msg("cannotContainNul", "Name cannot contain NUL.");

  // Split on both separators so a pasted Windows-style path is recognised
  // (mirrors VSCode's `name.split(/[\\/]/)`). Drop a single trailing empty
  // segment ("foo/" → ["foo", ""] → ["foo"]); leave anything else for the
  // segment check below to reject as an empty interior segment.
  const segments = name.split(/[\\/]/);
  if (segments.length > 1 && segments[segments.length - 1] === "") {
    segments.pop();
  }
  for (const seg of segments) {
    if (seg.length === 0) return msg("segmentsCannotBeEmpty", "Path segments cannot be empty.");
    if (FORBIDDEN_NAMES.has(seg)) return msg("reservedName", "Reserved name.");
  }
  return null;
}

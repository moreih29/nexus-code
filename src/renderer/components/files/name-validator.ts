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
 *   - On a Windows file system each segment also follows Windows' naming
 *     rules (`isValidBasename` in VSCode's extpath.ts).
 */

const FORBIDDEN_NAMES = new Set([".", ".."]);

// Windows refuses these characters in a name, and reads "a:b" as stream b of
// file a: creating it would make an empty "a".
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it matches
const WINDOWS_FORBIDDEN_CHARS = /[<>:"|?*\x01-\x1f]/;

// Device names, with or without an extension. "con" becomes a file most
// Windows programs cannot open or delete, and Windows 10 reads "nul.txt" as
// the NUL device.
const WINDOWS_DEVICE_NAMES = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

export interface NameRules {
  /** Whether the entry is on a Windows file system. */
  windows?: boolean;
}

export function validateNewEntryName(
  name: string,
  t?: (key: string) => string,
  rules: NameRules = {},
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
    if (rules.windows) {
      const error = windowsNameError(seg);
      if (error) return msg(error.key, error.fallback);
    }
  }
  return null;
}

/** Why Windows cannot name an entry `seg`, or null when it can. */
function windowsNameError(seg: string): { key: string; fallback: string } | null {
  if (WINDOWS_FORBIDDEN_CHARS.test(seg)) {
    return { key: "invalidCharacters", fallback: 'Name cannot contain : * ? " < > |' };
  }
  if (WINDOWS_DEVICE_NAMES.test(seg)) {
    return { key: "reservedOnWindows", fallback: "This name is reserved on Windows." };
  }
  // Windows drops a trailing dot or space, so "foo." would be created as "foo".
  if (/[. ]$/.test(seg)) {
    return { key: "cannotEndWithDotOrSpace", fallback: "Name cannot end with a dot or a space." };
  }
  return null;
}

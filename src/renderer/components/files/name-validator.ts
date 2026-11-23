const FORBIDDEN_NAMES = new Set([".", ".."]);

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it matches
const WINDOWS_FORBIDDEN_CHARS = /[<>:"|?*\x01-\x1f]/;

const WINDOWS_DEVICE_NAMES = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

export interface NameRules {
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

function windowsNameError(seg: string): { key: string; fallback: string } | null {
  if (WINDOWS_FORBIDDEN_CHARS.test(seg)) {
    return { key: "invalidCharacters", fallback: 'Name cannot contain : * ? " < > |' };
  }
  if (WINDOWS_DEVICE_NAMES.test(seg)) {
    return { key: "reservedOnWindows", fallback: "This name is reserved on Windows." };
  }
  if (/[. ]$/.test(seg)) {
    return { key: "cannotEndWithDotOrSpace", fallback: "Name cannot end with a dot or a space." };
  }
  return null;
}

/**
 * Pure name-validation rules used by the inline-create row.
 *
 * Returns null on valid, error message on invalid. UI shows the
 * message inline / disables commit. macOS-leaning: forbid `/` and NUL,
 * accept everything else (including dotfiles).
 */

const FORBIDDEN_NAMES = new Set([".", ".."]);

export function validateNewEntryName(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) return "Name cannot be empty.";
  if (FORBIDDEN_NAMES.has(trimmed)) return "Reserved name.";
  if (trimmed.includes("/")) return "Name cannot contain '/'.";
  if (trimmed.includes("\\")) return "Name cannot contain '\\'.";
  if (trimmed.includes("\0")) return "Name cannot contain NUL.";
  return null;
}

export const MAX_READABLE_FILE_SIZE = 5 * 1024 * 1024;
export const BINARY_DETECTION_BYTES = 512;

export const HIDDEN_NAMES: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  "dist",
  "out",
  ".DS_Store",
  ".next",
  ".turbo",
  ".cache",
  ".vscode-test",
]);

export function isHiddenName(name: string): boolean {
  return HIDDEN_NAMES.has(name);
}

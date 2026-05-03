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

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

/** Maximum file size considered for text search — mirrors the read limit so search never reads more than the editor would. */
export const MAX_SEARCHABLE_FILE_SIZE = MAX_READABLE_FILE_SIZE;

/** Default glob patterns excluded from text search only; does not affect the file tree. */
export const SEARCH_DEFAULT_EXCLUDES: readonly string[] = [
  "*.lock",
  "*-lock.json",
  "*.lockb",
  "bun.lock",
  "*.min.js",
  "*.min.css",
  "*.map",
  "build/",
  "coverage/",
  "target/",
] as const;

/**
 * Go·TS dual helper — runtime directory paths under ~/.nexus-code.
 *
 * This module is the TypeScript counterpart of internal/agentpaths/paths.go.
 * Both modules are authoritative over the same directory layout so that, on
 * the same system with the same HOME, both produce identical absolute paths.
 * Callers must not hard-code these paths independently.
 *
 * Directory layout:
 *   ~/.nexus-code/          ← root()
 *   ~/.nexus-code/bin/      ← binDir()
 *   ~/.nexus-code/sockets/  ← socketsDir()
 *
 * Windows is not supported — the project only targets macOS and Linux.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const ROOT_DIR_NAME = ".nexus-code";

/**
 * Returns the absolute path of the ~/.nexus-code runtime directory.
 * Throws if os.homedir() returns an empty string (rare in some CI environments).
 */
export function root(): string {
  const home = os.homedir();
  if (!home) {
    throw new Error("agentpaths: cannot determine home directory (os.homedir() returned empty)");
  }
  return path.join(home, ROOT_DIR_NAME);
}

/**
 * Returns the absolute path of ~/.nexus-code/bin, the directory where
 * agent-managed executables (e.g. wrapper scripts) are installed at runtime.
 */
export function binDir(): string {
  return path.join(root(), "bin");
}

/**
 * Returns the absolute path of ~/.nexus-code/sockets, the directory where
 * Unix domain socket files (e.g. the hook server socket) are placed.
 */
export function socketsDir(): string {
  return path.join(root(), "sockets");
}

/**
 * Creates dirPath and any necessary parents with permission 0o700.
 * Idempotent — if dirPath already exists as a directory the call resolves
 * without error.
 */
export async function ensureDir(dirPath: string): Promise<void> {
  try {
    await fs.mkdir(dirPath, { recursive: true, mode: 0o700 });
  } catch (err) {
    throw new Error(
      `agentpaths: cannot create directory "${dirPath}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

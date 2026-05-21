/**
 * Go·TS dual helper — runtime directory paths under ~/.nexus-code.
 *
 * This module is the TypeScript counterpart of internal/agentpaths/paths.go.
 * Both modules are authoritative over the same directory layout so that, on
 * the same system with the same HOME, both produce identical absolute paths.
 * Callers must not hard-code these paths independently.
 *
 * Directory layout:
 *   ~/.nexus-code/                       ← root()
 *   ~/.nexus-code/bin/                   ← binDir()
 *   ~/.nexus-code/sockets/               ← socketsDir()
 *   ~/.nexus-code/shim/<workspaceId>/    ← shimDir(workspaceId)
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

/**
 * Returns the absolute path of ~/.nexus-code/shim/<workspaceId>, the
 * per-workspace directory that holds PTY shim rc files (.zshrc, .zshenv,
 * bashrc). Pure path computation — no fs operations performed.
 */
export function shimDir(workspaceId: string): string {
  return path.join(root(), "shim", workspaceId);
}

// ---------------------------------------------------------------------------
// Shim file content templates
// ---------------------------------------------------------------------------

/** zsh .zshrc shim: sources the user's original .zshrc and registers a
 * precmd hook to keep NEXUS_WRAPPER_SELF_DIR at the front of PATH. */
const ZSHRC_CONTENT = `# Nexus PTY shim — sourced via ZDOTDIR at PTY spawn time.
if [ -n "\${NEXUS_USER_ZDOTDIR-}" ] && [ -f "$NEXUS_USER_ZDOTDIR/.zshrc" ]; then
  source "$NEXUS_USER_ZDOTDIR/.zshrc"
elif [ -f "$HOME/.zshrc" ]; then
  source "$HOME/.zshrc"
fi

_nexus_prepend_wrapper() {
  [ -z "\${NEXUS_WRAPPER_SELF_DIR-}" ] && return
  case ":\$PATH:" in
    ":\$NEXUS_WRAPPER_SELF_DIR:"*) ;;
    *) PATH="\$NEXUS_WRAPPER_SELF_DIR:\${PATH//:\$NEXUS_WRAPPER_SELF_DIR:/:}" ;;
  esac
}
autoload -Uz add-zsh-hook 2>/dev/null && add-zsh-hook precmd _nexus_prepend_wrapper
_nexus_prepend_wrapper
`;

/** zsh .zshenv shim: sources the user's original .zshenv, loaded by zsh
 * before any other startup file. */
const ZSHENV_CONTENT = `# Nexus PTY shim — sourced via ZDOTDIR at PTY spawn time.
if [ -n "\${NEXUS_USER_ZDOTDIR-}" ] && [ -f "$NEXUS_USER_ZDOTDIR/.zshenv" ]; then
  source "$NEXUS_USER_ZDOTDIR/.zshenv"
elif [ -f "$HOME/.zshenv" ]; then
  source "$HOME/.zshenv"
fi
`;

/** bash bashrc shim: sources the user's original .bashrc and registers a
 * PROMPT_COMMAND entry to keep NEXUS_WRAPPER_SELF_DIR at the front of PATH. */
const BASHRC_CONTENT = `# Nexus PTY shim — passed via --rcfile at PTY spawn time.
if [ -f "$HOME/.bashrc" ]; then
  source "$HOME/.bashrc"
fi

_nexus_prepend_wrapper() {
  [ -z "\${NEXUS_WRAPPER_SELF_DIR-}" ] && return
  case ":\$PATH:" in
    ":\$NEXUS_WRAPPER_SELF_DIR:"*) ;;
    *) PATH="\$NEXUS_WRAPPER_SELF_DIR:\${PATH//:\$NEXUS_WRAPPER_SELF_DIR:/:}" ;;
  esac
}
PROMPT_COMMAND="_nexus_prepend_wrapper\${PROMPT_COMMAND:+; \$PROMPT_COMMAND}"
_nexus_prepend_wrapper
`;

/**
 * Writes the three PTY shim rc files (.zshrc, .zshenv, bashrc) into the
 * workspace-specific shim directory. The directory is created with 0o700 and
 * each file is written with 0o644. Idempotent — safe to call multiple times.
 *
 * Returns an object with the absolute path of the shim directory and each
 * generated file.
 */
export async function writeShimFiles(workspaceId: string): Promise<{
  dir: string;
  zshrc: string;
  zshenv: string;
  bashrc: string;
}> {
  const dir = shimDir(workspaceId);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });

  const zshrc = path.join(dir, ".zshrc");
  const zshenv = path.join(dir, ".zshenv");
  const bashrc = path.join(dir, "bashrc");

  await Promise.all([
    fs.writeFile(zshrc, ZSHRC_CONTENT, { mode: 0o644 }),
    fs.writeFile(zshenv, ZSHENV_CONTENT, { mode: 0o644 }),
    fs.writeFile(bashrc, BASHRC_CONTENT, { mode: 0o644 }),
  ]);

  return { dir, zshrc, zshenv, bashrc };
}

/**
 * Removes the workspace-specific shim directory and all its contents.
 * Idempotent — resolves without error if the directory does not exist.
 */
export async function removeShimDir(workspaceId: string): Promise<void> {
  await fs.rm(shimDir(workspaceId), { recursive: true, force: true });
}

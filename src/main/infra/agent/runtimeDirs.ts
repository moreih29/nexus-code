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
 * On Windows, ~ is the user profile folder (USERPROFILE), for both modules.
 * NEXUS_CODE_HOME names another root in place of ~/.nexus-code, for both.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const ROOT_DIR_NAME = ".nexus-code";

/**
 * Names a runtime directory in place of ~/.nexus-code: a copy of the app
 * run beside the installed one, as a build under test, keeps its files and
 * the installed app's apart. The agent and the terminals' wrappers read it
 * too. Keep it short: the agents' sockets are under it.
 */
export const HOME_ENV = "NEXUS_CODE_HOME";

/**
 * Returns the absolute path of the ~/.nexus-code runtime directory, or of
 * the one NEXUS_CODE_HOME names.
 * Throws if os.homedir() returns an empty string (rare in some CI environments).
 */
export function root(): string {
  const named = process.env[HOME_ENV];
  if (named) return path.resolve(named);
  const home = os.homedir();
  if (!home) {
    throw new Error("agentpaths: cannot determine home directory (os.homedir() returned empty)");
  }
  return path.join(home, ROOT_DIR_NAME);
}

/**
 * Returns the absolute path of ~/.nexus-code/worktrees, where tasks' git
 * worktrees live.
 */
export function worktreesDir(): string {
  return path.join(root(), "worktrees");
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
//
// These constants are exported so that callers running on hosts other than
// the local machine (notably the SSH bootstrap, which uploads the same shim
// files to the remote `~/.nexus-code/shim/<workspaceId>/`) can write the
// exact same content without duplicating the templates.
//
// The shim is shell-rooted (zsh / bash) and references the runtime env
// variables `NEXUS_USER_ZDOTDIR` / `NEXUS_WRAPPER_SELF_DIR` so the same file
// works regardless of which workspace or which host it ends up on.
// ---------------------------------------------------------------------------

/** zsh .zshrc shim: sources the user's original .zshrc and registers a
 * precmd hook to keep NEXUS_WRAPPER_SELF_DIR at the front of PATH. */
export const ZSHRC_CONTENT = `# Nexus PTY shim — sourced via ZDOTDIR at PTY spawn time.
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

/** sh that puts the directory `variable` names first on PATH, if it names one. */
function prependDir(variable: string): string {
  return `if [ -n "\${${variable}-}" ]; then
  case ":\$PATH:" in
    ":\$${variable}:"*) ;;
    *) PATH="\$${variable}:\${PATH//:\$${variable}:/:}" ;;
  esac
fi
`;
}

/**
 * Puts NEXUS_WRAPPER_SELF_DIR back first on the PATH, which a startup file
 * may have reset: a shell that shows no prompt (the commands a Codex tab
 * runs) has no precmd hook to do it.
 */
const PREPEND_WRAPPER = prependDir("NEXUS_WRAPPER_SELF_DIR");

/** zsh .zshenv shim: sources the user's original .zshenv, loaded by zsh
 * before any other startup file, and the only one `zsh -c` reads. */
export const ZSHENV_CONTENT = `# Nexus PTY shim — sourced via ZDOTDIR at PTY spawn time.
if [ -n "\${NEXUS_USER_ZDOTDIR-}" ] && [ -f "$NEXUS_USER_ZDOTDIR/.zshenv" ]; then
  source "$NEXUS_USER_ZDOTDIR/.zshenv"
elif [ -f "$HOME/.zshenv" ]; then
  source "$HOME/.zshenv"
fi
${PREPEND_WRAPPER}`;

/** A zsh login-file shim (.zprofile, .zlogin, .zlogout): sources the user's
 * own copy, which ZDOTDIR pointing at the shim directory would otherwise hide
 * from a login zsh (a shell added in Settings with `-l`). */
function zshLoginShim(name: string): string {
  return `# Nexus PTY shim — sourced via ZDOTDIR at PTY spawn time.
if [ -n "\${NEXUS_USER_ZDOTDIR-}" ] && [ -f "$NEXUS_USER_ZDOTDIR/${name}" ]; then
  source "$NEXUS_USER_ZDOTDIR/${name}"
elif [ -f "$HOME/${name}" ]; then
  source "$HOME/${name}"
fi
`;
}

export const ZPROFILE_CONTENT = zshLoginShim(".zprofile");
/** The last file a login zsh reads, after the profile that may reset the PATH. */
export const ZLOGIN_CONTENT = zshLoginShim(".zlogin") + PREPEND_WRAPPER;
export const ZLOGOUT_CONTENT = zshLoginShim(".zlogout");

/** bash bashrc shim: sources the user's original .bashrc and registers a
 * PROMPT_COMMAND entry to keep NEXUS_WRAPPER_SELF_DIR at the front of PATH. */
export const BASHRC_CONTENT = `# Nexus PTY shim — passed via --rcfile at PTY spawn time.
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
 * bash BASH_ENV shim, for a Codex tab's `codex app-server` and a Windows
 * Claude tab's `claude`: bash reads it as it runs each command (`bash -c`),
 * and after a login shell's profile, which may have reset the PATH. On
 * Windows, NEXUS_BASH_WRAPPER_DIR is the wrappers' directory as Git Bash
 * names it, and NEXUS_WRAPPER_SELF_DIR the Windows path of the nexus
 * launchers, which would make no directory of the PATH bash reads.
 */
export const BASHENV_CONTENT = `# Nexus shim — the BASH_ENV of a Codex tab's commands, and of a Windows Claude tab's Bash tool.
_nexus_dir=\${NEXUS_BASH_WRAPPER_DIR:-\${NEXUS_WRAPPER_SELF_DIR-}}
${prependDir("_nexus_dir")}unset _nexus_dir
`;

/**
 * Writes the PTY shim rc files (.zshrc, .zshenv, bashrc, and the zsh login
 * files), and a Codex tab's bashenv, into the workspace-specific shim directory. The directory is created
 * with 0o700 and each file is written with 0o644. Idempotent — safe to call
 * multiple times.
 *
 * Returns an object with the absolute path of the shim directory and each
 * rc file a shell starts with.
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
    fs.writeFile(path.join(dir, ".zprofile"), ZPROFILE_CONTENT, { mode: 0o644 }),
    fs.writeFile(path.join(dir, ".zlogin"), ZLOGIN_CONTENT, { mode: 0o644 }),
    fs.writeFile(path.join(dir, ".zlogout"), ZLOGOUT_CONTENT, { mode: 0o644 }),
    fs.writeFile(path.join(dir, "bashenv"), BASHENV_CONTENT, { mode: 0o644 }),
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

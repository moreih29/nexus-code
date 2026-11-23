import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const ROOT_DIR_NAME = ".nexus-code";

export const HOME_ENV = "NEXUS_CODE_HOME";

export function root(): string {
  const named = process.env[HOME_ENV];
  if (named) return path.resolve(named);
  const home = os.homedir();
  if (!home) {
    throw new Error("agentpaths: cannot determine home directory (os.homedir() returned empty)");
  }
  return path.join(home, ROOT_DIR_NAME);
}

export function worktreesDir(): string {
  return path.join(root(), "worktrees");
}

export function binDir(): string {
  return path.join(root(), "bin");
}

export function socketsDir(): string {
  return path.join(root(), "sockets");
}

export async function ensureDir(dirPath: string): Promise<void> {
  try {
    await fs.mkdir(dirPath, { recursive: true, mode: 0o700 });
  } catch (err) {
    throw new Error(
      `agentpaths: cannot create directory "${dirPath}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export function shimDir(workspaceId: string): string {
  return path.join(root(), "shim", workspaceId);
}

export const ZSHRC_CONTENT = `# Nexus PTY shim — sourced via ZDOTDIR at PTY spawn time.
if [ -n "\${NEXUS_USER_ZDOTDIR-}" ] && [ -f "$NEXUS_USER_ZDOTDIR/.zshrc" ]; then
  source "$NEXUS_USER_ZDOTDIR/.zshrc"
elif [ -f "$HOME/.zshrc" ]; then
  source "$HOME/.zshrc"
fi

_nexus_prepend_wrapper() {
  [ -z "\${NEXUS_WRAPPER_SELF_DIR-}" ] && return
  case ":$PATH:" in
    ":$NEXUS_WRAPPER_SELF_DIR:"*) ;;
    *) PATH="$NEXUS_WRAPPER_SELF_DIR:\${PATH//:$NEXUS_WRAPPER_SELF_DIR:/:}" ;;
  esac
}
autoload -Uz add-zsh-hook 2>/dev/null && add-zsh-hook precmd _nexus_prepend_wrapper
_nexus_prepend_wrapper
`;

function prependDir(variable: string): string {
  return `if [ -n "\${${variable}-}" ]; then
  case ":$PATH:" in
    ":$${variable}:"*) ;;
    *) PATH="$${variable}:\${PATH//:$${variable}:/:}" ;;
  esac
fi
`;
}

const PREPEND_WRAPPER = prependDir("NEXUS_WRAPPER_SELF_DIR");

export const ZSHENV_CONTENT = `# Nexus PTY shim — sourced via ZDOTDIR at PTY spawn time.
if [ -n "\${NEXUS_USER_ZDOTDIR-}" ] && [ -f "$NEXUS_USER_ZDOTDIR/.zshenv" ]; then
  source "$NEXUS_USER_ZDOTDIR/.zshenv"
elif [ -f "$HOME/.zshenv" ]; then
  source "$HOME/.zshenv"
fi
${PREPEND_WRAPPER}`;

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
export const ZLOGIN_CONTENT = zshLoginShim(".zlogin") + PREPEND_WRAPPER;
export const ZLOGOUT_CONTENT = zshLoginShim(".zlogout");

export const BASHRC_CONTENT = `# Nexus PTY shim — passed via --rcfile at PTY spawn time.
if [ -f "$HOME/.bashrc" ]; then
  source "$HOME/.bashrc"
fi

_nexus_prepend_wrapper() {
  [ -z "\${NEXUS_WRAPPER_SELF_DIR-}" ] && return
  case ":$PATH:" in
    ":$NEXUS_WRAPPER_SELF_DIR:"*) ;;
    *) PATH="$NEXUS_WRAPPER_SELF_DIR:\${PATH//:$NEXUS_WRAPPER_SELF_DIR:/:}" ;;
  esac
}
PROMPT_COMMAND="_nexus_prepend_wrapper\${PROMPT_COMMAND:+; $PROMPT_COMMAND}"
_nexus_prepend_wrapper
`;

export const BASHENV_CONTENT = `# Nexus shim — the BASH_ENV of a Codex tab's commands, and of a Windows Claude tab's Bash tool.
_nexus_dir=\${NEXUS_BASH_WRAPPER_DIR:-\${NEXUS_WRAPPER_SELF_DIR-}}
${prependDir("_nexus_dir")}unset _nexus_dir
`;

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

export async function removeShimDir(workspaceId: string): Promise<void> {
  await fs.rm(shimDir(workspaceId), { recursive: true, force: true });
}

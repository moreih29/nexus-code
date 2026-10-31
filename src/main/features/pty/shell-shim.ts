/**
 * shell-shim.ts — pure-function helper that computes the env/args mutations
 * needed to activate the per-workspace PTY shim before the shell processes
 * any user startup file.
 *
 * zsh  → ZDOTDIR is redirected to shimDir so the shim .zshrc/.zshenv are
 *         sourced first; the shim then delegates to the user's originals.
 * bash → --rcfile <shimDir>/bashrc is prepended to argv so bash reads the
 *         shim bashrc before its default ~/.bashrc.
 * other → input returned unchanged (no-op).
 *
 * This module has no fs I/O — all file writing is done by runtimeDirs.ts.
 */

import { posix as path } from "node:path";

// zsh and bash take POSIX paths, on an SSH host as on a local Mac or Linux
// machine, and this app may itself run on Windows.

export interface ShellShimInput {
  /** Absolute path or bare basename of the shell binary (e.g. "/bin/zsh", "zsh-5.9"). */
  shell?: string;
  /** Current env record that will be forwarded to the child process. */
  env: Record<string, string>;
  /** Existing spawn argv (shell arguments). */
  args?: string[];
  /** Absolute path of the workspace-specific shim directory (runtimeDirs.shimDir result). */
  shimDir: string;
}

export interface ShellShimOutput {
  env: Record<string, string>;
  args?: string[];
}

/**
 * Returns mutated env/args that activate the shell shim for the detected shell.
 * Does not modify the input objects.
 */
export function applyShellPathShim(input: ShellShimInput): ShellShimOutput {
  const { env, args, shimDir } = input;

  const shellBase = resolveShellBasename(input.shell, env.SHELL);
  if (shellBase === null) {
    // No shell info — no-op.
    return { env, args };
  }

  if (shellBase.startsWith("zsh")) {
    // zsh: redirect ZDOTDIR to shimDir; preserve the user's original value.
    const newEnv: Record<string, string> = {
      ...env,
      NEXUS_USER_ZDOTDIR: env.ZDOTDIR ?? "",
      ZDOTDIR: shimDir,
    };
    return { env: newEnv, args };
  }

  if (shellBase.startsWith("bash")) {
    // bash: --rcfile <shimDir>/bashrc -i, after the shell's own long options
    // (`--login`, `--noprofile`): bash rejects a long option that follows a
    // single-letter one.
    const rcfilePath = path.join(shimDir, "bashrc");
    const shimArgs = ["--rcfile", rcfilePath, "-i"];
    if (args === undefined) return { env, args: shimArgs };
    // A shell the user gave its own rc file keeps it; the agent's PATH entry
    // then just isn't re-prepended at each prompt.
    if (args.includes("--rcfile") || args.includes("--init-file")) return { env, args };
    const longCount = leadingLongOptions(args);
    const newArgs = [...args.slice(0, longCount), ...shimArgs, ...args.slice(longCount)];
    return { env, args: newArgs };
  }

  // Unsupported shell — pass through unchanged.
  return { env, args };
}

/** How many of `args` are bash long options at the front; `--` ends the options. */
function leadingLongOptions(args: readonly string[]): number {
  const end = args.findIndex((arg) => !arg.startsWith("--") || arg === "--");
  return end === -1 ? args.length : end;
}

/**
 * Extracts the basename from a full shell path or bare name, falling back to
 * env.SHELL when `shell` is not provided.  Returns null when neither is set.
 */
function resolveShellBasename(
  shell: string | undefined,
  envShell: string | undefined,
): string | null {
  const resolved = shell ?? envShell;
  if (!resolved) return null;
  return path.basename(resolved);
}

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

import path from "node:path";

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
    // bash: prepend --rcfile <shimDir>/bashrc -i to argv.
    const rcfilePath = path.join(shimDir, "bashrc");
    const shimArgs = ["--rcfile", rcfilePath, "-i"];
    const newArgs = args !== undefined ? [...shimArgs, ...args] : shimArgs;
    return { env, args: newArgs };
  }

  // Unsupported shell — pass through unchanged.
  return { env, args };
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

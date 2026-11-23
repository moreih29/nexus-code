import { posix as path } from "node:path";

export interface ShellShimInput {
  shell?: string;
  env: Record<string, string>;
  args?: string[];
  shimDir: string;
}

export interface ShellShimOutput {
  env: Record<string, string>;
  args?: string[];
}

export function applyShellPathShim(input: ShellShimInput): ShellShimOutput {
  const { env, args, shimDir } = input;

  const shellBase = resolveShellBasename(input.shell, env.SHELL);
  if (shellBase === null) {
    return { env, args };
  }

  if (shellBase.startsWith("zsh")) {
    const newEnv: Record<string, string> = {
      ...env,
      NEXUS_USER_ZDOTDIR: env.ZDOTDIR ?? "",
      ZDOTDIR: shimDir,
    };
    return { env: newEnv, args };
  }

  if (shellBase.startsWith("bash")) {
    const rcfilePath = path.join(shimDir, "bashrc");
    const shimArgs = ["--rcfile", rcfilePath, "-i"];
    if (args === undefined) return { env, args: shimArgs };
    if (args.includes("--rcfile") || args.includes("--init-file")) return { env, args };
    const longCount = leadingLongOptions(args);
    const newArgs = [...args.slice(0, longCount), ...shimArgs, ...args.slice(longCount)];
    return { env, args: newArgs };
  }

  return { env, args };
}

function leadingLongOptions(args: readonly string[]): number {
  const end = args.findIndex((arg) => !arg.startsWith("--") || arg === "--");
  return end === -1 ? args.length : end;
}

function resolveShellBasename(
  shell: string | undefined,
  envShell: string | undefined,
): string | null {
  const resolved = shell ?? envShell;
  if (!resolved) return null;
  return path.basename(resolved);
}

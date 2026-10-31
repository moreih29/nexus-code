import { z } from "zod";

/**
 * A shell the user added in Settings › Terminal: a name, a program (a path,
 * or a name looked up on PATH) and the arguments it starts with.
 */
export const CustomShellSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(128),
  path: z.string().min(1).max(1024),
  args: z.array(z.string().max(1024)).max(64),
});
export type CustomShell = z.infer<typeof CustomShellSchema>;

/**
 * The shell a terminal runs: one the app found on this machine, or one the
 * user added (the id of a `CustomShell`). Detected ids are stable per
 * machine: "powershell", "pwsh", "cmd", "git-bash" and "nu" on Windows, the
 * shell's path elsewhere.
 */
export const ShellChoiceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("detected"), id: z.string().min(1).max(1024) }),
  z.object({ kind: z.literal("custom"), id: z.string().min(1).max(64) }),
]);
export type ShellChoice = z.infer<typeof ShellChoiceSchema>;

/** Whether two choices pick the same shell. */
export function sameShellChoice(a: ShellChoice | undefined, b: ShellChoice | undefined): boolean {
  return a !== undefined && b !== undefined && a.kind === b.kind && a.id === b.id;
}

/** A shell found on this machine. */
export const ShellInfoSchema = z.object({
  id: z.string(),
  /** Display name, e.g. "Git Bash" or "zsh". */
  name: z.string(),
  path: z.string(),
  /** Arguments the shell starts with, e.g. Git Bash's `--login -i`. */
  args: z.array(z.string()),
});
export type ShellInfo = z.infer<typeof ShellInfoSchema>;

/**
 * Splits an arguments field the way a shell would: on whitespace, except
 * inside double quotes, which may sit anywhere in an argument
 * (`--init-file="/a b/rc"`). No escapes; good enough for flags like `-l` or
 * `-NoLogo -ExecutionPolicy Bypass`.
 */
export function splitShellArgs(text: string): string[] {
  const args: string[] = [];
  for (const match of text.matchAll(/(?:"[^"]*(?:"|$)|[^\s"]+)+/g)) {
    args.push(match[0].replaceAll('"', ""));
  }
  return args;
}

/** The inverse of `splitShellArgs`, for showing stored arguments in the field. */
export function joinShellArgs(args: readonly string[]): string {
  return args.map((arg) => (/\s/.test(arg) || arg === "" ? `"${arg}"` : arg)).join(" ");
}

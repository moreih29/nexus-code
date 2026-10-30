import { z } from "zod";

/**
 * The shell a terminal runs: one the app found on this machine (by id), or a
 * program the user named, with its arguments. Ids are stable per machine:
 * "powershell", "pwsh", "cmd", "git-bash" and "nu" on Windows, the shell's
 * path elsewhere.
 */
export const ShellChoiceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("detected"), id: z.string().min(1).max(1024) }),
  z.object({
    kind: z.literal("custom"),
    path: z.string().min(1).max(1024),
    args: z.array(z.string().max(1024)).max(64).optional(),
  }),
]);
export type ShellChoice = z.infer<typeof ShellChoiceSchema>;

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
 * inside double quotes. No escapes; good enough for flags like `-l` or
 * `-NoLogo -ExecutionPolicy Bypass`.
 */
export function splitShellArgs(text: string): string[] {
  const args: string[] = [];
  for (const match of text.matchAll(/"([^"]*)"|(\S+)/g)) {
    args.push(match[1] ?? match[2] ?? "");
  }
  return args;
}

/** The inverse of `splitShellArgs`, for showing stored arguments in the field. */
export function joinShellArgs(args: readonly string[]): string {
  return args.map((arg) => (/\s/.test(arg) || arg === "" ? `"${arg}"` : arg)).join(" ");
}
